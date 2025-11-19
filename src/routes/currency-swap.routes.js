// Currency Swap API Routes
// Endpoints for currency swap strategy management

const express = require('express');
const router = express.Router();
const { systemLogger } = require('../utils/logger');
const CurrencySwap = require('../models/CurrencySwap');
const CurrencySwapSettings = require('../models/CurrencySwapSettings');
// REMOVED: CurrencySwapCredentials - credentials now managed client-side only
const currencySwapService = require('../services/currencySwapExecutionService');

// NEW: Import modular currency-swap services (using tickbox system - no AssetDeclaration needed)
const PathGeneratorService = require('../services/currency-swap/PathGeneratorService');
const RiskCalculatorService = require('../services/currency-swap/RiskCalculatorService');
const CurrencySwapScannerService = require('../services/currency-swap/CurrencySwapScannerService');
const CurrencySwapExecutionService = require('../services/currency-swap/CurrencySwapExecutionService');

// Import database query function for manual table initialization
const { query } = require('../database/connection');

/**
 * GET /api/v1/currency-swap/initialize-tables
 * One-time endpoint to manually create Currency Swap tables
 * Call this once if auto-migration fails during deployment
 */
router.get('/initialize-tables', async (req, res) => {
    try {
        // Create asset declarations table
        await query(`
            CREATE TABLE IF NOT EXISTS currency_swap_asset_declarations (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,
                funded_assets JSONB NOT NULL DEFAULT '[]',
                initial_balances JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT true,
                last_updated TIMESTAMP DEFAULT NOW(),
                notes TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_user_exchange_declaration UNIQUE(user_id, exchange)
            );
        `);

        await query(`
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_user_id ON currency_swap_asset_declarations(user_id);
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_exchange ON currency_swap_asset_declarations(exchange);
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_active ON currency_swap_asset_declarations(is_active);
        `);

        // Create balances table
        await query(`
            CREATE TABLE IF NOT EXISTS currency_swap_balances (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,
                asset VARCHAR(10) NOT NULL,
                available_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
                locked_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
                total_balance DECIMAL(20, 8) GENERATED ALWAYS AS (available_balance + locked_balance) STORED,
                last_synced_at TIMESTAMP DEFAULT NOW(),
                sync_source VARCHAR(20) DEFAULT 'api',
                sync_error TEXT,
                initial_balance DECIMAL(20, 8),
                total_profit DECIMAL(20, 8) DEFAULT 0,
                profit_percent DECIMAL(10, 4) DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_user_exchange_asset UNIQUE(user_id, exchange, asset)
            );
        `);

        await query(`
            CREATE INDEX IF NOT EXISTS idx_balances_user_exchange ON currency_swap_balances(user_id, exchange);
            CREATE INDEX IF NOT EXISTS idx_balances_user_asset ON currency_swap_balances(user_id, asset);
            CREATE INDEX IF NOT EXISTS idx_balances_asset ON currency_swap_balances(asset);
            CREATE INDEX IF NOT EXISTS idx_balances_synced ON currency_swap_balances(last_synced_at);
        `);

        // Enhance currency_swap_settings table
        await query(`
            ALTER TABLE currency_swap_settings
            ADD COLUMN IF NOT EXISTS max_concurrent_trades INTEGER DEFAULT 2 CHECK (max_concurrent_trades >= 1 AND max_concurrent_trades <= 5),
            ADD COLUMN IF NOT EXISTS max_balance_percentage DECIMAL(5,2) DEFAULT 10.0 CHECK (max_balance_percentage > 0 AND max_balance_percentage <= 50),
            ADD COLUMN IF NOT EXISTS scan_interval_seconds INTEGER DEFAULT 60 CHECK (scan_interval_seconds >= 30 AND scan_interval_seconds <= 300),
            ADD COLUMN IF NOT EXISTS balance_check_required BOOLEAN DEFAULT true,
            ADD COLUMN IF NOT EXISTS min_balance_reserve_percent DECIMAL(5,2) DEFAULT 5.0 CHECK (min_balance_reserve_percent >= 0 AND min_balance_reserve_percent <= 20);
        `);

        res.json({
            success: true,
            message: 'Currency Swap tables initialized successfully',
            tables: [
                'currency_swap_asset_declarations',
                'currency_swap_balances',
                'currency_swap_settings (enhanced)'
            ]
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/opportunities/:category
 * Get currency swap opportunities for a category
 */
router.get('/opportunities/:category', async (req, res) => {
    try {
        const { category } = req.params;
        const userId = req.query.userId || 1; // TODO: Get from auth middleware

        if (!['ZAR', 'INTERNATIONAL'].includes(category)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid category. Must be ZAR or INTERNATIONAL'
            });
        }

        const opportunities = await currencySwapService.detectCurrencySwapOpportunities(
            userId,
            category
        );

        res.json({
            success: true,
            data: {
                category,
                count: opportunities.length,
                opportunities
            }
        });
    } catch (error) {
        systemLogger.error('Failed to get currency swap opportunities', {
            category: req.params.category,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/calculate-route
 * Calculate optimal route for a currency swap
 */
router.post('/calculate-route', async (req, res) => {
    try {
        const { from, to, amount, bridgePreference } = req.body;

        if (!from || !to || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: from, to, amount'
            });
        }

        // Find all possible routes
        const routes = currencySwapService.findAllRoutes(from, to, bridgePreference || 'AUTO');

        // Calculate effective rates for each route
        const calculatedRoutes = routes.map(route => {
            // Mock prices for calculation (in production, fetch real prices)
            const mockRoute = route.path.map(p => ({
                ...p,
                rate: Math.random() * 20 + 15 // Mock rate
            }));

            const calculation = currencySwapService.calculateEffectiveRate(
                from,
                to,
                mockRoute,
                parseFloat(amount)
            );

            return {
                ...route,
                effectiveRate: calculation.effectiveRate,
                finalAmount: calculation.finalAmount,
                fees: calculation.fees,
                estimatedTime: route.type === '2-hop' ? '5-10 seconds' : '15-30 seconds'
            };
        });

        // Sort by best rate (lowest effectiveRate is better)
        calculatedRoutes.sort((a, b) => a.effectiveRate - b.effectiveRate);

        const bestRoute = calculatedRoutes[0];

        res.json({
            success: true,
            data: {
                from,
                to,
                amount,
                routesFound: calculatedRoutes.length,
                bestRoute,
                allRoutes: calculatedRoutes
            }
        });
    } catch (error) {
        systemLogger.error('Failed to calculate route', {
            body: req.body,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
/**
 * GET /api/v1/currency-swap/history
 * Get swap execution history
 */
router.get('/history', async (req, res) => {
    try {
        const userId = req.query.userId || 1; // TODO: Get from auth middleware
        const limit = parseInt(req.query.limit) || 50;
        const category = req.query.category;

        let swaps;
        if (category) {
            swaps = await CurrencySwap.findByCategory(userId, category, limit);
        } else {
            swaps = await CurrencySwap.findByUserId(userId, limit);
        }

        // Get statistics
        const stats = await CurrencySwap.getStats(userId);

        res.json({
            success: true,
            data: {
                swaps,
                stats,
                count: swaps.length
            }
        });
    } catch (error) {
        systemLogger.error('Failed to get swap history', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/settings
 * Get user's currency swap settings
 */
router.get('/settings', async (req, res) => {
    try {
        const userId = req.query.userId || 1; // TODO: Get from auth middleware

        const settings = await CurrencySwapSettings.getOrCreate(userId);

        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        systemLogger.error('Failed to get settings', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/settings
 * Update user's currency swap settings
 */
router.post('/settings', async (req, res) => {
    try {
        const { userId, ...settings } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }

        const updatedSettings = await CurrencySwapSettings.update(userId, settings);

        systemLogger.trading('Currency swap settings updated', {
            userId,
            autoTrading: settings.autoTradingEnabled
        });

        res.json({
            success: true,
            data: updatedSettings
        });
    } catch (error) {
        systemLogger.error('Failed to update settings', {
            userId: req.body.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/settings/toggle-auto
 * Toggle auto-trading on/off
 */
router.post('/settings/toggle-auto', async (req, res) => {
    try {
        const { userId, enabled } = req.body;

        if (!userId || typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'userId and enabled (boolean) are required'
            });
        }

        const settings = await CurrencySwapSettings.toggleAutoTrading(userId, enabled);

        systemLogger.trading(`Auto-trading ${enabled ? 'enabled' : 'disabled'}`, { userId });

        res.json({
            success: true,
            data: {
                autoTradingEnabled: settings.auto_trading_enabled,
                message: `Auto-trading ${enabled ? 'enabled' : 'disabled'} successfully`
            }
        });
    } catch (error) {
        systemLogger.error('Failed to toggle auto-trading', {
            userId: req.body.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/balances
 * Stateless proxy to fetch balances from exchanges (credentials sent from frontend localStorage)
 */
router.post('/balances', async (req, res) => {
    try {
        const { exchanges, currencies } = req.body;

        if (!exchanges || exchanges.length === 0) {
            return res.json({
                success: true,
                data: {
                    balances: {},
                    message: 'No exchanges provided'
                }
            });
        }

        systemLogger.trading('Fetching balances for exchanges', {
            exchangeCount: exchanges.length,
            currencyCount: currencies?.length || 0
        });

        // Fetch balances from each exchange using credentials from request
        const balances = {};
        const errors = {};

        for (const exchangeData of exchanges) {
            const { exchange, apiKey, apiSecret, apiPassphrase, memo } = exchangeData;
            const exchangeLower = exchange.toLowerCase();

            if (!apiKey || !apiSecret) {
                errors[exchange] = 'Missing credentials';
                continue;
            }

            try {
                // Use existing trading balance endpoints (they already handle each exchange's API)
                const balanceEndpoint = exchangeLower === 'chainex'
                    ? '/api/v1/trading/chainex/balance'
                    : `/api/v1/trading/${exchangeLower}/balance`;

                const requestBody = {
                    apiKey: apiKey,
                    apiSecret: apiSecret
                };

                // Add passphrase if provided (for exchanges that need it)
                if (apiPassphrase) {
                    requestBody.passphrase = apiPassphrase;
                }

                // Add memo if provided (for BitMart)
                if (memo) {
                    requestBody.memo = memo;
                }

                // Make internal API call to trading endpoint
                const axios = require('axios');
                const baseURL = process.env.NODE_ENV === 'production'
                    ? 'https://arb4me-unified-production.up.railway.app'
                    : 'http://localhost:3000';

                const response = await axios.post(`${baseURL}${balanceEndpoint}`, requestBody, {
                    timeout: 15000
                });

                if (response.data && response.data.success) {
                    // Extract balances from response
                    const rawBalances = response.data.balances || {};
                    const exchangeBalances = {};

                    // Filter to only requested currencies
                    const currenciesToCheck = currencies && currencies.length > 0 ? currencies : Object.keys(rawBalances);

                    for (const currency of currenciesToCheck) {
                        if (rawBalances[currency] && rawBalances[currency] > 0) {
                            exchangeBalances[currency] = {
                                free: rawBalances[currency],
                                used: 0,
                                total: rawBalances[currency]
                            };
                        }
                    }

                    if (Object.keys(exchangeBalances).length > 0) {
                        balances[exchange] = exchangeBalances;
                    }

                    systemLogger.trading(`Fetched ${exchange} balance via trading endpoint`, {
                        currencies: Object.keys(exchangeBalances)
                    });

                } else {
                    throw new Error(response.data?.error || 'Failed to fetch balance');
                }

            } catch (error) {
                systemLogger.error(`Failed to fetch ${exchange} balance`, {
                    error: error.message
                });
                errors[exchange] = error.response?.data?.error || error.message;
            }
        }

        res.json({
            success: true,
            data: {
                balances,
                errors: Object.keys(errors).length > 0 ? errors : undefined,
                lastUpdated: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Failed to get balances', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/wise-comparison/:from/:to
 * Compare your rate with Wise/TransferWise
 */
router.get('/wise-comparison/:from/:to', async (req, res) => {
    try {
        const { from, to } = req.params;
        const yourRate = parseFloat(req.query.rate);

        if (!yourRate) {
            return res.status(400).json({
                success: false,
                error: 'rate query parameter is required'
            });
        }

        const comparison = await currencySwapService.compareWithWiseRate(from, to, yourRate);

        res.json({
            success: true,
            data: comparison
        });
    } catch (error) {
        systemLogger.error('Failed to compare with Wise', {
            from: req.params.from,
            to: req.params.to,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/stats
 * Get overall currency swap statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const userId = req.query.userId || 1; // TODO: Get from auth middleware

        const stats = await CurrencySwap.getStats(userId);
        const recentSwaps = await CurrencySwap.getRecentSwaps(userId, 7);
        const settings = await CurrencySwapSettings.getOrCreate(userId);
        const dailyLimit = await CurrencySwapSettings.canExecuteSwap(userId);

        // Get available paths count from tickbox selections (same as Path Statistics panel)
        const pathStats = await PathGeneratorService.getPathStatistics(userId);

        res.json({
            success: true,
            data: {
                totalSwaps: parseInt(stats.total_swaps),
                completedSwaps: parseInt(stats.completed_swaps),
                failedSwaps: parseInt(stats.failed_swaps),
                totalProfit: parseFloat(stats.total_profit) || 0,
                avgProfit: parseFloat(stats.avg_profit) || 0,
                avgExecutionTime: parseInt(stats.avg_execution_time) || 0,
                recentSwaps: recentSwaps.length,
                autoTradingEnabled: settings.auto_trading_enabled,
                dailySwapsToday: dailyLimit.dailyCount,
                dailySwapsRemaining: dailyLimit.remaining,
                availablePaths: pathStats.totalPaths // From tickbox selections (same source as Path Statistics)
            }
        });
    } catch (error) {
        systemLogger.error('Failed to get stats', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/scan
 * Scan all exchanges and find best profitable arbitrage opportunity
 */
router.get('/scan', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        systemLogger.trading('Currency Swap scan initiated', { userId });

        const result = await CurrencySwapScannerService.scanOpportunities(userId);

        if (result.success && result.opportunity) {
            systemLogger.trading('Opportunity found', {
                userId,
                profit: result.opportunity.profitPercent.toFixed(2) + '%',
                path: result.opportunity.id
            });
        } else {
            systemLogger.trading('No opportunities found', {
                userId,
                scannedPaths: result.scannedPaths
            });
        }

        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        systemLogger.error('Currency Swap scan failed', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/scan-realtime
 * PUBLIC endpoint for Test Scan - scans using cached/public price data
 * Similar to Transfer Arb's scan-realtime endpoint
 */
router.post('/scan-realtime', async (req, res) => {
    try {
        const { exchanges, currencies, minProfitPercent, maxTradeAmount } = req.body;

        if (!exchanges || !currencies || exchanges.length === 0 || currencies.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'exchanges and currencies arrays are required'
            });
        }

        systemLogger.trading('[TEST SCAN] Currency Swap realtime scan initiated', {
            exchangeCount: exchanges.length,
            currencyCount: currencies.length,
            minProfit: minProfitPercent
        });

        // Import price cache service (singleton instance)
        const priceCacheService = require('../services/priceCacheService');

        // Get cached prices for all exchanges
        const priceData = {};
        for (const exchange of exchanges) {
            const exchangeLower = exchange.toLowerCase();

            // Get all cached prices for this exchange
            const prices = priceCacheService.getPrices(exchangeLower);

            // DEBUG: Show what's in cache for this exchange
            systemLogger.trading(`[TEST SCAN DEBUG] ${exchange} cache check:`, {
                hasPrices: !!prices,
                priceCount: prices ? Object.keys(prices).length : 0,
                sampleKeys: prices ? Object.keys(prices).slice(0, 5) : []
            });

            if (prices && Object.keys(prices).length > 0) {
                priceData[exchange] = {};

                // Extract XRP pairs for requested currencies
                // Note: priceCacheService stores prices as objects with bid/ask or as simple values
                for (const currency of currencies) {
                    // Try different pair formats that might be in cache
                    const possiblePairs = [
                        `XRP${currency}`,      // XRPUSDT
                        `XRP/${currency}`,     // XRP/USDT
                        `XRP-${currency}`      // XRP-USDT
                    ];

                    for (const pair of possiblePairs) {
                        if (prices[pair]) {
                            const price = prices[pair];

                            // DEBUG: Found XRP pair
                            systemLogger.trading(`[TEST SCAN DEBUG] ✅ Found ${exchange} ${pair}:`, {
                                priceType: typeof price,
                                priceValue: price
                            });

                            // Handle different price formats
                            if (typeof price === 'object') {
                                priceData[exchange][currency] = {
                                    bid: parseFloat(price.bid || price.bidPrice || price.buy || 0),
                                    ask: parseFloat(price.ask || price.askPrice || price.sell || 0),
                                    last: parseFloat(price.last || price.lastPrice || price.price || 0)
                                };
                            } else {
                                // Simple price value - use it for both bid and ask
                                const priceVal = parseFloat(price);
                                priceData[exchange][currency] = {
                                    bid: priceVal,
                                    ask: priceVal,
                                    last: priceVal
                                };
                            }
                            break; // Found the pair, stop trying other formats
                        }
                    }
                }
            }
        }

        // DEBUG: Show final price data summary
        const priceDataSummary = {};
        for (const [exch, currencies] of Object.entries(priceData)) {
            priceDataSummary[exch] = Object.keys(currencies);
        }

        systemLogger.trading('[TEST SCAN] Fetched cached prices - SUMMARY:', {
            exchangesWithData: Object.keys(priceData).length,
            totalExchangesRequested: exchanges.length,
            priceDataSummary
        });

        // Calculate all possible paths using cached prices
        const { _calculateAllPaths, _calculatePathProfit } = CurrencySwapScannerService;

        const mockSettings = {
            threshold_percent: minProfitPercent || 0.5,
            max_trade_amount_usdt: maxTradeAmount || 5000
        };

        // Filter out XRP from tradable currencies (it's bridge only)
        const tradableCurrencies = currencies.filter(c => c !== 'XRP');

        // Calculate paths
        const paths = await _calculateAllPaths.call(
            CurrencySwapScannerService,
            exchanges,
            tradableCurrencies,
            priceData,
            mockSettings
        );

        systemLogger.trading('[TEST SCAN] Path calculation complete', {
            pathsCalculated: paths.length
        });

        // Sort by profit (highest first)
        paths.sort((a, b) => b.profitPercent - a.profitPercent);

        // Get top 20 opportunities
        const topOpportunities = paths.slice(0, 20);
        const bestPath = paths.length > 0 ? paths[0] : null;

        // Extract ALL exchange-currency combinations that had price data (from ALL paths, not just top 20)
        const availablePairs = {};
        paths.forEach(path => {
            // Mark source exchange-currency as available
            if (!availablePairs[path.sourceExchange]) {
                availablePairs[path.sourceExchange] = new Set();
            }
            availablePairs[path.sourceExchange].add(path.sourceCurrency);

            // Mark destination exchange-currency as available
            if (!availablePairs[path.destExchange]) {
                availablePairs[path.destExchange] = new Set();
            }
            availablePairs[path.destExchange].add(path.destCurrency);
        });

        // Convert Sets to Arrays for JSON serialization
        const availablePairsArray = {};
        Object.keys(availablePairs).forEach(exchange => {
            availablePairsArray[exchange] = Array.from(availablePairs[exchange]);
        });

        const result = {
            success: true,
            opportunity: bestPath, // Keep for backward compatibility
            opportunities: topOpportunities, // NEW: Top 20 opportunities
            scannedPaths: paths.length,
            totalPossiblePaths: exchanges.length * (exchanges.length - 1) * tradableCurrencies.length,
            availablePairs: availablePairsArray, // NEW: All exchange-currency combos with data
            isProfitable: bestPath ? bestPath.profitPercent > 0 : false,
            meetsThreshold: bestPath ? bestPath.profitPercent >= minProfitPercent : false
        };

        if (bestPath) {
            const profitStatus = bestPath.profitPercent > 0 ?
                (result.meetsThreshold ? '✅ PROFITABLE' : '⚠️ BELOW THRESHOLD') :
                '📉 LOSS';

            systemLogger.trading(`[TEST SCAN] Best path: ${profitStatus}`, {
                path: bestPath.id,
                profit: bestPath.profitPercent.toFixed(4) + '%'
            });

            systemLogger.trading(`[TEST SCAN] Returning top ${topOpportunities.length} opportunities`, {
                profitRange: `${topOpportunities[topOpportunities.length-1].profitPercent.toFixed(4)}% to ${topOpportunities[0].profitPercent.toFixed(4)}%`
            });
        } else {
            systemLogger.trading('[TEST SCAN] No paths could be calculated (missing price data)');
        }

        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        systemLogger.error('[TEST SCAN] Currency Swap realtime scan failed', {
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/execute
 * Execute a currency swap opportunity (live trading)
 */
router.post('/execute', async (req, res) => {
    try {
        const { userId, path, amount } = req.body;

        if (!userId || !path || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, path, amount'
            });
        }

        systemLogger.trading('Currency Swap execution initiated', {
            userId,
            pathId: path.id,
            amount
        });

        const result = await CurrencySwapExecutionService.executePath(userId, path, amount);

        if (result.success) {
            systemLogger.trading('Currency Swap execution successful', {
                userId,
                pathId: path.id,
                profit: result.execution.profit,
                profitPercent: result.execution.profitPercent
            });
        } else {
            systemLogger.error('Currency Swap execution failed', {
                userId,
                pathId: path.id,
                error: result.error
            });
        }

        res.json(result);

    } catch (error) {
        systemLogger.error('Currency Swap execution error', {
            userId: req.body.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/credentials
 * Save API credentials for an exchange
 */
// ═══════════════════════════════════════════════════════════════════════
// REMOVED: Server-side credential storage endpoints
// All credentials now managed client-side via localStorage only
// Migration: security/remove-credential-storage
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ASSET DECLARATION ENDPOINTS - DEPRECATED (Using tickbox system now)
// These endpoints are no longer used since we switched to the tickbox approach
// ═══════════════════════════════════════════════════════════════════════

// NOTE: Asset declaration system replaced by tickbox system (selected_exchanges + selected_currencies)
// All path generation now uses settings-based tickbox selections instead of manual asset declarations

// ═══════════════════════════════════════════════════════════════════════
// NEW: PATH GENERATION ENDPOINTS
// Auto-generate all possible swap paths from user's declared assets
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/currency-swap/paths
 * Get all possible swap paths for a user
 */
router.get('/paths', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        // Get filter parameters
        const filters = {
            sourceExchange: req.query.sourceExchange,
            destExchange: req.query.destExchange,
            sourceAsset: req.query.sourceAsset,
            destAsset: req.query.destAsset,
            bridgeAsset: req.query.bridgeAsset
        };

        // Remove undefined filters
        Object.keys(filters).forEach(key => {
            if (!filters[key]) delete filters[key];
        });

        let paths;
        if (Object.keys(filters).length > 0) {
            paths = await PathGeneratorService.getFilteredPaths(userId, filters);
        } else {
            paths = await PathGeneratorService.generateAllPaths(userId);
        }

        res.json({
            success: true,
            data: {
                paths,
                count: paths.length,
                filters: Object.keys(filters).length > 0 ? filters : null
            }
        });
    } catch (error) {
        systemLogger.error('Failed to get paths', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/paths/stats
 * Get path statistics for user
 */
router.get('/paths/stats', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        const stats = await PathGeneratorService.getPathStatistics(userId);

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        systemLogger.error('Failed to get path stats', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/paths/grouped
 * Get paths grouped by exchange pair
 */
router.get('/paths/grouped', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        const grouped = await PathGeneratorService.getPathsByExchangePair(userId);

        res.json({
            success: true,
            data: grouped
        });
    } catch (error) {
        systemLogger.error('Failed to get grouped paths', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/paths/validate
 * Validate a specific path
 */
router.post('/paths/validate', async (req, res) => {
    try {
        const { userId, pathId } = req.body;

        if (!userId || !pathId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, pathId'
            });
        }

        const validation = await PathGeneratorService.validatePath(userId, pathId);

        res.json({
            success: true,
            data: validation
        });
    } catch (error) {
        systemLogger.error('Failed to validate path', {
            pathId: req.body.pathId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// NEW: RISK ASSESSMENT ENDPOINTS
// Calculate safe trade amounts and assess risk
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/currency-swap/risk-assessment
 * Assess risk for a specific swap path
 */
router.post('/risk-assessment', async (req, res) => {
    try {
        const { userId, path, prices } = req.body;

        if (!userId || !path) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, path'
            });
        }

        const assessment = await RiskCalculatorService.assessSwapRisk(
            userId,
            path,
            prices || {}
        );

        res.json({
            success: true,
            data: assessment
        });
    } catch (error) {
        systemLogger.error('Failed to assess swap risk', {
            userId: req.body.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/calculate-trade-amount
 * Calculate recommended trade amount for a swap
 */
router.post('/calculate-trade-amount', async (req, res) => {
    try {
        const { userId, sourceExchange, sourceAsset, prices } = req.body;

        if (!userId || !sourceExchange || !sourceAsset) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, sourceExchange, sourceAsset'
            });
        }

        const calculation = await RiskCalculatorService.calculateTradeAmount(
            userId,
            sourceExchange,
            sourceAsset,
            prices || {}
        );

        res.json({
            success: true,
            data: calculation
        });
    } catch (error) {
        systemLogger.error('Failed to calculate trade amount', {
            userId: req.body.userId,
            sourceExchange: req.body.sourceExchange,
            sourceAsset: req.body.sourceAsset,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/daily-limit-check
 * Check if user can execute more swaps today
 */
router.get('/daily-limit-check', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        const result = await RiskCalculatorService.canExecuteSwap(userId);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        systemLogger.error('Failed to check daily limit', {
            userId: req.query.userId,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
