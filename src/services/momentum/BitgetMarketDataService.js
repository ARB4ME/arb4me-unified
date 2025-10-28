// Bitget Market Data Service
// Fetches candle data and current prices from Bitget API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class BitgetMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.bitget.com';

        // Rate limiting: Bitget has standard rate limits
        // Public: 20 requests per second
        // Private: 10 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // Bitget-specific: Top 50 major USDT pairs by market cap and trading volume
        // Stored in standard format (BTCUSDT), converted to _SPBL format for API calls
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
            'BGBUSDT' // Bitget native token with reduced fees
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
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
            const bitgetPair = this._convertPairToBitget(pair);

            // Convert interval to Bitget format
            const bitgetInterval = this._convertIntervalToBitget(interval);

            // Bitget endpoint: GET /api/spot/v1/market/candles
            // Parameters: symbol, period, limit, startTime (optional), endTime (optional)
            const path = `/api/spot/v1/market/candles?symbol=${bitgetPair}&period=${bitgetInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Bitget candles', { pair: bitgetPair, interval, limit });

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
                throw new Error(`Bitget API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitget API error
            if (result.code !== '00000') {
                throw new Error(`Bitget API error: ${result.code} - ${result.msg}`);
            }

            // Transform Bitget response to standard format
            const candles = this._transformCandles(result.data);

            logger.info('Bitget candles fetched successfully', {
                pair: bitgetPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Bitget candles', {
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

            // Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
            const bitgetPair = this._convertPairToBitget(pair);

            // Bitget endpoint: GET /api/spot/v1/market/ticker
            const path = `/api/spot/v1/market/ticker?symbol=${bitgetPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Bitget current price', { pair: bitgetPair });

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
                throw new Error(`Bitget API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitget API error
            if (result.code !== '00000') {
                throw new Error(`Bitget API error: ${result.code} - ${result.msg}`);
            }

            // Bitget ticker format: { code: '00000', data: { close: "96234.50" } }
            const currentPrice = parseFloat(result.data?.close || 0);

            logger.debug('Bitget current price fetched', { pair: bitgetPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Bitget current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Bitget
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
            const signature = this._createBitgetSignature(timestamp, method, requestPath, '', credentials.apiSecret);

            const url = `${this.baseUrl}${requestPath}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'ACCESS-KEY': credentials.apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': credentials.passphrase
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitget connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitget API error
            if (result.code !== '00000') {
                throw new Error(`Bitget connection test failed: ${result.code} - ${result.msg}`);
            }

            logger.info('Bitget connection test successful', {
                assetsCount: result.data?.length
            });

            return true;

        } catch (error) {
            logger.error('Bitget connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Bitget signature for authentication
     * Format: timestamp + method + requestPath + body
     * Uses HMAC-SHA256 signature (base64)
     * @private
     */
    _createBitgetSignature(timestamp, method, requestPath, body, apiSecret) {
        // Bitget signature: base64(HMAC-SHA256(timestamp + method + requestPath + body, apiSecret))
        const message = timestamp + method.toUpperCase() + requestPath + (body || '');
        return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
    }

    /**
     * Convert standard interval format to Bitget interval
     * @private
     */
    _convertIntervalToBitget(interval) {
        // Bitget uses: 1min, 5min, 15min, 30min, 1h, 4h, 12h, 1day, 1week
        const intervalMap = {
            '1m': '1min',
            '5m': '5min',
            '15m': '15min',
            '30m': '30min',
            '1h': '1h',
            '4h': '4h',
            '12h': '12h',
            '1d': '1day',
            '1w': '1week'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
     * Bitget uses _SPBL suffix for spot balance pairs
     * @private
     */
    _convertPairToBitget(pair) {
        // Add _SPBL suffix for Bitget spot trading
        return `${pair}_SPBL`;
    }

    /**
     * Transform Bitget candle response to standard format
     * @private
     */
    _transformCandles(bitgetCandles) {
        if (!Array.isArray(bitgetCandles)) {
            return [];
        }

        // Bitget candlestick format: [
        //   [
        //     "1597026383085",  // Timestamp in milliseconds (string)
        //     "3.721",          // Open price
        //     "3.743",          // High price
        //     "3.677",          // Low price
        //     "3.708",          // Close price
        //     "8422410",        // Volume (base currency)
        //     "31234567"        // Volume (quote currency)
        //   ]
        // ]

        return bitgetCandles.map(candle => ({
            timestamp: parseInt(candle[0]), // Timestamp in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
    }

    /**
     * Get available USDT trading pairs on Bitget
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = BitgetMarketDataService;
