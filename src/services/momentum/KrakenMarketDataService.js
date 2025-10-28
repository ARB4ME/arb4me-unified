// Kraken Market Data Service
// Fetches candle data and current prices from Kraken API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class KrakenMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.kraken.com';

        // Rate limiting: Kraken has strict rate limits
        // Public endpoints: 1 request per second (decrease counter by 1 every 3 seconds)
        // Private endpoints: More restrictive
        this.minRequestInterval = 1000; // milliseconds (1 second between requests)
        this.lastRequestTime = 0;

        // Kraken-specific: Supported USDT pairs (43 pairs)
        this.supportedPairs = [
            'AI16ZUSDT',
            'ALGOUSDT',
            'APEUSDT',
            'AVAXUSDT',
            'BERAUSDT',
            'BTCUSDT',    // Kraken uses XBT internally, but accepts BTC
            'BCHUSDT',
            'BNBUSDT',
            'ADAUSDT',
            'LINKUSDT',
            'ATOMUSDT',
            'CROUSDT',
            'DAIUSDT',
            'MANAUSDT',
            'DOGEUSDT',
            'EOSUSDT',
            'USDEUSDT',
            'ETHUSDT',
            'USDGUSDT',
            'GRIFUSDT',
            'KASUSDT',
            'LTCUSDT',
            'MELANIAUSDT',
            'XMRUSDT',
            'TRUMPUSDT',
            'DOTUSDT',
            'MATICUSDT',  // Polygon
            'PENGUUSDT',
            'XRPUSDT',
            'SONICUSDT',
            'EURSUSDT',
            'USDSUSDT',
            'SHIBUSDT',
            'SOLUSDT',
            'USTCUSDT',
            'EURTUSDT',
            'XAUTUSDT',
            'XTZUSDT',
            'TONUSDT',
            'USDCUSDT',
            'USDQUSDT',
            'VIRTUALUSDT'
        ];
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
     * Prevents hitting Kraken's strict rate limits
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
     * @param {number} limit - Number of candles to fetch (default 100, max 720)
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to Kraken format (e.g., BTCUSDT → XBTUSDT)
            const krakenPair = this._convertPairToKraken(pair);

            // Convert interval to Kraken format (in minutes)
            const krakenInterval = this._convertIntervalToKraken(interval);

            // Kraken endpoint: GET /0/public/OHLC
            const path = `/0/public/OHLC?pair=${krakenPair}&interval=${krakenInterval}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Kraken candles', { pair: krakenPair, interval, limit });

            // OHLC endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Kraken API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Transform Kraken response to standard format
            const candles = this._transformCandles(data.result, krakenPair, limit);

            logger.info('Kraken candles fetched successfully', {
                pair: krakenPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Kraken candles', {
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

            // Convert pair to Kraken format (e.g., BTCUSDT → XBTUSDT)
            const krakenPair = this._convertPairToKraken(pair);

            // Kraken endpoint: GET /0/public/Ticker
            const path = `/0/public/Ticker?pair=${krakenPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Kraken current price', { pair: krakenPair });

            // Ticker endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Kraken API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Kraken returns result with pair name as key
            // Extract the first (and only) result
            const tickerData = Object.values(data.result)[0];

            // Kraken ticker format: { a: [ask_price, ...], b: [bid_price, ...], c: [last_price, ...] }
            const currentPrice = parseFloat(tickerData.c[0]); // c[0] is last trade price

            logger.debug('Kraken current price fetched', { pair: krakenPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Kraken current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Kraken
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private balance endpoint
            const nonce = Date.now() * 1000;
            const postData = `nonce=${nonce}`;
            const path = '/0/private/Balance';
            const url = `${this.baseUrl}${path}`;

            const authHeaders = this._createKrakenAuth(
                credentials.apiKey,
                credentials.apiSecret,
                path,
                nonce,
                postData
            );

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...authHeaders
                },
                body: postData
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Kraken connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            logger.info('Kraken connection test successful', {
                balanceAccess: true
            });

            return true;

        } catch (error) {
            logger.error('Kraken connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Kraken authentication headers (API-Key + API-Sign)
     * Uses HMAC-SHA512 signature
     * @private
     */
    _createKrakenAuth(apiKey, apiSecret, path, nonce, postData) {
        // Kraken signature: HMAC-SHA512 of (URI path + SHA256(nonce + POST data))
        // using base64-decoded API secret as the key
        const message = nonce + postData;
        const secret = Buffer.from(apiSecret, 'base64');
        const hash = crypto.createHash('sha256').update(message).digest();
        const hmac = crypto.createHmac('sha512', secret)
            .update(Buffer.concat([Buffer.from(path, 'utf8'), hash]))
            .digest('base64');

        return {
            'API-Key': apiKey,
            'API-Sign': hmac
        };
    }

    /**
     * Convert standard interval format to Kraken interval (in minutes)
     * @private
     */
    _convertIntervalToKraken(interval) {
        // Kraken uses intervals in minutes: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
        const intervalMap = {
            '1m': 1,
            '5m': 5,
            '15m': 15,
            '30m': 30,
            '1h': 60,
            '4h': 240,
            '1d': 1440,
            '1w': 10080,
            '15d': 21600
        };

        return intervalMap[interval] || 60; // Default to 1 hour
    }

    /**
     * Convert pair to Kraken format
     * Kraken uses specific naming conventions:
     * - BTC → XBT
     * - Pairs don't have separators (XBTUSDT)
     * @private
     */
    _convertPairToKraken(pair) {
        // Kraken uses XBT instead of BTC
        if (pair.startsWith('BTC')) {
            return pair.replace('BTC', 'XBT');
        }

        // Most other pairs use standard names
        return pair;
    }

    /**
     * Transform Kraken candle response to standard format
     * @private
     */
    _transformCandles(krakenResult, krakenPair, limit) {
        if (!krakenResult) {
            return [];
        }

        // Kraken returns result as object with pair name as key
        // Extract candles array from the first key
        const pairKey = Object.keys(krakenResult).find(key => key !== 'last');
        const candles = krakenResult[pairKey];

        if (!Array.isArray(candles)) {
            return [];
        }

        // Kraken candle format: [time, open, high, low, close, vwap, volume, count]
        const transformedCandles = candles.map(candle => ({
            timestamp: candle[0] * 1000, // Convert to milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[6])
        }));

        // Return only the requested limit (most recent candles)
        return transformedCandles.slice(-limit);
    }

    /**
     * Get available USDT trading pairs on Kraken
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = KrakenMarketDataService;
