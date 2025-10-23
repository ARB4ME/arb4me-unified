// Currency Swap API Routes
// Endpoints for currency swap strategy management

const express = require('express');
const router = express.Router();
const { systemLogger } = require('../utils/logger');
const CurrencySwap = require('../models/CurrencySwap');
const CurrencySwapSettings = require('../models/CurrencySwapSettings');
const CurrencySwapCredentials = require('../models/CurrencySwapCredentials');
const currencySwapService = require('../services/currencySwapExecutionService');

// NEW: Import modular currency-swap services (using tickbox system - no AssetDeclaration needed)
const PathGeneratorService = require('../services/currency-swap/PathGeneratorService');
const RiskCalculatorService = require('../services/currency-swap/RiskCalculatorService');

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
 * POST /api/v1/currency-swap/execute
 * Execute a currency swap
 */
router.post('/execute', async (req, res) => {
    try {
        const {
            userId,
            category,
            fromCurrency,
            toCurrency,
            bridgeCurrency,
            amount,
            route
        } = req.body;

        // Validation
        if (!userId || !category || !fromCurrency || !toCurrency || !bridgeCurrency || !amount || !route) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Check if user can execute more swaps today
        const canExecute = await CurrencySwapSettings.canExecuteSwap(userId);
        if (!canExecute.canExecute) {
            return res.status(429).json({
                success: false,
                error: `Daily swap limit reached (${canExecute.maxDaily} swaps per day)`,
                dailyCount: canExecute.dailyCount,
                maxDaily: canExecute.maxDaily
            });
        }

        // Create swap record
        const swap = await CurrencySwap.create({
            userId,
            category,
            fromCurrency,
            toCurrency,
            bridgeCurrency,
            amount: parseFloat(amount),
            route,
            status: 'pending'
        });

        systemLogger.trading('Currency swap initiated', {
            swapId: swap.id,
            userId,
            from: fromCurrency,
            to: toCurrency,
            amount
        });

        // TODO: Execute swap in background
        // For now, return the swap ID and status
        // In production, this would trigger background execution

        res.json({
            success: true,
            data: {
                swapId: swap.id,
                status: swap.status,
                message: 'Currency swap initiated. Execution will begin shortly.',
                swap
            }
        });
    } catch (error) {
        systemLogger.error('Failed to execute currency swap', {
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
                const ccxt = require('ccxt');
                const exchangeClass = ccxt[exchangeLower];

                if (!exchangeClass) {
                    errors[exchange] = 'Exchange not supported';
                    continue;
                }

                const exchangeInstance = new exchangeClass({
                    apiKey: apiKey,
                    secret: apiSecret,
                    password: apiPassphrase || undefined,
                    options: {
                        defaultType: 'spot'
                    }
                });

                // Fetch balance
                const balance = await exchangeInstance.fetchBalance();

                // Extract only the requested currencies (or all if not specified)
                const exchangeBalances = {};
                const currenciesToCheck = currencies && currencies.length > 0 ? currencies : Object.keys(balance);

                for (const currency of currenciesToCheck) {
                    if (balance[currency] && balance[currency].total > 0) {
                        exchangeBalances[currency] = {
                            free: balance[currency].free || 0,
                            used: balance[currency].used || 0,
                            total: balance[currency].total || 0
                        };
                    }
                }

                balances[exchange] = exchangeBalances;

                systemLogger.trading(`Fetched ${exchange} balance`, {
                    currencies: Object.keys(exchangeBalances)
                });

            } catch (error) {
                systemLogger.error(`Failed to fetch ${exchange} balance`, {
                    error: error.message
                });
                errors[exchange] = error.message;
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
 * POST /api/v1/currency-swap/credentials
 * Save API credentials for an exchange
 */
router.post('/credentials', async (req, res) => {
    try {
        const { userId, exchange, apiKey, apiSecret, apiPassphrase, memo } = req.body;

        if (!userId || !exchange || !apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, exchange, apiKey, apiSecret'
            });
        }

        await CurrencySwapCredentials.saveCredentials(userId, exchange, {
            apiKey,
            apiSecret,
            apiPassphrase,
            memo
        });

        systemLogger.trading('Currency Swap credentials saved', {
            userId,
            exchange
        });

        res.json({
            success: true,
            message: `Credentials saved for ${exchange}`
        });
    } catch (error) {
        systemLogger.error('Failed to save credentials', {
            exchange: req.body.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/credentials
 * Get all saved credentials for a user (API keys masked)
 */
router.get('/credentials', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        const credentials = await CurrencySwapCredentials.getAllCredentials(userId);

        // Mask API keys for security (only show last 4 characters)
        const maskedCredentials = credentials.map(cred => ({
            exchange: cred.exchange,
            apiKey: '***' + cred.apiKey.slice(-4),
            hasSecret: !!cred.apiSecret,
            hasPassphrase: !!cred.apiPassphrase,
            hasMemo: !!cred.memo,
            depositAddresses: cred.depositAddresses,
            isConnected: cred.isConnected,
            lastConnectedAt: cred.lastConnectedAt
        }));

        res.json({
            success: true,
            data: maskedCredentials
        });
    } catch (error) {
        systemLogger.error('Failed to get credentials', {
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/credentials/:exchange
 * Get credentials for a specific exchange (for internal use, returns decrypted)
 */
router.get('/credentials/:exchange', async (req, res) => {
    try {
        const { exchange } = req.params;
        const userId = req.query.userId || 1;

        const credentials = await CurrencySwapCredentials.getCredentials(userId, exchange);

        if (!credentials) {
            return res.status(404).json({
                success: false,
                error: `No credentials found for ${exchange}`
            });
        }

        res.json({
            success: true,
            data: credentials
        });
    } catch (error) {
        systemLogger.error('Failed to get exchange credentials', {
            exchange: req.params.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/currency-swap/credentials/:exchange/deposit-addresses
 * Update deposit addresses for an exchange
 */
router.post('/credentials/:exchange/deposit-addresses', async (req, res) => {
    try {
        const { exchange } = req.params;
        const { userId, depositAddresses } = req.body;

        if (!userId || !depositAddresses) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, depositAddresses'
            });
        }

        const updated = await CurrencySwapCredentials.updateDepositAddresses(
            userId,
            exchange,
            depositAddresses
        );

        if (updated) {
            systemLogger.trading('Deposit addresses updated', {
                userId,
                exchange,
                currencies: Object.keys(depositAddresses)
            });

            res.json({
                success: true,
                message: `Deposit addresses updated for ${exchange}`
            });
        } else {
            res.status(404).json({
                success: false,
                error: `Exchange ${exchange} not found or not connected`
            });
        }
    } catch (error) {
        systemLogger.error('Failed to update deposit addresses', {
            exchange: req.params.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * DELETE /api/v1/currency-swap/credentials/:exchange
 * Delete credentials for an exchange
 */
router.delete('/credentials/:exchange', async (req, res) => {
    try {
        const { exchange } = req.params;
        const userId = req.query.userId || 1;

        const deleted = await CurrencySwapCredentials.deleteCredentials(userId, exchange);

        if (deleted) {
            systemLogger.trading('Currency Swap credentials deleted', {
                userId,
                exchange
            });

            res.json({
                success: true,
                message: `Credentials deleted for ${exchange}`
            });
        } else {
            res.status(404).json({
                success: false,
                error: `No credentials found for ${exchange}`
            });
        }
    } catch (error) {
        systemLogger.error('Failed to delete credentials', {
            exchange: req.params.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/currency-swap/connected-exchanges
 * Get list of connected exchanges
 */
router.get('/connected-exchanges', async (req, res) => {
    try {
        const userId = req.query.userId || 1;

        const connectedExchanges = await CurrencySwapCredentials.getConnectedExchanges(userId);

        res.json({
            success: true,
            data: connectedExchanges
        });
    } catch (error) {
        systemLogger.error('Failed to get connected exchanges', {
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

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
