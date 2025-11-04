// Momentum Worker Service
// Main orchestration service that runs every 60 seconds
// Monitors strategies, detects signals, executes trades
// Frontend version - converted from backend MomentumWorkerService.js

const MomentumWorker = {
    // Worker state
    isRunning: false,
    workerInterval: null,

    // Asset rotation configuration
    assetRotationConfig: {
        enabled: true,
        batchSize: 25, // Check 25 coins per cycle
        threshold: 30  // Enable rotation if strategy has 30+ coins
    },

    // Track rotation state per strategy: Map<strategyId, { lastIndex: number }>
    assetRotationState: new Map(),

    // Parallel processing configuration (for assets/coins)
    parallelBatchingConfig: {
        enabled: true,
        batchSize: 5 // Process 5 coins in parallel at a time
    },

    // Parallel strategy processing configuration
    parallelStrategyConfig: {
        enabled: true,
        batchSize: 10 // Process 10 strategies in parallel at a time
    },

    /**
     * Start the momentum worker
     * Runs every 60 seconds
     */
    start() {
        if (this.isRunning) {
            console.warn('⚠️  Momentum worker is already running');
            return;
        }

        this.isRunning = true;

        console.log('\n╔═══════════════════════════════════════════════════════════════╗');
        console.log('║         🚀 MOMENTUM TRADING WORKER STARTED                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        console.log(`📅 Started at: ${new Date().toLocaleString()}`);
        console.log('⏱️  Cycle Interval: 60 seconds');
        console.log('🔄 Running first cycle immediately...\n');

        // Run immediately on start
        this.runCycle().catch(error => {
            console.error('❌ Momentum worker cycle failed:', error.message);
        });

        // Then run every 60 seconds
        this.workerInterval = setInterval(() => {
            this.runCycle().catch(error => {
                console.error('❌ Momentum worker cycle failed:', error.message);
            });
        }, 60000); // 60 seconds
    },

    /**
     * Stop the momentum worker
     */
    stop() {
        if (!this.isRunning) {
            console.warn('⚠️  Momentum worker is not running');
            return;
        }

        this.isRunning = false;
        if (this.workerInterval) {
            clearInterval(this.workerInterval);
            this.workerInterval = null;
        }

        console.log('\n╔═══════════════════════════════════════════════════════════════╗');
        console.log('║         🛑 MOMENTUM TRADING WORKER STOPPED                   ║');
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        console.log(`📅 Stopped at: ${new Date().toLocaleString()}\n`);
    },

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
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🔄 MOMENTUM WORKER CYCLE STARTED');
            console.log(`⏰ Time: ${new Date().toLocaleString()}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            // Get all active strategies (across all users and exchanges) via API
            const activeStrategies = await this._getAllActiveStrategies();

            if (!activeStrategies || activeStrategies.length === 0) {
                console.log('📭 No active strategies found');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                return stats;
            }

            console.log(`📊 Found ${activeStrategies.length} active strategy(ies)`);

            // Process strategies in parallel batches for efficiency
            if (this.parallelStrategyConfig.enabled && activeStrategies.length > 1) {
                const batchSize = this.parallelStrategyConfig.batchSize;

                console.log(`⚡ Processing strategies in parallel (batch size: ${batchSize})`);

                // Split strategies into parallel batches
                for (let i = 0; i < activeStrategies.length; i += batchSize) {
                    const batch = activeStrategies.slice(i, Math.min(i + batchSize, activeStrategies.length));

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

                    const batchSignals = batchResults.reduce((sum, r) => sum + r.signalsDetected, 0);
                    const batchOpened = batchResults.reduce((sum, r) => sum + r.positionsOpened, 0);
                    const batchClosed = batchResults.reduce((sum, r) => sum + r.positionsClosed, 0);

                    console.log(`   ✓ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(activeStrategies.length / batchSize)} complete - Signals: ${batchSignals}, Opened: ${batchOpened}, Closed: ${batchClosed}`);
                }
            } else {
                // Sequential processing (parallel disabled or single strategy)
                console.log('📝 Processing strategies sequentially');

                for (const strategy of activeStrategies) {
                    const result = await this._processStrategy(strategy);

                    stats.strategiesChecked++;
                    stats.signalsDetected += result.signalsDetected;
                    stats.positionsOpened += result.positionsOpened;
                    stats.positionsClosed += result.positionsClosed;
                }
            }

            const cycleDuration = Date.now() - cycleStart;

            console.log('\n✅ CYCLE COMPLETED');
            console.log(`⏱️  Duration: ${(cycleDuration / 1000).toFixed(2)}s`);
            console.log(`📈 Strategies Checked: ${stats.strategiesChecked}`);
            console.log(`🎯 Signals Detected: ${stats.signalsDetected}`);
            console.log(`📥 Positions Opened: ${stats.positionsOpened}`);
            console.log(`📤 Positions Closed: ${stats.positionsClosed}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            return stats;

        } catch (error) {
            console.error('Momentum worker cycle failed', error.message, error.stack);
            throw error;
        }
    },

    /**
     * Get all active strategies from database via API
     * @private
     */
    async _getAllActiveStrategies() {
        try {
            const response = await fetch('/api/v1/momentum/strategies/active', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch active strategies: ${response.statusText}`);
            }

            const { data } = await response.json();
            return data;

        } catch (error) {
            console.error('Failed to fetch active strategies', error.message);
            throw error;
        }
    },

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
            console.log(`\n   🔍 Processing Strategy ID: ${strategy.id} (${strategy.exchange.toUpperCase()}) - ${strategy.strategy_name || 'Unnamed'}`);

            // Get credentials from localStorage (like triangular arb)
            const apiKey = localStorage.getItem(`${strategy.exchange}_momentum_api`);
            const apiSecret = localStorage.getItem(`${strategy.exchange}_momentum_secret`);
            const apiPassphrase = localStorage.getItem(`${strategy.exchange}_momentum_passphrase`);

            if (!apiKey || !apiSecret) {
                console.log(`      ⚠️  No credentials found for ${strategy.exchange} - skipping`);
                return results;
            }

            const credentials = {
                apiKey,
                apiSecret,
                ...(apiPassphrase && { apiPassphrase })
            };

            // Monitor existing positions (check exits)
            console.log(`      🔍 Calling PositionMonitor.monitorPositions for ${strategy.exchange}...`);
            let closedPositions = [];
            try {
                closedPositions = await PositionMonitor.monitorPositions(
                    strategy.user_id,
                    strategy.exchange,
                    credentials
                );
                console.log(`      ✓ PositionMonitor completed - ${closedPositions.length} position(s) closed`);
            } catch (error) {
                console.error(`      ❌ PositionMonitor FAILED for ${strategy.exchange}:`, error.message);
                console.error(`      Stack:`, error.stack);
                // Continue with entry signals even if position monitoring failed
            }

            results.positionsClosed = closedPositions.length;

            if (closedPositions.length > 0) {
                console.log(`      📤 Closed ${closedPositions.length} position(s)`);
                closedPositions.forEach(pos => {
                    console.log(`         ✓ ${pos.pair}: ${pos.exit_reason} (${pos.pnl_percentage > 0 ? '+' : ''}${pos.pnl_percentage?.toFixed(2)}%)`);
                });
            }

            // Check for new entry signals
            const entryResults = await this._checkEntrySignals(
                strategy,
                credentials
            );

            results.signalsDetected = entryResults.signalsDetected;
            results.positionsOpened = entryResults.positionsOpened;

            if (entryResults.signalsDetected > 0) {
                console.log(`      🎯 Detected ${entryResults.signalsDetected} signal(s)`);
            }

            if (entryResults.positionsOpened > 0) {
                console.log(`      📥 Opened ${entryResults.positionsOpened} position(s)`);
            }

            if (results.positionsClosed === 0 && results.signalsDetected === 0 && results.positionsOpened === 0) {
                console.log(`      ✓ No activity`);
            }

            return results;

        } catch (error) {
            console.error('Failed to process strategy', {
                strategyId: strategy.id,
                error: error.message
            });
            return results;
        }
    },

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

        console.debug('Asset rotation batch', {
            strategyId: strategy.id,
            totalAssets,
            batchSize: batch.length,
            checking: `${startIndex + 1}-${endIndex} of ${totalAssets}`,
            nextCycleStarts: nextIndex
        });

        return batch;
    },

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

            // Fetch candle data via API
            // Use strategy's configured timeframe (1m/5m/15m)
            // Binance allows up to 1000 candles - request maximum for best indicator accuracy
            // 1000 candles: 1m = ~16.7 hours, 5m = ~3.5 days, 15m = ~10.4 days of historical data
            const timeframe = strategy.timeframe || '5m'; // Default to 5m if not set
            const candleResponse = await fetch('/api/v1/momentum/market/candles', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    exchange: strategy.exchange,
                    pair,
                    interval: timeframe,
                    limit: 1000,
                    credentials
                })
            });

            if (!candleResponse.ok) {
                throw new Error(`Failed to fetch candles: ${candleResponse.statusText}`);
            }

            const { data: candles } = await candleResponse.json();

            // Need minimum 8 candles for RSI-7 calculation (period + 1)
            // VALR's public trades endpoint only provides ~8 minutes of recent data
            if (!candles || candles.length < 8) {
                console.warn('Insufficient candle data', {
                    pair,
                    candlesCount: candles?.length || 0,
                    minimumRequired: 8
                });
                return { asset, pair, hasSignal: false };
            }

            console.log(`   📊 Candles fetched: ${candles.length} (${candles[0].timestamp} to ${candles[candles.length - 1].timestamp})`);

            // Check entry signals using SignalDetection
            const signalResult = await SignalDetection.checkEntrySignals(
                candles,
                strategy
            );

            // Get requirement text based on entry logic
            const getRequirementText = (entryLogic) => {
                switch(entryLogic) {
                    case 'any_1': return '1+';
                    case 'all': return 'all';
                    case '3_out_of_4': return '3+';
                    case '2_out_of_3':
                    default: return '2+';
                }
            };

            // Debug: Show indicator values and which ones triggered
            console.log(`   🔍 Indicators: ${signalResult.triggeredCount}/${signalResult.totalEnabled} triggered (need ${getRequirementText(strategy.entry_logic)})`);
            if (signalResult.indicatorValues) {
                console.log(`      📊 RSI: ${signalResult.indicatorValues.rsi?.toFixed(2) || 'N/A'}`);
                console.log(`      📈 Volume: ${signalResult.indicatorValues.volume?.volumeRatio?.toFixed(2) || 'N/A'}x avg`);
                console.log(`      📉 MACD: ${signalResult.indicatorValues.macd?.histogram?.toFixed(4) || 'N/A'}`);
                console.log(`      🔄 EMA: Fast ${signalResult.indicatorValues.ema?.fastEMA?.toFixed(2) || 'N/A'} / Slow ${signalResult.indicatorValues.ema?.slowEMA?.toFixed(2) || 'N/A'}`);
                console.log(`      📏 Bollinger: %B ${signalResult.indicatorValues.bollinger?.percentB?.toFixed(2) || 'N/A'}`);
                console.log(`      ⚡ Stochastic: %K ${signalResult.indicatorValues.stochastic?.k?.toFixed(2) || 'N/A'}`);
            }
            if (signalResult.triggeredIndicators.length > 0) {
                console.log(`      ✅ Triggered:`, signalResult.triggeredIndicators.map(i => i.name).join(', '));
            } else {
                console.log(`      ❌ No indicators triggered`);
            }

            return {
                asset,
                pair,
                candles,
                signalResult,
                hasSignal: signalResult.shouldEnter
            };

        } catch (error) {
            console.error('Failed to check entry signal for asset', {
                strategyId: strategy.id,
                asset,
                error: error.message
            });
            return { asset, hasSignal: false, error };
        }
    },

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
            // Check if strategy can open more positions via API
            const canOpenResponse = await fetch(`/api/v1/momentum/strategies/${strategy.id}/can-open-position`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!canOpenResponse.ok) {
                throw new Error(`Failed to check position limit: ${canOpenResponse.statusText}`);
            }

            const { data: canOpenMore } = await canOpenResponse.json();

            if (!canOpenMore) {
                console.debug('Strategy has reached max open positions', {
                    strategyId: strategy.id,
                    maxPositions: strategy.max_open_positions
                });
                return results;
            }

            // Get asset batch for this cycle (uses rotation for large coin lists)
            const assetBatch = this._getAssetBatch(strategy);

            console.debug('Checking entry signals', {
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

                    console.debug('Parallel batch processed', {
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

            // Save indicator results to localStorage for UI display
            this._saveIndicatorResults(strategy.id, allSignals);

            // Filter signals that triggered
            const triggeredSignals = allSignals.filter(s => s.hasSignal);
            results.signalsDetected = triggeredSignals.length;

            // Prioritize signals: strongest signals first (more indicators triggered)
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
                console.log('Prioritized signals ready for execution', {
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
                console.log('🎯 Entry signal detected', {
                    strategyId: strategy.id,
                    strategyName: strategy.strategy_name,
                    pair: signal.pair,
                    triggeredIndicators: signal.signalResult.triggeredIndicators,
                    triggeredCount: signal.signalResult.triggeredCount,
                    totalEnabled: signal.signalResult.totalEnabled
                });

                const indicatorNames = signal.signalResult.triggeredIndicators.map(i => i.name).join(', ');
                console.log(`         🎯 Signal: ${signal.pair} (${signal.signalResult.triggeredCount}/${signal.signalResult.totalEnabled}) - ${indicatorNames}`);

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
                    const stillCanOpenResponse = await fetch(`/api/v1/momentum/strategies/${strategy.id}/can-open-position`, {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    const { data: stillCanOpen } = await stillCanOpenResponse.json();

                    if (!stillCanOpen) {
                        console.log(`         ⚠️  Max positions reached - stopping entry checks`);
                        break; // Stop checking more assets for this strategy
                    }
                }
            }

            return results;

        } catch (error) {
            console.error('Failed to check entry signals', {
                strategyId: strategy.id,
                error: error.message
            });
            throw error;
        }
    },

    /**
     * Open a new position
     * @private
     */
    async _openPosition(strategy, asset, pair, currentPrice, triggeredIndicators, credentials) {
        try {
            console.log('Opening new position', {
                strategyId: strategy.id,
                pair,
                tradeAmount: strategy.max_trade_amount
            });

            // Execute market BUY order via API
            const orderResponse = await fetch('/api/v1/momentum/order/buy', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    exchange: strategy.exchange,
                    pair,
                    amountUSDT: strategy.max_trade_amount,
                    credentials
                })
            });

            if (!orderResponse.ok) {
                throw new Error(`Failed to execute buy order: ${orderResponse.statusText}`);
            }

            const responseData = await orderResponse.json();
            const buyOrder = responseData.data;

            // Log COMPLETE response for debugging
            console.log('🔍 RAW BUY ORDER RESPONSE:', JSON.stringify(responseData, null, 2));
            console.log('Buy order executed', {
                orderId: buyOrder.orderId,
                executedPrice: buyOrder.executedPrice,
                executedQuantity: buyOrder.executedQuantity,
                executedValue: buyOrder.executedValue,
                fee: buyOrder.fee,
                rawResponse: buyOrder.rawResponse
            });

            // Extract entry fee from order (estimate 0.1% if not provided)
            const entryValueUSDT = buyOrder.executedValue || strategy.max_trade_amount;
            const entryFee = buyOrder.fee || (entryValueUSDT * 0.001); // 0.1% conservative estimate

            // Create position in database via API
            const positionResponse = await fetch('/api/v1/momentum/positions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    userId: strategy.user_id,
                    strategyId: strategy.id,
                    exchange: strategy.exchange,
                    asset: asset,
                    pair: pair,
                    entryPrice: buyOrder.executedPrice,
                    entryQuantity: buyOrder.executedQuantity,
                    entryValueUSDT: entryValueUSDT,
                    entryFee: entryFee,
                    entrySignals: triggeredIndicators,
                    entryOrderId: buyOrder.orderId
                })
            });

            if (!positionResponse.ok) {
                throw new Error(`Failed to create position: ${positionResponse.statusText}`);
            }

            const { data: position } = await positionResponse.json();

            console.log('✅ Position opened successfully', {
                positionId: position.id,
                strategyId: strategy.id,
                pair,
                entryPrice: position.entry_price,
                quantity: position.entry_quantity
            });

            console.log(`         ✅ Position opened: ${pair} @ $${position.entry_price} (Qty: ${position.entry_quantity})`);

            return position;

        } catch (error) {
            console.error('Failed to open position', {
                strategyId: strategy.id,
                pair,
                error: error.message
            });
            console.error(`         ❌ Failed to open position for ${pair}: ${error.message}`);
            return null;
        }
    },

    /**
     * Save indicator results to localStorage for UI display
     * @private
     */
    _saveIndicatorResults(strategyId, allSignals) {
        try {
            // Get existing stored results
            const storedResults = JSON.parse(localStorage.getItem('momentum_indicator_results') || '{}');

            // Build indicator summary for this strategy
            const strategyData = {
                lastUpdate: Date.now(),
                assets: {}
            };

            // Process each asset's signal results
            allSignals.forEach(signal => {
                if (signal && signal.signalResult) {
                    const { asset, pair, signalResult } = signal;

                    strategyData.assets[asset] = {
                        pair,
                        indicators: {
                            rsi: signalResult.indicatorValues?.rsi || null,
                            volume: signalResult.indicatorValues?.volume?.volumeRatio || null,
                            macd: signalResult.indicatorValues?.macd ? {
                                histogram: signalResult.indicatorValues.macd.histogram,
                                crossover: signalResult.indicatorValues.macd.crossover
                            } : null,
                            ema: {
                                fast: signalResult.indicatorValues?.ema?.fastEMA || null,
                                slow: signalResult.indicatorValues?.ema?.slowEMA || null,
                                crossover: signalResult.indicatorValues?.ema?.crossover || false
                            },
                            bollinger: signalResult.indicatorValues?.bollinger?.percentB || null,
                            stochastic: signalResult.indicatorValues?.stochastic?.k || null
                        },
                        triggeredCount: signalResult.triggeredCount || 0,
                        totalEnabled: signalResult.totalEnabled || 0,
                        triggeredIndicators: signalResult.triggeredIndicators || []
                    };
                }
            });

            // Store results for this strategy
            storedResults[strategyId] = strategyData;

            // Save to localStorage
            localStorage.setItem('momentum_indicator_results', JSON.stringify(storedResults));

            console.debug('Saved indicator results to localStorage', {
                strategyId,
                assetsCount: Object.keys(strategyData.assets).length
            });

        } catch (error) {
            console.error('Failed to save indicator results', {
                strategyId,
                error: error.message
            });
        }
    },

    /**
     * Get worker status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            intervalMs: 60000
        };
    }
};
