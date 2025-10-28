// Momentum Worker Service
// Main orchestration service that runs every 60 seconds
// Monitors strategies, detects signals, executes trades

const MomentumStrategy = require('../../models/MomentumStrategy');
const MomentumPosition = require('../../models/MomentumPosition');
const MomentumCredentials = require('../../models/MomentumCredentials');
const SignalDetectionService = require('./SignalDetectionService');
const PositionMonitorService = require('./PositionMonitorService');
const VALRMarketDataService = require('./VALRMarketDataService');
const LunoMarketDataService = require('./LunoMarketDataService');
const ChainEXMarketDataService = require('./ChainEXMarketDataService');
const KrakenMarketDataService = require('./KrakenMarketDataService');
const BinanceMarketDataService = require('./BinanceMarketDataService');
const BYBITMarketDataService = require('./BYBITMarketDataService');
const GateioMarketDataService = require('./GateioMarketDataService');
const OKXMarketDataService = require('./OKXMarketDataService');
const MEXCMarketDataService = require('./MEXCMarketDataService');
const OrderExecutionService = require('./OrderExecutionService');
const { logger } = require('../../utils/logger');

class MomentumWorkerService {
    constructor() {
        // Create market data services for all supported exchanges
        this.marketDataServices = {
            'valr': new VALRMarketDataService(),
            'luno': new LunoMarketDataService(),
            'chainex': new ChainEXMarketDataService(),
            'kraken': new KrakenMarketDataService(),
            'binance': new BinanceMarketDataService(),
            'bybit': new BYBITMarketDataService(),
            'gate.io': new GateioMarketDataService(),
            'gateio': new GateioMarketDataService(),
            'okx': new OKXMarketDataService(),
            'mexc': new MEXCMarketDataService()
            // More exchanges will be added here (kucoin, xt, ascendex, htx, etc.)
        };

        this.orderService = new OrderExecutionService();
        this.positionMonitor = new PositionMonitorService();
        this.isRunning = false;
        this.workerInterval = null;

        // Asset rotation configuration
        // For strategies with many coins, check a subset each cycle
        this.assetRotationConfig = {
            enabled: true,
            batchSize: 25, // Check 25 coins per cycle
            threshold: 30  // Enable rotation if strategy has 30+ coins
        };

        // Track rotation state per strategy: Map<strategyId, { lastIndex: number }>
        this.assetRotationState = new Map();

        // Parallel processing configuration (for assets/coins)
        // Process multiple coins simultaneously to speed up execution
        this.parallelBatchingConfig = {
            enabled: true,
            batchSize: 5 // Process 5 coins in parallel at a time
        };

        // Parallel strategy processing configuration
        // Process multiple strategies simultaneously to handle 100-200 strategies efficiently
        this.parallelStrategyConfig = {
            enabled: true,
            batchSize: 10 // Process 10 strategies in parallel at a time
        };
    }

    /**
     * Get market data service for a specific exchange
     * @param {string} exchange - Exchange name ('valr', 'luno', 'binance', etc.)
     * @returns {object} Market data service instance
     */
    getMarketService(exchange) {
        const exchangeLower = exchange.toLowerCase();
        const service = this.marketDataServices[exchangeLower];

        if (!service) {
            throw new Error(`Market data service not available for exchange: ${exchange}. Supported exchanges: ${Object.keys(this.marketDataServices).join(', ')}`);
        }

        return service;
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

            // Process strategies in parallel batches for efficiency
            if (this.parallelStrategyConfig.enabled && activeStrategies.length > 1) {
                const batchSize = this.parallelStrategyConfig.batchSize;

                logger.info(`Processing strategies in parallel batches of ${batchSize}`);

                // Split strategies into parallel batches
                for (let i = 0; i < activeStrategies.length; i += batchSize) {
                    const batch = activeStrategies.slice(i, Math.min(i + batchSize, activeStrategies.length));

                    logger.debug(`Processing strategy batch ${Math.floor(i / batchSize) + 1}`, {
                        batchStart: i + 1,
                        batchEnd: i + batch.length,
                        total: activeStrategies.length
                    });

                    // Process batch in parallel
                    const batchResults = await Promise.all(
                        batch.map(strategy => this._processStrategy(strategy))
                    );

                    // Aggregate results
                    batchResults.forEach(result => {
                        stats.strategiesChecked++;
                        stats.signalsDetected += result.signalsDetected;
                        stats.positionsOpened += result.positionsOpened;
                        stats.positionsClosed += result.positionsClosed;
                    });

                    logger.info(`Completed strategy batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(activeStrategies.length / batchSize)}`, {
                        signals: batchResults.reduce((sum, r) => sum + r.signalsDetected, 0),
                        opened: batchResults.reduce((sum, r) => sum + r.positionsOpened, 0),
                        closed: batchResults.reduce((sum, r) => sum + r.positionsClosed, 0)
                    });
                }
            } else {
                // Sequential processing (parallel disabled or single strategy)
                logger.info('Processing strategies sequentially');

                for (const strategy of activeStrategies) {
                    const result = await this._processStrategy(strategy);

                    stats.strategiesChecked++;
                    stats.signalsDetected += result.signalsDetected;
                    stats.positionsOpened += result.positionsOpened;
                    stats.positionsClosed += result.positionsClosed;
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
     * Process a single strategy (check positions and signals)
     * @private
     * @param {object} strategy - Strategy configuration
     * @returns {Promise<object>} { signalsDetected, positionsOpened, positionsClosed }
     */
    async _processStrategy(strategy) {
        const results = {
            signalsDetected: 0,
            positionsOpened: 0,
            positionsClosed: 0
        };

        try {
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
                return results;
            }

            // Monitor existing positions (check exits)
            const closedPositions = await this.positionMonitor.monitorPositions(
                strategy.user_id,
                strategy.exchange,
                credentials
            );

            results.positionsClosed = closedPositions.length;

            // Check for new entry signals
            const entryResults = await this._checkEntrySignals(
                strategy,
                credentials
            );

            results.signalsDetected = entryResults.signalsDetected;
            results.positionsOpened = entryResults.positionsOpened;

            return results;

        } catch (error) {
            logger.error('Failed to process strategy', {
                strategyId: strategy.id,
                error: error.message
            });
            return results;
        }
    }

    /**
     * Get asset batch for this cycle (implements asset rotation)
     * For strategies with many coins, rotates through subsets to reduce API calls
     * @private
     * @param {object} strategy - Strategy configuration
     * @returns {Array} Assets to check this cycle
     */
    _getAssetBatch(strategy) {
        const { assets } = strategy;
        const totalAssets = assets.length;

        // If strategy has few assets or rotation disabled, check all
        if (!this.assetRotationConfig.enabled ||
            totalAssets <= this.assetRotationConfig.threshold) {
            return assets;
        }

        // Get or initialize rotation state for this strategy
        if (!this.assetRotationState.has(strategy.id)) {
            this.assetRotationState.set(strategy.id, { lastIndex: 0 });
        }

        const state = this.assetRotationState.get(strategy.id);
        const batchSize = this.assetRotationConfig.batchSize;
        const startIndex = state.lastIndex;
        const endIndex = Math.min(startIndex + batchSize, totalAssets);

        // Get the batch for this cycle
        const batch = assets.slice(startIndex, endIndex);

        // Update rotation state for next cycle
        const nextIndex = endIndex >= totalAssets ? 0 : endIndex;
        this.assetRotationState.set(strategy.id, { lastIndex: nextIndex });

        logger.debug('Asset rotation batch', {
            strategyId: strategy.id,
            totalAssets,
            batchSize: batch.length,
            checking: `${startIndex + 1}-${endIndex} of ${totalAssets}`,
            nextCycleStarts: nextIndex
        });

        return batch;
    }

    /**
     * Check signals for a single asset
     * @private
     * @param {string} asset - Asset symbol (e.g., 'BTC', 'ETH')
     * @param {object} strategy - Strategy configuration
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} { asset, pair, candles, signalResult, hasSignal }
     */
    async _checkAssetSignal(asset, strategy, credentials) {
        try {
            // Build trading pair (asset + USDT)
            const pair = `${asset}USDT`;

            // Get market data service for the strategy's exchange
            const marketService = this.getMarketService(strategy.exchange);

            // Fetch candle data for indicator calculation
            const candles = await marketService.fetchCandles(
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
                return { asset, pair, hasSignal: false };
            }

            // Check entry signals using SignalDetectionService
            const signalResult = await SignalDetectionService.checkEntrySignals(
                candles,
                strategy
            );

            return {
                asset,
                pair,
                candles,
                signalResult,
                hasSignal: signalResult.shouldEnter
            };

        } catch (error) {
            logger.error('Failed to check entry signal for asset', {
                strategyId: strategy.id,
                asset,
                error: error.message
            });
            return { asset, hasSignal: false, error };
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

            // Get asset batch for this cycle (uses rotation for large coin lists)
            const assetBatch = this._getAssetBatch(strategy);

            logger.debug('Checking entry signals', {
                strategyId: strategy.id,
                strategyName: strategy.strategy_name,
                totalAssets: strategy.assets.length,
                checkingThisCycle: assetBatch.length
            });

            // Process assets in parallel batches for faster execution
            const allSignals = [];

            if (this.parallelBatchingConfig.enabled && assetBatch.length > 1) {
                const batchSize = this.parallelBatchingConfig.batchSize;

                // Split assets into parallel batches
                for (let i = 0; i < assetBatch.length; i += batchSize) {
                    const batch = assetBatch.slice(i, Math.min(i + batchSize, assetBatch.length));

                    // Process batch in parallel
                    const batchResults = await Promise.all(
                        batch.map(asset => this._checkAssetSignal(asset, strategy, credentials))
                    );

                    allSignals.push(...batchResults);

                    logger.debug('Parallel batch processed', {
                        strategyId: strategy.id,
                        batch: `${i + 1}-${i + batch.length}`,
                        total: assetBatch.length
                    });
                }
            } else {
                // Sequential processing (parallel batching disabled)
                for (const asset of assetBatch) {
                    const signal = await this._checkAssetSignal(asset, strategy, credentials);
                    allSignals.push(signal);
                }
            }

            // Filter signals that triggered
            const triggeredSignals = allSignals.filter(s => s.hasSignal);
            results.signalsDetected = triggeredSignals.length;

            // Prioritize signals: strongest signals first (more indicators triggered)
            // This ensures we execute the best opportunities when we hit max positions
            triggeredSignals.sort((a, b) => {
                const aStrength = a.signalResult.triggeredCount / a.signalResult.totalEnabled;
                const bStrength = b.signalResult.triggeredCount / b.signalResult.totalEnabled;

                // Sort by signal strength (descending)
                if (bStrength !== aStrength) {
                    return bStrength - aStrength;
                }

                // If tied, sort by asset name (ascending) for consistent ordering
                return a.asset.localeCompare(b.asset);
            });

            if (triggeredSignals.length > 0) {
                logger.info('Prioritized signals ready for execution', {
                    strategyId: strategy.id,
                    signalCount: triggeredSignals.length,
                    topSignals: triggeredSignals.slice(0, 3).map(s => ({
                        asset: s.asset,
                        strength: `${s.signalResult.triggeredCount}/${s.signalResult.totalEnabled}`,
                        indicators: s.signalResult.triggeredIndicators.map(i => i.name).join(', ')
                    }))
                });
            }

            // Open positions for triggered signals (sequentially to avoid race conditions)
            for (const signal of triggeredSignals) {
                logger.info('🎯 Entry signal detected', {
                    strategyId: strategy.id,
                    strategyName: strategy.strategy_name,
                    pair: signal.pair,
                    triggeredIndicators: signal.signalResult.triggeredIndicators,
                    triggeredCount: signal.signalResult.triggeredCount,
                    totalEnabled: signal.signalResult.totalEnabled
                });

                // Open position
                const opened = await this._openPosition(
                    strategy,
                    signal.asset,
                    signal.pair,
                    signal.candles[signal.candles.length - 1].close, // Current price
                    signal.signalResult.triggeredIndicators,
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
