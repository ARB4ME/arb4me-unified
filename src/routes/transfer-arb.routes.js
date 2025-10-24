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

// Import execution service
const transferExecutionService = require('../services/transferExecutionService');

// Import scanner service
const TransferArbScanner = require('../services/transfer-arb-scanner');
const fetch = require('node-fetch');

const router = express.Router();

// =============================================================================
// TRANSFER ARBITRAGE - EXCHANGE API HELPERS
// =============================================================================

// Bybit API Helper Function
async function makeBybitRequest(endpoint, method = 'GET', params = {}, apiKey, apiSecret) {
    const timestamp = Date.now().toString();
    const recv_window = '5000';

    let queryString = '';
    if (method === 'GET' && Object.keys(params).length > 0) {
        queryString = Object.entries(params)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('&');
    }

    const signaturePayload = timestamp + apiKey + recv_window + (queryString || JSON.stringify(params));
    const signature = crypto.createHmac('sha256', apiSecret).update(signaturePayload).digest('hex');

    const options = {
        hostname: 'api.bybit.com',
        path: endpoint + (queryString ? `?${queryString}` : ''),
        method: method,
        headers: {
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-SIGN': signature,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recv_window,
            'Content-Type': 'application/json'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(new Error(`Bybit API response parsing failed: ${error.message}`));
                }
            });
        });

        req.on('error', error => reject(new Error(`Bybit API request failed: ${error.message}`)));
        if (method !== 'GET') req.write(JSON.stringify(params));
        req.end();
    });
}

// OKX API Helper Function
async function makeOKXRequest(endpoint, method = 'GET', body = '', apiKey, apiSecret, passphrase) {
    const timestamp = new Date().toISOString();
    const requestPath = endpoint;
    const stringToSign = timestamp + method + requestPath + body;
    const signature = crypto.createHmac('sha256', apiSecret).update(stringToSign).digest('base64');

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

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(new Error(`OKX API response parsing failed: ${error.message}`));
                }
            });
        });

        req.on('error', error => reject(new Error(`OKX API request failed: ${error.message}`)));
        if (body) req.write(body);
        req.end();
    });
}

// MEXC API Helper Function
async function makeMEXCRequest(endpoint, method = 'GET', params = {}, apiKey, apiSecret) {
    const timestamp = Date.now();

    let queryString = Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');

    if (queryString) queryString += `&timestamp=${timestamp}`;
    else queryString = `timestamp=${timestamp}`;

    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    queryString += `&signature=${signature}`;

    const options = {
        hostname: 'api.mexc.com',
        path: endpoint + `?${queryString}`,
        method: method,
        headers: {
            'X-MEXC-APIKEY': apiKey,
            'Content-Type': 'application/json'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(new Error(`MEXC API response parsing failed: ${error.message}`));
                }
            });
        });

        req.on('error', error => reject(new Error(`MEXC API request failed: ${error.message}`)));
        req.end();
    });
}

// KuCoin API Helper Function
async function makeKuCoinRequest(endpoint, method = 'GET', body = '', apiKey, apiSecret, passphrase) {
    const timestamp = Date.now();
    const stringToSign = timestamp + method + endpoint + body;
    const signature = crypto.createHmac('sha256', apiSecret).update(stringToSign).digest('base64');
    const passphraseSignature = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');

    const options = {
        hostname: 'api.kucoin.com',
        path: endpoint,
        method: method,
        headers: {
            'KC-API-KEY': apiKey,
            'KC-API-SIGN': signature,
            'KC-API-TIMESTAMP': timestamp,
            'KC-API-PASSPHRASE': passphraseSignature,
            'KC-API-KEY-VERSION': '2',
            'Content-Type': 'application/json'
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve(parsedData);
                } catch (error) {
                    reject(new Error(`KuCoin API response parsing failed: ${error.message}`));
                }
            });
        });

        req.on('error', error => reject(new Error(`KuCoin API request failed: ${error.message}`)));
        if (body) req.write(body);
        req.end();
    });
}

// =============================================================================
// TRANSFER ARBITRAGE ENDPOINTS
// =============================================================================

// GET /api/v1/transfer-arb/assets
// Discover available assets across all 4 target exchanges
router.get('/assets', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.info('Transfer ARB asset discovery initiated', {
            userId: req.user.id,
            endpoint: 'assets'
        });

        // This will be populated with actual API calls once we integrate
        const assetDiscovery = {
            bybit: [],
            okx: [],
            mexc: [],
            kucoin: [],
            commonAssets: [],
            totalPairs: 0
        };

        // TODO: Implement actual API calls to discover assets
        // For now, return empty structure

        res.json({
            success: true,
            data: assetDiscovery,
            message: 'Asset discovery completed',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        systemLogger.error('Transfer ARB asset discovery failed', {
            userId: req.user.id,
            error: error.message,
            stack: error.stack
        });

        throw new APIError(`Transfer ARB asset discovery failed: ${error.message}`, 500, 'TRANSFER_ARB_DISCOVERY_ERROR');
    }
}));

// POST /api/v1/transfer-arb/test-connection
// Test connections to all 4 target exchanges
router.post('/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.info('Transfer ARB connection test initiated', {
            userId: req.user.id,
            endpoint: 'test-connection'
        });

        const connectionResults = {
            bybit: { connected: false, error: null },
            okx: { connected: false, error: null },
            mexc: { connected: false, error: null },
            kucoin: { connected: false, error: null }
        };

        // TODO: Implement actual connection tests
        // For now, return mock results

        res.json({
            success: true,
            data: connectionResults,
            message: 'Connection tests completed',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        systemLogger.error('Transfer ARB connection test failed', {
            userId: req.user.id,
            error: error.message,
            stack: error.stack
        });

        throw new APIError(`Transfer ARB connection test failed: ${error.message}`, 500, 'TRANSFER_ARB_CONNECTION_ERROR');
    }
}));

// POST /api/v1/transfer-arb/scan
// Scan for transfer arbitrage opportunities
router.post('/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { asset, minProfit = 1.0 } = req.body;

        systemLogger.info('Transfer ARB scan initiated', {
            userId: req.user.id,
            asset,
            minProfit,
            endpoint: 'scan'
        });

        const opportunities = [];

        // TODO: Implement actual scanning logic
        // For now, return empty opportunities

        res.json({
            success: true,
            data: {
                opportunities,
                scannedAsset: asset,
                minProfitThreshold: minProfit,
                opportunitiesFound: opportunities.length
            },
            message: 'Transfer arbitrage scan completed',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        systemLogger.error('Transfer ARB scan failed', {
            userId: req.user.id,
            error: error.message,
            stack: error.stack
        });

        throw new APIError(`Transfer ARB scan failed: ${error.message}`, 500, 'TRANSFER_ARB_SCAN_ERROR');
    }
}));

// =============================================================================
// REAL-TIME TRANSFER ARB SCANNER (Using Price Cache)
// =============================================================================

const priceCacheService = require('../services/priceCacheService');

router.post('/scan-realtime', tradingRateLimit, optionalAuth, [
    body('exchanges').isArray().withMessage('Exchanges must be an array'),
    body('cryptos').isArray().withMessage('Cryptos must be an array'),
    body('minProfitPercent').optional().isFloat({ min: 0 }).withMessage('Min profit must be a positive number'),
    body('maxTransferAmount').optional().isFloat({ min: 0 }).withMessage('Max amount must be a positive number'),
    body('maxTransferTime').optional().isFloat({ min: 0 }).withMessage('Max transfer time must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const {
        exchanges,
        cryptos,
        minProfitPercent = 2.0,
        maxTransferAmount = 10000,
        maxTransferTime = 60
    } = req.body;

    try {
        systemLogger.trading('Real-time Transfer ARB scan initiated', {
            userId: req.user?.id || 'anonymous',
            exchanges: exchanges.length,
            cryptos: cryptos.length,
            filters: { minProfitPercent, maxTransferAmount, maxTransferTime }
        });

        const opportunities = [];

        // Scan all exchange pairs
        for (let i = 0; i < exchanges.length; i++) {
            for (let j = 0; j < exchanges.length; j++) {
                if (i === j) continue; // Skip same exchange

                const fromExchange = exchanges[i];
                const toExchange = exchanges[j];

                // Get prices from cache
                const fromPrices = priceCacheService.getPrices(fromExchange, cryptos);
                const toPrices = priceCacheService.getPrices(toExchange, cryptos);

                if (!fromPrices || !toPrices) {
                    systemLogger.warn(`Missing price data for ${fromExchange} or ${toExchange}`);
                    continue;
                }

                // Check each crypto
                for (const crypto of cryptos) {
                    const symbol = `${crypto}USDT`;
                    const buyPrice = fromPrices[symbol];
                    const sellPrice = toPrices[symbol];

                    if (!buyPrice || !sellPrice) {
                        continue; // Skip if price not available
                    }

                    // Calculate opportunity
                    const opportunity = calculateTransferOpportunity(
                        crypto,
                        fromExchange,
                        toExchange,
                        buyPrice,
                        sellPrice,
                        maxTransferAmount
                    );

                    // Filter by criteria
                    if (opportunity.profitable &&
                        opportunity.netProfitPercent >= minProfitPercent &&
                        opportunity.estimatedTransferTime <= maxTransferTime) {
                        opportunities.push(opportunity);
                    }
                }
            }
        }

        // Sort by net profit %
        opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);

        systemLogger.trading('Real-time scan completed', {
            userId: req.user?.id || 'anonymous',
            routesScanned: exchanges.length * (exchanges.length - 1) * cryptos.length,
            opportunitiesFound: opportunities.length
        });

        res.json({
            success: true,
            data: {
                opportunities: opportunities.slice(0, 20), // Return top 20
                scannedAt: new Date().toISOString(),
                routesScanned: exchanges.length * (exchanges.length - 1) * cryptos.length,
                filters: { minProfitPercent, maxTransferAmount, maxTransferTime }
            }
        });

    } catch (error) {
        systemLogger.error('Real-time scan failed', {
            userId: req.user?.id || 'anonymous',
            error: error.message
        });
        throw new APIError(`Real-time scan failed: ${error.message}`, 500, 'REALTIME_SCAN_ERROR');
    }
}));

// Helper function to calculate transfer opportunity
function calculateTransferOpportunity(crypto, fromExchange, toExchange, buyPrice, sellPrice, maxAmount) {
    // Price spread
    const priceSpread = ((sellPrice - buyPrice) / buyPrice) * 100;

    // Estimate fees (simplified)
    const withdrawalFee = getWithdrawalFee(crypto, fromExchange);
    const depositFee = 0; // Most exchanges don't charge deposit fees
    const tradingFeePercent = 0.1; // 0.1% trading fee estimate

    // Calculate quantities
    const usdtToSpend = Math.min(1000, maxAmount); // Default $1000 or max
    const cryptoQuantity = usdtToSpend / buyPrice;
    const cryptoAfterWithdrawal = cryptoQuantity - withdrawalFee;

    // Calculate revenue
    const revenueUSDT = cryptoAfterWithdrawal * sellPrice;
    const tradingFees = (usdtToSpend * tradingFeePercent / 100) + (revenueUSDT * tradingFeePercent / 100);

    // Net profit
    const netProfit = revenueUSDT - usdtToSpend - tradingFees;
    const netProfitPercent = (netProfit / usdtToSpend) * 100;

    // Transfer time estimate
    const estimatedTransferTime = getTransferTime(crypto);

    // Risk score (1-10)
    const riskScore = calculateRiskScore(crypto, estimatedTransferTime, netProfitPercent);

    return {
        crypto,
        fromExchange,
        toExchange,
        buyPrice,
        sellPrice,
        priceSpread,
        usdtToSpend,
        cryptoQuantity,
        cryptoAfterWithdrawal,
        revenueUSDT,
        withdrawalFee,
        withdrawalFeeUSD: withdrawalFee * sellPrice,
        tradingFees,
        netProfit,
        netProfitPercent,
        profitable: netProfit > 0,
        estimatedTransferTime,
        riskScore,
        scannedAt: new Date().toISOString()
    };
}

// Get withdrawal fee for crypto
function getWithdrawalFee(crypto) {
    const fees = {
        'XRP': 0.25,
        'XLM': 0.01,
        'TRX': 1.0,
        'LTC': 0.001,
        'BCH': 0.0005,
        'BTC': 0.0005,
        'ETH': 0.005,
        'USDT': 1.0,
        'DOGE': 2.0,
        'ADA': 1.0,
        'DOT': 0.1
    };
    return fees[crypto] || 1.0;
}

// Get estimated transfer time
function getTransferTime(crypto) {
    const times = {
        'XRP': 3,
        'XLM': 5,
        'TRX': 3,
        'LTC': 15,
        'BCH': 15,
        'BTC': 30,
        'ETH': 10,
        'USDT': 3,
        'DOGE': 20,
        'ADA': 10,
        'DOT': 10
    };
    return times[crypto] || 20;
}

// Calculate risk score (1-10, lower is better)
function calculateRiskScore(crypto, transferTime, profitPercent) {
    let score = 5; // Base risk

    // Time risk
    if (transferTime > 30) score += 3;
    else if (transferTime > 15) score += 2;
    else if (transferTime > 5) score += 1;

    // Profit margin risk
    if (profitPercent < 2) score += 2;
    else if (profitPercent < 3) score += 1;

    // Crypto volatility risk
    const volatile = ['BTC', 'ETH', 'DOGE'];
    if (volatile.includes(crypto)) score += 1;

    return Math.min(10, score);
}

// Get price cache status
router.get('/price-cache-status', optionalAuth, asyncHandler(async (req, res) => {
    const cacheData = priceCacheService.getAllCachedData();

    res.json({
        success: true,
        data: {
            isRunning: priceCacheService.isRunning,
            updateInterval: priceCacheService.updateInterval,
            exchanges: cacheData
        }
    });
}));

// =============================================================================
// EXECUTE TRANSFER ARBITRAGE
// =============================================================================

/**
 * POST /api/v1/transfer-arb/execute
 * Execute a transfer arbitrage opportunity
 */
router.post('/execute', tradingRateLimit, optionalAuth, [
    body('opportunity').isObject().withMessage('Opportunity object is required'),
    body('opportunity.crypto').notEmpty().withMessage('Crypto symbol is required'),
    body('opportunity.fromExchange').notEmpty().withMessage('Source exchange is required'),
    body('opportunity.toExchange').notEmpty().withMessage('Destination exchange is required'),
    body('opportunity.usdtToSpend').isFloat({ min: 0 }).withMessage('Valid USDT amount is required'),
    body('credentials').isObject().withMessage('Credentials object is required'),
    body('credentials.fromExchange').isObject().withMessage('Source exchange credentials required'),
    body('credentials.fromExchange.apiKey').notEmpty().withMessage('Source API key required'),
    body('credentials.fromExchange.apiSecret').notEmpty().withMessage('Source API secret required'),
    body('credentials.toExchange').isObject().withMessage('Destination exchange credentials required'),
    body('credentials.toExchange.apiKey').notEmpty().withMessage('Destination API key required'),
    body('credentials.toExchange.apiSecret').notEmpty().withMessage('Destination API secret required'),
    body('credentials.depositAddress').notEmpty().withMessage('Deposit address is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR', errors.array());
    }

    const { opportunity, credentials } = req.body;

    systemLogger.trading('Transfer ARB execution initiated', {
        userId: req.user?.id || 'anonymous',
        crypto: opportunity.crypto,
        fromExchange: opportunity.fromExchange,
        toExchange: opportunity.toExchange,
        expectedProfit: opportunity.netProfit
    });

    try {
        // Check if a transfer is already in progress
        if (transferExecutionService.isTransferInProgress()) {
            throw new APIError(
                'A transfer is already in progress. Please wait for it to complete.',
                409,
                'TRANSFER_IN_PROGRESS'
            );
        }

        // Execute the transfer
        const result = await transferExecutionService.executeTransfer(opportunity, credentials);

        systemLogger.trading('Transfer ARB execution completed', {
            userId: req.user?.id || 'anonymous',
            transferId: result.transferId,
            actualProfit: result.actualProfit,
            duration: result.duration
        });

        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        systemLogger.error('Transfer ARB execution failed', {
            userId: req.user?.id || 'anonymous',
            error: error.message,
            stack: error.stack
        });

        throw new APIError(
            error.message || 'Transfer execution failed',
            500,
            'EXECUTION_ERROR'
        );
    }
}));

// =============================================================================
// GET TRANSFER STATUS & HISTORY
// =============================================================================

/**
 * GET /api/v1/transfer-arb/active-transfers
 * Get currently active transfers
 */
router.get('/active-transfers', tradingRateLimit, optionalAuth, asyncHandler(async (req, res) => {
    const activeTransfers = transferExecutionService.getActiveTransfers();

    res.json({
        success: true,
        data: {
            transfers: activeTransfers,
            count: activeTransfers.length,
            isExecuting: transferExecutionService.isTransferInProgress()
        }
    });
}));

/**
 * GET /api/v1/transfer-arb/scan
 * Scan for transfer arbitrage opportunities with real prices
 */
router.get('/scan', tradingRateLimit, optionalAuth, asyncHandler(async (req, res) => {
    try {
        // Get selected cryptos and exchanges from query params
        const selectedCryptos = req.query.cryptos ? JSON.parse(req.query.cryptos) : [];
        const selectedExchanges = req.query.exchanges ? JSON.parse(req.query.exchanges) : [];
        const minProfit = parseFloat(req.query.minProfit) || 2.0; // Default 2%

        systemLogger.trading('Transfer ARB scan initiated', {
            userId: req.user?.id || 'anonymous',
            cryptos: selectedCryptos.length,
            exchanges: selectedExchanges.length,
            minProfit: minProfit + '%'
        });

        if (selectedCryptos.length === 0 || selectedExchanges.length < 2) {
            return res.json({
                success: false,
                error: 'Need at least 1 crypto and 2 exchanges selected',
                data: {
                    opportunities: [],
                    routesScanned: 0
                }
            });
        }

        // Fetch real prices from all selected exchanges
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        const exchangePrices = {};

        for (const exchange of selectedExchanges) {
            exchangePrices[exchange] = {};

            for (const crypto of selectedCryptos) {
                try {
                    const pair = `${crypto}/USDT`;
                    const exchangeLower = exchange.toLowerCase();

                    const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/ticker`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pair })
                    });

                    const data = await response.json();

                    if (data.success && data.data) {
                        const price = data.data;
                        exchangePrices[exchange][crypto] = {
                            bid: parseFloat(price.bid || price.bidPrice || price.buy || 0),
                            ask: parseFloat(price.ask || price.askPrice || price.sell || 0),
                            last: parseFloat(price.last || price.lastPrice || price.price || 0)
                        };
                    }
                } catch (error) {
                    systemLogger.warn(`Failed to fetch ${exchange} ${crypto} price`, {
                        error: error.message
                    });
                }
            }
        }

        // Mock user balances (assume user has $5000 USDT on each exchange)
        // In production, this should fetch real balances from exchanges
        const userBalances = {};
        selectedExchanges.forEach(exchange => {
            userBalances[exchange] = { USDT: 5000 };
        });

        // Create scanner and run
        const scanner = new TransferArbScanner();
        const allOpportunities = await scanner.scanOpportunities(exchangePrices, userBalances);

        // Filter by selected exchanges and cryptos
        const filteredOpportunities = allOpportunities.filter(opp => {
            return selectedExchanges.includes(opp.fromExchange) &&
                   selectedExchanges.includes(opp.toExchange) &&
                   selectedCryptos.includes(opp.crypto) &&
                   opp.netProfitPercent >= minProfit;
        });

        const routesScanned = selectedExchanges.length * (selectedExchanges.length - 1) * selectedCryptos.length;

        systemLogger.trading('Transfer ARB scan complete', {
            userId: req.user?.id || 'anonymous',
            routesScanned,
            opportunitiesFound: filteredOpportunities.length,
            bestProfit: filteredOpportunities[0]?.netProfitPercent.toFixed(2) + '%' || 'N/A'
        });

        res.json({
            success: true,
            data: {
                opportunities: filteredOpportunities,
                routesScanned,
                totalOpportunities: allOpportunities.length,
                scannedAt: new Date()
            }
        });

    } catch (error) {
        systemLogger.error('Transfer ARB scan error', {
            userId: req.user?.id || 'anonymous',
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}));

/**
 * GET /api/v1/transfer-arb/history
 * Get transfer history
 */
router.get('/history', tradingRateLimit, optionalAuth, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = transferExecutionService.getTransferHistory(limit);

    res.json({
        success: true,
        data: {
            transfers: history,
            count: history.length
        }
    });
}));

module.exports = router;