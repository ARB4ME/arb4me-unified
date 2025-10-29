// VALR Market Data Service
// Fetches candle data and current prices from VALR API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class VALRMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.valr.com';

        // Rate limiting: Max 5 requests per second (200ms between requests)
        this.minRequestInterval = 200; // milliseconds
        this.lastRequestTime = 0;
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
     * Prevents hitting VALR's rate limits
     * @private
     */
    async _rateLimitDelay() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestInterval) {
            const delayNeeded = this.minRequestInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, delayNeeded));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Fetch historical candles (OHLCV data) for indicator calculations
     * NOTE: VALR doesn't have a dedicated candles endpoint, so we build them from recent trades
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT', 'ETHUSDT')
     * @param {string} interval - Candle interval ('1m', '5m', '15m', '30m', '1h', '4h', '1d')
     * @param {number} limit - Number of candles to fetch (default 100, but may return less based on available trades)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // VALR doesn't have a candles endpoint - we need to build candles from recent trades
            // Use the public trades endpoint: /v1/public/:currencyPair/trades
            const path = `/v1/public/${pair}/trades`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching VALR trades to build candles', { pair, interval, limit });

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR API error: ${response.status} - ${errorText}`);
            }

            const trades = await response.json();

            // Convert interval to milliseconds
            const intervalMs = this._convertIntervalToMs(interval);

            // Build candles from trades
            const candles = this._buildCandlesFromTrades(trades, intervalMs, limit);

            logger.info('VALR candles built from trades', {
                pair,
                tradesCount: trades.length,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch VALR candles', {
                pair,
                interval,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current market price for a pair
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<number>} Current market price
     */
    async fetchCurrentPrice(pair, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Use VALR ticker endpoint
            const path = `/v1/marketdata/${pair}/marketsummary`;
            const url = `${this.baseUrl}${path}`;

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'GET',
                path,
                null
            );

            logger.debug('Fetching VALR current price', { pair });

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // VALR market summary includes lastTradedPrice, bidPrice, askPrice
            const currentPrice = parseFloat(data.lastTradedPrice || data.midPrice);

            logger.debug('VALR current price fetched', { pair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch VALR current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch order book for a pair (for bid/ask analysis)
     * @param {string} pair - Trading pair
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} { bids: [], asks: [] }
     */
    async fetchOrderBook(pair, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const path = `/v1/marketdata/${pair}/orderbook`;
            const url = `${this.baseUrl}${path}`;

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'GET',
                path,
                null
            );

            logger.debug('Fetching VALR order book', { pair });

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            return {
                bids: data.Bids || [],
                asks: data.Asks || []
            };

        } catch (error) {
            logger.error('Failed to fetch VALR order book', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test connection to VALR API
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const path = '/v1/account/balances';
            const url = `${this.baseUrl}${path}`;

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'GET',
                path,
                null
            );

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            logger.info('VALR connection test successful', {
                balancesCount: data.length
            });

            return true;

        } catch (error) {
            logger.error('VALR connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create VALR authentication headers
     * @private
     */
    _createValrAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now();
        const payload = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : '');

        const signature = crypto
            .createHmac('sha512', apiSecret)
            .update(payload)
            .digest('hex');

        return {
            'X-VALR-API-KEY': apiKey,
            'X-VALR-SIGNATURE': signature,
            'X-VALR-TIMESTAMP': timestamp.toString(),
            'Content-Type': 'application/json'
        };
    }

    /**
     * Convert standard interval format to VALR format
     * @private
     */
    _convertInterval(interval) {
        const intervalMap = {
            '1m': 'ONE_MINUTE',
            '5m': 'FIVE_MINUTES',
            '15m': 'FIFTEEN_MINUTES',
            '30m': 'THIRTY_MINUTES',
            '1h': 'ONE_HOUR',
            '4h': 'FOUR_HOURS',
            '1d': 'ONE_DAY'
        };

        return intervalMap[interval] || 'ONE_HOUR';
    }

    /**
     * Convert interval string to milliseconds
     * @private
     */
    _convertIntervalToMs(interval) {
        const intervalMap = {
            '1m': 60 * 1000,
            '5m': 5 * 60 * 1000,
            '15m': 15 * 60 * 1000,
            '30m': 30 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '4h': 4 * 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000
        };

        return intervalMap[interval] || (60 * 60 * 1000); // Default 1 hour
    }

    /**
     * Build OHLCV candles from trade data
     * Aggregates trades into time-based candles
     * @private
     */
    _buildCandlesFromTrades(trades, intervalMs, limit) {
        if (!Array.isArray(trades) || trades.length === 0) {
            return [];
        }

        // Sort trades by timestamp (oldest first)
        const sortedTrades = [...trades].sort((a, b) => {
            return new Date(a.tradedAt).getTime() - new Date(b.tradedAt).getTime();
        });

        // Get time range
        const firstTradeTime = new Date(sortedTrades[0].tradedAt).getTime();
        const lastTradeTime = new Date(sortedTrades[sortedTrades.length - 1].tradedAt).getTime();

        // Calculate candle boundaries
        const firstCandleStart = Math.floor(firstTradeTime / intervalMs) * intervalMs;
        const lastCandleStart = Math.floor(lastTradeTime / intervalMs) * intervalMs;

        // Build candles map
        const candlesMap = {};

        for (const trade of sortedTrades) {
            const tradeTime = new Date(trade.tradedAt).getTime();
            const candleStart = Math.floor(tradeTime / intervalMs) * intervalMs;

            if (!candlesMap[candleStart]) {
                candlesMap[candleStart] = {
                    timestamp: candleStart,
                    open: parseFloat(trade.price),
                    high: parseFloat(trade.price),
                    low: parseFloat(trade.price),
                    close: parseFloat(trade.price),
                    volume: 0,
                    trades: []
                };
            }

            const candle = candlesMap[candleStart];
            const price = parseFloat(trade.price);
            const volume = parseFloat(trade.quantity);

            // Update OHLC
            candle.high = Math.max(candle.high, price);
            candle.low = Math.min(candle.low, price);
            candle.close = price; // Last price in the candle
            candle.volume += volume;
            candle.trades.push(trade);
        }

        // Convert map to array and sort by timestamp (oldest first)
        let candles = Object.values(candlesMap)
            .sort((a, b) => a.timestamp - b.timestamp)
            .map(candle => ({
                timestamp: candle.timestamp,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume
            }));

        // Limit to requested number of candles (most recent)
        if (candles.length > limit) {
            candles = candles.slice(-limit);
        }

        return candles;
    }

    /**
     * Transform VALR candle response to standard format
     * @private
     */
    _transformCandles(valrCandles) {
        if (!Array.isArray(valrCandles)) {
            return [];
        }

        return valrCandles.map(candle => ({
            timestamp: candle.startTime || candle.timestamp,
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close),
            volume: parseFloat(candle.volume || candle.baseVolume || 0)
        }));
    }

    /**
     * Get available trading pairs on VALR
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of trading pairs
     */
    async getAvailablePairs(credentials) {
        try {
            const path = '/v1/public/pairs';
            const url = `${this.baseUrl}${path}`;

            // Public endpoint, but include auth for consistency
            const headers = {
                'Content-Type': 'application/json'
            };

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Return array of pair symbols
            return data.map(pair => pair.symbol);

        } catch (error) {
            logger.error('Failed to fetch VALR trading pairs', {
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = VALRMarketDataService;
