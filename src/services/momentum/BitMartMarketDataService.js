// BitMart Market Data Service
// Fetches candle data and current prices from BitMart API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class BitMartMarketDataService {
    constructor() {
        this.baseUrl = 'https://api-cloud.bitmart.com';

        // Rate limiting: BitMart has standard rate limits
        // Public: 10 requests per second
        // Private: 5 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // BitMart-specific: Top 50 major USDT pairs by market cap and trading volume
        // Stored in standard format (BTCUSDT), converted to underscore format for API calls
        this.supportedPairs = [
            // Top Layer 1 blockchains (by market cap)
            'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
            'AVAXUSDT', 'DOTUSDT', 'MATICUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT',
            'SUIUSDT', 'SEIUSDT', 'TONUSDT', 'TRXUSDT',

            // Layer 2 solutions
            'ARBUSDT', 'OPUSDT', 'IMXUSDT', 'LRCUSDT',

            // Major DeFi tokens
            'AAVEUSDT', 'UNIUSDT', 'LINKUSDT', 'MKRUSDT', 'SNXUSDT', 'CRVUSDT',
            'COMPUSDT', 'SUSHIUSDT', '1INCHUSDT', 'LDOUSDT', 'PENDLEUSDT',

            // Stablecoins
            'USDCUSDT', 'DAIUSDT', 'TUSDUSDT',

            // Popular altcoins
            'LTCUSDT', 'BCHUSDT', 'ETCUSDT', 'XLMUSDT', 'ALGOUSDT', 'VETUSDT',
            'FILUSDT', 'THETAUSDT', 'XTZUSDT', 'EOSUSDT',

            // Meme coins
            'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'FLOKIUSDT', 'BONKUSDT',

            // Native exchange token
            'BMXUSDT' // BitMart native token with reduced fees
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
     * @param {object} credentials - { apiKey, apiSecret, memo }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to BitMart format (BTCUSDT → BTC_USDT)
            const bitmartPair = this._convertPairToBitMart(pair);

            // Convert interval to BitMart format
            const bitmartInterval = this._convertIntervalToBitMart(interval);

            // BitMart endpoint: GET /spot/v1/symbols/kline
            // Parameters: symbol, from (start time), to (end time), step (interval)
            const toTime = Date.now();
            const fromTime = toTime - (limit * this._getIntervalMilliseconds(interval));

            const path = `/spot/v1/symbols/kline?symbol=${bitmartPair}&from=${fromTime}&to=${toTime}&step=${bitmartInterval}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching BitMart candles', { pair: bitmartPair, interval, limit });

            // Kline endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BitMart API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BitMart API error
            if (result.code !== 1000) {
                throw new Error(`BitMart API error: ${result.code} - ${result.message}`);
            }

            // Transform BitMart response to standard format
            const candles = this._transformCandles(result.data?.klines || []);

            logger.info('BitMart candles fetched successfully', {
                pair: bitmartPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch BitMart candles', {
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
     * @param {object} credentials - { apiKey, apiSecret, memo }
     * @returns {Promise<number>} Current market price
     */
    async fetchCurrentPrice(pair, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to BitMart format (BTCUSDT → BTC_USDT)
            const bitmartPair = this._convertPairToBitMart(pair);

            // BitMart endpoint: GET /spot/v1/ticker
            const path = `/spot/v1/ticker?symbol=${bitmartPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching BitMart current price', { pair: bitmartPair });

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
                throw new Error(`BitMart API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BitMart API error
            if (result.code !== 1000) {
                throw new Error(`BitMart API error: ${result.code} - ${result.message}`);
            }

            // BitMart ticker format: { code: 1000, data: { last_price: "96234.50" } }
            const currentPrice = parseFloat(result.data?.last_price || 0);

            logger.debug('BitMart current price fetched', { pair: bitmartPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch BitMart current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to BitMart
     * @param {object} credentials - { apiKey, apiSecret, memo }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test balance endpoint (requires authentication)
            const timestamp = Date.now().toString();
            const requestPath = '/spot/v1/wallet';
            // For GET requests, queryString is empty
            const signature = this._createBitMartSignature(timestamp, credentials.memo || '', '', credentials.apiSecret);

            const url = `${this.baseUrl}${requestPath}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-BM-KEY': credentials.apiKey,
                    'X-BM-SIGN': signature,
                    'X-BM-TIMESTAMP': timestamp
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BitMart connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BitMart API error
            if (result.code !== 1000) {
                throw new Error(`BitMart connection test failed: ${result.code} - ${result.message}`);
            }

            logger.info('BitMart connection test successful', {
                walletsCount: result.data?.wallet?.length
            });

            return true;

        } catch (error) {
            logger.error('BitMart connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create BitMart signature for authentication
     * Format: timestamp + '#' + memo + '#' + queryString
     * Uses HMAC-SHA256 signature (hex)
     * @private
     */
    _createBitMartSignature(timestamp, memo, queryString, apiSecret) {
        // BitMart signature: hex(HMAC-SHA256(timestamp + '#' + memo + '#' + queryString, apiSecret))
        const message = timestamp + '#' + (memo || '') + '#' + (queryString || '');
        return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
    }

    /**
     * Convert standard interval format to BitMart interval (in minutes)
     * @private
     */
    _convertIntervalToBitMart(interval) {
        // BitMart uses minutes: 1, 3, 5, 15, 30, 45, 60, 120, 180, 240, 1440, 10080, 43200
        const intervalMap = {
            '1m': 1,
            '3m': 3,
            '5m': 5,
            '15m': 15,
            '30m': 30,
            '45m': 45,
            '1h': 60,
            '2h': 120,
            '3h': 180,
            '4h': 240,
            '1d': 1440,
            '1w': 10080,
            '1M': 43200
        };

        return intervalMap[interval] || 60; // Default to 1 hour (60 minutes)
    }

    /**
     * Get interval duration in milliseconds
     * @private
     */
    _getIntervalMilliseconds(interval) {
        const intervalMap = {
            '1m': 60 * 1000,
            '3m': 3 * 60 * 1000,
            '5m': 5 * 60 * 1000,
            '15m': 15 * 60 * 1000,
            '30m': 30 * 60 * 1000,
            '45m': 45 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '2h': 2 * 60 * 60 * 1000,
            '3h': 3 * 60 * 60 * 1000,
            '4h': 4 * 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000,
            '1w': 7 * 24 * 60 * 60 * 1000,
            '1M': 30 * 24 * 60 * 60 * 1000
        };

        return intervalMap[interval] || 60 * 60 * 1000; // Default to 1 hour
    }

    /**
     * Convert pair to BitMart format (BTCUSDT → BTC_USDT)
     * BitMart uses underscore separator
     * @private
     */
    _convertPairToBitMart(pair) {
        // Convert BTCUSDT to BTC_USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform BitMart candle response to standard format
     * @private
     */
    _transformCandles(bitmartCandles) {
        if (!Array.isArray(bitmartCandles)) {
            return [];
        }

        // BitMart candlestick format: [
        //   {
        //     "timestamp": 1597026383,     // Unix timestamp in seconds
        //     "open_price": "3.721",       // Open price
        //     "high_price": "3.743",       // High price
        //     "low_price": "3.677",        // Low price
        //     "close_price": "3.708",      // Close price
        //     "volume": "8422410"          // Volume (base currency)
        //   }
        // ]

        return bitmartCandles.map(candle => ({
            timestamp: candle.timestamp * 1000, // Convert seconds to milliseconds
            open: parseFloat(candle.open_price || candle.open),
            high: parseFloat(candle.high_price || candle.high),
            low: parseFloat(candle.low_price || candle.low),
            close: parseFloat(candle.close_price || candle.close),
            volume: parseFloat(candle.volume)
        }));
    }

    /**
     * Get available USDT trading pairs on BitMart
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = BitMartMarketDataService;
