// Position Monitor Service
// Monitors open positions and determines when to exit based on strategy rules

const MomentumPosition = require('../../models/MomentumPosition');
const MomentumStrategy = require('../../models/MomentumStrategy');
const SignalDetectionService = require('./SignalDetectionService');
const OrderExecutionService = require('./OrderExecutionService');
const { logger } = require('../../utils/logger');

class PositionMonitorService {
    constructor() {
        this.orderService = new OrderExecutionService();
        // Market services are obtained dynamically per exchange
        // No hardcoded exchange service
    }

    /**
     * Get market data service for specific exchange
     * @private
     * @param {string} exchange - Exchange name
     * @returns {object} Market data service for the exchange
     */
    _getMarketService(exchange) {
        // Import MomentumWorkerService to access its market services
        const MomentumWorkerService = require('./MomentumWorkerService');
        return MomentumWorkerService.getMarketService(exchange);
    }

    /**
     * Monitor all open positions for a user
     * @param {string} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<Array>} Array of positions that were closed
     */
    async monitorPositions(userId, exchange, credentials) {
        try {
            // Get all open positions for user and exchange
            const openPositions = await MomentumPosition.getOpenByUserAndExchange(userId, exchange);

            if (!openPositions || openPositions.length === 0) {
                logger.debug('No open positions to monitor', { userId, exchange });
                return [];
            }

            logger.info('Monitoring open positions', {
                userId,
                exchange,
                positionsCount: openPositions.length
            });

            const closedPositions = [];

            // Monitor each position
            for (const position of openPositions) {
                try {
                    const shouldClose = await this._checkExitConditions(
                        position,
                        exchange,
                        credentials
                    );

                    if (shouldClose.shouldExit) {
                        // Execute exit order
                        const closedPosition = await this._closePosition(
                            position,
                            shouldClose.reason,
                            shouldClose.currentPrice,
                            exchange,
                            credentials
                        );

                        closedPositions.push(closedPosition);
                    }

                } catch (error) {
                    logger.error('Failed to monitor position', {
                        positionId: position.id,
                        error: error.message
                    });
                    // Continue monitoring other positions
                }
            }

            if (closedPositions.length > 0) {
                logger.info('Positions closed', {
                    userId,
                    exchange,
                    closedCount: closedPositions.length
                });
            }

            return closedPositions;

        } catch (error) {
            logger.error('Position monitoring failed', {
                userId,
                exchange,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Check exit conditions for a single position
     * @private
     * @param {object} position - Position object
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} {shouldExit, reason, currentPrice}
     */
    async _checkExitConditions(position, exchange, credentials) {
        try {
            // Get strategy configuration
            const strategy = await MomentumStrategy.getById(position.strategy_id);

            if (!strategy) {
                throw new Error(`Strategy not found: ${position.strategy_id}`);
            }

            // Get market data service for this exchange
            const marketService = this._getMarketService(exchange);

            // Get current market price from the correct exchange
            const currentPrice = await marketService.fetchCurrentPrice(
                position.pair,
                credentials
            );

            // Use SignalDetectionService to check exit signals
            const exitSignal = SignalDetectionService.checkExitSignals(
                position,
                currentPrice,
                strategy.exit_rules
            );

            return {
                ...exitSignal,
                currentPrice
            };

        } catch (error) {
            logger.error('Failed to check exit conditions', {
                positionId: position.id,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Close a position by executing sell order
     * @private
     * @param {object} position - Position object
     * @param {string} reason - Exit reason
     * @param {number} currentPrice - Current market price
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} Closed position
     */
    async _closePosition(position, reason, currentPrice, exchange, credentials) {
        try {
            logger.info('Closing position', {
                positionId: position.id,
                pair: position.pair,
                reason,
                entryPrice: position.entry_price,
                currentPrice,
                quantity: position.entry_quantity
            });

            // Execute market SELL order
            const sellOrder = await this.orderService.executeSellOrder(
                exchange,
                position.pair,
                position.entry_quantity,
                credentials
            );

            // Calculate P&L
            const exitPrice = sellOrder.executedPrice || currentPrice;
            const exitValue = sellOrder.executedValue || (exitPrice * position.entry_quantity);
            const pnlUSDT = exitValue - position.entry_value_usdt - sellOrder.fee;
            const pnlPercent = (pnlUSDT / position.entry_value_usdt) * 100;

            // Close position in database
            const closedPosition = await MomentumPosition.close(position.id, {
                exitPrice: exitPrice,
                exitQuantity: position.entry_quantity,
                exitReason: reason,
                exitOrderId: sellOrder.orderId,
                exitPnLUSDT: pnlUSDT,
                exitPnLPercent: pnlPercent
            });

            logger.info('Position closed successfully', {
                positionId: position.id,
                exitPrice,
                pnlUSDT: pnlUSDT.toFixed(2),
                pnlPercent: pnlPercent.toFixed(2),
                reason
            });

            return closedPosition;

        } catch (error) {
            logger.error('Failed to close position', {
                positionId: position.id,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Manually close a position (triggered by user)
     * @param {number} positionId - Position ID
     * @param {string} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} Closed position
     */
    async manualClosePosition(positionId, userId, exchange, credentials) {
        try {
            const position = await MomentumPosition.getById(positionId);

            if (!position) {
                throw new Error(`Position not found: ${positionId}`);
            }

            if (position.user_id !== userId) {
                throw new Error('Unauthorized: Position does not belong to user');
            }

            if (position.status !== 'OPEN') {
                throw new Error('Position is already closed');
            }

            // Get market data service for this exchange
            const marketService = this._getMarketService(exchange);

            // Get current price from the correct exchange
            const currentPrice = await marketService.fetchCurrentPrice(
                position.pair,
                credentials
            );

            // Close the position
            const closedPosition = await this._closePosition(
                position,
                'manual_close',
                currentPrice,
                exchange,
                credentials
            );

            return closedPosition;

        } catch (error) {
            logger.error('Manual close position failed', {
                positionId,
                userId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get current P&L for an open position
     * @param {number} positionId - Position ID
     * @param {string} exchange - Exchange name
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} { currentPrice, currentValue, pnlUSDT, pnlPercent }
     */
    async getCurrentPnL(positionId, exchange, credentials) {
        try {
            const position = await MomentumPosition.getById(positionId);

            if (!position) {
                throw new Error(`Position not found: ${positionId}`);
            }

            if (position.status !== 'OPEN') {
                throw new Error('Position is already closed');
            }

            // Get market data service for this exchange
            const marketService = this._getMarketService(exchange);

            // Get current price from the correct exchange
            const currentPrice = await marketService.fetchCurrentPrice(
                position.pair,
                credentials
            );

            // Calculate current P&L
            const currentValue = currentPrice * position.entry_quantity;
            const pnlUSDT = currentValue - position.entry_value_usdt;
            const pnlPercent = (pnlUSDT / position.entry_value_usdt) * 100;

            const hoursOpen = (Date.now() - new Date(position.entry_time).getTime()) / (1000 * 60 * 60);

            return {
                positionId: position.id,
                pair: position.pair,
                entryPrice: position.entry_price,
                entryValue: position.entry_value_usdt,
                currentPrice,
                currentValue,
                pnlUSDT,
                pnlPercent,
                hoursOpen: hoursOpen.toFixed(1)
            };

        } catch (error) {
            logger.error('Get current P&L failed', {
                positionId,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = PositionMonitorService;
