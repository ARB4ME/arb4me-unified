// Binance Market Data Service
// Fetches candle data and current prices from Binance API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class BinanceMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.binance.com';

        // Rate limiting: Binance has weight-based rate limits
        // 1200 weight per minute, most requests = 1 weight
        // Conservative approach: ~10 requests per second max
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // Binance-specific: Supported USDT pairs (excluding leveraged UP/DOWN tokens)
        // Standard spot trading pairs only
        this.supportedPairs = [
            'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOTUSDT',
            'LINKUSDT', 'LTCUSDT', 'BCHUSDT', 'UNIUSDT', 'SOLUSDT', 'MATICUSDT',
            'AVAXUSDT', 'ATOMUSDT', 'FILUSDT', 'TRXUSDT', 'EOSUSDT', 'XLMUSDT',
            'VETUSDT', 'THETAUSDT', 'ALGOUSDT', 'XTZUSDT', 'EGLDUSDT', 'AAVEUSDT',
            'NEOUSDT', 'DASHUSDT', 'ETCUSDT', 'MKRUSDT', 'COMPUSDT', 'YFIUSDT',
            'ZECUSDT', 'SUSHIUSDT', 'SNXUSDT', 'UNIUSDT', 'CRVUSDT', 'GRTUSDT',
            'CAKEUSDT', 'AXSUSDT', 'SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'CHZUSDT',
            'FTMUSDT', 'HBARUSDT', 'ZILUSDT', 'ICXUSDT', 'KSMUSDT', 'KAVAUSDT',
            'BANDUSDT', 'RUNEUSDT', 'OCEANUSDT', 'NEARUSDT', 'SKLUSDT', 'AUDIOUSDT',
            '1INCHUSDT', 'INJUSDT', 'CELOUSDT', 'RENUSDT', 'STORJUSDT', 'BATUSDT',
            'LRCUSDT', 'KNCUSDT', 'ZRXUSDT', 'OMGUSDT', 'BALUSDT', 'QTUMUSDT',
            'IOTAUSDT', 'ZENUSDT', 'ONTUSDT', 'RVNUSDT', 'DGBUSDT', 'WAVESUSDT',
            'DOGEUSDT', 'SXPUSDT', 'ONEUSDT', 'HOTUSDT', 'WINUSDT', 'BTTUSDT',
            'DENTUSDT', 'NPXSUSDT', 'STMXUSDT', 'WRXUSDT', 'EPSUSDT', 'TFUELUSDT',
            'XEMUSDT', 'CVCUSDT', 'ANKRUSDT', 'MTLUSDT', 'ONGUSDT', 'REEFUSDT',
            'KEYUSDT', 'VTHOUSDT', 'JSTUSDT', 'FUNUSDT', 'MBLUSDT', 'HNTUSDT',
            'DREPUSDT', 'SCUSDT', 'BTCSTUSDT', 'SRMUSDT', 'SUNUSDT', 'IOSTUSDT',
            'COTIUSDT', 'LUNAUSDT', 'CTKUSDT', 'ALPHAUSDT', 'BELUSDT', 'BTSUSDT',
            'CELRUSDT', 'FLMUSDT', 'CHRУСDT', 'SUPERUSDT', 'SFPUSDT', 'FETUSDT',
            'DIAUSDT', 'XMRUSDT', 'OGNUSDT', 'MFTUSDT', 'CKBUSDT', 'DOCKUSDT',
            'ROSEUSDT', 'RSRUSDT', 'ALICEUSDT', 'OXTUSDT', 'FTTUSDT', 'PNTUSDT',
            'NANOUSDT', 'ORNUSDT', 'VITEUSDT', 'LSKUSDT', 'LINAUSDT', 'AUDUSDT',
            'ANTUSDT', 'ARPAUSDT', 'YFIIUSDT', 'AKROUSDT', 'LITUSDT', 'BLZUSDT',
            'DODOUSDT', 'TOMOUSDT', 'PONDUSDT', 'HIVEUSDT', 'NKNUSDT', 'AUTOUSDT',
            'RAMPUSDT', 'TUSDUSDT', 'GTOUSDT', 'FIOUSDT', 'IOTXUSDT', 'COSUSDT',
            'DEGOUSDT', 'PERPUSDT', 'AIONUSDT', 'DNTUSDT', 'PERLUSDT', 'STPTUSDT',
            'PAXUSDT', 'TWTUSDT', 'HARDUSDT', 'REPUSDT', 'TROYUSDT', 'UMAUSDT',
            'WTCUSDT', 'CTSIUSDT', 'CFXUSDT', 'DATAUSDT', 'LTOUSDT', 'WINGUSDT',
            'BZRXUSDT', 'WANUSDT', 'UTKUSDT', 'OMUSDT', 'FISUSDT', 'UNFIUSDT',
            'MDTUSDT', 'KMDUSDT', 'NBSUSDT', 'RLCUSDT', 'NULSUSDT', 'TCTUSDT',
            'AVAUSDT', 'BADGERUSDT', 'STRAXUSDT', 'BNTUSDT', 'BEAMUSDT', 'TRUUSDT',
            'COCOSUSDT', 'IRISUSDT', 'STXUSDT', 'DUSKUSDT', 'PSGUSDT', 'WNXMUSDT',
            'ARDRUSDT', 'FIROUSDT', 'PAXGUSDT', 'ACMUSDT', 'OGUSDT', 'DCRUSDT',
            'CTXCUSDT', 'NMRUSDT', 'ASRUSDT', 'RIFUSDT', 'JUVUSDT', 'ATMUSDT',
            'SUSDUSDT', 'BUSDUSDT', 'USDCUSDT', 'EURUSDT', 'GBPUSDT'
        ];
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
     * Prevents hitting Binance's rate limits
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

            // Binance uses standard interval format (1m, 5m, 15m, 30m, 1h, 4h, 1d)
            const binanceInterval = this._convertIntervalToBinance(interval);

            // Binance endpoint: GET /api/v3/klines
            const path = `/api/v3/klines?symbol=${pair}&interval=${binanceInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching Binance candles', { pair, interval, limit });

            // Klines endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Binance response to standard format
            const candles = this._transformCandles(data);

            logger.info('Binance candles fetched successfully', {
                pair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch Binance candles', {
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

            // Binance endpoint: GET /api/v3/ticker/price
            const path = `/api/v3/ticker/price?symbol=${pair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching Binance current price', { pair });

            // Ticker endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Binance ticker format: { symbol: "BTCUSDT", price: "96234.50" }
            const currentPrice = parseFloat(data.price);

            logger.debug('Binance current price fetched', { pair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch Binance current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to Binance
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
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const path = `/api/v3/account?${queryString}&signature=${signature}`;
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            logger.info('Binance connection test successful', {
                accountType: data.accountType,
                canTrade: data.canTrade
            });

            return true;

        } catch (error) {
            logger.error('Binance connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert standard interval format to Binance interval
     * @private
     */
    _convertIntervalToBinance(interval) {
        // Binance uses: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M
        // Our standard format matches Binance, so just return as-is
        return interval;
    }

    /**
     * Transform Binance candle response to standard format
     * @private
     */
    _transformCandles(binanceCandles) {
        if (!Array.isArray(binanceCandles)) {
            return [];
        }

        // Binance kline format: [
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
        //     "17928899.62484339" // 11: Ignore
        //   ]
        // ]

        return binanceCandles.map(candle => ({
            timestamp: candle[0], // Open time in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        }));
    }

    /**
     * Get available USDT trading pairs on Binance
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = BinanceMarketDataService;
