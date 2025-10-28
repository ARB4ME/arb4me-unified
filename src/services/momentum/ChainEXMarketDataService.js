// ChainEX Market Data Service
// Fetches candle data and current prices from ChainEX API for momentum trading

const { logger } = require('../../utils/logger');

class ChainEXMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.chainex.io';

        // Rate limiting: Conservative approach (adjust based on ChainEX limits)
        this.minRequestInterval = 200; // milliseconds
        this.lastRequestTime = 0;

        // ChainEX-specific: Supported USDT pairs
        this.supportedPairs = [
            '1INCHUSDT',
            'BTCUSDT',
            'CVCUSDT',
            'EOSUSDT',
            'ETHUSDT',
            'LTCUSDT',
            'PARTUSDT',
            'STMXUSDT',
            'SUSHIUSDT',
            'TITANXUSDT',
            'XRPUSDT'
        ];
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
     * Prevents hitting ChainEX's rate limits
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

            // Convert pair format for ChainEX (e.g., BTCUSDT → BTC_USDT)
            const chainexPair = this._convertPairToChainEX(pair);

            // Convert interval to ChainEX format
            const chainexInterval = this._convertIntervalToChainEX(interval);

            // ChainEX endpoint: GET /v1/candles (assumed based on /v1/ticker pattern)
            // Adjust endpoint if different based on actual API docs
            const path = `/v1/candles?pair=${chainexPair}&interval=${chainexInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching ChainEX candles', { pair: chainexPair, interval, limit });

            const response = await fetch(url, {
                method: 'GET',
                headers: this._createChainEXAuth(credentials.apiKey)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform ChainEX response to standard format
            const candles = this._transformCandles(data);

            logger.info('ChainEX candles fetched successfully', {
                pair: chainexPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch ChainEX candles', {
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

            // Convert pair format for ChainEX (e.g., BTCUSDT → BTC_USDT)
            const chainexPair = this._convertPairToChainEX(pair);

            // ChainEX endpoint: GET /v1/ticker/{pair}
            const path = `/v1/ticker/${chainexPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching ChainEX current price', { pair: chainexPair });

            // Ticker endpoint may not require authentication - try without first
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // ChainEX returns 'last' field for last trade price
            const currentPrice = parseFloat(data.last || data.price);

            logger.debug('ChainEX current price fetched', { pair: chainexPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch ChainEX current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to ChainEX
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test connection by fetching a known ticker (BTC_USDT)
            const path = '/v1/ticker/BTC_USDT';
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: this._createChainEXAuth(credentials.apiKey)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            logger.info('ChainEX connection test successful', {
                testPair: 'BTC_USDT',
                price: data.last
            });

            return true;

        } catch (error) {
            logger.error('ChainEX connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create ChainEX authentication headers (Simple API Key)
     * @private
     */
    _createChainEXAuth(apiKey) {
        // ChainEX uses simple X-API-KEY header authentication
        return {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Convert standard interval format to ChainEX format
     * @private
     */
    _convertIntervalToChainEX(interval) {
        // ChainEX likely uses standard interval format
        // Adjust if different based on actual API documentation
        const intervalMap = {
            '1m': '1m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1h',
            '4h': '4h',
            '1d': '1d'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Convert pair to ChainEX format (BTCUSDT → BTC_USDT)
     * ChainEX uses underscore separator for pair names
     * @private
     */
    _convertPairToChainEX(pair) {
        // Convert BTCUSDT to BTC_USDT format
        // Extract base and quote currencies
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform ChainEX candle response to standard format
     * @private
     */
    _transformCandles(chainexData) {
        // ChainEX response format may vary - adjust based on actual API response
        // Assuming format similar to: [{time, open, high, low, close, volume}, ...]
        if (!Array.isArray(chainexData)) {
            // If wrapped in object, extract array
            if (chainexData.candles && Array.isArray(chainexData.candles)) {
                chainexData = chainexData.candles;
            } else if (chainexData.data && Array.isArray(chainexData.data)) {
                chainexData = chainexData.data;
            } else {
                return [];
            }
        }

        return chainexData.map(candle => ({
            timestamp: candle.timestamp || candle.time || candle.t,
            open: parseFloat(candle.open || candle.o),
            high: parseFloat(candle.high || candle.h),
            low: parseFloat(candle.low || candle.l),
            close: parseFloat(candle.close || candle.c),
            volume: parseFloat(candle.volume || candle.v || 0)
        }));
    }

    /**
     * Get available USDT trading pairs on ChainEX
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = ChainEXMarketDataService;
