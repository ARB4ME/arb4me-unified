// Coincatch Market Data Service
// Fetches candle data and current prices from Coincatch API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class CoincatchMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.coincatch.com';

        // Rate limiting: Coincatch has standard rate limits
        // Public: 20 requests per 2 seconds
        // Private: 20 requests per 2 seconds
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // Coincatch-specific: Top 50 major USDT pairs by market cap and trading volume
        // Uses standard format (BTCUSDT) like Binance/OKX
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

            // Exchange tokens
            'OKBUSDT' // OKB token (Coincatch is OKX-compatible)
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
     * @param {number} limit - Number of candles to fetch (default 100, max 300)
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert interval to Coincatch format
            const coincatchInterval = this._convertIntervalToCoincatch(interval);

            // Coincatch endpoint: GET /api/v1/market/candles (OKX-compatible)
            const path = `/api/v1/market/candles`;
            const params = new URLSearchParams({
                instId: pair,
                bar: coincatchInterval,
                limit: limit.toString()
            });
            const url = `${this.baseUrl}${path}?${params}`;

            logger.info('Fetching Coincatch candles', { pair, interval, limit });

            // Candles endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Coincatch API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Coincatch API error (code !== '0' means error)
            if (result.code && result.code !== '0') {
                throw new Error(`Coincatch API error: ${result.code} - ${result.msg}`);
            }

            // Transform Coincatch response to standard format
            const candles = this._transformCandles(result.data || []);

            logger.info('Coincatch candles fetched successfully', {
                pair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Coincatch candles', {
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
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<number>} Current market price
     */
    async fetchCurrentPrice(pair, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Coincatch endpoint: GET /api/v1/market/ticker
            const path = `/api/v1/market/ticker`;
            const params = new URLSearchParams({
                symbol: pair
            });
            const url = `${this.baseUrl}${path}?${params}`;

            logger.debug('Fetching Coincatch current price', { pair });

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
                throw new Error(`Coincatch API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Coincatch ticker format: { data: { close: "96234.50" } }
            const currentPrice = parseFloat(result.data?.close || 0);

            logger.debug('Coincatch current price fetched', { pair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Coincatch current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Coincatch
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test balance endpoint (requires authentication)
            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = '/api/spot/v1/account/assets';
            const signature = this._createCoincatchSignature(timestamp, method, requestPath, '', '', credentials.apiSecret);

            const url = `${this.baseUrl}${requestPath}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'ACCESS-KEY': credentials.apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': credentials.passphrase,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Coincatch connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Coincatch API error
            if (result.code && result.code !== '0') {
                throw new Error(`Coincatch connection test failed: ${result.code} - ${result.message}`);
            }

            logger.info('Coincatch connection test successful', {
                assetsCount: result.data?.length
            });

            return true;

        } catch (error) {
            logger.error('Coincatch connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Coincatch signature for authentication
     * Format: timestamp + method + requestPath + "?" + queryString + body
     * Only include "?" + queryString if queryString exists
     * Uses HMAC-SHA256 signature (base64)
     * @private
     */
    _createCoincatchSignature(timestamp, method, requestPath, queryString, body, apiSecret) {
        // Coincatch signature: HMAC-SHA256(timestamp + method + requestPath + queryString + body, apiSecret)
        let message = timestamp + method + requestPath;
        if (queryString) {
            message += '?' + queryString;
        }
        message += (body || '');
        return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
    }

    /**
     * Convert standard interval format to Coincatch interval (OKX-compatible)
     * @private
     */
    _convertIntervalToCoincatch(interval) {
        // Coincatch uses OKX format: 1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 6H, 12H, 1D, 1W, 1M
        const intervalMap = {
            '1m': '1m',
            '3m': '3m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1H',
            '2h': '2H',
            '4h': '4H',
            '6h': '6H',
            '12h': '12H',
            '1d': '1D',
            '1w': '1W',
            '1M': '1M'
        };

        return intervalMap[interval] || '1H'; // Default to 1 hour
    }

    /**
     * Transform Coincatch candle response to standard format
     * @private
     */
    _transformCandles(coincatchCandles) {
        if (!Array.isArray(coincatchCandles)) {
            return [];
        }

        // Coincatch candlestick format (OKX-compatible): [
        //   [
        //     "1597026383000",  // Timestamp in milliseconds (string)
        //     "3.721",          // Open price
        //     "3.743",          // High price
        //     "3.677",          // Low price
        //     "3.708",          // Close price
        //     "8422410",        // Volume (base currency)
        //     "31234567"        // Volume (quote currency)
        //   ]
        // ]

        return coincatchCandles.map(candle => ({
            timestamp: parseInt(candle[0]), // Timestamp in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
    }

    /**
     * Get available USDT trading pairs on Coincatch
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = CoincatchMarketDataService;
