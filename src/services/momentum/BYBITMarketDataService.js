// BYBIT Market Data Service
// Fetches candle data and current prices from BYBIT API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class BYBITMarketDataService {
    constructor() {
        this.baseUrl = 'https://api.bybit.com';

        // Rate limiting: BYBIT has generous rate limits
        // Public: 50 requests per second
        // Private: 10 requests per second
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // BYBIT-specific: Supported USDT pairs (400+ pairs available)
        // Including major coins, DeFi, meme coins, and trending tokens
        this.supportedPairs = [
            // Major cryptocurrencies
            'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT',
            'DOTUSDT', 'LINKUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT', 'UNIUSDT', 'TRXUSDT',
            'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'TONUSDT', 'INJUSDT',

            // DeFi tokens
            'AAVEUSDT', 'CRVUSDT', 'SNXUSDT', 'LDOUSDT', 'PENDLEUSDT', 'ENAUSDT', 'EIGUSDT',
            'JUPUSDT', 'DYDXUSDT', 'GMXUSDT', 'COMPUSDT', 'YFIUSDT', 'CAKEUSDT', 'SUSHIUSDT',

            // Layer 1/2 solutions
            'SEIUSDT', 'TIAUSDT', 'ZKUSDT', 'LINEAUSDT', 'MOVEUSDT', 'BERAУСDT', 'SONICUSDT',
            'STRAUSDT', 'TAIKOUSDT', 'BLASTUSDT', 'ZROUSDT', 'POLUSDT', 'FTMUSDT',

            // Meme coins & trending
            'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'BOMEUSDT',
            'TRUMPUSDT', 'PNUTUSDT', 'GOATUSDT', 'ACTUSDT', 'MEMECUSDT', 'PUMPUSDT', 'MEWUSDT',
            'POPCATUSDT', 'BANUSDT', 'CHILLGUYUSDT', 'MOGUSDT', 'PONKEUSDT', 'MYROQUSDT',

            // AI & Gaming
            'AI16ZUSDT', 'VIRTUALUSDT', 'RENDERUSDT', 'FETUSDT', 'TAOUST', 'AGIXUSDT',
            'ARKMUSDT', 'AIXBTUSDT', 'GRASSUSDT', 'IOUST', 'GRTUSDT', 'AXSUSDT', 'GALAUSDT',
            'SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'IMXUSDT', 'RNDRUSDT', 'BEAMUSDT', 'BLZUSDT',

            // Staking & Liquid Staking
            'ENSOUSDT', 'STETHUSDT', 'BBSOLUSDT', 'ETHFIUSDT', 'SSVUSDT', 'RPLUSDT',

            // NFT & Metaverse
            'BLUSUSDT', 'MAGICUSDT', 'APEUSDT', 'SUPERUSDT', 'FLOWUSDT', 'CHZUSDT',

            // Stablecoins & Wrapped
            'USDCUSDT', 'DAIUSDT', 'TUSDUSDT', 'USDЕUSDT', 'PYUSDUSDT', 'XAUTUSDT',

            // Exchange tokens
            'CAKEUS
DT', 'WOOUSDT', 'KCSUSDT', 'HTXUSDT', 'MXUSDT', 'FTTUSDT',

            // Additional popular pairs (sample from the 400+ available)
            'XLMUSDT', 'ALGOUSDT', 'XTZUSDT', 'EOSUSDT', 'VETUSDT', 'HBARUSDT', 'ICPUSDT',
            'FILUSDT', 'ETCUSDT', 'KASUSDT', 'THETAUSDT', 'BATUSDT', 'ZECUSDT', 'DASHUSDT',
            'ZENUSDT', 'ONDOUSDT', 'WLDUSDT', 'ORDIUSDT', 'HYPEUSDT', 'RECALLUSDT',
            'ASTERUSDT', 'BRETTUSDT', 'MNTUSDT', 'METUSDT', 'COMMONUSDT', 'ZBТUSDT',
            'APEXUSDT', 'PENGUUSDT', 'ZORAUSDT', 'YBUSDT', 'AVNTUSDT', 'WLFIUSDT',
            'SPXUSDT', 'FFUSDT', 'IPUSDT', 'FLOCKUSDT', 'AEROUSDT', 'XANUSDT',
            'ZBTUSDT', 'MEUSDT', 'DRIFTUSDT', 'PROVEUSDT', 'MОCAUSDT', 'ATHUSDT',
            'VANAUSDT', 'USD1USDT', 'SOMIUSDT', 'FUSDT', 'NXPCUSDT', 'TELUSDT',
            'ALCHUSDT', 'SPECUSDT', 'SOSOUSDT', '2ZUSDT', 'WALUSDT', 'BMTUSDT',
            'OLUSDT', 'TOSHIUSDT', 'ORDERUSDT', 'MERLUSDT', 'SAROSUSDT', 'MORPHOUSDT',
            'TAUSDT', 'TWTUSDT', 'CPOOLUSDT', 'SUSDT', 'PUFFERUSDT', 'ZEREBROQUSDT',
            'ZKСUSDT', 'FUELUSDT', 'EPTUSDT', 'SYNDUSDT', 'ESUSDT', 'SUNDOGUSDT',
            'JTOUSDT', 'AVLUSDT', 'DEEPUSDT', 'WUSDT', 'HOLOUSDT', 'PLUMEUSDT',
            'HFTUSDT', 'WCTUSDT', 'ZKJUSDT', 'VELOUSDT', 'CAMPUSDT', 'ARUSDT',
            'XTERUSDT', 'CORNUSDT', 'FLRUSDT', 'HMSTRUSDT', 'NOMUSDT', 'SOLV
USDT',
            'TURBOSUSDT', 'STXUSDT', 'XDCUSDT', 'TACUSDT', 'PYTHUSDT', 'CARVUSDT',
            'ZETAUSDT', 'AGLDUSDT', 'SIGNUSDT', 'FLUIDUSDT', 'SAFEUSDT', 'GAMEUSDT',
            'CMETHUSDT', 'PORT3USDT', 'CATIUSDT', 'OMUSDT', 'KAIAUSDT', 'TAIUSDT',
            'ERAUSDT', 'ANIMEUSDT', 'DEGENUSDT', 'BARDUSDT', 'SPKUSDT', 'SQDUSDT',
            'SAHARAUSDT', 'LAUSDT', 'CLOUDUSDT', 'KUSDT', 'NOTUSDT', 'PORTALUSDT',
            'VENOMUSDT', 'SKYUSDT', 'AUSDT', 'WAVESUSDT', 'CELOUSDT', 'AXLUSDT',
            'PARTIUSDT', 'INITUSDT', 'PRCLUSDT', 'AEVOUSDT', 'HYPERUSDT', 'ALTUSDT',
            'DOODUSDT', 'HUMAUSDT', 'TOWNSUSDT', 'EGLDUSDT', 'USDTBUSDT', 'RLUSDUSDT',
            'TREEUSDT', 'QNTUSDT', 'ZRCUSDT', 'DOGSUSDT', 'ICNTUSDT', 'TSLAXUSDT',
            'OBOLUSDT', 'METHUSDT', 'FLIPUSDT', 'BELUSDT', 'MYRIAUSDT', '1INCHUSDT',
            'RUNEUSDT', 'SDUSDT', 'AMIUSDT', 'COOKIEUSDT', 'WEMIXUSDT', 'HAEDALUSDT',
            'ELXUSDT', 'HOMEUSDT', 'TNSRUSDT', 'GMTUSDT', 'PUMPBTCUSDT', 'C98USDT',
            'TUNAUSDT', 'NEIROCTOUSDT', 'SVLUSDT', 'CRCLXUSDT', 'ROAMUSDT', 'SWELLUSDT',
            'MINAUSDT', 'NEXOUSDT', 'CUDISUSDT', 'BBUSDT', 'COOKUSDT', 'MAJORUSDT',
            'ZIGUSDT', 'BOBAUSDT', 'RESOLVUSDT', 'L3USDT', 'PAALUSDT', 'AGIUSDT',
            'XUSDUSDT', 'GLMRUSDT', 'BDXNUSDT', 'AIOZUSDT', 'FHEUSDT', 'CSPRUSDT',
            'ZEXUSDT', 'ZENTUSDT', 'CFGUSDT', 'DOLOUSDT', 'INSPUSDT', 'MANTAUSDT',
            'SUPRAUSDT', 'SXTUSDT', 'VVVUSDT', 'AOUSDT', 'FOXYUSDT', 'SHARDSUSDT',
            'OASUSDT', 'BTTUSDT', 'PELLUSDT', 'B3USDT', 'AURORAUSDT', 'GPSUSDT',
            'ODOSUSDT', 'HOOKUSDT', 'COINXUSDT', 'SQTUSDT', 'AFCUSDT', 'JUSDT',
            'HPOS10IUSDT', 'UXLINKUSDT', 'MASAUSDT', 'FIDAUSDT', 'DMAILUSDT',
            'COREUSDT', 'USTCUSDT', 'SHRAPUSDT', 'KAVAUSDT', 'MODEUSDT', 'XUSDT',
            'LUNAIUSDT', 'WAXPUSDT', 'CATUSDT', 'ZILUSDT', 'NEONUSDT', 'SCRUSDT',
            'BABYDOGEUSDT', 'CYBERUSDT', 'GALFTUSDT', 'REDUSDT', 'MBOXUSDT', 'NYMUSDT',
            'PEOPLEUSDT', 'STOPUSDT', 'DYMUSDT', 'ROOTUSDT', 'NAVXUSDT', 'SATSUSDT'
            // Note: BYBIT supports 400+ USDT pairs total
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

            // BYBIT uses different interval format
            const bybitInterval = this._convertIntervalToBYBIT(interval);

            // BYBIT endpoint: GET /v5/market/kline
            const path = `/v5/market/kline?category=spot&symbol=${pair}&interval=${bybitInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching BYBIT candles', { pair, interval, limit });

            // Kline endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BYBIT API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for BYBIT API errors
            if (data.retCode !== 0) {
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            // Transform BYBIT response to standard format
            const candles = this._transformCandles(data.result.list);

            logger.info('BYBIT candles fetched successfully', {
                pair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch BYBIT candles', {
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

            // BYBIT endpoint: GET /v5/market/tickers
            const path = `/v5/market/tickers?category=spot&symbol=${pair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching BYBIT current price', { pair });

            // Ticker endpoint is public, no authentication needed
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BYBIT API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for BYBIT API errors
            if (data.retCode !== 0) {
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            // BYBIT ticker format: { result: { list: [{ lastPrice: "96234.50" }] } }
            const currentPrice = parseFloat(data.result.list[0].lastPrice);

            logger.debug('BYBIT current price fetched', { pair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch BYBIT current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to BYBIT
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private balance endpoint
            const timestamp = Date.now().toString();
            const params = '5000'; // recv_window parameter
            const authHeaders = this._createBYBITAuth(credentials.apiKey, credentials.apiSecret, timestamp, params);

            const path = '/v5/account/wallet-balance?accountType=UNIFIED';
            const url = `${this.baseUrl}${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                    'X-BAPI-RECV-WINDOW': params
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BYBIT connection test failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for BYBIT API errors
            if (data.retCode !== 0) {
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            logger.info('BYBIT connection test successful', {
                accountType: 'UNIFIED'
            });

            return true;

        } catch (error) {
            logger.error('BYBIT connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create BYBIT authentication headers
     * Uses HMAC-SHA256 signature
     * @private
     */
    _createBYBITAuth(apiKey, apiSecret, timestamp, params) {
        // BYBIT signature: HMAC-SHA256 of (timestamp + apiKey + recv_window + params)
        const paramString = timestamp + apiKey + params;
        const signature = crypto.createHmac('sha256', apiSecret).update(paramString).digest('hex');

        return {
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-SIGN': signature,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-SIGN-TYPE': '2'
        };
    }

    /**
     * Convert standard interval format to BYBIT interval
     * @private
     */
    _convertIntervalToBYBIT(interval) {
        // BYBIT uses: 1, 3, 5, 15, 30, 60, 120, 240, 360, 720, D, W, M
        const intervalMap = {
            '1m': '1',
            '3m': '3',
            '5m': '5',
            '15m': '15',
            '30m': '30',
            '1h': '60',
            '2h': '120',
            '4h': '240',
            '6h': '360',
            '12h': '720',
            '1d': 'D',
            '1w': 'W',
            '1M': 'M'
        };

        return intervalMap[interval] || '60'; // Default to 1 hour
    }

    /**
     * Transform BYBIT candle response to standard format
     * @private
     */
    _transformCandles(bybitCandles) {
        if (!Array.isArray(bybitCandles)) {
            return [];
        }

        // BYBIT kline format: [
        //   [
        //     "1670601600000",  // 0: Start time (ms)
        //     "16493.50",       // 1: Open
        //     "16520.00",       // 2: High
        //     "16490.00",       // 3: Low
        //     "16504.00",       // 4: Close
        //     "2.45",           // 5: Volume
        //     "40000"           // 6: Turnover
        //   ]
        // ]

        return bybitCandles.map(candle => ({
            timestamp: parseInt(candle[0]), // Start time in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        })).reverse(); // BYBIT returns newest first, we want oldest first
    }

    /**
     * Get available USDT trading pairs on BYBIT
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = BYBITMarketDataService;
