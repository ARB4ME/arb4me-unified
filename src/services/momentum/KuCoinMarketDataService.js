// KuCoin Market Data Service
// Fetches candle data and current prices from KuCoin API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class KuCoinMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.kucoin.com';

        // Rate limiting: KuCoin has tiered rate limits
        // Public: 100 requests per 10 seconds
        // Private: 200 requests per 10 seconds
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // KuCoin-specific: Top 50 major USDT pairs by market cap and trading volume
        // Curated selection from KuCoin's extensive pair list
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
            'FIL-USDT', 'THETA-USDT', 'XTZ-USDT', 'EOS-USDT', 'KCS-USDT',

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
     * @param {number} limit - Number of candles to fetch (default 100, max 1500)
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
            const kucoinPair = this._convertPairToKuCoin(pair);

            // Convert interval to KuCoin format
            const kucoinInterval = this._convertIntervalToKuCoin(interval);

            // Calculate start and end time for the candles
            const endAt = Math.floor(Date.now() / 1000);
            const startAt = endAt - (limit * this._getIntervalSeconds(interval));

            // KuCoin endpoint: GET /api/v1/market/candles
            const path = `/api/v1/market/candles?symbol=${kucoinPair}&type=${kucoinInterval}&startAt=${startAt}&endAt=${endAt}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching KuCoin candles', { pair: kucoinPair, interval, limit });

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
                throw new Error(`KuCoin API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for KuCoin API error
            if (result.code !== '200000') {
                throw new Error(`KuCoin API error: ${result.code} - ${result.msg}`);
            }

            // Transform KuCoin response to standard format
            const candles = this._transformCandles(result.data);

            logger.info('KuCoin candles fetched successfully', {
                pair: kucoinPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch KuCoin candles', {
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

            // Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
            const kucoinPair = this._convertPairToKuCoin(pair);

            // KuCoin endpoint: GET /api/v1/market/orderbook/level1
            const path = `/api/v1/market/orderbook/level1?symbol=${kucoinPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching KuCoin current price', { pair: kucoinPair });

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
                throw new Error(`KuCoin API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for KuCoin API error
            if (result.code !== '200000') {
                throw new Error(`KuCoin API error: ${result.code} - ${result.msg}`);
            }

            // KuCoin ticker format: { code: "200000", data: { price: "96234.50" } }
            const currentPrice = parseFloat(result.data?.price || 0);

            logger.debug('KuCoin current price fetched', { pair: kucoinPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch KuCoin current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to KuCoin
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private accounts endpoint
            const timestamp = Date.now().toString();
            const method = 'GET';
            const endpoint = '/api/v1/accounts';
            const body = '';

            const signature = this._createKuCoinSignature(timestamp, method, endpoint, body, credentials.apiSecret);
            const passphrase = this._createKuCoinPassphrase(credentials.passphrase, credentials.apiSecret);

            const url = `${this.baseUrl}${endpoint}`;

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KC-API-KEY': credentials.apiKey,
                    'KC-API-SIGN': signature,
                    'KC-API-TIMESTAMP': timestamp,
                    'KC-API-PASSPHRASE': passphrase,
                    'KC-API-KEY-VERSION': '2'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`KuCoin connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for KuCoin API error
            if (result.code !== '200000') {
                throw new Error(`KuCoin connection test failed: ${result.code} - ${result.msg}`);
            }

            logger.info('KuCoin connection test successful', {
                accountsCount: result.data?.length
            });

            return true;

        } catch (error) {
            logger.error('KuCoin connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create KuCoin signature for authentication
     * Uses HMAC-SHA256 with base64 encoding
     * @private
     */
    _createKuCoinSignature(timestamp, method, endpoint, body, apiSecret) {
        // KuCoin signature: base64(HMAC-SHA256(timestamp + method + endpoint + body, apiSecret))
        const strForSign = timestamp + method + endpoint + (body || '');
        return crypto.createHmac('sha256', apiSecret).update(strForSign).digest('base64');
    }

    /**
     * Create KuCoin passphrase
     * KuCoin v2 requires passphrase to be encrypted with apiSecret
     * @private
     */
    _createKuCoinPassphrase(passphrase, apiSecret) {
        // KuCoin API v2: passphrase = base64(HMAC-SHA256(passphrase, apiSecret))
        return crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');
    }

    /**
     * Convert standard interval format to KuCoin type format
     * @private
     */
    _convertIntervalToKuCoin(interval) {
        // KuCoin uses: 1min, 3min, 5min, 15min, 30min, 1hour, 2hour, 4hour, 6hour, 8hour, 12hour, 1day, 1week
        const intervalMap = {
            '1m': '1min',
            '3m': '3min',
            '5m': '5min',
            '15m': '15min',
            '30m': '30min',
            '1h': '1hour',
            '2h': '2hour',
            '4h': '4hour',
            '6h': '6hour',
            '8h': '8hour',
            '12h': '12hour',
            '1d': '1day',
            '1w': '1week'
        };

        return intervalMap[interval] || '1hour'; // Default to 1 hour
    }

    /**
     * Get interval duration in seconds
     * @private
     */
    _getIntervalSeconds(interval) {
        const intervalMap = {
            '1m': 60,
            '3m': 180,
            '5m': 300,
            '15m': 900,
            '30m': 1800,
            '1h': 3600,
            '2h': 7200,
            '4h': 14400,
            '6h': 21600,
            '8h': 28800,
            '12h': 43200,
            '1d': 86400,
            '1w': 604800
        };

        return intervalMap[interval] || 3600; // Default to 1 hour
    }

    /**
     * Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
     * KuCoin uses hyphen separator
     * @private
     */
    _convertPairToKuCoin(pair) {
        // Convert BTCUSDT to BTC-USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}-${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform KuCoin candle response to standard format
     * @private
     */
    _transformCandles(kucoinCandles) {
        if (!Array.isArray(kucoinCandles)) {
            return [];
        }

        // KuCoin candlestick format: [
        //   [
        //     "1545904980",      // 0: Start time of the candle cycle (seconds)
        //     "0.058",           // 1: Open price
        //     "0.049",           // 2: Close price
        //     "0.058",           // 3: High price
        //     "0.049",           // 4: Low price
        //     "0.018",           // 5: Transaction volume (base currency)
        //     "0.000945"         // 6: Transaction amount (quote currency)
        //   ]
        // ]

        return kucoinCandles.map(candle => ({
            timestamp: parseInt(candle[0]) * 1000, // Convert seconds to milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[3]),
            low: parseFloat(candle[4]),
            close: parseFloat(candle[2]),
            volume: parseFloat(candle[5])
        })).reverse(); // KuCoin returns newest first, we want oldest first
    }

    /**
     * Get available USDT trading pairs on KuCoin
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = KuCoinMarketDataService;
