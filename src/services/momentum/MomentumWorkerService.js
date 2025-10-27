// Momentum Worker Service
// Main orchestration service that runs every 60 seconds
// Monitors strategies, detects signals, executes trades

const MomentumStrategy = require('../../models/MomentumStrategy');
const MomentumPosition = require('../../models/MomentumPosition');
const MomentumCredentials = require('../../models/MomentumCredentials');
const SignalDetectionService = require('./SignalDetectionService');
const PositionMonitorService = require('./PositionMonitorService');
const VALRMarketDataService = require('./VALRMarketDataService');
const OrderExecutionService = require('./OrderExecutionService');
const { logger } = require('../../utils/logger');

class MomentumWorkerService {
    constructor() {
        this.valrService = new VALRMarketDataService();
        this.orderService = new OrderExecutionService();
        this.positionMonitor = new PositionMonitorService();
        this.isRunning = false;
        this.workerInterval = null;
    }

    /**
     * Start the momentum worker
     * Runs every 60 seconds
     */
    start() {
        if (this.isRunning) {
            logger.warn('Momentum worker is already running');
            return;
        }

        this.isRunning = true;
        logger.info('Starting Momentum Worker (60-second intervals)');

        // Run immediately on start
        this.runCycle().catch(error => {
            logger.error('Momentum worker cycle failed', { error: error.message });
        });

        // Then run every 60 seconds
        this.workerInterval = setInterval(() => {
            this.runCycle().catch(error => {
                logger.error('Momentum worker cycle failed', { error: error.message });
            });
        }, 60000); // 60 seconds
    }

    /**
     * Stop the momentum worker
     */
    stop() {
        if (!this.isRunning) {
            logger.warn('Momentum worker is not running');
            return;
        }

        this.isRunning = false;
        if (this.workerInterval) {
            clearInterval(this.workerInterval);
            this.workerInterval = null;
        }

        logger.info('Momentum Worker stopped');
    }

    /**
     * Run one complete worker cycle
     * @returns {Promise<object>} Cycle statistics
     */
    async runCycle() {
        const cycleStart = Date.now();
        const stats = {
            cycleStartTime: new Date().toISOString(),
            strategiesChecked: 0,
            signalsDetected: 0,
            positionsOpened: 0,
            positionsClosed: 0,
            errors: 0
        };

        try {
            logger.info('🔄 Momentum Worker Cycle Started');

            // Get all active strategies (across all users and exchanges)
            const activeStrategies = await this._getAllActiveStrategies();

            if (!activeStrategies || activeStrategies.length === 0) {
                logger.info('No active strategies found');
                return stats;
            }

            logger.info(`Found ${activeStrategies.length} active strategies`);

            // Process each strategy
            for (const strategy of activeStrategies) {
                try {
                    stats.strategiesChecked++;

                    // Get credentials for this user/exchange
                    const credentials = await MomentumCredentials.getCredentials(
                        strategy.user_id,
                        strategy.exchange
                    );

                    if (!credentials) {
                        logger.warn('No credentials found for strategy', {
                            strategyId: strategy.id,
                            userId: strategy.user_id,
                            exchange: strategy.exchange
                        });
                        continue;
                    }

                    // Monitor existing positions (check exits)
                    const closedPositions = await this.positionMonitor.monitorPositions(
                        strategy.user_id,
                        strategy.exchange,
                        credentials
                    );

                    stats.positionsClosed += closedPositions.length;

                    // Check for new entry signals
                    const entryResults = await this._checkEntrySignals(
                        strategy,
                        credentials
                    );

                    stats.signalsDetected += entryResults.signalsDetected;
                    stats.positionsOpened += entryResults.positionsOpened;

                } catch (error) {
                    stats.errors++;
                    logger.error('Failed to process strategy', {
                        strategyId: strategy.id,
                        error: error.message
                    });
                }
            }

            const cycleDuration = Date.now() - cycleStart;

            logger.info('✅ Momentum Worker Cycle Completed', {
                duration: `${cycleDuration}ms`,
                ...stats
            });

            return stats;

        } catch (error) {
            logger.error('Momentum worker cycle failed', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get all active strategies from database
     * @private
     */
    async _getAllActiveStrategies() {
        try {
            // Query all active strategies across all users
            const { query } = require('../../database/connection');

            const result = await query(`
                SELECT * FROM momentum_strategies
                WHERE is_active = true
                ORDER BY user_id, exchange, id
            `);

            return result.rows;

        } catch (error) {
            logger.error('Failed to fetch active strategies', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Check entry signals for all assets in a strategy
     * @private
     * @param {object} strategy - Strategy configuration
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} { signalsDetected, positionsOpened }
     */
    async _checkEntrySignals(strategy, credentials) {
        const results = {
            signalsDetected: 0,
            positionsOpened: 0
        };

        try {
            // Check if strategy can open more positions
            const canOpenMore = await MomentumStrategy.canOpenPosition(strategy.id);

            if (!canOpenMore) {
                logger.debug('Strategy has reached max open positions', {
                    strategyId: strategy.id,
                    maxPositions: strategy.max_open_positions
                });
                return results;
            }

            // Check each asset in the strategy
            for (const asset of strategy.assets) {
                try {
                    // Build trading pair (asset + USDT)
                    const pair = `${asset}USDT`;

                    // Fetch candle data for indicator calculation
                    const candles = await this.valrService.fetchCandles(
                        pair,
                        '1h', // Use 1-hour candles
                        100,  // Fetch 100 candles for indicators
                        credentials
                    );

                    if (!candles || candles.length < 50) {
                        logger.warn('Insufficient candle data', {
                            pair,
                            candlesCount: candles?.length || 0
                        });
                        continue;
                    }

                    // Check entry signals using SignalDetectionService
                    const signalResult = await SignalDetectionService.checkEntrySignals(
                        candles,
                        strategy
                    );

                    if (signalResult.shouldEnter) {
                        results.signalsDetected++;

                        logger.info('🎯 Entry signal detected', {
                            strategyId: strategy.id,
                            strategyName: strategy.strategy_name,
                            pair,
                            triggeredIndicators: signalResult.triggeredIndicators,
                            triggeredCount: signalResult.triggeredCount,
                            totalEnabled: signalResult.totalEnabled
                        });

                        // Open position
                        const opened = await this._openPosition(
                            strategy,
                            asset,
                            pair,
                            candles[candles.length - 1].close, // Current price
                            signalResult.triggeredIndicators,
                            credentials
                        );

                        if (opened) {
                            results.positionsOpened++;

                            // Re-check if can open more positions
                            const stillCanOpen = await MomentumStrategy.canOpenPosition(strategy.id);
                            if (!stillCanOpen) {
                                logger.info('Strategy reached max positions, stopping entry checks', {
                                    strategyId: strategy.id
                                });
                                break; // Stop checking more assets for this strategy
                            }
                        }
                    }

                } catch (error) {
                    logger.error('Failed to check entry signal for asset', {
                        strategyId: strategy.id,
                        asset,
                        error: error.message
                    });
                }
            }

            return results;

        } catch (error) {
            logger.error('Failed to check entry signals', {
                strategyId: strategy.id,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Open a new position
     * @private
     */
    async _openPosition(strategy, asset, pair, currentPrice, triggeredIndicators, credentials) {
        try {
            logger.info('Opening new position', {
                strategyId: strategy.id,
                pair,
                tradeAmount: strategy.max_trade_amount
            });

            // Execute market BUY order
            const buyOrder = await this.orderService.executeBuyOrder(
                strategy.exchange,
                pair,
                strategy.max_trade_amount,
                credentials
            );

            logger.info('Buy order executed', {
                orderId: buyOrder.orderId,
                executedPrice: buyOrder.executedPrice,
                executedQuantity: buyOrder.executedQuantity
            });

            // Create position in database
            const position = await MomentumPosition.create({
                userId: strategy.user_id,
                strategyId: strategy.id,
                exchange: strategy.exchange,
                asset: asset,
                pair: pair,
                entryPrice: buyOrder.executedPrice,
                entryQuantity: buyOrder.executedQuantity,
                entryValueUSDT: buyOrder.executedValue || strategy.max_trade_amount,
                entrySignals: triggeredIndicators,
                entryOrderId: buyOrder.orderId
            });

            logger.info('✅ Position opened successfully', {
                positionId: position.id,
                strategyId: strategy.id,
                pair,
                entryPrice: position.entry_price,
                quantity: position.entry_quantity
            });

            return position;

        } catch (error) {
            logger.error('Failed to open position', {
                strategyId: strategy.id,
                pair,
                error: error.message
            });
            return null;
        }
    }

    /**
     * Get worker status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            intervalMs: 60000
        };
    }
}

// Export singleton instance
module.exports = new MomentumWorkerService();
