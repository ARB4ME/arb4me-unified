// OKX Market Data Service
// Fetches candle data and current prices from OKX API for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class OKXMarketDataService {
    constructor() {
        this.baseUrl = 'https://www.okx.com';

        // Rate limiting: OKX has generous rate limits
        // Public: 20 requests per 2 seconds per IP
        // Private: 60 requests per 2 seconds
        this.minRequestInterval = 100; // milliseconds
        this.lastRequestTime = 0;

        // OKX-specific: Comprehensive USDT pairs list
        // Major cryptocurrencies, DeFi tokens, Layer 1/2, meme coins
        this.supportedPairs = [
            // Top Layer 1 blockchains
            'BTC-USDT', 'ETH-USDT', 'OKB-USDT', 'SOL-USDT', 'XRP-USDT', 'BNB-USDT',
            'ADA-USDT', 'AVAX-USDT', 'DOT-USDT', 'MATIC-USDT', 'ATOM-USDT', 'NEAR-USDT',
            'APT-USDT', 'SUI-USDT', 'SEI-USDT', 'TON-USDT', 'TRX-USDT', 'ALGO-USDT',
            'FTM-USDT', 'ICP-USDT', 'VET-USDT', 'HBAR-USDT', 'EGLD-USDT', 'XTZ-USDT',
            'EOS-USDT', 'THETA-USDT', 'FLOW-USDT', 'KAS-USDT', 'INJ-USDT', 'TIA-USDT',
            'KAVA-USDT', 'WAVES-USDT', 'ZIL-USDT', 'QTUM-USDT', 'ICX-USDT', 'ONT-USDT',

            // Layer 2 solutions
            'ARB-USDT', 'OP-USDT', 'IMX-USDT', 'LRC-USDT', 'ZK-USDT', 'STRK-USDT',
            'METIS-USDT', 'MANTA-USDT', 'BLAST-USDT', 'MODE-USDT',

            // Major DeFi tokens
            'AAVE-USDT', 'UNI-USDT', 'LINK-USDT', 'MKR-USDT', 'SNX-USDT', 'CRV-USDT',
            'COMP-USDT', 'SUSHI-USDT', '1INCH-USDT', 'LDO-USDT', 'PENDLE-USDT',
            'RUNE-USDT', 'BAL-USDT', 'YFI-USDT', 'ENS-USDT', 'GRT-USDT', 'DYDX-USDT',
            'JUP-USDT', 'ORCA-USDT', 'RAY-USDT', 'CAKE-USDT', 'GMX-USDT', 'RDNT-USDT',
            'ENA-USDT', 'ETHFI-USDT', 'EIGEN-USDT', 'RSR-USDT', 'ZRX-USDT', 'KNC-USDT',

            // Stablecoins and wrapped assets
            'USDC-USDT', 'DAI-USDT', 'TUSD-USDT', 'FDUSD-USDT', 'PYUSD-USDT',
            'WBTC-USDT', 'STETH-USDT',

            // Popular altcoins
            'LTC-USDT', 'BCH-USDT', 'ETC-USDT', 'XLM-USDT', 'FIL-USDT', 'XMR-USDT',
            'BSV-USDT', 'DASH-USDT', 'ZEC-USDT', 'MINA-USDT', 'RVN-USDT', 'DGB-USDT',
            'NEO-USDT', 'IOTA-USDT', 'ZEN-USDT', 'LSK-USDT', 'SC-USDT', 'DCR-USDT',

            // Meme coins
            'DOGE-USDT', 'SHIB-USDT', 'PEPE-USDT', 'FLOKI-USDT', 'BONK-USDT',
            'WIF-USDT', 'MEME-USDT', 'TRUMP-USDT', 'PNUT-USDT', 'NEIRO-USDT',
            'POPCAT-USDT', 'MEW-USDT', 'GOAT-USDT', 'MOODENG-USDT', 'TURBO-USDT',

            // AI & Data tokens
            'FET-USDT', 'RENDER-USDT', 'AGIX-USDT', 'OCEAN-USDT', 'AI16Z-USDT',
            'ARKM-USDT', 'WLD-USDT', 'GRT-USDT', 'AIOZ-USDT', 'VIRTUAL-USDT',
            'AIXBT-USDT', 'GRASS-USDT', 'IO-USDT', 'TAO-USDT', 'RNDR-USDT',

            // Gaming & Metaverse
            'AXS-USDT', 'SAND-USDT', 'MANA-USDT', 'ENJ-USDT', 'GALA-USDT', 'CHZ-USDT',
            'ILV-USDT', 'IMX-USDT', 'BLUR-USDT', 'APE-USDT', 'MAGIC-USDT', 'SUPER-USDT',
            'VOXEL-USDT', 'SLP-USDT', 'TLM-USDT', 'ALICE-USDT', 'PYR-USDT', 'NAKA-USDT',
            'PIXEL-USDT', 'PORTAL-USDT', 'XAI-USDT', 'PRIME-USDT', 'BIGTIME-USDT',

            // Exchange tokens
            'OKB-USDT', 'BNB-USDT', 'GT-USDT', 'HT-USDT', 'KCS-USDT', 'LEO-USDT',

            // Privacy coins
            'XMR-USDT', 'ZEC-USDT', 'SCRT-USDT', 'ROSE-USDT', 'ZEN-USDT',

            // RWA & Infrastructure
            'ONDO-USDT', 'MKR-USDT', 'JASMY-USDT', 'HBAR-USDT', 'GRT-USDT', 'RENDER-USDT',
            'AR-USDT', 'FIL-USDT', 'STORJ-USDT', 'ANKR-USDT', 'POKT-USDT',

            // Other notable tokens
            'CHZ-USDT', 'BAT-USDT', 'ZRX-USDT', 'OMG-USDT', 'CELR-USDT', 'SKL-USDT',
            'AUDIO-USDT', 'BAND-USDT', 'COTI-USDT', 'RSR-USDT', 'DENT-USDT', 'HOT-USDT',
            'SXP-USDT', 'WIN-USDT', 'BTT-USDT', 'ONE-USDT', 'STMX-USDT', 'TFUEL-USDT',
            'REEF-USDT', 'KEY-USDT', 'JST-USDT', 'FUN-USDT', 'MBL-USDT', 'HNT-USDT',
            'SRM-USDT', 'SUN-USDT', 'CTK-USDT', 'ALPHA-USDT', 'BEL-USDT', 'FLM-USDT',
            'SUPER-USDT', 'SFP-USDT', 'DIA-USDT', 'OGN-USDT', 'CKB-USDT', 'DOCK-USDT',
            'ALICE-USDT', 'OXT-USDT', 'PNT-USDT', 'NANO-USDT', 'ORN-USDT', 'VITE-USDT',
            'LINA-USDT', 'AUD-USDT', 'ARPA-USDT', 'YFII-USDT', 'AKRO-USDT', 'LIT-USDT',
            'BLZ-USDT', 'DODO-USDT', 'TOMO-USDT', 'POND-USDT', 'NKN-USDT', 'AUTO-USDT',
            'RAMP-USDT', 'GTO-USDT', 'FIO-USDT', 'IOTX-USDT', 'COS-USDT', 'DEGO-USDT',
            'PERP-USDT', 'AION-USDT', 'DNT-USDT', 'PERL-USDT', 'STPT-USDT', 'PAX-USDT',
            'TWT-USDT', 'HARD-USDT', 'REP-USDT', 'TROY-USDT', 'UMA-USDT', 'WTC-USDT',
            'CTSI-USDT', 'CFX-USDT', 'DATA-USDT', 'LTO-USDT', 'WING-USDT', 'BZRX-USDT',
            'WAN-USDT', 'UTK-USDT', 'OM-USDT', 'FIS-USDT', 'UNFI-USDT', 'MDT-USDT',
            'KMD-USDT', 'NBS-USDT', 'RLC-USDT', 'NULS-USDT', 'TCT-USDT', 'AVA-USDT',
            'BADGER-USDT', 'STRAX-USDT', 'BNT-USDT', 'BEAM-USDT', 'TRU-USDT', 'COCOS-USDT',
            'IRIS-USDT', 'STX-USDT', 'DUSK-USDT', 'PSG-USDT', 'WNXM-USDT', 'ARDR-USDT',
            'FIRO-USDT', 'PAXG-USDT', 'ACM-USDT', 'OG-USDT', 'DCR-USDT', 'CTXC-USDT',
            'NMR-USDT', 'ASR-USDT', 'RIF-USDT', 'JUV-USDT', 'ATM-USDT', 'SUSD-USDT'
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
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<Array>} Array of candles [{open, high, low, close, volume, timestamp}]
     */
    async fetchCandles(pair, interval = '1h', limit = 100, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert pair to OKX format (BTCUSDT → BTC-USDT)
            const okxPair = this._convertPairToOKX(pair);

            // Convert interval to OKX format
            const okxInterval = this._convertIntervalToOKX(interval);

            // OKX endpoint: GET /api/v5/market/candles
            const path = `/api/v5/market/candles?instId=${okxPair}&bar=${okxInterval}&limit=${limit}`;
            const url = `${this.baseUrl}${path}`;

            logger.info('Fetching OKX candles', { pair: okxPair, interval, limit });

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
                throw new Error(`OKX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for API error in response
            if (result.code !== '0') {
                throw new Error(`OKX API error: ${result.code} - ${result.msg}`);
            }

            // Transform OKX response to standard format
            const candles = this._transformCandles(result.data);

            logger.info('OKX candles fetched successfully', {
                pair: okxPair,
                candlesCount: candles.length,
                firstCandle: candles[0]?.timestamp,
                lastCandle: candles[candles.length - 1]?.timestamp
            });

            return candles;

        } catch (error) {
            logger.error('Failed to fetch OKX candles', {
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

            // Convert pair to OKX format (BTCUSDT → BTC-USDT)
            const okxPair = this._convertPairToOKX(pair);

            // OKX endpoint: GET /api/v5/market/ticker
            const path = `/api/v5/market/ticker?instId=${okxPair}`;
            const url = `${this.baseUrl}${path}`;

            logger.debug('Fetching OKX current price', { pair: okxPair });

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
                throw new Error(`OKX API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for API error in response
            if (result.code !== '0') {
                throw new Error(`OKX API error: ${result.code} - ${result.msg}`);
            }

            // OKX ticker format: { code: "0", data: [{ last: "96234.50" }] }
            const currentPrice = parseFloat(result.data[0]?.last || 0);

            logger.debug('OKX current price fetched', { pair: okxPair, price: currentPrice });

            return currentPrice;

        } catch (error) {
            logger.error('Failed to fetch OKX current price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Test API connection to OKX
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<boolean>} True if connection successful
     */
    async testConnection(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Test private balance endpoint
            const timestamp = new Date().toISOString();
            const method = 'GET';
            const requestPath = '/api/v5/account/balance';
            const body = '';

            const authHeaders = this._createOKXAuth(
                credentials.apiKey,
                credentials.apiSecret,
                credentials.passphrase,
                timestamp,
                method,
                requestPath,
                body
            );

            const url = `${this.baseUrl}${requestPath}`;

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...authHeaders
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX connection test failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for API error in response
            if (result.code !== '0') {
                throw new Error(`OKX connection test failed: ${result.code} - ${result.msg}`);
            }

            logger.info('OKX connection test successful', {
                accountsCount: result.data?.length
            });

            return true;

        } catch (error) {
            logger.error('OKX connection test failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create OKX authentication headers
     * OKX requires passphrase in addition to API key and secret
     * Uses HMAC-SHA256 signature with base64 encoding
     * @private
     */
    _createOKXAuth(apiKey, apiSecret, passphrase, timestamp, method, requestPath, body = '') {
        // OKX signature: HMAC-SHA256 of signing string, base64 encoded
        // Signing string format: timestamp + method + requestPath + body
        const signingString = timestamp + method + requestPath + body;
        const signature = crypto.createHmac('sha256', apiSecret).update(signingString).digest('base64');

        return {
            'OK-ACCESS-KEY': apiKey,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': passphrase
        };
    }

    /**
     * Convert standard interval format to OKX bar format
     * @private
     */
    _convertIntervalToOKX(interval) {
        // OKX uses: 1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 6H, 12H, 1D, 1W, 1M
        const intervalMap = {
            '1m': '1m',
            '3m': '3m',
            '5m': '5m',
            '15m': '15m',
            '30m': '30m',
            '1h': '1H',
            '2h': '2H',
            '4h': '4H',
            '6h': '6H',
            '12h': '12H',
            '1d': '1D',
            '1w': '1W',
            '1M': '1M'
        };

        return intervalMap[interval] || '1H'; // Default to 1 hour
    }

    /**
     * Convert pair to OKX format (BTCUSDT → BTC-USDT)
     * OKX uses hyphen separator
     * @private
     */
    _convertPairToOKX(pair) {
        // Convert BTCUSDT to BTC-USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}-${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Transform OKX candle response to standard format
     * @private
     */
    _transformCandles(okxCandles) {
        if (!Array.isArray(okxCandles)) {
            return [];
        }

        // OKX candlestick format: [
        //   [
        //     "1597026383085",  // 0: Open time (timestamp in milliseconds)
        //     "3.721",          // 1: Open price
        //     "3.743",          // 2: High price
        //     "3.677",          // 3: Low price
        //     "3.708",          // 4: Close price
        //     "8422410",        // 5: Trading volume (base currency)
        //     "22698348.04828491",  // 6: Trading volume (quote currency)
        //     "22698348.04828491",  // 7: Quote currency volume
        //     "1"               // 8: Confirm (0: incomplete, 1: complete)
        //   ]
        // ]

        return okxCandles.map(candle => ({
            timestamp: parseInt(candle[0]), // Timestamp in milliseconds
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5])
        })).reverse(); // OKX returns newest first, we want oldest first
    }

    /**
     * Get available USDT trading pairs on OKX
     * @returns {Array} Array of supported USDT pairs
     */
    getAvailablePairs() {
        return this.supportedPairs;
    }
}

module.exports = OKXMarketDataService;
