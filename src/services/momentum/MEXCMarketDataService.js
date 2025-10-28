// MEXC Market Data Service
// Fetches candle data and current prices from MEXC API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class MEXCMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.mexc.com';

        // Rate limiting: MEXC has generous rate limits
        // Public: 20 requests per second
        // Private: 10 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // MEXC-specific: Top 50 major USDT pairs by market cap and trading volume
        // Curated selection from MEXC's thousands of pairs
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
            'FILUSDT', 'THETAUSDT', 'XTZUSDT', 'EOSUSDT', 'MXUSDT',

            // Meme coins
            'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'FLOKIUSDT', 'BONKUSDT'
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

            // MEXC uses Binance-compatible interval format (1m, 5m, 15m, 30m, 1h, 4h, 1d)
            const mexcInterval = this._convertIntervalToMEXC(interval);

            // MEXC endpoint: GET /api/v3/klines
            const path = `/api/v3/klines?symbol=${pair}&interval=${mexcInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching MEXC candles', { pair, interval, limit });

            // Klines endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform MEXC response to standard format
            const candles = this._transformCandles(data);

            logger.info('MEXC candles fetched successfully', {
                pair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch MEXC candles', {
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

            // MEXC endpoint: GET /api/v3/ticker/price
            const path = `/api/v3/ticker/price?symbol=${pair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching MEXC current price', { pair });

            // Ticker endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // MEXC ticker format: { symbol: "BTCUSDT", price: "96234.50" }
            const currentPrice = parseFloat(data.price);

            logger.debug('MEXC current price fetched', { pair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch MEXC current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to MEXC
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private account endpoint
            const timestamp = Date.now();
            const queryString = `timestamp=${timestamp}`;
            const signature = this._createMEXCSignature(queryString, credentials.apiSecret);

            const path = `/api/v3/account?${queryString}&signature=${signature}`;
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MEXC-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            logger.info('MEXC connection test successful', {
                canTrade: data.canTrade,
                balancesCount: data.balances?.length
            });

            return true;

        } catch (error) {
            logger.error('MEXC connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create MEXC signature for authentication
     * Uses HMAC-SHA256 signature (lowercase hex)
     * @private
     */
    _createMEXCSignature(queryString, apiSecret) {
        // MEXC signature: HMAC-SHA256 of query string, lowercase hex
        return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    }

    /**
     * Convert standard interval format to MEXC interval
     * @private
     */
    _convertIntervalToMEXC(interval) {
        // MEXC uses Binance-compatible format: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M
        // Our standard format matches MEXC, so just return as-is
        return interval;
    }

    /**
     * Transform MEXC candle response to standard format
     * @private
     */
    _transformCandles(mexcCandles) {
        if (!Array.isArray(mexcCandles)) {
            return [];
        }

        // MEXC kline format (Binance-compatible): [
        //   [
        //     1499040000000,      // 0: Open time
        //     "0.01634000",       // 1: Open
        //     "0.80000000",       // 2: High
        //     "0.01575800",       // 3: Low
        //     "0.01577100",       // 4: Close
        //     "148976.11427815",  // 5: Volume
        //     1499644799999,      // 6: Close time
        //     "2434.19055334",    // 7: Quote asset volume
        //     308,                // 8: Number of trades
        //     "1756.87402397",    // 9: Taker buy base asset volume
        //     "28.46694368",      // 10: Taker buy quote asset volume
        //     "0"                 // 11: Ignore
        //   ]
        // ]

        return mexcCandles.map(candle => ({
            timestamp: candle[0], // Open time in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
    }

    /**
     * Get available USDT trading pairs on MEXC
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = MEXCMarketDataService;
