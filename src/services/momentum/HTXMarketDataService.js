// HTX (Huobi) Market Data Service
// Fetches candle data and current prices from HTX API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class HTXMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.huobi.pro';
        this.host = 'api.huobi.pro';

        // Rate limiting: HTX has standard rate limits
        // Public: 100 requests per 10 seconds
        // Private: 100 requests per 10 seconds
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // HTX-specific: Top 50 major USDT pairs by market cap and trading volume
        // Curated selection from HTX's extensive pair list
        this.supportedPairs = [
            // Top Layer 1 blockchains (by market cap)
            'btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt', 'adausdt',
            'avaxusdt', 'dotusdt', 'maticusdt', 'atomusdt', 'nearusdt', 'aptusdt',
            'suiusdt', 'seiusdt', 'tonusdt', 'trxusdt',

            // Layer 2 solutions
            'arbusdt', 'opusdt', 'imxusdt', 'lrcusdt',

            // Major DeFi tokens
            'aaveusdt', 'uniusdt', 'linkusdt', 'mkrusdt', 'snxusdt', 'crvusdt',
            'compusdt', 'sushiusdt', '1inchusdt', 'ldousdt', 'pendleusdt',

            // Stablecoins
            'usdcusdt', 'daiusdt', 'tusdusdt',

            // Popular altcoins
            'ltcusdt', 'bchusdt', 'etcusdt', 'xlmusdt', 'algousdt', 'vetusdt',
            'filusdt', 'thetausdt', 'xtzusdt', 'eosusdt', 'htusdt',

            // Meme coins
            'dogeusdt', 'shibusdt', 'pepeusdt', 'flokiusdt', 'bonkusdt'
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
     * @param {number} limit - Number of candles to fetch (default 100, max 2000)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to HTX format (BTCUSDT → btcusdt)
            const htxPair = this._convertPairToHTX(pair);

            // Convert interval to HTX format
            const htxInterval = this._convertIntervalToHTX(interval);

            // HTX endpoint: GET /market/history/kline
            const path = `/market/history/kline?symbol=${htxPair}&period=${htxInterval}&size=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching HTX candles', { pair: htxPair, interval, limit });

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
                throw new Error(`HTX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for HTX API error
            if (result.status !== 'ok') {
                throw new Error(`HTX API error: ${result.status} - ${result['err-msg']}`);
            }

            // Transform HTX response to standard format
            const candles = this._transformCandles(result.data);

            logger.info('HTX candles fetched successfully', {
                pair: htxPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch HTX candles', {
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

            // Convert pair to HTX format (BTCUSDT → btcusdt)
            const htxPair = this._convertPairToHTX(pair);

            // HTX endpoint: GET /market/detail/merged
            const path = `/market/detail/merged?symbol=${htxPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching HTX current price', { pair: htxPair });

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
                throw new Error(`HTX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for HTX API error
            if (result.status !== 'ok') {
                throw new Error(`HTX API error: ${result.status} - ${result['err-msg']}`);
            }

            // HTX ticker format: { status: "ok", tick: { close: 96234.50 } }
            const currentPrice = parseFloat(result.tick?.close || 0);

            logger.debug('HTX current price fetched', { pair: htxPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch HTX current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to HTX
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test accounts endpoint (requires authentication)
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
            const params = {
                'AccessKeyId': credentials.apiKey,
                'SignatureMethod': 'HmacSHA256',
                'SignatureVersion': '2',
                'Timestamp': timestamp
            };

            const signature = this._createHTXSignature('GET', this.host, '/v1/account/accounts', params, credentials.apiSecret);
            params['Signature'] = signature;

            const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
            const url = `${this.baseUrl}/v1/account/accounts?${queryString}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTX connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for HTX API error
            if (result.status !== 'ok') {
                throw new Error(`HTX connection test failed: ${result.status} - ${result['err-msg']}`);
            }

            logger.info('HTX connection test successful', {
                accountsCount: result.data?.length
            });

            return true;

        } catch (error) {
            logger.error('HTX connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create HTX signature for authentication
     * Format: method\nhost\npath\nsorted_params
     * @private
     */
    _createHTXSignature(method, host, path, params, apiSecret) {
        // HTX signature: base64(HMAC-SHA256(method\nhost\npath\nsorted_params, apiSecret))
        const sortedParams = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
        const meta = [method, host, path, sortedParams].join('\n');
        return crypto.createHmac('sha256', apiSecret).update(meta).digest('base64');
    }

    /**
     * Convert standard interval format to HTX period
     * @private
     */
    _convertIntervalToHTX(interval) {
        // HTX uses: 1min, 5min, 15min, 30min, 60min, 4hour, 1day, 1week, 1mon
        const intervalMap = {
            '1m': '1min',
            '5m': '5min',
            '15m': '15min',
            '30m': '30min',
            '1h': '60min',
            '4h': '4hour',
            '1d': '1day',
            '1w': '1week',
            '1M': '1mon'
        };

        return intervalMap[interval] || '60min'; // Default to 1 hour
    }

    /**
     * Convert pair to HTX format (BTCUSDT → btcusdt)
     * HTX uses lowercase without separator
     * @private
     */
    _convertPairToHTX(pair) {
        // Convert to lowercase
        return pair.toLowerCase();
    }

    /**
     * Transform HTX candle response to standard format
     * @private
     */
    _transformCandles(htxCandles) {
        if (!Array.isArray(htxCandles)) {
            return [];
        }

        // HTX candlestick format: [
        //   {
        //     "id": 1597026383,     // Unix timestamp in seconds
        //     "open": 3.721,        // Open price
        //     "high": 3.743,        // High price
        //     "low": 3.677,         // Low price
        //     "close": 3.708,       // Close price
        //     "amount": 8422410,    // Trading volume (base currency)
        //     "vol": 31234567,      // Trading volume (quote currency)
        //     "count": 1234         // Number of trades
        //   }
        // ]

        return htxCandles.map(candle => ({
            timestamp: candle.id * 1000, // Convert seconds to milliseconds
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close),
            volume: parseFloat(candle.amount)
        })).reverse(); // HTX returns newest first, we want oldest first
    }

    /**
     * Get available USDT trading pairs on HTX
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = HTXMarketDataService;
