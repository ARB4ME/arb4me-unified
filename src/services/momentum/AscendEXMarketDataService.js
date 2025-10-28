// AscendEX Market Data Service
// Fetches candle data and current prices from AscendEX API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class AscendEXMarketDataService {
    constructor() {
        this.baseUrl = 'https://ascendex.com';

        // Rate limiting: AscendEX has standard rate limits
        // Public: 100 requests per minute
        // Private: 50 requests per minute
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // AscendEX-specific: Top 50 major USDT pairs by market cap and trading volume
        // Curated selection from AscendEX's pair list
        this.supportedPairs = [
            // Top Layer 1 blockchains (by market cap)
            'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT',
            'AVAX/USDT', 'DOT/USDT', 'MATIC/USDT', 'ATOM/USDT', 'NEAR/USDT', 'APT/USDT',
            'SUI/USDT', 'SEI/USDT', 'TON/USDT', 'TRX/USDT',

            // Layer 2 solutions
            'ARB/USDT', 'OP/USDT', 'IMX/USDT', 'LRC/USDT',

            // Major DeFi tokens
            'AAVE/USDT', 'UNI/USDT', 'LINK/USDT', 'MKR/USDT', 'SNX/USDT', 'CRV/USDT',
            'COMP/USDT', 'SUSHI/USDT', '1INCH/USDT', 'LDO/USDT', 'PENDLE/USDT',

            // Stablecoins
            'USDC/USDT', 'DAI/USDT', 'TUSD/USDT',

            // Popular altcoins
            'LTC/USDT', 'BCH/USDT', 'ETC/USDT', 'XLM/USDT', 'ALGO/USDT', 'VET/USDT',
            'FIL/USDT', 'THETA/USDT', 'XTZ/USDT', 'EOS/USDT',

            // Meme coins
            'DOGE/USDT', 'SHIB/USDT', 'PEPE/USDT', 'FLOKI/USDT', 'BONK/USDT'
        ];
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
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

            // Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
            const ascendexPair = this._convertPairToAscendEX(pair);

            // Convert interval to AscendEX format
            const ascendexInterval = this._convertIntervalToAscendEX(interval);

            // AscendEX endpoint: GET /api/pro/v1/barhist
            const path = `/api/pro/v1/barhist?symbol=${ascendexPair}&interval=${ascendexInterval}&n=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching AscendEX candles', { pair: ascendexPair, interval, limit });

            // Barhist endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AscendEX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for AscendEX API error
            if (result.code !== 0) {
                throw new Error(`AscendEX API error: ${result.code} - ${result.message}`);
            }

            // Transform AscendEX response to standard format
            const candles = this._transformCandles(result.data);

            logger.info('AscendEX candles fetched successfully', {
                pair: ascendexPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch AscendEX candles', {
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

            // Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
            const ascendexPair = this._convertPairToAscendEX(pair);

            // AscendEX endpoint: GET /api/pro/v1/ticker
            const path = `/api/pro/v1/ticker?symbol=${ascendexPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching AscendEX current price', { pair: ascendexPair });

            // Ticker endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AscendEX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for AscendEX API error
            if (result.code !== 0) {
                throw new Error(`AscendEX API error: ${result.code} - ${result.message}`);
            }

            // AscendEX ticker format: { code: 0, data: { close: "96234.50" } }
            const currentPrice = parseFloat(result.data?.close || 0);

            logger.debug('AscendEX current price fetched', { pair: ascendexPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch AscendEX current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to AscendEX
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test info endpoint (public)
            const path = '/api/pro/v1/info';
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AscendEX connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for AscendEX API error
            if (result.code !== 0) {
                throw new Error(`AscendEX connection test failed: ${result.code} - ${result.message}`);
            }

            logger.info('AscendEX connection test successful', {
                accountGroup: result.data?.accountGroup
            });

            return true;

        } catch (error) {
            logger.error('AscendEX connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create AscendEX signature for authentication
     * Format: timestamp + "+" + api_path
     * @private
     */
    _createAscendEXSignature(timestamp, path, apiSecret) {
        // AscendEX signature: base64(HMAC-SHA256(timestamp + "+" + path, apiSecret))
        const prehashString = timestamp + '+' + path;
        return crypto.createHmac('sha256', apiSecret).update(prehashString).digest('base64');
    }

    /**
     * Convert standard interval format to AscendEX interval
     * @private
     */
    _convertIntervalToAscendEX(interval) {
        // AscendEX uses: 1, 5, 15, 30, 60, 240, 360, 720, 1d, 1w, 1m (minutes or d/w/m)
        const intervalMap = {
            '1m': '1',
            '5m': '5',
            '15m': '15',
            '30m': '30',
            '1h': '60',
            '4h': '240',
            '6h': '360',
            '12h': '720',
            '1d': '1d',
            '1w': '1w'
        };

        return intervalMap[interval] || '60'; // Default to 1 hour (60 minutes)
    }

    /**
     * Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
     * AscendEX uses slash separator
     * @private
     */
    _convertPairToAscendEX(pair) {
        // Convert BTCUSDT to BTC/USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}/${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform AscendEX candle response to standard format
     * @private
     */
    _transformCandles(ascendexCandles) {
        if (!Array.isArray(ascendexCandles)) {
            return [];
        }

        // AscendEX candlestick format: {
        //   data: [
        //     {
        //       "ts": 1597026383085,  // Timestamp in milliseconds
        //       "o": "3.721",          // Open price
        //       "h": "3.743",          // High price
        //       "l": "3.677",          // Low price
        //       "c": "3.708",          // Close price
        //       "v": "8422410"         // Volume (base currency)
        //     }
        //   ]
        // }

        return ascendexCandles.map(candle => ({
            timestamp: candle.ts, // Timestamp in milliseconds
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
            volume: parseFloat(candle.v)
        }));
    }

    /**
     * Get available USDT trading pairs on AscendEX
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = AscendEXMarketDataService;
