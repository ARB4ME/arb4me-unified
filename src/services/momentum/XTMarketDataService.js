// XT.com Market Data Service
// Fetches candle data and current prices from XT.com API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class XTMarketDataService {
    constructor() {
        this.baseUrl = 'https://sapi.xt.com';

        // Rate limiting: XT.com has standard rate limits
        // Public: 20 requests per second
        // Private: 10 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // XT.com-specific: Top 50 major USDT pairs by market cap and trading volume
        // Curated selection from XT.com's extensive pair list
        this.supportedPairs = [
            // Top Layer 1 blockchains (by market cap)
            'btc_usdt', 'eth_usdt', 'bnb_usdt', 'sol_usdt', 'xrp_usdt', 'ada_usdt',
            'avax_usdt', 'dot_usdt', 'matic_usdt', 'atom_usdt', 'near_usdt', 'apt_usdt',
            'sui_usdt', 'sei_usdt', 'ton_usdt', 'trx_usdt',

            // Layer 2 solutions
            'arb_usdt', 'op_usdt', 'imx_usdt', 'lrc_usdt',

            // Major DeFi tokens
            'aave_usdt', 'uni_usdt', 'link_usdt', 'mkr_usdt', 'snx_usdt', 'crv_usdt',
            'comp_usdt', 'sushi_usdt', '1inch_usdt', 'ldo_usdt', 'pendle_usdt',

            // Stablecoins
            'usdc_usdt', 'dai_usdt', 'tusd_usdt',

            // Popular altcoins
            'ltc_usdt', 'bch_usdt', 'etc_usdt', 'xlm_usdt', 'algo_usdt', 'vet_usdt',
            'fil_usdt', 'theta_usdt', 'xtz_usdt', 'eos_usdt', 'xt_usdt',

            // Meme coins
            'doge_usdt', 'shib_usdt', 'pepe_usdt', 'floki_usdt', 'bonk_usdt'
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

            // Convert pair to XT.com format (BTCUSDT → btc_usdt)
            const xtPair = this._convertPairToXT(pair);

            // Convert interval to XT.com format
            const xtInterval = this._convertIntervalToXT(interval);

            // XT.com endpoint: GET /v4/public/kline
            const path = `/v4/public/kline?symbol=${xtPair}&interval=${xtInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching XT.com candles', { pair: xtPair, interval, limit });

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
                throw new Error(`XT.com API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for XT.com API error
            if (result.rc !== 0) {
                throw new Error(`XT.com API error: ${result.rc} - ${result.msg}`);
            }

            // Transform XT.com response to standard format
            const candles = this._transformCandles(result.result);

            logger.info('XT.com candles fetched successfully', {
                pair: xtPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch XT.com candles', {
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

            // Convert pair to XT.com format (BTCUSDT → btc_usdt)
            const xtPair = this._convertPairToXT(pair);

            // XT.com endpoint: GET /v4/public/ticker
            const path = `/v4/public/ticker?symbol=${xtPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching XT.com current price', { pair: xtPair });

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
                throw new Error(`XT.com API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for XT.com API error
            if (result.rc !== 0) {
                throw new Error(`XT.com API error: ${result.rc} - ${result.msg}`);
            }

            // XT.com ticker format: { rc: 0, result: { p: "96234.50" } }
            const currentPrice = parseFloat(result.result?.p || 0);

            logger.debug('XT.com current price fetched', { pair: xtPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch XT.com current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to XT.com
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private balance endpoint
            const timestamp = Date.now().toString();
            const signature = this._createXTSignature(credentials.apiKey, timestamp, credentials.apiSecret);

            const path = '/v4/balances';
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'validate-algorithms': 'HmacSHA256',
                    'validate-appkey': credentials.apiKey,
                    'validate-recvwindow': '60000',
                    'validate-timestamp': timestamp,
                    'validate-signature': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`XT.com connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for XT.com API error
            if (result.rc !== 0) {
                throw new Error(`XT.com connection test failed: ${result.rc} - ${result.msg}`);
            }

            logger.info('XT.com connection test successful', {
                balancesCount: result.result?.length
            });

            return true;

        } catch (error) {
            logger.error('XT.com connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create XT.com signature for authentication
     * Unique signature format: apiKey + "#" + apiSecret + "#" + timestamp
     * @private
     */
    _createXTSignature(apiKey, timestamp, apiSecret) {
        // XT signature: HMAC-SHA256(apiKey + "#" + apiSecret + "#" + timestamp, apiSecret)
        const signString = apiKey + "#" + apiSecret + "#" + timestamp;
        return crypto.createHmac('sha256', apiSecret).update(signString).digest('hex');
    }

    /**
     * Convert standard interval format to XT.com interval
     * @private
     */
    _convertIntervalToXT(interval) {
        // XT.com uses: 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M
        const intervalMap = {
            '1m': '1m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1h',
            '4h': '4h',
            '1d': '1d',
            '1w': '1w',
            '1M': '1M'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Convert pair to XT.com format (BTCUSDT → btc_usdt)
     * XT.com uses lowercase with underscore separator
     * @private
     */
    _convertPairToXT(pair) {
        // Convert BTCUSDT to btc_usdt format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency.toLowerCase()}_${quoteCurrency.toLowerCase()}`;
        }
        return pair.toLowerCase();
    }

    /**
     * Transform XT.com candle response to standard format
     * @private
     */
    _transformCandles(xtCandles) {
        if (!Array.isArray(xtCandles)) {
            return [];
        }

        // XT.com candlestick format: [
        //   {
        //     "t": 1597026383085,  // Timestamp in milliseconds
        //     "o": "3.721",         // Open price
        //     "h": "3.743",         // High price
        //     "l": "3.677",         // Low price
        //     "c": "3.708",         // Close price
        //     "v": "8422410"        // Volume (base currency)
        //   }
        // ]

        return xtCandles.map(candle => ({
            timestamp: candle.t, // Timestamp in milliseconds
            open: parseFloat(candle.o),
            high: parseFloat(candle.h),
            low: parseFloat(candle.l),
            close: parseFloat(candle.c),
            volume: parseFloat(candle.v)
        }));
    }

    /**
     * Get available USDT trading pairs on XT.com
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = XTMarketDataService;
