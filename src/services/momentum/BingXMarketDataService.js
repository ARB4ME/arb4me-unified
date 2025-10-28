// BingX Market Data Service
// Fetches candle data and current prices from BingX API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class BingXMarketDataService {
    constructor() {
        this.baseUrl = 'https://open-api.bingx.com';

        // Rate limiting: BingX has standard rate limits
        // Public: 20 requests per second
        // Private: 10 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // BingX-specific: Top 50 major USDT pairs by market cap and trading volume
        // Curated selection from BingX's pair list
        this.supportedPairs = [
            // Top Layer 1 blockchains (by market cap)
            'BTC-USDT', 'ETH-USDT', 'BNB-USDT', 'SOL-USDT', 'XRP-USDT', 'ADA-USDT',
            'AVAX-USDT', 'DOT-USDT', 'MATIC-USDT', 'ATOM-USDT', 'NEAR-USDT', 'APT-USDT',
            'SUI-USDT', 'SEI-USDT', 'TON-USDT', 'TRX-USDT',

            // Layer 2 solutions
            'ARB-USDT', 'OP-USDT', 'IMX-USDT', 'LRC-USDT',

            // Major DeFi tokens
            'AAVE-USDT', 'UNI-USDT', 'LINK-USDT', 'MKR-USDT', 'SNX-USDT', 'CRV-USDT',
            'COMP-USDT', 'SUSHI-USDT', '1INCH-USDT', 'LDO-USDT', 'PENDLE-USDT',

            // Stablecoins
            'USDC-USDT', 'DAI-USDT', 'TUSD-USDT',

            // Popular altcoins
            'LTC-USDT', 'BCH-USDT', 'ETC-USDT', 'XLM-USDT', 'ALGO-USDT', 'VET-USDT',
            'FIL-USDT', 'THETA-USDT', 'XTZ-USDT', 'EOS-USDT',

            // Meme coins
            'DOGE-USDT', 'SHIB-USDT', 'PEPE-USDT', 'FLOKI-USDT', 'BONK-USDT'
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
     * @param {number} limit - Number of candles to fetch (default 100, max 1440)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to BingX format (BTCUSDT → BTC-USDT)
            const bingxPair = this._convertPairToBingX(pair);

            // Convert interval to BingX format
            const bingxInterval = this._convertIntervalToBingX(interval);

            // BingX endpoint: GET /openApi/swap/v2/quote/klines
            const path = `/openApi/swap/v2/quote/klines?symbol=${bingxPair}&interval=${bingxInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching BingX candles', { pair: bingxPair, interval, limit });

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
                throw new Error(`BingX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BingX API error
            if (result.code !== 0) {
                throw new Error(`BingX API error: ${result.code} - ${result.msg}`);
            }

            // Transform BingX response to standard format
            const candles = this._transformCandles(result.data);

            logger.info('BingX candles fetched successfully', {
                pair: bingxPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch BingX candles', {
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

            // Convert pair to BingX format (BTCUSDT → BTC-USDT)
            const bingxPair = this._convertPairToBingX(pair);

            // BingX endpoint: GET /openApi/spot/v1/ticker/24hr
            const path = `/openApi/spot/v1/ticker/24hr?symbol=${bingxPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching BingX current price', { pair: bingxPair });

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
                throw new Error(`BingX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BingX API error
            if (result.code !== 0) {
                throw new Error(`BingX API error: ${result.code} - ${result.msg}`);
            }

            // BingX ticker format: { code: 0, data: { lastPrice: "96234.50" } }
            const currentPrice = parseFloat(result.data?.lastPrice || 0);

            logger.debug('BingX current price fetched', { pair: bingxPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch BingX current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to BingX
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test balance endpoint (requires authentication)
            const timestamp = Date.now();
            const queryString = `timestamp=${timestamp}`;
            const signature = this._createBingXSignature(queryString, credentials.apiSecret);

            const url = `${this.baseUrl}/openApi/spot/v1/account/balance?${queryString}&signature=${signature}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-BX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BingX connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BingX API error
            if (result.code !== 0) {
                throw new Error(`BingX connection test failed: ${result.code} - ${result.msg}`);
            }

            logger.info('BingX connection test successful', {
                balancesCount: result.data?.balances?.length
            });

            return true;

        } catch (error) {
            logger.error('BingX connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create BingX signature for authentication
     * Uses HMAC-SHA256 signature (lowercase hex)
     * @private
     */
    _createBingXSignature(queryString, apiSecret) {
        // BingX signature: HMAC-SHA256 of query string, lowercase hex
        return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    }

    /**
     * Convert standard interval format to BingX interval
     * @private
     */
    _convertIntervalToBingX(interval) {
        // BingX uses: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 3d, 1w, 1M
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
            '12h': '12h',
            '1d': '1d',
            '3d': '3d',
            '1w': '1w',
            '1M': '1M'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Convert pair to BingX format (BTCUSDT → BTC-USDT)
     * BingX uses hyphen separator
     * @private
     */
    _convertPairToBingX(pair) {
        // Convert BTCUSDT to BTC-USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}-${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform BingX candle response to standard format
     * @private
     */
    _transformCandles(bingxCandles) {
        if (!Array.isArray(bingxCandles)) {
            return [];
        }

        // BingX candlestick format: [
        //   {
        //     "time": 1597026383085,  // Timestamp in milliseconds
        //     "open": "3.721",        // Open price
        //     "high": "3.743",        // High price
        //     "low": "3.677",         // Low price
        //     "close": "3.708",       // Close price
        //     "volume": "8422410"     // Volume (base currency)
        //   }
        // ]

        return bingxCandles.map(candle => ({
            timestamp: candle.time, // Timestamp in milliseconds
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close),
            volume: parseFloat(candle.volume)
        }));
    }

    /**
     * Get available USDT trading pairs on BingX
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = BingXMarketDataService;
