// Currency Swap API Routes
// Endpoints for currency swap strategy management

const express = require('express');
const router = express.Router();
const { systemLogger } = require('../utils/logger');
const CurrencySwap = require('../models/CurrencySwap');
const CurrencySwapSettings = require('../models/CurrencySwapSettings');
const currencySwapService = require('../services/currencySwapExecutionService');

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

        systemLogger.info('Currency swap initiated', {
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

        systemLogger.info('Currency swap settings updated', {
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

        systemLogger.info(`Auto-trading ${enabled ? 'enabled' : 'disabled'}`, { userId });

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
 * GET /api/v1/currency-swap/balances
 * Get USDT and XRP balances across all exchanges
 */
router.get('/balances', async (req, res) => {
    try {
        const userId = req.query.userId || 1; // TODO: Get from auth middleware

        // TODO: Fetch real balances from exchanges
        // For now, return mock data

        const mockBalances = {
            VALR: { USDT: 2500, XRP: 1000, ZAR: 50000 },
            Luno: { USDT: 3000, XRP: 1200, ZAR: 75000 },
            ChainEX: { USDT: 1000, XRP: 500, ZAR: 25000 },
            Kraken: { USDT: 8000, XRP: 3000, USD: 10000 },
            Bybit: { USDT: 4500, XRP: 2000, EUR: 5000 }
        };

        res.json({
            success: true,
            data: {
                balances: mockBalances,
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
                dailySwapsRemaining: dailyLimit.remaining
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

module.exports = router;
