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
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT', 'ETHUSDT')
     * @param {string} interval - Candle interval ('1m', '5m', '15m', '30m', '1h', '4h', '1d')
     * @param {number} limit - Number of candles to fetch (default 100, max 500)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // VALR uses specific interval format
            const valrInterval = this._convertInterval(interval);

            // VALR endpoint: GET /v1/marketdata/:currencyPair/tradehistory
            // For candles, we use aggregated trades endpoint
            const path = `/v1/marketdata/${pair}/candles`;
            const url = `${this.baseUrl}${path}?period=${valrInterval}&limit=${limit}`;

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'GET',
                path,
                null
            );

            logger.info('Fetching VALR candles', { pair, interval: valrInterval, limit });

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform VALR response to standard format
            const candles = this._transformCandles(data);

            logger.info('VALR candles fetched successfully', {
                pair,
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
