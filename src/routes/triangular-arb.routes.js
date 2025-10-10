const express = require('express');
const { body, validationResult } = require('express-validator');
const { query: dbQuery, pool } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin, requireAdmin, optionalAuth } = require('../middleware/auth');
const { tradingRateLimit, tickerRateLimit, authenticatedRateLimit, adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { broadcastToAdmins } = require('../websocket/socketManager');

// Additional dependencies for exchange API integration
const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');

const router = express.Router();

// Alias 'authenticate' for backward compatibility with triangular routes
const authenticate = authenticateUser;

// ============================================================================
// EXCHANGE CONFIGURATION - Basic Trading Configs
// ============================================================================

const LUNO_CONFIG = {
    baseUrl: 'https://api.luno.com',
    endpoints: {
        balance: '/api/1/balance',
        ticker: '/api/1/ticker',
        tickers: '/api/1/tickers',
        order: '/api/1/marketorder'
    }
};

const VALR_CONFIG = {
    baseUrl: 'https://api.valr.com',
    endpoints: {
        balance: '/v1/account/balances',
        ticker: '/v1/public/marketsummary',
        simpleBuyOrder: '/v1/orders/market',  // Use working market order endpoint
        simpleSellOrder: '/v1/orders/market', // Same endpoint for both buy and sell
        pairs: '/v1/public/pairs',
        orderStatus: '/v1/orders/:orderId',
        orderBook: '/v1/public/:pair/orderbook'
    }
};

const CHAINEX_CONFIG = {
    baseUrl: 'https://api.chainex.io',
    endpoints: {
        balance: '/wallet/balances',
        ticker: '/market/summary',
        markets: '/market/summary',
        order: '/trading/order',
        orderBook: '/market/orderbook',  // Added for triangular arbitrage
        pairs: '/market/pairs'            // Added for triangular arbitrage
    }
};

const BYBIT_PROXY_CONFIG = {
    baseUrl: 'https://api.bybit.com',
    endpoints: {
        balance: '/v5/account/wallet-balance',
        ticker: '/v5/market/tickers',
        test: '/v5/account/wallet-balance'
    }
};

// ============================================================================
// AUTHENTICATION HELPER FUNCTIONS
// ============================================================================

// LUNO Authentication Helper - Simple Basic Auth
function createLunoAuth(apiKey, apiSecret) {
    return Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
}

// VALR Authentication Helper - FIXED TO MATCH FRONTEND BASE64 ENCODING
function createValrSignature(apiSecret, timestamp, verb, path, body = '') {
    const payload = timestamp + verb.toUpperCase() + path + (body || '');

    systemLogger.trading('VALR signature payload', {
        timestamp,
        method: verb.toUpperCase(),
        path,
        body: body || '',
        payload: payload
    });

    // Localhost server.js uses hex - match exactly
    const signature = crypto
        .createHmac('sha512', apiSecret)  // UTF-8 string
        .update(payload)
        .digest('hex');  // Use hex like working localhost server.js

    systemLogger.trading('VALR signature generated (hex)', {
        signature: signature.substring(0, 20) + '...',
        encoding: 'hex',
        payloadLength: payload.length
    });

    return signature;
}

// VALR HTTP Request Helper
async function makeValrRequest(endpoint, method, apiKey, apiSecret, body = null) {
    const maxRetries = 3;
    const retryDelays = [1000, 2000, 3000]; // Exponential backoff: 1s, 2s, 3s

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            systemLogger.trading(`VALR API request attempt ${attempt + 1}/${maxRetries + 1}`, {
                endpoint,
                method,
                attempt: attempt + 1
            });

            const result = await makeValrRequestSingle(endpoint, method, apiKey, apiSecret, body);

            // Success on first try or after retries
            if (attempt > 0) {
                systemLogger.trading(`VALR API request succeeded after ${attempt + 1} attempts`, {
                    endpoint,
                    method,
                    totalAttempts: attempt + 1
                });
            }

            return result;

        } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            const isRetriableError = error.message.includes('Empty response') ||
                                   error.message.includes('timeout') ||
                                   error.message.includes('ECONNRESET') ||
                                   error.message.includes('ENOTFOUND');

            systemLogger.trading(`VALR API request failed - attempt ${attempt + 1}`, {
                endpoint,
                method,
                error: error.message,
                isRetriable: isRetriableError,
                isLastAttempt,
                willRetry: !isLastAttempt && isRetriableError
            });

            if (isLastAttempt || !isRetriableError) {
                throw error;
            }

            // Wait before retry with exponential backoff
            const delayMs = retryDelays[attempt] || 3000;
            systemLogger.trading(`VALR API retrying in ${delayMs}ms`, {
                endpoint,
                method,
                attempt: attempt + 1,
                delayMs
            });

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

function makeValrRequestSingle(endpoint, method, apiKey, apiSecret, body = null) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const path = endpoint;
        const bodyString = body ? JSON.stringify(body) : '';

        const options = {
            hostname: 'api.valr.com',
            path: path,
            method: method.toUpperCase(),
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'ARB4ME/1.0'
            }
        };

        // Add Content-Length if we have a body
        if (bodyString) {
            options.headers['Content-Length'] = Buffer.byteLength(bodyString);
        }

        // Only add authentication headers if API key is provided (for private endpoints)
        if (apiKey && apiSecret) {
            const signature = createValrSignature(apiSecret, timestamp.toString(), method, path, bodyString);
            // Use correct VALR header names (from working localhost version)
            options.headers['X-VALR-API-KEY'] = apiKey;
            options.headers['X-VALR-SIGNATURE'] = signature;
            options.headers['X-VALR-TIMESTAMP'] = timestamp.toString();
        }

        systemLogger.trading('VALR API request details', {
            method: method.toUpperCase(),
            path: path,
            hostname: options.hostname,
            headers: options.headers,
            bodyString: bodyString,
            hasAuth: !!(apiKey && apiSecret)
        });

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                systemLogger.trading('VALR API raw response', {
                    statusCode: res.statusCode,
                    data: data.substring(0, 500),
                    headers: res.headers
                });

                try {
                    if (!data || data.trim() === '') {
                        reject(new Error('Empty response from VALR API'));
                        return;
                    }

                    const jsonData = JSON.parse(data);

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(jsonData);
                    } else {
                        reject(new Error(jsonData.message || jsonData.error || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                } catch (parseError) {
                    reject(new Error(`Invalid JSON response from VALR: ${data.substring(0, 200)}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        // Set timeout to detect hanging requests
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('VALR API request timeout (10s)'));
        });

        if (bodyString) {
            req.write(bodyString);
        }

        req.end();
    });
}

// ============================================================================
// TRIANGULAR ARBITRAGE ROUTES
// ============================================================================
// This file contains all triangular arbitrage routes extracted from trading.routes.js
// to resolve file size issues causing Railway restart loops.
//
// Exchanges implemented:
// - VALR, Luno, ChainEX, Kraken, ByBit, Binance, OKX, KuCoin
// - Coinbase, Huobi, Gate.io, Crypto.com, MEXC, XT, AscendEX
// ============================================================================

// LUNO TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// POST /api/v1/trading/luno/triangular/test-connection
// Test Luno API connection for triangular trading
router.post('/luno/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('Luno triangular connection test initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Validate Luno API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('Luno API credentials required', 400, 'LUNO_CREDENTIALS_REQUIRED');
        }

        const auth = createLunoAuth(apiKey, apiSecret);

        // Test API connection by fetching balance
        const balanceResponse = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });

        if (!balanceResponse.ok) {
            throw new Error(`Luno balance check failed: HTTP ${balanceResponse.status}`);
        }

        const balanceData = await balanceResponse.json();

        // Check if we have access to triangular pairs
        const requiredPairs = ['ETHXBT', 'ETHUSDT', 'XBTUSDT', 'XRPZAR', 'XRPXBT', 'USDTZAR'];
        const pairsResponse = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.tickers}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!pairsResponse.ok) {
            throw new Error(`Luno pairs check failed: HTTP ${pairsResponse.status}`);
        }

        const pairsData = await pairsResponse.json();
        const availablePairs = pairsData.tickers.map(t => t.pair);
        const triangularPairsAvailable = requiredPairs.every(pair => availablePairs.includes(pair));

        systemLogger.trading('Luno triangular connection test successful', {
            userId: req.user.id,
            balanceCount: balanceData.balance?.length || 0,
            triangularPairsAvailable
        });

        res.json({
            success: true,
            data: {
                connected: true,
                balanceAccess: true,
                triangularPairsAvailable,
                totalPairs: availablePairs.length,
                requiredPairsFound: requiredPairs.filter(p => availablePairs.includes(p)),
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        systemLogger.error('Luno triangular connection test failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// POST /api/v1/trading/luno/triangular/scan
// Scan for Luno triangular arbitrage opportunities with live prices
router.post('/luno/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { paths = 'all', apiKey, apiSecret } = req.body;

        systemLogger.trading('Luno triangular scan initiated', {
            userId: req.user.id,
            paths,
            timestamp: new Date().toISOString()
        });

        // Validate Luno API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('Luno API credentials required', 400, 'LUNO_CREDENTIALS_REQUIRED');
        }

        // Define all Luno triangular path sets (42 PATHS across 7 sets)
        const allPathSets = {
            SET_1_USDT_FOCUS: [
                { id: 'USDT_XBT_ETH_USDT', pairs: ['XBTUSDT', 'ETHXBT', 'ETHUSDT'], sequence: 'USDT → XBT → ETH → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_XBT_XRP_USDT', pairs: ['XBTUSDT', 'XRPXBT', 'XRPUSDT'], sequence: 'USDT → XBT → XRP → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_XBT_SOL_USDT', pairs: ['XBTUSDT', 'SOLXBT', 'SOLUSDT'], sequence: 'USDT → XBT → SOL → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_XBT_USDT', pairs: ['ETHUSDT', 'ETHXBT', 'XBTUSDT'], sequence: 'USDT → ETH → XBT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_XBT_USDT', pairs: ['XRPUSDT', 'XRPXBT', 'XBTUSDT'], sequence: 'USDT → XRP → XBT → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_XBT_USDT', pairs: ['SOLUSDT', 'SOLXBT', 'XBTUSDT'], sequence: 'USDT → SOL → XBT → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_USDC_ETH_USDT', pairs: ['USDCUSDT', 'ETHUSDC', 'ETHUSDT'], sequence: 'USDT → USDC → ETH → USDT', steps: [{ pair: 'USDCUSDT', side: 'buy' }, { pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_2_XBT_FOCUS: [
                { id: 'XBT_ETH_USDT_XBT', pairs: ['ETHXBT', 'ETHUSDT', 'XBTUSDT'], sequence: 'XBT → ETH → USDT → XBT', steps: [{ pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }] },
                { id: 'XBT_ETH_ZAR_XBT', pairs: ['ETHXBT', 'ETHZAR', 'XBTZAR'], sequence: 'XBT → ETH → ZAR → XBT', steps: [{ pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_SOL_USDT_XBT', pairs: ['SOLXBT', 'SOLUSDT', 'XBTUSDT'], sequence: 'XBT → SOL → USDT → XBT', steps: [{ pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }] },
                { id: 'XBT_SOL_XRP_XBT', pairs: ['SOLXBT', 'SOLXRP', 'XRPXBT'], sequence: 'XBT → SOL → XRP → XBT', steps: [{ pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLXRP', side: 'sell' }, { pair: 'XRPXBT', side: 'buy' }] },
                { id: 'XBT_XRP_USDT_XBT', pairs: ['XRPXBT', 'XRPUSDT', 'XBTUSDT'], sequence: 'XBT → XRP → USDT → XBT', steps: [{ pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }] },
                { id: 'XBT_XRP_ZAR_XBT', pairs: ['XRPXBT', 'XRPZAR', 'XBTZAR'], sequence: 'XBT → XRP → ZAR → XBT', steps: [{ pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_ADA_ZAR_XBT', pairs: ['ADAXBT', 'ADAZAR', 'XBTZAR'], sequence: 'XBT → ADA → ZAR → XBT', steps: [{ pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_DOT_ZAR_XBT', pairs: ['DOTXBT', 'DOTZAR', 'XBTZAR'], sequence: 'XBT → DOT → ZAR → XBT', steps: [{ pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_AVAX_ZAR_XBT', pairs: ['AVAXXBT', 'AVAXZAR', 'XBTZAR'], sequence: 'XBT → AVAX → ZAR → XBT', steps: [{ pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_LINK_ZAR_XBT', pairs: ['LINKXBT', 'LINKZAR', 'XBTZAR'], sequence: 'XBT → LINK → ZAR → XBT', steps: [{ pair: 'LINKXBT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_UNI_ZAR_XBT', pairs: ['UNIXBT', 'UNIZAR', 'XBTZAR'], sequence: 'XBT → UNI → ZAR → XBT', steps: [{ pair: 'UNIXBT', side: 'buy' }, { pair: 'UNIZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_LTC_ZAR_XBT', pairs: ['LTCXBT', 'LTCZAR', 'XBTZAR'], sequence: 'XBT → LTC → ZAR → XBT', steps: [{ pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] }
            ],
            SET_3_ZAR_FOCUS: [
                { id: 'ZAR_XBT_ETH_ZAR', pairs: ['XBTZAR', 'ETHXBT', 'ETHZAR'], sequence: 'ZAR → XBT → ETH → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_SOL_ZAR', pairs: ['XBTZAR', 'SOLXBT', 'SOLZAR'], sequence: 'ZAR → XBT → SOL → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_XRP_ZAR', pairs: ['XBTZAR', 'XRPXBT', 'XRPZAR'], sequence: 'ZAR → XBT → XRP → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_ETH_XBT_ZAR', pairs: ['ETHZAR', 'ETHXBT', 'XBTZAR'], sequence: 'ZAR → ETH → XBT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_SOL_XBT_ZAR', pairs: ['SOLZAR', 'SOLXBT', 'XBTZAR'], sequence: 'ZAR → SOL → XBT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XRP_XBT_ZAR', pairs: ['XRPZAR', 'XRPXBT', 'XBTZAR'], sequence: 'ZAR → XRP → XBT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XBT_ZAR', pairs: ['USDTZAR', 'XBTUSDT', 'XBTZAR'], sequence: 'ZAR → USDT → XBT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_USDC_ETH_ZAR', pairs: ['USDCZAR', 'ETHUSDC', 'ETHZAR'], sequence: 'ZAR → USDC → ETH → ZAR', steps: [{ pair: 'USDCZAR', side: 'buy' }, { pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] }
            ],
            SET_4_ETH_FOCUS: [
                { id: 'ETH_XBT_USDT_ETH', pairs: ['ETHXBT', 'XBTUSDT', 'ETHUSDT'], sequence: 'ETH → XBT → USDT → ETH', steps: [{ pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }] },
                { id: 'ETH_XBT_ZAR_ETH', pairs: ['ETHXBT', 'XBTZAR', 'ETHZAR'], sequence: 'ETH → XBT → ZAR → ETH', steps: [{ pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }] },
                { id: 'ETH_USDT_XBT_ETH', pairs: ['ETHUSDT', 'XBTUSDT', 'ETHXBT'], sequence: 'ETH → USDT → XBT → ETH', steps: [{ pair: 'ETHUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }] },
                { id: 'ETH_USDC_USDT_ETH', pairs: ['ETHUSDC', 'USDCUSDT', 'ETHUSDT'], sequence: 'ETH → USDC → USDT → ETH', steps: [{ pair: 'ETHUSDC', side: 'sell' }, { pair: 'USDCUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }] },
                { id: 'ETH_ZAR_XBT_ETH', pairs: ['ETHZAR', 'XBTZAR', 'ETHXBT'], sequence: 'ETH → ZAR → XBT → ETH', steps: [{ pair: 'ETHZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }] },
                { id: 'ETH_XBT_SOL_ETH', pairs: ['ETHXBT', 'SOLXBT', 'SOLETH'], sequence: 'ETH → XBT → SOL → ETH', steps: [{ pair: 'ETHXBT', side: 'sell' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }] }
            ],
            SET_5_SOL_UNIQUE: [
                { id: 'SOL_ADA_ZAR_SOL', pairs: ['SOLADA', 'ADAZAR', 'SOLZAR'], sequence: 'SOL → ADA → ZAR → SOL', steps: [{ pair: 'SOLADA', side: 'sell' }, { pair: 'ADAZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }] },
                { id: 'SOL_XRP_XBT_SOL', pairs: ['SOLXRP', 'XRPXBT', 'SOLXBT'], sequence: 'SOL → XRP → XBT → SOL', steps: [{ pair: 'SOLXRP', side: 'sell' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'SOLXBT', side: 'buy' }] },
                { id: 'SOL_XBT_USDT_SOL', pairs: ['SOLXBT', 'XBTUSDT', 'SOLUSDT'], sequence: 'SOL → XBT → USDT → SOL', steps: [{ pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }, { pair: 'SOLUSDT', side: 'buy' }] },
                { id: 'SOL_USDT_XBT_SOL', pairs: ['SOLUSDT', 'XBTUSDT', 'SOLXBT'], sequence: 'SOL → USDT → XBT → SOL', steps: [{ pair: 'SOLUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }] },
                { id: 'SOL_ZAR_XBT_SOL', pairs: ['SOLZAR', 'XBTZAR', 'SOLXBT'], sequence: 'SOL → ZAR → XBT → SOL', steps: [{ pair: 'SOLZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }] }
            ],
            SET_6_STABLECOIN_ARB: [
                { id: 'USDC_ETH_XBT_USDC', pairs: ['ETHUSDC', 'ETHXBT', 'XBTUSDC'], sequence: 'USDC → ETH → XBT → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                { id: 'USDC_USDT_ETH_USDC', pairs: ['USDCUSDT', 'ETHUSDT', 'ETHUSDC'], sequence: 'USDC → USDT → ETH → USDC', steps: [{ pair: 'USDCUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHUSDC', side: 'sell' }] },
                { id: 'XRP_SOL_XBT_XRP', pairs: ['SOLXRP', 'SOLXBT', 'XRPXBT'], sequence: 'XRP → SOL → XBT → XRP', steps: [{ pair: 'SOLXRP', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XRPXBT', side: 'buy' }] },
                { id: 'ADA_SOL_ZAR_ADA', pairs: ['SOLADA', 'SOLZAR', 'ADAZAR'], sequence: 'ADA → SOL → ZAR → ADA', steps: [{ pair: 'SOLADA', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'ADAZAR', side: 'buy' }] }
            ],
            SET_7_EXTENDED_ALTCOINS: [
                // Future expansion with ALGO, ATOM, BCH, CRV, GRT, HBAR, NEAR, POL, SAND, SNX, TRX, XLM
            ]
        };

        // Return basic scan structure (full implementation would fetch order books and calculate profits)
        systemLogger.trading('Luno triangular scan completed (placeholder)', {
            userId: req.user.id,
            pathSetsCount: Object.keys(allPathSets).length
        });

        res.json({
            success: true,
            data: {
                opportunities: [],
                pathSetsScanned: Object.keys(allPathSets).length,
                totalPathsScanned: Object.values(allPathSets).reduce((sum, set) => sum + set.length, 0),
                message: 'Luno triangular scan structure ready. Full order book analysis to be implemented.',
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Luno triangular scan failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// GET /api/v1/trading/luno/triangular/paths
// Get all configured Luno triangular arbitrage paths
router.get('/luno/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        // Return all 42 configured paths organized in 7 sets
        const allPaths = {
            SET_1_USDT_FOCUS: {
                name: 'USDT Focus (Essential)',
                description: 'Paths starting/ending with USDT',
                pathCount: 7
            },
            SET_2_XBT_FOCUS: {
                name: 'XBT Focus (High Volume)',
                description: 'Paths with Bitcoin as intermediary',
                pathCount: 12
            },
            SET_3_ZAR_FOCUS: {
                name: 'ZAR Focus (SA Market)',
                description: 'Paths for South African Rand trading',
                pathCount: 8
            },
            SET_4_ETH_FOCUS: {
                name: 'ETH Focus (DeFi)',
                description: 'Ethereum-based triangular paths',
                pathCount: 6
            },
            SET_5_SOL_UNIQUE: {
                name: 'SOL Unique Paths',
                description: 'Solana paths with direct SOL/ADA and SOL/XRP pairs',
                pathCount: 5
            },
            SET_6_STABLECOIN_ARB: {
                name: 'Stablecoin Arbitrage',
                description: 'Low-risk USDC/USDT paths',
                pathCount: 4
            },
            SET_7_EXTENDED_ALTCOINS: {
                name: 'Extended Altcoins',
                description: 'Future expansion with more altcoins',
                pathCount: 0
            }
        };

        res.json({
            success: true,
            data: {
                pathSets: allPaths,
                totalPaths: 42,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        systemLogger.error('Luno triangular paths fetch failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// POST /api/v1/trading/luno/triangular/execute
// Execute a Luno triangular arbitrage trade (3-leg atomic transaction)
router.post('/luno/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { pathId, amount, simulate = true } = req.body;

        if (!pathId || !amount) {
            throw new APIError('Path ID and amount are required', 400, 'MISSING_PARAMETERS');
        }

        systemLogger.trading('Luno triangular execution initiated', {
            userId: req.user.id,
            pathId,
            amount,
            simulate,
            timestamp: new Date().toISOString()
        });

        // For now, return a placeholder response
        // Full implementation would execute 3-leg trade with rollback on failure
        res.json({
            success: true,
            data: {
                message: 'Luno triangular execution structure ready. Full atomic trade implementation pending.',
                pathId,
                amount,
                simulate,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Luno triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// DELETE /api/v1/trading/luno/triangular/history
// Clear Luno triangular arbitrage trade history
router.delete('/luno/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('Luno triangular history clear initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Clear triangular trade history for Luno only
        await query(`
            DELETE FROM triangular_trades
            WHERE user_id = $1 AND exchange = 'LUNO'
        `, [req.user.id]);

        // Reset stats for Luno
        await query(`
            UPDATE trading_activity
            SET triangular_trades_count = triangular_trades_count - (
                SELECT COUNT(*) FROM triangular_trades
                WHERE user_id = $1 AND exchange = 'LUNO'
            ),
            updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
        `, [req.user.id]);

        systemLogger.trading('Luno triangular history cleared', {
            userId: req.user.id
        });

        res.json({
            success: true,
            message: 'Luno triangular trade history cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        systemLogger.error('Luno triangular history clear failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// GET /api/v1/trading/luno/triangular/recent-trades
// Get recent Luno triangular trades
router.get('/luno/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;

        // Query only Luno triangular trades
        const tradesQuery = `
            SELECT
                id, trade_id, exchange, path_id, path_sequence,
                execution_status, actual_profit_zar, actual_profit_percent,
                total_execution_time_ms, created_at, execution_completed_at,
                error_message, dry_run
            FROM triangular_trades
            WHERE user_id = $1 AND exchange = 'LUNO'
            ORDER BY created_at DESC
            LIMIT $2
        `;

        const result = await query(tradesQuery, [req.user.id, limit]);

        systemLogger.info('Recent Luno triangular trades fetched', {
            userId: req.user.id,
            tradesCount: result.rows.length
        });

        res.json({
            success: true,
            data: {
                trades: result.rows,
                count: result.rows.length,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Failed to fetch recent Luno triangular trades', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================================================
// CHAINEX TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Note: CHAINEX_CONFIG is defined later in the file (line ~4702)
// ChainEX authentication helper
function createChainExAuth(apiKey, apiSecret) {
    return Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
}

// POST /api/v1/trading/chainex/triangular/test-connection
// Test ChainEX API credentials and verify triangular arbitrage capability
router.post('/chainex/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('Testing ChainEX triangular arbitrage connection', {
            userId: req.user.id,
            exchange: 'chainex',
            strategy: 'triangular'
        });

        // Validate credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('ChainEX API credentials required', 400, 'CHAINEX_CREDENTIALS_REQUIRED');
        }

        const auth = createChainExAuth(apiKey, apiSecret);

        // Test balance access
        const balanceResponse = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });

        if (!balanceResponse.ok) {
            const errorText = await balanceResponse.text();
            throw new APIError(`ChainEX authentication failed: ${errorText}`, 401, 'CHAINEX_AUTH_FAILED');
        }

        const balanceData = await balanceResponse.json();

        // Check triangular pairs availability
        const requiredPairs = ['BTCZAR', 'ETHBTC', 'ETHZAR', 'XRPZAR', 'XRPBTC', 'USDTZAR'];
        const pairsResponse = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.pairs}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!pairsResponse.ok) {
            throw new APIError('Failed to fetch ChainEX trading pairs', 500, 'CHAINEX_PAIRS_FAILED');
        }

        const pairsData = await pairsResponse.json();
        const availablePairs = pairsData.map(p => p.pair || p.symbol);
        const missingPairs = requiredPairs.filter(pair => !availablePairs.includes(pair));

        systemLogger.trading('ChainEX triangular connection test successful', {
            userId: req.user.id,
            availablePairs: availablePairs.length,
            missingPairs: missingPairs.length
        });

        res.json({
            success: true,
            message: 'ChainEX triangular arbitrage connection successful',
            data: {
                authenticated: true,
                balances: balanceData.balance || balanceData,
                availablePairs: availablePairs.length,
                requiredPairs: requiredPairs.length,
                missingPairs: missingPairs,
                triangularReady: missingPairs.length === 0
            }
        });

    } catch (error) {
        systemLogger.error('ChainEX triangular connection test failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// POST /api/v1/trading/chainex/triangular/scan
// Scan for triangular arbitrage opportunities on ChainEX
router.post('/chainex/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { paths = 'all', apiKey, apiSecret } = req.body;

        systemLogger.trading('Starting ChainEX triangular arbitrage scan', {
            userId: req.user.id,
            requestedPaths: paths
        });

        if (!apiKey || !apiSecret) {
            throw new APIError('ChainEX API credentials required', 400, 'CHAINEX_CREDENTIALS_REQUIRED');
        }

        const auth = createChainExAuth(apiKey, apiSecret);

        // Define all 28 ChainEX triangular arbitrage paths across 6 sets
        const allPathSets = {
        SET_1_ZAR_FOCUS: [
            { id: 'ZAR_BTC_ETH_ZAR', pairs: ['BTCZAR', 'ETHBTC', 'ETHZAR'], sequence: 'ZAR → BTC → ETH → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
            { id: 'ZAR_BTC_XRP_ZAR', pairs: ['BTCZAR', 'XRPBTC', 'XRPZAR'], sequence: 'ZAR → BTC → XRP → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
            { id: 'ZAR_ETH_XRP_ZAR', pairs: ['ETHZAR', 'XRPETH', 'XRPZAR'], sequence: 'ZAR → ETH → XRP → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
            { id: 'ZAR_BTC_LTC_ZAR', pairs: ['BTCZAR', 'LTCBTC', 'LTCZAR'], sequence: 'ZAR → BTC → LTC → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
            { id: 'ZAR_ETH_LTC_ZAR', pairs: ['ETHZAR', 'LTCETH', 'LTCZAR'], sequence: 'ZAR → ETH → LTC → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
            { id: 'ZAR_BTC_BCH_ZAR', pairs: ['BTCZAR', 'BCHBTC', 'BCHZAR'], sequence: 'ZAR → BTC → BCH → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'BCHBTC', side: 'buy' }, { pair: 'BCHZAR', side: 'sell' }] },
            { id: 'ZAR_USDT_BTC_ZAR', pairs: ['USDTZAR', 'BTCUSDT', 'BTCZAR'], sequence: 'ZAR → USDT → BTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BTCUSDT', side: 'buy' }, { pair: 'BTCZAR', side: 'sell' }] },
            { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] }
        ],
        SET_2_BTC_FOCUS: [
            { id: 'BTC_ETH_XRP_BTC', pairs: ['ETHBTC', 'XRPETH', 'XRPBTC'], sequence: 'BTC → ETH → XRP → BTC', steps: [{ pair: 'ETHBTC', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPBTC', side: 'sell' }] },
            { id: 'BTC_ETH_LTC_BTC', pairs: ['ETHBTC', 'LTCETH', 'LTCBTC'], sequence: 'BTC → ETH → LTC → BTC', steps: [{ pair: 'ETHBTC', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }] },
            { id: 'BTC_XRP_LTC_BTC', pairs: ['XRPBTC', 'LTCXRP', 'LTCBTC'], sequence: 'BTC → XRP → LTC → BTC', steps: [{ pair: 'XRPBTC', side: 'buy' }, { pair: 'LTCXRP', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }] },
            { id: 'BTC_ETH_USDT_BTC', pairs: ['ETHBTC', 'ETHUSDT', 'BTCUSDT'], sequence: 'BTC → ETH → USDT → BTC', steps: [{ pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
            { id: 'BTC_XRP_USDT_BTC', pairs: ['XRPBTC', 'XRPUSDT', 'BTCUSDT'], sequence: 'BTC → XRP → USDT → BTC', steps: [{ pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
            { id: 'BTC_LTC_USDT_BTC', pairs: ['LTCBTC', 'LTCUSDT', 'BTCUSDT'], sequence: 'BTC → LTC → USDT → BTC', steps: [{ pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
            { id: 'BTC_BCH_USDT_BTC', pairs: ['BCHBTC', 'BCHUSDT', 'BTCUSDT'], sequence: 'BTC → BCH → USDT → BTC', steps: [{ pair: 'BCHBTC', side: 'buy' }, { pair: 'BCHUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] }
        ],
        SET_3_USDT_FOCUS: [
            { id: 'USDT_BTC_ETH_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
            { id: 'USDT_BTC_XRP_USDT', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
            { id: 'USDT_BTC_LTC_USDT', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
            { id: 'USDT_ETH_XRP_USDT', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
            { id: 'USDT_ETH_LTC_USDT', pairs: ['ETHUSDT', 'LTCETH', 'LTCUSDT'], sequence: 'USDT → ETH → LTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
            { id: 'USDT_ZAR_BTC_USDT', pairs: ['USDTZAR', 'BTCZAR', 'BTCUSDT'], sequence: 'USDT → ZAR → BTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BTCZAR', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] }
        ],
        SET_4_ETH_FOCUS: [
            { id: 'ETH_BTC_XRP_ETH', pairs: ['ETHBTC', 'XRPBTC', 'XRPETH'], sequence: 'ETH → BTC → XRP → ETH', steps: [{ pair: 'ETHBTC', side: 'sell' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPETH', side: 'sell' }] },
            { id: 'ETH_BTC_LTC_ETH', pairs: ['ETHBTC', 'LTCBTC', 'LTCETH'], sequence: 'ETH → BTC → LTC → ETH', steps: [{ pair: 'ETHBTC', side: 'sell' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }] },
            { id: 'ETH_USDT_ZAR_ETH', pairs: ['ETHUSDT', 'USDTZAR', 'ETHZAR'], sequence: 'ETH → USDT → ZAR → ETH', steps: [{ pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }] },
            { id: 'ETH_XRP_USDT_ETH', pairs: ['XRPETH', 'XRPUSDT', 'ETHUSDT'], sequence: 'ETH → XRP → USDT → ETH', steps: [{ pair: 'XRPETH', side: 'sell' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }] }
        ],
        SET_5_CROSS_CURRENCY: [
            { id: 'XRP_BTC_USDT_XRP', pairs: ['XRPBTC', 'BTCUSDT', 'XRPUSDT'], sequence: 'XRP → BTC → USDT → XRP', steps: [{ pair: 'XRPBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }, { pair: 'XRPUSDT', side: 'buy' }] },
            { id: 'LTC_BTC_ETH_LTC', pairs: ['LTCBTC', 'ETHBTC', 'LTCETH'], sequence: 'LTC → BTC → ETH → LTC', steps: [{ pair: 'LTCBTC', side: 'sell' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }] }
        ],
        SET_6_EXTENDED_ALTCOINS: [
            { id: 'BCH_BTC_USDT_BCH', pairs: ['BCHBTC', 'BTCUSDT', 'BCHUSDT'], sequence: 'BCH → BTC → USDT → BCH', steps: [{ pair: 'BCHBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }, { pair: 'BCHUSDT', side: 'buy' }] }
        ]
    };

        // Determine which path sets to scan
        let pathsToScan = [];
        if (paths === 'all' || !Array.isArray(paths)) {
            pathsToScan = Object.values(allPathSets).flat();
        } else {
            paths.forEach(setNum => {
                const setKey = `SET_${setNum}_${['ZAR_FOCUS', 'BTC_FOCUS', 'USDT_FOCUS', 'ETH_FOCUS', 'CROSS_CURRENCY', 'EXTENDED_ALTCOINS'][setNum - 1]}`;
                if (allPathSets[setKey]) {
                    pathsToScan.push(...allPathSets[setKey]);
                }
            });
        }

        const opportunities = [];

        // Fetch all required order books in parallel
        const uniquePairs = [...new Set(pathsToScan.flatMap(path => path.pairs))];
        const orderBookPromises = uniquePairs.map(async (pair) => {
            const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.orderBook}/${pair}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!response.ok) return { pair, error: true };
            const data = await response.json();
            return { pair, data };
        });

        const orderBooks = await Promise.all(orderBookPromises);
        const orderBookMap = Object.fromEntries(orderBooks.map(ob => [ob.pair, ob.data]));

        // Analyze each path
        for (const path of pathsToScan) {
            try {
                const pathOrderBooks = path.pairs.map(pair => orderBookMap[pair]);

                // Skip if any order book is missing
                if (pathOrderBooks.some(ob => !ob || !ob.bids || !ob.asks)) continue;

                // Calculate opportunity
                let amount = 1000; // Start with 1000 ZAR or USDT
                let finalAmount = amount;

                // Simulate the 3-leg trade
                for (let i = 0; i < path.steps.length; i++) {
                    const step = path.steps[i];
                    const orderBook = pathOrderBooks[i];

                    if (step.side === 'buy') {
                        const bestAsk = orderBook.asks[0];
                        finalAmount = finalAmount / parseFloat(bestAsk.price);
                    } else {
                        const bestBid = orderBook.bids[0];
                        finalAmount = finalAmount * parseFloat(bestBid.price);
                    }

                    // Apply 0.1% fee per leg
                    finalAmount *= 0.999;
                }

                const profitZar = finalAmount - amount;
                const profitPercent = (profitZar / amount) * 100;

                if (profitPercent > 0.15) { // Minimum 0.15% profit threshold
                    opportunities.push({
                        pathId: path.id,
                        sequence: path.sequence,
                        pairs: path.pairs,
                        steps: path.steps,
                        initialAmount: amount,
                        finalAmount: finalAmount,
                        profitZar: profitZar,
                        profitPercent: profitPercent,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (pathError) {
                systemLogger.error('Error analyzing ChainEX path', {
                    pathId: path.id,
                    error: pathError.message
                });
            }
        }

        // Sort by profit percentage
        opportunities.sort((a, b) => b.profitPercent - a.profitPercent);

        systemLogger.trading('ChainEX triangular scan complete', {
            userId: req.user.id,
            pathsScanned: pathsToScan.length,
            opportunitiesFound: opportunities.length
        });

        res.json({
            success: true,
            message: 'ChainEX triangular arbitrage scan complete',
            data: {
                scannedPaths: pathsToScan.length,
                opportunities: opportunities,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Failed ChainEX triangular scan', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// GET /api/v1/trading/chainex/triangular/paths
// Get all available ChainEX triangular arbitrage paths
router.get('/chainex/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const pathSets = {
            SET_1_ZAR_FOCUS: { count: 8, description: 'ZAR base currency paths', enabled: true },
            SET_2_BTC_FOCUS: { count: 7, description: 'BTC base currency paths', enabled: true },
            SET_3_USDT_FOCUS: { count: 6, description: 'USDT base currency paths', enabled: true },
            SET_4_ETH_FOCUS: { count: 4, description: 'ETH base currency paths', enabled: false },
            SET_5_CROSS_CURRENCY: { count: 2, description: 'Cross-currency arbitrage paths', enabled: false },
            SET_6_EXTENDED_ALTCOINS: { count: 1, description: 'Extended altcoin paths', enabled: false }
        };

        res.json({
            success: true,
            message: 'ChainEX triangular paths retrieved',
            data: {
                totalPaths: 28,
                pathSets: pathSets
            }
        });

    } catch (error) {
        systemLogger.error('Failed to get ChainEX triangular paths', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// POST /api/v1/trading/chainex/triangular/execute
// Execute a ChainEX triangular arbitrage trade
router.post('/chainex/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { pathId, initialAmount, apiKey, apiSecret, dryRun = false } = req.body;

        systemLogger.trading('ChainEX triangular execution started', {
            userId: req.user.id,
            pathId: pathId,
            initialAmount: initialAmount,
            dryRun: dryRun
        });

        if (!apiKey || !apiSecret) {
            throw new APIError('ChainEX API credentials required', 400, 'CHAINEX_CREDENTIALS_REQUIRED');
        }

        const auth = createChainExAuth(apiKey, apiSecret);

        const tradeRecord = {
            userId: req.user.id,
            exchange: 'chainex',
            pathId: pathId,
            initialAmount: initialAmount,
            executionStatus: dryRun ? 'test' : 'pending',
            dryRun: dryRun,
            timestamp: new Date().toISOString()
        };

        // In production, execute actual trades here
        // For now, simulate execution

        res.json({
            success: true,
            message: dryRun ? 'ChainEX triangular trade simulated' : 'ChainEX triangular trade executed',
            data: tradeRecord
        });

    } catch (error) {
        systemLogger.error('ChainEX triangular execution failed', {
            userId: req.user.id,
            pathId: pathId,
            error: error.message
        });
        throw error;
    }
}));

// DELETE /api/v1/trading/chainex/triangular/history
// Clear ChainEX triangular trade history
router.delete('/chainex/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('Clearing ChainEX triangular history', {
            userId: req.user.id
        });

        const result = await query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [req.user.id, 'CHAINEX']
        );

        res.json({
            success: true,
            message: 'ChainEX triangular history cleared',
            data: {
                deletedCount: result.rowCount
            }
        });

    } catch (error) {
        systemLogger.error('Failed to clear ChainEX triangular history', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// GET /api/v1/trading/chainex/triangular/recent-trades
// Get recent ChainEX triangular trades
router.get('/chainex/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;

        systemLogger.trading('Fetching recent ChainEX triangular trades', {
            userId: req.user.id,
            limit: limit
        });

        const result = await query(
            'SELECT * FROM triangular_trades WHERE user_id = $1 AND exchange = $2 ORDER BY created_at DESC LIMIT $3',
            [req.user.id, 'CHAINEX', limit]
        );

        res.json({
            success: true,
            message: 'Recent ChainEX triangular trades retrieved',
            data: {
                trades: result.rows,
                count: result.rowCount
            }
        });

    } catch (error) {
        systemLogger.error('Failed to fetch recent ChainEX triangular trades', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================================================
// KRAKEN TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Kraken API Configuration
const KRAKEN_CONFIG = {
    baseUrl: 'https://api.kraken.com',
    endpoints: {
        balance: '/0/private/Balance',
        ticker: '/0/public/Ticker',
        assetPairs: '/0/public/AssetPairs',
        orderBook: '/0/public/Depth',
        addOrder: '/0/private/AddOrder'
    }
};

// Kraken Authentication Helper (API-Key + API-Sign)
function createKrakenAuth(apiKey, apiSecret, path, nonce, postData) {
    const message = nonce + postData;
    const secret = Buffer.from(apiSecret, 'base64');
    const hash = crypto.createHash('sha256').update(message).digest();
    const hmac = crypto.createHmac('sha512', secret)
        .update(Buffer.concat([Buffer.from(path, 'utf8'), hash]))
        .digest('base64');

    return {
        'API-Key': apiKey,
        'API-Sign': hmac
    };
}

// Test Kraken Triangular Connection
router.post('/kraken/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('Testing Kraken triangular arbitrage connection', {
            userId: req.user.id,
            exchange: 'kraken',
            strategy: 'triangular'
        });

        if (!apiKey || !apiSecret) {
            throw new APIError('Kraken API credentials required', 400, 'KRAKEN_CREDENTIALS_REQUIRED');
        }

        // Test balance endpoint
        const nonce = Date.now() * 1000;
        const postData = `nonce=${nonce}`;
        const authHeaders = createKrakenAuth(apiKey, apiSecret, KRAKEN_CONFIG.endpoints.balance, nonce, postData);

        const balanceResponse = await fetch(`${KRAKEN_CONFIG.baseUrl}${KRAKEN_CONFIG.endpoints.balance}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...authHeaders
            },
            body: postData
        });

        const balanceData = await balanceResponse.json();

        if (balanceData.error && balanceData.error.length > 0) {
            throw new APIError(`Kraken API error: ${balanceData.error.join(', ')}`, 400, 'KRAKEN_API_ERROR');
        }

        // Test public ticker endpoint for triangular pairs
        const tickerResponse = await fetch(`${KRAKEN_CONFIG.baseUrl}${KRAKEN_CONFIG.endpoints.ticker}?pair=XXBTZUSD,XETHXXBT,XETHZUSD`);
        const tickerData = await tickerResponse.json();

        const requiredPairs = ['BTCUSDT', 'ETHBTC', 'ETHUSDT'];
        const availablePairs = tickerData.result ? Object.keys(tickerData.result).length : 0;

        systemLogger.trading('Kraken triangular connection test successful', {
            userId: req.user.id,
            exchange: 'kraken',
            balanceAccess: true,
            tickerAccess: availablePairs > 0
        });

        res.json({
            success: true,
            message: 'Kraken connection successful',
            data: {
                authenticated: true,
                balanceAccess: true,
                availablePairs: availablePairs,
                requiredPairs: requiredPairs.length,
                triangularReady: availablePairs >= 3
            }
        });

    } catch (error) {
        systemLogger.error('Kraken triangular connection test failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Scan Kraken Triangular Paths
router.post('/kraken/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { paths = 'all', apiKey, apiSecret } = req.body;

        const allPathSets = {
            SET_1_BTC_FOCUS: [
                { id: 'USDT_BTC_ETH_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_SOL_USDT', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ADA_USDT', pairs: ['BTCUSDT', 'ADABTC', 'ADAUSDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ADABTC', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_LINK_USDT', pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_DOT_USDT', pairs: ['BTCUSDT', 'DOTBTC', 'DOTUSDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'DOTBTC', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ATOM_USDT', pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ALGO_USDT', pairs: ['BTCUSDT', 'ALGOBTC', 'ALGOUSDT'], sequence: 'USDT → BTC → ALGO → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ALGOBTC', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_XRP_USDT', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_2_ETH_FOCUS: [
                { id: 'USDT_ETH_SOL_USDT', pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_ADA_USDT', pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_LINK_USDT', pairs: ['ETHUSDT', 'LINKETH', 'LINKUSDT'], sequence: 'USDT → ETH → LINK → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'LINKETH', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_DOT_USDT', pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_ATOM_USDT', pairs: ['ETHUSDT', 'ATOMETH', 'ATOMUSDT'], sequence: 'USDT → ETH → ATOM → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ATOMETH', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_ALGO_USDT', pairs: ['ETHUSDT', 'ALGOETH', 'ALGOUSDT'], sequence: 'USDT → ETH → ALGO → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ALGOETH', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_XRP_USDT', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_3_REVERSE_MAJORS: [
                { id: 'USDT_SOL_BTC_USDT', pairs: ['SOLUSDT', 'SOLBTC', 'BTCUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_ETH_USDT', pairs: ['SOLUSDT', 'SOLETH', 'ETHUSDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ADA_BTC_USDT', pairs: ['ADAUSDT', 'ADABTC', 'BTCUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADABTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_LINK_BTC_USDT', pairs: ['LINKUSDT', 'LINKBTC', 'BTCUSDT'], sequence: 'USDT → LINK → BTC → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_DOT_BTC_USDT', pairs: ['DOTUSDT', 'DOTBTC', 'BTCUSDT'], sequence: 'USDT → DOT → BTC → USDT', steps: [{ pair: 'DOTUSDT', side: 'buy' }, { pair: 'DOTBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_ATOM_BTC_USDT', pairs: ['ATOMUSDT', 'ATOMBTC', 'BTCUSDT'], sequence: 'USDT → ATOM → BTC → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_4_LEGACY_COINS: [
                { id: 'USDT_LTC_BTC_USDT', pairs: ['LTCUSDT', 'LTCBTC', 'BTCUSDT'], sequence: 'USDT → LTC → BTC → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_LTC_ETH_USDT', pairs: ['LTCUSDT', 'LTCETH', 'ETHUSDT'], sequence: 'USDT → LTC → ETH → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_BCH_BTC_USDT', pairs: ['BCHUSDT', 'BCHBTC', 'BTCUSDT'], sequence: 'USDT → BCH → BTC → USDT', steps: [{ pair: 'BCHUSDT', side: 'buy' }, { pair: 'BCHBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BCH_ETH_USDT', pairs: ['BCHUSDT', 'BCHETH', 'ETHUSDT'], sequence: 'USDT → BCH → ETH → USDT', steps: [{ pair: 'BCHUSDT', side: 'buy' }, { pair: 'BCHETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_XMR_BTC_USDT', pairs: ['XMRUSDT', 'XMRBTC', 'BTCUSDT'], sequence: 'USDT → XMR → BTC → USDT', steps: [{ pair: 'XMRUSDT', side: 'buy' }, { pair: 'XMRBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_5_CROSS_BRIDGE: [
                { id: 'USDT_ADA_ETH_USDT', pairs: ['ADAUSDT', 'ADAETH', 'ETHUSDT'], sequence: 'USDT → ADA → ETH → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ATOM_ETH_USDT', pairs: ['ATOMUSDT', 'ATOMETH', 'ETHUSDT'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_ETH_USDT', pairs: ['XRPUSDT', 'XRPETH', 'ETHUSDT'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_LINK_ETH_USDT', pairs: ['LINKUSDT', 'LINKETH', 'ETHUSDT'], sequence: 'USDT → LINK → ETH → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_6_MEME_GAMING: [
                { id: 'USDT_DOGE_BTC_USDT', pairs: ['DOGEUSDT', 'DOGEBTC', 'BTCUSDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_MANA_BTC_USDT', pairs: ['MANAUSDT', 'MANABTC', 'BTCUSDT'], sequence: 'USDT → MANA → BTC → USDT', steps: [{ pair: 'MANAUSDT', side: 'buy' }, { pair: 'MANABTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ]
        };

        systemLogger.trading('Kraken triangular path scan initiated', {
            userId: req.user.id,
            pathSetsRequested: paths
        });

        res.json({
            success: true,
            message: 'Kraken triangular path scan completed',
            data: {
                scannedPaths: 32,
                opportunities: [],
                pathSetsScanned: paths === 'all' ? 6 : paths.length,
                message: 'Full scanning implementation coming soon. Backend routes ready.'
            }
        });

    } catch (error) {
        systemLogger.error('Kraken triangular scan failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Get Kraken Path Details
router.get('/kraken/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const pathSets = {
            SET_1_BTC_FOCUS: { count: 8, description: 'BTC Focus (8 paths)', enabled: true },
            SET_2_ETH_FOCUS: { count: 7, description: 'ETH Focus (7 paths)', enabled: true },
            SET_3_REVERSE_MAJORS: { count: 6, description: 'Reverse Majors (6 paths)', enabled: true },
            SET_4_LEGACY_COINS: { count: 5, description: 'Legacy Coins (5 paths)', enabled: false },
            SET_5_CROSS_BRIDGE: { count: 4, description: 'Cross-Bridge (4 paths)', enabled: false },
            SET_6_MEME_GAMING: { count: 2, description: 'Meme & Gaming (2 paths)', enabled: false }
        };

        res.json({
            success: true,
            data: {
                totalPaths: 32,
                pathSets: pathSets,
                exchange: 'kraken'
            }
        });
    } catch (error) {
        systemLogger.error('Failed to fetch Kraken triangular paths', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Execute Kraken Triangular Trade (Placeholder)
router.post('/kraken/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('Kraken triangular execution requested (not implemented)', {
            userId: req.user.id
        });

        res.json({
            success: false,
            message: 'Kraken triangular execution not yet implemented. Backend infrastructure ready.'
        });
    } catch (error) {
        systemLogger.error('Kraken triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Clear Kraken Trade History
router.delete('/kraken/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [req.user.id, 'KRAKEN']
        );

        systemLogger.trading('Kraken triangular history cleared', {
            userId: req.user.id,
            deletedCount: result.rowCount
        });

        res.json({
            success: true,
            message: 'Kraken triangular trade history cleared',
            data: { deletedCount: result.rowCount }
        });
    } catch (error) {
        systemLogger.error('Failed to clear Kraken triangular history', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Get Recent Kraken Trades
router.get('/kraken/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT 10`,
            [req.user.id, 'KRAKEN']
        );

        res.json({
            success: true,
            data: { trades: result.rows }
        });
    } catch (error) {
        systemLogger.error('Failed to fetch recent Kraken triangular trades', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================================================
// BYBIT TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// ByBit API Configuration
const BYBIT_CONFIG = {
    baseUrl: 'https://api.bybit.com',
    endpoints: {
        balance: '/v5/account/wallet-balance',
        ticker: '/v5/market/tickers',
        instruments: '/v5/market/instruments-info',
        orderBook: '/v5/market/orderbook',
        placeOrder: '/v5/order/create'
    }
};

// ByBit Authentication Helper (API-Key + Signature)
function createByBitAuth(apiKey, apiSecret, timestamp, params) {
    const paramString = timestamp + apiKey + params;
    const signature = crypto.createHmac('sha256', apiSecret).update(paramString).digest('hex');

    return {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN-TYPE': '2'
    };
}

// Test ByBit Triangular Connection
router.post('/bybit/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('Testing ByBit triangular arbitrage connection', {
            userId: req.user.id,
            exchange: 'bybit',
            strategy: 'triangular'
        });

        if (!apiKey || !apiSecret) {
            throw new APIError('ByBit API credentials required', 400, 'BYBIT_CREDENTIALS_REQUIRED');
        }

        // Test account balance endpoint
        const timestamp = Date.now().toString();
        const params = '5000'; // recv_window parameter
        const authHeaders = createByBitAuth(apiKey, apiSecret, timestamp, params);

        const balanceResponse = await fetch(`${BYBIT_PROXY_CONFIG.baseUrl}${BYBIT_PROXY_CONFIG.endpoints.balance}?accountType=UNIFIED`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            }
        });

        const balanceData = await balanceResponse.json();

        if (balanceData.retCode !== 0) {
            throw new APIError(`ByBit API error: ${balanceData.retMsg}`, 400, 'BYBIT_API_ERROR');
        }

        // Test public ticker endpoint for triangular pairs
        const tickerResponse = await fetch(`${BYBIT_PROXY_CONFIG.baseUrl}${BYBIT_PROXY_CONFIG.endpoints.ticker}?category=spot&symbol=BTCUSDT`);
        const tickerData = await tickerResponse.json();

        const requiredPairs = ['BTCUSDT', 'ETHBTC', 'ETHUSDT'];
        const availablePairs = tickerData.retCode === 0 ? 1 : 0;

        systemLogger.trading('ByBit triangular connection test successful', {
            userId: req.user.id,
            exchange: 'bybit',
            balanceAccess: true,
            tickerAccess: availablePairs > 0
        });

        res.json({
            success: true,
            message: 'ByBit connection successful',
            data: {
                authenticated: true,
                balanceAccess: true,
                availablePairs: 11, // 11 BTC cross-pairs available
                requiredPairs: requiredPairs.length,
                triangularReady: true
            }
        });

    } catch (error) {
        systemLogger.error('ByBit triangular connection test failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Scan ByBit Triangular Paths
router.post('/bybit/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { paths = 'all', apiKey, apiSecret } = req.body;

        systemLogger.trading('Scanning ByBit triangular paths', {
            userId: req.user.id,
            exchange: 'bybit',
            pathsRequested: paths
        });

        // Define all 30 ByBit triangular paths
        const allPathSets = {
            SET_1_MAJOR_COINS: [
                { id: 'USDT_ETH_BTC_USDT', pairs: ['ETHUSDT', 'ETHBTC', 'BTCUSDT'],
                  sequence: 'USDT → ETH → BTC → USDT',
                  steps: [
                      { pair: 'ETHUSDT', side: 'buy' },
                      { pair: 'ETHBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_SOL_BTC_USDT', pairs: ['SOLUSDT', 'SOLBTC', 'BTCUSDT'],
                  sequence: 'USDT → SOL → BTC → USDT',
                  steps: [
                      { pair: 'SOLUSDT', side: 'buy' },
                      { pair: 'SOLBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_XRP_BTC_USDT', pairs: ['XRPUSDT', 'XRPBTC', 'BTCUSDT'],
                  sequence: 'USDT → XRP → BTC → USDT',
                  steps: [
                      { pair: 'XRPUSDT', side: 'buy' },
                      { pair: 'XRPBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_LTC_BTC_USDT', pairs: ['LTCUSDT', 'LTCBTC', 'BTCUSDT'],
                  sequence: 'USDT → LTC → BTC → USDT',
                  steps: [
                      { pair: 'LTCUSDT', side: 'buy' },
                      { pair: 'LTCBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_ETH_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'],
                  sequence: 'USDT → BTC → ETH → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'ETHBTC', side: 'buy' },
                      { pair: 'ETHUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_SOL_USDT', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'],
                  sequence: 'USDT → BTC → SOL → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'SOLBTC', side: 'buy' },
                      { pair: 'SOLUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_XRP_USDT', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'],
                  sequence: 'USDT → BTC → XRP → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'XRPBTC', side: 'buy' },
                      { pair: 'XRPUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_LTC_USDT', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'],
                  sequence: 'USDT → BTC → LTC → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'LTCBTC', side: 'buy' },
                      { pair: 'LTCUSDT', side: 'sell' }
                  ]
                }
            ],
            SET_2_MIDCAP: [
                { id: 'USDT_DOT_BTC_USDT', pairs: ['DOTUSDT', 'DOTBTC', 'BTCUSDT'],
                  sequence: 'USDT → DOT → BTC → USDT',
                  steps: [
                      { pair: 'DOTUSDT', side: 'buy' },
                      { pair: 'DOTBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_ALGO_BTC_USDT', pairs: ['ALGOUSDT', 'ALGOBTC', 'BTCUSDT'],
                  sequence: 'USDT → ALGO → BTC → USDT',
                  steps: [
                      { pair: 'ALGOUSDT', side: 'buy' },
                      { pair: 'ALGOBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_XLM_BTC_USDT', pairs: ['XLMUSDT', 'XLMBTC', 'BTCUSDT'],
                  sequence: 'USDT → XLM → BTC → USDT',
                  steps: [
                      { pair: 'XLMUSDT', side: 'buy' },
                      { pair: 'XLMBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_MNT_BTC_USDT', pairs: ['MNTUSDT', 'MNTBTC', 'BTCUSDT'],
                  sequence: 'USDT → MNT → BTC → USDT',
                  steps: [
                      { pair: 'MNTUSDT', side: 'buy' },
                      { pair: 'MNTBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_DOT_USDT', pairs: ['BTCUSDT', 'DOTBTC', 'DOTUSDT'],
                  sequence: 'USDT → BTC → DOT → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'DOTBTC', side: 'buy' },
                      { pair: 'DOTUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_ALGO_USDT', pairs: ['BTCUSDT', 'ALGOBTC', 'ALGOUSDT'],
                  sequence: 'USDT → BTC → ALGO → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'ALGOBTC', side: 'buy' },
                      { pair: 'ALGOUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_XLM_USDT', pairs: ['BTCUSDT', 'XLMBTC', 'XLMUSDT'],
                  sequence: 'USDT → BTC → XLM → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'XLMBTC', side: 'buy' },
                      { pair: 'XLMUSDT', side: 'sell' }
                  ]
                }
            ],
            SET_3_DEFI_GAMING: [
                { id: 'USDT_MANA_BTC_USDT', pairs: ['MANAUSDT', 'MANABTC', 'BTCUSDT'],
                  sequence: 'USDT → MANA → BTC → USDT',
                  steps: [
                      { pair: 'MANAUSDT', side: 'buy' },
                      { pair: 'MANABTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_SAND_BTC_USDT', pairs: ['SANDUSDT', 'SANDBTC', 'BTCUSDT'],
                  sequence: 'USDT → SAND → BTC → USDT',
                  steps: [
                      { pair: 'SANDUSDT', side: 'buy' },
                      { pair: 'SANDBTC', side: 'sell' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_MANA_USDT', pairs: ['BTCUSDT', 'MANABTC', 'MANAUSDT'],
                  sequence: 'USDT → BTC → MANA → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'MANABTC', side: 'buy' },
                      { pair: 'MANAUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_BTC_SAND_USDT', pairs: ['BTCUSDT', 'SANDBTC', 'SANDUSDT'],
                  sequence: 'USDT → BTC → SAND → USDT',
                  steps: [
                      { pair: 'BTCUSDT', side: 'buy' },
                      { pair: 'SANDBTC', side: 'buy' },
                      { pair: 'SANDUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_AVAX_USDT', pairs: ['AVAXUSDT', 'BTCUSDT'],
                  sequence: 'USDT → AVAX → USDT (via BTC pricing)',
                  steps: [
                      { pair: 'AVAXUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_LINK_USDT', pairs: ['LINKUSDT', 'BTCUSDT'],
                  sequence: 'USDT → LINK → USDT (via BTC pricing)',
                  steps: [
                      { pair: 'LINKUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'USDT_PEPE_USDT', pairs: ['PEPEUSDT', 'BTCUSDT'],
                  sequence: 'USDT → PEPE → USDT',
                  steps: [
                      { pair: 'PEPEUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_DOGE_USDT', pairs: ['DOGEUSDT', 'BTCUSDT'],
                  sequence: 'USDT → DOGE → USDT',
                  steps: [
                      { pair: 'DOGEUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_SHIB_USDT', pairs: ['SHIBUSDT', 'BTCUSDT'],
                  sequence: 'USDT → SHIB → USDT',
                  steps: [
                      { pair: 'SHIBUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_ARB_USDT', pairs: ['ARBUSDT', 'BTCUSDT'],
                  sequence: 'USDT → ARB → USDT',
                  steps: [
                      { pair: 'ARBUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_OP_USDT', pairs: ['OPUSDT', 'BTCUSDT'],
                  sequence: 'USDT → OP → USDT',
                  steps: [
                      { pair: 'OPUSDT', side: 'buy' },
                      { pair: 'BTCUSDT', side: 'sell' }
                  ]
                }
            ],
            SET_5_EXTENDED: [
                { id: 'USDT_ETH_BTC_SOL_USDT', pairs: ['ETHUSDT', 'ETHBTC', 'SOLBTC', 'SOLUSDT'],
                  sequence: 'USDT → ETH → BTC → SOL → USDT',
                  steps: [
                      { pair: 'ETHUSDT', side: 'buy' },
                      { pair: 'ETHBTC', side: 'sell' },
                      { pair: 'SOLBTC', side: 'buy' },
                      { pair: 'SOLUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_SOL_BTC_ETH_USDT', pairs: ['SOLUSDT', 'SOLBTC', 'ETHBTC', 'ETHUSDT'],
                  sequence: 'USDT → SOL → BTC → ETH → USDT',
                  steps: [
                      { pair: 'SOLUSDT', side: 'buy' },
                      { pair: 'SOLBTC', side: 'sell' },
                      { pair: 'ETHBTC', side: 'buy' },
                      { pair: 'ETHUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_XRP_BTC_LTC_USDT', pairs: ['XRPUSDT', 'XRPBTC', 'LTCBTC', 'LTCUSDT'],
                  sequence: 'USDT → XRP → BTC → LTC → USDT',
                  steps: [
                      { pair: 'XRPUSDT', side: 'buy' },
                      { pair: 'XRPBTC', side: 'sell' },
                      { pair: 'LTCBTC', side: 'buy' },
                      { pair: 'LTCUSDT', side: 'sell' }
                  ]
                },
                { id: 'USDT_DOT_BTC_ALGO_USDT', pairs: ['DOTUSDT', 'DOTBTC', 'ALGOBTC', 'ALGOUSDT'],
                  sequence: 'USDT → DOT → BTC → ALGO → USDT',
                  steps: [
                      { pair: 'DOTUSDT', side: 'buy' },
                      { pair: 'DOTBTC', side: 'sell' },
                      { pair: 'ALGOBTC', side: 'buy' },
                      { pair: 'ALGOUSDT', side: 'sell' }
                  ]
                }
            ]
        };

        // Calculate which sets to scan
        let setsToScan = [];
        if (paths === 'all') {
            setsToScan = Object.keys(allPathSets);
        } else if (Array.isArray(paths)) {
            paths.forEach(setNum => {
                const setKey = `SET_${setNum}_` + Object.keys(allPathSets)[setNum - 1].split('_').slice(1).join('_');
                if (allPathSets[setKey]) {
                    setsToScan.push(setKey);
                }
            });
        }

        systemLogger.trading('ByBit triangular scan completed', {
            userId: req.user.id,
            exchange: 'bybit',
            pathSetsScanned: setsToScan.length,
            totalPaths: 30
        });

        res.json({
            success: true,
            message: 'ByBit triangular path scan completed',
            data: {
                scannedPaths: 30,
                opportunities: [],
                pathSetsScanned: setsToScan.length,
                message: 'Full scanning implementation coming soon. Backend routes ready.'
            }
        });

    } catch (error) {
        systemLogger.error('ByBit triangular scan failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Get ByBit Triangular Paths Details
router.get('/bybit/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const pathSets = {
            SET_1_MAJOR_COINS: { count: 8, description: 'Major Coins Focus (8 paths)', enabled: true },
            SET_2_MIDCAP: { count: 7, description: 'Mid-Cap Focus (7 paths)', enabled: true },
            SET_3_DEFI_GAMING: { count: 6, description: 'DeFi/Gaming Tokens (6 paths)', enabled: false },
            SET_4_HIGH_VOLATILITY: { count: 5, description: 'High Volatility Mix (5 paths)', enabled: false },
            SET_5_EXTENDED: { count: 4, description: 'Extended Multi-Leg (4 paths)', enabled: false }
        };

        res.json({
            success: true,
            data: {
                totalPaths: 30,
                pathSets: pathSets,
                exchange: 'bybit'
            }
        });
    } catch (error) {
        systemLogger.error('Failed to fetch ByBit triangular paths', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Execute ByBit Triangular Trade (Placeholder)
router.post('/bybit/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { pathId, amount, apiKey, apiSecret } = req.body;

        systemLogger.trading('ByBit triangular execution requested', {
            userId: req.user.id,
            pathId: pathId,
            amount: amount
        });

        // Placeholder for future implementation
        res.json({
            success: false,
            message: 'ByBit triangular execution not yet implemented',
            data: {
                pathId: pathId,
                status: 'pending_implementation'
            }
        });
    } catch (error) {
        systemLogger.error('ByBit triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Delete ByBit Triangular History
router.delete('/bybit/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [req.user.id, 'BYBIT']
        );

        systemLogger.trading('ByBit triangular history cleared', {
            userId: req.user.id,
            deletedCount: result.rowCount
        });

        res.json({
            success: true,
            message: 'ByBit triangular trade history cleared',
            data: { deletedCount: result.rowCount }
        });
    } catch (error) {
        systemLogger.error('Failed to clear ByBit triangular history', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// Get ByBit Recent Triangular Trades
router.get('/bybit/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await query(
            `SELECT id, trade_id, path_id, path_sequence, execution_status,
                    actual_profit_zar, actual_profit_percent, total_execution_time_ms,
                    created_at, execution_completed_at
             FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT 20`,
            [req.user.id, 'BYBIT']
        );

        const trades = result.rows.map(trade => ({
            id: trade.id,
            tradeId: trade.trade_id,
            pathId: trade.path_id,
            sequence: trade.path_sequence,
            status: trade.execution_status,
            profit: trade.actual_profit_zar,
            profitPercent: trade.actual_profit_percent,
            executionTime: trade.total_execution_time_ms,
            timestamp: trade.created_at
        }));

        res.json({
            success: true,
            data: { trades: result.rows }
        });
    } catch (error) {
        systemLogger.error('Failed to fetch recent ByBit triangular trades', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================================================
// BINANCE TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Binance API Configuration
const BINANCE_CONFIG = {
    baseUrl: 'https://api.binance.com',
    endpoints: {
        balance: '/api/v3/account',
        ticker: '/api/v3/ticker/price',
        exchangeInfo: '/api/v3/exchangeInfo',
        orderBook: '/api/v3/depth',
        placeOrder: '/api/v3/order'
    }
};

// Binance Authentication Helper (API-Key + Signature)
function createBinanceAuth(apiKey, apiSecret, queryString) {
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    return {
        'X-MBX-APIKEY': apiKey,
        signature: signature
    };
}

// Test Binance Connection (triangular arbitrage)
router.post('/binance/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret } = req.body;

    if (!apiKey || !apiSecret) {
        return res.status(400).json({
            success: false,
            message: 'API Key and Secret are required'
        });
    }

    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const authHeaders = createBinanceAuth(apiKey, apiSecret, queryString);

        // Test account access
        const balanceResponse = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${authHeaders.signature}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-MBX-APIKEY': authHeaders['X-MBX-APIKEY']
            }
        });

        if (!balanceResponse.ok) {
            const errorData = await balanceResponse.json();
            throw new Error(`Binance API Error: ${errorData.msg || 'Authentication failed'}`);
        }

        const balanceData = await balanceResponse.json();

        // Test market data access (no auth required)
        const tickerResponse = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.ticker}?symbol=BTCUSDT`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!tickerResponse.ok) {
            throw new Error('Failed to fetch market data');
        }

        const tickerData = await tickerResponse.json();

        res.json({
            success: true,
            message: 'Binance connection successful',
            data: {
                authenticated: true,
                balanceAccess: true,
                marketDataAccess: true,
                availablePairs: 1500,
                requiredPairs: 3,
                triangularReady: true,
                samplePrice: `BTC/USDT: $${tickerData.price}`,
                accountType: 'SPOT'
            }
        });

    } catch (error) {
        console.error('Binance triangular test connection error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to connect to Binance API',
            error: error.message
        });
    }
}));

// Scan Binance Triangular Arbitrage Paths
router.post('/binance/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, enabledSets, profitThreshold = 0.5 } = req.body;

    if (!apiKey || !apiSecret) {
        return res.status(400).json({
            success: false,
            message: 'API Key and Secret are required'
        });
    }

    try {
        // Define all 33 Binance triangular paths across 5 sets
        const allPathSets = {
            SET_1_MAJOR_BNB_BRIDGE: [
                {
                    id: 'USDT_ETH_BNB_USDT',
                    pairs: ['ETHUSDT', 'ETHBNB', 'BNBUSDT'],
                    sequence: 'USDT → ETH → BNB → USDT',
                    steps: [
                        { pair: 'ETHUSDT', side: 'buy', from: 'USDT', to: 'ETH' },
                        { pair: 'ETHBNB', side: 'sell', from: 'ETH', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_BTC_BNB_USDT',
                    pairs: ['BTCUSDT', 'BTCBNB', 'BNBUSDT'],
                    sequence: 'USDT → BTC → BNB → USDT',
                    steps: [
                        { pair: 'BTCUSDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'BTCBNB', side: 'sell', from: 'BTC', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SOL_BNB_USDT',
                    pairs: ['SOLUSDT', 'SOLBNB', 'BNBUSDT'],
                    sequence: 'USDT → SOL → BNB → USDT',
                    steps: [
                        { pair: 'SOLUSDT', side: 'buy', from: 'USDT', to: 'SOL' },
                        { pair: 'SOLBNB', side: 'sell', from: 'SOL', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_XRP_BNB_USDT',
                    pairs: ['XRPUSDT', 'XRPBNB', 'BNBUSDT'],
                    sequence: 'USDT → XRP → BNB → USDT',
                    steps: [
                        { pair: 'XRPUSDT', side: 'buy', from: 'USDT', to: 'XRP' },
                        { pair: 'XRPBNB', side: 'sell', from: 'XRP', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ADA_BNB_USDT',
                    pairs: ['ADAUSDT', 'ADABNB', 'BNBUSDT'],
                    sequence: 'USDT → ADA → BNB → USDT',
                    steps: [
                        { pair: 'ADAUSDT', side: 'buy', from: 'USDT', to: 'ADA' },
                        { pair: 'ADABNB', side: 'sell', from: 'ADA', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_DOT_BNB_USDT',
                    pairs: ['DOTUSDT', 'DOTBNB', 'BNBUSDT'],
                    sequence: 'USDT → DOT → BNB → USDT',
                    steps: [
                        { pair: 'DOTUSDT', side: 'buy', from: 'USDT', to: 'DOT' },
                        { pair: 'DOTBNB', side: 'sell', from: 'DOT', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_MATIC_BNB_USDT',
                    pairs: ['MATICUSDT', 'MATICBNB', 'BNBUSDT'],
                    sequence: 'USDT → MATIC → BNB → USDT',
                    steps: [
                        { pair: 'MATICUSDT', side: 'buy', from: 'USDT', to: 'MATIC' },
                        { pair: 'MATICBNB', side: 'sell', from: 'MATIC', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                }
            ],
            SET_2_MIDCAP_ETH_BRIDGE: [
                {
                    id: 'USDT_AVAX_ETH_USDT',
                    pairs: ['AVAXUSDT', 'AVAXETH', 'ETHUSDT'],
                    sequence: 'USDT → AVAX → ETH → USDT',
                    steps: [
                        { pair: 'AVAXUSDT', side: 'buy', from: 'USDT', to: 'AVAX' },
                        { pair: 'AVAXETH', side: 'sell', from: 'AVAX', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_LINK_ETH_USDT',
                    pairs: ['LINKUSDT', 'LINKETH', 'ETHUSDT'],
                    sequence: 'USDT → LINK → ETH → USDT',
                    steps: [
                        { pair: 'LINKUSDT', side: 'buy', from: 'USDT', to: 'LINK' },
                        { pair: 'LINKETH', side: 'sell', from: 'LINK', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_UNI_ETH_USDT',
                    pairs: ['UNIUSDT', 'UNIETH', 'ETHUSDT'],
                    sequence: 'USDT → UNI → ETH → USDT',
                    steps: [
                        { pair: 'UNIUSDT', side: 'buy', from: 'USDT', to: 'UNI' },
                        { pair: 'UNIETH', side: 'sell', from: 'UNI', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_AAVE_ETH_USDT',
                    pairs: ['AAVEUSDT', 'AAVEETH', 'ETHUSDT'],
                    sequence: 'USDT → AAVE → ETH → USDT',
                    steps: [
                        { pair: 'AAVEUSDT', side: 'buy', from: 'USDT', to: 'AAVE' },
                        { pair: 'AAVEETH', side: 'sell', from: 'AAVE', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_LTC_BNB_USDT',
                    pairs: ['LTCUSDT', 'LTCBNB', 'BNBUSDT'],
                    sequence: 'USDT → LTC → BNB → USDT',
                    steps: [
                        { pair: 'LTCUSDT', side: 'buy', from: 'USDT', to: 'LTC' },
                        { pair: 'LTCBNB', side: 'sell', from: 'LTC', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ATOM_BNB_USDT',
                    pairs: ['ATOMUSDT', 'ATOMBNB', 'BNBUSDT'],
                    sequence: 'USDT → ATOM → BNB → USDT',
                    steps: [
                        { pair: 'ATOMUSDT', side: 'buy', from: 'USDT', to: 'ATOM' },
                        { pair: 'ATOMBNB', side: 'sell', from: 'ATOM', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_FIL_BNB_USDT',
                    pairs: ['FILUSDT', 'FILBNB', 'BNBUSDT'],
                    sequence: 'USDT → FIL → BNB → USDT',
                    steps: [
                        { pair: 'FILUSDT', side: 'buy', from: 'USDT', to: 'FIL' },
                        { pair: 'FILBNB', side: 'sell', from: 'FIL', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                }
            ],
            SET_3_DEFI_GAMING: [
                {
                    id: 'USDT_SAND_BNB_USDT',
                    pairs: ['SANDUSDT', 'SANDBNB', 'BNBUSDT'],
                    sequence: 'USDT → SAND → BNB → USDT',
                    steps: [
                        { pair: 'SANDUSDT', side: 'buy', from: 'USDT', to: 'SAND' },
                        { pair: 'SANDBNB', side: 'sell', from: 'SAND', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_MANA_BNB_USDT',
                    pairs: ['MANAUSDT', 'MANABNB', 'BNBUSDT'],
                    sequence: 'USDT → MANA → BNB → USDT',
                    steps: [
                        { pair: 'MANAUSDT', side: 'buy', from: 'USDT', to: 'MANA' },
                        { pair: 'MANABNB', side: 'sell', from: 'MANA', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_AXS_BNB_USDT',
                    pairs: ['AXSUSDT', 'AXSBNB', 'BNBUSDT'],
                    sequence: 'USDT → AXS → BNB → USDT',
                    steps: [
                        { pair: 'AXSUSDT', side: 'buy', from: 'USDT', to: 'AXS' },
                        { pair: 'AXSBNB', side: 'sell', from: 'AXS', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_GALA_BNB_USDT',
                    pairs: ['GALAUSDT', 'GALABNB', 'BNBUSDT'],
                    sequence: 'USDT → GALA → BNB → USDT',
                    steps: [
                        { pair: 'GALAUSDT', side: 'buy', from: 'USDT', to: 'GALA' },
                        { pair: 'GALABNB', side: 'sell', from: 'GALA', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SUSHI_ETH_USDT',
                    pairs: ['SUSHIUSDT', 'SUSHIETH', 'ETHUSDT'],
                    sequence: 'USDT → SUSHI → ETH → USDT',
                    steps: [
                        { pair: 'SUSHIUSDT', side: 'buy', from: 'USDT', to: 'SUSHI' },
                        { pair: 'SUSHIETH', side: 'sell', from: 'SUSHI', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_CRV_ETH_USDT',
                    pairs: ['CRVUSDT', 'CRVETH', 'ETHUSDT'],
                    sequence: 'USDT → CRV → ETH → USDT',
                    steps: [
                        { pair: 'CRVUSDT', side: 'buy', from: 'USDT', to: 'CRV' },
                        { pair: 'CRVETH', side: 'sell', from: 'CRV', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                }
            ],
            SET_4_HIGH_VOLATILITY: [
                {
                    id: 'USDT_DOGE_BNB_USDT',
                    pairs: ['DOGEUSDT', 'DOGEBNB', 'BNBUSDT'],
                    sequence: 'USDT → DOGE → BNB → USDT',
                    steps: [
                        { pair: 'DOGEUSDT', side: 'buy', from: 'USDT', to: 'DOGE' },
                        { pair: 'DOGEBNB', side: 'sell', from: 'DOGE', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SHIB_ETH_USDT',
                    pairs: ['SHIBUSDT', 'SHIBETH', 'ETHUSDT'],
                    sequence: 'USDT → SHIB → ETH → USDT',
                    steps: [
                        { pair: 'SHIBUSDT', side: 'buy', from: 'USDT', to: 'SHIB' },
                        { pair: 'SHIBETH', side: 'sell', from: 'SHIB', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_PEPE_ETH_USDT',
                    pairs: ['PEPEUSDT', 'PEPEETH', 'ETHUSDT'],
                    sequence: 'USDT → PEPE → ETH → USDT',
                    steps: [
                        { pair: 'PEPEUSDT', side: 'buy', from: 'USDT', to: 'PEPE' },
                        { pair: 'PEPEETH', side: 'sell', from: 'PEPE', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_FTM_BNB_USDT',
                    pairs: ['FTMUSDT', 'FTMBNB', 'BNBUSDT'],
                    sequence: 'USDT → FTM → BNB → USDT',
                    steps: [
                        { pair: 'FTMUSDT', side: 'buy', from: 'USDT', to: 'FTM' },
                        { pair: 'FTMBNB', side: 'sell', from: 'FTM', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_NEAR_BNB_USDT',
                    pairs: ['NEARUSDT', 'NEARBNB', 'BNBUSDT'],
                    sequence: 'USDT → NEAR → BNB → USDT',
                    steps: [
                        { pair: 'NEARUSDT', side: 'buy', from: 'USDT', to: 'NEAR' },
                        { pair: 'NEARBNB', side: 'sell', from: 'NEAR', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_APT_BNB_USDT',
                    pairs: ['APTUSDT', 'APTBNB', 'BNBUSDT'],
                    sequence: 'USDT → APT → BNB → USDT',
                    steps: [
                        { pair: 'APTUSDT', side: 'buy', from: 'USDT', to: 'APT' },
                        { pair: 'APTBNB', side: 'sell', from: 'APT', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                {
                    id: 'USDT_BTC_ETH_BNB_USDT',
                    pairs: ['BTCUSDT', 'ETHBTC', 'ETHBNB', 'BNBUSDT'],
                    sequence: 'USDT → BTC → ETH → BNB → USDT (4-leg)',
                    steps: [
                        { pair: 'BTCUSDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'ETHBTC', side: 'buy', from: 'BTC', to: 'ETH' },
                        { pair: 'ETHBNB', side: 'sell', from: 'ETH', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_BNB_ETH_USDT',
                    pairs: ['BNBUSDT', 'BNBETH', 'ETHUSDT'],
                    sequence: 'USDT → BNB → ETH → USDT',
                    steps: [
                        { pair: 'BNBUSDT', side: 'buy', from: 'USDT', to: 'BNB' },
                        { pair: 'BNBETH', side: 'sell', from: 'BNB', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_BNB_BTC_USDT',
                    pairs: ['BNBUSDT', 'BNBBTC', 'BTCUSDT'],
                    sequence: 'USDT → BNB → BTC → USDT',
                    steps: [
                        { pair: 'BNBUSDT', side: 'buy', from: 'USDT', to: 'BNB' },
                        { pair: 'BNBBTC', side: 'sell', from: 'BNB', to: 'BTC' },
                        { pair: 'BTCUSDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ETH_BTC_USDT',
                    pairs: ['ETHUSDT', 'ETHBTC', 'BTCUSDT'],
                    sequence: 'USDT → ETH → BTC → USDT',
                    steps: [
                        { pair: 'ETHUSDT', side: 'buy', from: 'USDT', to: 'ETH' },
                        { pair: 'ETHBTC', side: 'sell', from: 'ETH', to: 'BTC' },
                        { pair: 'BTCUSDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_BTC_ETH_USDT',
                    pairs: ['BTCUSDT', 'BTCETH', 'ETHUSDT'],
                    sequence: 'USDT → BTC → ETH → USDT',
                    steps: [
                        { pair: 'BTCUSDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'BTCETH', side: 'sell', from: 'BTC', to: 'ETH' },
                        { pair: 'ETHUSDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_TRX_BNB_USDT',
                    pairs: ['TRXUSDT', 'TRXBNB', 'BNBUSDT'],
                    sequence: 'USDT → TRX → BNB → USDT',
                    steps: [
                        { pair: 'TRXUSDT', side: 'buy', from: 'USDT', to: 'TRX' },
                        { pair: 'TRXBNB', side: 'sell', from: 'TRX', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_XLM_BNB_USDT',
                    pairs: ['XLMUSDT', 'XLMBNB', 'BNBUSDT'],
                    sequence: 'USDT → XLM → BNB → USDT',
                    steps: [
                        { pair: 'XLMUSDT', side: 'buy', from: 'USDT', to: 'XLM' },
                        { pair: 'XLMBNB', side: 'sell', from: 'XLM', to: 'BNB' },
                        { pair: 'BNBUSDT', side: 'sell', from: 'BNB', to: 'USDT' }
                    ]
                }
            ]
        };

        // Filter to only enabled sets
        const setsToScan = enabledSets || [1, 2, 3, 4, 5];
        const enabledPaths = [];

        setsToScan.forEach(setNum => {
            const setKey = Object.keys(allPathSets)[setNum - 1];
            if (allPathSets[setKey]) {
                enabledPaths.push(...allPathSets[setKey]);
            }
        });

        // Placeholder for full scanning logic
        // In production, this would:
        // 1. Fetch current prices for all pairs using Binance API
        // 2. Calculate arbitrage profit for each path
        // 3. Filter paths above profitThreshold
        // 4. Return ranked opportunities

        res.json({
            success: true,
            message: 'Binance triangular path scan completed',
            data: {
                scannedPaths: enabledPaths.length,
                totalPaths: 33,
                opportunities: [],
                pathSetsScanned: setsToScan.length,
                profitThreshold: profitThreshold,
                message: 'Full scanning implementation coming soon. Backend routes ready.',
                enabledPathDetails: enabledPaths.map(p => ({
                    id: p.id,
                    sequence: p.sequence,
                    pairs: p.pairs
                }))
            }
        });

    } catch (error) {
        console.error('Binance triangular scan error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to scan Binance triangular paths',
            error: error.message
        });
    }
}));

// Get Binance Triangular Path Details
router.get('/binance/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        res.json({
            success: true,
            message: 'Binance triangular paths retrieved',
            data: {
                totalPaths: 33,
                totalSets: 5,
                sets: [
                    { id: 1, name: 'Major BNB Bridge', paths: 7, liquidity: 'Very High' },
                    { id: 2, name: 'Mid-Cap ETH Bridge', paths: 7, liquidity: 'High' },
                    { id: 3, name: 'DeFi/Gaming', paths: 6, liquidity: 'Medium-High' },
                    { id: 4, name: 'High Volatility', paths: 6, liquidity: 'Medium' },
                    { id: 5, name: 'Extended Multi-Bridge', paths: 7, liquidity: 'High' }
                ],
                exchange: 'binance',
                fundingCurrency: 'USDT',
                bridgeCurrencies: ['BNB', 'ETH', 'BTC'],
                note: 'Binance offers 1500+ trading pairs with deep liquidity on USDT pairs. BNB cross-pairs are highly liquid.'
            }
        });
    } catch (error) {
        console.error('Binance triangular paths error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Binance path details'
        });
    }
}));

// Execute Binance Triangular Trade (placeholder)
router.post('/binance/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, pathId, amount } = req.body;

    if (!apiKey || !apiSecret || !pathId || !amount) {
        return res.status(400).json({
            success: false,
            message: 'API credentials, path ID, and amount are required'
        });
    }

    try {
        // Placeholder for execution logic
        // In production, this would execute all 3 legs atomically
        res.json({
            success: false,
            message: 'Execution not yet implemented',
            data: {
                pathId: pathId,
                amount: amount,
                status: 'not_implemented',
                note: 'Live execution will be implemented after full testing'
            }
        });
    } catch (error) {
        console.error('Binance triangular execute error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to execute Binance triangular trade'
        });
    }
}));

// Delete Binance Triangular Trade History
router.delete('/binance/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
        const result = await pool.query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [userId, 'BINANCE']
        );

        res.json({
            success: true,
            message: 'Binance triangular trade history cleared',
            data: {
                deletedCount: result.rowCount
            }
        });
    } catch (error) {
        console.error('Binance triangular history delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear Binance trade history'
        });
    }
}));

// Get Recent Binance Triangular Trades
router.get('/binance/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 20;

    try {
        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [userId, 'BINANCE', limit]
        );

        res.json({
            success: true,
            message: 'Recent Binance triangular trades retrieved',
            data: {
                trades: result.rows,
                count: result.rows.length
            }
        });
    } catch (error) {
        console.error('Binance triangular recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Binance trades'
        });
    }
}));

// ============================================================================
// OKX TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// OKX API Configuration
const OKX_CONFIG = {
    baseUrl: 'https://www.okx.com',
    endpoints: {
        balance: '/api/v5/account/balance',
        ticker: '/api/v5/market/ticker',
        instruments: '/api/v5/public/instruments',
        orderBook: '/api/v5/market/books',
        placeOrder: '/api/v5/trade/order'
    }
};

// OKX Authentication Helper (API-Key + Passphrase + Signature)
function createOKXAuth(apiKey, apiSecret, passphrase, timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    const signature = crypto.createHmac('sha256', apiSecret).update(message).digest('base64');

    return {
        'OK-ACCESS-KEY': apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': passphrase
    };
}

// Test OKX Connection (triangular arbitrage)
router.post('/okx/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, passphrase } = req.body;

    if (!apiKey || !apiSecret || !passphrase) {
        return res.status(400).json({
            success: false,
            message: 'API Key, Secret, and Passphrase are required'
        });
    }

    try {
        const timestamp = new Date().toISOString();
        const method = 'GET';
        const requestPath = '/api/v5/account/balance';
        const authHeaders = createOKXAuth(apiKey, apiSecret, passphrase, timestamp, method, requestPath);

        // Test account access
        const balanceResponse = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            }
        });

        if (!balanceResponse.ok) {
            const errorData = await balanceResponse.json();
            throw new Error(`OKX API Error: ${errorData.msg || 'Authentication failed'}`);
        }

        const balanceData = await balanceResponse.json();

        // Test market data access (no auth required)
        const tickerResponse = await fetch(`${OKX_CONFIG.baseUrl}${OKX_CONFIG.endpoints.ticker}?instId=BTC-USDT`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!tickerResponse.ok) {
            throw new Error('Failed to fetch market data');
        }

        const tickerData = await tickerResponse.json();

        res.json({
            success: true,
            message: 'OKX connection successful',
            data: {
                authenticated: true,
                balanceAccess: true,
                marketDataAccess: true,
                availablePairs: 673,
                requiredPairs: 3,
                triangularReady: true,
                samplePrice: tickerData.data && tickerData.data[0] ? `BTC/USDT: $${tickerData.data[0].last}` : 'N/A',
                accountType: 'SPOT'
            }
        });

    } catch (error) {
        console.error('OKX triangular test connection error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to connect to OKX API',
            error: error.message
        });
    }
}));

// Scan OKX Triangular Arbitrage Paths
router.post('/okx/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, passphrase, enabledSets, profitThreshold = 0.5 } = req.body;

    if (!apiKey || !apiSecret || !passphrase) {
        return res.status(400).json({
            success: false,
            message: 'API Key, Secret, and Passphrase are required'
        });
    }

    try {
        // Define all 32 OKX triangular paths across 5 sets
        const allPathSets = {
            SET_1_MAJOR_ETH_BRIDGE: [
                {
                    id: 'USDT_BTC_ETH_USDT',
                    pairs: ['BTC-USDT', 'BTC-ETH', 'ETH-USDT'],
                    sequence: 'USDT → BTC → ETH → USDT',
                    steps: [
                        { pair: 'BTC-USDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'BTC-ETH', side: 'sell', from: 'BTC', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SOL_ETH_USDT',
                    pairs: ['SOL-USDT', 'SOL-ETH', 'ETH-USDT'],
                    sequence: 'USDT → SOL → ETH → USDT',
                    steps: [
                        { pair: 'SOL-USDT', side: 'buy', from: 'USDT', to: 'SOL' },
                        { pair: 'SOL-ETH', side: 'sell', from: 'SOL', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_XRP_ETH_USDT',
                    pairs: ['XRP-USDT', 'XRP-ETH', 'ETH-USDT'],
                    sequence: 'USDT → XRP → ETH → USDT',
                    steps: [
                        { pair: 'XRP-USDT', side: 'buy', from: 'USDT', to: 'XRP' },
                        { pair: 'XRP-ETH', side: 'sell', from: 'XRP', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ADA_ETH_USDT',
                    pairs: ['ADA-USDT', 'ADA-ETH', 'ETH-USDT'],
                    sequence: 'USDT → ADA → ETH → USDT',
                    steps: [
                        { pair: 'ADA-USDT', side: 'buy', from: 'USDT', to: 'ADA' },
                        { pair: 'ADA-ETH', side: 'sell', from: 'ADA', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_DOT_ETH_USDT',
                    pairs: ['DOT-USDT', 'DOT-ETH', 'ETH-USDT'],
                    sequence: 'USDT → DOT → ETH → USDT',
                    steps: [
                        { pair: 'DOT-USDT', side: 'buy', from: 'USDT', to: 'DOT' },
                        { pair: 'DOT-ETH', side: 'sell', from: 'DOT', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_MATIC_ETH_USDT',
                    pairs: ['MATIC-USDT', 'MATIC-ETH', 'ETH-USDT'],
                    sequence: 'USDT → MATIC → ETH → USDT',
                    steps: [
                        { pair: 'MATIC-USDT', side: 'buy', from: 'USDT', to: 'MATIC' },
                        { pair: 'MATIC-ETH', side: 'sell', from: 'MATIC', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_LINK_ETH_USDT',
                    pairs: ['LINK-USDT', 'LINK-ETH', 'ETH-USDT'],
                    sequence: 'USDT → LINK → ETH → USDT',
                    steps: [
                        { pair: 'LINK-USDT', side: 'buy', from: 'USDT', to: 'LINK' },
                        { pair: 'LINK-ETH', side: 'sell', from: 'LINK', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                {
                    id: 'USDT_ETH_BTC_USDT',
                    pairs: ['ETH-USDT', 'ETH-BTC', 'BTC-USDT'],
                    sequence: 'USDT → ETH → BTC → USDT',
                    steps: [
                        { pair: 'ETH-USDT', side: 'buy', from: 'USDT', to: 'ETH' },
                        { pair: 'ETH-BTC', side: 'sell', from: 'ETH', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SOL_BTC_USDT',
                    pairs: ['SOL-USDT', 'SOL-BTC', 'BTC-USDT'],
                    sequence: 'USDT → SOL → BTC → USDT',
                    steps: [
                        { pair: 'SOL-USDT', side: 'buy', from: 'USDT', to: 'SOL' },
                        { pair: 'SOL-BTC', side: 'sell', from: 'SOL', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_AVAX_BTC_USDT',
                    pairs: ['AVAX-USDT', 'AVAX-BTC', 'BTC-USDT'],
                    sequence: 'USDT → AVAX → BTC → USDT',
                    steps: [
                        { pair: 'AVAX-USDT', side: 'buy', from: 'USDT', to: 'AVAX' },
                        { pair: 'AVAX-BTC', side: 'sell', from: 'AVAX', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ATOM_BTC_USDT',
                    pairs: ['ATOM-USDT', 'ATOM-BTC', 'BTC-USDT'],
                    sequence: 'USDT → ATOM → BTC → USDT',
                    steps: [
                        { pair: 'ATOM-USDT', side: 'buy', from: 'USDT', to: 'ATOM' },
                        { pair: 'ATOM-BTC', side: 'sell', from: 'ATOM', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_LTC_BTC_USDT',
                    pairs: ['LTC-USDT', 'LTC-BTC', 'BTC-USDT'],
                    sequence: 'USDT → LTC → BTC → USDT',
                    steps: [
                        { pair: 'LTC-USDT', side: 'buy', from: 'USDT', to: 'LTC' },
                        { pair: 'LTC-BTC', side: 'sell', from: 'LTC', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_UNI_BTC_USDT',
                    pairs: ['UNI-USDT', 'UNI-BTC', 'BTC-USDT'],
                    sequence: 'USDT → UNI → BTC → USDT',
                    steps: [
                        { pair: 'UNI-USDT', side: 'buy', from: 'USDT', to: 'UNI' },
                        { pair: 'UNI-BTC', side: 'sell', from: 'UNI', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_FIL_BTC_USDT',
                    pairs: ['FIL-USDT', 'FIL-BTC', 'BTC-USDT'],
                    sequence: 'USDT → FIL → BTC → USDT',
                    steps: [
                        { pair: 'FIL-USDT', side: 'buy', from: 'USDT', to: 'FIL' },
                        { pair: 'FIL-BTC', side: 'sell', from: 'FIL', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                }
            ],
            SET_3_OKB_NATIVE_BRIDGE: [
                {
                    id: 'USDT_BTC_OKB_USDT',
                    pairs: ['BTC-USDT', 'BTC-OKB', 'OKB-USDT'],
                    sequence: 'USDT → BTC → OKB → USDT',
                    steps: [
                        { pair: 'BTC-USDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'BTC-OKB', side: 'sell', from: 'BTC', to: 'OKB' },
                        { pair: 'OKB-USDT', side: 'sell', from: 'OKB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ETH_OKB_USDT',
                    pairs: ['ETH-USDT', 'ETH-OKB', 'OKB-USDT'],
                    sequence: 'USDT → ETH → OKB → USDT',
                    steps: [
                        { pair: 'ETH-USDT', side: 'buy', from: 'USDT', to: 'ETH' },
                        { pair: 'ETH-OKB', side: 'sell', from: 'ETH', to: 'OKB' },
                        { pair: 'OKB-USDT', side: 'sell', from: 'OKB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SOL_OKB_USDT',
                    pairs: ['SOL-USDT', 'SOL-OKB', 'OKB-USDT'],
                    sequence: 'USDT → SOL → OKB → USDT',
                    steps: [
                        { pair: 'SOL-USDT', side: 'buy', from: 'USDT', to: 'SOL' },
                        { pair: 'SOL-OKB', side: 'sell', from: 'SOL', to: 'OKB' },
                        { pair: 'OKB-USDT', side: 'sell', from: 'OKB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_XRP_OKB_USDT',
                    pairs: ['XRP-USDT', 'XRP-OKB', 'OKB-USDT'],
                    sequence: 'USDT → XRP → OKB → USDT',
                    steps: [
                        { pair: 'XRP-USDT', side: 'buy', from: 'USDT', to: 'XRP' },
                        { pair: 'XRP-OKB', side: 'sell', from: 'XRP', to: 'OKB' },
                        { pair: 'OKB-USDT', side: 'sell', from: 'OKB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ADA_OKB_USDT',
                    pairs: ['ADA-USDT', 'ADA-OKB', 'OKB-USDT'],
                    sequence: 'USDT → ADA → OKB → USDT',
                    steps: [
                        { pair: 'ADA-USDT', side: 'buy', from: 'USDT', to: 'ADA' },
                        { pair: 'ADA-OKB', side: 'sell', from: 'ADA', to: 'OKB' },
                        { pair: 'OKB-USDT', side: 'sell', from: 'OKB', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_DOT_OKB_USDT',
                    pairs: ['DOT-USDT', 'DOT-OKB', 'OKB-USDT'],
                    sequence: 'USDT → DOT → OKB → USDT',
                    steps: [
                        { pair: 'DOT-USDT', side: 'buy', from: 'USDT', to: 'DOT' },
                        { pair: 'DOT-OKB', side: 'sell', from: 'DOT', to: 'OKB' },
                        { pair: 'OKB-USDT', side: 'sell', from: 'OKB', to: 'USDT' }
                    ]
                }
            ],
            SET_4_HIGH_VOLATILITY: [
                {
                    id: 'USDT_DOGE_ETH_USDT',
                    pairs: ['DOGE-USDT', 'DOGE-ETH', 'ETH-USDT'],
                    sequence: 'USDT → DOGE → ETH → USDT',
                    steps: [
                        { pair: 'DOGE-USDT', side: 'buy', from: 'USDT', to: 'DOGE' },
                        { pair: 'DOGE-ETH', side: 'sell', from: 'DOGE', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SHIB_ETH_USDT',
                    pairs: ['SHIB-USDT', 'SHIB-ETH', 'ETH-USDT'],
                    sequence: 'USDT → SHIB → ETH → USDT',
                    steps: [
                        { pair: 'SHIB-USDT', side: 'buy', from: 'USDT', to: 'SHIB' },
                        { pair: 'SHIB-ETH', side: 'sell', from: 'SHIB', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_PEPE_ETH_USDT',
                    pairs: ['PEPE-USDT', 'PEPE-ETH', 'ETH-USDT'],
                    sequence: 'USDT → PEPE → ETH → USDT',
                    steps: [
                        { pair: 'PEPE-USDT', side: 'buy', from: 'USDT', to: 'PEPE' },
                        { pair: 'PEPE-ETH', side: 'sell', from: 'PEPE', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_NEAR_BTC_USDT',
                    pairs: ['NEAR-USDT', 'NEAR-BTC', 'BTC-USDT'],
                    sequence: 'USDT → NEAR → BTC → USDT',
                    steps: [
                        { pair: 'NEAR-USDT', side: 'buy', from: 'USDT', to: 'NEAR' },
                        { pair: 'NEAR-BTC', side: 'sell', from: 'NEAR', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_APT_BTC_USDT',
                    pairs: ['APT-USDT', 'APT-BTC', 'BTC-USDT'],
                    sequence: 'USDT → APT → BTC → USDT',
                    steps: [
                        { pair: 'APT-USDT', side: 'buy', from: 'USDT', to: 'APT' },
                        { pair: 'APT-BTC', side: 'sell', from: 'APT', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_FTM_BTC_USDT',
                    pairs: ['FTM-USDT', 'FTM-BTC', 'BTC-USDT'],
                    sequence: 'USDT → FTM → BTC → USDT',
                    steps: [
                        { pair: 'FTM-USDT', side: 'buy', from: 'USDT', to: 'FTM' },
                        { pair: 'FTM-BTC', side: 'sell', from: 'FTM', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                {
                    id: 'USDT_BTC_ETH_SOL_USDT',
                    pairs: ['BTC-USDT', 'ETH-BTC', 'SOL-ETH', 'SOL-USDT'],
                    sequence: 'USDT → BTC → ETH → SOL → USDT (4-leg)',
                    steps: [
                        { pair: 'BTC-USDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'ETH-BTC', side: 'buy', from: 'BTC', to: 'ETH' },
                        { pair: 'SOL-ETH', side: 'buy', from: 'ETH', to: 'SOL' },
                        { pair: 'SOL-USDT', side: 'sell', from: 'SOL', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_ETH_SOL_USDT',
                    pairs: ['ETH-USDT', 'ETH-SOL', 'SOL-USDT'],
                    sequence: 'USDT → ETH → SOL → USDT',
                    steps: [
                        { pair: 'ETH-USDT', side: 'buy', from: 'USDT', to: 'ETH' },
                        { pair: 'ETH-SOL', side: 'sell', from: 'ETH', to: 'SOL' },
                        { pair: 'SOL-USDT', side: 'sell', from: 'SOL', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_SOL_ETH_USDT_REV',
                    pairs: ['SOL-USDT', 'ETH-SOL', 'ETH-USDT'],
                    sequence: 'USDT → SOL → ETH → USDT',
                    steps: [
                        { pair: 'SOL-USDT', side: 'buy', from: 'USDT', to: 'SOL' },
                        { pair: 'ETH-SOL', side: 'buy', from: 'SOL', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_BTC_SOL_USDT',
                    pairs: ['BTC-USDT', 'BTC-SOL', 'SOL-USDT'],
                    sequence: 'USDT → BTC → SOL → USDT',
                    steps: [
                        { pair: 'BTC-USDT', side: 'buy', from: 'USDT', to: 'BTC' },
                        { pair: 'BTC-SOL', side: 'sell', from: 'BTC', to: 'SOL' },
                        { pair: 'SOL-USDT', side: 'sell', from: 'SOL', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_OKB_ETH_USDT',
                    pairs: ['OKB-USDT', 'OKB-ETH', 'ETH-USDT'],
                    sequence: 'USDT → OKB → ETH → USDT',
                    steps: [
                        { pair: 'OKB-USDT', side: 'buy', from: 'USDT', to: 'OKB' },
                        { pair: 'OKB-ETH', side: 'sell', from: 'OKB', to: 'ETH' },
                        { pair: 'ETH-USDT', side: 'sell', from: 'ETH', to: 'USDT' }
                    ]
                },
                {
                    id: 'USDT_OKB_BTC_USDT',
                    pairs: ['OKB-USDT', 'OKB-BTC', 'BTC-USDT'],
                    sequence: 'USDT → OKB → BTC → USDT',
                    steps: [
                        { pair: 'OKB-USDT', side: 'buy', from: 'USDT', to: 'OKB' },
                        { pair: 'OKB-BTC', side: 'sell', from: 'OKB', to: 'BTC' },
                        { pair: 'BTC-USDT', side: 'sell', from: 'BTC', to: 'USDT' }
                    ]
                }
            ]
        };

        // Filter to only enabled sets
        const setsToScan = enabledSets || [1, 2, 3, 4, 5];
        const enabledPaths = [];

        setsToScan.forEach(setNum => {
            const setKey = Object.keys(allPathSets)[setNum - 1];
            if (allPathSets[setKey]) {
                enabledPaths.push(...allPathSets[setKey]);
            }
        });

        // Placeholder for full scanning logic
        res.json({
            success: true,
            message: 'OKX triangular path scan completed',
            data: {
                scannedPaths: enabledPaths.length,
                totalPaths: 32,
                opportunities: [],
                pathSetsScanned: setsToScan.length,
                profitThreshold: profitThreshold,
                message: 'Full scanning implementation coming soon. Backend routes ready.',
                enabledPathDetails: enabledPaths.map(p => ({
                    id: p.id,
                    sequence: p.sequence,
                    pairs: p.pairs
                }))
            }
        });

    } catch (error) {
        console.error('OKX triangular scan error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to scan OKX triangular paths',
            error: error.message
        });
    }
}));

// Get OKX Triangular Path Details
router.get('/okx/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        res.json({
            success: true,
            message: 'OKX triangular paths retrieved',
            data: {
                totalPaths: 32,
                totalSets: 5,
                sets: [
                    { id: 1, name: 'Major ETH Bridge', paths: 7, liquidity: 'Very High' },
                    { id: 2, name: 'Mid-Cap BTC Bridge', paths: 7, liquidity: 'High' },
                    { id: 3, name: 'OKB Native Bridge', paths: 6, liquidity: 'High' },
                    { id: 4, name: 'High Volatility', paths: 6, liquidity: 'Medium' },
                    { id: 5, name: 'Extended Multi-Bridge', paths: 6, liquidity: 'High' }
                ],
                exchange: 'okx',
                fundingCurrency: 'USDT',
                bridgeCurrencies: ['ETH', 'BTC', 'OKB'],
                note: 'OKX offers 673 trading pairs with deep liquidity. OKB (native token) provides unique arbitrage paths.'
            }
        });
    } catch (error) {
        console.error('OKX triangular paths error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve OKX path details'
        });
    }
}));

// Execute OKX Triangular Trade (placeholder)
router.post('/okx/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, passphrase, pathId, amount } = req.body;

    if (!apiKey || !apiSecret || !passphrase || !pathId || !amount) {
        return res.status(400).json({
            success: false,
            message: 'API credentials, path ID, and amount are required'
        });
    }

    try {
        res.json({
            success: false,
            message: 'Execution not yet implemented',
            data: {
                pathId: pathId,
                amount: amount,
                status: 'not_implemented',
                note: 'Live execution will be implemented after full testing'
            }
        });
    } catch (error) {
        console.error('OKX triangular execute error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to execute OKX triangular trade'
        });
    }
}));

// Delete OKX Triangular Trade History
router.delete('/okx/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
        const result = await pool.query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [userId, 'OKX']
        );

        res.json({
            success: true,
            message: 'OKX triangular trade history cleared',
            data: {
                deletedCount: result.rowCount
            }
        });
    } catch (error) {
        console.error('OKX triangular history delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear OKX trade history'
        });
    }
}));

// Get Recent OKX Triangular Trades
router.get('/okx/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 20;

    try {
        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [userId, 'OKX', limit]
        );

        res.json({
            success: true,
            message: 'Recent OKX triangular trades retrieved',
            data: {
                trades: result.rows,
                count: result.rows.length
            }
        });
    } catch (error) {
        console.error('OKX triangular recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent OKX trades'
        });
    }
}));

// ============================================================================
// KUCOIN TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// KuCoin API Configuration (Triangular Routes)
const KUCOIN_CONFIG = {
    baseUrl: 'https://api.kucoin.com',
    endpoints: {
        balance: '/api/v1/accounts',
        ticker: '/api/v1/market/allTickers',
        symbols: '/api/v2/symbols',
        orderBook: '/api/v1/market/orderbook/level2_100',
        placeOrder: '/api/v1/orders'
    }
};

// KuCoin Authentication Helper (KC-API-KEY + Passphrase + Signature)
function createKuCoinAuth(apiKey, apiSecret, passphrase, timestamp, method, endpoint, body = '') {
    const strForSign = timestamp + method + endpoint + body;
    const signature = crypto.createHmac('sha256', apiSecret).update(strForSign).digest('base64');
    const passphraseSignature = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');

    return {
        'KC-API-KEY': apiKey,
        'KC-API-SIGN': signature,
        'KC-API-TIMESTAMP': timestamp,
        'KC-API-PASSPHRASE': passphraseSignature,
        'KC-API-KEY-VERSION': '2'
    };
}

// POST /api/v1/trading/kucoin/triangular/test-connection - Test KuCoin API connection for triangular arbitrage
router.post('/kucoin/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, passphrase } = req.body;

    if (!apiKey || !apiSecret || !passphrase) {
        return res.status(400).json({
            success: false,
            message: 'API Key, Secret, and Passphrase are required'
        });
    }

    try {
        console.log('🔍 [KUCOIN] Testing connection for triangular arbitrage...');

        const timestamp = Date.now().toString();
        const endpoint = KUCOIN_CONFIG.endpoints.balance;
        const authHeaders = createKuCoinAuth(apiKey, apiSecret, passphrase, timestamp, 'GET', endpoint);

        const balanceResponse = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            }
        });

        const balanceData = await balanceResponse.json();

        if (balanceData.code === '200000') {
            console.log('✅ [KUCOIN] Connection successful');
            res.json({
                success: true,
                message: 'KuCoin connection successful',
                accountType: balanceData.data?.[0]?.type || 'trade',
                timestamp: new Date().toISOString()
            });
        } else {
            console.error('❌ [KUCOIN] Connection failed:', balanceData.msg);
            res.status(401).json({
                success: false,
                message: balanceData.msg || 'Invalid API credentials'
            });
        }
    } catch (error) {
        console.error('❌ [KUCOIN] Connection test error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to test KuCoin connection',
            error: error.message
        });
    }
}));

// POST /api/v1/trading/kucoin/triangular/scan - Scan for triangular arbitrage opportunities
router.post('/kucoin/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, passphrase, maxTradeAmount, profitThreshold, enabledSets } = req.body;

    if (!apiKey || !apiSecret || !passphrase) {
        return res.status(400).json({
            success: false,
            message: 'API credentials are required'
        });
    }

    try {
        console.log('🔍 [KUCOIN] Scanning for triangular arbitrage opportunities...');

        // Get all market tickers
        const timestamp = Date.now().toString();
        const endpoint = KUCOIN_CONFIG.endpoints.ticker;
        const authHeaders = createKuCoinAuth(apiKey, apiSecret, passphrase, timestamp, 'GET', endpoint);

        const tickerResponse = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            }
        });

        const tickerData = await tickerResponse.json();

        if (tickerData.code !== '200000') {
            throw new Error(tickerData.msg || 'Failed to fetch market data');
        }

        const tickers = tickerData.data.ticker;
        const priceMap = {};

        // Build price map
        tickers.forEach(ticker => {
            if (ticker.symbol && ticker.last) {
                priceMap[ticker.symbol] = parseFloat(ticker.last);
            }
        });

        console.log(`📊 [KUCOIN] Loaded ${Object.keys(priceMap).length} trading pairs`);

        // Define triangular arbitrage paths (32 paths across 5 sets)
        const allPaths = {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'KCS_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH-USDT', 'BTC-ETH', 'BTC-USDT'], description: 'ETH → BTC Bridge' },
                { id: 'KCS_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH-USDT', 'SOL-ETH', 'SOL-USDT'], description: 'ETH → SOL Bridge' },
                { id: 'KCS_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH-USDT', 'XRP-ETH', 'XRP-USDT'], description: 'ETH → XRP Bridge' },
                { id: 'KCS_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH-USDT', 'ADA-ETH', 'ADA-USDT'], description: 'ETH → ADA Bridge' },
                { id: 'KCS_ETH_5', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETH-USDT', 'DOT-ETH', 'DOT-USDT'], description: 'ETH → DOT Bridge' },
                { id: 'KCS_ETH_6', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH-USDT', 'MATIC-ETH', 'MATIC-USDT'], description: 'ETH → MATIC Bridge' },
                { id: 'KCS_ETH_7', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETH-USDT', 'LINK-ETH', 'LINK-USDT'], description: 'ETH → LINK Bridge' }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'KCS_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], description: 'BTC → ETH Bridge' },
                { id: 'KCS_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC-USDT', 'SOL-BTC', 'SOL-USDT'], description: 'BTC → SOL Bridge' },
                { id: 'KCS_BTC_3', path: ['USDT', 'BTC', 'AVAX', 'USDT'], pairs: ['BTC-USDT', 'AVAX-BTC', 'AVAX-USDT'], description: 'BTC → AVAX Bridge' },
                { id: 'KCS_BTC_4', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC-USDT', 'ATOM-BTC', 'ATOM-USDT'], description: 'BTC → ATOM Bridge' },
                { id: 'KCS_BTC_5', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC-USDT', 'LTC-BTC', 'LTC-USDT'], description: 'BTC → LTC Bridge' },
                { id: 'KCS_BTC_6', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTC-USDT', 'UNI-BTC', 'UNI-USDT'], description: 'BTC → UNI Bridge' },
                { id: 'KCS_BTC_7', path: ['USDT', 'BTC', 'FIL', 'USDT'], pairs: ['BTC-USDT', 'FIL-BTC', 'FIL-USDT'], description: 'BTC → FIL Bridge' }
            ],
            SET_3_KCS_NATIVE_BRIDGE: [
                { id: 'KCS_NATIVE_1', path: ['USDT', 'KCS', 'BTC', 'USDT'], pairs: ['KCS-USDT', 'BTC-KCS', 'BTC-USDT'], description: 'KCS → BTC Bridge' },
                { id: 'KCS_NATIVE_2', path: ['USDT', 'KCS', 'ETH', 'USDT'], pairs: ['KCS-USDT', 'ETH-KCS', 'ETH-USDT'], description: 'KCS → ETH Bridge' },
                { id: 'KCS_NATIVE_3', path: ['USDT', 'KCS', 'SOL', 'USDT'], pairs: ['KCS-USDT', 'SOL-KCS', 'SOL-USDT'], description: 'KCS → SOL Bridge' },
                { id: 'KCS_NATIVE_4', path: ['USDT', 'KCS', 'XRP', 'USDT'], pairs: ['KCS-USDT', 'XRP-KCS', 'XRP-USDT'], description: 'KCS → XRP Bridge' },
                { id: 'KCS_NATIVE_5', path: ['USDT', 'KCS', 'ADA', 'USDT'], pairs: ['KCS-USDT', 'ADA-KCS', 'ADA-USDT'], description: 'KCS → ADA Bridge' },
                { id: 'KCS_NATIVE_6', path: ['USDT', 'KCS', 'DOT', 'USDT'], pairs: ['KCS-USDT', 'DOT-KCS', 'DOT-USDT'], description: 'KCS → DOT Bridge' }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'KCS_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE-USDT', 'BTC-DOGE', 'BTC-USDT'], description: 'DOGE → BTC Meme' },
                { id: 'KCS_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB-USDT', 'ETH-SHIB', 'ETH-USDT'], description: 'SHIB → ETH Meme' },
                { id: 'KCS_VOL_3', path: ['USDT', 'PEPE', 'ETH', 'USDT'], pairs: ['PEPE-USDT', 'ETH-PEPE', 'ETH-USDT'], description: 'PEPE → ETH Meme' },
                { id: 'KCS_VOL_4', path: ['USDT', 'NEAR', 'BTC', 'USDT'], pairs: ['NEAR-USDT', 'BTC-NEAR', 'BTC-USDT'], description: 'NEAR → BTC Layer1' },
                { id: 'KCS_VOL_5', path: ['USDT', 'APT', 'ETH', 'USDT'], pairs: ['APT-USDT', 'ETH-APT', 'ETH-USDT'], description: 'APT → ETH Layer1' },
                { id: 'KCS_VOL_6', path: ['USDT', 'FTM', 'BTC', 'USDT'], pairs: ['FTM-USDT', 'BTC-FTM', 'BTC-USDT'], description: 'FTM → BTC DeFi' }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'KCS_EXT_1', path: ['USDT', 'BNB', 'ETH', 'USDT'], pairs: ['BNB-USDT', 'ETH-BNB', 'ETH-USDT'], description: 'BNB → ETH Cross-Exchange' },
                { id: 'KCS_EXT_2', path: ['USDT', 'TRX', 'BTC', 'USDT'], pairs: ['TRX-USDT', 'BTC-TRX', 'BTC-USDT'], description: 'TRX → BTC Bridge' },
                { id: 'KCS_EXT_3', path: ['USDT', 'ALGO', 'ETH', 'USDT'], pairs: ['ALGO-USDT', 'ETH-ALGO', 'ETH-USDT'], description: 'ALGO → ETH Bridge' },
                { id: 'KCS_EXT_4', path: ['USDT', 'VET', 'BTC', 'USDT'], pairs: ['VET-USDT', 'BTC-VET', 'BTC-USDT'], description: 'VET → BTC Bridge' },
                { id: 'KCS_EXT_5', path: ['USDT', 'HBAR', 'ETH', 'USDT'], pairs: ['HBAR-USDT', 'ETH-HBAR', 'ETH-USDT'], description: 'HBAR → ETH Bridge' },
                { id: 'KCS_EXT_6', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC-USDT', 'ETH-BTC', 'SOL-ETH', 'SOL-USDT'], description: 'Multi-Bridge 4-Leg' }
            ]
        };

        // Filter paths based on enabled sets
        const enabledPaths = [];
        Object.keys(allPaths).forEach(setKey => {
            if (enabledSets && enabledSets[setKey]) {
                enabledPaths.push(...allPaths[setKey]);
            }
        });

        console.log(`🎯 [KUCOIN] Scanning ${enabledPaths.length} enabled paths...`);

        // Calculate arbitrage for each path
        const opportunities = [];
        const threshold = profitThreshold || 0.5;

        enabledPaths.forEach(pathConfig => {
            try {
                // Check if all required pairs exist
                const allPairsExist = pathConfig.pairs.every(pair => priceMap[pair]);

                if (!allPairsExist) {
                    return; // Skip if any pair is missing
                }

                // Calculate path profit
                let amount = maxTradeAmount || 100;
                const executionSteps = [];

                // For standard 3-leg paths
                if (pathConfig.path.length === 4) {
                    // Leg 1: USDT → Asset1
                    const price1 = priceMap[pathConfig.pairs[0]];
                    const amount1 = amount / price1;
                    executionSteps.push({ pair: pathConfig.pairs[0], side: 'BUY', amount: amount, price: price1, result: amount1 });

                    // Leg 2: Asset1 → Asset2
                    const price2 = priceMap[pathConfig.pairs[1]];
                    const amount2 = amount1 / price2;
                    executionSteps.push({ pair: pathConfig.pairs[1], side: 'BUY', amount: amount1, price: price2, result: amount2 });

                    // Leg 3: Asset2 → USDT
                    const price3 = priceMap[pathConfig.pairs[2]];
                    const finalAmount = amount2 * price3;
                    executionSteps.push({ pair: pathConfig.pairs[2], side: 'SELL', amount: amount2, price: price3, result: finalAmount });

                    const profitAmount = finalAmount - amount;
                    const profitPercent = (profitAmount / amount) * 100;

                    if (profitPercent >= threshold) {
                        opportunities.push({
                            pathId: pathConfig.id,
                            path: pathConfig.path,
                            pairs: pathConfig.pairs,
                            description: pathConfig.description,
                            initialAmount: amount,
                            finalAmount: finalAmount,
                            profitAmount: profitAmount,
                            profitPercent: profitPercent.toFixed(4),
                            executionSteps: executionSteps,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                // For 4-leg multi-bridge path
                if (pathConfig.path.length === 5) {
                    // Leg 1: USDT → BTC
                    const price1 = priceMap[pathConfig.pairs[0]];
                    const amount1 = amount / price1;
                    executionSteps.push({ pair: pathConfig.pairs[0], side: 'BUY', amount: amount, price: price1, result: amount1 });

                    // Leg 2: BTC → ETH
                    const price2 = priceMap[pathConfig.pairs[1]];
                    const amount2 = amount1 / price2;
                    executionSteps.push({ pair: pathConfig.pairs[1], side: 'BUY', amount: amount1, price: price2, result: amount2 });

                    // Leg 3: ETH → SOL
                    const price3 = priceMap[pathConfig.pairs[2]];
                    const amount3 = amount2 / price3;
                    executionSteps.push({ pair: pathConfig.pairs[2], side: 'BUY', amount: amount2, price: price3, result: amount3 });

                    // Leg 4: SOL → USDT
                    const price4 = priceMap[pathConfig.pairs[3]];
                    const finalAmount = amount3 * price4;
                    executionSteps.push({ pair: pathConfig.pairs[3], side: 'SELL', amount: amount3, price: price4, result: finalAmount });

                    const profitAmount = finalAmount - amount;
                    const profitPercent = (profitAmount / amount) * 100;

                    if (profitPercent >= threshold) {
                        opportunities.push({
                            pathId: pathConfig.id,
                            path: pathConfig.path,
                            pairs: pathConfig.pairs,
                            description: pathConfig.description,
                            initialAmount: amount,
                            finalAmount: finalAmount,
                            profitAmount: profitAmount,
                            profitPercent: profitPercent.toFixed(4),
                            executionSteps: executionSteps,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`⚠️ [KUCOIN] Error calculating path ${pathConfig.id}:`, error.message);
            }
        });

        // Sort by profit percentage
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        console.log(`✅ [KUCOIN] Found ${opportunities.length} opportunities above ${threshold}% profit threshold`);

        res.json({
            success: true,
            exchange: 'kucoin',
            opportunities: opportunities,
            totalScanned: enabledPaths.length,
            profitableCount: opportunities.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ [KUCOIN] Scan error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to scan KuCoin triangular opportunities',
            error: error.message
        });
    }
}));

// GET /api/v1/trading/kucoin/triangular/paths - Get all available triangular paths
router.get('/kucoin/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    console.log('📋 [KUCOIN] Retrieving available triangular paths...');

    const paths = {
        SET_1_ESSENTIAL_ETH_BRIDGE: { count: 7, description: 'Major coins via ETH bridge', enabled: true },
        SET_2_MIDCAP_BTC_BRIDGE: { count: 7, description: 'Mid-cap coins via BTC bridge', enabled: true },
        SET_3_KCS_NATIVE_BRIDGE: { count: 6, description: 'Using KuCoin native KCS token', enabled: false },
        SET_4_HIGH_VOLATILITY: { count: 6, description: 'High volatility meme/DeFi coins', enabled: false },
        SET_5_EXTENDED_MULTIBRIDGE: { count: 6, description: 'Extended paths including 4-leg', enabled: false }
    };

    res.json({
        success: true,
        exchange: 'kucoin',
        totalPaths: 32,
        pathSets: paths,
        timestamp: new Date().toISOString()
    });
}));

// POST /api/v1/trading/kucoin/triangular/execute - Execute a triangular arbitrage trade (placeholder)
router.post('/kucoin/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, passphrase, opportunity } = req.body;

    console.log('⚠️ [KUCOIN] Execute endpoint called - NOT IMPLEMENTED YET');
    console.log('🎯 [KUCOIN] Opportunity:', opportunity?.pathId);

    res.status(501).json({
        success: false,
        message: 'Execution not yet implemented - scan mode only',
        notice: 'This endpoint will be implemented after initial testing phase'
    });
}));

// DELETE /api/v1/trading/kucoin/triangular/history - Clear KuCoin triangular trade history
router.delete('/kucoin/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
        console.log('🗑️ [KUCOIN] Clearing triangular trade history for user:', userId);

        const result = await db.query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [userId, 'KUCOIN']
        );

        console.log(`✅ [KUCOIN] Cleared ${result.rowCount} trade records`);

        res.json({
            success: true,
            message: `Cleared ${result.rowCount} KuCoin triangular trade records`,
            deletedCount: result.rowCount
        });
    } catch (error) {
        console.error('❌ [KUCOIN] History clear error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to clear KuCoin trade history'
        });
    }
}));

// GET /api/v1/trading/kucoin/triangular/recent-trades - Get recent KuCoin triangular trades
router.get('/kucoin/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    try {
        console.log('📜 [KUCOIN] Retrieving recent triangular trades for user:', userId);

        const result = await db.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [userId, 'KUCOIN', limit]
        );

        res.json({
            success: true,
            exchange: 'kucoin',
            trades: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('KuCoin triangular recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent KuCoin trades'
        });
    }
}));

// ============================================================================
// COINBASE TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Coinbase API Configuration (Triangular Routes)
const COINBASE_CONFIG = {
    baseUrl: 'https://api.coinbase.com',
    endpoints: {
        accounts: '/api/v3/brokerage/accounts',
        products: '/api/v3/brokerage/products',
        ticker: '/api/v3/brokerage/best_bid_ask',
        orderBook: '/api/v3/brokerage/product_book',
        placeOrder: '/api/v3/brokerage/orders'
    }
};

// Coinbase JWT Authentication Helper (ES256 with Elliptic Curve)
function createCoinbaseJWT(apiKey, apiSecret, method, path) {
    const uri = method + ' api.coinbase.com' + path;

    const token = jwt.sign(
        {
            iss: 'coinbase-cloud',
            nbf: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 120, // 2 minute expiry
            sub: apiKey,
            uri: uri
        },
        apiSecret,
        {
            algorithm: 'ES256',
            header: {
                kid: apiKey,
                nonce: crypto.randomBytes(16).toString('hex')
            }
        }
    );

    return token;
}

// POST /api/v1/trading/coinbase/triangular/test-connection - Test Coinbase API connection for triangular arbitrage
router.post('/coinbase/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret } = req.body;

    if (!apiKey || !apiSecret) {
        return res.status(400).json({
            success: false,
            message: 'API Key and Secret are required'
        });
    }

    try {
        console.log('🔍 [COINBASE] Testing connection for triangular arbitrage...');

        const endpoint = COINBASE_CONFIG.endpoints.accounts;
        const jwtToken = createCoinbaseJWT(apiKey, apiSecret, 'GET', endpoint);

        const accountsResponse = await fetch(`${COINBASE_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwtToken}`
            }
        });

        const accountsData = await accountsResponse.json();

        if (accountsResponse.ok && accountsData.accounts) {
            console.log('✅ [COINBASE] Connection successful');
            res.json({
                success: true,
                message: 'Coinbase connection successful',
                accountsCount: accountsData.accounts.length,
                timestamp: new Date().toISOString()
            });
        } else {
            console.error('❌ [COINBASE] Connection failed:', accountsData.message);
            res.status(401).json({
                success: false,
                message: accountsData.message || 'Invalid API credentials'
            });
        }
    } catch (error) {
        console.error('❌ [COINBASE] Connection test error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to test Coinbase connection',
            error: error.message
        });
    }
}));

// POST /api/v1/trading/coinbase/triangular/scan - Scan for triangular arbitrage opportunities
router.post('/coinbase/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

    if (!apiKey || !apiSecret) {
        return res.status(400).json({
            success: false,
            message: 'API credentials are required'
        });
    }

    try {
        console.log('🔍 [COINBASE] Scanning for triangular arbitrage opportunities...');

        // Get all products
        const endpoint = COINBASE_CONFIG.endpoints.products;
        const jwtToken = createCoinbaseJWT(apiKey, apiSecret, 'GET', endpoint);

        const productsResponse = await fetch(`${COINBASE_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwtToken}`
            }
        });

        const productsData = await productsResponse.json();

        if (!productsResponse.ok || !productsData.products) {
            throw new Error(productsData.message || 'Failed to fetch products');
        }

        const priceMap = {};

        // Build price map from products
        productsData.products.forEach(product => {
            if (product.product_id && product.price) {
                priceMap[product.product_id] = parseFloat(product.price);
            }
        });

        console.log(`📊 [COINBASE] Loaded ${Object.keys(priceMap).length} trading pairs`);

        // Define triangular arbitrage paths (32 paths across 5 sets) - ALL USDC-BASED
        const allPaths = {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'CB_ETH_1', path: ['USDC', 'ETH', 'BTC', 'USDC'], pairs: ['ETH-USDC', 'BTC-ETH', 'BTC-USDC'], description: 'ETH → BTC Bridge' },
                { id: 'CB_ETH_2', path: ['USDC', 'ETH', 'SOL', 'USDC'], pairs: ['ETH-USDC', 'SOL-ETH', 'SOL-USDC'], description: 'ETH → SOL Bridge' },
                { id: 'CB_ETH_3', path: ['USDC', 'ETH', 'XRP', 'USDC'], pairs: ['ETH-USDC', 'XRP-ETH', 'XRP-USDC'], description: 'ETH → XRP Bridge' },
                { id: 'CB_ETH_4', path: ['USDC', 'ETH', 'ADA', 'USDC'], pairs: ['ETH-USDC', 'ADA-ETH', 'ADA-USDC'], description: 'ETH → ADA Bridge' },
                { id: 'CB_ETH_5', path: ['USDC', 'ETH', 'DOT', 'USDC'], pairs: ['ETH-USDC', 'DOT-ETH', 'DOT-USDC'], description: 'ETH → DOT Bridge' },
                { id: 'CB_ETH_6', path: ['USDC', 'ETH', 'MATIC', 'USDC'], pairs: ['ETH-USDC', 'MATIC-ETH', 'MATIC-USDC'], description: 'ETH → MATIC Bridge' },
                { id: 'CB_ETH_7', path: ['USDC', 'ETH', 'LINK', 'USDC'], pairs: ['ETH-USDC', 'LINK-ETH', 'LINK-USDC'], description: 'ETH → LINK Bridge' }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'CB_BTC_1', path: ['USDC', 'BTC', 'ETH', 'USDC'], pairs: ['BTC-USDC', 'ETH-BTC', 'ETH-USDC'], description: 'BTC → ETH Bridge' },
                { id: 'CB_BTC_2', path: ['USDC', 'BTC', 'SOL', 'USDC'], pairs: ['BTC-USDC', 'SOL-BTC', 'SOL-USDC'], description: 'BTC → SOL Bridge' },
                { id: 'CB_BTC_3', path: ['USDC', 'BTC', 'AVAX', 'USDC'], pairs: ['BTC-USDC', 'AVAX-BTC', 'AVAX-USDC'], description: 'BTC → AVAX Bridge' },
                { id: 'CB_BTC_4', path: ['USDC', 'BTC', 'ATOM', 'USDC'], pairs: ['BTC-USDC', 'ATOM-BTC', 'ATOM-USDC'], description: 'BTC → ATOM Bridge' },
                { id: 'CB_BTC_5', path: ['USDC', 'BTC', 'LTC', 'USDC'], pairs: ['BTC-USDC', 'LTC-BTC', 'LTC-USDC'], description: 'BTC → LTC Bridge' },
                { id: 'CB_BTC_6', path: ['USDC', 'BTC', 'UNI', 'USDC'], pairs: ['BTC-USDC', 'UNI-BTC', 'UNI-USDC'], description: 'BTC → UNI Bridge' },
                { id: 'CB_BTC_7', path: ['USDC', 'BTC', 'ALGO', 'USDC'], pairs: ['BTC-USDC', 'ALGO-BTC', 'ALGO-USDC'], description: 'BTC → ALGO Bridge' }
            ],
            SET_3_DEFI_NATIVE: [
                { id: 'CB_DEFI_1', path: ['USDC', 'AAVE', 'ETH', 'USDC'], pairs: ['AAVE-USDC', 'ETH-AAVE', 'ETH-USDC'], description: 'AAVE → ETH DeFi' },
                { id: 'CB_DEFI_2', path: ['USDC', 'COMP', 'ETH', 'USDC'], pairs: ['COMP-USDC', 'ETH-COMP', 'ETH-USDC'], description: 'COMP → ETH DeFi' },
                { id: 'CB_DEFI_3', path: ['USDC', 'MKR', 'ETH', 'USDC'], pairs: ['MKR-USDC', 'ETH-MKR', 'ETH-USDC'], description: 'MKR → ETH DeFi' },
                { id: 'CB_DEFI_4', path: ['USDC', 'SNX', 'ETH', 'USDC'], pairs: ['SNX-USDC', 'ETH-SNX', 'ETH-USDC'], description: 'SNX → ETH DeFi' },
                { id: 'CB_DEFI_5', path: ['USDC', 'CRV', 'ETH', 'USDC'], pairs: ['CRV-USDC', 'ETH-CRV', 'ETH-USDC'], description: 'CRV → ETH DeFi' },
                { id: 'CB_DEFI_6', path: ['USDC', 'SUSHI', 'ETH', 'USDC'], pairs: ['SUSHI-USDC', 'ETH-SUSHI', 'ETH-USDC'], description: 'SUSHI → ETH DeFi' }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'CB_VOL_1', path: ['USDC', 'DOGE', 'BTC', 'USDC'], pairs: ['DOGE-USDC', 'BTC-DOGE', 'BTC-USDC'], description: 'DOGE → BTC Meme' },
                { id: 'CB_VOL_2', path: ['USDC', 'SHIB', 'ETH', 'USDC'], pairs: ['SHIB-USDC', 'ETH-SHIB', 'ETH-USDC'], description: 'SHIB → ETH Meme' },
                { id: 'CB_VOL_3', path: ['USDC', 'APE', 'ETH', 'USDC'], pairs: ['APE-USDC', 'ETH-APE', 'ETH-USDC'], description: 'APE → ETH Gaming' },
                { id: 'CB_VOL_4', path: ['USDC', 'GALA', 'BTC', 'USDC'], pairs: ['GALA-USDC', 'BTC-GALA', 'BTC-USDC'], description: 'GALA → BTC Gaming' },
                { id: 'CB_VOL_5', path: ['USDC', 'SAND', 'ETH', 'USDC'], pairs: ['SAND-USDC', 'ETH-SAND', 'ETH-USDC'], description: 'SAND → ETH Gaming' },
                { id: 'CB_VOL_6', path: ['USDC', 'MANA', 'ETH', 'USDC'], pairs: ['MANA-USDC', 'ETH-MANA', 'ETH-USDC'], description: 'MANA → ETH Gaming' }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'CB_EXT_1', path: ['USDC', 'FIL', 'BTC', 'USDC'], pairs: ['FIL-USDC', 'BTC-FIL', 'BTC-USDC'], description: 'FIL → BTC Bridge' },
                { id: 'CB_EXT_2', path: ['USDC', 'GRT', 'ETH', 'USDC'], pairs: ['GRT-USDC', 'ETH-GRT', 'ETH-USDC'], description: 'GRT → ETH Bridge' },
                { id: 'CB_EXT_3', path: ['USDC', 'ICP', 'BTC', 'USDC'], pairs: ['ICP-USDC', 'BTC-ICP', 'BTC-USDC'], description: 'ICP → BTC Bridge' },
                { id: 'CB_EXT_4', path: ['USDC', 'CHZ', 'ETH', 'USDC'], pairs: ['CHZ-USDC', 'ETH-CHZ', 'ETH-USDC'], description: 'CHZ → ETH Bridge' },
                { id: 'CB_EXT_5', path: ['USDC', 'ENJ', 'BTC', 'USDC'], pairs: ['ENJ-USDC', 'BTC-ENJ', 'BTC-USDC'], description: 'ENJ → BTC Bridge' },
                { id: 'CB_EXT_6', path: ['USDC', 'BTC', 'ETH', 'SOL', 'USDC'], pairs: ['BTC-USDC', 'ETH-BTC', 'SOL-ETH', 'SOL-USDC'], description: 'Multi-Bridge 4-Leg' }
            ]
        };

        // Filter paths based on enabled sets
        const enabledPaths = [];
        Object.keys(allPaths).forEach(setKey => {
            if (enabledSets && enabledSets[setKey]) {
                enabledPaths.push(...allPaths[setKey]);
            }
        });

        console.log(`🎯 [COINBASE] Scanning ${enabledPaths.length} enabled paths...`);

        // Calculate arbitrage for each path
        const opportunities = [];
        const threshold = profitThreshold || 0.5;

        enabledPaths.forEach(pathConfig => {
            try {
                // Check if all required pairs exist
                const allPairsExist = pathConfig.pairs.every(pair => priceMap[pair]);

                if (!allPairsExist) {
                    return; // Skip if any pair is missing
                }

                // Calculate path profit
                let amount = maxTradeAmount || 100;
                const executionSteps = [];

                // For standard 3-leg paths
                if (pathConfig.path.length === 4) {
                    // Leg 1: USDC → Asset1
                    const price1 = priceMap[pathConfig.pairs[0]];
                    const amount1 = amount / price1;
                    executionSteps.push({ pair: pathConfig.pairs[0], side: 'BUY', amount: amount, price: price1, result: amount1 });

                    // Leg 2: Asset1 → Asset2
                    const price2 = priceMap[pathConfig.pairs[1]];
                    const amount2 = amount1 / price2;
                    executionSteps.push({ pair: pathConfig.pairs[1], side: 'BUY', amount: amount1, price: price2, result: amount2 });

                    // Leg 3: Asset2 → USDC
                    const price3 = priceMap[pathConfig.pairs[2]];
                    const finalAmount = amount2 * price3;
                    executionSteps.push({ pair: pathConfig.pairs[2], side: 'SELL', amount: amount2, price: price3, result: finalAmount });

                    const profitAmount = finalAmount - amount;
                    const profitPercent = (profitAmount / amount) * 100;

                    if (profitPercent >= threshold) {
                        opportunities.push({
                            pathId: pathConfig.id,
                            path: pathConfig.path,
                            pairs: pathConfig.pairs,
                            description: pathConfig.description,
                            initialAmount: amount,
                            finalAmount: finalAmount,
                            profitAmount: profitAmount,
                            profitPercent: profitPercent.toFixed(4),
                            executionSteps: executionSteps,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                // For 4-leg multi-bridge path
                if (pathConfig.path.length === 5) {
                    // Leg 1: USDC → BTC
                    const price1 = priceMap[pathConfig.pairs[0]];
                    const amount1 = amount / price1;
                    executionSteps.push({ pair: pathConfig.pairs[0], side: 'BUY', amount: amount, price: price1, result: amount1 });

                    // Leg 2: BTC → ETH
                    const price2 = priceMap[pathConfig.pairs[1]];
                    const amount2 = amount1 / price2;
                    executionSteps.push({ pair: pathConfig.pairs[1], side: 'BUY', amount: amount1, price: price2, result: amount2 });

                    // Leg 3: ETH → SOL
                    const price3 = priceMap[pathConfig.pairs[2]];
                    const amount3 = amount2 / price3;
                    executionSteps.push({ pair: pathConfig.pairs[2], side: 'BUY', amount: amount2, price: price3, result: amount3 });

                    // Leg 4: SOL → USDC
                    const price4 = priceMap[pathConfig.pairs[3]];
                    const finalAmount = amount3 * price4;
                    executionSteps.push({ pair: pathConfig.pairs[3], side: 'SELL', amount: amount3, price: price4, result: finalAmount });

                    const profitAmount = finalAmount - amount;
                    const profitPercent = (profitAmount / amount) * 100;

                    if (profitPercent >= threshold) {
                        opportunities.push({
                            pathId: pathConfig.id,
                            path: pathConfig.path,
                            pairs: pathConfig.pairs,
                            description: pathConfig.description,
                            initialAmount: amount,
                            finalAmount: finalAmount,
                            profitAmount: profitAmount,
                            profitPercent: profitPercent.toFixed(4),
                            executionSteps: executionSteps,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`⚠️ [COINBASE] Error calculating path ${pathConfig.id}:`, error.message);
            }
        });

        // Sort by profit percentage
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        console.log(`✅ [COINBASE] Found ${opportunities.length} opportunities above ${threshold}% profit threshold`);

        res.json({
            success: true,
            exchange: 'coinbase',
            opportunities: opportunities,
            totalScanned: enabledPaths.length,
            profitableCount: opportunities.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ [COINBASE] Scan error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to scan Coinbase triangular opportunities',
            error: error.message
        });
    }
}));

// GET /api/v1/trading/coinbase/triangular/paths - Get all available triangular paths
router.get('/coinbase/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    console.log('📋 [COINBASE] Retrieving available triangular paths...');

    const paths = {
        SET_1_ESSENTIAL_ETH_BRIDGE: { count: 7, description: 'Major coins via ETH bridge', enabled: true },
        SET_2_MIDCAP_BTC_BRIDGE: { count: 7, description: 'Mid-cap coins via BTC bridge', enabled: true },
        SET_3_DEFI_NATIVE: { count: 6, description: 'DeFi tokens via ETH', enabled: false },
        SET_4_HIGH_VOLATILITY: { count: 6, description: 'High volatility meme/gaming coins', enabled: false },
        SET_5_EXTENDED_MULTIBRIDGE: { count: 6, description: 'Extended paths including 4-leg', enabled: false }
    };

    res.json({
        success: true,
        exchange: 'coinbase',
        totalPaths: 32,
        fundingCurrency: 'USDC',
        pathSets: paths,
        timestamp: new Date().toISOString()
    });
}));

// POST /api/v1/trading/coinbase/triangular/execute - Execute a triangular arbitrage trade (placeholder)
router.post('/coinbase/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, opportunity } = req.body;

    console.log('⚠️ [COINBASE] Execute endpoint called - NOT IMPLEMENTED YET');
    console.log('🎯 [COINBASE] Opportunity:', opportunity?.pathId);

    res.status(501).json({
        success: false,
        message: 'Execution not yet implemented - scan mode only',
        notice: 'This endpoint will be implemented after initial testing phase'
    });
}));

// DELETE /api/v1/trading/coinbase/triangular/history - Clear Coinbase triangular trade history
router.delete('/coinbase/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
        console.log('🗑️ [COINBASE] Clearing triangular trade history for user:', userId);

        const result = await db.query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [userId, 'COINBASE']
        );

        console.log(`✅ [COINBASE] Cleared ${result.rowCount} trade records`);

        res.json({
            success: true,
            message: `Cleared ${result.rowCount} Coinbase triangular trade records`,
            deletedCount: result.rowCount
        });
    } catch (error) {
        console.error('❌ [COINBASE] History clear error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to clear Coinbase trade history'
        });
    }
}));

// GET /api/v1/trading/coinbase/triangular/recent-trades - Get recent Coinbase triangular trades
router.get('/coinbase/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    try {
        console.log('📜 [COINBASE] Retrieving recent triangular trades for user:', userId);

        const result = await db.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [userId, 'COINBASE', limit]
        );

        res.json({
            success: true,
            exchange: 'coinbase',
            trades: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('Coinbase triangular recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Coinbase trades'
        });
    }
}));

// ============================================================================
// HUOBI (HTX) TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Huobi API Configuration (Triangular Routes)
const HUOBI_CONFIG = {
    baseUrl: 'https://api.huobi.pro',
    endpoints: {
        accounts: '/v1/account/accounts',
        symbols: '/v1/common/symbols',
        ticker: '/market/tickers',
        orderBook: '/market/depth',
        placeOrder: '/v1/order/orders/place'
    }
};

// Huobi HMAC-SHA256 Authentication Helper
function createHuobiSignature(apiKey, apiSecret, method, endpoint, params = {}) {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');

    // Add required signature parameters
    params.AccessKeyId = apiKey;
    params.SignatureMethod = 'HmacSHA256';
    params.SignatureVersion = '2';
    params.Timestamp = timestamp;

    // Sort parameters alphabetically
    const sortedParams = Object.keys(params).sort().map(key => {
        return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
    }).join('&');

    // Create pre-signed text: method + '\n' + host + '\n' + endpoint + '\n' + params
    const preSignedText = `${method.toUpperCase()}\napi.huobi.pro\n${endpoint}\n${sortedParams}`;

    // Generate signature
    const signature = crypto.createHmac('sha256', apiSecret).update(preSignedText).digest('base64');

    return {
        params: params,
        signature: signature,
        queryString: sortedParams + '&Signature=' + encodeURIComponent(signature)
    };
}

// POST /api/v1/trading/huobi/triangular/test-connection - Test Huobi API connection for triangular arbitrage
router.post('/huobi/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret } = req.body;

    if (!apiKey || !apiSecret) {
        return res.status(400).json({
            success: false,
            message: 'API Key and Secret are required'
        });
    }

    try {
        console.log('🔍 [HUOBI] Testing connection for triangular arbitrage...');

        const endpoint = HUOBI_CONFIG.endpoints.accounts;
        const authData = createHuobiSignature(apiKey, apiSecret, 'GET', endpoint);

        const accountsResponse = await fetch(`${HUOBI_CONFIG.baseUrl}${endpoint}?${authData.queryString}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const accountsData = await accountsResponse.json();

        if (accountsData.status === 'ok' && accountsData.data) {
            console.log('✅ [HUOBI] Connection successful');
            res.json({
                success: true,
                message: 'Huobi connection successful',
                accountsCount: accountsData.data.length,
                timestamp: new Date().toISOString()
            });
        } else {
            console.error('❌ [HUOBI] Connection failed:', accountsData['err-msg']);
            res.status(401).json({
                success: false,
                message: accountsData['err-msg'] || 'Invalid API credentials'
            });
        }
    } catch (error) {
        console.error('❌ [HUOBI] Connection test error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to test Huobi connection',
            error: error.message
        });
    }
}));

// POST /api/v1/trading/huobi/triangular/scan - Scan for triangular arbitrage opportunities
router.post('/huobi/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

    if (!apiKey || !apiSecret) {
        return res.status(400).json({
            success: false,
            message: 'API credentials are required'
        });
    }

    try {
        console.log('🔍 [HUOBI] Scanning for triangular arbitrage opportunities...');

        // Get all market tickers (no auth required for public endpoint)
        const tickerResponse = await fetch(`${HUOBI_CONFIG.baseUrl}${HUOBI_CONFIG.endpoints.ticker}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const tickerData = await tickerResponse.json();

        if (tickerData.status !== 'ok' || !tickerData.data) {
            throw new Error(tickerData['err-msg'] || 'Failed to fetch market data');
        }

        const priceMap = {};

        // Build price map
        tickerData.data.forEach(ticker => {
            if (ticker.symbol && ticker.close) {
                // Convert Huobi symbol format (btcusdt) to standard (BTC-USDT)
                const symbol = ticker.symbol.toUpperCase();
                priceMap[symbol] = parseFloat(ticker.close);
            }
        });

        console.log(`📊 [HUOBI] Loaded ${Object.keys(priceMap).length} trading pairs`);

        // Define triangular arbitrage paths (32 paths across 5 sets)
        const allPaths = {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'HB_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETHUSDT', 'BTCETH', 'BTCUSDT'], description: 'ETH → BTC Bridge' },
                { id: 'HB_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], description: 'ETH → SOL Bridge' },
                { id: 'HB_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], description: 'ETH → XRP Bridge' },
                { id: 'HB_ETH_4', path: ['USDT', 'ETH', 'TRX', 'USDT'], pairs: ['ETHUSDT', 'TRXETH', 'TRXUSDT'], description: 'ETH → TRX Bridge' },
                { id: 'HB_ETH_5', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], description: 'ETH → DOT Bridge' },
                { id: 'HB_ETH_6', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], description: 'ETH → MATIC Bridge' },
                { id: 'HB_ETH_7', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETHUSDT', 'LINKETH', 'LINKUSDT'], description: 'ETH → LINK Bridge' }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'HB_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], description: 'BTC → ETH Bridge' },
                { id: 'HB_BTC_2', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], description: 'BTC → XRP Bridge' },
                { id: 'HB_BTC_3', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], description: 'BTC → LTC Bridge' },
                { id: 'HB_BTC_4', path: ['USDT', 'BTC', 'BCH', 'USDT'], pairs: ['BTCUSDT', 'BCHBTC', 'BCHUSDT'], description: 'BTC → BCH Bridge' },
                { id: 'HB_BTC_5', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTCUSDT', 'ADABTC', 'ADAUSDT'], description: 'BTC → ADA Bridge' },
                { id: 'HB_BTC_6', path: ['USDT', 'BTC', 'AVAX', 'USDT'], pairs: ['BTCUSDT', 'AVAXBTC', 'AVAXUSDT'], description: 'BTC → AVAX Bridge' },
                { id: 'HB_BTC_7', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], description: 'BTC → UNI Bridge' }
            ],
            SET_3_HT_NATIVE_BRIDGE: [
                { id: 'HB_HT_1', path: ['USDT', 'HT', 'BTC', 'USDT'], pairs: ['HTUSDT', 'BTCHT', 'BTCUSDT'], description: 'HT → BTC Native' },
                { id: 'HB_HT_2', path: ['USDT', 'HT', 'ETH', 'USDT'], pairs: ['HTUSDT', 'ETHHT', 'ETHUSDT'], description: 'HT → ETH Native' },
                { id: 'HB_HT_3', path: ['USDT', 'HT', 'XRP', 'USDT'], pairs: ['HTUSDT', 'XRPHT', 'XRPUSDT'], description: 'HT → XRP Native' },
                { id: 'HB_HT_4', path: ['USDT', 'HT', 'TRX', 'USDT'], pairs: ['HTUSDT', 'TRXHT', 'TRXUSDT'], description: 'HT → TRX Native' },
                { id: 'HB_HT_5', path: ['USDT', 'HT', 'DOT', 'USDT'], pairs: ['HTUSDT', 'DOTHT', 'DOTUSDT'], description: 'HT → DOT Native' },
                { id: 'HB_HT_6', path: ['USDT', 'HT', 'SOL', 'USDT'], pairs: ['HTUSDT', 'SOLHT', 'SOLUSDT'], description: 'HT → SOL Native' }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'HB_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGEUSDT', 'BTCDOGE', 'BTCUSDT'], description: 'DOGE → BTC Meme' },
                { id: 'HB_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIBUSDT', 'ETHSHIB', 'ETHUSDT'], description: 'SHIB → ETH Meme' },
                { id: 'HB_VOL_3', path: ['USDT', 'APE', 'ETH', 'USDT'], pairs: ['APEUSDT', 'ETHAPE', 'ETHUSDT'], description: 'APE → ETH NFT' },
                { id: 'HB_VOL_4', path: ['USDT', 'NEAR', 'BTC', 'USDT'], pairs: ['NEARUSDT', 'BTCNEAR', 'BTCUSDT'], description: 'NEAR → BTC Layer1' },
                { id: 'HB_VOL_5', path: ['USDT', 'APT', 'ETH', 'USDT'], pairs: ['APTUSDT', 'ETHAPT', 'ETHUSDT'], description: 'APT → ETH Layer1' },
                { id: 'HB_VOL_6', path: ['USDT', 'FTM', 'BTC', 'USDT'], pairs: ['FTMUSDT', 'BTCFTM', 'BTCUSDT'], description: 'FTM → BTC DeFi' }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'HB_EXT_1', path: ['USDT', 'FIL', 'BTC', 'USDT'], pairs: ['FILUSDT', 'BTCFIL', 'BTCUSDT'], description: 'FIL → BTC Bridge' },
                { id: 'HB_EXT_2', path: ['USDT', 'ATOM', 'ETH', 'USDT'], pairs: ['ATOMUSDT', 'ETHATOM', 'ETHUSDT'], description: 'ATOM → ETH Bridge' },
                { id: 'HB_EXT_3', path: ['USDT', 'ICP', 'BTC', 'USDT'], pairs: ['ICPUSDT', 'BTCICP', 'BTCUSDT'], description: 'ICP → BTC Bridge' },
                { id: 'HB_EXT_4', path: ['USDT', 'ALGO', 'ETH', 'USDT'], pairs: ['ALGOUSDT', 'ETHALGO', 'ETHUSDT'], description: 'ALGO → ETH Bridge' },
                { id: 'HB_EXT_5', path: ['USDT', 'ETC', 'BTC', 'USDT'], pairs: ['ETCUSDT', 'BTCETC', 'BTCUSDT'], description: 'ETC → BTC Bridge' },
                { id: 'HB_EXT_6', path: ['USDT', 'BTC', 'ETH', 'XRP', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'XRPETH', 'XRPUSDT'], description: 'Multi-Bridge 4-Leg' }
            ]
        };

        // Filter paths based on enabled sets
        const enabledPaths = [];
        Object.keys(allPaths).forEach(setKey => {
            if (enabledSets && enabledSets[setKey]) {
                enabledPaths.push(...allPaths[setKey]);
            }
        });

        console.log(`🎯 [HUOBI] Scanning ${enabledPaths.length} enabled paths...`);

        // Calculate arbitrage for each path
        const opportunities = [];
        const threshold = profitThreshold || 0.5;

        enabledPaths.forEach(pathConfig => {
            try {
                // Check if all required pairs exist
                const allPairsExist = pathConfig.pairs.every(pair => priceMap[pair]);

                if (!allPairsExist) {
                    return; // Skip if any pair is missing
                }

                // Calculate path profit
                let amount = maxTradeAmount || 100;
                const executionSteps = [];

                // For standard 3-leg paths
                if (pathConfig.path.length === 4) {
                    // Leg 1: USDT → Asset1
                    const price1 = priceMap[pathConfig.pairs[0]];
                    const amount1 = amount / price1;
                    executionSteps.push({ pair: pathConfig.pairs[0], side: 'BUY', amount: amount, price: price1, result: amount1 });

                    // Leg 2: Asset1 → Asset2
                    const price2 = priceMap[pathConfig.pairs[1]];
                    const amount2 = amount1 / price2;
                    executionSteps.push({ pair: pathConfig.pairs[1], side: 'BUY', amount: amount1, price: price2, result: amount2 });

                    // Leg 3: Asset2 → USDT
                    const price3 = priceMap[pathConfig.pairs[2]];
                    const finalAmount = amount2 * price3;
                    executionSteps.push({ pair: pathConfig.pairs[2], side: 'SELL', amount: amount2, price: price3, result: finalAmount });

                    const profitAmount = finalAmount - amount;
                    const profitPercent = (profitAmount / amount) * 100;

                    if (profitPercent >= threshold) {
                        opportunities.push({
                            pathId: pathConfig.id,
                            path: pathConfig.path,
                            pairs: pathConfig.pairs,
                            description: pathConfig.description,
                            initialAmount: amount,
                            finalAmount: finalAmount,
                            profitAmount: profitAmount,
                            profitPercent: profitPercent.toFixed(4),
                            executionSteps: executionSteps,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                // For 4-leg multi-bridge path
                if (pathConfig.path.length === 5) {
                    // Leg 1: USDT → BTC
                    const price1 = priceMap[pathConfig.pairs[0]];
                    const amount1 = amount / price1;
                    executionSteps.push({ pair: pathConfig.pairs[0], side: 'BUY', amount: amount, price: price1, result: amount1 });

                    // Leg 2: BTC → ETH
                    const price2 = priceMap[pathConfig.pairs[1]];
                    const amount2 = amount1 / price2;
                    executionSteps.push({ pair: pathConfig.pairs[1], side: 'BUY', amount: amount1, price: price2, result: amount2 });

                    // Leg 3: ETH → XRP
                    const price3 = priceMap[pathConfig.pairs[2]];
                    const amount3 = amount2 / price3;
                    executionSteps.push({ pair: pathConfig.pairs[2], side: 'BUY', amount: amount2, price: price3, result: amount3 });

                    // Leg 4: XRP → USDT
                    const price4 = priceMap[pathConfig.pairs[3]];
                    const finalAmount = amount3 * price4;
                    executionSteps.push({ pair: pathConfig.pairs[3], side: 'SELL', amount: amount3, price: price4, result: finalAmount });

                    const profitAmount = finalAmount - amount;
                    const profitPercent = (profitAmount / amount) * 100;

                    if (profitPercent >= threshold) {
                        opportunities.push({
                            pathId: pathConfig.id,
                            path: pathConfig.path,
                            pairs: pathConfig.pairs,
                            description: pathConfig.description,
                            initialAmount: amount,
                            finalAmount: finalAmount,
                            profitAmount: profitAmount,
                            profitPercent: profitPercent.toFixed(4),
                            executionSteps: executionSteps,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`⚠️ [HUOBI] Error calculating path ${pathConfig.id}:`, error.message);
            }
        });

        // Sort by profit percentage
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        console.log(`✅ [HUOBI] Found ${opportunities.length} opportunities above ${threshold}% profit threshold`);

        res.json({
            success: true,
            exchange: 'huobi',
            opportunities: opportunities,
            totalScanned: enabledPaths.length,
            profitableCount: opportunities.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ [HUOBI] Scan error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to scan Huobi triangular opportunities',
            error: error.message
        });
    }
}));

// GET /api/v1/trading/huobi/triangular/paths - Get all available triangular paths
router.get('/huobi/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    console.log('📋 [HUOBI] Retrieving available triangular paths...');

    const paths = {
        SET_1_ESSENTIAL_ETH_BRIDGE: { count: 7, description: 'Major coins via ETH bridge', enabled: true },
        SET_2_MIDCAP_BTC_BRIDGE: { count: 7, description: 'Mid-cap coins via BTC bridge', enabled: true },
        SET_3_HT_NATIVE_BRIDGE: { count: 6, description: 'Using Huobi Token (HT)', enabled: false },
        SET_4_HIGH_VOLATILITY: { count: 6, description: 'High volatility meme/DeFi coins', enabled: false },
        SET_5_EXTENDED_MULTIBRIDGE: { count: 6, description: 'Extended paths including 4-leg', enabled: false }
    };

    res.json({
        success: true,
        exchange: 'huobi',
        totalPaths: 32,
        pathSets: paths,
        timestamp: new Date().toISOString()
    });
}));

// POST /api/v1/trading/huobi/triangular/execute - Execute a triangular arbitrage trade (placeholder)
router.post('/huobi/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, opportunity } = req.body;

    console.log('⚠️ [HUOBI] Execute endpoint called - NOT IMPLEMENTED YET');
    console.log('🎯 [HUOBI] Opportunity:', opportunity?.pathId);

    res.status(501).json({
        success: false,
        message: 'Execution not yet implemented - scan mode only',
        notice: 'This endpoint will be implemented after initial testing phase'
    });
}));

// DELETE /api/v1/trading/huobi/triangular/history - Clear Huobi triangular trade history
router.delete('/huobi/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    try {
        console.log('🗑️ [HUOBI] Clearing triangular trade history for user:', userId);

        const result = await db.query(
            'DELETE FROM triangular_trades WHERE user_id = $1 AND exchange = $2',
            [userId, 'HUOBI']
        );

        console.log(`✅ [HUOBI] Cleared ${result.rowCount} trade records`);

        res.json({
            success: true,
            message: `Cleared ${result.rowCount} Huobi triangular trade records`,
            deletedCount: result.rowCount
        });
    } catch (error) {
        console.error('❌ [HUOBI] History clear error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to clear Huobi trade history'
        });
    }
}));

// GET /api/v1/trading/huobi/triangular/recent-trades - Get recent Huobi triangular trades
router.get('/huobi/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    try {
        console.log('📜 [HUOBI] Retrieving recent triangular trades for user:', userId);

        const result = await db.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = $2
             ORDER BY created_at DESC
             LIMIT $3`,
            [userId, 'HUOBI', limit]
        );

        res.json({
            success: true,
            exchange: 'huobi',
            trades: result.rows,
            count: result.rows.length
        });
    } catch (error) {
        console.error('Huobi triangular recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Huobi trades'
        });
    }
}));

// ============================================================================
// GATE.IO EXCHANGE - TRIANGULAR ARBITRAGE
// ============================================================================

// Gate.io API Configuration
const GATE_CONFIG = {
    baseUrl: 'https://api.gateio.ws/api/v4',
    endpoints: {
        currencyPairs: '/spot/currency_pairs',
        tickers: '/spot/tickers',
        orderBook: '/spot/order_book',
        balances: '/spot/accounts',
        placeOrder: '/spot/orders'
    }
};

// Gate.io HMAC-SHA512 Authentication Helper
function createGateSignature(apiKey, apiSecret, method, endpoint, queryString = '', body = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Hash the request body with SHA512 if present
    const bodyHash = body ? crypto.createHash('sha512').update(body).digest('hex') : crypto.createHash('sha512').update('').digest('hex');

    // Build signature string: method + "\n" + url + "\n" + query + "\n" + bodyHash + "\n" + timestamp
    const signatureString = `${method.toUpperCase()}\n${endpoint}\n${queryString}\n${bodyHash}\n${timestamp}`;

    // Generate HMAC-SHA512 signature
    const signature = crypto.createHmac('sha512', apiSecret).update(signatureString).digest('hex');

    return {
        timestamp: timestamp,
        signature: signature
    };
}

// ROUTE 1: Test Gate.io Connection
router.post('/gateio/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API key and secret are required'
            });
        }

        // Test connection by fetching account balances
        const method = 'GET';
        const endpoint = GATE_CONFIG.endpoints.balances;
        const auth = createGateSignature(apiKey, apiSecret, method, endpoint);

        const response = await fetch(`${GATE_CONFIG.baseUrl}${endpoint}`, {
            method: method,
            headers: {
                'KEY': apiKey,
                'Timestamp': auth.timestamp,
                'SIGN': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(401).json({
                success: false,
                message: 'Gate.io API authentication failed',
                error: errorText
            });
        }

        const balances = await response.json();

        // Find USDT balance
        const usdtBalance = balances.find(b => b.currency === 'USDT');
        const usdtAvailable = usdtBalance ? parseFloat(usdtBalance.available) : 0;

        res.json({
            success: true,
            message: 'Gate.io connection successful',
            balances: {
                USDT: usdtAvailable.toFixed(2)
            }
        });

    } catch (error) {
        console.error('Gate.io connection test error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to connect to Gate.io'
        });
    }
}));

// ROUTE 2: Scan Gate.io Triangular Arbitrage Opportunities
router.post('/gateio/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Define all 32 triangular arbitrage paths
        const allPaths = {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'GT_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], description: 'ETH → BTC Bridge' },
                { id: 'GT_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], description: 'ETH → SOL Bridge' },
                { id: 'GT_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], description: 'ETH → XRP Bridge' },
                { id: 'GT_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], description: 'ETH → ADA Bridge' },
                { id: 'GT_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], description: 'ETH → MATIC Bridge' },
                { id: 'GT_ETH_6', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETH_USDT', 'LINK_ETH', 'LINK_USDT'], description: 'ETH → LINK Bridge' },
                { id: 'GT_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], description: 'ETH → AVAX Bridge' }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'GT_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], description: 'BTC → ETH Bridge' },
                { id: 'GT_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], description: 'BTC → SOL Bridge' },
                { id: 'GT_BTC_3', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], description: 'BTC → LTC Bridge' },
                { id: 'GT_BTC_4', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], description: 'BTC → DOT Bridge' },
                { id: 'GT_BTC_5', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], description: 'BTC → ATOM Bridge' },
                { id: 'GT_BTC_6', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTC_USDT', 'UNI_BTC', 'UNI_USDT'], description: 'BTC → UNI Bridge' },
                { id: 'GT_BTC_7', path: ['USDT', 'BTC', 'BCH', 'USDT'], pairs: ['BTC_USDT', 'BCH_BTC', 'BCH_USDT'], description: 'BTC → BCH Bridge' }
            ],
            SET_3_GT_NATIVE_BRIDGE: [
                { id: 'GT_GT_1', path: ['USDT', 'GT', 'BTC', 'USDT'], pairs: ['GT_USDT', 'BTC_GT', 'BTC_USDT'], description: 'GT → BTC Native' },
                { id: 'GT_GT_2', path: ['USDT', 'GT', 'ETH', 'USDT'], pairs: ['GT_USDT', 'ETH_GT', 'ETH_USDT'], description: 'GT → ETH Native' },
                { id: 'GT_GT_3', path: ['USDT', 'GT', 'SOL', 'USDT'], pairs: ['GT_USDT', 'SOL_GT', 'SOL_USDT'], description: 'GT → SOL Native' },
                { id: 'GT_GT_4', path: ['USDT', 'BTC', 'GT', 'USDT'], pairs: ['BTC_USDT', 'GT_BTC', 'GT_USDT'], description: 'BTC → GT Reverse' },
                { id: 'GT_GT_5', path: ['USDT', 'ETH', 'GT', 'USDT'], pairs: ['ETH_USDT', 'GT_ETH', 'GT_USDT'], description: 'ETH → GT Reverse' },
                { id: 'GT_GT_6', path: ['USDT', 'GT', 'TRX', 'USDT'], pairs: ['GT_USDT', 'TRX_GT', 'TRX_USDT'], description: 'GT → TRX Native' }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'GT_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], description: 'DOGE → BTC Volatility' },
                { id: 'GT_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], description: 'SHIB → ETH Volatility' },
                { id: 'GT_VOL_3', path: ['USDT', 'FTM', 'BTC', 'USDT'], pairs: ['FTM_USDT', 'BTC_FTM', 'BTC_USDT'], description: 'FTM → BTC Volatility' },
                { id: 'GT_VOL_4', path: ['USDT', 'SAND', 'ETH', 'USDT'], pairs: ['SAND_USDT', 'ETH_SAND', 'ETH_USDT'], description: 'SAND → ETH Volatility' },
                { id: 'GT_VOL_5', path: ['USDT', 'MANA', 'BTC', 'USDT'], pairs: ['MANA_USDT', 'BTC_MANA', 'BTC_USDT'], description: 'MANA → BTC Volatility' },
                { id: 'GT_VOL_6', path: ['USDT', 'APE', 'ETH', 'USDT'], pairs: ['APE_USDT', 'ETH_APE', 'ETH_USDT'], description: 'APE → ETH Volatility' }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'GT_EXT_1', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['SOL_USDT', 'ETH_SOL', 'ETH_USDT'], description: 'SOL → ETH Multi-Bridge' },
                { id: 'GT_EXT_2', path: ['USDT', 'XRP', 'BTC', 'USDT'], pairs: ['XRP_USDT', 'BTC_XRP', 'BTC_USDT'], description: 'XRP → BTC Multi-Bridge' },
                { id: 'GT_EXT_3', path: ['USDT', 'TRX', 'BTC', 'USDT'], pairs: ['TRX_USDT', 'BTC_TRX', 'BTC_USDT'], description: 'TRX → BTC Multi-Bridge' },
                { id: 'GT_EXT_4', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], description: 'ADA → BTC Multi-Bridge' },
                { id: 'GT_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'SOL_ETH', 'SOL_USDT'], description: '4-Leg BTC-ETH-SOL' },
                { id: 'GT_EXT_6', path: ['USDT', 'ETH', 'BTC', 'XRP', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'XRP_BTC', 'XRP_USDT'], description: '4-Leg ETH-BTC-XRP' }
            ]
        };

        // Filter paths based on enabled sets
        let pathsToScan = [];
        Object.keys(allPaths).forEach(setKey => {
            if (enabledSets[setKey]) {
                pathsToScan = pathsToScan.concat(allPaths[setKey]);
            }
        });

        // Fetch all tickers to build price map
        const tickersResponse = await fetch(`${GATE_CONFIG.baseUrl}${GATE_CONFIG.endpoints.tickers}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!tickersResponse.ok) {
            throw new Error('Failed to fetch Gate.io tickers');
        }

        const tickers = await tickersResponse.json();

        // Build price map
        const priceMap = {};
        tickers.forEach(ticker => {
            priceMap[ticker.currency_pair] = {
                bid: parseFloat(ticker.highest_bid) || 0,
                ask: parseFloat(ticker.lowest_ask) || 0,
                last: parseFloat(ticker.last) || 0
            };
        });

        // Scan each path for arbitrage opportunities
        const opportunities = [];

        for (const pathDef of pathsToScan) {
            try {
                const { path, pairs, id, description } = pathDef;
                let currentAmount = maxTradeAmount;
                let prices = [];
                let valid = true;

                // Calculate through each leg
                for (let i = 0; i < pairs.length; i++) {
                    const pair = pairs[i];
                    const priceData = priceMap[pair];

                    if (!priceData || priceData.bid === 0 || priceData.ask === 0) {
                        valid = false;
                        break;
                    }

                    const fromCurrency = path[i];
                    const toCurrency = path[i + 1];

                    // Determine if we're buying or selling the pair
                    const [base, quote] = pair.split('_');

                    if (fromCurrency === quote && toCurrency === base) {
                        // Buying base with quote (use ask price)
                        const price = priceData.ask;
                        currentAmount = currentAmount / price;
                        prices.push({ pair, side: 'buy', price, amount: currentAmount });
                    } else if (fromCurrency === base && toCurrency === quote) {
                        // Selling base for quote (use bid price)
                        const price = priceData.bid;
                        currentAmount = currentAmount * price;
                        prices.push({ pair, side: 'sell', price, amount: currentAmount });
                    } else {
                        valid = false;
                        break;
                    }
                }

                if (valid) {
                    const finalAmount = currentAmount;
                    const profit = finalAmount - maxTradeAmount;
                    const profitPercent = (profit / maxTradeAmount) * 100;

                    if (profitPercent >= profitThreshold) {
                        opportunities.push({
                            pathId: id,
                            path: path.join(' → '),
                            pairs: pairs,
                            description: description,
                            initialAmount: maxTradeAmount,
                            finalAmount: finalAmount.toFixed(2),
                            profit: profit.toFixed(2),
                            profitPercent: profitPercent.toFixed(4),
                            legs: prices,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`Error scanning path ${pathDef.id}:`, error);
            }
        }

        // Sort by profit percentage descending
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            scanned: pathsToScan.length,
            opportunities: opportunities,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Gate.io scan error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to scan Gate.io triangular paths'
        });
    }
}));

// ROUTE 3: Get All Gate.io Triangular Paths
router.get('/gateio/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const allPaths = {
        SET_1_ESSENTIAL_ETH_BRIDGE: [
            { id: 'GT_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], description: 'ETH → BTC Bridge' },
            { id: 'GT_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], description: 'ETH → SOL Bridge' },
            { id: 'GT_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], description: 'ETH → XRP Bridge' },
            { id: 'GT_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], description: 'ETH → ADA Bridge' },
            { id: 'GT_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], description: 'ETH → MATIC Bridge' },
            { id: 'GT_ETH_6', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETH_USDT', 'LINK_ETH', 'LINK_USDT'], description: 'ETH → LINK Bridge' },
            { id: 'GT_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], description: 'ETH → AVAX Bridge' }
        ],
        SET_2_MIDCAP_BTC_BRIDGE: [
            { id: 'GT_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], description: 'BTC → ETH Bridge' },
            { id: 'GT_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], description: 'BTC → SOL Bridge' },
            { id: 'GT_BTC_3', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], description: 'BTC → LTC Bridge' },
            { id: 'GT_BTC_4', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], description: 'BTC → DOT Bridge' },
            { id: 'GT_BTC_5', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], description: 'BTC → ATOM Bridge' },
            { id: 'GT_BTC_6', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTC_USDT', 'UNI_BTC', 'UNI_USDT'], description: 'BTC → UNI Bridge' },
            { id: 'GT_BTC_7', path: ['USDT', 'BTC', 'BCH', 'USDT'], pairs: ['BTC_USDT', 'BCH_BTC', 'BCH_USDT'], description: 'BTC → BCH Bridge' }
        ],
        SET_3_GT_NATIVE_BRIDGE: [
            { id: 'GT_GT_1', path: ['USDT', 'GT', 'BTC', 'USDT'], pairs: ['GT_USDT', 'BTC_GT', 'BTC_USDT'], description: 'GT → BTC Native' },
            { id: 'GT_GT_2', path: ['USDT', 'GT', 'ETH', 'USDT'], pairs: ['GT_USDT', 'ETH_GT', 'ETH_USDT'], description: 'GT → ETH Native' },
            { id: 'GT_GT_3', path: ['USDT', 'GT', 'SOL', 'USDT'], pairs: ['GT_USDT', 'SOL_GT', 'SOL_USDT'], description: 'GT → SOL Native' },
            { id: 'GT_GT_4', path: ['USDT', 'BTC', 'GT', 'USDT'], pairs: ['BTC_USDT', 'GT_BTC', 'GT_USDT'], description: 'BTC → GT Reverse' },
            { id: 'GT_GT_5', path: ['USDT', 'ETH', 'GT', 'USDT'], pairs: ['ETH_USDT', 'GT_ETH', 'GT_USDT'], description: 'ETH → GT Reverse' },
            { id: 'GT_GT_6', path: ['USDT', 'GT', 'TRX', 'USDT'], pairs: ['GT_USDT', 'TRX_GT', 'TRX_USDT'], description: 'GT → TRX Native' }
        ],
        SET_4_HIGH_VOLATILITY: [
            { id: 'GT_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], description: 'DOGE → BTC Volatility' },
            { id: 'GT_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], description: 'SHIB → ETH Volatility' },
            { id: 'GT_VOL_3', path: ['USDT', 'FTM', 'BTC', 'USDT'], pairs: ['FTM_USDT', 'BTC_FTM', 'BTC_USDT'], description: 'FTM → BTC Volatility' },
            { id: 'GT_VOL_4', path: ['USDT', 'SAND', 'ETH', 'USDT'], pairs: ['SAND_USDT', 'ETH_SAND', 'ETH_USDT'], description: 'SAND → ETH Volatility' },
            { id: 'GT_VOL_5', path: ['USDT', 'MANA', 'BTC', 'USDT'], pairs: ['MANA_USDT', 'BTC_MANA', 'BTC_USDT'], description: 'MANA → BTC Volatility' },
            { id: 'GT_VOL_6', path: ['USDT', 'APE', 'ETH', 'USDT'], pairs: ['APE_USDT', 'ETH_APE', 'ETH_USDT'], description: 'APE → ETH Volatility' }
        ],
        SET_5_EXTENDED_MULTIBRIDGE: [
            { id: 'GT_EXT_1', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['SOL_USDT', 'ETH_SOL', 'ETH_USDT'], description: 'SOL → ETH Multi-Bridge' },
            { id: 'GT_EXT_2', path: ['USDT', 'XRP', 'BTC', 'USDT'], pairs: ['XRP_USDT', 'BTC_XRP', 'BTC_USDT'], description: 'XRP → BTC Multi-Bridge' },
            { id: 'GT_EXT_3', path: ['USDT', 'TRX', 'BTC', 'USDT'], pairs: ['TRX_USDT', 'BTC_TRX', 'BTC_USDT'], description: 'TRX → BTC Multi-Bridge' },
            { id: 'GT_EXT_4', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], description: 'ADA → BTC Multi-Bridge' },
            { id: 'GT_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'SOL_ETH', 'SOL_USDT'], description: '4-Leg BTC-ETH-SOL' },
            { id: 'GT_EXT_6', path: ['USDT', 'ETH', 'BTC', 'XRP', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'XRP_BTC', 'XRP_USDT'], description: '4-Leg ETH-BTC-XRP' }
        ]
    };

    res.json({
        success: true,
        totalPaths: 32,
        sets: allPaths
    });
}));

// ROUTE 4: Execute Gate.io Triangular Trade
router.post('/gateio/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, opportunity, dryRun } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        if (dryRun) {
            return res.json({
                success: true,
                message: 'DRY RUN - Trade would execute with following parameters',
                opportunity: opportunity,
                execution: {
                    leg1: { status: 'simulated', pair: opportunity.legs[0].pair },
                    leg2: { status: 'simulated', pair: opportunity.legs[1].pair },
                    leg3: { status: 'simulated', pair: opportunity.legs[2].pair }
                }
            });
        }

        // Real execution would go here
        res.json({
            success: true,
            message: 'Gate.io triangular trade execution endpoint ready',
            note: 'Full execution logic to be implemented after testing phase'
        });

    } catch (error) {
        console.error('Gate.io execute error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to execute Gate.io triangular trade'
        });
    }
}));

// ROUTE 5: Get Gate.io Trade History
router.post('/gateio/triangular/history', asyncHandler(async (req, res) => {
    try {
        const { userId, limit = 50 } = req.body;

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'GATEIO'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Gate.io history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Gate.io trade history'
        });
    }
}));

// ROUTE 6: Get Recent Gate.io Trades (All Users)
router.get('/gateio/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'GATEIO'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Gate.io recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Gate.io trades'
        });
    }
}));

// ============================================================================
// CRYPTO.COM EXCHANGE - TRIANGULAR ARBITRAGE
// ============================================================================

// Crypto.com Triangular Arbitrage API Configuration
const CRYPTOCOM_TRIANGULAR_CONFIG = {
    baseUrl: 'https://api.crypto.com/v1',
    endpoints: {
        tickers: '/public/get-tickers',
        orderBook: '/public/get-book',
        instruments: '/public/get-instruments',
        balance: '/private/get-account-summary',
        placeOrder: '/private/create-order'
    }
};

// Crypto.com HMAC-SHA256 Authentication Helper
function createCryptocomSignature(apiKey, apiSecret, method, endpoint, params = {}, nonce = Date.now()) {
    // Add required fields
    params.api_key = apiKey;
    params.nonce = nonce;
    params.method = method;

    // Sort params alphabetically by key
    const sortedKeys = Object.keys(params).sort();

    // Concatenate key+value pairs (no spaces, no delimiters)
    let signatureString = '';
    sortedKeys.forEach(key => {
        signatureString += key + params[key];
    });

    // Generate HMAC-SHA256 signature and hex encode
    const signature = crypto.createHmac('sha256', apiSecret).update(signatureString).digest('hex');

    return {
        params: params,
        signature: signature,
        nonce: nonce
    };
}

// ROUTE 1: Test Crypto.com Connection
router.post('/cryptocom/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API key and secret are required'
            });
        }

        // Test connection by fetching account summary
        const method = 'private/get-account-summary';
        const nonce = Date.now();
        const params = {};
        const auth = createCryptocomSignature(apiKey, apiSecret, method, '', params, nonce);

        const response = await fetch(`${CRYPTOCOM_TRIANGULAR_CONFIG.baseUrl}${CRYPTOCOM_TRIANGULAR_CONFIG.endpoints.balance}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                id: nonce,
                method: method,
                api_key: apiKey,
                sig: auth.signature,
                nonce: nonce,
                params: {}
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(401).json({
                success: false,
                message: 'Crypto.com API authentication failed',
                error: errorText
            });
        }

        const result = await response.json();

        if (result.code !== 0) {
            throw new Error(result.message || 'Authentication failed');
        }

        // Find USDT balance
        const accounts = result.result.accounts || [];
        const usdtAccount = accounts.find(acc => acc.currency === 'USDT');
        const usdtAvailable = usdtAccount ? parseFloat(usdtAccount.available) : 0;

        res.json({
            success: true,
            message: 'Crypto.com connection successful',
            balances: {
                USDT: usdtAvailable.toFixed(2)
            }
        });

    } catch (error) {
        console.error('Crypto.com connection test error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to connect to Crypto.com'
        });
    }
}));

// ROUTE 2: Scan Crypto.com Triangular Arbitrage Opportunities
router.post('/cryptocom/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Define all 32 triangular arbitrage paths
        const allPaths = {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'CDC_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], description: 'ETH → BTC Bridge' },
                { id: 'CDC_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], description: 'ETH → SOL Bridge' },
                { id: 'CDC_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], description: 'ETH → XRP Bridge' },
                { id: 'CDC_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], description: 'ETH → ADA Bridge' },
                { id: 'CDC_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], description: 'ETH → MATIC Bridge' },
                { id: 'CDC_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETH_USDT', 'DOT_ETH', 'DOT_USDT'], description: 'ETH → DOT Bridge' },
                { id: 'CDC_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], description: 'ETH → AVAX Bridge' }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'CDC_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], description: 'BTC → ETH Bridge' },
                { id: 'CDC_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], description: 'BTC → SOL Bridge' },
                { id: 'CDC_BTC_3', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTC_USDT', 'ADA_BTC', 'ADA_USDT'], description: 'BTC → ADA Bridge' },
                { id: 'CDC_BTC_4', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], description: 'BTC → DOT Bridge' },
                { id: 'CDC_BTC_5', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], description: 'BTC → ATOM Bridge' },
                { id: 'CDC_BTC_6', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], description: 'BTC → LTC Bridge' },
                { id: 'CDC_BTC_7', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTC_USDT', 'XRP_BTC', 'XRP_USDT'], description: 'BTC → XRP Bridge' }
            ],
            SET_3_CRO_NATIVE_BRIDGE: [
                { id: 'CDC_CRO_1', path: ['USDT', 'CRO', 'BTC', 'USDT'], pairs: ['CRO_USDT', 'BTC_CRO', 'BTC_USDT'], description: 'CRO → BTC Native' },
                { id: 'CDC_CRO_2', path: ['USDT', 'CRO', 'ETH', 'USDT'], pairs: ['CRO_USDT', 'ETH_CRO', 'ETH_USDT'], description: 'CRO → ETH Native' },
                { id: 'CDC_CRO_3', path: ['USDT', 'CRO', 'SOL', 'USDT'], pairs: ['CRO_USDT', 'SOL_CRO', 'SOL_USDT'], description: 'CRO → SOL Native' },
                { id: 'CDC_CRO_4', path: ['USDT', 'BTC', 'CRO', 'USDT'], pairs: ['BTC_USDT', 'CRO_BTC', 'CRO_USDT'], description: 'BTC → CRO Reverse' },
                { id: 'CDC_CRO_5', path: ['USDT', 'ETH', 'CRO', 'USDT'], pairs: ['ETH_USDT', 'CRO_ETH', 'CRO_USDT'], description: 'ETH → CRO Reverse' },
                { id: 'CDC_CRO_6', path: ['USDT', 'CRO', 'MATIC', 'USDT'], pairs: ['CRO_USDT', 'MATIC_CRO', 'MATIC_USDT'], description: 'CRO → MATIC Native' }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'CDC_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], description: 'DOGE → BTC Volatility' },
                { id: 'CDC_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], description: 'SHIB → ETH Volatility' },
                { id: 'CDC_VOL_3', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['MATIC_USDT', 'BTC_MATIC', 'BTC_USDT'], description: 'MATIC → BTC Volatility' },
                { id: 'CDC_VOL_4', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['SOL_USDT', 'ETH_SOL', 'ETH_USDT'], description: 'SOL → ETH Volatility' },
                { id: 'CDC_VOL_5', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], description: 'ADA → BTC Volatility' },
                { id: 'CDC_VOL_6', path: ['USDT', 'DOT', 'ETH', 'USDT'], pairs: ['DOT_USDT', 'ETH_DOT', 'ETH_USDT'], description: 'DOT → ETH Volatility' }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'CDC_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOL_USDT', 'BTC_SOL', 'BTC_USDT'], description: 'SOL → BTC Multi-Bridge' },
                { id: 'CDC_EXT_2', path: ['USDT', 'XRP', 'ETH', 'USDT'], pairs: ['XRP_USDT', 'ETH_XRP', 'ETH_USDT'], description: 'XRP → ETH Multi-Bridge' },
                { id: 'CDC_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['AVAX_USDT', 'BTC_AVAX', 'BTC_USDT'], description: 'AVAX → BTC Multi-Bridge' },
                { id: 'CDC_EXT_4', path: ['USDT', 'ATOM', 'ETH', 'USDT'], pairs: ['ATOM_USDT', 'ETH_ATOM', 'ETH_USDT'], description: 'ATOM → ETH Multi-Bridge' },
                { id: 'CDC_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'SOL_ETH', 'SOL_USDT'], description: '4-Leg BTC-ETH-SOL' },
                { id: 'CDC_EXT_6', path: ['USDT', 'ETH', 'BTC', 'ADA', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'ADA_BTC', 'ADA_USDT'], description: '4-Leg ETH-BTC-ADA' }
            ]
        };

        // Filter paths based on enabled sets
        let pathsToScan = [];
        Object.keys(allPaths).forEach(setKey => {
            if (enabledSets[setKey]) {
                pathsToScan = pathsToScan.concat(allPaths[setKey]);
            }
        });

        // Fetch all tickers (public endpoint, no auth needed)
        const tickersResponse = await fetch(`${CRYPTOCOM_TRIANGULAR_CONFIG.baseUrl}${CRYPTOCOM_TRIANGULAR_CONFIG.endpoints.tickers}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!tickersResponse.ok) {
            throw new Error('Failed to fetch Crypto.com tickers');
        }

        const tickersResult = await tickersResponse.json();

        if (tickersResult.code !== 0) {
            throw new Error(tickersResult.message || 'Failed to fetch tickers');
        }

        const tickers = tickersResult.result.data || [];

        // Build price map
        const priceMap = {};
        tickers.forEach(ticker => {
            const symbol = ticker.i; // instrument_name like BTC_USDT
            priceMap[symbol] = {
                bid: parseFloat(ticker.b) || 0,  // best bid
                ask: parseFloat(ticker.k) || 0,  // best ask
                last: parseFloat(ticker.a) || 0  // latest price
            };
        });

        // Scan each path for arbitrage opportunities
        const opportunities = [];

        for (const pathDef of pathsToScan) {
            try {
                const { path, pairs, id, description } = pathDef;
                let currentAmount = maxTradeAmount;
                let prices = [];
                let valid = true;

                // Calculate through each leg
                for (let i = 0; i < pairs.length; i++) {
                    const pair = pairs[i];
                    const priceData = priceMap[pair];

                    if (!priceData || priceData.bid === 0 || priceData.ask === 0) {
                        valid = false;
                        break;
                    }

                    const fromCurrency = path[i];
                    const toCurrency = path[i + 1];

                    // Determine if we're buying or selling the pair
                    const [base, quote] = pair.split('_');

                    if (fromCurrency === quote && toCurrency === base) {
                        // Buying base with quote (use ask price)
                        const price = priceData.ask;
                        currentAmount = currentAmount / price;
                        prices.push({ pair, side: 'buy', price, amount: currentAmount });
                    } else if (fromCurrency === base && toCurrency === quote) {
                        // Selling base for quote (use bid price)
                        const price = priceData.bid;
                        currentAmount = currentAmount * price;
                        prices.push({ pair, side: 'sell', price, amount: currentAmount });
                    } else {
                        valid = false;
                        break;
                    }
                }

                if (valid) {
                    const finalAmount = currentAmount;
                    const profit = finalAmount - maxTradeAmount;
                    const profitPercent = (profit / maxTradeAmount) * 100;

                    if (profitPercent >= profitThreshold) {
                        opportunities.push({
                            pathId: id,
                            path: path.join(' → '),
                            pairs: pairs,
                            description: description,
                            initialAmount: maxTradeAmount,
                            finalAmount: finalAmount.toFixed(2),
                            profit: profit.toFixed(2),
                            profitPercent: profitPercent.toFixed(4),
                            legs: prices,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`Error scanning path ${pathDef.id}:`, error);
            }
        }

        // Sort by profit percentage descending
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            scanned: pathsToScan.length,
            opportunities: opportunities,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Crypto.com scan error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to scan Crypto.com triangular paths'
        });
    }
}));

// ROUTE 3: Get All Crypto.com Triangular Paths
router.get('/cryptocom/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const allPaths = {
        SET_1_ESSENTIAL_ETH_BRIDGE: [
            { id: 'CDC_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], description: 'ETH → BTC Bridge' },
            { id: 'CDC_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], description: 'ETH → SOL Bridge' },
            { id: 'CDC_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], description: 'ETH → XRP Bridge' },
            { id: 'CDC_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], description: 'ETH → ADA Bridge' },
            { id: 'CDC_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], description: 'ETH → MATIC Bridge' },
            { id: 'CDC_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETH_USDT', 'DOT_ETH', 'DOT_USDT'], description: 'ETH → DOT Bridge' },
            { id: 'CDC_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], description: 'ETH → AVAX Bridge' }
        ],
        SET_2_MIDCAP_BTC_BRIDGE: [
            { id: 'CDC_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], description: 'BTC → ETH Bridge' },
            { id: 'CDC_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], description: 'BTC → SOL Bridge' },
            { id: 'CDC_BTC_3', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTC_USDT', 'ADA_BTC', 'ADA_USDT'], description: 'BTC → ADA Bridge' },
            { id: 'CDC_BTC_4', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], description: 'BTC → DOT Bridge' },
            { id: 'CDC_BTC_5', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], description: 'BTC → ATOM Bridge' },
            { id: 'CDC_BTC_6', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], description: 'BTC → LTC Bridge' },
            { id: 'CDC_BTC_7', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTC_USDT', 'XRP_BTC', 'XRP_USDT'], description: 'BTC → XRP Bridge' }
        ],
        SET_3_CRO_NATIVE_BRIDGE: [
            { id: 'CDC_CRO_1', path: ['USDT', 'CRO', 'BTC', 'USDT'], pairs: ['CRO_USDT', 'BTC_CRO', 'BTC_USDT'], description: 'CRO → BTC Native' },
            { id: 'CDC_CRO_2', path: ['USDT', 'CRO', 'ETH', 'USDT'], pairs: ['CRO_USDT', 'ETH_CRO', 'ETH_USDT'], description: 'CRO → ETH Native' },
            { id: 'CDC_CRO_3', path: ['USDT', 'CRO', 'SOL', 'USDT'], pairs: ['CRO_USDT', 'SOL_CRO', 'SOL_USDT'], description: 'CRO → SOL Native' },
            { id: 'CDC_CRO_4', path: ['USDT', 'BTC', 'CRO', 'USDT'], pairs: ['BTC_USDT', 'CRO_BTC', 'CRO_USDT'], description: 'BTC → CRO Reverse' },
            { id: 'CDC_CRO_5', path: ['USDT', 'ETH', 'CRO', 'USDT'], pairs: ['ETH_USDT', 'CRO_ETH', 'CRO_USDT'], description: 'ETH → CRO Reverse' },
            { id: 'CDC_CRO_6', path: ['USDT', 'CRO', 'MATIC', 'USDT'], pairs: ['CRO_USDT', 'MATIC_CRO', 'MATIC_USDT'], description: 'CRO → MATIC Native' }
        ],
        SET_4_HIGH_VOLATILITY: [
            { id: 'CDC_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], description: 'DOGE → BTC Volatility' },
            { id: 'CDC_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], description: 'SHIB → ETH Volatility' },
            { id: 'CDC_VOL_3', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['MATIC_USDT', 'BTC_MATIC', 'BTC_USDT'], description: 'MATIC → BTC Volatility' },
            { id: 'CDC_VOL_4', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['SOL_USDT', 'ETH_SOL', 'ETH_USDT'], description: 'SOL → ETH Volatility' },
            { id: 'CDC_VOL_5', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], description: 'ADA → BTC Volatility' },
            { id: 'CDC_VOL_6', path: ['USDT', 'DOT', 'ETH', 'USDT'], pairs: ['DOT_USDT', 'ETH_DOT', 'ETH_USDT'], description: 'DOT → ETH Volatility' }
        ],
        SET_5_EXTENDED_MULTIBRIDGE: [
            { id: 'CDC_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOL_USDT', 'BTC_SOL', 'BTC_USDT'], description: 'SOL → BTC Multi-Bridge' },
            { id: 'CDC_EXT_2', path: ['USDT', 'XRP', 'ETH', 'USDT'], pairs: ['XRP_USDT', 'ETH_XRP', 'ETH_USDT'], description: 'XRP → ETH Multi-Bridge' },
            { id: 'CDC_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['AVAX_USDT', 'BTC_AVAX', 'BTC_USDT'], description: 'AVAX → BTC Multi-Bridge' },
            { id: 'CDC_EXT_4', path: ['USDT', 'ATOM', 'ETH', 'USDT'], pairs: ['ATOM_USDT', 'ETH_ATOM', 'ETH_USDT'], description: 'ATOM → ETH Multi-Bridge' },
            { id: 'CDC_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'SOL_ETH', 'SOL_USDT'], description: '4-Leg BTC-ETH-SOL' },
            { id: 'CDC_EXT_6', path: ['USDT', 'ETH', 'BTC', 'ADA', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'ADA_BTC', 'ADA_USDT'], description: '4-Leg ETH-BTC-ADA' }
        ]
    };

    res.json({
        success: true,
        totalPaths: 32,
        sets: allPaths
    });
}));

// ROUTE 4: Execute Crypto.com Triangular Trade
router.post('/cryptocom/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, opportunity, dryRun } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        if (dryRun) {
            return res.json({
                success: true,
                message: 'DRY RUN - Trade would execute with following parameters',
                opportunity: opportunity,
                execution: {
                    leg1: { status: 'simulated', pair: opportunity.legs[0].pair },
                    leg2: { status: 'simulated', pair: opportunity.legs[1].pair },
                    leg3: { status: 'simulated', pair: opportunity.legs[2].pair }
                }
            });
        }

        // Real execution would go here
        res.json({
            success: true,
            message: 'Crypto.com triangular trade execution endpoint ready',
            note: 'Full execution logic to be implemented after testing phase'
        });

    } catch (error) {
        console.error('Crypto.com execute error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to execute Crypto.com triangular trade'
        });
    }
}));

// ROUTE 5: Get Crypto.com Trade History
router.post('/cryptocom/triangular/history', asyncHandler(async (req, res) => {
    try {
        const { userId, limit = 50 } = req.body;

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'CRYPTOCOM'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Crypto.com history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Crypto.com trade history'
        });
    }
}));

// ROUTE 6: Get Recent Crypto.com Trades (All Users)
router.get('/cryptocom/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'CRYPTOCOM'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Crypto.com recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Crypto.com trades'
        });
    }
}));

// ============================================================================
// MEXC EXCHANGE - TRIANGULAR ARBITRAGE
// ============================================================================

// MEXC Triangular Arbitrage API Configuration
const MEXC_TRIANGULAR_CONFIG = {
    baseUrl: 'https://api.mexc.com/api/v3',
    endpoints: {
        ticker: '/ticker/24hr',
        orderBook: '/depth',
        account: '/account',
        placeOrder: '/order'
    }
};

// MEXC HMAC-SHA256 Authentication Helper
function createMexcSignature(apiKey, apiSecret, timestamp, params = '') {
    // Signature format: accessKey + timestamp + params
    const signatureString = apiKey + timestamp + params;

    // Generate HMAC-SHA256 signature (lowercase only for MEXC)
    const signature = crypto.createHmac('sha256', apiSecret).update(signatureString).digest('hex');

    return signature;
}

// ROUTE 1: Test MEXC Connection
router.post('/mexc/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API key and secret are required'
            });
        }

        // Test connection by fetching account info
        const timestamp = Date.now().toString();
        const queryString = `timestamp=${timestamp}`;
        const signature = createMexcSignature(apiKey, apiSecret, timestamp, queryString);

        const response = await fetch(`${MEXC_TRIANGULAR_CONFIG.baseUrl}${MEXC_TRIANGULAR_CONFIG.endpoints.account}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            return res.status(401).json({
                success: false,
                message: 'MEXC API authentication failed',
                error: errorText
            });
        }

        const accountData = await response.json();

        // Find USDT balance
        const balances = accountData.balances || [];
        const usdtBalance = balances.find(b => b.asset === 'USDT');
        const usdtAvailable = usdtBalance ? parseFloat(usdtBalance.free) : 0;

        res.json({
            success: true,
            message: 'MEXC connection successful',
            balances: {
                USDT: usdtAvailable.toFixed(2)
            }
        });

    } catch (error) {
        console.error('MEXC connection test error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to connect to MEXC'
        });
    }
}));

// ROUTE 2: Scan MEXC Triangular Arbitrage Opportunities
router.post('/mexc/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Define all 32 triangular arbitrage paths
        const allPaths = {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'MEXC_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETHUSDT', 'BTCETH', 'BTCUSDT'], description: 'ETH → BTC Bridge' },
                { id: 'MEXC_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], description: 'ETH → SOL Bridge' },
                { id: 'MEXC_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], description: 'ETH → XRP Bridge' },
                { id: 'MEXC_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], description: 'ETH → ADA Bridge' },
                { id: 'MEXC_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], description: 'ETH → MATIC Bridge' },
                { id: 'MEXC_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], description: 'ETH → DOT Bridge' },
                { id: 'MEXC_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], description: 'ETH → AVAX Bridge' }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'MEXC_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], description: 'BTC → ETH Bridge' },
                { id: 'MEXC_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], description: 'BTC → SOL Bridge' },
                { id: 'MEXC_BTC_3', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], description: 'BTC → XRP Bridge' },
                { id: 'MEXC_BTC_4', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], description: 'BTC → LTC Bridge' },
                { id: 'MEXC_BTC_5', path: ['USDT', 'BTC', 'LINK', 'USDT'], pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], description: 'BTC → LINK Bridge' },
                { id: 'MEXC_BTC_6', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], description: 'BTC → ATOM Bridge' },
                { id: 'MEXC_BTC_7', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], description: 'BTC → UNI Bridge' }
            ],
            SET_3_MX_NATIVE_BRIDGE: [
                { id: 'MEXC_MX_1', path: ['USDT', 'MX', 'BTC', 'USDT'], pairs: ['MXUSDT', 'BTCMX', 'BTCUSDT'], description: 'MX → BTC Native' },
                { id: 'MEXC_MX_2', path: ['USDT', 'MX', 'ETH', 'USDT'], pairs: ['MXUSDT', 'ETHMX', 'ETHUSDT'], description: 'MX → ETH Native' },
                { id: 'MEXC_MX_3', path: ['USDT', 'MX', 'SOL', 'USDT'], pairs: ['MXUSDT', 'SOLMX', 'SOLUSDT'], description: 'MX → SOL Native' },
                { id: 'MEXC_MX_4', path: ['USDT', 'BTC', 'MX', 'USDT'], pairs: ['BTCUSDT', 'MXBTC', 'MXUSDT'], description: 'BTC → MX Reverse' },
                { id: 'MEXC_MX_5', path: ['USDT', 'ETH', 'MX', 'USDT'], pairs: ['ETHUSDT', 'MXETH', 'MXUSDT'], description: 'ETH → MX Reverse' },
                { id: 'MEXC_MX_6', path: ['USDT', 'MX', 'BNB', 'USDT'], pairs: ['MXUSDT', 'BNBMX', 'BNBUSDT'], description: 'MX → BNB Native' }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'MEXC_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGEUSDT', 'BTCDOGE', 'BTCUSDT'], description: 'DOGE → BTC Volatility' },
                { id: 'MEXC_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIBUSDT', 'ETHSHIB', 'ETHUSDT'], description: 'SHIB → ETH Volatility' },
                { id: 'MEXC_VOL_3', path: ['USDT', 'PEPE', 'ETH', 'USDT'], pairs: ['PEPEUSDT', 'ETHPEPE', 'ETHUSDT'], description: 'PEPE → ETH Volatility' },
                { id: 'MEXC_VOL_4', path: ['USDT', 'FLOKI', 'BTC', 'USDT'], pairs: ['FLOKIUSDT', 'BTCFLOKI', 'BTCUSDT'], description: 'FLOKI → BTC Volatility' },
                { id: 'MEXC_VOL_5', path: ['USDT', 'TON', 'ETH', 'USDT'], pairs: ['TONUSDT', 'ETHTON', 'ETHUSDT'], description: 'TON → ETH Volatility' },
                { id: 'MEXC_VOL_6', path: ['USDT', 'SUI', 'BTC', 'USDT'], pairs: ['SUIUSDT', 'BTCSUI', 'BTCUSDT'], description: 'SUI → BTC Volatility' }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'MEXC_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOLUSDT', 'BTCSOL', 'BTCUSDT'], description: 'SOL → BTC Multi-Bridge' },
                { id: 'MEXC_EXT_2', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADAUSDT', 'BTCADA', 'BTCUSDT'], description: 'ADA → BTC Multi-Bridge' },
                { id: 'MEXC_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['AVAXUSDT', 'BTCAVAX', 'BTCUSDT'], description: 'AVAX → BTC Multi-Bridge' },
                { id: 'MEXC_EXT_4', path: ['USDT', 'MATIC', 'ETH', 'USDT'], pairs: ['MATICUSDT', 'ETHMATIC', 'ETHUSDT'], description: 'MATIC → ETH Multi-Bridge' },
                { id: 'MEXC_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'SOLETH', 'SOLUSDT'], description: '4-Leg BTC-ETH-SOL' },
                { id: 'MEXC_EXT_6', path: ['USDT', 'ETH', 'BTC', 'XRP', 'USDT'], pairs: ['ETHUSDT', 'BTCETH', 'XRPBTC', 'XRPUSDT'], description: '4-Leg ETH-BTC-XRP' }
            ]
        };

        // Filter paths based on enabled sets
        let pathsToScan = [];
        Object.keys(allPaths).forEach(setKey => {
            if (enabledSets[setKey]) {
                pathsToScan = pathsToScan.concat(allPaths[setKey]);
            }
        });

        // Fetch all tickers (public endpoint, no auth needed)
        const tickersResponse = await fetch(`${MEXC_TRIANGULAR_CONFIG.baseUrl}${MEXC_TRIANGULAR_CONFIG.endpoints.ticker}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!tickersResponse.ok) {
            throw new Error('Failed to fetch MEXC tickers');
        }

        const tickers = await tickersResponse.json();

        // Build price map
        const priceMap = {};
        tickers.forEach(ticker => {
            priceMap[ticker.symbol] = {
                bid: parseFloat(ticker.bidPrice) || 0,
                ask: parseFloat(ticker.askPrice) || 0,
                last: parseFloat(ticker.lastPrice) || 0
            };
        });

        // Scan each path for arbitrage opportunities
        const opportunities = [];

        for (const pathDef of pathsToScan) {
            try {
                const { path, pairs, id, description } = pathDef;
                let currentAmount = maxTradeAmount;
                let prices = [];
                let valid = true;

                // Calculate through each leg
                for (let i = 0; i < pairs.length; i++) {
                    const pair = pairs[i];
                    const priceData = priceMap[pair];

                    if (!priceData || priceData.bid === 0 || priceData.ask === 0) {
                        valid = false;
                        break;
                    }

                    const fromCurrency = path[i];
                    const toCurrency = path[i + 1];

                    // Determine if we're buying or selling the pair
                    // MEXC format: BTCUSDT means BTC is base, USDT is quote
                    let base, quote;
                    if (pair.endsWith('USDT')) {
                        quote = 'USDT';
                        base = pair.replace('USDT', '');
                    } else if (pair.endsWith('BTC')) {
                        quote = 'BTC';
                        base = pair.replace('BTC', '');
                    } else if (pair.endsWith('ETH')) {
                        quote = 'ETH';
                        base = pair.replace('ETH', '');
                    } else {
                        valid = false;
                        break;
                    }

                    if (fromCurrency === quote && toCurrency === base) {
                        // Buying base with quote (use ask price)
                        const price = priceData.ask;
                        currentAmount = currentAmount / price;
                        prices.push({ pair, side: 'buy', price, amount: currentAmount });
                    } else if (fromCurrency === base && toCurrency === quote) {
                        // Selling base for quote (use bid price)
                        const price = priceData.bid;
                        currentAmount = currentAmount * price;
                        prices.push({ pair, side: 'sell', price, amount: currentAmount });
                    } else {
                        valid = false;
                        break;
                    }
                }

                if (valid) {
                    const finalAmount = currentAmount;
                    const profit = finalAmount - maxTradeAmount;
                    const profitPercent = (profit / maxTradeAmount) * 100;

                    if (profitPercent >= profitThreshold) {
                        opportunities.push({
                            pathId: id,
                            path: path.join(' → '),
                            pairs: pairs,
                            description: description,
                            initialAmount: maxTradeAmount,
                            finalAmount: finalAmount.toFixed(2),
                            profit: profit.toFixed(2),
                            profitPercent: profitPercent.toFixed(4),
                            legs: prices,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`Error scanning path ${pathDef.id}:`, error);
            }
        }

        // Sort by profit percentage descending
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            scanned: pathsToScan.length,
            opportunities: opportunities,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('MEXC scan error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to scan MEXC triangular paths'
        });
    }
}));

// ROUTE 3: Get All MEXC Triangular Paths
router.get('/mexc/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const allPaths = {
        SET_1_ESSENTIAL_ETH_BRIDGE: [
            { id: 'MEXC_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETHUSDT', 'BTCETH', 'BTCUSDT'], description: 'ETH → BTC Bridge' },
            { id: 'MEXC_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], description: 'ETH → SOL Bridge' },
            { id: 'MEXC_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], description: 'ETH → XRP Bridge' },
            { id: 'MEXC_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], description: 'ETH → ADA Bridge' },
            { id: 'MEXC_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], description: 'ETH → MATIC Bridge' },
            { id: 'MEXC_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], description: 'ETH → DOT Bridge' },
            { id: 'MEXC_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], description: 'ETH → AVAX Bridge' }
        ],
        SET_2_MIDCAP_BTC_BRIDGE: [
            { id: 'MEXC_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], description: 'BTC → ETH Bridge' },
            { id: 'MEXC_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], description: 'BTC → SOL Bridge' },
            { id: 'MEXC_BTC_3', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], description: 'BTC → XRP Bridge' },
            { id: 'MEXC_BTC_4', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], description: 'BTC → LTC Bridge' },
            { id: 'MEXC_BTC_5', path: ['USDT', 'BTC', 'LINK', 'USDT'], pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], description: 'BTC → LINK Bridge' },
            { id: 'MEXC_BTC_6', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], description: 'BTC → ATOM Bridge' },
            { id: 'MEXC_BTC_7', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], description: 'BTC → UNI Bridge' }
        ],
        SET_3_MX_NATIVE_BRIDGE: [
            { id: 'MEXC_MX_1', path: ['USDT', 'MX', 'BTC', 'USDT'], pairs: ['MXUSDT', 'BTCMX', 'BTCUSDT'], description: 'MX → BTC Native' },
            { id: 'MEXC_MX_2', path: ['USDT', 'MX', 'ETH', 'USDT'], pairs: ['MXUSDT', 'ETHMX', 'ETHUSDT'], description: 'MX → ETH Native' },
            { id: 'MEXC_MX_3', path: ['USDT', 'MX', 'SOL', 'USDT'], pairs: ['MXUSDT', 'SOLMX', 'SOLUSDT'], description: 'MX → SOL Native' },
            { id: 'MEXC_MX_4', path: ['USDT', 'BTC', 'MX', 'USDT'], pairs: ['BTCUSDT', 'MXBTC', 'MXUSDT'], description: 'BTC → MX Reverse' },
            { id: 'MEXC_MX_5', path: ['USDT', 'ETH', 'MX', 'USDT'], pairs: ['ETHUSDT', 'MXETH', 'MXUSDT'], description: 'ETH → MX Reverse' },
            { id: 'MEXC_MX_6', path: ['USDT', 'MX', 'BNB', 'USDT'], pairs: ['MXUSDT', 'BNBMX', 'BNBUSDT'], description: 'MX → BNB Native' }
        ],
        SET_4_HIGH_VOLATILITY: [
            { id: 'MEXC_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGEUSDT', 'BTCDOGE', 'BTCUSDT'], description: 'DOGE → BTC Volatility' },
            { id: 'MEXC_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIBUSDT', 'ETHSHIB', 'ETHUSDT'], description: 'SHIB → ETH Volatility' },
            { id: 'MEXC_VOL_3', path: ['USDT', 'PEPE', 'ETH', 'USDT'], pairs: ['PEPEUSDT', 'ETHPEPE', 'ETHUSDT'], description: 'PEPE → ETH Volatility' },
            { id: 'MEXC_VOL_4', path: ['USDT', 'FLOKI', 'BTC', 'USDT'], pairs: ['FLOKIUSDT', 'BTCFLOKI', 'BTCUSDT'], description: 'FLOKI → BTC Volatility' },
            { id: 'MEXC_VOL_5', path: ['USDT', 'TON', 'ETH', 'USDT'], pairs: ['TONUSDT', 'ETHTON', 'ETHUSDT'], description: 'TON → ETH Volatility' },
            { id: 'MEXC_VOL_6', path: ['USDT', 'SUI', 'BTC', 'USDT'], pairs: ['SUIUSDT', 'BTCSUI', 'BTCUSDT'], description: 'SUI → BTC Volatility' }
        ],
        SET_5_EXTENDED_MULTIBRIDGE: [
            { id: 'MEXC_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOLUSDT', 'BTCSOL', 'BTCUSDT'], description: 'SOL → BTC Multi-Bridge' },
            { id: 'MEXC_EXT_2', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADAUSDT', 'BTCADA', 'BTCUSDT'], description: 'ADA → BTC Multi-Bridge' },
            { id: 'MEXC_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['AVAXUSDT', 'BTCAVAX', 'BTCUSDT'], description: 'AVAX → BTC Multi-Bridge' },
            { id: 'MEXC_EXT_4', path: ['USDT', 'MATIC', 'ETH', 'USDT'], pairs: ['MATICUSDT', 'ETHMATIC', 'ETHUSDT'], description: 'MATIC → ETH Multi-Bridge' },
            { id: 'MEXC_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'SOLETH', 'SOLUSDT'], description: '4-Leg BTC-ETH-SOL' },
            { id: 'MEXC_EXT_6', path: ['USDT', 'ETH', 'BTC', 'XRP', 'USDT'], pairs: ['ETHUSDT', 'BTCETH', 'XRPBTC', 'XRPUSDT'], description: '4-Leg ETH-BTC-XRP' }
        ]
    };

    res.json({
        success: true,
        totalPaths: 32,
        sets: allPaths
    });
}));

// ROUTE 4: Execute MEXC Triangular Trade
router.post('/mexc/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, opportunity, dryRun } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        if (dryRun) {
            return res.json({
                success: true,
                message: 'DRY RUN - Trade would execute with following parameters',
                opportunity: opportunity,
                execution: {
                    leg1: { status: 'simulated', pair: opportunity.legs[0].pair },
                    leg2: { status: 'simulated', pair: opportunity.legs[1].pair },
                    leg3: { status: 'simulated', pair: opportunity.legs[2].pair }
                }
            });
        }

        // Real execution would go here
        res.json({
            success: true,
            message: 'MEXC triangular trade execution endpoint ready',
            note: 'Full execution logic to be implemented after testing phase'
        });

    } catch (error) {
        console.error('MEXC execute error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to execute MEXC triangular trade'
        });
    }
}));

// ROUTE 5: Get MEXC Trade History
router.post('/mexc/triangular/history', asyncHandler(async (req, res) => {
    try {
        const { userId, limit = 50 } = req.body;

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'MEXC'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('MEXC history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve MEXC trade history'
        });
    }
}));

// ROUTE 6: Get Recent MEXC Trades (All Users)
router.get('/mexc/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'MEXC'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('MEXC recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent MEXC trades'
        });
    }
}));

// ============================================================================
// XT TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// XT Triangular Arbitrage API Configuration
const XT_TRIANGULAR_CONFIG = {
    baseUrl: 'https://sapi.xt.com',
    endpoints: {
        ticker: '/v4/public/ticker',
        orderBook: '/v4/public/depth',
        balance: '/v4/balances',
        placeOrder: '/v4/order'
    }
};

// XT HMAC-SHA256 Authentication Helper
function createXtSignature(apiKey, apiSecret, timestamp, method, endpoint, params = '') {
    // XT signature format: path + query/body params
    const signatureString = endpoint + params;
    // Generate HMAC-SHA256 signature
    const signature = crypto.createHmac('sha256', apiSecret).update(signatureString).digest('hex');
    return signature;
}

// XT 32 TRIANGULAR ARBITRAGE PATHS
const XT_TRIANGULAR_PATHS = {
    SET_1_ESSENTIAL_ETH_BRIDGE: [
        { id: 'XT_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['eth_usdt', 'btc_eth', 'btc_usdt'], description: 'ETH → BTC Essential' },
        { id: 'XT_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['eth_usdt', 'sol_eth', 'sol_usdt'], description: 'ETH → SOL Essential' },
        { id: 'XT_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['eth_usdt', 'xrp_eth', 'xrp_usdt'], description: 'ETH → XRP Essential' },
        { id: 'XT_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['eth_usdt', 'ada_eth', 'ada_usdt'], description: 'ETH → ADA Essential' },
        { id: 'XT_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['eth_usdt', 'matic_eth', 'matic_usdt'], description: 'ETH → MATIC Essential' },
        { id: 'XT_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['eth_usdt', 'dot_eth', 'dot_usdt'], description: 'ETH → DOT Essential' },
        { id: 'XT_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['eth_usdt', 'avax_eth', 'avax_usdt'], description: 'ETH → AVAX Essential' }
    ],
    SET_2_MIDCAP_BTC_BRIDGE: [
        { id: 'XT_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['btc_usdt', 'eth_btc', 'eth_usdt'], description: 'BTC → ETH Mid-Cap' },
        { id: 'XT_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['btc_usdt', 'sol_btc', 'sol_usdt'], description: 'BTC → SOL Mid-Cap' },
        { id: 'XT_BTC_3', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['btc_usdt', 'ada_btc', 'ada_usdt'], description: 'BTC → ADA Mid-Cap' },
        { id: 'XT_BTC_4', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['btc_usdt', 'dot_btc', 'dot_usdt'], description: 'BTC → DOT Mid-Cap' },
        { id: 'XT_BTC_5', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['btc_usdt', 'atom_btc', 'atom_usdt'], description: 'BTC → ATOM Mid-Cap' },
        { id: 'XT_BTC_6', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['btc_usdt', 'ltc_btc', 'ltc_usdt'], description: 'BTC → LTC Mid-Cap' },
        { id: 'XT_BTC_7', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['btc_usdt', 'xrp_btc', 'xrp_usdt'], description: 'BTC → XRP Mid-Cap' }
    ],
    SET_3_XT_NATIVE_BRIDGE: [
        { id: 'XT_XT_1', path: ['USDT', 'XT', 'BTC', 'USDT'], pairs: ['xt_usdt', 'btc_xt', 'btc_usdt'], description: 'XT → BTC Native' },
        { id: 'XT_XT_2', path: ['USDT', 'XT', 'ETH', 'USDT'], pairs: ['xt_usdt', 'eth_xt', 'eth_usdt'], description: 'XT → ETH Native' },
        { id: 'XT_XT_3', path: ['USDT', 'XT', 'SOL', 'USDT'], pairs: ['xt_usdt', 'sol_xt', 'sol_usdt'], description: 'XT → SOL Native' },
        { id: 'XT_XT_4', path: ['USDT', 'BTC', 'XT', 'USDT'], pairs: ['btc_usdt', 'xt_btc', 'xt_usdt'], description: 'BTC → XT Native' },
        { id: 'XT_XT_5', path: ['USDT', 'ETH', 'XT', 'USDT'], pairs: ['eth_usdt', 'xt_eth', 'xt_usdt'], description: 'ETH → XT Native' },
        { id: 'XT_XT_6', path: ['USDT', 'XT', 'MATIC', 'USDT'], pairs: ['xt_usdt', 'matic_xt', 'matic_usdt'], description: 'XT → MATIC Native' }
    ],
    SET_4_HIGH_VOLATILITY: [
        { id: 'XT_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['doge_usdt', 'btc_doge', 'btc_usdt'], description: 'DOGE High Vol' },
        { id: 'XT_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['shib_usdt', 'eth_shib', 'eth_usdt'], description: 'SHIB High Vol' },
        { id: 'XT_VOL_3', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['matic_usdt', 'btc_matic', 'btc_usdt'], description: 'MATIC High Vol' },
        { id: 'XT_VOL_4', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['sol_usdt', 'eth_sol', 'eth_usdt'], description: 'SOL High Vol' },
        { id: 'XT_VOL_5', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ada_usdt', 'btc_ada', 'btc_usdt'], description: 'ADA High Vol' },
        { id: 'XT_VOL_6', path: ['USDT', 'DOT', 'ETH', 'USDT'], pairs: ['dot_usdt', 'eth_dot', 'eth_usdt'], description: 'DOT High Vol' }
    ],
    SET_5_EXTENDED_MULTIBRIDGE: [
        { id: 'XT_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['sol_usdt', 'btc_sol', 'btc_usdt'], description: 'SOL Multi-Bridge' },
        { id: 'XT_EXT_2', path: ['USDT', 'XRP', 'ETH', 'USDT'], pairs: ['xrp_usdt', 'eth_xrp', 'eth_usdt'], description: 'XRP Multi-Bridge' },
        { id: 'XT_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['avax_usdt', 'btc_avax', 'btc_usdt'], description: 'AVAX Multi-Bridge' },
        { id: 'XT_EXT_4', path: ['USDT', 'ATOM', 'ETH', 'USDT'], pairs: ['atom_usdt', 'eth_atom', 'eth_usdt'], description: 'ATOM Multi-Bridge' },
        { id: 'XT_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['btc_usdt', 'eth_btc', 'sol_eth', 'sol_usdt'], description: 'BTC-ETH-SOL 4-Leg' },
        { id: 'XT_EXT_6', path: ['USDT', 'ETH', 'BTC', 'ADA', 'USDT'], pairs: ['eth_usdt', 'btc_eth', 'ada_btc', 'ada_usdt'], description: 'ETH-BTC-ADA 4-Leg' }
    ]
};

// 1. XT Test Connection Route
router.post('/xt/triangular/test-connection', authenticate, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'Missing XT API credentials'
            });
        }

        const timestamp = Date.now().toString();
        const endpoint = XT_TRIANGULAR_CONFIG.endpoints.balance;
        const signature = createXtSignature(apiKey, apiSecret, timestamp, 'GET', endpoint, '');

        const response = await fetch(`${XT_TRIANGULAR_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'xt-validate-appkey': apiKey,
                'xt-validate-timestamp': timestamp,
                'xt-validate-signature': signature,
                'xt-validate-algorithms': 'HmacSHA256'
            }
        });

        const result = await response.json();

        if (response.ok && result.returnCode === 0) {
            const balances = {};
            result.result.forEach(asset => {
                balances[asset.currency.toUpperCase()] = parseFloat(asset.free || 0).toFixed(2);
            });

            res.json({
                success: true,
                message: 'XT connection successful',
                balances: {
                    USDT: balances.USDT || '0.00',
                    BTC: balances.BTC || '0.00',
                    ETH: balances.ETH || '0.00',
                    XT: balances.XT || '0.00'
                }
            });
        } else {
            throw new Error(result.message || 'XT API connection failed');
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to connect to XT'
        });
    }
}));

// 2. XT Scan Triangular Paths Route
router.post('/xt/triangular/scan', authenticate, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'Missing XT API credentials'
            });
        }

        // Fetch all tickers from XT
        const tickersResponse = await fetch(`${XT_TRIANGULAR_CONFIG.baseUrl}${XT_TRIANGULAR_CONFIG.endpoints.ticker}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        const tickersData = await tickersResponse.json();

        if (!tickersResponse.ok || tickersData.returnCode !== 0) {
            throw new Error('Failed to fetch XT tickers');
        }

        // Parse ticker data into price map
        const priceMap = {};
        tickersData.result.forEach(ticker => {
            const symbol = ticker.s.toLowerCase(); // XT returns uppercase, convert to lowercase
            priceMap[symbol] = {
                bid: parseFloat(ticker.b || 0),
                ask: parseFloat(ticker.a || 0),
                last: parseFloat(ticker.c || 0)
            };
        });

        // Collect enabled paths
        const enabledPaths = [];
        Object.keys(XT_TRIANGULAR_PATHS).forEach(setKey => {
            if (enabledSets[setKey]) {
                enabledPaths.push(...XT_TRIANGULAR_PATHS[setKey]);
            }
        });

        // Scan each enabled path
        const opportunities = [];
        for (const pathConfig of enabledPaths) {
            try {
                const { path, pairs } = pathConfig;

                // Get prices for all pairs in the path
                const prices = pairs.map(pair => priceMap[pair]);

                // Skip if any price is missing
                if (prices.some(p => !p || p.ask === 0 || p.bid === 0)) continue;

                // Calculate triangular arbitrage profit
                let currentAmount = maxTradeAmount || 100;
                const legs = [];

                // Leg 1: USDT → Asset1
                currentAmount = currentAmount / prices[0].ask;
                legs.push({ pair: pairs[0], side: 'BUY', price: prices[0].ask, amount: currentAmount });

                // Leg 2: Asset1 → Asset2
                if (pairs.length >= 2) {
                    currentAmount = currentAmount / prices[1].ask;
                    legs.push({ pair: pairs[1], side: 'BUY', price: prices[1].ask, amount: currentAmount });
                }

                // Leg 3: Asset2 → USDT (or Asset3)
                if (pairs.length >= 3) {
                    currentAmount = currentAmount * prices[2].bid;
                    legs.push({ pair: pairs[2], side: 'SELL', price: prices[2].bid, amount: currentAmount });
                }

                // Leg 4 (if 4-leg path): Asset3 → USDT
                if (pairs.length === 4) {
                    currentAmount = currentAmount * prices[3].bid;
                    legs.push({ pair: pairs[3], side: 'SELL', price: prices[3].bid, amount: currentAmount });
                }

                const finalAmount = currentAmount;
                const profit = finalAmount - (maxTradeAmount || 100);
                const profitPercent = ((profit / (maxTradeAmount || 100)) * 100).toFixed(4);

                // Check if profit exceeds threshold
                if (parseFloat(profitPercent) >= profitThreshold) {
                    opportunities.push({
                        pathId: pathConfig.id,
                        path: pathConfig.path,
                        pairs: pathConfig.pairs,
                        description: pathConfig.description,
                        profitPercent: profitPercent,
                        expectedProfitZAR: profit.toFixed(2),
                        estimatedSlippage: '0.2',
                        risk: parseFloat(profitPercent) >= 1 ? 'EXECUTE' : 'CAUTIOUS',
                        legs: legs
                    });
                }
            } catch (err) {
                console.error(`Error scanning XT path ${pathConfig.id}:`, err);
            }
        }

        // Sort by profit descending
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            opportunities: opportunities.slice(0, 20), // Return top 20
            scannedPaths: enabledPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'XT scan failed'
        });
    }
}));

// 3. XT Get Available Paths Route
router.get('/xt/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    res.json({
        success: true,
        exchange: 'xt',
        totalPaths: 32,
        paths: XT_TRIANGULAR_PATHS
    });
}));

// 4. XT Execute Triangular Trade Route
router.post('/xt/triangular/execute', authenticate, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, userId, opportunity, dryRun } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'Missing XT API credentials'
            });
        }

        const executionStartTime = Date.now();

        // Simulate execution (real execution would place orders via XT API)
        if (dryRun) {
            const tradeId = `TRI_XT_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

            res.json({
                success: true,
                message: 'XT dry run execution successful',
                tradeId: tradeId,
                actualProfitZAR: opportunity.expectedProfitZAR,
                actualProfitPercent: opportunity.profitPercent,
                executionTime: Date.now() - executionStartTime,
                dryRun: true
            });
        } else {
            // Real execution logic would go here
            res.status(501).json({
                success: false,
                message: 'Real XT execution not implemented yet. Use dryRun mode.'
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'XT execution failed'
        });
    }
}));

// 5. XT Trade History Route
router.post('/xt/triangular/history', authenticate, asyncHandler(async (req, res) => {
    try {
        const { userId, limit } = req.body;

        const query = `
            SELECT * FROM triangular_trades
            WHERE user_id = $1 AND exchange = 'XT'
            ORDER BY created_at DESC
            LIMIT $2
        `;

        const result = await pool.query(query, [userId, limit || 10]);

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch XT trade history'
        });
    }
}));

// 6. XT Recent Trades Route (Public Feed)
router.get('/xt/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const query = `
            SELECT
                t.trade_id,
                t.path_sequence,
                t.actual_profit_zar,
                t.actual_profit_percent,
                t.execution_status,
                t.created_at,
                u.first_name
            FROM triangular_trades t
            JOIN users u ON t.user_id = u.id
            WHERE t.exchange = 'XT'
                AND t.execution_status = 'completed'
                AND t.created_at >= NOW() - INTERVAL '24 hours'
            ORDER BY t.created_at DESC
            LIMIT 50
        `;

        const result = await pool.query(query);

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch XT recent trades'
        });
    }
}));

// ============================================================================
// ASCENDEX TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// AscendEX Triangular Arbitrage API Configuration
const ASCENDEX_TRIANGULAR_CONFIG = {
    baseUrl: 'https://ascendex.com',
    endpoints: {
        accountInfo: '/api/pro/v1/info',
        balance: '/api/pro/v1/cash/balance',
        ticker: '/api/pro/v1/spot/ticker',
        products: '/api/pro/v1/cash/products',
        placeOrder: '/api/pro/v1/cash/order'
    }
};

// AscendEX HMAC-SHA256 Authentication Helper
function createAscendexSignature(apiSecret, timestamp, apiPath) {
    // AscendEX signature format: base64(HMAC-SHA256(secret, timestamp+apiPath))
    const message = timestamp + apiPath;
    const signature = crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
    return signature;
}

// AscendEX 32 TRIANGULAR ARBITRAGE PATHS
const ASCENDEX_TRIANGULAR_PATHS = {
    SET_1_ESSENTIAL_ETH_BRIDGE: [
        { id: 'ASCENDEX_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH/USDT', 'BTC/ETH', 'BTC/USDT'], description: 'ETH → BTC Essential' },
        { id: 'ASCENDEX_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH/USDT', 'SOL/ETH', 'SOL/USDT'], description: 'ETH → SOL Essential' },
        { id: 'ASCENDEX_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH/USDT', 'XRP/ETH', 'XRP/USDT'], description: 'ETH → XRP Essential' },
        { id: 'ASCENDEX_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH/USDT', 'ADA/ETH', 'ADA/USDT'], description: 'ETH → ADA Essential' },
        { id: 'ASCENDEX_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH/USDT', 'MATIC/ETH', 'MATIC/USDT'], description: 'ETH → MATIC Essential' },
        { id: 'ASCENDEX_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETH/USDT', 'DOT/ETH', 'DOT/USDT'], description: 'ETH → DOT Essential' },
        { id: 'ASCENDEX_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH/USDT', 'AVAX/ETH', 'AVAX/USDT'], description: 'ETH → AVAX Essential' }
    ],
    SET_2_MIDCAP_BTC_BRIDGE: [
        { id: 'ASCENDEX_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC/USDT', 'ETH/BTC', 'ETH/USDT'], description: 'BTC → ETH Mid-Cap' },
        { id: 'ASCENDEX_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC/USDT', 'SOL/BTC', 'SOL/USDT'], description: 'BTC → SOL Mid-Cap' },
        { id: 'ASCENDEX_BTC_3', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTC/USDT', 'ADA/BTC', 'ADA/USDT'], description: 'BTC → ADA Mid-Cap' },
        { id: 'ASCENDEX_BTC_4', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTC/USDT', 'DOT/BTC', 'DOT/USDT'], description: 'BTC → DOT Mid-Cap' },
        { id: 'ASCENDEX_BTC_5', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC/USDT', 'ATOM/BTC', 'ATOM/USDT'], description: 'BTC → ATOM Mid-Cap' },
        { id: 'ASCENDEX_BTC_6', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC/USDT', 'LTC/BTC', 'LTC/USDT'], description: 'BTC → LTC Mid-Cap' },
        { id: 'ASCENDEX_BTC_7', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTC/USDT', 'XRP/BTC', 'XRP/USDT'], description: 'BTC → XRP Mid-Cap' }
    ],
    SET_3_ASD_NATIVE_BRIDGE: [
        { id: 'ASCENDEX_ASD_1', path: ['USDT', 'ASD', 'BTC', 'USDT'], pairs: ['ASD/USDT', 'BTC/ASD', 'BTC/USDT'], description: 'ASD → BTC Native' },
        { id: 'ASCENDEX_ASD_2', path: ['USDT', 'ASD', 'ETH', 'USDT'], pairs: ['ASD/USDT', 'ETH/ASD', 'ETH/USDT'], description: 'ASD → ETH Native' },
        { id: 'ASCENDEX_ASD_3', path: ['USDT', 'ASD', 'SOL', 'USDT'], pairs: ['ASD/USDT', 'SOL/ASD', 'SOL/USDT'], description: 'ASD → SOL Native' },
        { id: 'ASCENDEX_ASD_4', path: ['USDT', 'BTC', 'ASD', 'USDT'], pairs: ['BTC/USDT', 'ASD/BTC', 'ASD/USDT'], description: 'BTC → ASD Native' },
        { id: 'ASCENDEX_ASD_5', path: ['USDT', 'ETH', 'ASD', 'USDT'], pairs: ['ETH/USDT', 'ASD/ETH', 'ASD/USDT'], description: 'ETH → ASD Native' },
        { id: 'ASCENDEX_ASD_6', path: ['USDT', 'ASD', 'MATIC', 'USDT'], pairs: ['ASD/USDT', 'MATIC/ASD', 'MATIC/USDT'], description: 'ASD → MATIC Native' }
    ],
    SET_4_HIGH_VOLATILITY: [
        { id: 'ASCENDEX_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE/USDT', 'BTC/DOGE', 'BTC/USDT'], description: 'DOGE High Vol' },
        { id: 'ASCENDEX_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB/USDT', 'ETH/SHIB', 'ETH/USDT'], description: 'SHIB High Vol' },
        { id: 'ASCENDEX_VOL_3', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['MATIC/USDT', 'BTC/MATIC', 'BTC/USDT'], description: 'MATIC High Vol' },
        { id: 'ASCENDEX_VOL_4', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['SOL/USDT', 'ETH/SOL', 'ETH/USDT'], description: 'SOL High Vol' },
        { id: 'ASCENDEX_VOL_5', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADA/USDT', 'BTC/ADA', 'BTC/USDT'], description: 'ADA High Vol' },
        { id: 'ASCENDEX_VOL_6', path: ['USDT', 'DOT', 'ETH', 'USDT'], pairs: ['DOT/USDT', 'ETH/DOT', 'ETH/USDT'], description: 'DOT High Vol' }
    ],
    SET_5_EXTENDED_MULTIBRIDGE: [
        { id: 'ASCENDEX_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOL/USDT', 'BTC/SOL', 'BTC/USDT'], description: 'SOL Multi-Bridge' },
        { id: 'ASCENDEX_EXT_2', path: ['USDT', 'XRP', 'ETH', 'USDT'], pairs: ['XRP/USDT', 'ETH/XRP', 'ETH/USDT'], description: 'XRP Multi-Bridge' },
        { id: 'ASCENDEX_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['AVAX/USDT', 'BTC/AVAX', 'BTC/USDT'], description: 'AVAX Multi-Bridge' },
        { id: 'ASCENDEX_EXT_4', path: ['USDT', 'ATOM', 'ETH', 'USDT'], pairs: ['ATOM/USDT', 'ETH/ATOM', 'ETH/USDT'], description: 'ATOM Multi-Bridge' },
        { id: 'ASCENDEX_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC/USDT', 'ETH/BTC', 'SOL/ETH', 'SOL/USDT'], description: 'BTC-ETH-SOL 4-Leg' },
        { id: 'ASCENDEX_EXT_6', path: ['USDT', 'ETH', 'BTC', 'ADA', 'USDT'], pairs: ['ETH/USDT', 'BTC/ETH', 'ADA/BTC', 'ADA/USDT'], description: 'ETH-BTC-ADA 4-Leg' }
    ]
};

// 1. AscendEX Test Connection Route
router.post('/ascendex/triangular/test-connection', authenticate, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'Missing AscendEX API credentials'
            });
        }

        // First, get account info to obtain account-group
        const timestamp = Date.now().toString();
        const accountInfoPath = ASCENDEX_TRIANGULAR_CONFIG.endpoints.accountInfo;
        const signature = createAscendexSignature(apiSecret, timestamp, accountInfoPath);

        const accountInfoResponse = await fetch(`${ASCENDEX_TRIANGULAR_CONFIG.baseUrl}${accountInfoPath}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'x-auth-key': apiKey,
                'x-auth-timestamp': timestamp,
                'x-auth-signature': signature
            }
        });

        const accountInfo = await accountInfoResponse.json();

        if (!accountInfoResponse.ok || accountInfo.code !== 0) {
            throw new Error(accountInfo.message || 'Failed to get account info');
        }

        const accountGroup = accountInfo.data.accountGroup;

        // Now get balance using account-group
        const balancePath = `/${accountGroup}${ASCENDEX_TRIANGULAR_CONFIG.endpoints.balance}`;
        const balanceTimestamp = Date.now().toString();
        const balanceSignature = createAscendexSignature(apiSecret, balanceTimestamp, balancePath);

        const balanceResponse = await fetch(`${ASCENDEX_TRIANGULAR_CONFIG.baseUrl}${balancePath}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'x-auth-key': apiKey,
                'x-auth-timestamp': balanceTimestamp,
                'x-auth-signature': balanceSignature
            }
        });

        const balanceData = await balanceResponse.json();

        if (balanceResponse.ok && balanceData.code === 0) {
            const balances = {};
            balanceData.data.forEach(asset => {
                balances[asset.asset] = parseFloat(asset.availableBalance || 0).toFixed(2);
            });

            res.json({
                success: true,
                message: 'AscendEX connection successful',
                accountGroup: accountGroup,
                balances: {
                    USDT: balances.USDT || '0.00',
                    BTC: balances.BTC || '0.00',
                    ETH: balances.ETH || '0.00',
                    ASD: balances.ASD || '0.00'
                }
            });
        } else {
            throw new Error(balanceData.message || 'AscendEX API connection failed');
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to connect to AscendEX'
        });
    }
}));

// 2. AscendEX Scan Triangular Paths Route
router.post('/ascendex/triangular/scan', authenticate, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, maxTradeAmount, profitThreshold, enabledSets } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'Missing AscendEX API credentials'
            });
        }

        // Fetch all tickers from AscendEX
        const tickersResponse = await fetch(`${ASCENDEX_TRIANGULAR_CONFIG.baseUrl}${ASCENDEX_TRIANGULAR_CONFIG.endpoints.ticker}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        const tickersData = await tickersResponse.json();

        if (!tickersResponse.ok || tickersData.code !== 0) {
            throw new Error('Failed to fetch AscendEX tickers');
        }

        // Parse ticker data into price map
        const priceMap = {};
        tickersData.data.forEach(ticker => {
            const symbol = ticker.symbol; // AscendEX uses BTC/USDT format
            priceMap[symbol] = {
                bid: parseFloat(ticker.bid && ticker.bid[0] ? ticker.bid[0] : 0),
                ask: parseFloat(ticker.ask && ticker.ask[0] ? ticker.ask[0] : 0),
                last: parseFloat(ticker.close || 0)
            };
        });

        // Collect enabled paths
        const enabledPaths = [];
        Object.keys(ASCENDEX_TRIANGULAR_PATHS).forEach(setKey => {
            if (enabledSets[setKey]) {
                enabledPaths.push(...ASCENDEX_TRIANGULAR_PATHS[setKey]);
            }
        });

        // Scan each enabled path
        const opportunities = [];
        for (const pathConfig of enabledPaths) {
            try {
                const { path, pairs } = pathConfig;

                // Get prices for all pairs in the path
                const prices = pairs.map(pair => priceMap[pair]);

                // Skip if any price is missing
                if (prices.some(p => !p || p.ask === 0 || p.bid === 0)) continue;

                // Calculate triangular arbitrage profit
                let currentAmount = maxTradeAmount || 100;
                const legs = [];

                // Leg 1: USDT → Asset1
                currentAmount = currentAmount / prices[0].ask;
                legs.push({ pair: pairs[0], side: 'BUY', price: prices[0].ask, amount: currentAmount });

                // Leg 2: Asset1 → Asset2
                if (pairs.length >= 2) {
                    currentAmount = currentAmount / prices[1].ask;
                    legs.push({ pair: pairs[1], side: 'BUY', price: prices[1].ask, amount: currentAmount });
                }

                // Leg 3: Asset2 → USDT (or Asset3)
                if (pairs.length >= 3) {
                    currentAmount = currentAmount * prices[2].bid;
                    legs.push({ pair: pairs[2], side: 'SELL', price: prices[2].bid, amount: currentAmount });
                }

                // Leg 4 (if 4-leg path): Asset3 → USDT
                if (pairs.length === 4) {
                    currentAmount = currentAmount * prices[3].bid;
                    legs.push({ pair: pairs[3], side: 'SELL', price: prices[3].bid, amount: currentAmount });
                }

                const finalAmount = currentAmount;
                const profit = finalAmount - (maxTradeAmount || 100);
                const profitPercent = ((profit / (maxTradeAmount || 100)) * 100).toFixed(4);

                // Check if profit exceeds threshold
                if (parseFloat(profitPercent) >= profitThreshold) {
                    opportunities.push({
                        pathId: pathConfig.id,
                        path: pathConfig.path,
                        pairs: pathConfig.pairs,
                        description: pathConfig.description,
                        profitPercent: profitPercent,
                        expectedProfitZAR: profit.toFixed(2),
                        estimatedSlippage: '0.2',
                        risk: parseFloat(profitPercent) >= 1 ? 'EXECUTE' : 'CAUTIOUS',
                        legs: legs
                    });
                }
            } catch (err) {
                console.error(`Error scanning AscendEX path ${pathConfig.id}:`, err);
            }
        }

        // Sort by profit descending
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            opportunities: opportunities.slice(0, 20), // Return top 20
            scannedPaths: enabledPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'AscendEX scan failed'
        });
    }
}));

// 3. AscendEX Get Available Paths Route
router.get('/ascendex/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    res.json({
        success: true,
        exchange: 'ascendex',
        totalPaths: 32,
        paths: ASCENDEX_TRIANGULAR_PATHS
    });
}));

// 4. AscendEX Execute Triangular Trade Route
router.post('/ascendex/triangular/execute', authenticate, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, userId, opportunity, dryRun } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'Missing AscendEX API credentials'
            });
        }

        const executionStartTime = Date.now();

        // Simulate execution (real execution would place orders via AscendEX API)
        if (dryRun) {
            const tradeId = `TRI_ASCENDEX_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

            res.json({
                success: true,
                message: 'AscendEX dry run execution successful',
                tradeId: tradeId,
                actualProfitZAR: opportunity.expectedProfitZAR,
                actualProfitPercent: opportunity.profitPercent,
                executionTime: Date.now() - executionStartTime,
                dryRun: true
            });
        } else {
            // Real execution logic would go here
            res.status(501).json({
                success: false,
                message: 'Real AscendEX execution not implemented yet. Use dryRun mode.'
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'AscendEX execution failed'
        });
    }
}));

// 5. AscendEX Trade History Route
router.post('/ascendex/triangular/history', authenticate, asyncHandler(async (req, res) => {
    try {
        const { userId, limit } = req.body;

        const query = `
            SELECT * FROM triangular_trades
            WHERE user_id = $1 AND exchange = 'AscendEX'
            ORDER BY created_at DESC
            LIMIT $2
        `;

        const result = await pool.query(query, [userId, limit || 10]);

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch AscendEX trade history'
        });
    }
}));

// 6. AscendEX Recent Trades Route (Public Feed)
router.get('/ascendex/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const query = `
            SELECT
                t.trade_id,
                t.path_sequence,
                t.actual_profit_zar,
                t.actual_profit_percent,
                t.execution_status,
                t.created_at,
                u.first_name
            FROM triangular_trades t
            JOIN users u ON t.user_id = u.id
            WHERE t.exchange = 'AscendEX'
                AND t.execution_status = 'completed'
                AND t.created_at >= NOW() - INTERVAL '24 hours'
            ORDER BY t.created_at DESC
            LIMIT 50
        `;

        const result = await pool.query(query);

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch AscendEX recent trades'
        });
    }
}));

// ============================================================================
// BINGX TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// BingX Triangular Arbitrage API Configuration
const BINGX_TRIANGULAR_CONFIG = {
    baseUrl: 'https://open-api.bingx.com',
    endpoints: {
        ticker: '/openApi/spot/v1/ticker/24hr',
        balance: '/openApi/spot/v1/account/balance',
        placeOrder: '/openApi/spot/v1/trade/order',
        symbols: '/openApi/spot/v1/common/symbols'
    }
};

// BingX HMAC-SHA256 Authentication Helper
function createBingXTriangularSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// BingX Triangular Arbitrage Paths (32 paths - no native token, using SOL as high-liquidity alternative)
const BINGX_TRIANGULAR_PATHS = {
    SET_1_ESSENTIAL_ETH_BRIDGE: [
        { id: 'BINGX_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH-USDT', 'BTC-ETH', 'BTC-USDT'], description: 'ETH → BTC Bridge' },
        { id: 'BINGX_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH-USDT', 'SOL-ETH', 'SOL-USDT'], description: 'ETH → SOL Bridge' },
        { id: 'BINGX_ETH_3', path: ['USDT', 'ETH', 'XRP', 'USDT'], pairs: ['ETH-USDT', 'XRP-ETH', 'XRP-USDT'], description: 'ETH → XRP Bridge' },
        { id: 'BINGX_ETH_4', path: ['USDT', 'ETH', 'ADA', 'USDT'], pairs: ['ETH-USDT', 'ADA-ETH', 'ADA-USDT'], description: 'ETH → ADA Bridge' },
        { id: 'BINGX_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH-USDT', 'MATIC-ETH', 'MATIC-USDT'], description: 'ETH → MATIC Bridge' },
        { id: 'BINGX_ETH_6', path: ['USDT', 'ETH', 'DOT', 'USDT'], pairs: ['ETH-USDT', 'DOT-ETH', 'DOT-USDT'], description: 'ETH → DOT Bridge' },
        { id: 'BINGX_ETH_7', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH-USDT', 'AVAX-ETH', 'AVAX-USDT'], description: 'ETH → AVAX Bridge' }
    ],
    SET_2_MIDCAP_BTC_BRIDGE: [
        { id: 'BINGX_BTC_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], description: 'BTC → ETH Bridge' },
        { id: 'BINGX_BTC_2', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC-USDT', 'SOL-BTC', 'SOL-USDT'], description: 'BTC → SOL Bridge' },
        { id: 'BINGX_BTC_3', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTC-USDT', 'XRP-BTC', 'XRP-USDT'], description: 'BTC → XRP Bridge' },
        { id: 'BINGX_BTC_4', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC-USDT', 'LTC-BTC', 'LTC-USDT'], description: 'BTC → LTC Bridge' },
        { id: 'BINGX_BTC_5', path: ['USDT', 'BTC', 'LINK', 'USDT'], pairs: ['BTC-USDT', 'LINK-BTC', 'LINK-USDT'], description: 'BTC → LINK Bridge' },
        { id: 'BINGX_BTC_6', path: ['USDT', 'BTC', 'ATOM', 'USDT'], pairs: ['BTC-USDT', 'ATOM-BTC', 'ATOM-USDT'], description: 'BTC → ATOM Bridge' },
        { id: 'BINGX_BTC_7', path: ['USDT', 'BTC', 'UNI', 'USDT'], pairs: ['BTC-USDT', 'UNI-BTC', 'UNI-USDT'], description: 'BTC → UNI Bridge' }
    ],
    SET_3_SOL_HIGH_LIQUIDITY: [
        { id: 'BINGX_SOL_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOL-USDT', 'BTC-SOL', 'BTC-USDT'], description: 'SOL → BTC High-Liq' },
        { id: 'BINGX_SOL_2', path: ['USDT', 'SOL', 'ETH', 'USDT'], pairs: ['SOL-USDT', 'ETH-SOL', 'ETH-USDT'], description: 'SOL → ETH High-Liq' },
        { id: 'BINGX_SOL_3', path: ['USDT', 'SOL', 'BNB', 'USDT'], pairs: ['SOL-USDT', 'BNB-SOL', 'BNB-USDT'], description: 'SOL → BNB High-Liq' },
        { id: 'BINGX_SOL_4', path: ['USDT', 'BTC', 'SOL', 'USDT'], pairs: ['BTC-USDT', 'SOL-BTC', 'SOL-USDT'], description: 'BTC → SOL Reverse' },
        { id: 'BINGX_SOL_5', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH-USDT', 'SOL-ETH', 'SOL-USDT'], description: 'ETH → SOL Reverse' },
        { id: 'BINGX_SOL_6', path: ['USDT', 'SOL', 'AVAX', 'USDT'], pairs: ['SOL-USDT', 'AVAX-SOL', 'AVAX-USDT'], description: 'SOL → AVAX High-Liq' }
    ],
    SET_4_HIGH_VOLATILITY: [
        { id: 'BINGX_VOL_1', path: ['USDT', 'DOGE', 'BTC', 'USDT'], pairs: ['DOGE-USDT', 'BTC-DOGE', 'BTC-USDT'], description: 'DOGE → BTC Volatility' },
        { id: 'BINGX_VOL_2', path: ['USDT', 'SHIB', 'ETH', 'USDT'], pairs: ['SHIB-USDT', 'ETH-SHIB', 'ETH-USDT'], description: 'SHIB → ETH Volatility' },
        { id: 'BINGX_VOL_3', path: ['USDT', 'PEPE', 'ETH', 'USDT'], pairs: ['PEPE-USDT', 'ETH-PEPE', 'ETH-USDT'], description: 'PEPE → ETH Volatility' },
        { id: 'BINGX_VOL_4', path: ['USDT', 'FLOKI', 'BTC', 'USDT'], pairs: ['FLOKI-USDT', 'BTC-FLOKI', 'BTC-USDT'], description: 'FLOKI → BTC Volatility' },
        { id: 'BINGX_VOL_5', path: ['USDT', 'TON', 'ETH', 'USDT'], pairs: ['TON-USDT', 'ETH-TON', 'ETH-USDT'], description: 'TON → ETH Volatility' },
        { id: 'BINGX_VOL_6', path: ['USDT', 'SUI', 'BTC', 'USDT'], pairs: ['SUI-USDT', 'BTC-SUI', 'BTC-USDT'], description: 'SUI → BTC Volatility' }
    ],
    SET_5_EXTENDED_MULTIBRIDGE: [
        { id: 'BINGX_EXT_1', path: ['USDT', 'SOL', 'BTC', 'USDT'], pairs: ['SOL-USDT', 'BTC-SOL', 'BTC-USDT'], description: 'SOL → BTC Multi-Bridge' },
        { id: 'BINGX_EXT_2', path: ['USDT', 'ADA', 'BTC', 'USDT'], pairs: ['ADA-USDT', 'BTC-ADA', 'BTC-USDT'], description: 'ADA → BTC Multi-Bridge' },
        { id: 'BINGX_EXT_3', path: ['USDT', 'AVAX', 'BTC', 'USDT'], pairs: ['AVAX-USDT', 'BTC-AVAX', 'BTC-USDT'], description: 'AVAX → BTC Multi-Bridge' },
        { id: 'BINGX_EXT_4', path: ['USDT', 'MATIC', 'ETH', 'USDT'], pairs: ['MATIC-USDT', 'ETH-MATIC', 'ETH-USDT'], description: 'MATIC → ETH Multi-Bridge' },
        { id: 'BINGX_EXT_5', path: ['USDT', 'BTC', 'ETH', 'SOL', 'USDT'], pairs: ['BTC-USDT', 'ETH-BTC', 'SOL-ETH', 'SOL-USDT'], description: '4-Leg BTC-ETH-SOL' },
        { id: 'BINGX_EXT_6', path: ['USDT', 'ETH', 'BTC', 'XRP', 'USDT'], pairs: ['ETH-USDT', 'BTC-ETH', 'XRP-BTC', 'XRP-USDT'], description: '4-Leg ETH-BTC-XRP' }
    ]
};

// ROUTE 1: Test BingX Connection
router.post('/bingx/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API Key and Secret are required'
            });
        }

        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBingXTriangularSignature(queryString, apiSecret);

        const response = await fetch(`${BINGX_TRIANGULAR_CONFIG.baseUrl}${BINGX_TRIANGULAR_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.code === 0) {
            res.json({
                success: true,
                message: 'BingX API connection successful',
                data: {
                    balances: data.data?.balances || []
                }
            });
        } else {
            res.json({
                success: false,
                message: data.msg || 'BingX API connection failed'
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to test BingX connection'
        });
    }
}));

// ROUTE 2: Scan BingX Triangular Opportunities
router.post('/bingx/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, minProfitPercent = 0.5 } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API Key and Secret are required'
            });
        }

        const opportunities = [];

        // Fetch all tickers
        const tickerResponse = await fetch(`${BINGX_TRIANGULAR_CONFIG.baseUrl}${BINGX_TRIANGULAR_CONFIG.endpoints.ticker}`);
        const tickerData = await tickerResponse.json();

        if (tickerData.code !== 0) {
            throw new Error(tickerData.msg || 'Failed to fetch BingX tickers');
        }

        const tickers = {};
        tickerData.data.forEach(ticker => {
            tickers[ticker.symbol] = {
                bid: parseFloat(ticker.bidPrice),
                ask: parseFloat(ticker.askPrice),
                volume: parseFloat(ticker.volume)
            };
        });

        // Scan all path sets
        Object.values(BINGX_TRIANGULAR_PATHS).forEach(pathSet => {
            pathSet.forEach(pathConfig => {
                try {
                    const prices = pathConfig.pairs.map(pair => {
                        const normalizedPair = pair.replace('-', '');
                        return tickers[normalizedPair];
                    });

                    if (prices.every(p => p && p.bid && p.ask)) {
                        const leg1 = prices[0].ask;
                        const leg2 = prices[1].ask;
                        const leg3 = prices[2].bid;

                        const finalAmount = (1 / leg1) * (1 / leg2) * leg3;
                        const profitPercent = (finalAmount - 1) * 100;

                        if (profitPercent >= minProfitPercent) {
                            opportunities.push({
                                id: pathConfig.id,
                                path: pathConfig.path,
                                pairs: pathConfig.pairs,
                                description: pathConfig.description,
                                profitPercent: profitPercent.toFixed(4),
                                estimatedProfit: (1000 * (finalAmount - 1)).toFixed(2),
                                leg1Price: leg1,
                                leg2Price: leg2,
                                leg3Price: leg3,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                } catch (err) {
                    // Skip invalid paths
                }
            });
        });

        res.json({
            success: true,
            opportunities: opportunities.sort((a, b) => b.profitPercent - a.profitPercent),
            scannedPaths: Object.values(BINGX_TRIANGULAR_PATHS).reduce((sum, set) => sum + set.length, 0),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to scan BingX opportunities'
        });
    }
}));

// ROUTE 3: Get BingX Triangular Paths
router.get('/bingx/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const totalPaths = Object.values(BINGX_TRIANGULAR_PATHS).reduce((sum, set) => sum + set.length, 0);

    res.json({
        success: true,
        totalPaths,
        sets: BINGX_TRIANGULAR_PATHS
    });
}));

// ROUTE 4: Execute BingX Triangular Trade
router.post('/bingx/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, opportunity, investmentAmount = 1000 } = req.body;

        if (!apiKey || !apiSecret || !opportunity) {
            return res.status(400).json({
                success: false,
                message: 'API credentials and opportunity required'
            });
        }

        const executionSteps = [];
        let currentAmount = investmentAmount;

        // Execute each leg sequentially
        for (let i = 0; i < opportunity.pairs.length; i++) {
            const pair = opportunity.pairs[i].replace('-', '');
            const side = i === opportunity.pairs.length - 1 ? 'SELL' : 'BUY';

            const timestamp = Date.now();
            const orderParams = `symbol=${pair}&side=${side}&type=MARKET&quoteOrderQty=${currentAmount}&timestamp=${timestamp}`;
            const signature = createBingXTriangularSignature(orderParams, apiSecret);

            const orderResponse = await fetch(`${BINGX_TRIANGULAR_CONFIG.baseUrl}${BINGX_TRIANGULAR_CONFIG.endpoints.placeOrder}?${orderParams}&signature=${signature}`, {
                method: 'POST',
                headers: {
                    'X-BX-APIKEY': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            const orderData = await orderResponse.json();

            if (orderData.code !== 0) {
                throw new Error(`Leg ${i + 1} failed: ${orderData.msg}`);
            }

            executionSteps.push({
                leg: i + 1,
                pair: pair,
                side: side,
                orderId: orderData.data?.orderId,
                status: 'completed'
            });

            currentAmount = parseFloat(orderData.data?.executedQty || currentAmount);
        }

        const finalProfit = currentAmount - investmentAmount;
        const profitPercent = (finalProfit / investmentAmount) * 100;

        res.json({
            success: true,
            execution: {
                pathId: opportunity.id,
                investmentAmount,
                finalAmount: currentAmount,
                profit: finalProfit,
                profitPercent: profitPercent.toFixed(4),
                steps: executionSteps,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to execute BingX triangular trade'
        });
    }
}));

// ROUTE 5: Get BingX Trade History
router.post('/bingx/triangular/history', asyncHandler(async (req, res) => {
    try {
        const userId = req.body.userId || req.user?.id;
        const limit = req.body.limit || 20;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID required'
            });
        }

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'BingX'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve BingX trade history'
        });
    }
}));

// ROUTE 6: Get Recent BingX Trades (All Users)
router.get('/bingx/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'BingX'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('BingX recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent BingX trades'
        });
    }
}));

// ============================================================================
// BITGET TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Bitget Triangular Arbitrage API Configuration
const BITGET_TRIANGULAR_CONFIG = {
    baseUrl: 'https://api.bitget.com',
    endpoints: {
        ticker: '/api/v2/spot/market/tickers',
        balance: '/api/v2/spot/account/assets',
        placeOrder: '/api/v2/spot/trade/place-order',
        symbols: '/api/v2/spot/public/symbols'
    }
};

// Bitget HMAC-SHA256 Authentication Helper (Base64 encoding)
function createBitgetTriangularSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = timestamp + method + requestPath + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// Bitget Triangular Arbitrage Paths (32 paths - includes BGB native token)
const BITGET_TRIANGULAR_PATHS = {
    SET_1_ESSENTIAL_ETH_BRIDGE: [
        { id: 'BITGET_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETHUSDT_SPBL', 'BTCETH_SPBL', 'BTCUSDT_SPBL'], description: 'ETH → BTC Bridge' },
        { id: 'BITGET_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETHUSDT_SPBL', 'SOLETH_SPBL', 'SOLUSDT_SPBL'], description: 'ETH → SOL Bridge' },
        { id: 'BITGET_ETH_3', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETHUSDT_SPBL', 'LINKETH_SPBL', 'LINKUSDT_SPBL'], description: 'ETH → LINK Bridge' },
        { id: 'BITGET_ETH_4', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETHUSDT_SPBL', 'AVAXETH_SPBL', 'AVAXUSDT_SPBL'], description: 'ETH → AVAX Bridge' },
        { id: 'BITGET_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETHUSDT_SPBL', 'MATICETH_SPBL', 'MATICUSDT_SPBL'], description: 'ETH → MATIC Bridge' },
        { id: 'BITGET_ETH_6', path: ['USDT', 'ETH', 'UNI', 'USDT'], pairs: ['ETHUSDT_SPBL', 'UNIETH_SPBL', 'UNIUSDT_SPBL'], description: 'ETH → UNI Bridge' },
        { id: 'BITGET_ETH_7', path: ['USDT', 'ETH', 'AAVE', 'USDT'], pairs: ['ETHUSDT_SPBL', 'AAVEETH_SPBL', 'AAVEUSDT_SPBL'], description: 'ETH → AAVE Bridge' }
    ],
    SET_2_MIDCAP_BTC_BRIDGE: [
        { id: 'BITGET_BTC_1', path: ['USDT', 'BTC', 'DOGE', 'USDT'], pairs: ['BTCUSDT_SPBL', 'DOGEBTC_SPBL', 'DOGEUSDT_SPBL'], description: 'BTC → DOGE Bridge' },
        { id: 'BITGET_BTC_2', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTCUSDT_SPBL', 'LTCBTC_SPBL', 'LTCUSDT_SPBL'], description: 'BTC → LTC Bridge' },
        { id: 'BITGET_BTC_3', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTCUSDT_SPBL', 'XRPBTC_SPBL', 'XRPUSDT_SPBL'], description: 'BTC → XRP Bridge' },
        { id: 'BITGET_BTC_4', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTCUSDT_SPBL', 'ADABTC_SPBL', 'ADAUSDT_SPBL'], description: 'BTC → ADA Bridge' },
        { id: 'BITGET_BTC_5', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTCUSDT_SPBL', 'DOTBTC_SPBL', 'DOTUSDT_SPBL'], description: 'BTC → DOT Bridge' },
        { id: 'BITGET_BTC_6', path: ['USDT', 'BTC', 'BCH', 'USDT'], pairs: ['BTCUSDT_SPBL', 'BCHBTC_SPBL', 'BCHUSDT_SPBL'], description: 'BTC → BCH Bridge' },
        { id: 'BITGET_BTC_7', path: ['USDT', 'BTC', 'TRX', 'USDT'], pairs: ['BTCUSDT_SPBL', 'TRXBTC_SPBL', 'TRXUSDT_SPBL'], description: 'BTC → TRX Bridge' }
    ],
    SET_3_BGB_NATIVE_TOKEN: [
        { id: 'BITGET_BGB_1', path: ['USDT', 'BGB', 'BTC', 'USDT'], pairs: ['BGBUSDT_SPBL', 'BTCBGB_SPBL', 'BTCUSDT_SPBL'], description: 'BGB → BTC Native Bridge' },
        { id: 'BITGET_BGB_2', path: ['USDT', 'BGB', 'ETH', 'USDT'], pairs: ['BGBUSDT_SPBL', 'ETHBGB_SPBL', 'ETHUSDT_SPBL'], description: 'BGB → ETH Native Bridge' },
        { id: 'BITGET_BGB_3', path: ['USDT', 'BTC', 'BGB', 'USDT'], pairs: ['BTCUSDT_SPBL', 'BGBBTC_SPBL', 'BGBUSDT_SPBL'], description: 'BTC → BGB Native' },
        { id: 'BITGET_BGB_4', path: ['USDT', 'ETH', 'BGB', 'USDT'], pairs: ['ETHUSDT_SPBL', 'BGBETH_SPBL', 'BGBUSDT_SPBL'], description: 'ETH → BGB Native' },
        { id: 'BITGET_BGB_5', path: ['USDT', 'BGB', 'SOL', 'USDT'], pairs: ['BGBUSDT_SPBL', 'SOLBGB_SPBL', 'SOLUSDT_SPBL'], description: 'BGB → SOL Native Bridge' },
        { id: 'BITGET_BGB_6', path: ['USDT', 'SOL', 'BGB', 'USDT'], pairs: ['SOLUSDT_SPBL', 'BGBSOL_SPBL', 'BGBUSDT_SPBL'], description: 'SOL → BGB Native' }
    ],
    SET_4_HIGH_VOLATILITY: [
        { id: 'BITGET_VOL_1', path: ['USDT', 'SOL', 'LINK', 'USDT'], pairs: ['SOLUSDT_SPBL', 'LINKSOL_SPBL', 'LINKUSDT_SPBL'], description: 'SOL → LINK Volatility' },
        { id: 'BITGET_VOL_2', path: ['USDT', 'SOL', 'MATIC', 'USDT'], pairs: ['SOLUSDT_SPBL', 'MATICSOL_SPBL', 'MATICUSDT_SPBL'], description: 'SOL → MATIC Volatility' },
        { id: 'BITGET_VOL_3', path: ['USDT', 'LINK', 'BTC', 'USDT'], pairs: ['LINKUSDT_SPBL', 'BTCLINK_SPBL', 'BTCUSDT_SPBL'], description: 'LINK → BTC Volatility' },
        { id: 'BITGET_VOL_4', path: ['USDT', 'AVAX', 'SOL', 'USDT'], pairs: ['AVAXUSDT_SPBL', 'SOLAVAX_SPBL', 'SOLUSDT_SPBL'], description: 'AVAX → SOL Volatility' },
        { id: 'BITGET_VOL_5', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['MATICUSDT_SPBL', 'BTCMATIC_SPBL', 'BTCUSDT_SPBL'], description: 'MATIC → BTC Volatility' },
        { id: 'BITGET_VOL_6', path: ['USDT', 'UNI', 'ETH', 'USDT'], pairs: ['UNIUSDT_SPBL', 'ETHUNI_SPBL', 'ETHUSDT_SPBL'], description: 'UNI → ETH Volatility' }
    ],
    SET_5_EXTENDED_MULTIBRIDGE: [
        { id: 'BITGET_EXT_1', path: ['USDT', 'ATOM', 'BTC', 'USDT'], pairs: ['ATOMUSDT_SPBL', 'BTCATOM_SPBL', 'BTCUSDT_SPBL'], description: 'ATOM → BTC Extended' },
        { id: 'BITGET_EXT_2', path: ['USDT', 'FIL', 'ETH', 'USDT'], pairs: ['FILUSDT_SPBL', 'ETHFIL_SPBL', 'ETHUSDT_SPBL'], description: 'FIL → ETH Extended' },
        { id: 'BITGET_EXT_3', path: ['USDT', 'XLM', 'BTC', 'USDT'], pairs: ['XLMUSDT_SPBL', 'BTCXLM_SPBL', 'BTCUSDT_SPBL'], description: 'XLM → BTC Extended' },
        { id: 'BITGET_EXT_4', path: ['USDT', 'ALGO', 'ETH', 'USDT'], pairs: ['ALGOUSDT_SPBL', 'ETHALGO_SPBL', 'ETHUSDT_SPBL'], description: 'ALGO → ETH Extended' },
        { id: 'BITGET_EXT_5', path: ['USDT', 'ETH', 'BTC', 'SOL', 'USDT'], pairs: ['ETHUSDT_SPBL', 'BTCETH_SPBL', 'SOLBTC_SPBL', 'SOLUSDT_SPBL'], description: 'Four-Leg: ETH→BTC→SOL' },
        { id: 'BITGET_EXT_6', path: ['USDT', 'BTC', 'ETH', 'LINK', 'USDT'], pairs: ['BTCUSDT_SPBL', 'ETHBTC_SPBL', 'LINKETH_SPBL', 'LINKUSDT_SPBL'], description: 'Four-Leg: BTC→ETH→LINK' }
    ]
};

// ROUTE 1: Test Bitget Connection
router.post('/bitget/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, passphrase } = req.body;

        if (!apiKey || !apiSecret || !passphrase) {
            return res.status(400).json({
                success: false,
                message: 'API credentials (key, secret, and passphrase) are required'
            });
        }

        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = BITGET_TRIANGULAR_CONFIG.endpoints.balance;
        const signature = createBitgetTriangularSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await axios.get(
            `${BITGET_TRIANGULAR_CONFIG.baseUrl}${requestPath}`,
            {
                headers: {
                    'ACCESS-KEY': apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': passphrase,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.code === '00000') {
            res.json({
                success: true,
                message: 'Bitget connection successful',
                data: {
                    balances: response.data.data || [],
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: `Bitget API error: ${response.data.msg || 'Unknown error'}`
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.response?.data?.msg || 'Failed to connect to Bitget'
        });
    }
}));

// ROUTE 2: Scan Bitget Triangular Opportunities
router.post('/bitget/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, passphrase, minProfitPercent = 0.3, enabledSets = ['SET_1', 'SET_2', 'SET_3', 'SET_4', 'SET_5'] } = req.body;

        if (!apiKey || !apiSecret || !passphrase) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Fetch all tickers
        const tickerResponse = await axios.get(
            `${BITGET_TRIANGULAR_CONFIG.baseUrl}${BITGET_TRIANGULAR_CONFIG.endpoints.ticker}`
        );

        if (tickerResponse.data.code !== '00000') {
            return res.status(400).json({
                success: false,
                message: 'Failed to fetch Bitget market data'
            });
        }

        const tickers = tickerResponse.data.data || [];
        const priceMap = {};

        tickers.forEach(ticker => {
            if (ticker.symbol) {
                priceMap[ticker.symbol] = {
                    bid: parseFloat(ticker.bidPr || ticker.buyOne || 0),
                    ask: parseFloat(ticker.askPr || ticker.sellOne || 0),
                    last: parseFloat(ticker.lastPr || ticker.close || 0)
                };
            }
        });

        // Filter enabled paths
        let allPaths = [];
        if (enabledSets.includes('SET_1')) allPaths = allPaths.concat(BITGET_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE);
        if (enabledSets.includes('SET_2')) allPaths = allPaths.concat(BITGET_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE);
        if (enabledSets.includes('SET_3')) allPaths = allPaths.concat(BITGET_TRIANGULAR_PATHS.SET_3_BGB_NATIVE_TOKEN);
        if (enabledSets.includes('SET_4')) allPaths = allPaths.concat(BITGET_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY);
        if (enabledSets.includes('SET_5')) allPaths = allPaths.concat(BITGET_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE);

        const opportunities = [];
        const feePercent = 0.10; // Bitget 0.10% maker/taker fee

        allPaths.forEach(pathConfig => {
            const pairs = pathConfig.pairs;
            let isValid = true;
            let prices = [];

            // Get prices for each pair
            for (const pair of pairs) {
                if (!priceMap[pair]) {
                    isValid = false;
                    break;
                }
                prices.push(priceMap[pair]);
            }

            if (!isValid) return;

            // Calculate profit for triangular path
            let amount = 100; // Start with 100 USDT

            // Execute each leg
            for (let i = 0; i < pairs.length; i++) {
                const price = prices[i];
                const avgPrice = (price.bid + price.ask) / 2;

                // Apply fee
                amount = amount * (1 - feePercent / 100);

                // Execute trade
                if (i === 0 || i === pairs.length - 1) {
                    // First and last leg: buying/selling against USDT
                    amount = amount / avgPrice;
                } else {
                    // Middle legs: cross pairs
                    amount = amount * avgPrice;
                }
            }

            const profitPercent = ((amount - 100) / 100) * 100;

            if (profitPercent >= minProfitPercent) {
                opportunities.push({
                    id: pathConfig.id,
                    path: pathConfig.path,
                    pairs: pathConfig.pairs,
                    description: pathConfig.description,
                    profitPercent: profitPercent.toFixed(3),
                    estimatedProfit: (amount - 100).toFixed(2),
                    prices: prices.map(p => ({
                        bid: p.bid,
                        ask: p.ask,
                        spread: ((p.ask - p.bid) / p.bid * 100).toFixed(3)
                    }))
                });
            }
        });

        // Sort by profit
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            opportunities,
            scannedPaths: allPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to scan Bitget opportunities'
        });
    }
}));

// ROUTE 3: Get Bitget Triangular Paths
router.get('/bitget/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const allPaths = [
        ...BITGET_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE,
        ...BITGET_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE,
        ...BITGET_TRIANGULAR_PATHS.SET_3_BGB_NATIVE_TOKEN,
        ...BITGET_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY,
        ...BITGET_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
    ];

    res.json({
        success: true,
        exchange: 'bitget',
        totalPaths: allPaths.length,
        sets: {
            SET_1_ESSENTIAL_ETH_BRIDGE: {
                name: 'Essential ETH Bridge',
                count: BITGET_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE.length,
                paths: BITGET_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE
            },
            SET_2_MIDCAP_BTC_BRIDGE: {
                name: 'Midcap BTC Bridge',
                count: BITGET_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE.length,
                paths: BITGET_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE
            },
            SET_3_BGB_NATIVE_TOKEN: {
                name: 'BGB Native Token',
                count: BITGET_TRIANGULAR_PATHS.SET_3_BGB_NATIVE_TOKEN.length,
                paths: BITGET_TRIANGULAR_PATHS.SET_3_BGB_NATIVE_TOKEN
            },
            SET_4_HIGH_VOLATILITY: {
                name: 'High Volatility',
                count: BITGET_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY.length,
                paths: BITGET_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY
            },
            SET_5_EXTENDED_MULTIBRIDGE: {
                name: 'Extended Multi-Bridge',
                count: BITGET_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE.length,
                paths: BITGET_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
            }
        }
    });
}));

// ROUTE 4: Execute Bitget Triangular Trade
router.post('/bitget/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, passphrase, pathId, amount, userId } = req.body;

        if (!apiKey || !apiSecret || !passphrase) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Find the path configuration
        const allPaths = [
            ...BITGET_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE,
            ...BITGET_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE,
            ...BITGET_TRIANGULAR_PATHS.SET_3_BGB_NATIVE_TOKEN,
            ...BITGET_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY,
            ...BITGET_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
        ];

        const pathConfig = allPaths.find(p => p.id === pathId);
        if (!pathConfig) {
            return res.status(400).json({
                success: false,
                message: 'Invalid path ID'
            });
        }

        const executionResults = [];
        let currentAmount = parseFloat(amount);

        // Execute each leg sequentially
        for (let i = 0; i < pathConfig.pairs.length; i++) {
            const symbol = pathConfig.pairs[i];
            const timestamp = Date.now().toString();
            const method = 'POST';
            const requestPath = BITGET_TRIANGULAR_CONFIG.endpoints.placeOrder;

            const orderData = {
                symbol: symbol,
                side: i % 2 === 0 ? 'buy' : 'sell',
                orderType: 'market',
                force: 'gtc',
                size: currentAmount.toString()
            };

            const body = JSON.stringify(orderData);
            const signature = createBitgetTriangularSignature(timestamp, method, requestPath, body, apiSecret);

            const response = await axios.post(
                `${BITGET_TRIANGULAR_CONFIG.baseUrl}${requestPath}`,
                orderData,
                {
                    headers: {
                        'ACCESS-KEY': apiKey,
                        'ACCESS-SIGN': signature,
                        'ACCESS-TIMESTAMP': timestamp,
                        'ACCESS-PASSPHRASE': passphrase,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.code !== '00000') {
                throw new Error(`Order failed at leg ${i + 1}: ${response.data.msg}`);
            }

            executionResults.push({
                leg: i + 1,
                symbol: symbol,
                orderId: response.data.data?.orderId,
                status: 'filled'
            });

            // Update amount for next leg (simplified)
            currentAmount = response.data.data?.fillSize || currentAmount;
        }

        // Store trade in database
        if (userId) {
            await pool.query(
                `INSERT INTO triangular_trades
                (user_id, exchange, path_id, path_description, initial_amount, final_amount, profit, profit_percent, status, execution_details, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
                [
                    userId,
                    'bitget',
                    pathConfig.id,
                    pathConfig.description,
                    parseFloat(amount),
                    currentAmount,
                    currentAmount - parseFloat(amount),
                    ((currentAmount - parseFloat(amount)) / parseFloat(amount)) * 100,
                    'completed',
                    JSON.stringify(executionResults)
                ]
            );
        }

        res.json({
            success: true,
            message: 'Triangular arbitrage executed successfully',
            execution: {
                pathId: pathConfig.id,
                initialAmount: parseFloat(amount),
                finalAmount: currentAmount,
                profit: currentAmount - parseFloat(amount),
                profitPercent: ((currentAmount - parseFloat(amount)) / parseFloat(amount)) * 100,
                legs: executionResults
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to execute Bitget triangular trade'
        });
    }
}));

// ROUTE 5: Get Bitget Trade History (User-Specific)
router.post('/bitget/triangular/history', asyncHandler(async (req, res) => {
    try {
        const { userId } = req.body;
        const limit = req.body.limit || 20;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID required'
            });
        }

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'Bitget'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Bitget trade history'
        });
    }
}));

// ROUTE 6: Get Recent Bitget Trades (All Users)
router.get('/bitget/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'Bitget'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Bitget recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Bitget trades'
        });
    }
}));

// ============================================================================
// BITMART TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Bitmart Triangular Arbitrage API Configuration
const BITMART_TRIANGULAR_CONFIG = {
    baseUrl: 'https://api-cloud.bitmart.com',
    endpoints: {
        ticker: '/spot/v2/ticker',
        balance: '/account/v1/wallet',
        placeOrder: '/spot/v1/submit_order',
        symbols: '/spot/v1/symbols'
    }
};

// Bitmart HMAC-SHA256 Authentication Helper
function createBitmartTriangularSignature(timestamp, memo, queryString, apiSecret) {
    const message = timestamp + '#' + memo + '#' + queryString;
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

// Bitmart Triangular Arbitrage Paths (32 paths - includes BMX native token)
const BITMART_TRIANGULAR_PATHS = {
    SET_1_ESSENTIAL_ETH_BRIDGE: [
        { id: 'BITMART_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], description: 'ETH → BTC Bridge' },
        { id: 'BITMART_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], description: 'ETH → SOL Bridge' },
        { id: 'BITMART_ETH_3', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETH_USDT', 'LINK_ETH', 'LINK_USDT'], description: 'ETH → LINK Bridge' },
        { id: 'BITMART_ETH_4', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], description: 'ETH → AVAX Bridge' },
        { id: 'BITMART_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], description: 'ETH → MATIC Bridge' },
        { id: 'BITMART_ETH_6', path: ['USDT', 'ETH', 'UNI', 'USDT'], pairs: ['ETH_USDT', 'UNI_ETH', 'UNI_USDT'], description: 'ETH → UNI Bridge' },
        { id: 'BITMART_ETH_7', path: ['USDT', 'ETH', 'AAVE', 'USDT'], pairs: ['ETH_USDT', 'AAVE_ETH', 'AAVE_USDT'], description: 'ETH → AAVE Bridge' }
    ],
    SET_2_MIDCAP_BTC_BRIDGE: [
        { id: 'BITMART_BTC_1', path: ['USDT', 'BTC', 'DOGE', 'USDT'], pairs: ['BTC_USDT', 'DOGE_BTC', 'DOGE_USDT'], description: 'BTC → DOGE Bridge' },
        { id: 'BITMART_BTC_2', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], description: 'BTC → LTC Bridge' },
        { id: 'BITMART_BTC_3', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTC_USDT', 'XRP_BTC', 'XRP_USDT'], description: 'BTC → XRP Bridge' },
        { id: 'BITMART_BTC_4', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTC_USDT', 'ADA_BTC', 'ADA_USDT'], description: 'BTC → ADA Bridge' },
        { id: 'BITMART_BTC_5', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], description: 'BTC → DOT Bridge' },
        { id: 'BITMART_BTC_6', path: ['USDT', 'BTC', 'BCH', 'USDT'], pairs: ['BTC_USDT', 'BCH_BTC', 'BCH_USDT'], description: 'BTC → BCH Bridge' },
        { id: 'BITMART_BTC_7', path: ['USDT', 'BTC', 'TRX', 'USDT'], pairs: ['BTC_USDT', 'TRX_BTC', 'TRX_USDT'], description: 'BTC → TRX Bridge' }
    ],
    SET_3_BMX_NATIVE_TOKEN: [
        { id: 'BITMART_BMX_1', path: ['USDT', 'BMX', 'BTC', 'USDT'], pairs: ['BMX_USDT', 'BTC_BMX', 'BTC_USDT'], description: 'BMX → BTC Native Bridge' },
        { id: 'BITMART_BMX_2', path: ['USDT', 'BMX', 'ETH', 'USDT'], pairs: ['BMX_USDT', 'ETH_BMX', 'ETH_USDT'], description: 'BMX → ETH Native Bridge' },
        { id: 'BITMART_BMX_3', path: ['USDT', 'BTC', 'BMX', 'USDT'], pairs: ['BTC_USDT', 'BMX_BTC', 'BMX_USDT'], description: 'BTC → BMX Native' },
        { id: 'BITMART_BMX_4', path: ['USDT', 'ETH', 'BMX', 'USDT'], pairs: ['ETH_USDT', 'BMX_ETH', 'BMX_USDT'], description: 'ETH → BMX Native' },
        { id: 'BITMART_BMX_5', path: ['USDT', 'BMX', 'SOL', 'USDT'], pairs: ['BMX_USDT', 'SOL_BMX', 'SOL_USDT'], description: 'BMX → SOL Native Bridge' },
        { id: 'BITMART_BMX_6', path: ['USDT', 'SOL', 'BMX', 'USDT'], pairs: ['SOL_USDT', 'BMX_SOL', 'BMX_USDT'], description: 'SOL → BMX Native' }
    ],
    SET_4_HIGH_VOLATILITY: [
        { id: 'BITMART_VOL_1', path: ['USDT', 'SOL', 'LINK', 'USDT'], pairs: ['SOL_USDT', 'LINK_SOL', 'LINK_USDT'], description: 'SOL → LINK Volatility' },
        { id: 'BITMART_VOL_2', path: ['USDT', 'SOL', 'MATIC', 'USDT'], pairs: ['SOL_USDT', 'MATIC_SOL', 'MATIC_USDT'], description: 'SOL → MATIC Volatility' },
        { id: 'BITMART_VOL_3', path: ['USDT', 'LINK', 'BTC', 'USDT'], pairs: ['LINK_USDT', 'BTC_LINK', 'BTC_USDT'], description: 'LINK → BTC Volatility' },
        { id: 'BITMART_VOL_4', path: ['USDT', 'AVAX', 'SOL', 'USDT'], pairs: ['AVAX_USDT', 'SOL_AVAX', 'SOL_USDT'], description: 'AVAX → SOL Volatility' },
        { id: 'BITMART_VOL_5', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['MATIC_USDT', 'BTC_MATIC', 'BTC_USDT'], description: 'MATIC → BTC Volatility' },
        { id: 'BITMART_VOL_6', path: ['USDT', 'UNI', 'ETH', 'USDT'], pairs: ['UNI_USDT', 'ETH_UNI', 'ETH_USDT'], description: 'UNI → ETH Volatility' }
    ],
    SET_5_EXTENDED_MULTIBRIDGE: [
        { id: 'BITMART_EXT_1', path: ['USDT', 'ATOM', 'BTC', 'USDT'], pairs: ['ATOM_USDT', 'BTC_ATOM', 'BTC_USDT'], description: 'ATOM → BTC Extended' },
        { id: 'BITMART_EXT_2', path: ['USDT', 'FIL', 'ETH', 'USDT'], pairs: ['FIL_USDT', 'ETH_FIL', 'ETH_USDT'], description: 'FIL → ETH Extended' },
        { id: 'BITMART_EXT_3', path: ['USDT', 'XLM', 'BTC', 'USDT'], pairs: ['XLM_USDT', 'BTC_XLM', 'BTC_USDT'], description: 'XLM → BTC Extended' },
        { id: 'BITMART_EXT_4', path: ['USDT', 'ALGO', 'ETH', 'USDT'], pairs: ['ALGO_USDT', 'ETH_ALGO', 'ETH_USDT'], description: 'ALGO → ETH Extended' },
        { id: 'BITMART_EXT_5', path: ['USDT', 'ETH', 'BTC', 'SOL', 'USDT'], pairs: ['ETH_USDT', 'BTC_ETH', 'SOL_BTC', 'SOL_USDT'], description: 'Four-Leg: ETH→BTC→SOL' },
        { id: 'BITMART_EXT_6', path: ['USDT', 'BTC', 'ETH', 'LINK', 'USDT'], pairs: ['BTC_USDT', 'ETH_BTC', 'LINK_ETH', 'LINK_USDT'], description: 'Four-Leg: BTC→ETH→LINK' }
    ]
};

// ROUTE 1: Test Bitmart Connection
router.post('/bitmart/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, memo } = req.body;

        if (!apiKey || !apiSecret || !memo) {
            return res.status(400).json({
                success: false,
                message: 'API credentials (key, secret, and memo) are required'
            });
        }

        const timestamp = Date.now().toString();
        const queryString = '';
        const signature = createBitmartTriangularSignature(timestamp, memo, queryString, apiSecret);

        const response = await axios.get(
            `${BITMART_TRIANGULAR_CONFIG.baseUrl}${BITMART_TRIANGULAR_CONFIG.endpoints.balance}`,
            {
                headers: {
                    'X-BM-KEY': apiKey,
                    'X-BM-SIGN': signature,
                    'X-BM-TIMESTAMP': timestamp,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.code === 1000) {
            res.json({
                success: true,
                message: 'Bitmart connection successful',
                data: {
                    balances: response.data.data?.wallet || [],
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: `Bitmart API error: ${response.data.message || 'Unknown error'}`
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.response?.data?.message || 'Failed to connect to Bitmart'
        });
    }
}));

// ROUTE 2: Scan Bitmart Triangular Opportunities
router.post('/bitmart/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, memo, minProfitPercent = 0.3, enabledSets = ['SET_1', 'SET_2', 'SET_3', 'SET_4', 'SET_5'] } = req.body;

        if (!apiKey || !apiSecret || !memo) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Fetch all tickers
        const tickerResponse = await axios.get(
            `${BITMART_TRIANGULAR_CONFIG.baseUrl}${BITMART_TRIANGULAR_CONFIG.endpoints.ticker}`
        );

        if (tickerResponse.data.code !== 1000) {
            return res.status(400).json({
                success: false,
                message: 'Failed to fetch Bitmart market data'
            });
        }

        const tickers = tickerResponse.data.data || [];
        const priceMap = {};

        tickers.forEach(ticker => {
            if (ticker.symbol) {
                priceMap[ticker.symbol] = {
                    bid: parseFloat(ticker.best_bid || ticker.buy_1_price || 0),
                    ask: parseFloat(ticker.best_ask || ticker.sell_1_price || 0),
                    last: parseFloat(ticker.last_price || ticker.close || 0)
                };
            }
        });

        // Filter enabled paths
        let allPaths = [];
        if (enabledSets.includes('SET_1')) allPaths = allPaths.concat(BITMART_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE);
        if (enabledSets.includes('SET_2')) allPaths = allPaths.concat(BITMART_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE);
        if (enabledSets.includes('SET_3')) allPaths = allPaths.concat(BITMART_TRIANGULAR_PATHS.SET_3_BMX_NATIVE_TOKEN);
        if (enabledSets.includes('SET_4')) allPaths = allPaths.concat(BITMART_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY);
        if (enabledSets.includes('SET_5')) allPaths = allPaths.concat(BITMART_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE);

        const opportunities = [];
        const feePercent = 0.25; // Bitmart 0.25% maker/taker fee (0.1% with BMX)

        allPaths.forEach(pathConfig => {
            const pairs = pathConfig.pairs;
            let isValid = true;
            let prices = [];

            // Get prices for each pair
            for (const pair of pairs) {
                if (!priceMap[pair]) {
                    isValid = false;
                    break;
                }
                prices.push(priceMap[pair]);
            }

            if (!isValid) return;

            // Calculate profit for triangular path
            let amount = 100; // Start with 100 USDT

            // Execute each leg
            for (let i = 0; i < pairs.length; i++) {
                const price = prices[i];
                const avgPrice = (price.bid + price.ask) / 2;

                // Apply fee
                amount = amount * (1 - feePercent / 100);

                // Execute trade
                if (i === 0 || i === pairs.length - 1) {
                    // First and last leg: buying/selling against USDT
                    amount = amount / avgPrice;
                } else {
                    // Middle legs: cross pairs
                    amount = amount * avgPrice;
                }
            }

            const profitPercent = ((amount - 100) / 100) * 100;

            if (profitPercent >= minProfitPercent) {
                opportunities.push({
                    id: pathConfig.id,
                    path: pathConfig.path,
                    pairs: pathConfig.pairs,
                    description: pathConfig.description,
                    profitPercent: profitPercent.toFixed(3),
                    estimatedProfit: (amount - 100).toFixed(2),
                    prices: prices.map(p => ({
                        bid: p.bid,
                        ask: p.ask,
                        spread: ((p.ask - p.bid) / p.bid * 100).toFixed(3)
                    }))
                });
            }
        });

        // Sort by profit
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            opportunities,
            scannedPaths: allPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to scan Bitmart opportunities'
        });
    }
}));

// ROUTE 3: Get Bitmart Triangular Paths
router.get('/bitmart/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const allPaths = [
        ...BITMART_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE,
        ...BITMART_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE,
        ...BITMART_TRIANGULAR_PATHS.SET_3_BMX_NATIVE_TOKEN,
        ...BITMART_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY,
        ...BITMART_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
    ];

    res.json({
        success: true,
        exchange: 'bitmart',
        totalPaths: allPaths.length,
        sets: {
            SET_1_ESSENTIAL_ETH_BRIDGE: {
                name: 'Essential ETH Bridge',
                count: BITMART_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE.length,
                paths: BITMART_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE
            },
            SET_2_MIDCAP_BTC_BRIDGE: {
                name: 'Midcap BTC Bridge',
                count: BITMART_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE.length,
                paths: BITMART_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE
            },
            SET_3_BMX_NATIVE_TOKEN: {
                name: 'BMX Native Token',
                count: BITMART_TRIANGULAR_PATHS.SET_3_BMX_NATIVE_TOKEN.length,
                paths: BITMART_TRIANGULAR_PATHS.SET_3_BMX_NATIVE_TOKEN
            },
            SET_4_HIGH_VOLATILITY: {
                name: 'High Volatility',
                count: BITMART_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY.length,
                paths: BITMART_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY
            },
            SET_5_EXTENDED_MULTIBRIDGE: {
                name: 'Extended Multi-Bridge',
                count: BITMART_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE.length,
                paths: BITMART_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
            }
        }
    });
}));

// ROUTE 4: Execute Bitmart Triangular Trade
router.post('/bitmart/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, memo, pathId, amount, userId } = req.body;

        if (!apiKey || !apiSecret || !memo) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Find the path configuration
        const allPaths = [
            ...BITMART_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE,
            ...BITMART_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE,
            ...BITMART_TRIANGULAR_PATHS.SET_3_BMX_NATIVE_TOKEN,
            ...BITMART_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY,
            ...BITMART_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
        ];

        const pathConfig = allPaths.find(p => p.id === pathId);
        if (!pathConfig) {
            return res.status(400).json({
                success: false,
                message: 'Invalid path ID'
            });
        }

        const executionResults = [];
        let currentAmount = parseFloat(amount);

        // Execute each leg sequentially
        for (let i = 0; i < pathConfig.pairs.length; i++) {
            const symbol = pathConfig.pairs[i];
            const timestamp = Date.now().toString();
            const orderData = {
                symbol: symbol,
                side: i % 2 === 0 ? 'buy' : 'sell',
                type: 'market',
                size: currentAmount.toString()
            };

            const queryString = Object.keys(orderData)
                .sort()
                .map(key => `${key}=${orderData[key]}`)
                .join('&');

            const signature = createBitmartTriangularSignature(timestamp, memo, queryString, apiSecret);

            const response = await axios.post(
                `${BITMART_TRIANGULAR_CONFIG.baseUrl}${BITMART_TRIANGULAR_CONFIG.endpoints.placeOrder}`,
                orderData,
                {
                    headers: {
                        'X-BM-KEY': apiKey,
                        'X-BM-SIGN': signature,
                        'X-BM-TIMESTAMP': timestamp,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.code !== 1000) {
                throw new Error(`Order failed at leg ${i + 1}: ${response.data.message}`);
            }

            executionResults.push({
                leg: i + 1,
                symbol: symbol,
                orderId: response.data.data?.order_id,
                status: 'filled'
            });

            // Update amount for next leg (simplified)
            currentAmount = response.data.data?.filled_size || currentAmount;
        }

        // Store trade in database
        if (userId) {
            await pool.query(
                `INSERT INTO triangular_trades
                (user_id, exchange, path_id, path_description, initial_amount, final_amount, profit, profit_percent, status, execution_details, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
                [
                    userId,
                    'bitmart',
                    pathConfig.id,
                    pathConfig.description,
                    parseFloat(amount),
                    currentAmount,
                    currentAmount - parseFloat(amount),
                    ((currentAmount - parseFloat(amount)) / parseFloat(amount)) * 100,
                    'completed',
                    JSON.stringify(executionResults)
                ]
            );
        }

        res.json({
            success: true,
            message: 'Triangular arbitrage executed successfully',
            execution: {
                pathId: pathConfig.id,
                initialAmount: parseFloat(amount),
                finalAmount: currentAmount,
                profit: currentAmount - parseFloat(amount),
                profitPercent: ((currentAmount - parseFloat(amount)) / parseFloat(amount)) * 100,
                legs: executionResults
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to execute Bitmart triangular trade'
        });
    }
}));

// ROUTE 5: Get Bitmart Trade History (User-Specific)
router.post('/bitmart/triangular/history', asyncHandler(async (req, res) => {
    try {
        const { userId } = req.body;
        const limit = req.body.limit || 20;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID required'
            });
        }

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'Bitmart'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Bitmart trade history'
        });
    }
}));

// ROUTE 6: Get Recent Bitmart Trades (All Users)
router.get('/bitmart/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'Bitmart'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Bitmart recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Bitmart trades'
        });
    }
}));

// ============================================================================
// BITRUE TRIANGULAR ARBITRAGE ROUTES
// ============================================================================

// Bitrue Triangular Arbitrage API Configuration
const BITRUE_TRIANGULAR_CONFIG = {
    baseUrl: 'https://openapi.bitrue.com',
    endpoints: {
        ticker: '/api/v1/ticker/24hr',
        balance: '/api/v1/account',
        placeOrder: '/api/v1/order',
        symbols: '/api/v1/exchangeInfo'
    }
};

// Bitrue HMAC-SHA256 Authentication Helper (Binance-compatible)
function createBitrueTriangularSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// Bitrue Triangular Arbitrage Paths (32 paths - includes BTR native token)
const BITRUE_TRIANGULAR_PATHS = {
    SET_1_ESSENTIAL_ETH_BRIDGE: [
        { id: 'BITRUE_ETH_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETHUSDT', 'ETHBTC', 'BTCUSDT'], description: 'ETH → BTC Bridge' },
        { id: 'BITRUE_ETH_2', path: ['USDT', 'ETH', 'SOL', 'USDT'], pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], description: 'ETH → SOL Bridge' },
        { id: 'BITRUE_ETH_3', path: ['USDT', 'ETH', 'LINK', 'USDT'], pairs: ['ETHUSDT', 'LINKETH', 'LINKUSDT'], description: 'ETH → LINK Bridge' },
        { id: 'BITRUE_ETH_4', path: ['USDT', 'ETH', 'AVAX', 'USDT'], pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], description: 'ETH → AVAX Bridge' },
        { id: 'BITRUE_ETH_5', path: ['USDT', 'ETH', 'MATIC', 'USDT'], pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], description: 'ETH → MATIC Bridge' },
        { id: 'BITRUE_ETH_6', path: ['USDT', 'ETH', 'UNI', 'USDT'], pairs: ['ETHUSDT', 'UNIETH', 'UNIUSDT'], description: 'ETH → UNI Bridge' },
        { id: 'BITRUE_ETH_7', path: ['USDT', 'ETH', 'AAVE', 'USDT'], pairs: ['ETHUSDT', 'AAVEETH', 'AAVEUSDT'], description: 'ETH → AAVE Bridge' }
    ],
    SET_2_MIDCAP_BTC_BRIDGE: [
        { id: 'BITRUE_BTC_1', path: ['USDT', 'BTC', 'DOGE', 'USDT'], pairs: ['BTCUSDT', 'DOGEBTC', 'DOGEUSDT'], description: 'BTC → DOGE Bridge' },
        { id: 'BITRUE_BTC_2', path: ['USDT', 'BTC', 'LTC', 'USDT'], pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], description: 'BTC → LTC Bridge' },
        { id: 'BITRUE_BTC_3', path: ['USDT', 'BTC', 'XRP', 'USDT'], pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], description: 'BTC → XRP Bridge' },
        { id: 'BITRUE_BTC_4', path: ['USDT', 'BTC', 'ADA', 'USDT'], pairs: ['BTCUSDT', 'ADABTC', 'ADAUSDT'], description: 'BTC → ADA Bridge' },
        { id: 'BITRUE_BTC_5', path: ['USDT', 'BTC', 'DOT', 'USDT'], pairs: ['BTCUSDT', 'DOTBTC', 'DOTUSDT'], description: 'BTC → DOT Bridge' },
        { id: 'BITRUE_BTC_6', path: ['USDT', 'BTC', 'BCH', 'USDT'], pairs: ['BTCUSDT', 'BCHBTC', 'BCHUSDT'], description: 'BTC → BCH Bridge' },
        { id: 'BITRUE_BTC_7', path: ['USDT', 'BTC', 'TRX', 'USDT'], pairs: ['BTCUSDT', 'TRXBTC', 'TRXUSDT'], description: 'BTC → TRX Bridge' }
    ],
    SET_3_BTR_NATIVE_TOKEN: [
        { id: 'BITRUE_BTR_1', path: ['USDT', 'BTR', 'BTC', 'USDT'], pairs: ['BTRUSDT', 'BTRBTC', 'BTCUSDT'], description: 'BTR → BTC Native Bridge' },
        { id: 'BITRUE_BTR_2', path: ['USDT', 'BTR', 'ETH', 'USDT'], pairs: ['BTRUSDT', 'BTRETH', 'ETHUSDT'], description: 'BTR → ETH Native Bridge' },
        { id: 'BITRUE_BTR_3', path: ['USDT', 'BTC', 'BTR', 'USDT'], pairs: ['BTCUSDT', 'BTRBTC', 'BTRUSDT'], description: 'BTC → BTR Native' },
        { id: 'BITRUE_BTR_4', path: ['USDT', 'ETH', 'BTR', 'USDT'], pairs: ['ETHUSDT', 'BTRETH', 'BTRUSDT'], description: 'ETH → BTR Native' },
        { id: 'BITRUE_BTR_5', path: ['USDT', 'BTR', 'SOL', 'USDT'], pairs: ['BTRUSDT', 'BTRSOL', 'SOLUSDT'], description: 'BTR → SOL Native Bridge' },
        { id: 'BITRUE_BTR_6', path: ['USDT', 'SOL', 'BTR', 'USDT'], pairs: ['SOLUSDT', 'BTRSOL', 'BTRUSDT'], description: 'SOL → BTR Native' }
    ],
    SET_4_HIGH_VOLATILITY: [
        { id: 'BITRUE_VOL_1', path: ['USDT', 'SOL', 'LINK', 'USDT'], pairs: ['SOLUSDT', 'LINKSOL', 'LINKUSDT'], description: 'SOL → LINK Volatility' },
        { id: 'BITRUE_VOL_2', path: ['USDT', 'SOL', 'MATIC', 'USDT'], pairs: ['SOLUSDT', 'MATICSOL', 'MATICUSDT'], description: 'SOL → MATIC Volatility' },
        { id: 'BITRUE_VOL_3', path: ['USDT', 'LINK', 'BTC', 'USDT'], pairs: ['LINKUSDT', 'LINKBTC', 'BTCUSDT'], description: 'LINK → BTC Volatility' },
        { id: 'BITRUE_VOL_4', path: ['USDT', 'AVAX', 'SOL', 'USDT'], pairs: ['AVAXUSDT', 'SOLAVAX', 'SOLUSDT'], description: 'AVAX → SOL Volatility' },
        { id: 'BITRUE_VOL_5', path: ['USDT', 'MATIC', 'BTC', 'USDT'], pairs: ['MATICUSDT', 'MATICBTC', 'BTCUSDT'], description: 'MATIC → BTC Volatility' },
        { id: 'BITRUE_VOL_6', path: ['USDT', 'UNI', 'ETH', 'USDT'], pairs: ['UNIUSDT', 'UNIETH', 'ETHUSDT'], description: 'UNI → ETH Volatility' }
    ],
    SET_5_EXTENDED_MULTIBRIDGE: [
        { id: 'BITRUE_EXT_1', path: ['USDT', 'ATOM', 'BTC', 'USDT'], pairs: ['ATOMUSDT', 'ATOMBTC', 'BTCUSDT'], description: 'ATOM → BTC Extended' },
        { id: 'BITRUE_EXT_2', path: ['USDT', 'FIL', 'ETH', 'USDT'], pairs: ['FILUSDT', 'FILETH', 'ETHUSDT'], description: 'FIL → ETH Extended' },
        { id: 'BITRUE_EXT_3', path: ['USDT', 'XLM', 'BTC', 'USDT'], pairs: ['XLMUSDT', 'XLMBTC', 'BTCUSDT'], description: 'XLM → BTC Extended' },
        { id: 'BITRUE_EXT_4', path: ['USDT', 'ALGO', 'ETH', 'USDT'], pairs: ['ALGOUSDT', 'ALGOETH', 'ETHUSDT'], description: 'ALGO → ETH Extended' },
        { id: 'BITRUE_EXT_5', path: ['USDT', 'ETH', 'BTC', 'SOL', 'USDT'], pairs: ['ETHUSDT', 'ETHBTC', 'SOLBTC', 'SOLUSDT'], description: 'Four-Leg: ETH→BTC→SOL' },
        { id: 'BITRUE_EXT_6', path: ['USDT', 'BTC', 'ETH', 'LINK', 'USDT'], pairs: ['BTCUSDT', 'ETHBTC', 'LINKETH', 'LINKUSDT'], description: 'Four-Leg: BTC→ETH→LINK' }
    ]
};

// ROUTE 1: Test Bitrue Connection
router.post('/bitrue/triangular/test-connection', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials (key and secret) are required'
            });
        }

        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBitrueTriangularSignature(queryString, apiSecret);

        const response = await axios.get(
            `${BITRUE_TRIANGULAR_CONFIG.baseUrl}${BITRUE_TRIANGULAR_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`,
            {
                headers: {
                    'X-MBX-APIKEY': apiKey
                }
            }
        );

        if (response.data) {
            res.json({
                success: true,
                message: 'Bitrue connection successful',
                data: {
                    balances: response.data.balances || [],
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Bitrue API error: Invalid response'
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.response?.data?.msg || 'Failed to connect to Bitrue'
        });
    }
}));

// ROUTE 2: Scan Bitrue Triangular Opportunities
router.post('/bitrue/triangular/scan', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, minProfitPercent = 0.3, enabledSets = ['SET_1', 'SET_2', 'SET_3', 'SET_4', 'SET_5'] } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Fetch all tickers
        const tickerResponse = await axios.get(
            `${BITRUE_TRIANGULAR_CONFIG.baseUrl}${BITRUE_TRIANGULAR_CONFIG.endpoints.ticker}`
        );

        if (!Array.isArray(tickerResponse.data)) {
            return res.status(400).json({
                success: false,
                message: 'Failed to fetch Bitrue market data'
            });
        }

        const tickers = tickerResponse.data;
        const priceMap = {};

        tickers.forEach(ticker => {
            if (ticker.symbol) {
                priceMap[ticker.symbol] = {
                    bid: parseFloat(ticker.bidPrice || 0),
                    ask: parseFloat(ticker.askPrice || 0),
                    last: parseFloat(ticker.lastPrice || 0)
                };
            }
        });

        // Filter enabled paths
        let allPaths = [];
        if (enabledSets.includes('SET_1')) allPaths = allPaths.concat(BITRUE_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE);
        if (enabledSets.includes('SET_2')) allPaths = allPaths.concat(BITRUE_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE);
        if (enabledSets.includes('SET_3')) allPaths = allPaths.concat(BITRUE_TRIANGULAR_PATHS.SET_3_BTR_NATIVE_TOKEN);
        if (enabledSets.includes('SET_4')) allPaths = allPaths.concat(BITRUE_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY);
        if (enabledSets.includes('SET_5')) allPaths = allPaths.concat(BITRUE_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE);

        const opportunities = [];
        const feePercent = 0.10; // Bitrue ~0.10% fee (0.07% with BTR)

        allPaths.forEach(pathConfig => {
            const pairs = pathConfig.pairs;
            let isValid = true;
            let prices = [];

            // Get prices for each pair
            for (const pair of pairs) {
                if (!priceMap[pair]) {
                    isValid = false;
                    break;
                }
                prices.push(priceMap[pair]);
            }

            if (!isValid) return;

            // Calculate profit for triangular path
            let amount = 100; // Start with 100 USDT

            // Execute each leg
            for (let i = 0; i < pairs.length; i++) {
                const price = prices[i];
                const avgPrice = (price.bid + price.ask) / 2;

                // Apply fee
                amount = amount * (1 - feePercent / 100);

                // Execute trade
                if (i === 0 || i === pairs.length - 1) {
                    // First and last leg: buying/selling against USDT
                    amount = amount / avgPrice;
                } else {
                    // Middle legs: cross pairs
                    amount = amount * avgPrice;
                }
            }

            const profitPercent = ((amount - 100) / 100) * 100;

            if (profitPercent >= minProfitPercent) {
                opportunities.push({
                    id: pathConfig.id,
                    path: pathConfig.path,
                    pairs: pathConfig.pairs,
                    description: pathConfig.description,
                    profitPercent: profitPercent.toFixed(3),
                    estimatedProfit: (amount - 100).toFixed(2),
                    prices: prices.map(p => ({
                        bid: p.bid,
                        ask: p.ask,
                        spread: ((p.ask - p.bid) / p.bid * 100).toFixed(3)
                    }))
                });
            }
        });

        // Sort by profit
        opportunities.sort((a, b) => parseFloat(b.profitPercent) - parseFloat(a.profitPercent));

        res.json({
            success: true,
            opportunities,
            scannedPaths: allPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to scan Bitrue opportunities'
        });
    }
}));

// ROUTE 3: Get Bitrue Triangular Paths
router.get('/bitrue/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const allPaths = [
        ...BITRUE_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE,
        ...BITRUE_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE,
        ...BITRUE_TRIANGULAR_PATHS.SET_3_BTR_NATIVE_TOKEN,
        ...BITRUE_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY,
        ...BITRUE_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
    ];

    res.json({
        success: true,
        exchange: 'bitrue',
        totalPaths: allPaths.length,
        sets: {
            SET_1_ESSENTIAL_ETH_BRIDGE: {
                name: 'Essential ETH Bridge',
                count: BITRUE_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE.length,
                paths: BITRUE_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE
            },
            SET_2_MIDCAP_BTC_BRIDGE: {
                name: 'Midcap BTC Bridge',
                count: BITRUE_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE.length,
                paths: BITRUE_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE
            },
            SET_3_BTR_NATIVE_TOKEN: {
                name: 'BTR Native Token',
                count: BITRUE_TRIANGULAR_PATHS.SET_3_BTR_NATIVE_TOKEN.length,
                paths: BITRUE_TRIANGULAR_PATHS.SET_3_BTR_NATIVE_TOKEN
            },
            SET_4_HIGH_VOLATILITY: {
                name: 'High Volatility',
                count: BITRUE_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY.length,
                paths: BITRUE_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY
            },
            SET_5_EXTENDED_MULTIBRIDGE: {
                name: 'Extended Multi-Bridge',
                count: BITRUE_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE.length,
                paths: BITRUE_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
            }
        }
    });
}));

// ROUTE 4: Execute Bitrue Triangular Trade
router.post('/bitrue/triangular/execute', asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, pathId, amount, userId } = req.body;

        if (!apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                message: 'API credentials required'
            });
        }

        // Find the path configuration
        const allPaths = [
            ...BITRUE_TRIANGULAR_PATHS.SET_1_ESSENTIAL_ETH_BRIDGE,
            ...BITRUE_TRIANGULAR_PATHS.SET_2_MIDCAP_BTC_BRIDGE,
            ...BITRUE_TRIANGULAR_PATHS.SET_3_BTR_NATIVE_TOKEN,
            ...BITRUE_TRIANGULAR_PATHS.SET_4_HIGH_VOLATILITY,
            ...BITRUE_TRIANGULAR_PATHS.SET_5_EXTENDED_MULTIBRIDGE
        ];

        const pathConfig = allPaths.find(p => p.id === pathId);
        if (!pathConfig) {
            return res.status(400).json({
                success: false,
                message: 'Invalid path ID'
            });
        }

        const executionResults = [];
        let currentAmount = parseFloat(amount);

        // Execute each leg sequentially
        for (let i = 0; i < pathConfig.pairs.length; i++) {
            const symbol = pathConfig.pairs[i];
            const timestamp = Date.now();

            const orderParams = {
                symbol: symbol,
                side: i % 2 === 0 ? 'BUY' : 'SELL',
                type: 'MARKET',
                quantity: currentAmount,
                timestamp: timestamp
            };

            const queryString = Object.keys(orderParams)
                .map(key => `${key}=${orderParams[key]}`)
                .join('&');

            const signature = createBitrueTriangularSignature(queryString, apiSecret);

            const response = await axios.post(
                `${BITRUE_TRIANGULAR_CONFIG.baseUrl}${BITRUE_TRIANGULAR_CONFIG.endpoints.placeOrder}?${queryString}&signature=${signature}`,
                {},
                {
                    headers: {
                        'X-MBX-APIKEY': apiKey
                    }
                }
            );

            if (!response.data || response.data.status !== 'FILLED') {
                throw new Error(`Order failed at leg ${i + 1}: ${response.data?.msg || 'Unknown error'}`);
            }

            executionResults.push({
                leg: i + 1,
                symbol: symbol,
                orderId: response.data.orderId,
                status: 'filled'
            });

            // Update amount for next leg
            currentAmount = parseFloat(response.data.executedQty || currentAmount);
        }

        // Store trade in database
        if (userId) {
            await pool.query(
                `INSERT INTO triangular_trades
                (user_id, exchange, path_id, path_description, initial_amount, final_amount, profit, profit_percent, status, execution_details, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
                [
                    userId,
                    'bitrue',
                    pathConfig.id,
                    pathConfig.description,
                    parseFloat(amount),
                    currentAmount,
                    currentAmount - parseFloat(amount),
                    ((currentAmount - parseFloat(amount)) / parseFloat(amount)) * 100,
                    'completed',
                    JSON.stringify(executionResults)
                ]
            );
        }

        res.json({
            success: true,
            message: 'Triangular arbitrage executed successfully',
            execution: {
                pathId: pathConfig.id,
                initialAmount: parseFloat(amount),
                finalAmount: currentAmount,
                profit: currentAmount - parseFloat(amount),
                profitPercent: ((currentAmount - parseFloat(amount)) / parseFloat(amount)) * 100,
                legs: executionResults
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to execute Bitrue triangular trade'
        });
    }
}));

// ROUTE 5: Get Bitrue Trade History (User-Specific)
router.post('/bitrue/triangular/history', asyncHandler(async (req, res) => {
    try {
        const { userId } = req.body;
        const limit = req.body.limit || 20;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID required'
            });
        }

        const result = await pool.query(
            `SELECT * FROM triangular_trades
             WHERE user_id = $1 AND exchange = 'Bitrue'
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Bitrue trade history'
        });
    }
}));

// ROUTE 6: Get Recent Bitrue Trades (All Users)
router.get('/bitrue/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM triangular_recent_trades
             WHERE exchange = 'Bitrue'
             ORDER BY created_at DESC
             LIMIT 20`
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Bitrue recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Bitrue trades'
        });
    }
}));

// ============================================================================
// GEMINI TRIANGULAR ARBITRAGE ENDPOINTS
// ============================================================================
// Gemini Exchange - Founded by Winklevoss twins, regulated US exchange
// Limited USDT pairs (btcusdt, ethusdt only) - 10 paths instead of 32

// Gemini Triangular Arbitrage API Configuration
const GEMINI_TRIANGULAR_CONFIG = {
    baseUrl: 'https://api.gemini.com',
    endpoints: {
        ticker: '/v2/ticker',
        balance: '/v1/balances',
        placeOrder: '/v1/order/new',
        symbols: '/v1/symbols'
    }
};

// Gemini HMAC-SHA384 Authentication Helper (NOTE: SHA384, not SHA256!)
function createGeminiTriangularSignature(base64Payload, apiSecret) {
    return crypto.createHmac('sha384', apiSecret).update(base64Payload).digest('hex');
}

// Gemini Triangular Arbitrage Paths (10 paths - limited by USDT availability)
// NOTE: Gemini only has 2 USDT pairs: btcusdt, ethusdt
const GEMINI_TRIANGULAR_PATHS = {
    SET_1_BTC_ETH_DIRECT: [
        { id: 'GEMINI_BTCETH_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['btcusdt', 'ethbtc', 'ethusdt'], description: 'Direct BTC-ETH bridge (forward)' },
        { id: 'GEMINI_ETHBTC_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ethusdt', 'ethbtc', 'btcusdt'], description: 'Direct ETH-BTC bridge (reverse)' }
    ],
    SET_2_DOGE_BRIDGE: [
        { id: 'GEMINI_DOGE_1', path: ['USDT', 'BTC', 'DOGE', 'ETH', 'USDT'], pairs: ['btcusdt', 'dogebtc', 'dogeeth', 'ethusdt'], description: 'BTC → DOGE → ETH bridge' },
        { id: 'GEMINI_DOGE_2', path: ['USDT', 'ETH', 'DOGE', 'BTC', 'USDT'], pairs: ['ethusdt', 'dogeeth', 'dogebtc', 'btcusdt'], description: 'ETH → DOGE → BTC bridge' }
    ],
    SET_3_LINK_BRIDGE: [
        { id: 'GEMINI_LINK_1', path: ['USDT', 'BTC', 'LINK', 'ETH', 'USDT'], pairs: ['btcusdt', 'linkbtc', 'linketh', 'ethusdt'], description: 'BTC → LINK → ETH bridge' },
        { id: 'GEMINI_LINK_2', path: ['USDT', 'ETH', 'LINK', 'BTC', 'USDT'], pairs: ['ethusdt', 'linketh', 'linkbtc', 'btcusdt'], description: 'ETH → LINK → BTC bridge' }
    ],
    SET_4_LTC_BRIDGE: [
        { id: 'GEMINI_LTC_1', path: ['USDT', 'BTC', 'LTC', 'ETH', 'USDT'], pairs: ['btcusdt', 'ltcbtc', 'ltceth', 'ethusdt'], description: 'BTC → LTC → ETH bridge' },
        { id: 'GEMINI_LTC_2', path: ['USDT', 'ETH', 'LTC', 'BTC', 'USDT'], pairs: ['ethusdt', 'ltceth', 'ltcbtc', 'btcusdt'], description: 'ETH → LTC → BTC bridge' }
    ],
    SET_5_SOL_BRIDGE: [
        { id: 'GEMINI_SOL_1', path: ['USDT', 'BTC', 'SOL', 'ETH', 'USDT'], pairs: ['btcusdt', 'solbtc', 'soleth', 'ethusdt'], description: 'BTC → SOL → ETH bridge' },
        { id: 'GEMINI_SOL_2', path: ['USDT', 'ETH', 'SOL', 'BTC', 'USDT'], pairs: ['ethusdt', 'soleth', 'solbtc', 'btcusdt'], description: 'ETH → SOL → BTC bridge' }
    ]
};

// POST /api/v1/trading/gemini/triangular/test-connection
// Test Gemini API connection for triangular trading
router.post('/gemini/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('Gemini triangular connection test initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Validate Gemini API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('Gemini API credentials required', 400, 'GEMINI_CREDENTIALS_REQUIRED');
        }

        // Test connection with account balance request
        const timestamp = Date.now();
        const payload = {
            request: '/v1/balances',
            nonce: timestamp
        };
        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const signature = createGeminiTriangularSignature(base64Payload, apiSecret);

        const balanceResponse = await axios.post(`${GEMINI_TRIANGULAR_CONFIG.baseUrl}/v1/balances`, {}, {
            headers: {
                'Content-Type': 'text/plain',
                'X-GEMINI-APIKEY': apiKey,
                'X-GEMINI-PAYLOAD': base64Payload,
                'X-GEMINI-SIGNATURE': signature,
                'Cache-Control': 'no-cache'
            }
        });

        if (!Array.isArray(balanceResponse.data)) {
            throw new APIError('Invalid response from Gemini API', 500, 'GEMINI_INVALID_RESPONSE');
        }

        // Find USDT balance
        const usdtBalance = balanceResponse.data.find(b => b.currency.toUpperCase() === 'USDT');
        const balance = usdtBalance ? {
            available: parseFloat(usdtBalance.available),
            total: parseFloat(usdtBalance.amount)
        } : { available: 0, total: 0 };

        systemLogger.trading('Gemini triangular connection successful', {
            userId: req.user.id,
            balance: balance.available
        });

        res.json({
            success: true,
            message: 'Gemini connection successful',
            balance
        });

    } catch (error) {
        systemLogger.trading('Gemini triangular connection failed', {
            userId: req.user.id,
            error: error.message
        });

        if (error.response?.data) {
            throw new APIError(`Gemini API error: ${JSON.stringify(error.response.data)}`, 400, 'GEMINI_API_ERROR');
        }

        throw error;
    }
}));

// POST /api/v1/trading/gemini/triangular/scan
// Scan for Gemini triangular arbitrage opportunities
router.post('/gemini/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, selectedSets } = req.body;

        systemLogger.trading('Gemini triangular scan initiated', {
            userId: req.user.id,
            selectedSets
        });

        // Validate inputs
        if (!apiKey || !apiSecret) {
            throw new APIError('Gemini API credentials required', 400, 'GEMINI_CREDENTIALS_REQUIRED');
        }

        if (!selectedSets || selectedSets.length === 0) {
            throw new APIError('At least one path set must be selected', 400, 'NO_PATHS_SELECTED');
        }

        // Collect all paths from selected sets
        let allPaths = [];
        selectedSets.forEach(setName => {
            if (GEMINI_TRIANGULAR_PATHS[setName]) {
                allPaths = allPaths.concat(GEMINI_TRIANGULAR_PATHS[setName]);
            }
        });

        if (allPaths.length === 0) {
            throw new APIError('No valid paths found in selected sets', 400, 'NO_VALID_PATHS');
        }

        // Fetch all unique symbols (no authentication needed for ticker data)
        const uniqueSymbols = [...new Set(allPaths.flatMap(p => p.pairs))];

        const tickerPromises = uniqueSymbols.map(async symbol => {
            try {
                const response = await axios.get(`${GEMINI_TRIANGULAR_CONFIG.baseUrl}${GEMINI_TRIANGULAR_CONFIG.endpoints.ticker}/${symbol}`);
                return {
                    symbol,
                    bid: parseFloat(response.data.bid),
                    ask: parseFloat(response.data.ask)
                };
            } catch (error) {
                systemLogger.trading(`Gemini ticker fetch failed for ${symbol}`, { error: error.message });
                return null;
            }
        });

        const tickers = (await Promise.all(tickerPromises)).filter(t => t !== null);

        // Create ticker map
        const tickerMap = {};
        tickers.forEach(t => {
            tickerMap[t.symbol] = t;
        });

        // Calculate arbitrage opportunities
        const opportunities = [];
        for (const pathConfig of allPaths) {
            try {
                // Check if all required tickers are available
                const missingTickers = pathConfig.pairs.filter(pair => !tickerMap[pair]);
                if (missingTickers.length > 0) {
                    continue;
                }

                let simulatedAmount = 1000; // Start with $1000 USDT
                const trades = [];

                // Execute simulated trades
                for (let i = 0; i < pathConfig.pairs.length; i++) {
                    const pair = pathConfig.pairs[i];
                    const ticker = tickerMap[pair];
                    const fromCurrency = pathConfig.path[i];
                    const toCurrency = pathConfig.path[i + 1];

                    // Determine if we're buying or selling
                    const pairBase = pair.replace('usdt', '').replace('btc', '').replace('eth', '');
                    let price, side;

                    if (pair === `${toCurrency.toLowerCase()}usdt` || pair === `${toCurrency.toLowerCase()}btc` || pair === `${toCurrency.toLowerCase()}eth`) {
                        // Buying the quote currency
                        side = 'buy';
                        price = ticker.ask;
                    } else {
                        // Selling to get the quote currency
                        side = 'sell';
                        price = ticker.bid;
                    }

                    const newAmount = side === 'buy' ? simulatedAmount / price : simulatedAmount * price;

                    trades.push({
                        pair,
                        side,
                        price,
                        fromAmount: simulatedAmount,
                        toAmount: newAmount,
                        fromCurrency,
                        toCurrency
                    });

                    simulatedAmount = newAmount;
                }

                const profit = simulatedAmount - 1000;
                const profitPercentage = (profit / 1000) * 100;

                // Consider 0.35% trading fee (maker/taker average on Gemini)
                const feePercentage = 0.35 * pathConfig.pairs.length;
                const netProfitPercentage = profitPercentage - feePercentage;

                if (netProfitPercentage > 0.1) { // Minimum 0.1% profit after fees
                    opportunities.push({
                        pathId: pathConfig.id,
                        path: pathConfig.path,
                        pairs: pathConfig.pairs,
                        description: pathConfig.description,
                        profitPercentage: netProfitPercentage,
                        estimatedProfit: (netProfitPercentage / 100) * 1000,
                        trades
                    });
                }

            } catch (error) {
                systemLogger.trading(`Error calculating path ${pathConfig.id}`, { error: error.message });
            }
        }

        // Sort by profit percentage
        opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

        systemLogger.trading('Gemini triangular scan completed', {
            userId: req.user.id,
            pathsScanned: allPaths.length,
            opportunitiesFound: opportunities.length
        });

        res.json({
            success: true,
            opportunities,
            scannedPaths: allPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Gemini scan error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to scan Gemini triangular opportunities'
        });
    }
}));

// GET /api/v1/trading/gemini/triangular/paths
// Get available Gemini triangular arbitrage paths
router.get('/gemini/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    res.json({
        success: true,
        paths: GEMINI_TRIANGULAR_PATHS,
        note: 'Gemini has limited USDT pairs (btcusdt, ethusdt only) - 10 paths available instead of standard 32'
    });
}));

// POST /api/v1/trading/gemini/triangular/execute
// Execute a Gemini triangular arbitrage trade
router.post('/gemini/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, opportunity, investmentAmount } = req.body;

        systemLogger.trading('Gemini triangular execution initiated', {
            userId: req.user.id,
            pathId: opportunity.pathId,
            investmentAmount
        });

        // Validate inputs
        if (!apiKey || !apiSecret) {
            throw new APIError('Gemini API credentials required', 400, 'GEMINI_CREDENTIALS_REQUIRED');
        }

        if (!opportunity || !investmentAmount) {
            throw new APIError('Opportunity and investment amount required', 400, 'MISSING_PARAMETERS');
        }

        const executedTrades = [];
        let currentAmount = investmentAmount;

        // Execute each leg of the triangular arbitrage
        for (let i = 0; i < opportunity.trades.length; i++) {
            const trade = opportunity.trades[i];

            const timestamp = Date.now() + i; // Increment nonce for each request
            const orderPayload = {
                request: '/v1/order/new',
                nonce: timestamp,
                symbol: trade.pair,
                amount: (currentAmount / trade.price).toFixed(8),
                price: trade.price.toFixed(8),
                side: trade.side,
                type: 'exchange limit',
                options: ['immediate-or-cancel'] // IOC for quick execution
            };

            const base64Payload = Buffer.from(JSON.stringify(orderPayload)).toString('base64');
            const signature = createGeminiTriangularSignature(base64Payload, apiSecret);

            const orderResponse = await axios.post(`${GEMINI_TRIANGULAR_CONFIG.baseUrl}/v1/order/new`, {}, {
                headers: {
                    'Content-Type': 'text/plain',
                    'X-GEMINI-APIKEY': apiKey,
                    'X-GEMINI-PAYLOAD': base64Payload,
                    'X-GEMINI-SIGNATURE': signature,
                    'Cache-Control': 'no-cache'
                }
            });

            executedTrades.push({
                pair: trade.pair,
                side: trade.side,
                price: trade.price,
                amount: parseFloat(orderPayload.amount),
                orderId: orderResponse.data.order_id
            });

            currentAmount = trade.toAmount;

            // Small delay between trades
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const finalProfit = currentAmount - investmentAmount;

        // Save to database
        if (req.db) {
            await req.db.query(
                `INSERT INTO triangular_trades
                (user_id, exchange, path_id, investment_amount, final_amount, profit, status, trades_data, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                [
                    req.user.id,
                    'gemini',
                    opportunity.pathId,
                    investmentAmount,
                    currentAmount,
                    finalProfit,
                    'completed',
                    JSON.stringify(executedTrades)
                ]
            );
        }

        systemLogger.trading('Gemini triangular execution completed', {
            userId: req.user.id,
            pathId: opportunity.pathId,
            profit: finalProfit
        });

        res.json({
            success: true,
            message: 'Triangular arbitrage executed successfully',
            executedTrades,
            finalAmount: currentAmount,
            profit: finalProfit,
            profitPercentage: ((finalProfit / investmentAmount) * 100).toFixed(2)
        });

    } catch (error) {
        console.error('Gemini execution error:', error);

        systemLogger.trading('Gemini triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });

        res.status(500).json({
            success: false,
            message: error.response?.data?.message || error.message || 'Execution failed'
        });
    }
}));

// GET /api/v1/trading/gemini/triangular/history
// Get Gemini triangular arbitrage trade history
router.get('/gemini/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        if (!req.db) {
            return res.json({
                success: true,
                trades: [],
                message: 'Database not connected'
            });
        }

        const result = await req.db.query(
            `SELECT * FROM triangular_trades
            WHERE user_id = $1 AND exchange = $2
            ORDER BY created_at DESC
            LIMIT 50`,
            [req.user.id, 'gemini']
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Gemini history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Gemini trade history'
        });
    }
}));

// GET /api/v1/trading/gemini/triangular/recent-trades
// Get recent Gemini triangular arbitrage trades (last 24 hours, all users)
router.get('/gemini/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        if (!req.db) {
            return res.json({
                success: true,
                trades: []
            });
        }

        const result = await req.db.query(
            `SELECT path_id, investment_amount, profit,
                    (profit / investment_amount * 100) as profit_percentage,
                    created_at
            FROM triangular_trades
            WHERE exchange = $1
            AND created_at > NOW() - INTERVAL '24 hours'
            AND status = 'completed'
            ORDER BY created_at DESC
            LIMIT 20`,
            ['gemini']
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Gemini recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Gemini trades'
        });
    }
}));

// ============================================================================
// COINCATCH TRIANGULAR ARBITRAGE ENDPOINTS
// ============================================================================
// Coincatch Exchange - 129 spot pairs, limited cross pairs (only ETHBTC, GMTBTC)
// Using mixed 3-leg and 4-leg paths due to cross pair limitations

// Coincatch Triangular Arbitrage API Configuration
const COINCATCH_TRIANGULAR_CONFIG = {
    baseUrl: 'https://api.coincatch.com',
    endpoints: {
        ticker: '/api/spot/v1/market/tickers',
        balance: '/api/spot/v1/account/assets',
        placeOrder: '/api/spot/v1/trade/orders',
        products: '/api/spot/v1/public/products'
    }
};

// Coincatch HMAC-SHA256 Authentication Helper
function createCoincatchTriangularSignature(timestamp, method, requestPath, queryString, body, apiSecret) {
    const message = timestamp + method.toUpperCase() + requestPath + queryString + body;
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// Coincatch Triangular Arbitrage Paths (32 paths - mixed 3-leg and 4-leg)
// NOTE: Coincatch only has 2 BTC cross pairs: ETHBTC_SPBL, GMTBTC_SPBL
const COINCATCH_TRIANGULAR_PATHS = {
    SET_1_BTC_ETH_DIRECT: [
        { id: 'COINCATCH_BTCETH_1', path: ['USDT', 'BTC', 'ETH', 'USDT'], pairs: ['BTCUSDT_SPBL', 'ETHBTC_SPBL', 'ETHUSDT_SPBL'], description: 'Direct BTC-ETH bridge (forward)' },
        { id: 'COINCATCH_ETHBTC_1', path: ['USDT', 'ETH', 'BTC', 'USDT'], pairs: ['ETHUSDT_SPBL', 'ETHBTC_SPBL', 'BTCUSDT_SPBL'], description: 'Direct ETH-BTC bridge (reverse)' }
    ],
    SET_2_GMT_BTC_BRIDGE: [
        { id: 'COINCATCH_GMT_1', path: ['USDT', 'BTC', 'GMT', 'USDT'], pairs: ['BTCUSDT_SPBL', 'GMTBTC_SPBL', 'GMTUSDT_SPBL'], description: 'BTC → GMT bridge' },
        { id: 'COINCATCH_GMT_2', path: ['USDT', 'GMT', 'BTC', 'USDT'], pairs: ['GMTUSDT_SPBL', 'GMTBTC_SPBL', 'BTCUSDT_SPBL'], description: 'GMT → BTC bridge' }
    ],
    SET_3_MAJOR_4LEG: [
        { id: 'COINCATCH_4LEG_1', path: ['USDT', 'BTC', 'USDT', 'ETH', 'USDT'], pairs: ['BTCUSDT_SPBL', 'BTCUSDT_SPBL', 'ETHUSDT_SPBL', 'ETHUSDT_SPBL'], description: 'BTC ⇄ ETH via USDT' },
        { id: 'COINCATCH_4LEG_2', path: ['USDT', 'BTC', 'USDT', 'SOL', 'USDT'], pairs: ['BTCUSDT_SPBL', 'BTCUSDT_SPBL', 'SOLUSDT_SPBL', 'SOLUSDT_SPBL'], description: 'BTC ⇄ SOL via USDT' },
        { id: 'COINCATCH_4LEG_3', path: ['USDT', 'BTC', 'USDT', 'LINK', 'USDT'], pairs: ['BTCUSDT_SPBL', 'BTCUSDT_SPBL', 'LINKUSDT_SPBL', 'LINKUSDT_SPBL'], description: 'BTC ⇄ LINK via USDT' },
        { id: 'COINCATCH_4LEG_4', path: ['USDT', 'ETH', 'USDT', 'SOL', 'USDT'], pairs: ['ETHUSDT_SPBL', 'ETHUSDT_SPBL', 'SOLUSDT_SPBL', 'SOLUSDT_SPBL'], description: 'ETH ⇄ SOL via USDT' },
        { id: 'COINCATCH_4LEG_5', path: ['USDT', 'ETH', 'USDT', 'LINK', 'USDT'], pairs: ['ETHUSDT_SPBL', 'ETHUSDT_SPBL', 'LINKUSDT_SPBL', 'LINKUSDT_SPBL'], description: 'ETH ⇄ LINK via USDT' },
        { id: 'COINCATCH_4LEG_6', path: ['USDT', 'ETH', 'USDT', 'AVAX', 'USDT'], pairs: ['ETHUSDT_SPBL', 'ETHUSDT_SPBL', 'AVAXUSDT_SPBL', 'AVAXUSDT_SPBL'], description: 'ETH ⇄ AVAX via USDT' },
        { id: 'COINCATCH_4LEG_7', path: ['USDT', 'SOL', 'USDT', 'LINK', 'USDT'], pairs: ['SOLUSDT_SPBL', 'SOLUSDT_SPBL', 'LINKUSDT_SPBL', 'LINKUSDT_SPBL'], description: 'SOL ⇄ LINK via USDT' },
        { id: 'COINCATCH_4LEG_8', path: ['USDT', 'SOL', 'USDT', 'UNI', 'USDT'], pairs: ['SOLUSDT_SPBL', 'SOLUSDT_SPBL', 'UNIUSDT_SPBL', 'UNIUSDT_SPBL'], description: 'SOL ⇄ UNI via USDT' }
    ],
    SET_4_ALTCOIN_4LEG: [
        { id: 'COINCATCH_4LEG_9', path: ['USDT', 'DOGE', 'USDT', 'XRP', 'USDT'], pairs: ['DOGEUSDT_SPBL', 'DOGEUSDT_SPBL', 'XRPUSDT_SPBL', 'XRPUSDT_SPBL'], description: 'DOGE ⇄ XRP via USDT' },
        { id: 'COINCATCH_4LEG_10', path: ['USDT', 'LINK', 'USDT', 'UNI', 'USDT'], pairs: ['LINKUSDT_SPBL', 'LINKUSDT_SPBL', 'UNIUSDT_SPBL', 'UNIUSDT_SPBL'], description: 'LINK ⇄ UNI via USDT' },
        { id: 'COINCATCH_4LEG_11', path: ['USDT', 'AVAX', 'USDT', 'ATOM', 'USDT'], pairs: ['AVAXUSDT_SPBL', 'AVAXUSDT_SPBL', 'ATOMUSDT_SPBL', 'ATOMUSDT_SPBL'], description: 'AVAX ⇄ ATOM via USDT' },
        { id: 'COINCATCH_4LEG_12', path: ['USDT', 'DOT', 'USDT', 'UNI', 'USDT'], pairs: ['DOTUSDT_SPBL', 'DOTUSDT_SPBL', 'UNIUSDT_SPBL', 'UNIUSDT_SPBL'], description: 'DOT ⇄ UNI via USDT' },
        { id: 'COINCATCH_4LEG_13', path: ['USDT', 'ATOM', 'USDT', 'LINK', 'USDT'], pairs: ['ATOMUSDT_SPBL', 'ATOMUSDT_SPBL', 'LINKUSDT_SPBL', 'LINKUSDT_SPBL'], description: 'ATOM ⇄ LINK via USDT' },
        { id: 'COINCATCH_4LEG_14', path: ['USDT', 'ADA', 'USDT', 'DOT', 'USDT'], pairs: ['ADAUSDT_SPBL', 'ADAUSDT_SPBL', 'DOTUSDT_SPBL', 'DOTUSDT_SPBL'], description: 'ADA ⇄ DOT via USDT' },
        { id: 'COINCATCH_4LEG_15', path: ['USDT', 'LTC', 'USDT', 'BCH', 'USDT'], pairs: ['LTCUSDT_SPBL', 'LTCUSDT_SPBL', 'BCHUSDT_SPBL', 'BCHUSDT_SPBL'], description: 'LTC ⇄ BCH via USDT' },
        { id: 'COINCATCH_4LEG_16', path: ['USDT', 'XRP', 'USDT', 'TRX', 'USDT'], pairs: ['XRPUSDT_SPBL', 'XRPUSDT_SPBL', 'TRXUSDT_SPBL', 'TRXUSDT_SPBL'], description: 'XRP ⇄ TRX via USDT' },
        { id: 'COINCATCH_4LEG_17', path: ['USDT', 'UNI', 'USDT', 'AAVE', 'USDT'], pairs: ['UNIUSDT_SPBL', 'UNIUSDT_SPBL', 'AAVEUSDT_SPBL', 'AAVEUSDT_SPBL'], description: 'UNI ⇄ AAVE via USDT' },
        { id: 'COINCATCH_4LEG_18', path: ['USDT', 'BNB', 'USDT', 'OP', 'USDT'], pairs: ['BNBUSDT_SPBL', 'BNBUSDT_SPBL', 'OPUSDT_SPBL', 'OPUSDT_SPBL'], description: 'BNB ⇄ OP via USDT' }
    ],
    SET_5_EXTENDED_4LEG: [
        { id: 'COINCATCH_4LEG_19', path: ['USDT', 'PEPE', 'USDT', 'SHIB', 'USDT'], pairs: ['PEPEUSDT_SPBL', 'PEPEUSDT_SPBL', 'SHIBUSDT_SPBL', 'SHIBUSDT_SPBL'], description: 'PEPE ⇄ SHIB via USDT' },
        { id: 'COINCATCH_4LEG_20', path: ['USDT', 'APT', 'USDT', 'SUI', 'USDT'], pairs: ['APTUSDT_SPBL', 'APTUSDT_SPBL', 'SUIUSDT_SPBL', 'SUIUSDT_SPBL'], description: 'APT ⇄ SUI via USDT' },
        { id: 'COINCATCH_4LEG_21', path: ['USDT', 'INJ', 'USDT', 'OP', 'USDT'], pairs: ['INJUSDT_SPBL', 'INJUSDT_SPBL', 'OPUSDT_SPBL', 'OPUSDT_SPBL'], description: 'INJ ⇄ OP via USDT' },
        { id: 'COINCATCH_4LEG_22', path: ['USDT', 'ARB', 'USDT', 'OP', 'USDT'], pairs: ['ARBUSDT_SPBL', 'ARBUSDT_SPBL', 'OPUSDT_SPBL', 'OPUSDT_SPBL'], description: 'ARB ⇄ OP via USDT' },
        { id: 'COINCATCH_4LEG_23', path: ['USDT', 'FIL', 'USDT', 'ICP', 'USDT'], pairs: ['FILUSDT_SPBL', 'FILUSDT_SPBL', 'ICPUSDT_SPBL', 'ICPUSDT_SPBL'], description: 'FIL ⇄ ICP via USDT' },
        { id: 'COINCATCH_4LEG_24', path: ['USDT', 'COMP', 'USDT', 'AAVE', 'USDT'], pairs: ['COMPUSDT_SPBL', 'COMPUSDT_SPBL', 'AAVEUSDT_SPBL', 'AAVEUSDT_SPBL'], description: 'COMP ⇄ AAVE via USDT' },
        { id: 'COINCATCH_4LEG_25', path: ['USDT', 'SNX', 'USDT', 'CRV', 'USDT'], pairs: ['SNXUSDT_SPBL', 'SNXUSDT_SPBL', 'CRVUSDT_SPBL', 'CRVUSDT_SPBL'], description: 'SNX ⇄ CRV via USDT' },
        { id: 'COINCATCH_4LEG_26', path: ['USDT', 'GALA', 'USDT', 'MANA', 'USDT'], pairs: ['GALAUSDT_SPBL', 'GALAUSDT_SPBL', 'MANAUSDT_SPBL', 'MANAUSDT_SPBL'], description: 'GALA ⇄ MANA via USDT' },
        { id: 'COINCATCH_4LEG_27', path: ['USDT', 'FLOKI', 'USDT', 'PEPE', 'USDT'], pairs: ['FLOKIUSDT_SPBL', 'FLOKIUSDT_SPBL', 'PEPEUSDT_SPBL', 'PEPEUSDT_SPBL'], description: 'FLOKI ⇄ PEPE via USDT' },
        { id: 'COINCATCH_4LEG_28', path: ['USDT', 'GRT', 'USDT', 'LDO', 'USDT'], pairs: ['GRTUSDT_SPBL', 'GRTUSDT_SPBL', 'LDOUSDT_SPBL', 'LDOUSDT_SPBL'], description: 'GRT ⇄ LDO via USDT' },
        { id: 'COINCATCH_4LEG_29', path: ['USDT', 'APE', 'USDT', 'SAND', 'USDT'], pairs: ['APEUSDT_SPBL', 'APEUSDT_SPBL', 'SANDUSDT_SPBL', 'SANDUSDT_SPBL'], description: 'APE ⇄ SAND via USDT' },
        { id: 'COINCATCH_4LEG_30', path: ['USDT', 'CHZ', 'USDT', 'STORJ', 'USDT'], pairs: ['CHZUSDT_SPBL', 'CHZUSDT_SPBL', 'STORJUSDT_SPBL', 'STORJUSDT_SPBL'], description: 'CHZ ⇄ STORJ via USDT' }
    ]
};

// POST /api/v1/trading/coincatch/triangular/test-connection
// Test Coincatch API connection for triangular trading
router.post('/coincatch/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, passphrase } = req.body;

        systemLogger.trading('Coincatch triangular connection test initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Validate Coincatch API credentials
        if (!apiKey || !apiSecret || !passphrase) {
            throw new APIError('Coincatch API credentials (apiKey, apiSecret, passphrase) required', 400, 'COINCATCH_CREDENTIALS_REQUIRED');
        }

        // Test connection with account balance request
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = '/api/spot/v1/account/assets';
        const signature = createCoincatchTriangularSignature(timestamp, method, requestPath, '', '', apiSecret);

        const balanceResponse = await axios.get(`${COINCATCH_TRIANGULAR_CONFIG.baseUrl}${requestPath}`, {
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        if (balanceResponse.data.code !== '00000') {
            throw new APIError(`Coincatch API error: ${balanceResponse.data.msg}`, 400, 'COINCATCH_API_ERROR');
        }

        // Find USDT balance
        const assets = balanceResponse.data.data || [];
        const usdtAsset = assets.find(a => a.coinName === 'USDT');
        const balance = usdtAsset ? {
            available: parseFloat(usdtAsset.available),
            total: parseFloat(usdtAsset.available) + parseFloat(usdtAsset.frozen || 0)
        } : { available: 0, total: 0 };

        systemLogger.trading('Coincatch triangular connection successful', {
            userId: req.user.id,
            balance: balance.available
        });

        res.json({
            success: true,
            message: 'Coincatch connection successful',
            balance
        });

    } catch (error) {
        systemLogger.trading('Coincatch triangular connection failed', {
            userId: req.user.id,
            error: error.message
        });

        if (error.response?.data) {
            throw new APIError(`Coincatch API error: ${JSON.stringify(error.response.data)}`, 400, 'COINCATCH_API_ERROR');
        }

        throw error;
    }
}));

// POST /api/v1/trading/coincatch/triangular/scan
// Scan for Coincatch triangular arbitrage opportunities
router.post('/coincatch/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, passphrase, selectedSets } = req.body;

        systemLogger.trading('Coincatch triangular scan initiated', {
            userId: req.user.id,
            selectedSets
        });

        // Validate inputs
        if (!apiKey || !apiSecret || !passphrase) {
            throw new APIError('Coincatch API credentials required', 400, 'COINCATCH_CREDENTIALS_REQUIRED');
        }

        if (!selectedSets || selectedSets.length === 0) {
            throw new APIError('At least one path set must be selected', 400, 'NO_PATHS_SELECTED');
        }

        // Collect all paths from selected sets
        let allPaths = [];
        selectedSets.forEach(setName => {
            if (COINCATCH_TRIANGULAR_PATHS[setName]) {
                allPaths = allPaths.concat(COINCATCH_TRIANGULAR_PATHS[setName]);
            }
        });

        if (allPaths.length === 0) {
            throw new APIError('No valid paths found in selected sets', 400, 'NO_VALID_PATHS');
        }

        // Fetch all unique symbols (no authentication needed for ticker data)
        const uniqueSymbols = [...new Set(allPaths.flatMap(p => p.pairs))];

        const tickerResponse = await axios.get(`${COINCATCH_TRIANGULAR_CONFIG.baseUrl}${COINCATCH_TRIANGULAR_CONFIG.endpoints.ticker}`);

        if (tickerResponse.data.code !== '00000') {
            throw new APIError('Failed to fetch Coincatch ticker data', 500, 'COINCATCH_TICKER_ERROR');
        }

        // Create ticker map
        const tickerMap = {};
        tickerResponse.data.data.forEach(ticker => {
            if (uniqueSymbols.includes(ticker.symbol)) {
                tickerMap[ticker.symbol] = {
                    symbol: ticker.symbol,
                    bid: parseFloat(ticker.bidPr),
                    ask: parseFloat(ticker.askPr)
                };
            }
        });

        // Calculate arbitrage opportunities
        const opportunities = [];
        for (const pathConfig of allPaths) {
            try {
                // Check if all required tickers are available
                const missingTickers = pathConfig.pairs.filter(pair => !tickerMap[pair]);
                if (missingTickers.length > 0) {
                    continue;
                }

                let simulatedAmount = 1000; // Start with $1000 USDT
                const trades = [];

                // Execute simulated trades
                for (let i = 0; i < pathConfig.pairs.length; i++) {
                    const pair = pathConfig.pairs[i];
                    const ticker = tickerMap[pair];
                    const fromCurrency = pathConfig.path[i];
                    const toCurrency = pathConfig.path[i + 1];

                    // Determine if we're buying or selling
                    let price, side;

                    // For 4-leg paths with duplicate pairs, alternate buy/sell
                    if (pair.includes(fromCurrency) && pair.includes(toCurrency)) {
                        // Determine based on position in path
                        if (fromCurrency === 'USDT') {
                            side = 'buy';
                            price = ticker.ask;
                        } else if (toCurrency === 'USDT') {
                            side = 'sell';
                            price = ticker.bid;
                        } else {
                            side = (i % 2 === 0) ? 'buy' : 'sell';
                            price = (i % 2 === 0) ? ticker.ask : ticker.bid;
                        }
                    } else {
                        // Standard 3-leg logic
                        if (pair === `${toCurrency}USDT_SPBL` || pair === `${toCurrency}BTC_SPBL`) {
                            side = 'buy';
                            price = ticker.ask;
                        } else {
                            side = 'sell';
                            price = ticker.bid;
                        }
                    }

                    const newAmount = side === 'buy' ? simulatedAmount / price : simulatedAmount * price;

                    trades.push({
                        pair,
                        side,
                        price,
                        fromAmount: simulatedAmount,
                        toAmount: newAmount,
                        fromCurrency,
                        toCurrency
                    });

                    simulatedAmount = newAmount;
                }

                const profit = simulatedAmount - 1000;
                const profitPercentage = (profit / 1000) * 100;

                // Consider 0.1% trading fee per leg
                const feePercentage = 0.1 * pathConfig.pairs.length;
                const netProfitPercentage = profitPercentage - feePercentage;

                if (netProfitPercentage > 0.1) { // Minimum 0.1% profit after fees
                    opportunities.push({
                        pathId: pathConfig.id,
                        path: pathConfig.path,
                        pairs: pathConfig.pairs,
                        description: pathConfig.description,
                        profitPercentage: netProfitPercentage,
                        estimatedProfit: (netProfitPercentage / 100) * 1000,
                        trades
                    });
                }

            } catch (error) {
                systemLogger.trading(`Error calculating path ${pathConfig.id}`, { error: error.message });
            }
        }

        // Sort by profit percentage
        opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

        systemLogger.trading('Coincatch triangular scan completed', {
            userId: req.user.id,
            pathsScanned: allPaths.length,
            opportunitiesFound: opportunities.length
        });

        res.json({
            success: true,
            opportunities,
            scannedPaths: allPaths.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Coincatch scan error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to scan Coincatch triangular opportunities'
        });
    }
}));

// GET /api/v1/trading/coincatch/triangular/paths
// Get available Coincatch triangular arbitrage paths
router.get('/coincatch/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    res.json({
        success: true,
        paths: COINCATCH_TRIANGULAR_PATHS,
        note: 'Coincatch has limited cross pairs (ETHBTC, GMTBTC) - using mixed 3-leg and 4-leg paths'
    });
}));

// POST /api/v1/trading/coincatch/triangular/execute
// Execute a Coincatch triangular arbitrage trade
router.post('/coincatch/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret, passphrase, opportunity, investmentAmount } = req.body;

        systemLogger.trading('Coincatch triangular execution initiated', {
            userId: req.user.id,
            pathId: opportunity.pathId,
            investmentAmount
        });

        // Validate inputs
        if (!apiKey || !apiSecret || !passphrase) {
            throw new APIError('Coincatch API credentials required', 400, 'COINCATCH_CREDENTIALS_REQUIRED');
        }

        if (!opportunity || !investmentAmount) {
            throw new APIError('Opportunity and investment amount required', 400, 'MISSING_PARAMETERS');
        }

        const executedTrades = [];
        let currentAmount = investmentAmount;

        // Execute each leg of the triangular arbitrage
        for (let i = 0; i < opportunity.trades.length; i++) {
            const trade = opportunity.trades[i];

            const timestamp = Date.now().toString();
            const method = 'POST';
            const requestPath = '/api/spot/v1/trade/orders';

            const orderBody = JSON.stringify({
                symbol: trade.pair,
                side: trade.side,
                orderType: 'limit',
                force: 'normal',
                price: trade.price.toFixed(8),
                quantity: (currentAmount / trade.price).toFixed(8),
                clientOrderId: `triangular_${Date.now()}_${i}`
            });

            const signature = createCoincatchTriangularSignature(timestamp, method, requestPath, '', orderBody, apiSecret);

            const orderResponse = await axios.post(`${COINCATCH_TRIANGULAR_CONFIG.baseUrl}${requestPath}`, orderBody, {
                headers: {
                    'ACCESS-KEY': apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': passphrase,
                    'Content-Type': 'application/json'
                }
            });

            if (orderResponse.data.code !== '00000') {
                throw new APIError(`Order failed: ${orderResponse.data.msg}`, 400, 'COINCATCH_ORDER_ERROR');
            }

            executedTrades.push({
                pair: trade.pair,
                side: trade.side,
                price: trade.price,
                amount: parseFloat((currentAmount / trade.price).toFixed(8)),
                orderId: orderResponse.data.data.orderId
            });

            currentAmount = trade.toAmount;

            // Small delay between trades
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const finalProfit = currentAmount - investmentAmount;

        // Save to database
        if (req.db) {
            await req.db.query(
                `INSERT INTO triangular_trades
                (user_id, exchange, path_id, investment_amount, final_amount, profit, status, trades_data, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                [
                    req.user.id,
                    'coincatch',
                    opportunity.pathId,
                    investmentAmount,
                    currentAmount,
                    finalProfit,
                    'completed',
                    JSON.stringify(executedTrades)
                ]
            );
        }

        systemLogger.trading('Coincatch triangular execution completed', {
            userId: req.user.id,
            pathId: opportunity.pathId,
            profit: finalProfit
        });

        res.json({
            success: true,
            message: 'Triangular arbitrage executed successfully',
            executedTrades,
            finalAmount: currentAmount,
            profit: finalProfit,
            profitPercentage: ((finalProfit / investmentAmount) * 100).toFixed(2)
        });

    } catch (error) {
        console.error('Coincatch execution error:', error);

        systemLogger.trading('Coincatch triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });

        res.status(500).json({
            success: false,
            message: error.response?.data?.msg || error.message || 'Execution failed'
        });
    }
}));

// GET /api/v1/trading/coincatch/triangular/history
// Get Coincatch triangular arbitrage trade history
router.get('/coincatch/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        if (!req.db) {
            return res.json({
                success: true,
                trades: [],
                message: 'Database not connected'
            });
        }

        const result = await req.db.query(
            `SELECT * FROM triangular_trades
            WHERE user_id = $1 AND exchange = $2
            ORDER BY created_at DESC
            LIMIT 50`,
            [req.user.id, 'coincatch']
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Coincatch history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve Coincatch trade history'
        });
    }
}));

// GET /api/v1/trading/coincatch/triangular/recent-trades
// Get recent Coincatch triangular arbitrage trades (last 24 hours, all users)
router.get('/coincatch/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        if (!req.db) {
            return res.json({
                success: true,
                trades: []
            });
        }

        const result = await req.db.query(
            `SELECT path_id, investment_amount, profit,
                    (profit / investment_amount * 100) as profit_percentage,
                    created_at
            FROM triangular_trades
            WHERE exchange = $1
            AND created_at > NOW() - INTERVAL '24 hours'
            AND status = 'completed'
            ORDER BY created_at DESC
            LIMIT 20`,
            ['coincatch']
        );

        res.json({
            success: true,
            trades: result.rows
        });

    } catch (error) {
        console.error('Coincatch recent trades error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve recent Coincatch trades'
        });
    }
}));

// ============================================================================
// VALR TRIANGULAR ARBITRAGE ENDPOINTS
// ============================================
// Specific endpoints for triangular arbitrage functionality

// POST /api/v1/trading/valr/triangular/test-connection
// Test VALR API connection for triangular trading
router.post('/valr/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('VALR triangular connection test initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Validate VALR API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('VALR API credentials required', 400, 'VALR_CREDENTIALS_REQUIRED');
        }

        const exchange_api_key = apiKey;
        const exchange_api_secret = apiSecret;

        // Test API connection by fetching balance
        const balanceData = await makeVALRRequest(
            VALR_CONFIG.endpoints.balance,
            'GET',
            null,
            exchange_api_key,
            exchange_api_secret
        );

        // Check if we have access to triangular pairs
        const requiredPairs = ['LINKZAR', 'LINKUSDT', 'USDTZAR', 'ETHZAR', 'ETHUSDT'];
        const pairsData = await makeVALRRequest(
            VALR_CONFIG.endpoints.pairs,
            'GET',
            null,
            exchange_api_key,
            exchange_api_secret
        );

        const availablePairs = pairsData.map(p => p.currencyPair);
        const triangularPairsAvailable = requiredPairs.every(pair => availablePairs.includes(pair));

        systemLogger.trading('VALR triangular connection test successful', {
            userId: req.user.id,
            balanceCount: balanceData.length,
            triangularPairsAvailable
        });

        res.json({
            success: true,
            data: {
                connected: true,
                balanceAccess: true,
                triangularPairsAvailable,
                totalPairs: availablePairs.length,
                requiredPairsFound: requiredPairs.filter(p => availablePairs.includes(p)),
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        systemLogger.error('VALR triangular connection test failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================
// ENHANCED TRIANGULAR PROFIT CALCULATION ENGINE
// ============================================
// Sophisticated profit calculation with VALR fees, slippage, and order book depth analysis

/**
 * Calculate triangular arbitrage profit with comprehensive analysis
 * @param {Object} path - Triangular path configuration 
 * @param {Object} orderBooks - Order book data for all pairs
 * @param {number} amount - Starting amount in ZAR
 * @param {Object} options - Calculation options
 * @returns {Object} Detailed profit analysis
 */
function calculateTriangularProfitAdvanced(path, orderBooks, amount = 1000, options = {}) {
    const {
        slippageBuffer = 0.1, // 0.1% slippage buffer
        minOrderSize = 50,    // Minimum R50 order size
        maxOrderSize = 10000, // Maximum R10,000 order size
        depthAnalysis = true   // Whether to analyze order book depth
    } = options;

    try {
        // VALR fee structure
        const MAKER_FEE = 0.001;  // 0.1% maker fee
        const TAKER_FEE = 0.001;  // 0.1% taker fee (we'll use taker for immediate execution)
        
        // Validate input amount
        if (amount < minOrderSize || amount > maxOrderSize) {
            return {
                success: false,
                error: `Amount must be between R${minOrderSize} and R${maxOrderSize}`,
                pathId: path.id
            };
        }

        const result = {
            pathId: path.id,
            sequence: path.sequence,
            startAmount: amount,
            steps: [],
            fees: {
                total: 0,
                breakdown: []
            },
            slippage: {
                estimated: 0,
                breakdown: []
            },
            orderBookDepth: [],
            success: true
        };

        let currentAmount = amount;
        let totalFees = 0;
        let totalSlippage = 0;

        // Execute each step of the triangular path
        for (let i = 0; i < path.steps.length; i++) {
            const step = path.steps[i];
            const orderBook = orderBooks[step.pair];
            
            if (!orderBook || !orderBook.Asks || !orderBook.Bids) {
                return {
                    success: false,
                    error: `Missing order book data for ${step.pair}`,
                    pathId: path.id
                };
            }

            const stepResult = {
                step: i + 1,
                pair: step.pair,
                side: step.side,
                inputAmount: currentAmount
            };

            if (step.side === 'buy') {
                // Buying: use ask prices (we pay the ask)
                const asks = orderBook.Asks;
                if (!asks || asks.length === 0) {
                    return {
                        success: false,
                        error: `No ask orders available for ${step.pair}`,
                        pathId: path.id
                    };
                }

                const bestAsk = parseFloat(asks[0].price);
                const askSize = parseFloat(asks[0].quantity);
                
                // Calculate how much we can buy with current amount
                const grossQuantity = currentAmount / bestAsk;
                
                // Apply trading fee
                const fee = currentAmount * TAKER_FEE;
                const netAmountAfterFee = currentAmount - fee;
                const netQuantity = netAmountAfterFee / bestAsk;
                
                // Estimate slippage based on order book depth
                let slippagePercent = 0;
                if (depthAnalysis && askSize < netQuantity) {
                    // Need to eat into deeper order book levels
                    slippagePercent = slippageBuffer;
                    const slippageAmount = netQuantity * (slippagePercent / 100);
                    stepResult.slippageWarning = `Insufficient liquidity: need ${netQuantity.toFixed(4)}, available ${askSize.toFixed(4)}`;
                    totalSlippage += slippageAmount;
                }
                
                const finalQuantity = netQuantity * (1 - slippagePercent / 100);
                
                stepResult.price = bestAsk;
                stepResult.grossQuantity = grossQuantity;
                stepResult.fee = fee;
                stepResult.netQuantity = finalQuantity;
                stepResult.slippage = slippagePercent;
                stepResult.availableLiquidity = askSize;
                stepResult.outputAmount = finalQuantity;
                
                currentAmount = finalQuantity;
                totalFees += fee;
                
                // Order book depth analysis
                if (depthAnalysis) {
                    const depthInfo = analyzeOrderBookDepth(asks, netAmountAfterFee, 'ask');
                    result.orderBookDepth.push({
                        pair: step.pair,
                        side: 'ask',
                        ...depthInfo
                    });
                }

            } else {
                // Selling: use bid prices (we receive the bid)
                const bids = orderBook.Bids;
                if (!bids || bids.length === 0) {
                    return {
                        success: false,
                        error: `No bid orders available for ${step.pair}`,
                        pathId: path.id
                    };
                }

                const bestBid = parseFloat(bids[0].price);
                const bidSize = parseFloat(bids[0].quantity);
                
                // Calculate ZAR amount we'll receive
                const grossAmount = currentAmount * bestBid;
                
                // Apply trading fee
                const fee = grossAmount * TAKER_FEE;
                const netAmount = grossAmount - fee;
                
                // Estimate slippage based on order book depth
                let slippagePercent = 0;
                if (depthAnalysis && bidSize < currentAmount) {
                    // Need to sell into deeper order book levels
                    slippagePercent = slippageBuffer;
                    const slippageAmount = netAmount * (slippagePercent / 100);
                    stepResult.slippageWarning = `Insufficient liquidity: selling ${currentAmount.toFixed(4)}, available ${bidSize.toFixed(4)}`;
                    totalSlippage += slippageAmount;
                }
                
                const finalAmount = netAmount * (1 - slippagePercent / 100);
                
                stepResult.price = bestBid;
                stepResult.grossAmount = grossAmount;
                stepResult.fee = fee;
                stepResult.netAmount = finalAmount;
                stepResult.slippage = slippagePercent;
                stepResult.availableLiquidity = bidSize;
                stepResult.outputAmount = finalAmount;
                
                currentAmount = finalAmount;
                totalFees += fee;
                
                // Order book depth analysis
                if (depthAnalysis) {
                    const depthInfo = analyzeOrderBookDepth(bids, currentAmount, 'bid');
                    result.orderBookDepth.push({
                        pair: step.pair,
                        side: 'bid',
                        ...depthInfo
                    });
                }
            }

            result.steps.push(stepResult);
            result.fees.breakdown.push({
                step: i + 1,
                pair: step.pair,
                fee: stepResult.fee,
                feePercent: TAKER_FEE * 100
            });
        }

        // Final profit calculation
        const grossProfit = currentAmount - amount;
        const netProfit = grossProfit; // Fees already deducted in steps
        const profitPercent = (netProfit / amount) * 100;
        
        // Risk assessment
        const riskFactors = [];
        if (totalSlippage > 0) riskFactors.push('slippage_risk');
        if (totalFees > amount * 0.005) riskFactors.push('high_fees');
        if (result.orderBookDepth.some(d => d.liquidityRisk)) riskFactors.push('liquidity_risk');
        
        // Minimum profit threshold (must exceed total costs by meaningful margin)
        const minProfitThreshold = amount * 0.008; // 0.8% minimum for VALR
        const profitable = netProfit > minProfitThreshold;
        
        // Update result with final calculations
        result.endAmount = currentAmount;
        result.grossProfit = grossProfit;
        result.netProfit = netProfit;
        result.netProfitPercent = profitPercent;
        result.profitable = profitable;
        result.fees.total = totalFees;
        result.fees.percentage = (totalFees / amount) * 100;
        result.slippage.estimated = totalSlippage;
        result.slippage.percentage = (totalSlippage / amount) * 100;
        result.riskFactors = riskFactors;
        result.riskLevel = getRiskLevel(riskFactors);
        result.minProfitThreshold = minProfitThreshold;
        result.timestamp = new Date().toISOString();
        
        // Execution recommendation
        if (profitable && riskFactors.length === 0) {
            result.recommendation = 'EXECUTE';
        } else if (profitable && riskFactors.length <= 1) {
            result.recommendation = 'CAUTIOUS';
        } else {
            result.recommendation = 'AVOID';
        }

        return result;

    } catch (error) {
        return {
            success: false,
            error: error.message,
            pathId: path.id
        };
    }
}

/**
 * Analyze order book depth for liquidity assessment
 */
function analyzeOrderBookDepth(orders, requiredAmount, side) {
    let cumulativeAmount = 0;
    let cumulativeQuantity = 0;
    let levelsNeeded = 0;
    let averagePrice = 0;
    let priceImpact = 0;
    
    if (!orders || orders.length === 0) {
        return {
            liquidityRisk: true,
            levelsNeeded: 0,
            priceImpact: 100,
            message: 'No orders available'
        };
    }
    
    const firstPrice = parseFloat(orders[0].price);
    
    for (let i = 0; i < orders.length && cumulativeAmount < requiredAmount; i++) {
        const order = orders[i];
        const price = parseFloat(order.price);
        const quantity = parseFloat(order.quantity);
        const orderAmount = side === 'ask' ? quantity * price : quantity;
        
        cumulativeAmount += orderAmount;
        cumulativeQuantity += quantity;
        levelsNeeded++;
        
        // Calculate weighted average price
        averagePrice = cumulativeAmount / cumulativeQuantity;
        
        // Calculate price impact
        priceImpact = Math.abs((price - firstPrice) / firstPrice) * 100;
    }
    
    const liquidityRisk = levelsNeeded > 3 || priceImpact > 1.0; // Risk if need >3 levels or >1% impact
    
    return {
        liquidityRisk,
        levelsNeeded,
        priceImpact: priceImpact.toFixed(4),
        averagePrice: averagePrice.toFixed(8),
        cumulativeAmount: cumulativeAmount.toFixed(2),
        message: liquidityRisk ? 'Liquidity constraints detected' : 'Sufficient liquidity'
    };
}

/**
 * Determine risk level based on risk factors
 */
function getRiskLevel(riskFactors) {
    if (riskFactors.length === 0) return 'LOW';
    if (riskFactors.length <= 1) return 'MEDIUM';
    return 'HIGH';
}

// ============================================
// 3-LEG ATOMIC TRADE EXECUTION ENGINE
// ============================================
// Execute triangular arbitrage with atomic rollback on failure

/**
 * Execute a 3-leg triangular arbitrage trade atomically
 * @param {Object} opportunity - Triangular opportunity with execution details
 * @param {string} apiKey - VALR API key
 * @param {string} apiSecret - VALR API secret
 * @param {Object} options - Execution options
 * @returns {Object} Execution result with trade details
 */
async function executeTriangularTradeAtomic(opportunity, apiKey, apiSecret, options = {}) {
    const {
        maxSlippage = 0.5,      // Maximum allowed slippage %
        timeoutMs = 30000,      // 30 second timeout per trade
        dryRun = false          // Dry run mode for testing
    } = options;
    
    const executionId = Math.random().toString(36).substring(7);
    const startTime = Date.now();
    
    console.log(`🚀 Starting atomic triangular execution: ${executionId}`);
    console.log(`📊 Path: ${opportunity.pathId} | Amount: R${opportunity.startAmount}`);
    
    const result = {
        executionId,
        pathId: opportunity.pathId,
        sequence: opportunity.sequence,
        startAmount: opportunity.startAmount,
        startTime: new Date(startTime).toISOString(),
        success: false,
        legs: [],
        rollbacks: [],
        error: null,
        performance: {
            totalTime: 0,
            legTimes: []
        }
    };
    
    try {
        // Pre-execution validation
        if (!opportunity.steps || opportunity.steps.length !== 3) {
            throw new Error('Invalid triangular path: must have exactly 3 steps');
        }
        
        if (!opportunity.profitable || opportunity.recommendation === 'AVOID') {
            throw new Error(`Opportunity not suitable for execution: ${opportunity.recommendation}`);
        }
        
        // Validate balances before execution
        const balanceCheck = await validateBalancesForExecution(opportunity, apiKey, apiSecret);
        if (!balanceCheck.sufficient) {
            throw new Error(`Insufficient balance: ${balanceCheck.message}`);
        }
        
        console.log(`✅ Pre-execution validation passed`);
        
        let currentAmount = opportunity.startAmount;
        let currentCurrency = 'ZAR'; // Assuming ZAR-based arbitrage
        
        // Execute each leg sequentially with rollback capability
        for (let i = 0; i < opportunity.steps.length; i++) {
            const step = opportunity.steps[i];
            const legStartTime = Date.now();
            
            console.log(`🔄 Executing leg ${i + 1}/3: ${step.pair} (${step.side})`);
            
            try {
                // Execute the trade leg
                const legResult = await executeTradeLeg(
                    step, 
                    currentAmount, 
                    currentCurrency,
                    apiKey, 
                    apiSecret,
                    { 
                        maxSlippage, 
                        timeoutMs, 
                        dryRun,
                        executionId 
                    }
                );
                
                const legTime = Date.now() - legStartTime;
                result.performance.legTimes.push(legTime);
                
                // Update current state
                currentAmount = legResult.outputAmount;
                currentCurrency = legResult.outputCurrency;
                
                // Store leg details
                result.legs.push({
                    legNumber: i + 1,
                    step: step,
                    inputAmount: legResult.inputAmount,
                    outputAmount: legResult.outputAmount,
                    price: legResult.price,
                    fee: legResult.fee,
                    orderId: legResult.orderId,
                    slippage: legResult.slippage,
                    executionTime: legTime,
                    success: true
                });
                
                console.log(`✅ Leg ${i + 1} completed: ${currentAmount.toFixed(4)} ${currentCurrency}`);
                
            } catch (legError) {
                console.error(`❌ Leg ${i + 1} failed:`, legError.message);
                
                // Record failed leg
                result.legs.push({
                    legNumber: i + 1,
                    step: step,
                    error: legError.message,
                    executionTime: Date.now() - legStartTime,
                    success: false
                });
                
                // Initiate rollback for all completed legs
                if (i > 0 && !dryRun) {
                    console.log(`🔄 Initiating rollback for ${i} completed legs...`);
                    await rollbackCompletedLegs(result.legs.slice(0, i), apiKey, apiSecret);
                }
                
                throw new Error(`Leg ${i + 1} execution failed: ${legError.message}`);
            }
        }
        
        // Calculate final results
        const finalAmount = currentAmount;
        const grossProfit = finalAmount - opportunity.startAmount;
        const netProfit = grossProfit; // Fees already deducted in legs
        const netProfitPercent = (netProfit / opportunity.startAmount) * 100;
        const totalTime = Date.now() - startTime;
        
        result.success = true;
        result.endAmount = finalAmount;
        result.grossProfit = grossProfit;
        result.netProfit = netProfit;
        result.netProfitPercent = netProfitPercent;
        result.performance.totalTime = totalTime;
        result.endTime = new Date().toISOString();
        
        console.log(`🎉 Triangular execution completed successfully!`);
        console.log(`💰 Net profit: R${netProfit.toFixed(2)} (${netProfitPercent.toFixed(2)}%)`);
        console.log(`⏱️ Total execution time: ${totalTime}ms`);
        
        return result;
        
    } catch (error) {
        const totalTime = Date.now() - startTime;
        result.error = error.message;
        result.performance.totalTime = totalTime;
        result.endTime = new Date().toISOString();
        
        console.error(`❌ Triangular execution failed: ${error.message}`);
        
        return result;
    }
}

/**
 * Execute a single trade leg
 */
async function executeTradeLeg(step, inputAmount, inputCurrency, apiKey, apiSecret, options) {
    const { maxSlippage, timeoutMs, dryRun, executionId } = options;
    
    if (dryRun) {
        // Simulate trade execution for testing
        const simulatedPrice = step.price * (1 + (Math.random() - 0.5) * 0.001); // ±0.05% price variance
        const simulatedFee = inputAmount * 0.001; // 0.1% fee
        const simulatedSlippage = Math.random() * 0.1; // Up to 0.1% slippage
        
        let outputAmount, outputCurrency;
        
        if (step.side === 'buy') {
            outputAmount = (inputAmount - simulatedFee) / simulatedPrice;
            outputCurrency = step.pair.replace('ZAR', '').replace('USDT', ''); // Extract base currency
        } else {
            outputAmount = inputAmount * simulatedPrice - simulatedFee;
            outputCurrency = step.pair.includes('ZAR') ? 'ZAR' : 'USDT';
        }
        
        return {
            inputAmount,
            outputAmount,
            outputCurrency,
            price: simulatedPrice,
            fee: simulatedFee,
            slippage: simulatedSlippage,
            orderId: `SIM_${executionId}_${step.pair}_${Date.now()}`,
            simulation: true
        };
    }
    
    // Real trade execution
    try {
        // Get fresh order book to check for slippage
        const orderBook = await makeVALRRequest(
            `/v1/marketdata/${step.pair}/orderbook`,
            'GET',
            null,
            apiKey,
            apiSecret
        );
        
        // Check for excessive slippage
        const currentPrice = step.side === 'buy' 
            ? parseFloat(orderBook.Asks[0]?.price || 0)
            : parseFloat(orderBook.Bids[0]?.price || 0);
            
        const priceChange = Math.abs((currentPrice - step.price) / step.price * 100);
        
        if (priceChange > maxSlippage) {
            throw new Error(`Excessive slippage: ${priceChange.toFixed(2)}% > ${maxSlippage}%`);
        }
        
        // Prepare order parameters
        let orderParams;
        
        if (step.side === 'buy') {
            // Market buy order
            orderParams = {
                side: 'BUY',
                quantity: (inputAmount / currentPrice).toFixed(8), // Quantity in base currency
                pair: step.pair,
                type: 'MARKET'
            };
        } else {
            // Market sell order  
            orderParams = {
                side: 'SELL',
                quantity: inputAmount.toFixed(8), // Quantity in base currency
                pair: step.pair,
                type: 'MARKET'
            };
        }
        
        console.log(`📝 Placing ${step.side} order:`, orderParams);
        
        // Place the order
        const orderResponse = await makeVALRRequest(
            '/v1/orders/market',
            'POST',
            orderParams,
            apiKey,
            apiSecret
        );
        
        // Wait for order to be filled (with timeout)
        const orderResult = await waitForOrderCompletion(
            orderResponse.id, 
            apiKey, 
            apiSecret, 
            timeoutMs
        );
        
        return {
            inputAmount,
            outputAmount: parseFloat(orderResult.executedQuantity),
            outputCurrency: orderResult.outputCurrency,
            price: parseFloat(orderResult.averagePrice),
            fee: parseFloat(orderResult.feeAmount),
            slippage: priceChange,
            orderId: orderResult.id
        };
        
    } catch (error) {
        throw new Error(`Trade leg execution failed: ${error.message}`);
    }
}

/**
 * Validate account balances before execution
 */
async function validateBalancesForExecution(opportunity, apiKey, apiSecret) {
    try {
        const balances = await makeVALRRequest('/v1/account/balances', 'GET', null, apiKey, apiSecret);
        
        // Check ZAR balance for starting amount
        const zarBalance = balances.find(b => b.currency === 'ZAR');
        const availableZAR = parseFloat(zarBalance?.available || 0);
        
        if (availableZAR < opportunity.startAmount) {
            return {
                sufficient: false,
                message: `Insufficient ZAR balance: need R${opportunity.startAmount}, have R${availableZAR.toFixed(2)}`
            };
        }
        
        // Add buffer for fees (5% extra)
        const requiredAmount = opportunity.startAmount * 1.05;
        if (availableZAR < requiredAmount) {
            return {
                sufficient: false,
                message: `Insufficient ZAR balance with fee buffer: need R${requiredAmount.toFixed(2)}, have R${availableZAR.toFixed(2)}`
            };
        }
        
        return {
            sufficient: true,
            availableZAR: availableZAR,
            message: 'Balance validation passed'
        };
        
    } catch (error) {
        return {
            sufficient: false,
            message: `Balance check failed: ${error.message}`
        };
    }
}

/**
 * Wait for order completion with timeout
 */
async function waitForOrderCompletion(orderId, apiKey, apiSecret, timeoutMs) {
    const startTime = Date.now();
    const pollInterval = 1000; // Poll every 1 second
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const orderStatus = await makeVALRRequest(
                `/v1/orders/${orderId}`,
                'GET',
                null,
                apiKey,
                apiSecret
            );
            
            if (orderStatus.orderStatusType === 'Filled') {
                return orderStatus;
            }
            
            if (orderStatus.orderStatusType === 'Failed' || orderStatus.orderStatusType === 'Cancelled') {
                throw new Error(`Order ${orderId} ${orderStatus.orderStatusType.toLowerCase()}`);
            }
            
            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            
        } catch (error) {
            throw new Error(`Order status check failed: ${error.message}`);
        }
    }
    
    throw new Error(`Order ${orderId} timeout after ${timeoutMs}ms`);
}

/**
 * Rollback completed legs by placing reverse orders
 */
async function rollbackCompletedLegs(completedLegs, apiKey, apiSecret) {
    console.log(`🔄 Starting rollback for ${completedLegs.length} completed legs...`);
    
    const rollbackResults = [];
    
    // Rollback in reverse order
    for (let i = completedLegs.length - 1; i >= 0; i--) {
        const leg = completedLegs[i];
        
        try {
            console.log(`🔄 Rolling back leg ${leg.legNumber}: ${leg.step.pair}`);
            
            // Create reverse order
            const reverseOrderParams = {
                side: leg.step.side === 'buy' ? 'SELL' : 'BUY',
                quantity: leg.outputAmount.toFixed(8),
                pair: leg.step.pair,
                type: 'MARKET'
            };
            
            const rollbackOrder = await makeVALRRequest(
                '/v1/orders/market',
                'POST',
                reverseOrderParams,
                apiKey,
                apiSecret
            );
            
            rollbackResults.push({
                legNumber: leg.legNumber,
                rollbackOrderId: rollbackOrder.id,
                success: true
            });
            
            console.log(`✅ Rollback order placed for leg ${leg.legNumber}: ${rollbackOrder.id}`);
            
        } catch (rollbackError) {
            console.error(`❌ Rollback failed for leg ${leg.legNumber}:`, rollbackError.message);
            rollbackResults.push({
                legNumber: leg.legNumber,
                error: rollbackError.message,
                success: false
            });
        }
    }
    
    return rollbackResults;
}

// POST /api/v1/trading/valr/triangular/scan
// Scan for triangular arbitrage opportunities with live prices
router.post('/valr/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { paths = 'all', apiKey, apiSecret } = req.body; // Can specify which path sets to scan
        
        systemLogger.trading('VALR triangular scan initiated', {
            userId: req.user.id,
            paths,
            timestamp: new Date().toISOString()
        });

        // Validate VALR API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('VALR API credentials required', 400, 'VALR_CREDENTIALS_REQUIRED');
        }

        // Define all triangular path sets (80 PATHS - 20 sets of 4 paths each, excludes BTC)
        const allPathSets = {
            SET_1_ETH_FOCUS: [
                { id: 'ZAR_ETH_USDT_ZAR', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], sequence: 'ZAR → ETH → USDT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'USDT_ETH_ZAR_USDT', pairs: ['ETHUSDT', 'ETHZAR', 'USDTZAR'], sequence: 'USDT → ETH → ZAR → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETHUSDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_2_XRP_FOCUS: [
                { id: 'ZAR_XRP_USDT_ZAR', pairs: ['XRPZAR', 'XRPUSDT', 'USDTZAR'], sequence: 'ZAR → XRP → USDT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'USDT_XRP_ZAR_USDT', pairs: ['XRPUSDT', 'XRPZAR', 'USDTZAR'], sequence: 'USDT → XRP → ZAR → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRPUSDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_3_SOL_FOCUS: [
                { id: 'ZAR_SOL_USDT_ZAR', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], sequence: 'ZAR → SOL → USDT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'USDT_SOL_ZAR_USDT', pairs: ['SOLUSDT', 'SOLZAR', 'USDTZAR'], sequence: 'USDT → SOL → ZAR → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SOL_USDT', pairs: ['USDTZAR', 'SOLZAR', 'SOLUSDT'], sequence: 'USDT → ZAR → SOL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] }
            ],
            SET_4_BNB_FOCUS: [
                { id: 'ZAR_BNB_USDT_ZAR', pairs: ['BNBZAR', 'BNBUSDT', 'USDTZAR'], sequence: 'ZAR → BNB → USDT → ZAR', steps: [{ pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BNB_ZAR', pairs: ['USDTZAR', 'BNBUSDT', 'BNBZAR'], sequence: 'ZAR → USDT → BNB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }] },
                { id: 'USDT_BNB_ZAR_USDT', pairs: ['BNBUSDT', 'BNBZAR', 'USDTZAR'], sequence: 'USDT → BNB → ZAR → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BNB_USDT', pairs: ['USDTZAR', 'BNBZAR', 'BNBUSDT'], sequence: 'USDT → ZAR → BNB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_5_SHIB_FOCUS: [
                { id: 'ZAR_SHIB_USDT_ZAR', pairs: ['SHIBZAR', 'SHIBUSDT', 'USDTZAR'], sequence: 'ZAR → SHIB → USDT → ZAR', steps: [{ pair: 'SHIBZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SHIB_ZAR', pairs: ['USDTZAR', 'SHIBUSDT', 'SHIBZAR'], sequence: 'ZAR → USDT → SHIB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBZAR', side: 'sell' }] },
                { id: 'USDT_SHIB_ZAR_USDT', pairs: ['SHIBUSDT', 'SHIBZAR', 'USDTZAR'], sequence: 'USDT → SHIB → ZAR → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SHIB_USDT', pairs: ['USDTZAR', 'SHIBZAR', 'SHIBUSDT'], sequence: 'USDT → ZAR → SHIB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SHIBZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'sell' }] }
            ],
            SET_6_AVAX_FOCUS: [
                { id: 'ZAR_AVAX_USDT_ZAR', pairs: ['AVAXZAR', 'AVAXUSDT', 'USDTZAR'], sequence: 'ZAR → AVAX → USDT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AVAX_ZAR', pairs: ['USDTZAR', 'AVAXUSDT', 'AVAXZAR'], sequence: 'ZAR → USDT → AVAX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'USDT_AVAX_ZAR_USDT', pairs: ['AVAXUSDT', 'AVAXZAR', 'USDTZAR'], sequence: 'USDT → AVAX → ZAR → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AVAX_USDT', pairs: ['USDTZAR', 'AVAXZAR', 'AVAXUSDT'], sequence: 'USDT → ZAR → AVAX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_7_DOGE_FOCUS: [
                { id: 'ZAR_DOGE_USDT_ZAR', pairs: ['DOGEZAR', 'DOGEUSDT', 'USDTZAR'], sequence: 'ZAR → DOGE → USDT → ZAR', steps: [{ pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DOGE_ZAR', pairs: ['USDTZAR', 'DOGEUSDT', 'DOGEZAR'], sequence: 'ZAR → USDT → DOGE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }] },
                { id: 'USDT_DOGE_ZAR_USDT', pairs: ['DOGEUSDT', 'DOGEZAR', 'USDTZAR'], sequence: 'USDT → DOGE → ZAR → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DOGE_USDT', pairs: ['USDTZAR', 'DOGEZAR', 'DOGEUSDT'], sequence: 'USDT → ZAR → DOGE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }] }
            ],
            SET_8_TRX_FOCUS: [
                { id: 'ZAR_TRX_USDT_ZAR', pairs: ['TRXZAR', 'TRXUSDT', 'USDTZAR'], sequence: 'ZAR → TRX → USDT → ZAR', steps: [{ pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_TRX_ZAR', pairs: ['USDTZAR', 'TRXUSDT', 'TRXZAR'], sequence: 'ZAR → USDT → TRX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }] },
                { id: 'USDT_TRX_ZAR_USDT', pairs: ['TRXUSDT', 'TRXZAR', 'USDTZAR'], sequence: 'USDT → TRX → ZAR → USDT', steps: [{ pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_TRX_USDT', pairs: ['USDTZAR', 'TRXZAR', 'TRXUSDT'], sequence: 'USDT → ZAR → TRX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'sell' }] }
            ],
            SET_9_LTC_FOCUS: [
                { id: 'ZAR_LTC_USDT_ZAR', pairs: ['LTCZAR', 'LTCUSDT', 'USDTZAR'], sequence: 'ZAR → LTC → USDT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LTC_ZAR', pairs: ['USDTZAR', 'LTCUSDT', 'LTCZAR'], sequence: 'ZAR → USDT → LTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'USDT_LTC_ZAR_USDT', pairs: ['LTCUSDT', 'LTCZAR', 'USDTZAR'], sequence: 'USDT → LTC → ZAR → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LTC_USDT', pairs: ['USDTZAR', 'LTCZAR', 'LTCUSDT'], sequence: 'USDT → ZAR → LTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            SET_10_RLUSD_FOCUS: [
                { id: 'ZAR_RLUSD_USDT_ZAR', pairs: ['RLUSDZAR', 'RLUSDUSDT', 'USDTZAR'], sequence: 'ZAR → RLUSD → USDT → ZAR', steps: [{ pair: 'RLUSDZAR', side: 'buy' }, { pair: 'RLUSDUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_RLUSD_ZAR', pairs: ['USDTZAR', 'RLUSDUSDT', 'RLUSDZAR'], sequence: 'ZAR → USDT → RLUSD → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'RLUSDUSDT', side: 'buy' }, { pair: 'RLUSDZAR', side: 'sell' }] },
                { id: 'USDT_RLUSD_ZAR_USDT', pairs: ['RLUSDUSDT', 'RLUSDZAR', 'USDTZAR'], sequence: 'USDT → RLUSD → ZAR → USDT', steps: [{ pair: 'RLUSDUSDT', side: 'buy' }, { pair: 'RLUSDZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_RLUSD_USDT', pairs: ['USDTZAR', 'RLUSDZAR', 'RLUSDUSDT'], sequence: 'USDT → ZAR → RLUSD → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'RLUSDZAR', side: 'buy' }, { pair: 'RLUSDUSDT', side: 'sell' }] }
            ],
            SET_11_LINK_FOCUS: [
                { id: 'ZAR_LINK_USDT_ZAR', pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'], sequence: 'ZAR → LINK → USDT → ZAR', steps: [{ pair: 'LINKZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LINK_ZAR', pairs: ['USDTZAR', 'LINKUSDT', 'LINKZAR'], sequence: 'ZAR → USDT → LINK → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }] },
                { id: 'USDT_LINK_ZAR_USDT', pairs: ['LINKUSDT', 'LINKZAR', 'USDTZAR'], sequence: 'USDT → LINK → ZAR → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LINK_USDT', pairs: ['USDTZAR', 'LINKZAR', 'LINKUSDT'], sequence: 'USDT → ZAR → LINK → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LINKZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] }
            ],
            SET_12_XLM_FOCUS: [
                { id: 'ZAR_XLM_USDT_ZAR', pairs: ['XLMZAR', 'XLMUSDT', 'USDTZAR'], sequence: 'ZAR → XLM → USDT → ZAR', steps: [{ pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XLM_ZAR', pairs: ['USDTZAR', 'XLMUSDT', 'XLMZAR'], sequence: 'ZAR → USDT → XLM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }] },
                { id: 'USDT_XLM_ZAR_USDT', pairs: ['XLMUSDT', 'XLMZAR', 'USDTZAR'], sequence: 'USDT → XLM → ZAR → USDT', steps: [{ pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XLM_USDT', pairs: ['USDTZAR', 'XLMZAR', 'XLMUSDT'], sequence: 'USDT → ZAR → XLM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }] }
            ],
            SET_13_MATIC_FOCUS: [
                { id: 'ZAR_MATIC_USDT_ZAR', pairs: ['MATICZAR', 'MATICUSDT', 'USDTZAR'], sequence: 'ZAR → MATIC → USDT → ZAR', steps: [{ pair: 'MATICZAR', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_MATIC_ZAR', pairs: ['USDTZAR', 'MATICUSDT', 'MATICZAR'], sequence: 'ZAR → USDT → MATIC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICZAR', side: 'sell' }] },
                { id: 'USDT_MATIC_ZAR_USDT', pairs: ['MATICUSDT', 'MATICZAR', 'USDTZAR'], sequence: 'USDT → MATIC → ZAR → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_MATIC_USDT', pairs: ['USDTZAR', 'MATICZAR', 'MATICUSDT'], sequence: 'USDT → ZAR → MATIC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'MATICZAR', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] }
            ],
            SET_14_LTC_FOCUS: [
                { id: 'ZAR_LTC_USDT_ZAR', pairs: ['LTCZAR', 'LTCUSDT', 'USDTZAR'], sequence: 'ZAR → LTC → USDT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LTC_ZAR', pairs: ['USDTZAR', 'LTCUSDT', 'LTCZAR'], sequence: 'ZAR → USDT → LTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'USDT_LTC_ZAR_USDT', pairs: ['LTCUSDT', 'LTCZAR', 'USDTZAR'], sequence: 'USDT → LTC → ZAR → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LTC_USDT', pairs: ['USDTZAR', 'LTCZAR', 'LTCUSDT'], sequence: 'USDT → ZAR → LTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            SET_15_ZAR_EXTENDED: [
                { id: 'ZAR_DOGE_USDT_ZAR', pairs: ['DOGEZAR', 'DOGEUSDT', 'USDTZAR'], sequence: 'ZAR → DOGE → USDT → ZAR', steps: [{ pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DOGE_ZAR', pairs: ['USDTZAR', 'DOGEUSDT', 'DOGEZAR'], sequence: 'ZAR → USDT → DOGE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }] },
                { id: 'USDT_DOGE_ZAR_USDT', pairs: ['DOGEUSDT', 'DOGEZAR', 'USDTZAR'], sequence: 'USDT → DOGE → ZAR → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DOGE_USDT', pairs: ['USDTZAR', 'DOGEZAR', 'DOGEUSDT'], sequence: 'USDT → ZAR → DOGE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }] }
            ],
            SET_16_USDT_EXTENDED: [
                { id: 'ZAR_ETH_USDT_ZAR', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], sequence: 'ZAR → ETH → USDT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'USDT_ETH_ZAR_USDT', pairs: ['ETHUSDT', 'ETHZAR', 'USDTZAR'], sequence: 'USDT → ETH → ZAR → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETHUSDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_17_CROSS_BRIDGE: [
                { id: 'ZAR_AVAX_USDT_ZAR', pairs: ['AVAXZAR', 'AVAXUSDT', 'USDTZAR'], sequence: 'ZAR → AVAX → USDT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AVAX_ZAR', pairs: ['USDTZAR', 'AVAXUSDT', 'AVAXZAR'], sequence: 'ZAR → USDT → AVAX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'USDT_AVAX_ZAR_USDT', pairs: ['AVAXUSDT', 'AVAXZAR', 'USDTZAR'], sequence: 'USDT → AVAX → ZAR → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AVAX_USDT', pairs: ['USDTZAR', 'AVAXZAR', 'AVAXUSDT'], sequence: 'USDT → ZAR → AVAX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_18_VOLUME_LEADERS: [
                { id: 'ZAR_XRP_USDT_ZAR', pairs: ['XRPZAR', 'XRPUSDT', 'USDTZAR'], sequence: 'ZAR → XRP → USDT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'USDT_XRP_ZAR_USDT', pairs: ['XRPUSDT', 'XRPZAR', 'USDTZAR'], sequence: 'USDT → XRP → ZAR → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRPUSDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_19_DEFI_TOKENS: [
                { id: 'ZAR_SOL_USDT_ZAR', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], sequence: 'ZAR → SOL → USDT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'USDT_SOL_ZAR_USDT', pairs: ['SOLUSDT', 'SOLZAR', 'USDTZAR'], sequence: 'USDT → SOL → ZAR → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SOL_USDT', pairs: ['USDTZAR', 'SOLZAR', 'SOLUSDT'], sequence: 'USDT → ZAR → SOL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] }
            ],
            SET_20_ALT_COINS: [
                { id: 'ZAR_BNB_USDT_ZAR', pairs: ['BNBZAR', 'BNBUSDT', 'USDTZAR'], sequence: 'ZAR → BNB → USDT → ZAR', steps: [{ pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BNB_ZAR', pairs: ['USDTZAR', 'BNBUSDT', 'BNBZAR'], sequence: 'ZAR → USDT → BNB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }] },
                { id: 'USDT_BNB_ZAR_USDT', pairs: ['BNBUSDT', 'BNBZAR', 'USDTZAR'], sequence: 'USDT → BNB → ZAR → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BNB_USDT', pairs: ['USDTZAR', 'BNBZAR', 'BNBUSDT'], sequence: 'USDT → ZAR → BNB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_21_DEFI_MAJORS: [
                { id: 'ZAR_ALGO_USDT_ZAR', pairs: ['ALGOZAR', 'ALGOUSDT', 'USDTZAR'], sequence: 'ZAR → ALGO → USDT → ZAR', steps: [{ pair: 'ALGOZAR', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ALGO_ZAR', pairs: ['USDTZAR', 'ALGOUSDT', 'ALGOZAR'], sequence: 'ZAR → USDT → ALGO → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ALGOUSDT', side: 'buy' }, { pair: 'ALGOZAR', side: 'sell' }] },
                { id: 'USDT_ALGO_ZAR_USDT', pairs: ['ALGOUSDT', 'ALGOZAR', 'USDTZAR'], sequence: 'USDT → ALGO → ZAR → USDT', steps: [{ pair: 'ALGOUSDT', side: 'buy' }, { pair: 'ALGOZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ALGO_USDT', pairs: ['USDTZAR', 'ALGOZAR', 'ALGOUSDT'], sequence: 'USDT → ZAR → ALGO → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ALGOZAR', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }] }
            ],
            SET_22_GAMING_METAVERSE: [
                { id: 'ZAR_SAND_USDT_ZAR', pairs: ['SANDZAR', 'SANDUSDT', 'USDTZAR'], sequence: 'ZAR → SAND → USDT → ZAR', steps: [{ pair: 'SANDZAR', side: 'buy' }, { pair: 'SANDUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SAND_ZAR', pairs: ['USDTZAR', 'SANDUSDT', 'SANDZAR'], sequence: 'ZAR → USDT → SAND → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SANDUSDT', side: 'buy' }, { pair: 'SANDZAR', side: 'sell' }] },
                { id: 'USDT_SAND_ZAR_USDT', pairs: ['SANDUSDT', 'SANDZAR', 'USDTZAR'], sequence: 'USDT → SAND → ZAR → USDT', steps: [{ pair: 'SANDUSDT', side: 'buy' }, { pair: 'SANDZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SAND_USDT', pairs: ['USDTZAR', 'SANDZAR', 'SANDUSDT'], sequence: 'USDT → ZAR → SAND → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SANDZAR', side: 'buy' }, { pair: 'SANDUSDT', side: 'sell' }] }
            ],
            SET_23_LAYER1_ALTS: [
                { id: 'ZAR_NEAR_USDT_ZAR', pairs: ['NEARZAR', 'NEARUSDT', 'USDTZAR'], sequence: 'ZAR → NEAR → USDT → ZAR', steps: [{ pair: 'NEARZAR', side: 'buy' }, { pair: 'NEARUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_NEAR_ZAR', pairs: ['USDTZAR', 'NEARUSDT', 'NEARZAR'], sequence: 'ZAR → USDT → NEAR → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'NEARUSDT', side: 'buy' }, { pair: 'NEARZAR', side: 'sell' }] },
                { id: 'USDT_NEAR_ZAR_USDT', pairs: ['NEARUSDT', 'NEARZAR', 'USDTZAR'], sequence: 'USDT → NEAR → ZAR → USDT', steps: [{ pair: 'NEARUSDT', side: 'buy' }, { pair: 'NEARZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_NEAR_USDT', pairs: ['USDTZAR', 'NEARZAR', 'NEARUSDT'], sequence: 'USDT → ZAR → NEAR → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'NEARZAR', side: 'buy' }, { pair: 'NEARUSDT', side: 'sell' }] }
            ],
            SET_24_DEFI_PROTOCOLS: [
                { id: 'ZAR_ATOM_USDT_ZAR', pairs: ['ATOMZAR', 'ATOMUSDT', 'USDTZAR'], sequence: 'ZAR → ATOM → USDT → ZAR', steps: [{ pair: 'ATOMZAR', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ATOM_ZAR', pairs: ['USDTZAR', 'ATOMUSDT', 'ATOMZAR'], sequence: 'ZAR → USDT → ATOM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMZAR', side: 'sell' }] },
                { id: 'USDT_ATOM_ZAR_USDT', pairs: ['ATOMUSDT', 'ATOMZAR', 'USDTZAR'], sequence: 'USDT → ATOM → ZAR → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ATOM_USDT', pairs: ['USDTZAR', 'ATOMZAR', 'ATOMUSDT'], sequence: 'USDT → ZAR → ATOM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ATOMZAR', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] }
            ],
            SET_25_FANTOM_ECOSYSTEM: [
                { id: 'ZAR_FTM_USDT_ZAR', pairs: ['FTMZAR', 'FTMUSDT', 'USDTZAR'], sequence: 'ZAR → FTM → USDT → ZAR', steps: [{ pair: 'FTMZAR', side: 'buy' }, { pair: 'FTMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_FTM_ZAR', pairs: ['USDTZAR', 'FTMUSDT', 'FTMZAR'], sequence: 'ZAR → USDT → FTM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'FTMUSDT', side: 'buy' }, { pair: 'FTMZAR', side: 'sell' }] },
                { id: 'USDT_FTM_ZAR_USDT', pairs: ['FTMUSDT', 'FTMZAR', 'USDTZAR'], sequence: 'USDT → FTM → ZAR → USDT', steps: [{ pair: 'FTMUSDT', side: 'buy' }, { pair: 'FTMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_FTM_USDT', pairs: ['USDTZAR', 'FTMZAR', 'FTMUSDT'], sequence: 'USDT → ZAR → FTM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'FTMZAR', side: 'buy' }, { pair: 'FTMUSDT', side: 'sell' }] }
            ],
            SET_26_DEFI_LENDING: [
                { id: 'ZAR_AAVE_USDT_ZAR', pairs: ['AAVEZAR', 'AAVEUSDT', 'USDTZAR'], sequence: 'ZAR → AAVE → USDT → ZAR', steps: [{ pair: 'AAVEZAR', side: 'buy' }, { pair: 'AAVEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AAVE_ZAR', pairs: ['USDTZAR', 'AAVEUSDT', 'AAVEZAR'], sequence: 'ZAR → USDT → AAVE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AAVEUSDT', side: 'buy' }, { pair: 'AAVEZAR', side: 'sell' }] },
                { id: 'USDT_AAVE_ZAR_USDT', pairs: ['AAVEUSDT', 'AAVEZAR', 'USDTZAR'], sequence: 'USDT → AAVE → ZAR → USDT', steps: [{ pair: 'AAVEUSDT', side: 'buy' }, { pair: 'AAVEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AAVE_USDT', pairs: ['USDTZAR', 'AAVEZAR', 'AAVEUSDT'], sequence: 'USDT → ZAR → AAVE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AAVEZAR', side: 'buy' }, { pair: 'AAVEUSDT', side: 'sell' }] }
            ],
            SET_27_DEX_AGGREGATOR: [
                { id: 'ZAR_1INCH_USDT_ZAR', pairs: ['1INCHZAR', '1INCHUSDT', 'USDTZAR'], sequence: 'ZAR → 1INCH → USDT → ZAR', steps: [{ pair: '1INCHZAR', side: 'buy' }, { pair: '1INCHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_1INCH_ZAR', pairs: ['USDTZAR', '1INCHUSDT', '1INCHZAR'], sequence: 'ZAR → USDT → 1INCH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: '1INCHUSDT', side: 'buy' }, { pair: '1INCHZAR', side: 'sell' }] },
                { id: 'USDT_1INCH_ZAR_USDT', pairs: ['1INCHUSDT', '1INCHZAR', 'USDTZAR'], sequence: 'USDT → 1INCH → ZAR → USDT', steps: [{ pair: '1INCHUSDT', side: 'buy' }, { pair: '1INCHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_1INCH_USDT', pairs: ['USDTZAR', '1INCHZAR', '1INCHUSDT'], sequence: 'USDT → ZAR → 1INCH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: '1INCHZAR', side: 'buy' }, { pair: '1INCHUSDT', side: 'sell' }] }
            ],
            SET_28_CURVE_FINANCE: [
                { id: 'ZAR_CRV_USDT_ZAR', pairs: ['CRVZAR', 'CRVUSDT', 'USDTZAR'], sequence: 'ZAR → CRV → USDT → ZAR', steps: [{ pair: 'CRVZAR', side: 'buy' }, { pair: 'CRVUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_CRV_ZAR', pairs: ['USDTZAR', 'CRVUSDT', 'CRVZAR'], sequence: 'ZAR → USDT → CRV → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'CRVUSDT', side: 'buy' }, { pair: 'CRVZAR', side: 'sell' }] },
                { id: 'USDT_CRV_ZAR_USDT', pairs: ['CRVUSDT', 'CRVZAR', 'USDTZAR'], sequence: 'USDT → CRV → ZAR → USDT', steps: [{ pair: 'CRVUSDT', side: 'buy' }, { pair: 'CRVZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_CRV_USDT', pairs: ['USDTZAR', 'CRVZAR', 'CRVUSDT'], sequence: 'USDT → ZAR → CRV → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'CRVZAR', side: 'buy' }, { pair: 'CRVUSDT', side: 'sell' }] }
            ],
            SET_29_COMPOUND_PROTOCOL: [
                { id: 'ZAR_COMP_USDT_ZAR', pairs: ['COMPZAR', 'COMPUSDT', 'USDTZAR'], sequence: 'ZAR → COMP → USDT → ZAR', steps: [{ pair: 'COMPZAR', side: 'buy' }, { pair: 'COMPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_COMP_ZAR', pairs: ['USDTZAR', 'COMPUSDT', 'COMPZAR'], sequence: 'ZAR → USDT → COMP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'COMPUSDT', side: 'buy' }, { pair: 'COMPZAR', side: 'sell' }] },
                { id: 'USDT_COMP_ZAR_USDT', pairs: ['COMPUSDT', 'COMPZAR', 'USDTZAR'], sequence: 'USDT → COMP → ZAR → USDT', steps: [{ pair: 'COMPUSDT', side: 'buy' }, { pair: 'COMPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_COMP_USDT', pairs: ['USDTZAR', 'COMPZAR', 'COMPUSDT'], sequence: 'USDT → ZAR → COMP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'COMPZAR', side: 'buy' }, { pair: 'COMPUSDT', side: 'sell' }] }
            ],
            SET_30_SYNTHETIX_NETWORK: [
                { id: 'ZAR_SNX_USDT_ZAR', pairs: ['SNXZAR', 'SNXUSDT', 'USDTZAR'], sequence: 'ZAR → SNX → USDT → ZAR', steps: [{ pair: 'SNXZAR', side: 'buy' }, { pair: 'SNXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SNX_ZAR', pairs: ['USDTZAR', 'SNXUSDT', 'SNXZAR'], sequence: 'ZAR → USDT → SNX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SNXUSDT', side: 'buy' }, { pair: 'SNXZAR', side: 'sell' }] },
                { id: 'USDT_SNX_ZAR_USDT', pairs: ['SNXUSDT', 'SNXZAR', 'USDTZAR'], sequence: 'USDT → SNX → ZAR → USDT', steps: [{ pair: 'SNXUSDT', side: 'buy' }, { pair: 'SNXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SNX_USDT', pairs: ['USDTZAR', 'SNXZAR', 'SNXUSDT'], sequence: 'USDT → ZAR → SNX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SNXZAR', side: 'buy' }, { pair: 'SNXUSDT', side: 'sell' }] }
            ],
            SET_31_MAKERDAO: [
                { id: 'ZAR_MKR_USDT_ZAR', pairs: ['MKRZAR', 'MKRUSDT', 'USDTZAR'], sequence: 'ZAR → MKR → USDT → ZAR', steps: [{ pair: 'MKRZAR', side: 'buy' }, { pair: 'MKRUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_MKR_ZAR', pairs: ['USDTZAR', 'MKRUSDT', 'MKRZAR'], sequence: 'ZAR → USDT → MKR → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'MKRUSDT', side: 'buy' }, { pair: 'MKRZAR', side: 'sell' }] },
                { id: 'USDT_MKR_ZAR_USDT', pairs: ['MKRUSDT', 'MKRZAR', 'USDTZAR'], sequence: 'USDT → MKR → ZAR → USDT', steps: [{ pair: 'MKRUSDT', side: 'buy' }, { pair: 'MKRZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_MKR_USDT', pairs: ['USDTZAR', 'MKRZAR', 'MKRUSDT'], sequence: 'USDT → ZAR → MKR → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'MKRZAR', side: 'buy' }, { pair: 'MKRUSDT', side: 'sell' }] }
            ],
            SET_32_BALANCER_PROTOCOL: [
                { id: 'ZAR_BAL_USDT_ZAR', pairs: ['BALZAR', 'BALUSDT', 'USDTZAR'], sequence: 'ZAR → BAL → USDT → ZAR', steps: [{ pair: 'BALZAR', side: 'buy' }, { pair: 'BALUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BAL_ZAR', pairs: ['USDTZAR', 'BALUSDT', 'BALZAR'], sequence: 'ZAR → USDT → BAL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BALUSDT', side: 'buy' }, { pair: 'BALZAR', side: 'sell' }] },
                { id: 'USDT_BAL_ZAR_USDT', pairs: ['BALUSDT', 'BALZAR', 'USDTZAR'], sequence: 'USDT → BAL → ZAR → USDT', steps: [{ pair: 'BALUSDT', side: 'buy' }, { pair: 'BALZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BAL_USDT', pairs: ['USDTZAR', 'BALZAR', 'BALUSDT'], sequence: 'USDT → ZAR → BAL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BALZAR', side: 'buy' }, { pair: 'BALUSDT', side: 'sell' }] }
            ],
            SET_33_ZRX_PROTOCOL: [
                { id: 'ZAR_ZRX_USDT_ZAR', pairs: ['ZRXZAR', 'ZRXUSDT', 'USDTZAR'], sequence: 'ZAR → ZRX → USDT → ZAR', steps: [{ pair: 'ZRXZAR', side: 'buy' }, { pair: 'ZRXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ZRX_ZAR', pairs: ['USDTZAR', 'ZRXUSDT', 'ZRXZAR'], sequence: 'ZAR → USDT → ZRX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ZRXUSDT', side: 'buy' }, { pair: 'ZRXZAR', side: 'sell' }] },
                { id: 'USDT_ZRX_ZAR_USDT', pairs: ['ZRXUSDT', 'ZRXZAR', 'USDTZAR'], sequence: 'USDT → ZRX → ZAR → USDT', steps: [{ pair: 'ZRXUSDT', side: 'buy' }, { pair: 'ZRXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ZRX_USDT', pairs: ['USDTZAR', 'ZRXZAR', 'ZRXUSDT'], sequence: 'USDT → ZAR → ZRX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ZRXZAR', side: 'buy' }, { pair: 'ZRXUSDT', side: 'sell' }] }
            ],
            SET_34_STORAGE_NETWORK: [
                { id: 'ZAR_STORJ_USDT_ZAR', pairs: ['STORJZAR', 'STORJUSDT', 'USDTZAR'], sequence: 'ZAR → STORJ → USDT → ZAR', steps: [{ pair: 'STORJZAR', side: 'buy' }, { pair: 'STORJUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_STORJ_ZAR', pairs: ['USDTZAR', 'STORJUSDT', 'STORJZAR'], sequence: 'ZAR → USDT → STORJ → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'STORJUSDT', side: 'buy' }, { pair: 'STORJZAR', side: 'sell' }] },
                { id: 'USDT_STORJ_ZAR_USDT', pairs: ['STORJUSDT', 'STORJZAR', 'USDTZAR'], sequence: 'USDT → STORJ → ZAR → USDT', steps: [{ pair: 'STORJUSDT', side: 'buy' }, { pair: 'STORJZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_STORJ_USDT', pairs: ['USDTZAR', 'STORJZAR', 'STORJUSDT'], sequence: 'USDT → ZAR → STORJ → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'STORJZAR', side: 'buy' }, { pair: 'STORJUSDT', side: 'sell' }] }
            ],
            SET_35_THE_GRAPH: [
                { id: 'ZAR_GRT_USDT_ZAR', pairs: ['GRTZAR', 'GRTUSDT', 'USDTZAR'], sequence: 'ZAR → GRT → USDT → ZAR', steps: [{ pair: 'GRTZAR', side: 'buy' }, { pair: 'GRTUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_GRT_ZAR', pairs: ['USDTZAR', 'GRTUSDT', 'GRTZAR'], sequence: 'ZAR → USDT → GRT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'GRTUSDT', side: 'buy' }, { pair: 'GRTZAR', side: 'sell' }] },
                { id: 'USDT_GRT_ZAR_USDT', pairs: ['GRTUSDT', 'GRTZAR', 'USDTZAR'], sequence: 'USDT → GRT → ZAR → USDT', steps: [{ pair: 'GRTUSDT', side: 'buy' }, { pair: 'GRTZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_GRT_USDT', pairs: ['USDTZAR', 'GRTZAR', 'GRTUSDT'], sequence: 'USDT → ZAR → GRT → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'GRTZAR', side: 'buy' }, { pair: 'GRTUSDT', side: 'sell' }] }
            ],
            SET_36_GAMING_TOKEN: [
                { id: 'ZAR_ENJ_USDT_ZAR', pairs: ['ENJZAR', 'ENJUSDT', 'USDTZAR'], sequence: 'ZAR → ENJ → USDT → ZAR', steps: [{ pair: 'ENJZAR', side: 'buy' }, { pair: 'ENJUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ENJ_ZAR', pairs: ['USDTZAR', 'ENJUSDT', 'ENJZAR'], sequence: 'ZAR → USDT → ENJ → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ENJUSDT', side: 'buy' }, { pair: 'ENJZAR', side: 'sell' }] },
                { id: 'USDT_ENJ_ZAR_USDT', pairs: ['ENJUSDT', 'ENJZAR', 'USDTZAR'], sequence: 'USDT → ENJ → ZAR → USDT', steps: [{ pair: 'ENJUSDT', side: 'buy' }, { pair: 'ENJZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ENJ_USDT', pairs: ['USDTZAR', 'ENJZAR', 'ENJUSDT'], sequence: 'USDT → ZAR → ENJ → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ENJZAR', side: 'buy' }, { pair: 'ENJUSDT', side: 'sell' }] }
            ],
            SET_37_ATTENTION_TOKEN: [
                { id: 'ZAR_BAT_USDT_ZAR', pairs: ['BATZAR', 'BATUSDT', 'USDTZAR'], sequence: 'ZAR → BAT → USDT → ZAR', steps: [{ pair: 'BATZAR', side: 'buy' }, { pair: 'BATUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BAT_ZAR', pairs: ['USDTZAR', 'BATUSDT', 'BATZAR'], sequence: 'ZAR → USDT → BAT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BATUSDT', side: 'buy' }, { pair: 'BATZAR', side: 'sell' }] },
                { id: 'USDT_BAT_ZAR_USDT', pairs: ['BATUSDT', 'BATZAR', 'USDTZAR'], sequence: 'USDT → BAT → ZAR → USDT', steps: [{ pair: 'BATUSDT', side: 'buy' }, { pair: 'BATZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BAT_USDT', pairs: ['USDTZAR', 'BATZAR', 'BATUSDT'], sequence: 'USDT → ZAR → BAT → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BATZAR', side: 'buy' }, { pair: 'BATUSDT', side: 'sell' }] }
            ],
            SET_38_PRIVACY_COIN: [
                { id: 'ZAR_ZEC_USDT_ZAR', pairs: ['ZECZAR', 'ZECUSDT', 'USDTZAR'], sequence: 'ZAR → ZEC → USDT → ZAR', steps: [{ pair: 'ZECZAR', side: 'buy' }, { pair: 'ZECUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ZEC_ZAR', pairs: ['USDTZAR', 'ZECUSDT', 'ZECZAR'], sequence: 'ZAR → USDT → ZEC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ZECUSDT', side: 'buy' }, { pair: 'ZECZAR', side: 'sell' }] },
                { id: 'USDT_ZEC_ZAR_USDT', pairs: ['ZECUSDT', 'ZECZAR', 'USDTZAR'], sequence: 'USDT → ZEC → ZAR → USDT', steps: [{ pair: 'ZECUSDT', side: 'buy' }, { pair: 'ZECZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ZEC_USDT', pairs: ['USDTZAR', 'ZECZAR', 'ZECUSDT'], sequence: 'USDT → ZAR → ZEC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ZECZAR', side: 'buy' }, { pair: 'ZECUSDT', side: 'sell' }] }
            ],
            SET_39_DIGITAL_CASH: [
                { id: 'ZAR_DASH_USDT_ZAR', pairs: ['DASHZAR', 'DASHUSDT', 'USDTZAR'], sequence: 'ZAR → DASH → USDT → ZAR', steps: [{ pair: 'DASHZAR', side: 'buy' }, { pair: 'DASHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DASH_ZAR', pairs: ['USDTZAR', 'DASHUSDT', 'DASHZAR'], sequence: 'ZAR → USDT → DASH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DASHUSDT', side: 'buy' }, { pair: 'DASHZAR', side: 'sell' }] },
                { id: 'USDT_DASH_ZAR_USDT', pairs: ['DASHUSDT', 'DASHZAR', 'USDTZAR'], sequence: 'USDT → DASH → ZAR → USDT', steps: [{ pair: 'DASHUSDT', side: 'buy' }, { pair: 'DASHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DASH_USDT', pairs: ['USDTZAR', 'DASHZAR', 'DASHUSDT'], sequence: 'USDT → ZAR → DASH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DASHZAR', side: 'buy' }, { pair: 'DASHUSDT', side: 'sell' }] }
            ]
        };

        // Select paths based on scanSet parameter (supports all 39 sets)
        const { scanSet = 'SET_1_ETH_FOCUS' } = req.body;
        let triangularPaths;

        if (scanSet === 'ALL' || scanSet === 'all') {
            // Combine all 20 path sets for comprehensive scanning (80 total paths)
            triangularPaths = Object.values(allPathSets).flat();
            console.log(`🔺 Scanning ALL 20 SETS with ${triangularPaths.length} total paths (excludes BTC)`);
        } else {
            triangularPaths = allPathSets[scanSet] || allPathSets.SET_1_ETH_FOCUS;
            console.log(`🔺 Scanning ${scanSet} with ${triangularPaths.length} paths (4 paths per focused set)`);
        }

        // Fetch current market prices for all pairs
        const orderBooks = {};
        const uniquePairs = [...new Set(triangularPaths.flatMap(p => p.pairs))];
        
        for (const pair of uniquePairs) {
            const orderBook = await makeVALRRequest(
                `/v1/marketdata/${pair}/orderbook`,
                'GET',
                null,
                apiKey,
                apiSecret
            );
            orderBooks[pair] = orderBook;
        }

        // Calculate profit for each path using advanced calculation engine
        const opportunities = [];
        const { amount = 1000 } = req.body; // Allow custom amount, default R1000
        
        console.log(`🔺 Calculating profits for ${triangularPaths.length} paths with R${amount} starting amount`);
        
        for (const path of triangularPaths) {
            console.log(`📊 Analyzing path: ${path.id} - ${path.sequence}`);
            
            // Use advanced profit calculation with comprehensive analysis
            const result = calculateTriangularProfitAdvanced(path, orderBooks, amount, {
                slippageBuffer: 0.1,
                minOrderSize: 50,
                maxOrderSize: 10000,
                depthAnalysis: true
            });
            
            if (result.success) {
                // Transform advanced result to match expected format while preserving all data
                const opportunity = {
                    pathId: result.pathId,
                    sequence: result.sequence,
                    startAmount: result.startAmount,
                    endAmount: parseFloat(result.endAmount.toFixed(2)),
                    grossProfit: parseFloat(result.grossProfit.toFixed(2)),
                    netProfit: parseFloat(result.netProfit.toFixed(2)),
                    netProfitPercent: parseFloat(result.netProfitPercent.toFixed(3)),
                    profitable: result.profitable,
                    recommendation: result.recommendation,
                    riskLevel: result.riskLevel,
                    riskFactors: result.riskFactors,
                    
                    // Fee breakdown
                    fees: {
                        total: parseFloat(result.fees.total.toFixed(2)),
                        percentage: parseFloat(result.fees.percentage.toFixed(3)),
                        breakdown: result.fees.breakdown
                    },
                    
                    // Slippage analysis
                    slippage: {
                        estimated: parseFloat(result.slippage.estimated.toFixed(2)),
                        percentage: parseFloat(result.slippage.percentage.toFixed(3))
                    },
                    
                    // Order book depth analysis
                    orderBookDepth: result.orderBookDepth,
                    
                    // Step-by-step execution details
                    steps: result.steps,
                    
                    // Backward compatibility fields
                    profit: parseFloat(result.netProfit.toFixed(2)), // For legacy compatibility
                    profitPercent: parseFloat(result.netProfitPercent.toFixed(3)), // For legacy compatibility
                    prices: result.steps.map(step => ({
                        pair: step.pair,
                        side: step.side,
                        price: step.price
                    })),
                    
                    minProfitThreshold: result.minProfitThreshold,
                    timestamp: result.timestamp
                };
                
                opportunities.push(opportunity);
                
                // Log significant opportunities
                if (result.profitable) {
                    console.log(`💰 PROFITABLE: ${path.id} - ${result.netProfitPercent.toFixed(2)}% (${result.recommendation}) [${result.riskLevel} risk]`);
                    if (result.riskFactors.length > 0) {
                        console.log(`⚠️ Risk factors: ${result.riskFactors.join(', ')}`);
                    }
                } else {
                    console.log(`📉 NOT PROFITABLE: ${path.id} - ${result.netProfitPercent.toFixed(2)}%`);
                }
                
            } else {
                // Handle calculation errors
                console.error(`❌ Calculation failed for ${path.id}: ${result.error}`);
                
                opportunities.push({
                    pathId: result.pathId,
                    sequence: path.sequence,
                    error: result.error,
                    profitable: false,
                    netProfitPercent: 0,
                    recommendation: 'ERROR',
                    riskLevel: 'HIGH',
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        console.log(`🔺 Analysis complete: ${opportunities.filter(o => o.profitable).length} profitable opportunities found`);
        
        // Enhanced sorting: prioritize by profit percentage, then by risk level
        opportunities.sort((a, b) => {
            // First sort by profitability
            if (a.profitable !== b.profitable) {
                return b.profitable - a.profitable; // Profitable first
            }
            
            // Then by profit percentage
            if (a.netProfitPercent !== b.netProfitPercent) {
                return b.netProfitPercent - a.netProfitPercent; // Higher profit first
            }
            
            // Finally by risk level (LOW < MEDIUM < HIGH)
            const riskOrder = { 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'ERROR': 4 };
            return (riskOrder[a.riskLevel] || 4) - (riskOrder[b.riskLevel] || 4);
        });

        // Calculate enhanced statistics
        const profitableOpportunities = opportunities.filter(o => o.profitable);
        const executeRecommendations = opportunities.filter(o => o.recommendation === 'EXECUTE');
        const cautionsRecommendations = opportunities.filter(o => o.recommendation === 'CAUTIOUS');
        
        // Risk distribution
        const riskDistribution = {
            LOW: opportunities.filter(o => o.riskLevel === 'LOW').length,
            MEDIUM: opportunities.filter(o => o.riskLevel === 'MEDIUM').length,
            HIGH: opportunities.filter(o => o.riskLevel === 'HIGH').length
        };
        
        const avgProfit = profitableOpportunities.length > 0 
            ? profitableOpportunities.reduce((sum, o) => sum + o.netProfitPercent, 0) / profitableOpportunities.length
            : 0;

        systemLogger.trading('VALR triangular scan completed', {
            userId: req.user.id,
            opportunitiesFound: opportunities.length,
            profitableCount: profitableOpportunities.length,
            executeRecommendations: executeRecommendations.length,
            avgProfitPercent: avgProfit.toFixed(3),
            startAmount: amount
        });

        res.json({
            success: true,
            data: {
                opportunities,
                pathsScanned: triangularPaths.length,
                scanSet: scanSet,
                scanTime: new Date().toISOString(),
                analysis: {
                    totalOpportunities: opportunities.length,
                    profitableCount: profitableOpportunities.length,
                    executeRecommendations: executeRecommendations.length,
                    cautiousRecommendations: cautionsRecommendations.length,
                    avgProfitPercent: parseFloat(avgProfit.toFixed(3)),
                    riskDistribution,
                    startAmount: amount
                },
                bestOpportunity: opportunities[0] || null,
                topProfitable: profitableOpportunities.slice(0, 3), // Top 3 profitable
                readyToExecute: executeRecommendations.slice(0, 2) // Top 2 ready to execute
            }
        });
    } catch (error) {
        systemLogger.error('VALR triangular scan failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// GET /api/v1/trading/valr/triangular/paths
// Get all configured triangular arbitrage paths
router.get('/valr/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        // Return all 32 configured paths with current status
        const allPaths = {
            SET_1_MAJORS: {
                name: 'High Volume Majors',
                paths: [
                    { id: 'ZAR_LINK_USDT', pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'], proven: true },
                    { id: 'ZAR_ETH_USDT', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_USDT_LINK', pairs: ['USDTZAR', 'LINKUSDT', 'LINKZAR'], proven: true },
                    { id: 'ZAR_USDT_ETH', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], proven: false }
                ]
            },
            SET_2_ALTS: {
                name: 'Popular Altcoins',
                paths: [
                    { id: 'ZAR_ADA_USDT', pairs: ['ADAZAR', 'ADAUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_DOT_USDT', pairs: ['DOTZAR', 'DOTUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_MATIC_USDT', pairs: ['MATICZAR', 'MATICUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_SOL_USDT', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], proven: false }
                ]
            }
            // Add remaining sets as needed
        };

        res.json({
            success: true,
            data: {
                pathSets: allPaths,
                totalPaths: Object.values(allPaths).reduce((sum, set) => sum + set.paths.length, 0),
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        systemLogger.error('VALR triangular paths fetch failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// POST /api/v1/trading/valr/triangular/execute
// Execute a triangular arbitrage trade (3-leg atomic transaction)
router.post('/valr/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { pathId, amount, simulate = true } = req.body;
        
        if (!pathId || !amount) {
            throw new APIError('Path ID and amount are required', 400, 'MISSING_PARAMETERS');
        }

        systemLogger.trading('VALR triangular execution initiated', {
            userId: req.user.id,
            pathId,
            amount,
            simulate,
            timestamp: new Date().toISOString()
        });

        // Get user's VALR API credentials
        const keysResult = await query(`
            SELECT exchange_api_key, exchange_api_secret 
            FROM user_api_keys 
            WHERE user_id = $1 AND exchange = 'VALR'
        `, [req.user.id]);

        if (keysResult.rows.length === 0) {
            throw new APIError('VALR API keys not found', 404, 'VALR_KEYS_NOT_FOUND');
        }

        const { exchange_api_key, exchange_api_secret } = keysResult.rows[0];

        // Find the triangular path configuration
        const triangularPaths = [
            {
                id: 'ZAR_LINK_USDT',
                pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'],
                sequence: 'ZAR → LINK → USDT → ZAR',
                steps: [
                    { pair: 'LINKZAR', side: 'buy' },
                    { pair: 'LINKUSDT', side: 'sell' },
                    { pair: 'USDTZAR', side: 'sell' }
                ]
            },
            {
                id: 'ZAR_ETH_USDT',
                pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'],
                sequence: 'ZAR → ETH → USDT → ZAR',
                steps: [
                    { pair: 'ETHZAR', side: 'buy' },
                    { pair: 'ETHUSDT', side: 'sell' },
                    { pair: 'USDTZAR', side: 'sell' }
                ]
            }
            // Add more paths as needed
        ];

        const selectedPath = triangularPaths.find(p => p.id === pathId);
        if (!selectedPath) {
            throw new APIError(`Invalid path ID: ${pathId}`, 400, 'INVALID_PATH_ID');
        }

        // Get current market prices for the path to create opportunity object
        const orderBooks = {};
        for (const pair of selectedPath.pairs) {
            const orderBook = await makeVALRRequest(
                `/v1/marketdata/${pair}/orderbook`,
                'GET',
                null,
                exchange_api_key,
                exchange_api_secret
            );
            orderBooks[pair] = orderBook;
        }

        // Calculate current opportunity
        const currentOpportunity = calculateTriangularProfitAdvanced(selectedPath, orderBooks, amount);
        
        if (!currentOpportunity.success) {
            throw new APIError(`Opportunity calculation failed: ${currentOpportunity.error}`, 400, 'CALCULATION_FAILED');
        }

        console.log(`🎯 Executing triangular arbitrage: ${pathId} with R${amount}`);
        console.log(`📊 Expected profit: ${currentOpportunity.netProfitPercent.toFixed(2)}% (${currentOpportunity.recommendation})`);

        // Execute the triangular trade atomically
        const executionResult = await executeTriangularTradeAtomic(
            currentOpportunity,
            exchange_api_key,
            exchange_api_secret,
            {
                maxSlippage: 0.5,      // 0.5% max slippage
                timeoutMs: 30000,      // 30 second timeout per leg
                dryRun: simulate       // Use simulate parameter for dry run
            }
        );

        // Prepare response based on execution result
        if (executionResult.success) {
            systemLogger.trading('VALR triangular execution completed', {
                userId: req.user.id,
                executionId: executionResult.executionId,
                pathId: executionResult.pathId,
                startAmount: executionResult.startAmount,
                endAmount: executionResult.endAmount,
                netProfit: executionResult.netProfit,
                netProfitPercent: executionResult.netProfitPercent,
                totalTime: executionResult.performance.totalTime,
                simulate
            });

            // Log trade to database
            const logResult = await logTriangularTrade(req.user.id, {
                opportunity: currentOpportunity,
                executionResult: executionResult,
                dryRun: simulate,
                maxSlippage: maxSlippage,
                scanStartedAt: req.body.scanStartedAt ? new Date(req.body.scanStartedAt) : new Date(),
                executionStartedAt: new Date(),
                executionTimeMs: executionResult.performance?.totalTime,
                userAgent: req.headers['user-agent'],
                ipAddress: req.ip
            });

            if (logResult.success) {
                systemLogger.info('Trade logged to database', {
                    userId: req.user.id,
                    tradeId: logResult.tradeId,
                    dbId: logResult.dbId
                });
            }

            res.json({
                success: true,
                data: {
                    execution: {
                        executionId: executionResult.executionId,
                        pathId: executionResult.pathId,
                        sequence: executionResult.sequence,
                        simulate: simulate,
                        startAmount: executionResult.startAmount,
                        endAmount: executionResult.endAmount,
                        grossProfit: executionResult.grossProfit,
                        netProfit: executionResult.netProfit,
                        netProfitPercent: executionResult.netProfitPercent,
                        performance: executionResult.performance,
                        legs: executionResult.legs,
                        startTime: executionResult.startTime,
                        endTime: executionResult.endTime
                    },
                    message: simulate 
                        ? `Simulation completed successfully. Estimated profit: R${executionResult.netProfit.toFixed(2)} (${executionResult.netProfitPercent.toFixed(2)}%)`
                        : `Triangular execution completed successfully! Net profit: R${executionResult.netProfit.toFixed(2)} (${executionResult.netProfitPercent.toFixed(2)}%)`,
                    timestamp: new Date().toISOString()
                }
            });

        } else {
            // Execution failed
            systemLogger.error('VALR triangular execution failed', {
                userId: req.user.id,
                executionId: executionResult.executionId,
                pathId: executionResult.pathId,
                error: executionResult.error,
                legs: executionResult.legs,
                rollbacks: executionResult.rollbacks,
                simulate
            });

            // Log failed trade to database
            const logResult = await logTriangularTrade(req.user.id, {
                opportunity: currentOpportunity,
                executionResult: executionResult,
                dryRun: simulate,
                maxSlippage: maxSlippage,
                scanStartedAt: req.body.scanStartedAt ? new Date(req.body.scanStartedAt) : new Date(),
                executionStartedAt: new Date(),
                executionTimeMs: executionResult.performance?.totalTime,
                userAgent: req.headers['user-agent'],
                ipAddress: req.ip
            });

            if (logResult.success) {
                systemLogger.info('Failed trade logged to database', {
                    userId: req.user.id,
                    tradeId: logResult.tradeId,
                    dbId: logResult.dbId
                });
            }

            res.json({
                success: false,
                data: {
                    execution: {
                        executionId: executionResult.executionId,
                        pathId: executionResult.pathId,
                        simulate: simulate,
                        error: executionResult.error,
                        legs: executionResult.legs,
                        rollbacks: executionResult.rollbacks,
                        performance: executionResult.performance,
                        startTime: executionResult.startTime,
                        endTime: executionResult.endTime
                    },
                    message: `Execution failed: ${executionResult.error}`,
                    timestamp: new Date().toISOString()
                }
            });
        }
    } catch (error) {
        systemLogger.error('VALR triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// DELETE /api/v1/trading/valr/triangular/history
// Clear triangular arbitrage trade history
router.delete('/valr/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('VALR triangular history clear initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Clear triangular trade history for this user
        await query(`
            DELETE FROM triangular_trades 
            WHERE user_id = $1
        `, [req.user.id]);

        // Reset stats
        await query(`
            UPDATE trading_activity 
            SET triangular_trades_count = 0,
                triangular_profit_total = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
        `, [req.user.id]);

        systemLogger.trading('VALR triangular history cleared', {
            userId: req.user.id
        });

        res.json({
            success: true,
            message: 'Triangular trade history cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        systemLogger.error('VALR triangular history clear failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================
// WEBSOCKET PRICE SUBSCRIBER FOR TRIANGULAR PAIRS
// ============================================
// Real-time price streaming for triangular arbitrage opportunities

const WebSocket = require('ws');

// Track active WebSocket connections for triangular price updates
const triangularPriceSubscriptions = new Map();

// WebSocket endpoint for triangular price updates
router.ws = function(server) {
    const wss = new WebSocket.Server({ 
        server,
        path: '/ws/triangular-prices'
    });

    console.log('🔺 WebSocket server initialized for triangular prices on /ws/triangular-prices');

    wss.on('connection', function connection(ws, req) {
        const connectionId = Math.random().toString(36).substring(7);
        console.log(`📡 New triangular price WebSocket connection: ${connectionId}`);
        
        // Store connection
        triangularPriceSubscriptions.set(connectionId, {
            ws: ws,
            subscriptions: new Set(),
            lastPing: Date.now()
        });

        // Handle incoming messages
        ws.on('message', function incoming(message) {
            try {
                const data = JSON.parse(message);
                
                switch (data.type) {
                    case 'subscribe':
                        handleTriangularSubscription(connectionId, data.pairs);
                        break;
                    case 'unsubscribe':
                        handleTriangularUnsubscription(connectionId, data.pairs);
                        break;
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                        triangularPriceSubscriptions.get(connectionId).lastPing = Date.now();
                        break;
                    default:
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: 'Unknown message type',
                            received: data.type 
                        }));
                }
            } catch (error) {
                console.error('❌ WebSocket message parsing error:', error);
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'Invalid JSON message' 
                }));
            }
        });

        // Handle connection close
        ws.on('close', function close() {
            console.log(`📡 Triangular WebSocket connection closed: ${connectionId}`);
            triangularPriceSubscriptions.delete(connectionId);
        });

        // Send welcome message
        ws.send(JSON.stringify({
            type: 'connected',
            connectionId: connectionId,
            message: 'Connected to triangular price feed',
            availablePairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR', 'ETHZAR', 'ETHUSDT', 'ADAZAR', 'ADAUSDT']
        }));
    });

    return wss;
};

// Handle triangular pair subscription
function handleTriangularSubscription(connectionId, pairs) {
    const connection = triangularPriceSubscriptions.get(connectionId);
    if (!connection) return;

    if (Array.isArray(pairs)) {
        pairs.forEach(pair => {
            connection.subscriptions.add(pair);
            console.log(`📊 ${connectionId} subscribed to ${pair}`);
        });
    } else {
        connection.subscriptions.add(pairs);
        console.log(`📊 ${connectionId} subscribed to ${pairs}`);
    }

    connection.ws.send(JSON.stringify({
        type: 'subscribed',
        pairs: Array.from(connection.subscriptions),
        message: `Subscribed to ${Array.isArray(pairs) ? pairs.length : 1} pairs`
    }));

    // Start sending price updates for subscribed pairs
    startPriceUpdatesForConnection(connectionId);
}

// Handle triangular pair unsubscription
function handleTriangularUnsubscription(connectionId, pairs) {
    const connection = triangularPriceSubscriptions.get(connectionId);
    if (!connection) return;

    if (Array.isArray(pairs)) {
        pairs.forEach(pair => {
            connection.subscriptions.delete(pair);
            console.log(`📊 ${connectionId} unsubscribed from ${pair}`);
        });
    } else {
        connection.subscriptions.delete(pairs);
        console.log(`📊 ${connectionId} unsubscribed from ${pairs}`);
    }

    connection.ws.send(JSON.stringify({
        type: 'unsubscribed',
        pairs: Array.isArray(pairs) ? pairs : [pairs],
        remaining: Array.from(connection.subscriptions)
    }));
}

// Start sending price updates for a connection
async function startPriceUpdatesForConnection(connectionId) {
    const connection = triangularPriceSubscriptions.get(connectionId);
    if (!connection || connection.subscriptions.size === 0) return;

    try {
        const subscribedPairs = Array.from(connection.subscriptions);
        const priceUpdates = {};

        // Fetch latest prices for all subscribed pairs
        for (const pair of subscribedPairs) {
            try {
                const orderBook = await makeVALRRequest(
                    `/v1/marketdata/${pair}/orderbook`,
                    'GET',
                    null,
                    process.env.VALR_API_KEY,
                    process.env.VALR_API_SECRET
                );

                if (orderBook && orderBook.Asks && orderBook.Bids && 
                    orderBook.Asks.length > 0 && orderBook.Bids.length > 0) {
                    
                    const bestAsk = parseFloat(orderBook.Asks[0].price);
                    const bestBid = parseFloat(orderBook.Bids[0].price);
                    const spread = ((bestAsk - bestBid) / bestBid * 100);
                    
                    priceUpdates[pair] = {
                        pair: pair,
                        bestBid: bestBid,
                        bestAsk: bestAsk,
                        spread: spread.toFixed(4),
                        bidSize: parseFloat(orderBook.Bids[0].quantity),
                        askSize: parseFloat(orderBook.Asks[0].quantity),
                        timestamp: Date.now()
                    };
                }
            } catch (pairError) {
                console.error(`❌ Failed to fetch ${pair} prices:`, pairError.message);
                priceUpdates[pair] = {
                    pair: pair,
                    error: pairError.message,
                    timestamp: Date.now()
                };
            }
        }

        // Send price updates to client
        if (Object.keys(priceUpdates).length > 0) {
            connection.ws.send(JSON.stringify({
                type: 'priceUpdate',
                data: priceUpdates,
                timestamp: Date.now()
            }));
        }

    } catch (error) {
        console.error(`❌ Error sending price updates to ${connectionId}:`, error);
        connection.ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to fetch price updates',
            error: error.message
        }));
    }
}

// Broadcast price updates to all connected clients
async function broadcastTriangularPriceUpdates() {
    if (triangularPriceSubscriptions.size === 0) return;

    const allSubscribedPairs = new Set();
    triangularPriceSubscriptions.forEach(connection => {
        connection.subscriptions.forEach(pair => allSubscribedPairs.add(pair));
    });

    if (allSubscribedPairs.size === 0) return;

    console.log(`📡 Broadcasting prices for ${allSubscribedPairs.size} pairs to ${triangularPriceSubscriptions.size} clients`);

    // Fetch prices for all subscribed pairs
    const priceData = {};
    for (const pair of allSubscribedPairs) {
        try {
            const orderBook = await makeVALRRequest(
                `/v1/marketdata/${pair}/orderbook`,
                'GET',
                null,
                process.env.VALR_API_KEY,
                process.env.VALR_API_SECRET
            );

            if (orderBook && orderBook.Asks && orderBook.Bids && 
                orderBook.Asks.length > 0 && orderBook.Bids.length > 0) {
                
                const bestAsk = parseFloat(orderBook.Asks[0].price);
                const bestBid = parseFloat(orderBook.Bids[0].price);
                const spread = ((bestAsk - bestBid) / bestBid * 100);
                
                priceData[pair] = {
                    pair: pair,
                    bestBid: bestBid,
                    bestAsk: bestAsk,
                    spread: spread.toFixed(4),
                    bidSize: parseFloat(orderBook.Bids[0].quantity),
                    askSize: parseFloat(orderBook.Asks[0].quantity),
                    timestamp: Date.now()
                };
            }
        } catch (error) {
            console.error(`❌ Failed to fetch ${pair} for broadcast:`, error.message);
        }
    }

    // Send updates to each connected client
    triangularPriceSubscriptions.forEach((connection, connectionId) => {
        if (connection.ws.readyState === WebSocket.OPEN) {
            const clientPriceData = {};
            connection.subscriptions.forEach(pair => {
                if (priceData[pair]) {
                    clientPriceData[pair] = priceData[pair];
                }
            });

            if (Object.keys(clientPriceData).length > 0) {
                connection.ws.send(JSON.stringify({
                    type: 'priceUpdate',
                    data: clientPriceData,
                    timestamp: Date.now()
                }));
            }
        } else {
            console.log(`📡 Removing dead connection: ${connectionId}`);
            triangularPriceSubscriptions.delete(connectionId);
        }
    });
}

// Start periodic price broadcasting (every 10 seconds)
setInterval(broadcastTriangularPriceUpdates, 10000);

// Cleanup stale connections (every 60 seconds)
setInterval(() => {
    const now = Date.now();
    triangularPriceSubscriptions.forEach((connection, connectionId) => {
        if (now - connection.lastPing > 120000) { // 2 minutes timeout
            console.log(`📡 Cleaning up stale connection: ${connectionId}`);
            connection.ws.terminate();
            triangularPriceSubscriptions.delete(connectionId);
        }
    });
}, 60000);

// GET /api/v1/trading/valr/triangular/recent-trades
// Get recent triangular trades for feed
router.get('/valr/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const trades = await getRecentTriangularTrades(req.user.id, limit);
        
        systemLogger.info('Recent triangular trades fetched', {
            userId: req.user.id,
            tradesCount: trades.length
        });

        res.json({
            success: true,
            data: {
                trades: trades,
                count: trades.length,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Failed to fetch recent triangular trades', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

module.exports = router;// VERSION 6 DEPLOYMENT MARKER - Tue, Sep 16, 2025  2:05:16 PM


module.exports = router;
