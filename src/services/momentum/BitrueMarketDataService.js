// Bitrue Market Data Service
// Fetches candle data and current prices from Bitrue API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class BitrueMarketDataService {
    constructor() {
        this.baseUrl = 'https://openapi.bitrue.com';

        // Rate limiting: Bitrue has standard rate limits (Binance-compatible)
        // Public: 1200 requests per minute
        // Private: 1200 requests per minute
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // Bitrue-specific: Top 50 major USDT pairs by market cap and trading volume
        // Uses standard format (BTCUSDT) like Binance
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
            'BTRUSDT' // Bitrue native token with reduced fees
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
     * @param {number} limit - Number of candles to fetch (default 100, max 1000)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Bitrue uses same format as Binance
            const bitrueInterval = this._convertIntervalToBitrue(interval);

            // Bitrue endpoint: GET /api/v1/klines (Binance-compatible)
            const path = `/api/v1/klines?symbol=${pair}&interval=${bitrueInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Bitrue candles', { pair, interval, limit });

            // Klines endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitrue API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Transform Bitrue response to standard format
            const candles = this._transformCandles(result);

            logger.info('Bitrue candles fetched successfully', {
                pair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Bitrue candles', {
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

            // Bitrue endpoint: GET /api/v1/ticker/24hr (Binance-compatible)
            const path = `/api/v1/ticker/24hr?symbol=${pair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Bitrue current price', { pair });

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
                throw new Error(`Bitrue API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Bitrue ticker format (Binance-compatible): { lastPrice: "96234.50" }
            const currentPrice = parseFloat(result.lastPrice || 0);

            logger.debug('Bitrue current price fetched', { pair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Bitrue current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Bitrue
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test account endpoint (requires authentication)
            const timestamp = Date.now();
            const queryString = `timestamp=${timestamp}`;
            const signature = this._createBitrueSignature(queryString, credentials.apiSecret);

            const url = `${this.baseUrl}/api/v1/account?${queryString}&signature=${signature}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitrue connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for error response
            if (result.code && result.code < 0) {
                throw new Error(`Bitrue connection test failed: ${result.code} - ${result.msg}`);
            }

            logger.info('Bitrue connection test successful', {
                balancesCount: result.balances?.length
            });

            return true;

        } catch (error) {
            logger.error('Bitrue connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Bitrue signature for authentication
     * Uses HMAC-SHA256 signature (hex) - Binance-compatible
     * @private
     */
    _createBitrueSignature(queryString, apiSecret) {
        // Bitrue signature: HMAC-SHA256 of query string, lowercase hex (Binance-compatible)
        return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    }

    /**
     * Convert standard interval format to Bitrue interval (Binance-compatible)
     * @private
     */
    _convertIntervalToBitrue(interval) {
        // Bitrue uses Binance-compatible intervals: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M
        const intervalMap = {
            '1m': '1m',
            '3m': '3m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1h',
            '2h': '2h',
            '4h': '4h',
            '6h': '6h',
            '8h': '8h',
            '12h': '12h',
            '1d': '1d',
            '3d': '3d',
            '1w': '1w',
            '1M': '1M'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Transform Bitrue candle response to standard format
     * @private
     */
    _transformCandles(bitrueCandles) {
        if (!Array.isArray(bitrueCandles)) {
            return [];
        }

        // Bitrue candlestick format (Binance-compatible): [
        //   [
        //     1597026383085,  // Open time (timestamp in milliseconds)
        //     "3.721",        // Open price
        //     "3.743",        // High price
        //     "3.677",        // Low price
        //     "3.708",        // Close price
        //     "8422410",      // Volume (base currency)
        //     1597026443085,  // Close time
        //     "31234567",     // Quote asset volume
        //     1234,           // Number of trades
        //     "4211205",      // Taker buy base asset volume
        //     "15617321",     // Taker buy quote asset volume
        //     "0"             // Ignore
        //   ]
        // ]

        return bitrueCandles.map(candle => ({
            timestamp: candle[0], // Timestamp in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
    }

    /**
     * Get available USDT trading pairs on Bitrue
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = BitrueMarketDataService;
