// Indicator Calculation Service
// Calculates technical indicators (RSI, MACD, Volume, EMA, Bollinger Bands)

const { logger } = require('../../utils/logger');

class IndicatorService {
    /**
     * Calculate RSI (Relative Strength Index)
     * @param {Array} candles - Array of candles [{close: number, ...}]
     * @param {number} period - RSI period (default 14)
     * @returns {number} RSI value (0-100)
     */
    static calculateRSI(candles, period = 14) {
        try {
            if (!candles || candles.length < period + 1) {
                throw new Error(`Need at least ${period + 1} candles for RSI calculation`);
            }

            // Calculate price changes
            const changes = [];
            for (let i = 1; i < candles.length; i++) {
                changes.push(candles[i].close - candles[i - 1].close);
            }

            // Calculate average gains and losses
            let avgGain = 0;
            let avgLoss = 0;

            // Initial average (SMA of first period)
            for (let i = 0; i < period; i++) {
                if (changes[i] > 0) {
                    avgGain += changes[i];
                } else {
                    avgLoss += Math.abs(changes[i]);
                }
            }
            avgGain /= period;
            avgLoss /= period;

            // Smoothed averages for remaining periods
            for (let i = period; i < changes.length; i++) {
                if (changes[i] > 0) {
                    avgGain = (avgGain * (period - 1) + changes[i]) / period;
                    avgLoss = (avgLoss * (period - 1)) / period;
                } else {
                    avgGain = (avgGain * (period - 1)) / period;
                    avgLoss = (avgLoss * (period - 1) + Math.abs(changes[i])) / period;
                }
            }

            // Calculate RS and RSI
            if (avgLoss === 0) {
                return 100; // If no losses, RSI is 100
            }

            const rs = avgGain / avgLoss;
            const rsi = 100 - (100 / (1 + rs));

            return parseFloat(rsi.toFixed(2));

        } catch (error) {
            logger.error('RSI calculation failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Calculate MACD (Moving Average Convergence Divergence)
     * @param {Array} candles - Array of candles [{close: number, ...}]
     * @param {number} fastPeriod - Fast EMA period (default 12)
     * @param {number} slowPeriod - Slow EMA period (default 26)
     * @param {number} signalPeriod - Signal EMA period (default 9)
     * @returns {Object} {macdLine, signalLine, histogram, crossover}
     */
    static calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        try {
            if (!candles || candles.length < slowPeriod + signalPeriod) {
                throw new Error(`Need at least ${slowPeriod + signalPeriod} candles for MACD calculation`);
            }

            const closes = candles.map(c => c.close);

            // Calculate fast and slow EMAs
            const fastEMA = this._calculateEMA(closes, fastPeriod);
            const slowEMA = this._calculateEMA(closes, slowPeriod);

            // Calculate MACD line
            const macdLine = fastEMA - slowEMA;

            // Calculate signal line (EMA of MACD line)
            // We need previous MACD values for signal line EMA
            const macdValues = [];
            for (let i = slowPeriod - 1; i < candles.length; i++) {
                const fast = this._calculateEMA(closes.slice(0, i + 1), fastPeriod);
                const slow = this._calculateEMA(closes.slice(0, i + 1), slowPeriod);
                macdValues.push(fast - slow);
            }

            const signalLine = this._calculateEMA(macdValues, signalPeriod);
            const histogram = macdLine - signalLine;

            // Check for bullish crossover (MACD crosses above signal)
            const prevMACD = macdValues[macdValues.length - 2];
            const prevSignal = macdValues.length >= signalPeriod ?
                this._calculateEMA(macdValues.slice(0, -1), signalPeriod) :
                signalLine;

            const crossover = prevMACD <= prevSignal && macdLine > signalLine;

            return {
                macdLine: parseFloat(macdLine.toFixed(6)),
                signalLine: parseFloat(signalLine.toFixed(6)),
                histogram: parseFloat(histogram.toFixed(6)),
                crossover: crossover // Bullish crossover signal
            };

        } catch (error) {
            logger.error('MACD calculation failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Calculate Volume Spike
     * @param {Array} candles - Array of candles [{volume: number, ...}]
     * @param {number} period - Lookback period for average (default 20)
     * @param {number} multiplier - Spike multiplier (default 2.0)
     * @returns {Object} {currentVolume, avgVolume, volumeRatio, isSpike}
     */
    static calculateVolumeSpike(candles, period = 20, multiplier = 2.0) {
        try {
            if (!candles || candles.length < period) {
                throw new Error(`Need at least ${period} candles for volume spike calculation`);
            }

            const currentVolume = candles[candles.length - 1].volume;

            // Calculate average volume over period (excluding current)
            let sumVolume = 0;
            for (let i = candles.length - period - 1; i < candles.length - 1; i++) {
                sumVolume += candles[i].volume;
            }
            const avgVolume = sumVolume / period;

            const volumeRatio = currentVolume / avgVolume;
            const isSpike = volumeRatio >= multiplier;

            return {
                currentVolume: parseFloat(currentVolume.toFixed(2)),
                avgVolume: parseFloat(avgVolume.toFixed(2)),
                volumeRatio: parseFloat(volumeRatio.toFixed(2)),
                isSpike: isSpike
            };

        } catch (error) {
            logger.error('Volume spike calculation failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Calculate EMA Crossover
     * @param {Array} candles - Array of candles [{close: number, ...}]
     * @param {number} fastPeriod - Fast EMA period (default 9)
     * @param {number} slowPeriod - Slow EMA period (default 21)
     * @returns {Object} {fastEMA, slowEMA, crossover}
     */
    static calculateEMACrossover(candles, fastPeriod = 9, slowPeriod = 21) {
        try {
            if (!candles || candles.length < slowPeriod) {
                throw new Error(`Need at least ${slowPeriod} candles for EMA crossover calculation`);
            }

            const closes = candles.map(c => c.close);

            const fastEMA = this._calculateEMA(closes, fastPeriod);
            const slowEMA = this._calculateEMA(closes, slowPeriod);

            // Check for bullish crossover (fast crosses above slow)
            const prevCloses = closes.slice(0, -1);
            const prevFastEMA = this._calculateEMA(prevCloses, fastPeriod);
            const prevSlowEMA = this._calculateEMA(prevCloses, slowPeriod);

            const crossover = prevFastEMA <= prevSlowEMA && fastEMA > slowEMA;

            return {
                fastEMA: parseFloat(fastEMA.toFixed(6)),
                slowEMA: parseFloat(slowEMA.toFixed(6)),
                crossover: crossover // Bullish crossover signal
            };

        } catch (error) {
            logger.error('EMA crossover calculation failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Calculate Bollinger Bands
     * @param {Array} candles - Array of candles [{close: number, ...}]
     * @param {number} period - MA period (default 20)
     * @param {number} stdDevMultiplier - Standard deviation multiplier (default 2)
     * @returns {Object} {upper, middle, lower, percentB, width}
     */
    static calculateBollingerBands(candles, period = 20, stdDevMultiplier = 2) {
        try {
            if (!candles || candles.length < period) {
                throw new Error(`Need at least ${period} candles for Bollinger Bands calculation`);
            }

            const closes = candles.map(c => c.close);
            const recentCloses = closes.slice(-period);

            // Calculate middle band (SMA)
            const middle = recentCloses.reduce((a, b) => a + b, 0) / period;

            // Calculate standard deviation
            const squaredDiffs = recentCloses.map(close => Math.pow(close - middle, 2));
            const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
            const stdDev = Math.sqrt(variance);

            // Calculate upper and lower bands
            const upper = middle + (stdDev * stdDevMultiplier);
            const lower = middle - (stdDev * stdDevMultiplier);

            // Calculate %B (where price is relative to bands)
            const currentPrice = closes[closes.length - 1];
            const percentB = (currentPrice - lower) / (upper - lower);

            // Calculate band width
            const width = (upper - lower) / middle;

            return {
                upper: parseFloat(upper.toFixed(6)),
                middle: parseFloat(middle.toFixed(6)),
                lower: parseFloat(lower.toFixed(6)),
                percentB: parseFloat(percentB.toFixed(4)),
                width: parseFloat(width.toFixed(4)),
                // Signal: price near lower band indicates potential buy
                nearLowerBand: percentB < 0.2
            };

        } catch (error) {
            logger.error('Bollinger Bands calculation failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Calculate Stochastic Oscillator
     * @param {Array} candles - Array of candles [{high, low, close}]
     * @param {number} period - %K period (default 14)
     * @param {number} smoothK - %K smoothing (default 3)
     * @param {number} smoothD - %D smoothing (default 3)
     * @returns {Object} {k, d, oversold}
     */
    static calculateStochastic(candles, period = 14, smoothK = 3, smoothD = 3) {
        try {
            if (!candles || candles.length < period + smoothK + smoothD) {
                throw new Error(`Need at least ${period + smoothK + smoothD} candles for Stochastic calculation`);
            }

            const recentCandles = candles.slice(-period);

            // Find highest high and lowest low over period
            const highs = recentCandles.map(c => c.high);
            const lows = recentCandles.map(c => c.low);
            const highestHigh = Math.max(...highs);
            const lowestLow = Math.min(...lows);

            const currentClose = candles[candles.length - 1].close;

            // Calculate raw %K
            const rawK = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

            // Smooth %K (using SMA of raw %K values)
            // For simplicity, we'll use the raw %K (in real implementation, would smooth over smoothK periods)
            const k = rawK;

            // Calculate %D (SMA of %K)
            // For simplicity, using %K as %D (in real implementation, would use SMA of %K values)
            const d = k;

            return {
                k: parseFloat(k.toFixed(2)),
                d: parseFloat(d.toFixed(2)),
                oversold: k < 20 // Oversold signal
            };

        } catch (error) {
            logger.error('Stochastic calculation failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Calculate EMA (Exponential Moving Average)
     * @private
     * @param {Array} values - Array of values
     * @param {number} period - EMA period
     * @returns {number} EMA value
     */
    static _calculateEMA(values, period) {
        if (values.length < period) {
            throw new Error(`Need at least ${period} values for EMA calculation`);
        }

        // Calculate SMA for initial EMA
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += values[i];
        }
        let ema = sum / period;

        // Calculate multiplier
        const multiplier = 2 / (period + 1);

        // Calculate EMA for remaining values
        for (let i = period; i < values.length; i++) {
            ema = (values[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Calculate SMA (Simple Moving Average)
     * @private
     * @param {Array} values - Array of values
     * @param {number} period - SMA period
     * @returns {number} SMA value
     */
    static _calculateSMA(values, period) {
        if (values.length < period) {
            throw new Error(`Need at least ${period} values for SMA calculation`);
        }

        const recentValues = values.slice(-period);
        const sum = recentValues.reduce((a, b) => a + b, 0);
        return sum / period;
    }
}

module.exports = IndicatorService;
