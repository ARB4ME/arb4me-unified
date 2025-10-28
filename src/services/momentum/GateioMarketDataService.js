// Gate.io Market Data Service
// Fetches candle data and current prices from Gate.io API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class GateioMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.gateio.ws';

        // Rate limiting: Gate.io has generous rate limits
        // Public: 900 requests per second
        // Private: 300 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // Gate.io-specific: Top 50 major USDT pairs by market cap and trading volume
        this.supportedPairs = [
            // Top Layer 1 blockchains (by market cap)
            'BTC_USDT', 'ETH_USDT', 'BNB_USDT', 'SOL_USDT', 'XRP_USDT', 'ADA_USDT',
            'AVAX_USDT', 'DOT_USDT', 'MATIC_USDT', 'ATOM_USDT', 'NEAR_USDT', 'APT_USDT',
            'SUI_USDT', 'SEI_USDT', 'TON_USDT', 'TRX_USDT',

            // Layer 2 solutions
            'ARB_USDT', 'OP_USDT', 'IMX_USDT', 'LRC_USDT',

            // Major DeFi tokens
            'AAVE_USDT', 'UNI_USDT', 'LINK_USDT', 'MKR_USDT', 'SNX_USDT', 'CRV_USDT',
            'COMP_USDT', 'SUSHI_USDT', '1INCH_USDT', 'LDO_USDT', 'PENDLE_USDT',

            // Stablecoins
            'USDC_USDT', 'DAI_USDT', 'TUSD_USDT',

            // Popular altcoins
            'LTC_USDT', 'BCH_USDT', 'ETC_USDT', 'XLM_USDT', 'ALGO_USDT', 'VET_USDT',
            'FIL_USDT', 'THETA_USDT', 'XTZ_USDT', 'EOS_USDT',

            // Meme coins
            'DOGE_USDT', 'SHIB_USDT', 'PEPE_USDT', 'FLOKI_USDT', 'BONK_USDT'
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

            // Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
            const gateioPair = this._convertPairToGateio(pair);

            // Convert interval to Gate.io format
            const gateioInterval = this._convertIntervalToGateio(interval);

            // Gate.io endpoint: GET /api/v4/spot/candlesticks
            const path = `/api/v4/spot/candlesticks?currency_pair=${gateioPair}&interval=${gateioInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Gate.io candles', { pair: gateioPair, interval, limit });

            // Candlesticks endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gate.io API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Gate.io response to standard format
            const candles = this._transformCandles(data);

            logger.info('Gate.io candles fetched successfully', {
                pair: gateioPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Gate.io candles', {
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

            // Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
            const gateioPair = this._convertPairToGateio(pair);

            // Gate.io endpoint: GET /api/v4/spot/tickers
            const path = `/api/v4/spot/tickers?currency_pair=${gateioPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Gate.io current price', { pair: gateioPair });

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
                throw new Error(`Gate.io API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Gate.io ticker format: [{ last: "96234.50" }]
            const currentPrice = parseFloat(data[0]?.last || 0);

            logger.debug('Gate.io current price fetched', { pair: gateioPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Gate.io current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Gate.io
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private balance endpoint
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const method = 'GET';
            const url = '/api/v4/spot/accounts';
            const queryString = '';

            const signature = this._createGateioSignature(method, url, queryString, '', timestamp, credentials.apiSecret);

            const fullUrl = `${this.baseUrl}${url}`;

            const response = await fetch(fullUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KEY': credentials.apiKey,
                    'Timestamp': timestamp,
                    'SIGN': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gate.io connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            logger.info('Gate.io connection test successful', {
                accountsCount: data.length
            });

            return true;

        } catch (error) {
            logger.error('Gate.io connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Gate.io signature for authentication
     * Uses HMAC-SHA512 signature
     * @private
     */
    _createGateioSignature(method, url, queryString, body, timestamp, apiSecret) {
        // Gate.io signature: HMAC-SHA512 of signing string
        // Signing string format: METHOD\nURL\nQUERY_STRING\nHASHED_PAYLOAD\nTIMESTAMP
        const hashedPayload = crypto.createHash('sha512').update(body || '').digest('hex');
        const signingString = `${method}\n${url}\n${queryString}\n${hashedPayload}\n${timestamp}`;
        return crypto.createHmac('sha512', apiSecret).update(signingString).digest('hex');
    }

    /**
     * Convert standard interval format to Gate.io interval
     * @private
     */
    _convertIntervalToGateio(interval) {
        // Gate.io uses: 10s, 1m, 5m, 15m, 30m, 1h, 4h, 8h, 1d, 7d, 30d
        const intervalMap = {
            '1m': '1m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1h',
            '4h': '4h',
            '8h': '8h',
            '1d': '1d',
            '1w': '7d'
        };

        return intervalMap[interval] || '1h'; // Default to 1 hour
    }

    /**
     * Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
     * Gate.io uses underscore separator
     * @private
     */
    _convertPairToGateio(pair) {
        // Convert BTCUSDT to BTC_USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform Gate.io candle response to standard format
     * @private
     */
    _transformCandles(gateioCandles) {
        if (!Array.isArray(gateioCandles)) {
            return [];
        }

        // Gate.io candlestick format: [
        //   [
        //     "1606292600",  // 0: Unix timestamp in seconds
        //     "19137.74",    // 1: Trading volume (quote currency)
        //     "19105.89",    // 2: Close price
        //     "19126.22",    // 3: Highest price
        //     "19105.89",    // 4: Lowest price
        //     "19106.39",    // 5: Open price
        //     "1.07",        // 6: Trading volume (base currency)
        //     true           // 7: Whether the candlestick is closed
        //   ]
        // ]

        return gateioCandles.map(candle => ({
            timestamp: parseInt(candle[0]) * 1000, // Convert to milliseconds
            open: parseFloat(candle[5]),
            high: parseFloat(candle[3]),
            low: parseFloat(candle[4]),
            close: parseFloat(candle[2]),
            volume: parseFloat(candle[6])
        })).reverse(); // Gate.io returns newest first, we want oldest first
    }

    /**
     * Get available USDT trading pairs on Gate.io
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = GateioMarketDataService;
