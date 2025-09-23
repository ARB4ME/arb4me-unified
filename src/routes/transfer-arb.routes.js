const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin, requireAdmin, optionalAuth } = require('../middleware/auth');
const { tradingRateLimit, tickerRateLimit, authenticatedRateLimit, adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { broadcastToAdmins } = require('../websocket/socketManager');

// Additional dependencies for exchange API integration
const crypto = require('crypto');
const https = require('https');

const router = express.Router();

// ============================================================================
// TRANSFER ARBITRAGE SYSTEM
// ============================================================================
// Physical arbitrage strategy: Buy on one exchange, transfer, sell on another
// Target exchanges: Bybit, OKX, MEXC, KuCoin
// Strategy: Leverage price differences across exchanges for profit
// ============================================================================

// Exchange API Helper Functions
// ----------------------------------------------------------------------------

/**
 * Make authenticated request to Bybit API
 */
async function makeBybitRequest(endpoint, method = 'GET', data = null, apiKey, apiSecret) {
    const timestamp = Date.now().toString();
    const recvWindow = '20000';

    let queryString = `timestamp=${timestamp}&recv_window=${recvWindow}`;
    if (data && method === 'GET') {
        const params = new URLSearchParams(data).toString();
        queryString += `&${params}`;
    }

    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    queryString += `&signature=${signature}`;

    const options = {
        hostname: 'api.bybit.com',
        path: `${endpoint}?${queryString}`,
        method: method,
        headers: {
            'X-BAPI-API-KEY': apiKey,
            'Content-Type': 'application/json'
        }
    };

    return makeHttpRequest(options, method === 'POST' ? JSON.stringify(data) : null);
}

/**
 * Make authenticated request to OKX API
 */
async function makeOKXRequest(endpoint, method = 'GET', data = null, apiKey, apiSecret, passphrase) {
    const timestamp = new Date().toISOString();
    const body = data ? JSON.stringify(data) : '';
    const signString = timestamp + method.toUpperCase() + endpoint + body;
    const signature = crypto.createHmac('sha256', apiSecret).update(signString).digest('base64');

    const options = {
        hostname: 'www.okx.com',
        path: endpoint,
        method: method,
        headers: {
            'OK-ACCESS-KEY': apiKey,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': passphrase,
            'Content-Type': 'application/json'
        }
    };

    return makeHttpRequest(options, body);
}

/**
 * Make authenticated request to MEXC API
 */
async function makeMEXCRequest(endpoint, method = 'GET', data = null, apiKey, apiSecret) {
    const timestamp = Date.now().toString();
    let queryString = `timestamp=${timestamp}`;

    if (data && method === 'GET') {
        const params = new URLSearchParams(data).toString();
        queryString += `&${params}`;
    }

    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    queryString += `&signature=${signature}`;

    const options = {
        hostname: 'api.mexc.com',
        path: `${endpoint}?${queryString}`,
        method: method,
        headers: {
            'X-MEXC-APIKEY': apiKey,
            'Content-Type': 'application/json'
        }
    };

    return makeHttpRequest(options, method === 'POST' ? JSON.stringify(data) : null);
}

/**
 * Make authenticated request to KuCoin API
 */
async function makeKuCoinRequest(endpoint, method = 'GET', data = null, apiKey, apiSecret, passphrase) {
    const timestamp = Date.now().toString();
    const body = data ? JSON.stringify(data) : '';
    const signString = timestamp + method.toUpperCase() + endpoint + body;
    const signature = crypto.createHmac('sha256', apiSecret).update(signString).digest('base64');

    const options = {
        hostname: 'api.kucoin.com',
        path: endpoint,
        method: method,
        headers: {
            'KC-API-KEY': apiKey,
            'KC-API-SIGN': signature,
            'KC-API-TIMESTAMP': timestamp,
            'KC-API-PASSPHRASE': crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64'),
            'KC-API-KEY-VERSION': '2',
            'Content-Type': 'application/json'
        }
    };

    return makeHttpRequest(options, body);
}

/**
 * Generic HTTP request helper
 */
function makeHttpRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else {
                        reject(new Error(`API Error: ${res.statusCode} - ${parsedData.message || responseData}`));
                    }
                } catch (parseError) {
                    reject(new Error(`Failed to parse response: ${responseData}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error(`Request Error: ${error.message}`));
        });

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

// API Endpoints
// ----------------------------------------------------------------------------

/**
 * GET /api/v1/transfer-arb/assets/discovery
 * Discover available assets across target exchanges
 */
router.get('/assets/discovery', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    systemLogger.info('Starting asset discovery across target exchanges', { userId: req.user.id });

    try {
        const discovery = {
            exchanges: ['bybit', 'okx', 'mexc', 'kucoin'],
            assets: {},
            crossExchangeAssets: [],
            totalAssets: 0,
            scanTime: new Date().toISOString()
        };

        // Get user's exchange credentials
        const credentialsResult = await query(`
            SELECT exchange_name, api_key, api_secret, api_passphrase
            FROM exchange_connections
            WHERE user_id = $1 AND exchange_name IN ('bybit', 'okx', 'mexc', 'kucoin') AND status = 'connected'
        `, [req.user.id]);

        const credentials = {};
        credentialsResult.rows.forEach(row => {
            credentials[row.exchange_name] = {
                apiKey: row.api_key,
                apiSecret: row.api_secret,
                passphrase: row.api_passphrase
            };
        });

        // Fetch asset lists from each exchange
        const exchangeAssets = {};

        // Bybit assets
        if (credentials.bybit) {
            try {
                const bybitAssets = await makeBybitRequest('/v5/market/instruments-info', 'GET', { category: 'spot' },
                    credentials.bybit.apiKey, credentials.bybit.apiSecret);
                exchangeAssets.bybit = bybitAssets.result?.list || [];
                systemLogger.info(`Fetched ${exchangeAssets.bybit.length} Bybit assets`);
            } catch (error) {
                systemLogger.error('Failed to fetch Bybit assets:', error);
                exchangeAssets.bybit = [];
            }
        }

        // OKX assets
        if (credentials.okx) {
            try {
                const okxAssets = await makeOKXRequest('/api/v5/public/instruments', 'GET', { instType: 'SPOT' },
                    credentials.okx.apiKey, credentials.okx.apiSecret, credentials.okx.passphrase);
                exchangeAssets.okx = okxAssets.data || [];
                systemLogger.info(`Fetched ${exchangeAssets.okx.length} OKX assets`);
            } catch (error) {
                systemLogger.error('Failed to fetch OKX assets:', error);
                exchangeAssets.okx = [];
            }
        }

        // MEXC assets
        if (credentials.mexc) {
            try {
                const mexcAssets = await makeMEXCRequest('/api/v3/exchangeInfo', 'GET', null,
                    credentials.mexc.apiKey, credentials.mexc.apiSecret);
                exchangeAssets.mexc = mexcAssets.symbols || [];
                systemLogger.info(`Fetched ${exchangeAssets.mexc.length} MEXC assets`);
            } catch (error) {
                systemLogger.error('Failed to fetch MEXC assets:', error);
                exchangeAssets.mexc = [];
            }
        }

        // KuCoin assets
        if (credentials.kucoin) {
            try {
                const kucoinAssets = await makeKuCoinRequest('/api/v1/symbols', 'GET', null,
                    credentials.kucoin.apiKey, credentials.kucoin.apiSecret, credentials.kucoin.passphrase);
                exchangeAssets.kucoin = kucoinAssets.data || [];
                systemLogger.info(`Fetched ${exchangeAssets.kucoin.length} KuCoin assets`);
            } catch (error) {
                systemLogger.error('Failed to fetch KuCoin assets:', error);
                exchangeAssets.kucoin = [];
            }
        }

        // Process and cross-reference assets
        discovery.assets = exchangeAssets;
        discovery.totalAssets = Object.values(exchangeAssets).reduce((sum, assets) => sum + assets.length, 0);

        // Find assets available on multiple exchanges
        const assetMap = {};
        Object.entries(exchangeAssets).forEach(([exchange, assets]) => {
            assets.forEach(asset => {
                const symbol = asset.symbol || asset.instId || asset.baseCurrency;
                if (symbol) {
                    if (!assetMap[symbol]) {
                        assetMap[symbol] = [];
                    }
                    assetMap[symbol].push(exchange);
                }
            });
        });

        // Filter for assets available on 2+ exchanges
        discovery.crossExchangeAssets = Object.entries(assetMap)
            .filter(([symbol, exchanges]) => exchanges.length >= 2)
            .map(([symbol, exchanges]) => ({ symbol, exchanges, count: exchanges.length }))
            .sort((a, b) => b.count - a.count);

        systemLogger.info(`Asset discovery completed: ${discovery.crossExchangeAssets.length} cross-exchange assets found`);

        res.json({
            success: true,
            data: discovery
        });

    } catch (error) {
        systemLogger.error('Asset discovery failed:', error);
        throw new APIError('Asset discovery failed', 500, 'DISCOVERY_ERROR');
    }
}));

/**
 * GET /api/v1/transfer-arb/test-connection
 * Test connections to target exchanges
 */
router.get('/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const results = {
        bybit: { connected: false, error: null },
        okx: { connected: false, error: null },
        mexc: { connected: false, error: null },
        kucoin: { connected: false, error: null }
    };

    // Get user's exchange credentials
    const credentialsResult = await query(`
        SELECT exchange_name, api_key, api_secret, api_passphrase
        FROM exchange_connections
        WHERE user_id = $1 AND exchange_name IN ('bybit', 'okx', 'mexc', 'kucoin')
    `, [req.user.id]);

    const credentials = {};
    credentialsResult.rows.forEach(row => {
        credentials[row.exchange_name] = {
            apiKey: row.api_key,
            apiSecret: row.api_secret,
            passphrase: row.api_passphrase
        };
    });

    // Test each exchange connection
    for (const [exchange, creds] of Object.entries(credentials)) {
        try {
            switch (exchange) {
                case 'bybit':
                    await makeBybitRequest('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' },
                        creds.apiKey, creds.apiSecret);
                    results.bybit.connected = true;
                    break;
                case 'okx':
                    await makeOKXRequest('/api/v5/account/balance', 'GET', null,
                        creds.apiKey, creds.apiSecret, creds.passphrase);
                    results.okx.connected = true;
                    break;
                case 'mexc':
                    await makeMEXCRequest('/api/v3/account', 'GET', null,
                        creds.apiKey, creds.apiSecret);
                    results.mexc.connected = true;
                    break;
                case 'kucoin':
                    await makeKuCoinRequest('/api/v1/accounts', 'GET', null,
                        creds.apiKey, creds.apiSecret, creds.passphrase);
                    results.kucoin.connected = true;
                    break;
            }
        } catch (error) {
            results[exchange].error = error.message;
        }
    }

    res.json({
        success: true,
        data: results
    });
}));

module.exports = router;