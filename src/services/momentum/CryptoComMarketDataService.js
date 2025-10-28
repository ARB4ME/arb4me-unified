// Crypto.com Market Data Service
// Fetches candle data and current prices from Crypto.com API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class CryptoComMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.crypto.com';

        // Rate limiting: Crypto.com has standard rate limits
        // Public: 100 requests per second
        // Private: 15 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // Crypto.com-specific: Top 50 major USDT pairs by market cap and trading volume
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
            'CROUSDT' // Crypto.com native token (Cronos) with reduced fees
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
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to Crypto.com format (BTCUSDT → BTC_USDT)
            const cryptocomPair = this._convertPairToCryptoCom(pair);

            // Convert interval to Crypto.com format
            const cryptocomInterval = this._convertIntervalToCryptoCom(interval);

            // Crypto.com endpoint: GET /v2/public/get-candlestick
            const path = `/v2/public/get-candlestick`;
            const params = new URLSearchParams({
                instrument_name: cryptocomPair,
                timeframe: cryptocomInterval
            });
            const url = `${this.baseUrl}${path}?${params}`;

            logger.info('Fetching Crypto.com candles', { pair: cryptocomPair, interval, limit });

            // Candlestick endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Crypto.com API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Crypto.com API error
            if (result.code !== 0) {
                throw new Error(`Crypto.com API error: ${result.code} - ${result.message}`);
            }

            // Transform Crypto.com response to standard format
            const candles = this._transformCandles(result.result?.data || []).slice(0, limit);

            logger.info('Crypto.com candles fetched successfully', {
                pair: cryptocomPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Crypto.com candles', {
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

            // Convert pair to Crypto.com format (BTCUSDT → BTC_USDT)
            const cryptocomPair = this._convertPairToCryptoCom(pair);

            // Crypto.com endpoint: GET /v2/public/get-ticker
            const path = `/v2/public/get-ticker`;
            const params = new URLSearchParams({
                instrument_name: cryptocomPair
            });
            const url = `${this.baseUrl}${path}?${params}`;

            logger.debug('Fetching Crypto.com current price', { pair: cryptocomPair });

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
                throw new Error(`Crypto.com API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Crypto.com API error
            if (result.code !== 0) {
                throw new Error(`Crypto.com API error: ${result.code} - ${result.message}`);
            }

            // Crypto.com ticker format: { code: 0, result: { data: [{ a: "96234.50" }] } }
            const tickerData = result.result?.data?.[0];
            const currentPrice = parseFloat(tickerData?.a || 0);

            logger.debug('Crypto.com current price fetched', { pair: cryptocomPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Crypto.com current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Crypto.com
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test account summary endpoint (requires authentication)
            const nonce = Date.now();
            const method = 'POST';
            const requestPath = '/v2/private/get-account-summary';
            const requestBody = JSON.stringify({
                id: 11,
                method: 'private/get-account-summary',
                api_key: credentials.apiKey,
                nonce: nonce
            });

            const signaturePayload = method + requestPath + requestBody + nonce;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('hex');

            const url = `${this.baseUrl}${requestPath}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': credentials.apiKey,
                    'signature': signature,
                    'nonce': nonce.toString()
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Crypto.com connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Crypto.com API error
            if (result.code && result.code !== 0) {
                throw new Error(`Crypto.com connection test failed: ${result.code} - ${result.message}`);
            }

            logger.info('Crypto.com connection test successful', {
                accountsCount: result.result?.accounts?.length
            });

            return true;

        } catch (error) {
            logger.error('Crypto.com connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Crypto.com signature for authentication
     * Format: method + requestPath + body + nonce
     * Uses HMAC-SHA256 signature (hex)
     * @private
     */
    _createCryptoComSignature(method, requestPath, body, nonce, apiSecret) {
        // Crypto.com signature: HMAC-SHA256(method + requestPath + body + nonce, apiSecret)
        const signaturePayload = method + requestPath + body + nonce;
        return crypto.createHmac('sha256', apiSecret).update(signaturePayload).digest('hex');
    }

    /**
     * Convert standard interval format to Crypto.com interval
     * @private
     */
    _convertIntervalToCryptoCom(interval) {
        // Crypto.com uses: 1m, 5m, 15m, 30m, 1h, 4h, 6h, 12h, 1D, 7D, 14D, 1M
        const intervalMap = {
            '1m': '1m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1h',
            '4h': '4h',
            '6h': '6h',
            '12h': '12h',
            '1d': '1D',
            '1w': '7D',
            '1M': '1M'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Convert pair to Crypto.com format (BTCUSDT → BTC_USDT)
     * Crypto.com uses underscore separator
     * @private
     */
    _convertPairToCryptoCom(pair) {
        // Convert BTCUSDT to BTC_USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform Crypto.com candle response to standard format
     * @private
     */
    _transformCandles(cryptocomCandles) {
        if (!Array.isArray(cryptocomCandles)) {
            return [];
        }

        // Crypto.com candlestick format: {
        //   t: 1597026383000,  // Timestamp in milliseconds
        //   o: 3.721,           // Open price
        //   h: 3.743,           // High price
        //   l: 3.677,           // Low price
        //   c: 3.708,           // Close price
        //   v: 8422410          // Volume
        // }

        return cryptocomCandles.map(candle => ({
            timestamp: candle.t, // Timestamp in milliseconds
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
            volume: parseFloat(candle.v)
        }));
    }

    /**
     * Get available USDT trading pairs on Crypto.com
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = CryptoComMarketDataService;
