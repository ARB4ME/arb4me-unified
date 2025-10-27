// Momentum Trading API Routes
// Endpoints for momentum trading strategy management

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const MomentumStrategy = require('../models/MomentumStrategy');
const MomentumPosition = require('../models/MomentumPosition');
const MomentumCredentials = require('../models/MomentumCredentials');
const VALRMarketDataService = require('../services/momentum/VALRMarketDataService');
const PositionMonitorService = require('../services/momentum/PositionMonitorService');

// Import database query function for manual table initialization
const { query } = require('../database/connection');

// Initialize services
const valrService = new VALRMarketDataService();
const positionMonitor = new PositionMonitorService();

/**
 * GET /api/v1/momentum/initialize-tables
 * One-time endpoint to manually create Momentum Trading tables
 * Call this once if auto-migration fails during deployment
 */
router.get('/initialize-tables', async (req, res) => {
    try {
        await MomentumStrategy.createTable();
        await MomentumPosition.createTable();

        res.json({
            success: true,
            message: 'Momentum Trading tables initialized successfully',
            tables: [
                'momentum_strategies',
                'momentum_positions'
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
 * POST /api/v1/momentum/test-connection
 * Test API connection to exchange
 */
router.post('/test-connection', async (req, res) => {
    try {
        const { userId, exchange, apiKey, apiSecret } = req.body;

        if (!userId || !exchange || !apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                error: 'userId, exchange, apiKey, and apiSecret are required'
            });
        }

        logger.info('Testing momentum trading connection', { userId, exchange });

        const credentials = { apiKey, apiSecret };

        // Test connection based on exchange
        if (exchange.toLowerCase() === 'valr') {
            await valrService.testConnection(credentials);
        } else {
            throw new Error(`Exchange not supported: ${exchange}`);
        }

        res.json({
            success: true,
            message: `Connected to ${exchange.toUpperCase()} successfully`,
            exchange: exchange
        });

    } catch (error) {
        logger.error('Failed to test momentum trading connection', {
            userId: req.body.userId,
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
 * POST /api/v1/momentum/credentials
 * Save API credentials for an exchange
 */
router.post('/credentials', async (req, res) => {
    try {
        const { userId, exchange, apiKey, apiSecret, apiPassphrase } = req.body;

        if (!userId || !exchange || !apiKey || !apiSecret) {
            return res.status(400).json({
                success: false,
                error: 'userId, exchange, apiKey, and apiSecret are required'
            });
        }

        // Test connection before saving
        const credentials = { apiKey, apiSecret, apiPassphrase };

        if (exchange.toLowerCase() === 'valr') {
            await valrService.testConnection(credentials);
        } else {
            throw new Error(`Exchange not supported: ${exchange}`);
        }

        // Save credentials
        const saved = await MomentumCredentials.saveCredentials(userId, exchange, credentials);

        logger.info('Momentum credentials saved', { userId, exchange });

        res.json({
            success: true,
            message: `Credentials saved for ${exchange.toUpperCase()}`,
            data: {
                exchange: saved.exchange,
                isConnected: saved.is_connected,
                lastConnectedAt: saved.last_connected_at
            }
        });

    } catch (error) {
        logger.error('Failed to save momentum credentials', {
            userId: req.body.userId,
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
 * GET /api/v1/momentum/credentials
 * Get saved credentials for user and exchange (apiSecret is excluded)
 */
router.get('/credentials', async (req, res) => {
    try {
        const { userId, exchange } = req.query;

        if (!userId || !exchange) {
            return res.status(400).json({
                success: false,
                error: 'userId and exchange are required'
            });
        }

        const credentials = await MomentumCredentials.getCredentials(userId, exchange);

        if (!credentials) {
            // Return 200 with empty data instead of 404 to avoid console errors
            return res.json({
                success: true,
                data: {
                    exchange: exchange,
                    hasApiKey: false,
                    hasApiSecret: false,
                    isConnected: false,
                    lastConnectedAt: null
                }
            });
        }

        // Return credentials without apiSecret for security
        res.json({
            success: true,
            data: {
                exchange: credentials.exchange,
                hasApiKey: !!credentials.api_key,
                hasApiSecret: !!credentials.api_secret,
                isConnected: credentials.is_connected,
                lastConnectedAt: credentials.last_connected_at
            }
        });

    } catch (error) {
        logger.error('Failed to get momentum credentials', {
            userId: req.query.userId,
            exchange: req.query.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * DELETE /api/v1/momentum/credentials
 * Delete credentials for an exchange
 */
router.delete('/credentials', async (req, res) => {
    try {
        const { userId, exchange } = req.body;

        if (!userId || !exchange) {
            return res.status(400).json({
                success: false,
                error: 'userId and exchange are required'
            });
        }

        const deleted = await MomentumCredentials.deleteCredentials(userId, exchange);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                error: 'No credentials found for this exchange'
            });
        }

        logger.info('Momentum credentials deleted', { userId, exchange });

        res.json({
            success: true,
            message: `Credentials deleted for ${exchange.toUpperCase()}`
        });

    } catch (error) {
        logger.error('Failed to delete momentum credentials', {
            userId: req.body.userId,
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
 * GET /api/v1/momentum/strategies
 * Get all strategies for user and exchange
 */
router.get('/strategies', async (req, res) => {
    try {
        const { userId, exchange } = req.query;

        if (!userId || !exchange) {
            return res.status(400).json({
                success: false,
                error: 'userId and exchange are required'
            });
        }

        const strategies = await MomentumStrategy.getByUserAndExchange(userId, exchange);

        res.json({
            success: true,
            data: strategies
        });

    } catch (error) {
        logger.error('Failed to get momentum strategies', {
            userId: req.query.userId,
            exchange: req.query.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/momentum/strategies
 * Create a new momentum trading strategy
 */
router.post('/strategies', async (req, res) => {
    try {
        const {
            userId,
            exchange,
            strategyName,
            assets,
            entryLogic,
            entryIndicators,
            exitRules,
            maxTradeAmount,
            maxOpenPositions
        } = req.body;

        // Validate required fields
        if (!userId || !exchange || !strategyName || !assets || !entryLogic) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Validate assets array
        if (!Array.isArray(assets) || assets.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Assets must be a non-empty array'
            });
        }

        // Validate assets format (basic check - uppercase, alphanumeric)
        const invalidAssets = assets.filter(asset => {
            // Check if asset is valid format (uppercase letters, 2-10 chars)
            return !/^[A-Z0-9]{2,10}$/.test(asset);
        });

        if (invalidAssets.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Invalid asset format: ${invalidAssets.join(', ')}. Assets must be uppercase symbols (e.g., BTC, ETH, XRP)`
            });
        }

        // Warning: We cannot validate if pair exists on VALR without API call
        // Worker will handle invalid pairs gracefully with error logging

        // Create strategy
        const strategy = await MomentumStrategy.create({
            userId,
            exchange,
            strategyName,
            assets,
            entryIndicators,
            entryLogic,
            exitRules,
            maxTradeAmount,
            maxOpenPositions
        });

        logger.info('Momentum strategy created', {
            userId,
            strategyId: strategy.id,
            strategyName
        });

        res.json({
            success: true,
            data: strategy,
            message: 'Strategy created successfully'
        });

    } catch (error) {
        logger.error('Failed to create momentum strategy', {
            userId: req.body.userId,
            strategyName: req.body.strategyName,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/momentum/strategies/:id/toggle
 * Toggle strategy ON/OFF
 */
router.post('/strategies/:id/toggle', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }

        const strategy = await MomentumStrategy.toggle(id, userId);

        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: 'Strategy not found'
            });
        }

        logger.info('Momentum strategy toggled', {
            userId,
            strategyId: id,
            isActive: strategy.is_active
        });

        res.json({
            success: true,
            data: strategy,
            message: `Strategy ${strategy.is_active ? 'activated' : 'deactivated'}`
        });

    } catch (error) {
        logger.error('Failed to toggle momentum strategy', {
            strategyId: req.params.id,
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
 * PUT /api/v1/momentum/strategies/:id
 * Update a strategy
 */
router.put('/strategies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, ...updates } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }

        const strategy = await MomentumStrategy.update(id, userId, updates);

        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: 'Strategy not found'
            });
        }

        logger.info('Momentum strategy updated', {
            userId,
            strategyId: id
        });

        res.json({
            success: true,
            data: strategy,
            message: 'Strategy updated successfully'
        });

    } catch (error) {
        logger.error('Failed to update momentum strategy', {
            strategyId: req.params.id,
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
 * DELETE /api/v1/momentum/strategies/:id
 * Delete a strategy
 */
router.delete('/strategies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }

        const strategy = await MomentumStrategy.delete(id, userId);

        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: 'Strategy not found'
            });
        }

        logger.info('Momentum strategy deleted', {
            userId,
            strategyId: id
        });

        res.json({
            success: true,
            message: 'Strategy deleted successfully'
        });

    } catch (error) {
        logger.error('Failed to delete momentum strategy', {
            strategyId: req.params.id,
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
 * GET /api/v1/momentum/positions
 * Get positions for user and exchange
 */
router.get('/positions', async (req, res) => {
    try {
        const { userId, exchange } = req.query;

        if (!userId || !exchange) {
            return res.status(400).json({
                success: false,
                error: 'userId and exchange are required'
            });
        }

        const openPositions = await MomentumPosition.getOpenByUserAndExchange(userId, exchange);
        const closedPositions = await MomentumPosition.getClosedByUserAndExchange(userId, exchange, 50);

        res.json({
            success: true,
            data: {
                open: openPositions,
                closed: closedPositions
            }
        });

    } catch (error) {
        logger.error('Failed to get momentum positions', {
            userId: req.query.userId,
            exchange: req.query.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/momentum/positions/:id/close
 * Manually close a position
 */
router.post('/positions/:id/close', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, reason } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }

        // Get position details
        const position = await MomentumPosition.getById(id);

        if (!position) {
            return res.status(404).json({
                success: false,
                error: 'Position not found'
            });
        }

        if (position.user_id !== userId) {
            return res.status(403).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        if (position.status === 'CLOSED') {
            return res.status(400).json({
                success: false,
                error: 'Position is already closed'
            });
        }

        // Get credentials for this user/exchange
        const credentials = await MomentumCredentials.getCredentials(userId, position.exchange);

        if (!credentials) {
            return res.status(400).json({
                success: false,
                error: `No API credentials found for ${position.exchange}. Please configure credentials first.`
            });
        }

        logger.info('Manually closing momentum position', {
            userId,
            positionId: id,
            asset: position.asset,
            exchange: position.exchange
        });

        // Use PositionMonitorService to close position with real exchange execution
        const closedPosition = await positionMonitor.manualClosePosition(
            id,
            userId,
            position.exchange,
            credentials
        );

        logger.info('Momentum position closed', {
            userId,
            positionId: id,
            pnlUsdt: closedPosition.exit_pnl_usdt,
            pnlPercent: closedPosition.exit_pnl_percent
        });

        res.json({
            success: true,
            data: closedPosition,
            message: 'Position closed successfully'
        });

    } catch (error) {
        logger.error('Failed to close momentum position', {
            positionId: req.params.id,
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
 * GET /api/v1/momentum/stats
 * Get daily statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const { userId, exchange } = req.query;

        if (!userId || !exchange) {
            return res.status(400).json({
                success: false,
                error: 'userId and exchange are required'
            });
        }

        const stats = await MomentumPosition.getDailyStats(userId, exchange);

        res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        logger.error('Failed to get momentum stats', {
            userId: req.query.userId,
            exchange: req.query.exchange,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
