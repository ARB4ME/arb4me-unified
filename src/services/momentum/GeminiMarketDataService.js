// Gemini Market Data Service
// Fetches candle data and current prices from Gemini API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class GeminiMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.gemini.com';

        // Rate limiting: Gemini has standard rate limits
        // Public: 120 requests per minute
        // Private: 600 requests per minute
        this.minRequestInterval = 500; // milliseconds (conservative)
        this.lastRequestTime = 0;

        // Gemini-specific: Major USD pairs (Gemini primarily uses USD, not USDT)
        // Stored in standard format (BTCUSDT), converted to Gemini format (btcusd) for API calls
        // Note: Gemini has limited USDT pairs, mostly uses USD
        this.supportedPairs = [
            // Top crypto pairs (USD-based, Gemini's primary quote currency)
            'BTCUSD', 'ETHUSD', 'BCHUSD', 'LTCUSD', 'LINKUSD',
            'MATICUSD', 'AVAXUSD', 'DOTUSD', 'UNIUSD', 'AAVEUSD',
            'ATOMUSD', 'FILUSD', 'SOLUSD', 'DOGEUSD', 'SHIBUSD',

            // Limited USDT pairs (Gemini has very few USDT pairs)
            'BTCUSDT', 'ETHUSDT',

            // Additional USD pairs
            'XRPUSD', 'ADAUSD', 'TRXUSD', 'EOSUSD', 'XLMUSD',
            'ALGOUSD', 'MANAUSD', 'SANDUSD', 'GRTUSD', 'MKRUSD',
            'COMPUSD', 'SNXUSD', 'CRVUSD', 'LRCUSD', 'ZECUSD',
            'BATUSD', 'DAIUSD', 'PAXUSD', 'GUSDUSD' // GUSD is Gemini's stablecoin
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
     * @param {string} pair - Trading pair (e.g., 'BTCUSD', 'ETHUSD', 'BTCUSDT')
     * @param {string} interval - Candle interval ('1m', '5m', '15m', '30m', '1h', '4h', '1d')
     * @param {number} limit - Number of candles to fetch (default 100)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to Gemini format (BTCUSD → btcusd, BTCUSDT → btcusdt)
            const geminiPair = this._convertPairToGemini(pair);

            // Convert interval to Gemini format
            const geminiInterval = this._convertIntervalToGemini(interval);

            // Gemini endpoint: GET /v2/candles/:symbol/:time_frame
            const path = `/v2/candles/${geminiPair}/${geminiInterval}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Gemini candles', { pair: geminiPair, interval, limit });

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
                throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Transform Gemini response to standard format
            const candles = this._transformCandles(result).slice(0, limit);

            logger.info('Gemini candles fetched successfully', {
                pair: geminiPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Gemini candles', {
                pair,
                interval,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current market price for a pair
     * @param {string} pair - Trading pair (e.g., 'BTCUSD', 'BTCUSDT')
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<number>} Current market price
     */
    async fetchCurrentPrice(pair, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to Gemini format (BTCUSD → btcusd)
            const geminiPair = this._convertPairToGemini(pair);

            // Gemini endpoint: GET /v1/pubticker/:symbol
            const path = `/v1/pubticker/${geminiPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Gemini current price', { pair: geminiPair });

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
                throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Gemini ticker format: { last: "96234.50" }
            const currentPrice = parseFloat(result.last || 0);

            logger.debug('Gemini current price fetched', { pair: geminiPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Gemini current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Gemini
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test heartbeat endpoint (requires authentication)
            const nonce = Date.now();
            const payload = {
                request: '/v1/heartbeat',
                nonce: nonce
            };

            const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = this._createGeminiSignature(payloadBase64, credentials.apiSecret);

            const url = `${this.baseUrl}/v1/heartbeat`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'text/plain',
                    'X-GEMINI-APIKEY': credentials.apiKey,
                    'X-GEMINI-PAYLOAD': payloadBase64,
                    'X-GEMINI-SIGNATURE': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gemini connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for error response
            if (result.result === 'error') {
                throw new Error(`Gemini connection test failed: ${result.reason} - ${result.message}`);
            }

            logger.info('Gemini connection test successful', {
                result: result.result
            });

            return true;

        } catch (error) {
            logger.error('Gemini connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Gemini signature for authentication
     * Uses HMAC-SHA384 signature (hex) - unique to Gemini
     * @private
     */
    _createGeminiSignature(payload, apiSecret) {
        // Gemini signature: HMAC-SHA384 of base64 payload, lowercase hex
        return crypto.createHmac('sha384', apiSecret).update(payload).digest('hex');
    }

    /**
     * Convert standard interval format to Gemini interval
     * @private
     */
    _convertIntervalToGemini(interval) {
        // Gemini uses: 1m, 5m, 15m, 30m, 1hr, 6hr, 1day
        const intervalMap = {
            '1m': '1m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1hr',
            '6h': '6hr',
            '1d': '1day'
        };

        return intervalMap[interval] || '1hr'; // Default to 1 hour
    }

    /**
     * Convert pair to Gemini format
     * BTCUSD → btcusd, BTCUSDT → btcusdt
     * Gemini uses lowercase without separator
     * @private
     */
    _convertPairToGemini(pair) {
        // Convert to lowercase
        return pair.toLowerCase();
    }

    /**
     * Transform Gemini candle response to standard format
     * @private
     */
    _transformCandles(geminiCandles) {
        if (!Array.isArray(geminiCandles)) {
            return [];
        }

        // Gemini candlestick format: [
        //   [
        //     1597026383000,  // Timestamp in milliseconds
        //     3721,           // Open price
        //     3743,           // High price
        //     3677,           // Low price
        //     3708,           // Close price
        //     8422410         // Volume
        //   ]
        // ]

        return geminiCandles.map(candle => ({
            timestamp: candle[0], // Timestamp in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
    }

    /**
     * Get available USD/USDT trading pairs on Gemini
     * @returns {Array} Array of supported pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = GeminiMarketDataService;
