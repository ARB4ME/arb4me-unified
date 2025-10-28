// Signal Detection Service
// Determines entry/exit signals based on indicator combinations

const IndicatorService = require('./IndicatorService');
const { logger } = require('../../utils/logger');

class SignalDetectionService {
    /**
     * Check for entry signals based on strategy configuration
     * @param {Array} candles - Array of candles with OHLCV data
     * @param {Object} strategy - Strategy configuration
     * @returns {Object} {shouldEnter, triggeredIndicators, indicatorValues}
     */
    static async checkEntrySignals(candles, strategy) {
        try {
            const { entry_indicators, entry_logic } = strategy;

            // Calculate all enabled indicators
            const indicatorResults = {};
            const triggeredIndicators = [];
            const indicatorValues = {};

            // RSI
            if (entry_indicators.rsi && entry_indicators.rsi.enabled) {
                try {
                    const rsi = IndicatorService.calculateRSI(
                        candles,
                        entry_indicators.rsi.period
                    );
                    indicatorValues.rsi = rsi;

                    // Check if RSI is oversold (buy signal)
                    if (rsi < entry_indicators.rsi.oversold) {
                        indicatorResults.rsi = true;
                        triggeredIndicators.push({
                            name: 'RSI',
                            value: rsi,
                            condition: `< ${entry_indicators.rsi.oversold} (Oversold)`
                        });
                    } else {
                        indicatorResults.rsi = false;
                    }
                } catch (error) {
                    logger.warn('RSI calculation failed for signal detection', { error: error.message });
                    indicatorResults.rsi = false;
                }
            }

            // Volume Spike
            if (entry_indicators.volume && entry_indicators.volume.enabled) {
                try {
                    const volumeSpike = IndicatorService.calculateVolumeSpike(
                        candles,
                        entry_indicators.volume.period,
                        entry_indicators.volume.multiplier
                    );
                    indicatorValues.volume = volumeSpike;

                    if (volumeSpike.isSpike) {
                        indicatorResults.volume = true;
                        triggeredIndicators.push({
                            name: 'Volume Spike',
                            value: volumeSpike.volumeRatio,
                            condition: `${volumeSpike.volumeRatio}x average (>${entry_indicators.volume.multiplier}x)`
                        });
                    } else {
                        indicatorResults.volume = false;
                    }
                } catch (error) {
                    logger.warn('Volume calculation failed for signal detection', { error: error.message });
                    indicatorResults.volume = false;
                }
            }

            // MACD
            if (entry_indicators.macd && entry_indicators.macd.enabled) {
                try {
                    const macd = IndicatorService.calculateMACD(
                        candles,
                        entry_indicators.macd.fast,
                        entry_indicators.macd.slow,
                        entry_indicators.macd.signal
                    );
                    indicatorValues.macd = macd;

                    // Check for bullish crossover
                    if (macd.crossover) {
                        indicatorResults.macd = true;
                        triggeredIndicators.push({
                            name: 'MACD',
                            value: macd.histogram,
                            condition: 'Bullish Crossover'
                        });
                    } else {
                        indicatorResults.macd = false;
                    }
                } catch (error) {
                    logger.warn('MACD calculation failed for signal detection', { error: error.message });
                    indicatorResults.macd = false;
                }
            }

            // EMA Crossover (if added in future)
            if (entry_indicators.ema && entry_indicators.ema.enabled) {
                try {
                    const ema = IndicatorService.calculateEMACrossover(
                        candles,
                        entry_indicators.ema.fast,
                        entry_indicators.ema.slow
                    );
                    indicatorValues.ema = ema;

                    if (ema.crossover) {
                        indicatorResults.ema = true;
                        triggeredIndicators.push({
                            name: 'EMA Crossover',
                            value: `${ema.fastEMA} / ${ema.slowEMA}`,
                            condition: 'Fast crossed above Slow'
                        });
                    } else {
                        indicatorResults.ema = false;
                    }
                } catch (error) {
                    logger.warn('EMA calculation failed for signal detection', { error: error.message });
                    indicatorResults.ema = false;
                }
            }

            // Bollinger Bands (if added in future)
            if (entry_indicators.bollinger && entry_indicators.bollinger.enabled) {
                try {
                    const bb = IndicatorService.calculateBollingerBands(
                        candles,
                        entry_indicators.bollinger.period,
                        entry_indicators.bollinger.stdDev
                    );
                    indicatorValues.bollinger = bb;

                    if (bb.nearLowerBand) {
                        indicatorResults.bollinger = true;
                        triggeredIndicators.push({
                            name: 'Bollinger Bands',
                            value: bb.percentB,
                            condition: 'Price near lower band'
                        });
                    } else {
                        indicatorResults.bollinger = false;
                    }
                } catch (error) {
                    logger.warn('Bollinger Bands calculation failed for signal detection', { error: error.message });
                    indicatorResults.bollinger = false;
                }
            }

            // Stochastic Oscillator
            if (entry_indicators.stochastic && entry_indicators.stochastic.enabled) {
                try {
                    const stochastic = IndicatorService.calculateStochastic(
                        candles,
                        entry_indicators.stochastic.period,
                        entry_indicators.stochastic.smoothK,
                        entry_indicators.stochastic.smoothD
                    );
                    indicatorValues.stochastic = stochastic;

                    if (stochastic.oversold) {
                        indicatorResults.stochastic = true;
                        triggeredIndicators.push({
                            name: 'Stochastic',
                            value: `%K: ${stochastic.k}`,
                            condition: 'Oversold (< 20)'
                        });
                    } else {
                        indicatorResults.stochastic = false;
                    }
                } catch (error) {
                    logger.warn('Stochastic calculation failed for signal detection', { error: error.message });
                    indicatorResults.stochastic = false;
                }
            }

            // Determine if entry signal is triggered based on entry logic
            const shouldEnter = this._evaluateEntryLogic(
                indicatorResults,
                entry_logic
            );

            return {
                shouldEnter,
                triggeredIndicators,
                indicatorValues,
                triggeredCount: triggeredIndicators.length,
                totalEnabled: Object.keys(indicatorResults).length
            };

        } catch (error) {
            logger.error('Entry signal check failed', {
                strategyId: strategy.id,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Check for exit signals based on exit rules
     * @param {Object} position - Current position
     * @param {number} currentPrice - Current market price
     * @param {Object} exitRules - Exit rules configuration
     * @returns {Object} {shouldExit, reason}
     */
    static checkExitSignals(position, currentPrice, exitRules) {
        try {
            const entryPrice = position.entry_price;
            const entryTime = new Date(position.entry_time);
            const hoursOpen = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);

            // Calculate current P&L percentage
            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

            // Check Take Profit (only in Auto mode, skip if Manual mode)
            const takeProfitMode = exitRules.takeProfitMode || 'auto'; // Default to 'auto' for backward compatibility

            if (takeProfitMode === 'auto' && exitRules.takeProfitPercent && pnlPercent >= exitRules.takeProfitPercent) {
                return {
                    shouldExit: true,
                    reason: 'take_profit',
                    details: `+${pnlPercent.toFixed(2)}% (Target: ${exitRules.takeProfitPercent}%)`
                };
            }

            // Check Stop Loss
            if (exitRules.stopLossPercent && pnlPercent <= -exitRules.stopLossPercent) {
                return {
                    shouldExit: true,
                    reason: 'stop_loss',
                    details: `${pnlPercent.toFixed(2)}% (Max Loss: ${exitRules.stopLossPercent}%)`
                };
            }

            // Check Max Hold Time
            if (exitRules.maxHoldTimeHours && hoursOpen >= exitRules.maxHoldTimeHours) {
                return {
                    shouldExit: true,
                    reason: 'max_hold_time',
                    details: `${hoursOpen.toFixed(1)}h (Max: ${exitRules.maxHoldTimeHours}h)`
                };
            }

            // Check indicator-based exit (if configured)
            // TODO: Add indicator-based exit signals (e.g., RSI overbought, MACD bearish crossover)

            return {
                shouldExit: false,
                reason: null,
                currentPnL: pnlPercent,
                hoursOpen: hoursOpen
            };

        } catch (error) {
            logger.error('Exit signal check failed', {
                positionId: position.id,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Evaluate entry logic based on triggered indicators
     * @private
     * @param {Object} indicatorResults - Object with indicator results {rsi: true/false, volume: true/false, ...}
     * @param {string} entryLogic - Entry logic type ('2_out_of_3', '3_out_of_4', 'all', 'any_1')
     * @returns {boolean} Should enter position
     */
    static _evaluateEntryLogic(indicatorResults, entryLogic) {
        const results = Object.values(indicatorResults);
        const triggeredCount = results.filter(r => r === true).length;
        const totalCount = results.length;

        switch (entryLogic) {
            case 'all':
                // All indicators must be true
                return triggeredCount === totalCount && totalCount > 0;

            case 'any_1':
                // Any one indicator triggers
                return triggeredCount >= 1;

            case '3_out_of_4':
                // At least 3 indicators must trigger
                if (totalCount >= 4) {
                    return triggeredCount >= 3;
                } else if (totalCount === 3) {
                    return triggeredCount >= 3; // All 3 must trigger if only 3 enabled
                } else if (totalCount === 2) {
                    return triggeredCount >= 2; // Both must trigger if only 2 enabled
                } else if (totalCount === 1) {
                    return triggeredCount >= 1; // Must trigger if only 1 enabled
                }
                return false;

            case '2_out_of_3':
            default:
                // At least 2 indicators must trigger (if 3+ indicators enabled)
                if (totalCount >= 3) {
                    return triggeredCount >= 2;
                } else if (totalCount === 2) {
                    return triggeredCount >= 2; // Both must trigger if only 2 enabled
                } else if (totalCount === 1) {
                    return triggeredCount >= 1; // Must trigger if only 1 enabled
                }
                return false;
        }
    }

    /**
     * Get indicator summary for logging/display
     * @param {Array} candles - Array of candles with OHLCV data
     * @param {Object} indicators - Indicator configuration
     * @returns {Object} Indicator values
     */
    static async getIndicatorSummary(candles, indicators) {
        const summary = {};

        if (indicators.rsi && indicators.rsi.enabled) {
            try {
                summary.rsi = IndicatorService.calculateRSI(candles, indicators.rsi.period);
            } catch (error) {
                summary.rsi = 'N/A';
            }
        }

        if (indicators.volume && indicators.volume.enabled) {
            try {
                const volumeData = IndicatorService.calculateVolumeSpike(
                    candles,
                    indicators.volume.period,
                    indicators.volume.multiplier
                );
                summary.volumeRatio = volumeData.volumeRatio;
            } catch (error) {
                summary.volumeRatio = 'N/A';
            }
        }

        if (indicators.macd && indicators.macd.enabled) {
            try {
                const macdData = IndicatorService.calculateMACD(
                    candles,
                    indicators.macd.fast,
                    indicators.macd.slow,
                    indicators.macd.signal
                );
                summary.macd = {
                    line: macdData.macdLine,
                    signal: macdData.signalLine,
                    histogram: macdData.histogram
                };
            } catch (error) {
                summary.macd = 'N/A';
            }
        }

        return summary;
    }
}

module.exports = SignalDetectionService;
