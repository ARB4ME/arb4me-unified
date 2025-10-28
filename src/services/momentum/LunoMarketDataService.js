// Luno Market Data Service
// Fetches candle data and current prices from Luno API for momentum trading

const { logger } = require('../../utils/logger');

class LunoMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.luno.com';

        // Rate limiting: Max 5 requests per second (300/min)
        this.minRequestInterval = 200; // milliseconds
        this.lastRequestTime = 0;

        // Luno-specific: Supported USDT pairs
        this.supportedPairs = [
            'ETHUSDT',
            'PAXUSDT',
            'SOLUSDT',
            'USDCUSDT',
            'XBTUSDT', // Bitcoin - Luno uses XBT not BTC
            'XRPUSDT'
        ];
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
     * Prevents hitting Luno's rate limits (300 requests/min)
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
     * @param {string} pair - Trading pair (e.g., 'XBTUSDT', 'ETHUSDT')
     * @param {string} interval - Candle interval ('1m', '5m', '15m', '30m', '1h', '4h', '1d')
     * @param {number} limit - Number of candles to fetch (default 100, max 500)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert asset to Luno format (BTC → XBT)
            const lunoPair = this._convertPairToLuno(pair);

            // Convert interval to duration in seconds
            const duration = this._convertIntervalToDuration(interval);

            // Calculate 'since' timestamp (limit candles back from now)
            const since = Date.now() - (limit * duration * 1000);

            // Luno endpoint: GET /api/exchange/1/candles
            const path = `/api/exchange/1/candles?pair=${lunoPair}&duration=${duration}&since=${since}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Luno candles', { pair: lunoPair, interval, limit, duration });

            const response = await fetch(url, {
                method: 'GET',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Luno response to standard format
            const candles = this._transformCandles(data.candles);

            logger.info('Luno candles fetched successfully', {
                pair: lunoPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Luno candles', {
                pair,
                interval,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current market price for a pair
     * @param {string} pair - Trading pair (e.g., 'XBTUSDT')
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<number>} Current market price
     */
    async fetchCurrentPrice(pair, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert asset to Luno format (BTC → XBT)
            const lunoPair = this._convertPairToLuno(pair);

            // Luno endpoint: GET /api/1/ticker
            const path = `/api/1/ticker?pair=${lunoPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Luno current price', { pair: lunoPair });

            // Ticker endpoint doesn't require authentication
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Luno returns last_trade, bid, ask
            const currentPrice = parseFloat(data.last_trade || data.bid);

            logger.debug('Luno current price fetched', { pair: lunoPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Luno current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Luno
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Luno endpoint: GET /api/1/balance (requires authentication)
            const path = '/api/1/balance';
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            logger.info('Luno connection test successful', {
                balancesCount: data.balance?.length || 0
            });

            return true;

        } catch (error) {
            logger.error('Luno connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Luno authentication headers (HTTP Basic Auth)
     * @private
     */
    _createLunoAuth(apiKey, apiSecret) {
        // Luno uses HTTP Basic Authentication
        // Username: API Key ID
        // Password: API Secret
        const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

        return {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Convert standard interval format to Luno duration (seconds)
     * @private
     */
    _convertIntervalToDuration(interval) {
        const durationMap = {
            '1m': 60,
            '5m': 300,
            '15m': 900,
            '30m': 1800,
            '1h': 3600,
            '4h': 14400,
            '1d': 86400
        };

        return durationMap[interval] || 3600; // Default to 1 hour
    }

    /**
     * Convert pair to Luno format (BTC → XBT)
     * Luno uses XBT for Bitcoin instead of BTC
     * @private
     */
    _convertPairToLuno(pair) {
        // Replace BTC with XBT for Luno
        if (pair.startsWith('BTC')) {
            return pair.replace('BTC', 'XBT');
        }
        return pair;
    }

    /**
     * Transform Luno candle response to standard format
     * @private
     */
    _transformCandles(lunoCandles) {
        if (!Array.isArray(lunoCandles)) {
            return [];
        }

        return lunoCandles.map(candle => ({
            timestamp: candle.timestamp, // Unix milliseconds
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close),
            volume: parseFloat(candle.volume || 0)
        }));
    }

    /**
     * Get available USDT trading pairs on Luno
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = LunoMarketDataService;
