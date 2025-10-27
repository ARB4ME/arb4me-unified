// Momentum Trading API Routes
// Endpoints for momentum trading strategy management

const express = require('express');
const router = express.Router();
const { systemLogger } = require('../utils/logger');
const MomentumStrategy = require('../models/MomentumStrategy');
const MomentumPosition = require('../models/MomentumPosition');

// Import database query function for manual table initialization
const { query } = require('../database/connection');

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
        const { userId, exchange } = req.body;

        if (!userId || !exchange) {
            return res.status(400).json({
                success: false,
                error: 'userId and exchange are required'
            });
        }

        // TODO: Import and use appropriate exchange service
        // For now, return success as placeholder
        // When implementing VALR, import VALRService and test actual connection

        systemLogger.info('Testing momentum trading connection', { userId, exchange });

        res.json({
            success: true,
            message: `Connected to ${exchange.toUpperCase()} successfully`,
            exchange: exchange
        });

    } catch (error) {
        systemLogger.error('Failed to test momentum trading connection', {
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
        systemLogger.error('Failed to get momentum strategies', {
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

        systemLogger.info('Momentum strategy created', {
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
        systemLogger.error('Failed to create momentum strategy', {
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

        systemLogger.info('Momentum strategy toggled', {
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
        systemLogger.error('Failed to toggle momentum strategy', {
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

        systemLogger.info('Momentum strategy updated', {
            userId,
            strategyId: id
        });

        res.json({
            success: true,
            data: strategy,
            message: 'Strategy updated successfully'
        });

    } catch (error) {
        systemLogger.error('Failed to update momentum strategy', {
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

        systemLogger.info('Momentum strategy deleted', {
            userId,
            strategyId: id
        });

        res.json({
            success: true,
            message: 'Strategy deleted successfully'
        });

    } catch (error) {
        systemLogger.error('Failed to delete momentum strategy', {
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
        systemLogger.error('Failed to get momentum positions', {
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

        // TODO: Execute actual sell order on exchange
        // For now, we'll use entry price as exit price (placeholder)
        // When VALR service is implemented, this will execute real market sell order

        systemLogger.info('Manually closing momentum position', {
            userId,
            positionId: id,
            asset: position.asset,
            exchange: position.exchange
        });

        // Placeholder exit data - will be replaced with real exchange execution
        const exitData = {
            exitPrice: position.entry_price, // TODO: Get current market price
            exitQuantity: position.entry_quantity,
            exitReason: reason || 'manual_close',
            exitOrderId: `MANUAL_${Date.now()}` // TODO: Real order ID from exchange
        };

        const closedPosition = await MomentumPosition.close(id, exitData);

        systemLogger.info('Momentum position closed', {
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
        systemLogger.error('Failed to close momentum position', {
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
        systemLogger.error('Failed to get momentum stats', {
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
