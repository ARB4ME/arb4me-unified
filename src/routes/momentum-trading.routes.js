// Momentum Trading API Routes
// Endpoints for momentum trading strategy management

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const MomentumStrategy = require('../models/MomentumStrategy');
const MomentumPosition = require('../models/MomentumPosition');
const MomentumCredentials = require('../models/MomentumCredentials');
const VALRMarketDataService = require('../services/momentum/VALRMarketDataService');
const LunoMarketDataService = require('../services/momentum/LunoMarketDataService');
const ChainEXMarketDataService = require('../services/momentum/ChainEXMarketDataService');
const BinanceMarketDataService = require('../services/momentum/BinanceMarketDataService');
const OrderExecutionService = require('../services/momentum/OrderExecutionService');

// Import database query function for manual table initialization
const { query } = require('../database/connection');

// Initialize services
const valrService = new VALRMarketDataService();
const lunoService = new LunoMarketDataService();
const chainexService = new ChainEXMarketDataService();
const binanceService = new BinanceMarketDataService();
const orderExecutionService = new OrderExecutionService();

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
 * GET /api/v1/momentum/supported-pairs/:exchange
 * Get supported USDT pairs for an exchange (from backend configuration)
 * Returns only pairs that backend can fetch candle data for
 */
router.get('/supported-pairs/:exchange', async (req, res) => {
    try {
        const { exchange } = req.params;

        if (!exchange) {
            return res.status(400).json({
                success: false,
                error: 'exchange parameter is required'
            });
        }

        let supportedPairs = [];

        // Get supported pairs based on exchange
        switch (exchange.toLowerCase()) {
            case 'chainex':
                supportedPairs = chainexService.getAvailablePairs();
                break;
            case 'luno':
                supportedPairs = lunoService.getAvailablePairs();
                break;
            case 'valr':
                // VALR doesn't have hardcoded pairs - return common USDT pairs
                // Based on VALR's known USDT markets
                supportedPairs = [
                    'BTCUSDT',
                    'ETHUSDT',
                    'XRPUSDT',
                    'SOLUSDT',
                    'ADAUSDT',
                    'DOTUSDT',
                    'MATICUSDT',
                    'AVAXUSDT'
                ];
                break;
            default:
                return res.status(400).json({
                    success: false,
                    error: `Exchange not supported: ${exchange}`
                });
        }

        // Extract base currency (remove USDT suffix) for frontend display
        const baseAssets = supportedPairs.map(pair => {
            if (pair.endsWith('USDT')) {
                return pair.replace('USDT', '');
            }
            return pair;
        });

        logger.info('Supported pairs fetched from backend', {
            exchange,
            pairCount: supportedPairs.length
        });

        res.json({
            success: true,
            data: {
                exchange: exchange.toLowerCase(),
                pairs: supportedPairs,
                baseAssets: baseAssets,
                count: supportedPairs.length
            }
        });

    } catch (error) {
        logger.error('Failed to get supported pairs', {
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
 * GET /api/v1/momentum/strategies/active
 * Get all active strategies (across all users and exchanges)
 * Used by the momentum worker
 */
router.get('/strategies/active', async (req, res) => {
    try {
        const strategies = await MomentumStrategy.getAllActive();

        res.json({
            success: true,
            data: strategies
        });

    } catch (error) {
        logger.error('Failed to get active momentum strategies', {
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/momentum/strategies/:id
 * Get a single strategy by ID (regardless of active status)
 * Used by PositionMonitor to fetch exit rules for open positions
 */
router.get('/strategies/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Strategy ID is required'
            });
        }

        const strategy = await MomentumStrategy.getById(id);

        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: `Strategy not found: ${id}`
            });
        }

        res.json({
            success: true,
            data: strategy
        });

    } catch (error) {
        logger.error('Failed to get strategy by ID', {
            strategyId: req.params.id,
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
            timeframe,
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
            maxOpenPositions,
            timeframe: timeframe || '5m'  // Default to 5m if not provided
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
 * GET /api/v1/momentum/strategies/:id/can-open-position
 * Check if strategy can open new position (not at max positions limit)
 */
router.get('/strategies/:id/can-open-position', async (req, res) => {
    try {
        const { id } = req.params;

        const canOpen = await MomentumStrategy.canOpenPosition(id);

        res.json({
            success: true,
            data: canOpen
        });

    } catch (error) {
        logger.error('Failed to check if strategy can open position', {
            strategyId: req.params.id,
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
 * POST /api/v1/momentum/positions
 * Create a new position (after successful buy order)
 */
router.post('/positions', async (req, res) => {
    try {
        const {
            userId,
            strategyId,
            exchange,
            asset,
            pair,
            entryPrice,
            entryQuantity,
            entryValueUSDT,
            entryFee,
            entrySignals,
            entryOrderId
        } = req.body;

        if (!userId || !strategyId || !exchange || !pair || !entryPrice || !entryQuantity) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        const position = await MomentumPosition.create({
            userId,
            strategyId,
            exchange,
            asset,
            pair,
            entryPrice,
            entryQuantity,
            entryValueUsdt: entryValueUSDT,
            entryFee: entryFee || 0,
            entrySignals,
            entryOrderId
        });

        logger.info('Position created successfully', {
            positionId: position.id,
            strategyId,
            pair,
            entryPrice
        });

        res.json({
            success: true,
            data: position
        });

    } catch (error) {
        logger.error('Failed to create position', {
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
 * POST /api/v1/momentum/positions/:id/close
 * Manually close a position
 */
router.post('/positions/:id/close', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, reason, credentials } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }

        if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
            return res.status(400).json({
                success: false,
                error: 'credentials are required (apiKey and apiSecret)'
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

        // Convert both to strings for comparison (DB stores as VARCHAR, frontend may send as number)
        if (String(position.user_id) !== String(userId)) {
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

        logger.info('Manually closing momentum position', {
            userId,
            positionId: id,
            asset: position.asset,
            pair: position.pair,
            exchange: position.exchange,
            quantity: position.entry_quantity
        });

        // Execute sell order on exchange
        const sellResult = await orderExecutionService.executeSellOrder(
            position.exchange,
            position.pair,
            parseFloat(position.entry_quantity),
            credentials
        );

        logger.info('Sell order executed', {
            positionId: id,
            orderId: sellResult.orderId,
            executedPrice: sellResult.executedPrice,
            executedQuantity: sellResult.executedQuantity,
            fee: sellResult.fee
        });

        // Close position in database with actual execution details
        const closedPosition = await MomentumPosition.close(id, {
            exitPrice: sellResult.executedPrice,
            exitQuantity: sellResult.executedQuantity,
            exitFee: sellResult.fee || 0,
            exitReason: reason || 'manual_close',
            exitOrderId: sellResult.orderId
        });

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
 * PUT /api/v1/momentum/positions/:id/close
 * Close a position (called by PositionMonitor after executing sell order)
 */
router.put('/positions/:id/close', async (req, res) => {
    try {
        const { id } = req.params;
        const { exitPrice, exitQuantity, exitFee, exitReason, exitOrderId } = req.body;

        if (!exitPrice || !exitQuantity) {
            return res.status(400).json({
                success: false,
                error: 'exitPrice and exitQuantity are required'
            });
        }

        // Close position in database with actual fees
        const closedPosition = await MomentumPosition.close(id, {
            exitPrice,
            exitQuantity,
            exitFee: exitFee || 0,
            exitReason: exitReason || 'unknown',
            exitOrderId
        });

        if (!closedPosition) {
            return res.status(404).json({
                success: false,
                error: 'Position not found'
            });
        }

        logger.info('Position closed in database with accurate P&L', {
            positionId: id,
            exitPrice,
            exitFee: exitFee || 0,
            netPnL: closedPosition.exit_pnl_usdt,
            netPnLPercent: closedPosition.exit_pnl_percent
        });

        res.json({
            success: true,
            data: closedPosition,
            message: 'Position closed successfully'
        });

    } catch (error) {
        logger.error('Failed to close position in database', {
            positionId: req.params.id,
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

/**
 * POST /api/v1/momentum/market/candles
 * Fetch candle data for a trading pair (accepts credentials in body)
 */
router.post('/market/candles', async (req, res) => {
    try {
        const { exchange, pair, interval, limit, credentials } = req.body;

        logger.info('Candles request received', {
            targetExchange: exchange,
            pair,
            interval,
            limit
        });

        if (!exchange || !pair) {
            return res.status(400).json({
                success: false,
                error: 'exchange and pair are required'
            });
        }

        // Use Binance as universal data source for ALL exchanges
        // XRP/USDT price is identical across all exchanges due to arbitrage
        // This gives us unlimited historical data for analysis
        // Actual trades will execute on the target exchange (VALR, Bybit, etc.)
        logger.info('Fetching candles from Binance (universal data source)', {
            targetExchange: exchange,
            pair,
            dataSource: 'Binance'
        });

        // Fetch candles from Binance (no credentials needed - public endpoint)
        const candles = await binanceService.fetchCandles(
            pair,
            interval || '1h',
            limit || 100
        );

        logger.info('Candles fetched successfully from Binance', {
            targetExchange: exchange,
            pair,
            candleCount: candles?.length,
            dataRange: candles.length > 0 ? {
                from: new Date(candles[0].timestamp).toISOString(),
                to: new Date(candles[candles.length - 1].timestamp).toISOString()
            } : 'N/A'
        });

        res.json({
            success: true,
            data: candles
        });

    } catch (error) {
        logger.error('Failed to fetch candles', {
            exchange: req.body.exchange,
            pair: req.body.pair,
            error: error.message,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch candles'
        });
    }
});

/**
 * POST /api/v1/momentum/market/current-price
 * Get current market price for a trading pair
 */
router.post('/market/current-price', async (req, res) => {
    try {
        const { exchange, pair } = req.body;

        if (!exchange || !pair) {
            return res.status(400).json({
                success: false,
                error: 'exchange and pair are required'
            });
        }

        // Use Binance as universal data source for current price
        // Price is identical across all exchanges due to arbitrage
        logger.info('Fetching current price from Binance', {
            targetExchange: exchange,
            pair,
            dataSource: 'Binance'
        });

        // Fetch current price from Binance (no credentials needed)
        const price = await binanceService.fetchCurrentPrice(pair);

        logger.info('Current price fetched from Binance', {
            targetExchange: exchange,
            pair,
            price
        });

        res.json({
            success: true,
            data: price
        });

    } catch (error) {
        logger.error('Failed to fetch current price', {
            exchange: req.body.exchange,
            pair: req.body.pair,
            error: error.message
        });

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/momentum/order/buy
 * Execute a buy order (accepts credentials in body)
 */
router.post('/order/buy', async (req, res) => {
    try {
        const { exchange, pair, amountUSDT, credentials } = req.body;

        if (!exchange || !pair || !amountUSDT || !credentials) {
            return res.status(400).json({
                success: false,
                error: 'exchange, pair, amountUSDT, and credentials are required'
            });
        }

        logger.info('Executing buy order', { exchange, pair, amountUSDT });

        // Execute buy order
        const orderResult = await orderExecutionService.executeBuyOrder(
            exchange,
            pair,
            amountUSDT,
            credentials
        );

        res.json({
            success: true,
            data: orderResult
        });

    } catch (error) {
        logger.error('Failed to execute buy order', {
            exchange: req.body.exchange,
            pair: req.body.pair,
            amountUSDT: req.body.amountUSDT,
            error: error.message,
            stack: error.stack,
            errorType: error.constructor.name
        });

        res.status(500).json({
            success: false,
            error: error.message || 'Unknown error executing buy order',
            details: error.stack
        });
    }
});

/**
 * POST /api/v1/momentum/order/sell
 * Execute a sell order (accepts credentials in body)
 */
router.post('/order/sell', async (req, res) => {
    try {
        const { exchange, pair, quantity, credentials } = req.body;

        if (!exchange || !pair || !quantity || !credentials) {
            return res.status(400).json({
                success: false,
                error: 'exchange, pair, quantity, and credentials are required'
            });
        }

        logger.info('Executing sell order', { exchange, pair, quantity });

        // Execute sell order
        const orderResult = await orderExecutionService.executeSellOrder(
            exchange,
            pair,
            quantity,
            credentials
        );

        res.json({
            success: true,
            data: orderResult
        });

    } catch (error) {
        logger.error('Failed to execute sell order', {
            exchange: req.body.exchange,
            pair: req.body.pair,
            quantity: req.body.quantity,
            error: error.message,
            stack: error.stack,
            errorType: error.constructor.name
        });

        res.status(500).json({
            success: false,
            error: error.message || 'Unknown error executing sell order',
            details: error.stack
        });
    }
});

module.exports = router;
