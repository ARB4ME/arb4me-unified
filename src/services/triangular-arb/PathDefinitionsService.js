/**
 * Path Definitions Service
 * Centralized repository of all triangular arbitrage paths for all exchanges
 *
 * Each path defines:
 * - id: Unique identifier
 * - pairs: Trading pairs involved
 * - sequence: Human-readable description
 * - steps: Array of trading steps with pair and side (buy/sell)
 */

const { systemLogger } = require('../../utils/logger');

class PathDefinitionsService {
    constructor() {
        // Initialize path definitions for all exchanges
        this.paths = {
            valr: this._initializeVALRPaths(),
            luno: this._initializeLunoPaths(),
            kraken: this._initializeKrakenPaths(),
            // Other exchanges will be added as they're implemented
            chainex: this._initializeChainexPaths(),
            binance: this._initializeBinancePaths(),
            bybit: this._initializeBybitPaths(),
            okx: this._initializeOkxPaths(),
            kucoin: this._initializeKucoinPaths(),
            coinbase: this._initializeCoinbasePaths(),
            htx: this._initializeHtxPaths(),
            gateio: this._initializeGateioPaths(),
            cryptocom: this._initializeCryptocomPaths(),
            mexc: this._initializeMexcPaths(),
            xt: this._initializeXtPaths(),
            ascendex: this._initializeAscendexPaths(),
            bingx: this._initializeBingxPaths(),
            bitget: this._initializeBitgetPaths(),
            bitmart: this._initializeBitmartPaths(),
            bitrue: this._initializeBitruePaths(),
            gemini: this._initializeGeminiPaths(),
            coincatch: this._initializeCoincatchPaths()
        };
    }

    /**
     * Get paths for a specific exchange
     * @param {string} exchange - Exchange name
     * @param {string|array} pathFilter - 'all' or specific path set numbers/names
     * @returns {Array} Filtered paths
     */
    getPathsForExchange(exchange, pathFilter = 'all') {
        const exchangeLower = exchange.toLowerCase();
        const allPaths = this.paths[exchangeLower];

        if (!allPaths) {
            systemLogger.warn(`No path definitions for exchange: ${exchange}`);
            return [];
        }

        // If requesting all paths, flatten all sets
        if (pathFilter === 'all' || !pathFilter) {
            return this._flattenPathSets(allPaths);
        }

        // If specific sets requested as array
        if (Array.isArray(pathFilter)) {
            return this._filterPathSets(allPaths, pathFilter);
        }

        // If specific single set requested as string (e.g. "SET_1_ETH_FOCUS")
        if (typeof pathFilter === 'string' && allPaths[pathFilter]) {
            return allPaths[pathFilter];
        }

        // Default: return all
        return this._flattenPathSets(allPaths);
    }

    /**
     * Get a specific path by ID
     * @param {string} exchange - Exchange name
     * @param {string} pathId - Path ID
     * @returns {object|null} Path definition or null
     */
    getPathById(exchange, pathId) {
        const allPaths = this.getPathsForExchange(exchange, 'all');
        return allPaths.find(path => path.id === pathId) || null;
    }

    /**
     * Get available path set names for an exchange
     * @param {string} exchange - Exchange name
     * @returns {Array} Path set names
     */
    getAvailablePathSets(exchange) {
        const exchangeLower = exchange.toLowerCase();
        const allPaths = this.paths[exchangeLower];

        if (!allPaths || typeof allPaths !== 'object') {
            return [];
        }

        return Object.keys(allPaths);
    }

    /**
     * Flatten path sets into single array
     * @private
     */
    _flattenPathSets(pathSets) {
        if (Array.isArray(pathSets)) {
            return pathSets;
        }

        const flattened = [];
        for (const setName in pathSets) {
            if (Array.isArray(pathSets[setName])) {
                flattened.push(...pathSets[setName]);
            }
        }
        return flattened;
    }

    /**
     * Filter specific path sets
     * @private
     */
    _filterPathSets(pathSets, setFilters) {
        const filtered = [];

        for (const filter of setFilters) {
            // If filter is a number, look for SET_X pattern
            const setKey = typeof filter === 'number'
                ? Object.keys(pathSets).find(key => key.startsWith(`SET_${filter}_`))
                : filter;

            if (setKey && pathSets[setKey]) {
                filtered.push(...pathSets[setKey]);
            }
        }

        return filtered;
    }

    /**
     * Initialize VALR paths (80+ paths across 20+ sets)
     * @private
     */
    _initializeVALRPaths() {
        return {
            SET_1_ETH_FOCUS: [
                { id: 'ZAR_ETH_USDT_ZAR', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], sequence: 'ZAR → ETH → USDT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'USDT_ETH_ZAR_USDT', pairs: ['ETHUSDT', 'ETHZAR', 'USDTZAR'], sequence: 'USDT → ETH → ZAR → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETHUSDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_2_XRP_FOCUS: [
                { id: 'ZAR_XRP_USDT_ZAR', pairs: ['XRPZAR', 'XRPUSDT', 'USDTZAR'], sequence: 'ZAR → XRP → USDT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'USDT_XRP_ZAR_USDT', pairs: ['XRPUSDT', 'XRPZAR', 'USDTZAR'], sequence: 'USDT → XRP → ZAR → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRPUSDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_3_SOL_FOCUS: [
                { id: 'ZAR_SOL_USDT_ZAR', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], sequence: 'ZAR → SOL → USDT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'USDT_SOL_ZAR_USDT', pairs: ['SOLUSDT', 'SOLZAR', 'USDTZAR'], sequence: 'USDT → SOL → ZAR → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SOL_USDT', pairs: ['USDTZAR', 'SOLZAR', 'SOLUSDT'], sequence: 'USDT → ZAR → SOL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] }
            ],
            SET_4_BNB_FOCUS: [
                { id: 'ZAR_BNB_USDT_ZAR', pairs: ['BNBZAR', 'BNBUSDT', 'USDTZAR'], sequence: 'ZAR → BNB → USDT → ZAR', steps: [{ pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BNB_ZAR', pairs: ['USDTZAR', 'BNBUSDT', 'BNBZAR'], sequence: 'ZAR → USDT → BNB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }] },
                { id: 'USDT_BNB_ZAR_USDT', pairs: ['BNBUSDT', 'BNBZAR', 'USDTZAR'], sequence: 'USDT → BNB → ZAR → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BNB_USDT', pairs: ['USDTZAR', 'BNBZAR', 'BNBUSDT'], sequence: 'USDT → ZAR → BNB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_5_SHIB_FOCUS: [
                { id: 'ZAR_SHIB_USDT_ZAR', pairs: ['SHIBZAR', 'SHIBUSDT', 'USDTZAR'], sequence: 'ZAR → SHIB → USDT → ZAR', steps: [{ pair: 'SHIBZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SHIB_ZAR', pairs: ['USDTZAR', 'SHIBUSDT', 'SHIBZAR'], sequence: 'ZAR → USDT → SHIB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBZAR', side: 'sell' }] },
                { id: 'USDT_SHIB_ZAR_USDT', pairs: ['SHIBUSDT', 'SHIBZAR', 'USDTZAR'], sequence: 'USDT → SHIB → ZAR → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SHIB_USDT', pairs: ['USDTZAR', 'SHIBZAR', 'SHIBUSDT'], sequence: 'USDT → ZAR → SHIB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SHIBZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'sell' }] }
            ],
            SET_6_AVAX_FOCUS: [
                { id: 'ZAR_AVAX_USDT_ZAR', pairs: ['AVAXZAR', 'AVAXUSDT', 'USDTZAR'], sequence: 'ZAR → AVAX → USDT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AVAX_ZAR', pairs: ['USDTZAR', 'AVAXUSDT', 'AVAXZAR'], sequence: 'ZAR → USDT → AVAX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'USDT_AVAX_ZAR_USDT', pairs: ['AVAXUSDT', 'AVAXZAR', 'USDTZAR'], sequence: 'USDT → AVAX → ZAR → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AVAX_USDT', pairs: ['USDTZAR', 'AVAXZAR', 'AVAXUSDT'], sequence: 'USDT → ZAR → AVAX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_7_DOGE_FOCUS: [
                { id: 'ZAR_DOGE_USDT_ZAR', pairs: ['DOGEZAR', 'DOGEUSDT', 'USDTZAR'], sequence: 'ZAR → DOGE → USDT → ZAR', steps: [{ pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DOGE_ZAR', pairs: ['USDTZAR', 'DOGEUSDT', 'DOGEZAR'], sequence: 'ZAR → USDT → DOGE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }] },
                { id: 'USDT_DOGE_ZAR_USDT', pairs: ['DOGEUSDT', 'DOGEZAR', 'USDTZAR'], sequence: 'USDT → DOGE → ZAR → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DOGE_USDT', pairs: ['USDTZAR', 'DOGEZAR', 'DOGEUSDT'], sequence: 'USDT → ZAR → DOGE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }] }
            ],
            SET_8_TRX_FOCUS: [
                { id: 'ZAR_TRX_USDT_ZAR', pairs: ['TRXZAR', 'TRXUSDT', 'USDTZAR'], sequence: 'ZAR → TRX → USDT → ZAR', steps: [{ pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_TRX_ZAR', pairs: ['USDTZAR', 'TRXUSDT', 'TRXZAR'], sequence: 'ZAR → USDT → TRX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }] },
                { id: 'USDT_TRX_ZAR_USDT', pairs: ['TRXUSDT', 'TRXZAR', 'USDTZAR'], sequence: 'USDT → TRX → ZAR → USDT', steps: [{ pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_TRX_USDT', pairs: ['USDTZAR', 'TRXZAR', 'TRXUSDT'], sequence: 'USDT → ZAR → TRX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'sell' }] }
            ],
            SET_9_LTC_FOCUS: [
                { id: 'ZAR_LTC_USDT_ZAR', pairs: ['LTCZAR', 'LTCUSDT', 'USDTZAR'], sequence: 'ZAR → LTC → USDT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LTC_ZAR', pairs: ['USDTZAR', 'LTCUSDT', 'LTCZAR'], sequence: 'ZAR → USDT → LTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'USDT_LTC_ZAR_USDT', pairs: ['LTCUSDT', 'LTCZAR', 'USDTZAR'], sequence: 'USDT → LTC → ZAR → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LTC_USDT', pairs: ['USDTZAR', 'LTCZAR', 'LTCUSDT'], sequence: 'USDT → ZAR → LTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            // SET_10_RLUSD_FOCUS removed - RLUSD pairs not supported on VALR (API returns 400 "Unsupported Currency Pair")
            SET_11_LINK_FOCUS: [
                { id: 'ZAR_LINK_USDT_ZAR', pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'], sequence: 'ZAR → LINK → USDT → ZAR', steps: [{ pair: 'LINKZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LINK_ZAR', pairs: ['USDTZAR', 'LINKUSDT', 'LINKZAR'], sequence: 'ZAR → USDT → LINK → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }] },
                { id: 'USDT_LINK_ZAR_USDT', pairs: ['LINKUSDT', 'LINKZAR', 'USDTZAR'], sequence: 'USDT → LINK → ZAR → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LINK_USDT', pairs: ['USDTZAR', 'LINKZAR', 'LINKUSDT'], sequence: 'USDT → ZAR → LINK → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LINKZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] }
            ],
            SET_12_XLM_FOCUS: [
                { id: 'ZAR_XLM_USDT_ZAR', pairs: ['XLMZAR', 'XLMUSDT', 'USDTZAR'], sequence: 'ZAR → XLM → USDT → ZAR', steps: [{ pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XLM_ZAR', pairs: ['USDTZAR', 'XLMUSDT', 'XLMZAR'], sequence: 'ZAR → USDT → XLM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }] },
                { id: 'USDT_XLM_ZAR_USDT', pairs: ['XLMUSDT', 'XLMZAR', 'USDTZAR'], sequence: 'USDT → XLM → ZAR → USDT', steps: [{ pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XLM_USDT', pairs: ['USDTZAR', 'XLMZAR', 'XLMUSDT'], sequence: 'USDT → ZAR → XLM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Luno paths (24 paths across 6 sets - matching VALR structure)
     * Simple 4-paths-per-set structure
     * Only ZAR and USDT focused (fundable currencies)
     * @private
     */
    _initializeLunoPaths() {
        return {
            SET_1_ETH_FOCUS: [
                { id: 'ZAR_XBT_ETH_ZAR', pairs: ['XBTZAR', 'ETHXBT', 'ETHZAR'], sequence: 'ZAR → XBT → ETH → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_ETH_XBT_ZAR', pairs: ['ETHZAR', 'ETHXBT', 'XBTZAR'], sequence: 'ZAR → ETH → XBT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'USDT_XBT_ETH_USDT', pairs: ['XBTUSDT', 'ETHXBT', 'ETHUSDT'], sequence: 'USDT → XBT → ETH → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_XBT_USDT', pairs: ['ETHUSDT', 'ETHXBT', 'XBTUSDT'], sequence: 'USDT → ETH → XBT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] }
            ],
            SET_2_SOL_FOCUS: [
                { id: 'ZAR_XBT_SOL_ZAR', pairs: ['XBTZAR', 'SOLXBT', 'SOLZAR'], sequence: 'ZAR → XBT → SOL → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'ZAR_SOL_XBT_ZAR', pairs: ['SOLZAR', 'SOLXBT', 'XBTZAR'], sequence: 'ZAR → SOL → XBT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'USDT_XBT_SOL_USDT', pairs: ['XBTUSDT', 'SOLXBT', 'SOLUSDT'], sequence: 'USDT → XBT → SOL → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_XBT_USDT', pairs: ['SOLUSDT', 'SOLXBT', 'XBTUSDT'], sequence: 'USDT → SOL → XBT → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] }
            ],
            SET_3_XRP_FOCUS: [
                { id: 'ZAR_XBT_XRP_ZAR', pairs: ['XBTZAR', 'XRPXBT', 'XRPZAR'], sequence: 'ZAR → XBT → XRP → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_XRP_XBT_ZAR', pairs: ['XRPZAR', 'XRPXBT', 'XBTZAR'], sequence: 'ZAR → XRP → XBT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'USDT_XBT_XRP_USDT', pairs: ['XBTUSDT', 'XRPXBT', 'XRPUSDT'], sequence: 'USDT → XBT → XRP → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_XBT_USDT', pairs: ['XRPUSDT', 'XRPXBT', 'XBTUSDT'], sequence: 'USDT → XRP → XBT → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] }
            ],
            SET_4_USDT_BRIDGE: [
                { id: 'ZAR_USDT_XBT_ZAR', pairs: ['USDTZAR', 'XBTUSDT', 'XBTZAR'], sequence: 'ZAR → USDT → XBT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] }
            ],
            SET_5_ALTCOINS_1: [
                { id: 'ZAR_XBT_ADA_ZAR', pairs: ['XBTZAR', 'ADAXBT', 'ADAZAR'], sequence: 'ZAR → XBT → ADA → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAZAR', side: 'sell' }] },
                { id: 'ZAR_ADA_XBT_ZAR', pairs: ['ADAZAR', 'ADAXBT', 'XBTZAR'], sequence: 'ZAR → ADA → XBT → ZAR', steps: [{ pair: 'ADAZAR', side: 'buy' }, { pair: 'ADAXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_DOT_ZAR', pairs: ['XBTZAR', 'DOTXBT', 'DOTZAR'], sequence: 'ZAR → XBT → DOT → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTZAR', side: 'sell' }] },
                { id: 'ZAR_DOT_XBT_ZAR', pairs: ['DOTZAR', 'DOTXBT', 'XBTZAR'], sequence: 'ZAR → DOT → XBT → ZAR', steps: [{ pair: 'DOTZAR', side: 'buy' }, { pair: 'DOTXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] }
            ],
            SET_6_ALTCOINS_2: [
                { id: 'ZAR_XBT_AVAX_ZAR', pairs: ['XBTZAR', 'AVAXXBT', 'AVAXZAR'], sequence: 'ZAR → XBT → AVAX → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'ZAR_AVAX_XBT_ZAR', pairs: ['AVAXZAR', 'AVAXXBT', 'XBTZAR'], sequence: 'ZAR → AVAX → XBT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_LTC_ZAR', pairs: ['XBTZAR', 'LTCXBT', 'LTCZAR'], sequence: 'ZAR → XBT → LTC → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'ZAR_LTC_XBT_ZAR', pairs: ['LTCZAR', 'LTCXBT', 'XBTZAR'], sequence: 'ZAR → LTC → XBT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Kraken paths (114 paths across 10 sets)
     * Comprehensive coverage with USD/USDT/USDC fundable currencies
     * BTC and ETH as bridge currencies
     * @private
     */
    _initializeKrakenPaths() {
        return {
            // SET 1: ETH Focus (6 paths) - BTC bridge only (ETH is target, so no ETH bridge)
            SET_1_ETH_FOCUS: [
                { id: 'USD_BTC_ETH_USD', pairs: ['XBTUSD', 'ETHXBT', 'ETHUSD'], sequence: 'USD → BTC → ETH → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USD_ETH_BTC_USD', pairs: ['ETHUSD', 'ETHXBT', 'XBTUSD'], sequence: 'USD → ETH → BTC → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_ETH_USDT', pairs: ['XBTUSDT', 'ETHXBT', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_BTC_USDT', pairs: ['ETHUSDT', 'ETHXBT', 'XBTUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_ETH_USDC', pairs: ['XBTUSDC', 'ETHXBT', 'ETHUSDC'], sequence: 'USDC → BTC → ETH → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDC', side: 'sell' }] },
                { id: 'USDC_ETH_BTC_USDC', pairs: ['ETHUSDC', 'ETHXBT', 'XBTUSDC'], sequence: 'USDC → ETH → BTC → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] }
            ],

            // SET 2: XRP Focus (12 paths) - BTC + ETH bridges
            SET_2_XRP_FOCUS: [
                // BTC Bridge (6 paths)
                { id: 'USD_BTC_XRP_USD', pairs: ['XBTUSD', 'XRPXBT', 'XRPUSD'], sequence: 'USD → BTC → XRP → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSD', side: 'sell' }] },
                { id: 'USD_XRP_BTC_USD', pairs: ['XRPUSD', 'XRPXBT', 'XBTUSD'], sequence: 'USD → XRP → BTC → USD', steps: [{ pair: 'XRPUSD', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_XRP_USDT', pairs: ['XBTUSDT', 'XRPXBT', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_BTC_USDT', pairs: ['XRPUSDT', 'XRPXBT', 'XBTUSDT'], sequence: 'USDT → XRP → BTC → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_XRP_USDC', pairs: ['XBTUSDC', 'XRPXBT', 'XRPUSDC'], sequence: 'USDC → BTC → XRP → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDC', side: 'sell' }] },
                { id: 'USDC_XRP_BTC_USDC', pairs: ['XRPUSDC', 'XRPXBT', 'XBTUSDC'], sequence: 'USDC → XRP → BTC → USDC', steps: [{ pair: 'XRPUSDC', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge (6 paths)
                { id: 'USD_ETH_XRP_USD', pairs: ['ETHUSD', 'XRPETH', 'XRPUSD'], sequence: 'USD → ETH → XRP → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSD', side: 'sell' }] },
                { id: 'USD_XRP_ETH_USD', pairs: ['XRPUSD', 'XRPETH', 'ETHUSD'], sequence: 'USD → XRP → ETH → USD', steps: [{ pair: 'XRPUSD', side: 'buy' }, { pair: 'XRPETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_XRP_USDT', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_ETH_USDT', pairs: ['XRPUSDT', 'XRPETH', 'ETHUSDT'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_XRP_USDC', pairs: ['ETHUSDC', 'XRPETH', 'XRPUSDC'], sequence: 'USDC → ETH → XRP → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDC', side: 'sell' }] },
                { id: 'USDC_XRP_ETH_USDC', pairs: ['XRPUSDC', 'XRPETH', 'ETHUSDC'], sequence: 'USDC → XRP → ETH → USDC', steps: [{ pair: 'XRPUSDC', side: 'buy' }, { pair: 'XRPETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 3: SOL Focus (12 paths) - BTC + ETH bridges
            SET_3_SOL_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_SOL_USD', pairs: ['XBTUSD', 'SOLXBT', 'SOLUSD'], sequence: 'USD → BTC → SOL → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSD', side: 'sell' }] },
                { id: 'USD_SOL_BTC_USD', pairs: ['SOLUSD', 'SOLXBT', 'XBTUSD'], sequence: 'USD → SOL → BTC → USD', steps: [{ pair: 'SOLUSD', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_SOL_USDT', pairs: ['XBTUSDT', 'SOLXBT', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_BTC_USDT', pairs: ['SOLUSDT', 'SOLXBT', 'XBTUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_SOL_USDC', pairs: ['XBTUSDC', 'SOLXBT', 'SOLUSDC'], sequence: 'USDC → BTC → SOL → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDC', side: 'sell' }] },
                { id: 'USDC_SOL_BTC_USDC', pairs: ['SOLUSDC', 'SOLXBT', 'XBTUSDC'], sequence: 'USDC → SOL → BTC → USDC', steps: [{ pair: 'SOLUSDC', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_SOL_USD', pairs: ['ETHUSD', 'SOLETH', 'SOLUSD'], sequence: 'USD → ETH → SOL → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSD', side: 'sell' }] },
                { id: 'USD_SOL_ETH_USD', pairs: ['SOLUSD', 'SOLETH', 'ETHUSD'], sequence: 'USD → SOL → ETH → USD', steps: [{ pair: 'SOLUSD', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_SOL_USDT', pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_ETH_USDT', pairs: ['SOLUSDT', 'SOLETH', 'ETHUSDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_SOL_USDC', pairs: ['ETHUSDC', 'SOLETH', 'SOLUSDC'], sequence: 'USDC → ETH → SOL → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDC', side: 'sell' }] },
                { id: 'USDC_SOL_ETH_USDC', pairs: ['SOLUSDC', 'SOLETH', 'ETHUSDC'], sequence: 'USDC → SOL → ETH → USDC', steps: [{ pair: 'SOLUSDC', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 4: ADA Focus (12 paths) - BTC + ETH bridges
            SET_4_ADA_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_ADA_USD', pairs: ['XBTUSD', 'ADAXBT', 'ADAUSD'], sequence: 'USD → BTC → ADA → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAUSD', side: 'sell' }] },
                { id: 'USD_ADA_BTC_USD', pairs: ['ADAUSD', 'ADAXBT', 'XBTUSD'], sequence: 'USD → ADA → BTC → USD', steps: [{ pair: 'ADAUSD', side: 'buy' }, { pair: 'ADAXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_ADA_USDT', pairs: ['XBTUSDT', 'ADAXBT', 'ADAUSDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_ADA_BTC_USDT', pairs: ['ADAUSDT', 'ADAXBT', 'XBTUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADAXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_ADA_USDC', pairs: ['XBTUSDC', 'ADAXBT', 'ADAUSDC'], sequence: 'USDC → BTC → ADA → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAUSDC', side: 'sell' }] },
                { id: 'USDC_ADA_BTC_USDC', pairs: ['ADAUSDC', 'ADAXBT', 'XBTUSDC'], sequence: 'USDC → ADA → BTC → USDC', steps: [{ pair: 'ADAUSDC', side: 'buy' }, { pair: 'ADAXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_ADA_USD', pairs: ['ETHUSD', 'ADAETH', 'ADAUSD'], sequence: 'USD → ETH → ADA → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSD', side: 'sell' }] },
                { id: 'USD_ADA_ETH_USD', pairs: ['ADAUSD', 'ADAETH', 'ETHUSD'], sequence: 'USD → ADA → ETH → USD', steps: [{ pair: 'ADAUSD', side: 'buy' }, { pair: 'ADAETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_ADA_USDT', pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_ADA_ETH_USDT', pairs: ['ADAUSDT', 'ADAETH', 'ETHUSDT'], sequence: 'USDT → ADA → ETH → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_ADA_USDC', pairs: ['ETHUSDC', 'ADAETH', 'ADAUSDC'], sequence: 'USDC → ETH → ADA → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDC', side: 'sell' }] },
                { id: 'USDC_ADA_ETH_USDC', pairs: ['ADAUSDC', 'ADAETH', 'ETHUSDC'], sequence: 'USDC → ADA → ETH → USDC', steps: [{ pair: 'ADAUSDC', side: 'buy' }, { pair: 'ADAETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 5: DOT Focus (12 paths) - BTC + ETH bridges
            SET_5_DOT_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_DOT_USD', pairs: ['XBTUSD', 'DOTXBT', 'DOTUSD'], sequence: 'USD → BTC → DOT → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTUSD', side: 'sell' }] },
                { id: 'USD_DOT_BTC_USD', pairs: ['DOTUSD', 'DOTXBT', 'XBTUSD'], sequence: 'USD → DOT → BTC → USD', steps: [{ pair: 'DOTUSD', side: 'buy' }, { pair: 'DOTXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_DOT_USDT', pairs: ['XBTUSDT', 'DOTXBT', 'DOTUSDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_DOT_BTC_USDT', pairs: ['DOTUSDT', 'DOTXBT', 'XBTUSDT'], sequence: 'USDT → DOT → BTC → USDT', steps: [{ pair: 'DOTUSDT', side: 'buy' }, { pair: 'DOTXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_DOT_USDC', pairs: ['XBTUSDC', 'DOTXBT', 'DOTUSDC'], sequence: 'USDC → BTC → DOT → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTUSDC', side: 'sell' }] },
                { id: 'USDC_DOT_BTC_USDC', pairs: ['DOTUSDC', 'DOTXBT', 'XBTUSDC'], sequence: 'USDC → DOT → BTC → USDC', steps: [{ pair: 'DOTUSDC', side: 'buy' }, { pair: 'DOTXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_DOT_USD', pairs: ['ETHUSD', 'DOTETH', 'DOTUSD'], sequence: 'USD → ETH → DOT → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSD', side: 'sell' }] },
                { id: 'USD_DOT_ETH_USD', pairs: ['DOTUSD', 'DOTETH', 'ETHUSD'], sequence: 'USD → DOT → ETH → USD', steps: [{ pair: 'DOTUSD', side: 'buy' }, { pair: 'DOTETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_DOT_USDT', pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_DOT_ETH_USDT', pairs: ['DOTUSDT', 'DOTETH', 'ETHUSDT'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'DOTUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_DOT_USDC', pairs: ['ETHUSDC', 'DOTETH', 'DOTUSDC'], sequence: 'USDC → ETH → DOT → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDC', side: 'sell' }] },
                { id: 'USDC_DOT_ETH_USDC', pairs: ['DOTUSDC', 'DOTETH', 'ETHUSDC'], sequence: 'USDC → DOT → ETH → USDC', steps: [{ pair: 'DOTUSDC', side: 'buy' }, { pair: 'DOTETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 6: MATIC Focus (12 paths) - BTC + ETH bridges
            SET_6_MATIC_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_MATIC_USD', pairs: ['XBTUSD', 'MATICXBT', 'MATICUSD'], sequence: 'USD → BTC → MATIC → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'MATICXBT', side: 'buy' }, { pair: 'MATICUSD', side: 'sell' }] },
                { id: 'USD_MATIC_BTC_USD', pairs: ['MATICUSD', 'MATICXBT', 'XBTUSD'], sequence: 'USD → MATIC → BTC → USD', steps: [{ pair: 'MATICUSD', side: 'buy' }, { pair: 'MATICXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_MATIC_USDT', pairs: ['XBTUSDT', 'MATICXBT', 'MATICUSDT'], sequence: 'USDT → BTC → MATIC → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'MATICXBT', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'USDT_MATIC_BTC_USDT', pairs: ['MATICUSDT', 'MATICXBT', 'XBTUSDT'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_MATIC_USDC', pairs: ['XBTUSDC', 'MATICXBT', 'MATICUSDC'], sequence: 'USDC → BTC → MATIC → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'MATICXBT', side: 'buy' }, { pair: 'MATICUSDC', side: 'sell' }] },
                { id: 'USDC_MATIC_BTC_USDC', pairs: ['MATICUSDC', 'MATICXBT', 'XBTUSDC'], sequence: 'USDC → MATIC → BTC → USDC', steps: [{ pair: 'MATICUSDC', side: 'buy' }, { pair: 'MATICXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_MATIC_USD', pairs: ['ETHUSD', 'MATICETH', 'MATICUSD'], sequence: 'USD → ETH → MATIC → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSD', side: 'sell' }] },
                { id: 'USD_MATIC_ETH_USD', pairs: ['MATICUSD', 'MATICETH', 'ETHUSD'], sequence: 'USD → MATIC → ETH → USD', steps: [{ pair: 'MATICUSD', side: 'buy' }, { pair: 'MATICETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_MATIC_USDT', pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'USDT_MATIC_ETH_USDT', pairs: ['MATICUSDT', 'MATICETH', 'ETHUSDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_MATIC_USDC', pairs: ['ETHUSDC', 'MATICETH', 'MATICUSDC'], sequence: 'USDC → ETH → MATIC → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSDC', side: 'sell' }] },
                { id: 'USDC_MATIC_ETH_USDC', pairs: ['MATICUSDC', 'MATICETH', 'ETHUSDC'], sequence: 'USDC → MATIC → ETH → USDC', steps: [{ pair: 'MATICUSDC', side: 'buy' }, { pair: 'MATICETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 7: LINK Focus (12 paths) - BTC + ETH bridges
            SET_7_LINK_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_LINK_USD', pairs: ['XBTUSD', 'LINKXBT', 'LINKUSD'], sequence: 'USD → BTC → LINK → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'LINKXBT', side: 'buy' }, { pair: 'LINKUSD', side: 'sell' }] },
                { id: 'USD_LINK_BTC_USD', pairs: ['LINKUSD', 'LINKXBT', 'XBTUSD'], sequence: 'USD → LINK → BTC → USD', steps: [{ pair: 'LINKUSD', side: 'buy' }, { pair: 'LINKXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_LINK_USDT', pairs: ['XBTUSDT', 'LINKXBT', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'LINKXBT', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'USDT_LINK_BTC_USDT', pairs: ['LINKUSDT', 'LINKXBT', 'XBTUSDT'], sequence: 'USDT → LINK → BTC → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_LINK_USDC', pairs: ['XBTUSDC', 'LINKXBT', 'LINKUSDC'], sequence: 'USDC → BTC → LINK → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'LINKXBT', side: 'buy' }, { pair: 'LINKUSDC', side: 'sell' }] },
                { id: 'USDC_LINK_BTC_USDC', pairs: ['LINKUSDC', 'LINKXBT', 'XBTUSDC'], sequence: 'USDC → LINK → BTC → USDC', steps: [{ pair: 'LINKUSDC', side: 'buy' }, { pair: 'LINKXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_LINK_USD', pairs: ['ETHUSD', 'LINKETH', 'LINKUSD'], sequence: 'USD → ETH → LINK → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'LINKETH', side: 'buy' }, { pair: 'LINKUSD', side: 'sell' }] },
                { id: 'USD_LINK_ETH_USD', pairs: ['LINKUSD', 'LINKETH', 'ETHUSD'], sequence: 'USD → LINK → ETH → USD', steps: [{ pair: 'LINKUSD', side: 'buy' }, { pair: 'LINKETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_LINK_USDT', pairs: ['ETHUSDT', 'LINKETH', 'LINKUSDT'], sequence: 'USDT → ETH → LINK → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'LINKETH', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'USDT_LINK_ETH_USDT', pairs: ['LINKUSDT', 'LINKETH', 'ETHUSDT'], sequence: 'USDT → LINK → ETH → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_LINK_USDC', pairs: ['ETHUSDC', 'LINKETH', 'LINKUSDC'], sequence: 'USDC → ETH → LINK → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'LINKETH', side: 'buy' }, { pair: 'LINKUSDC', side: 'sell' }] },
                { id: 'USDC_LINK_ETH_USDC', pairs: ['LINKUSDC', 'LINKETH', 'ETHUSDC'], sequence: 'USDC → LINK → ETH → USDC', steps: [{ pair: 'LINKUSDC', side: 'buy' }, { pair: 'LINKETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 8: LTC Focus (12 paths) - BTC + ETH bridges
            SET_8_LTC_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_LTC_USD', pairs: ['XBTUSD', 'LTCXBT', 'LTCUSD'], sequence: 'USD → BTC → LTC → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCUSD', side: 'sell' }] },
                { id: 'USD_LTC_BTC_USD', pairs: ['LTCUSD', 'LTCXBT', 'XBTUSD'], sequence: 'USD → LTC → BTC → USD', steps: [{ pair: 'LTCUSD', side: 'buy' }, { pair: 'LTCXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_LTC_USDT', pairs: ['XBTUSDT', 'LTCXBT', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'USDT_LTC_BTC_USDT', pairs: ['LTCUSDT', 'LTCXBT', 'XBTUSDT'], sequence: 'USDT → LTC → BTC → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_LTC_USDC', pairs: ['XBTUSDC', 'LTCXBT', 'LTCUSDC'], sequence: 'USDC → BTC → LTC → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCUSDC', side: 'sell' }] },
                { id: 'USDC_LTC_BTC_USDC', pairs: ['LTCUSDC', 'LTCXBT', 'XBTUSDC'], sequence: 'USDC → LTC → BTC → USDC', steps: [{ pair: 'LTCUSDC', side: 'buy' }, { pair: 'LTCXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_LTC_USD', pairs: ['ETHUSD', 'LTCETH', 'LTCUSD'], sequence: 'USD → ETH → LTC → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCUSD', side: 'sell' }] },
                { id: 'USD_LTC_ETH_USD', pairs: ['LTCUSD', 'LTCETH', 'ETHUSD'], sequence: 'USD → LTC → ETH → USD', steps: [{ pair: 'LTCUSD', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_LTC_USDT', pairs: ['ETHUSDT', 'LTCETH', 'LTCUSDT'], sequence: 'USDT → ETH → LTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'USDT_LTC_ETH_USDT', pairs: ['LTCUSDT', 'LTCETH', 'ETHUSDT'], sequence: 'USDT → LTC → ETH → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_LTC_USDC', pairs: ['ETHUSDC', 'LTCETH', 'LTCUSDC'], sequence: 'USDC → ETH → LTC → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCUSDC', side: 'sell' }] },
                { id: 'USDC_LTC_ETH_USDC', pairs: ['LTCUSDC', 'LTCETH', 'ETHUSDC'], sequence: 'USDC → LTC → ETH → USDC', steps: [{ pair: 'LTCUSDC', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 9: ATOM Focus (12 paths) - BTC + ETH bridges
            SET_9_ATOM_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_ATOM_USD', pairs: ['XBTUSD', 'ATOMXBT', 'ATOMUSD'], sequence: 'USD → BTC → ATOM → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'ATOMXBT', side: 'buy' }, { pair: 'ATOMUSD', side: 'sell' }] },
                { id: 'USD_ATOM_BTC_USD', pairs: ['ATOMUSD', 'ATOMXBT', 'XBTUSD'], sequence: 'USD → ATOM → BTC → USD', steps: [{ pair: 'ATOMUSD', side: 'buy' }, { pair: 'ATOMXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_ATOM_USDT', pairs: ['XBTUSDT', 'ATOMXBT', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ATOMXBT', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'USDT_ATOM_BTC_USDT', pairs: ['ATOMUSDT', 'ATOMXBT', 'XBTUSDT'], sequence: 'USDT → ATOM → BTC → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_ATOM_USDC', pairs: ['XBTUSDC', 'ATOMXBT', 'ATOMUSDC'], sequence: 'USDC → BTC → ATOM → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'ATOMXBT', side: 'buy' }, { pair: 'ATOMUSDC', side: 'sell' }] },
                { id: 'USDC_ATOM_BTC_USDC', pairs: ['ATOMUSDC', 'ATOMXBT', 'XBTUSDC'], sequence: 'USDC → ATOM → BTC → USDC', steps: [{ pair: 'ATOMUSDC', side: 'buy' }, { pair: 'ATOMXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_ATOM_USD', pairs: ['ETHUSD', 'ATOMETH', 'ATOMUSD'], sequence: 'USD → ETH → ATOM → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'ATOMETH', side: 'buy' }, { pair: 'ATOMUSD', side: 'sell' }] },
                { id: 'USD_ATOM_ETH_USD', pairs: ['ATOMUSD', 'ATOMETH', 'ETHUSD'], sequence: 'USD → ATOM → ETH → USD', steps: [{ pair: 'ATOMUSD', side: 'buy' }, { pair: 'ATOMETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_ATOM_USDT', pairs: ['ETHUSDT', 'ATOMETH', 'ATOMUSDT'], sequence: 'USDT → ETH → ATOM → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ATOMETH', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'USDT_ATOM_ETH_USDT', pairs: ['ATOMUSDT', 'ATOMETH', 'ETHUSDT'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_ATOM_USDC', pairs: ['ETHUSDC', 'ATOMETH', 'ATOMUSDC'], sequence: 'USDC → ETH → ATOM → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'ATOMETH', side: 'buy' }, { pair: 'ATOMUSDC', side: 'sell' }] },
                { id: 'USDC_ATOM_ETH_USDC', pairs: ['ATOMUSDC', 'ATOMETH', 'ETHUSDC'], sequence: 'USDC → ATOM → ETH → USDC', steps: [{ pair: 'ATOMUSDC', side: 'buy' }, { pair: 'ATOMETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ],

            // SET 10: AVAX Focus (12 paths) - BTC + ETH bridges
            SET_10_AVAX_FOCUS: [
                // BTC Bridge
                { id: 'USD_BTC_AVAX_USD', pairs: ['XBTUSD', 'AVAXXBT', 'AVAXUSD'], sequence: 'USD → BTC → AVAX → USD', steps: [{ pair: 'XBTUSD', side: 'buy' }, { pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXUSD', side: 'sell' }] },
                { id: 'USD_AVAX_BTC_USD', pairs: ['AVAXUSD', 'AVAXXBT', 'XBTUSD'], sequence: 'USD → AVAX → BTC → USD', steps: [{ pair: 'AVAXUSD', side: 'buy' }, { pair: 'AVAXXBT', side: 'sell' }, { pair: 'XBTUSD', side: 'sell' }] },
                { id: 'USDT_BTC_AVAX_USDT', pairs: ['XBTUSDT', 'AVAXXBT', 'AVAXUSDT'], sequence: 'USDT → BTC → AVAX → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] },
                { id: 'USDT_AVAX_BTC_USDT', pairs: ['AVAXUSDT', 'AVAXXBT', 'XBTUSDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDC_BTC_AVAX_USDC', pairs: ['XBTUSDC', 'AVAXXBT', 'AVAXUSDC'], sequence: 'USDC → BTC → AVAX → USDC', steps: [{ pair: 'XBTUSDC', side: 'buy' }, { pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXUSDC', side: 'sell' }] },
                { id: 'USDC_AVAX_BTC_USDC', pairs: ['AVAXUSDC', 'AVAXXBT', 'XBTUSDC'], sequence: 'USDC → AVAX → BTC → USDC', steps: [{ pair: 'AVAXUSDC', side: 'buy' }, { pair: 'AVAXXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                // ETH Bridge
                { id: 'USD_ETH_AVAX_USD', pairs: ['ETHUSD', 'AVAXETH', 'AVAXUSD'], sequence: 'USD → ETH → AVAX → USD', steps: [{ pair: 'ETHUSD', side: 'buy' }, { pair: 'AVAXETH', side: 'buy' }, { pair: 'AVAXUSD', side: 'sell' }] },
                { id: 'USD_AVAX_ETH_USD', pairs: ['AVAXUSD', 'AVAXETH', 'ETHUSD'], sequence: 'USD → AVAX → ETH → USD', steps: [{ pair: 'AVAXUSD', side: 'buy' }, { pair: 'AVAXETH', side: 'sell' }, { pair: 'ETHUSD', side: 'sell' }] },
                { id: 'USDT_ETH_AVAX_USDT', pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'AVAXETH', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] },
                { id: 'USDT_AVAX_ETH_USDT', pairs: ['AVAXUSDT', 'AVAXETH', 'ETHUSDT'], sequence: 'USDT → AVAX → ETH → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDC_ETH_AVAX_USDC', pairs: ['ETHUSDC', 'AVAXETH', 'AVAXUSDC'], sequence: 'USDC → ETH → AVAX → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'AVAXETH', side: 'buy' }, { pair: 'AVAXUSDC', side: 'sell' }] },
                { id: 'USDC_AVAX_ETH_USDC', pairs: ['AVAXUSDC', 'AVAXETH', 'ETHUSDC'], sequence: 'USDC → AVAX → ETH → USDC', steps: [{ pair: 'AVAXUSDC', side: 'buy' }, { pair: 'AVAXETH', side: 'sell' }, { pair: 'ETHUSDC', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Binance paths (33 paths across 5 sets)
     * No separator format (ETHUSDT, ETHBTC, BTCUSDT)
     * @private
     */
    _initializeBinancePaths() {
        return {
            SET_1_MAJOR_BTC: [
                { id: 'USDT_ETH_BTC_USDT', pairs: ['ETHUSDT', 'ETHBTC', 'BTCUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ETH_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_BTC_USDT', pairs: ['SOLUSDT', 'SOLBTC', 'BTCUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_SOL_USDT', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_BTC_USDT', pairs: ['XRPUSDT', 'XRPBTC', 'BTCUSDT'], sequence: 'USDT → XRP → BTC → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_XRP_USDT', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_LTC_BTC_USDT', pairs: ['LTCUSDT', 'LTCBTC', 'BTCUSDT'], sequence: 'USDT → LTC → BTC → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_LTC_USDT', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            SET_2_ALTCOINS_BTC: [
                { id: 'USDT_ADA_BTC_USDT', pairs: ['ADAUSDT', 'ADABTC', 'BTCUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADABTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ADA_USDT', pairs: ['BTCUSDT', 'ADABTC', 'ADAUSDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ADABTC', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_DOT_BTC_USDT', pairs: ['DOTUSDT', 'DOTBTC', 'BTCUSDT'], sequence: 'USDT → DOT → BTC → USDT', steps: [{ pair: 'DOTUSDT', side: 'buy' }, { pair: 'DOTBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_DOT_USDT', pairs: ['BTCUSDT', 'DOTBTC', 'DOTUSDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'DOTBTC', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_MATIC_BTC_USDT', pairs: ['MATICUSDT', 'MATICBTC', 'BTCUSDT'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_MATIC_USDT', pairs: ['BTCUSDT', 'MATICBTC', 'MATICUSDT'], sequence: 'USDT → BTC → MATIC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'MATICBTC', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'USDT_AVAX_BTC_USDT', pairs: ['AVAXUSDT', 'AVAXBTC', 'BTCUSDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_AVAX_USDT', pairs: ['BTCUSDT', 'AVAXBTC', 'AVAXUSDT'], sequence: 'USDT → BTC → AVAX → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'AVAXBTC', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_3_DEFI_BTC: [
                { id: 'USDT_LINK_BTC_USDT', pairs: ['LINKUSDT', 'LINKBTC', 'BTCUSDT'], sequence: 'USDT → LINK → BTC → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_LINK_USDT', pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'USDT_UNI_BTC_USDT', pairs: ['UNIUSDT', 'UNIBTC', 'BTCUSDT'], sequence: 'USDT → UNI → BTC → USDT', steps: [{ pair: 'UNIUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_UNI_USDT', pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'buy' }, { pair: 'UNIUSDT', side: 'sell' }] },
                { id: 'USDT_ATOM_BTC_USDT', pairs: ['ATOMUSDT', 'ATOMBTC', 'BTCUSDT'], sequence: 'USDT → ATOM → BTC → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ATOM_USDT', pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] }
            ],
            SET_4_ETH_BNB_BRIDGE: [
                { id: 'USDT_SAND_BNB_USDT', pairs: ['SANDUSDT', 'SANDBNB', 'BNBUSDT'], sequence: 'USDT → SAND → BNB → USDT', steps: [{ pair: 'SANDUSDT', side: 'buy' }, { pair: 'SANDBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_MANA_BNB_USDT', pairs: ['MANAUSDT', 'MANABNB', 'BNBUSDT'], sequence: 'USDT → MANA → BNB → USDT', steps: [{ pair: 'MANAUSDT', side: 'buy' }, { pair: 'MANABNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_AXS_BNB_USDT', pairs: ['AXSUSDT', 'AXSBNB', 'BNBUSDT'], sequence: 'USDT → AXS → BNB → USDT', steps: [{ pair: 'AXSUSDT', side: 'buy' }, { pair: 'AXSBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_GALA_BNB_USDT', pairs: ['GALAUSDT', 'GALABNB', 'BNBUSDT'], sequence: 'USDT → GALA → BNB → USDT', steps: [{ pair: 'GALAUSDT', side: 'buy' }, { pair: 'GALABNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_SUSHI_ETH_USDT', pairs: ['SUSHIUSDT', 'SUSHIETH', 'ETHUSDT'], sequence: 'USDT → SUSHI → ETH → USDT', steps: [{ pair: 'SUSHIUSDT', side: 'buy' }, { pair: 'SUSHIETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_CRV_ETH_USDT', pairs: ['CRVUSDT', 'CRVETH', 'ETHUSDT'], sequence: 'USDT → CRV → ETH → USDT', steps: [{ pair: 'CRVUSDT', side: 'buy' }, { pair: 'CRVETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_DOGE_BNB_USDT', pairs: ['DOGEUSDT', 'DOGEBNB', 'BNBUSDT'], sequence: 'USDT → DOGE → BNB → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_SHIB_ETH_USDT', pairs: ['SHIBUSDT', 'SHIBETH', 'ETHUSDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_PEPE_ETH_USDT', pairs: ['PEPEUSDT', 'PEPEETH', 'ETHUSDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPEUSDT', side: 'buy' }, { pair: 'PEPEETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_FTM_BNB_USDT', pairs: ['FTMUSDT', 'FTMBNB', 'BNBUSDT'], sequence: 'USDT → FTM → BNB → USDT', steps: [{ pair: 'FTMUSDT', side: 'buy' }, { pair: 'FTMBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_NEAR_BNB_USDT', pairs: ['NEARUSDT', 'NEARBNB', 'BNBUSDT'], sequence: 'USDT → NEAR → BNB → USDT', steps: [{ pair: 'NEARUSDT', side: 'buy' }, { pair: 'NEARBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_APT_BNB_USDT', pairs: ['APTUSDT', 'APTBNB', 'BNBUSDT'], sequence: 'USDT → APT → BNB → USDT', steps: [{ pair: 'APTUSDT', side: 'buy' }, { pair: 'APTBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'USDT_BTC_ETH_BNB_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHBNB', 'BNBUSDT'], sequence: 'USDT → BTC → ETH → BNB → USDT (4-leg)', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_BNB_ETH_USDT', pairs: ['BNBUSDT', 'BNBETH', 'ETHUSDT'], sequence: 'USDT → BNB → ETH → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_BNB_BTC_USDT', pairs: ['BNBUSDT', 'BNBBTC', 'BTCUSDT'], sequence: 'USDT → BNB → BTC → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_BTC_USDT_2', pairs: ['ETHUSDT', 'ETHBTC', 'BTCUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ETH_USDT_2', pairs: ['BTCUSDT', 'BTCETH', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'BTCETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_TRX_BNB_USDT', pairs: ['TRXUSDT', 'TRXBNB', 'BNBUSDT'], sequence: 'USDT → TRX → BNB → USDT', steps: [{ pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] },
                { id: 'USDT_XLM_BNB_USDT', pairs: ['XLMUSDT', 'XLMBNB', 'BNBUSDT'], sequence: 'USDT → XLM → BNB → USDT', steps: [{ pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMBNB', side: 'sell' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize ByBit paths (40 paths across 5 sets)
     * No separator format (ETHUSDT, ETHBTC, BTCUSDT)
     * @private
     */
    _initializeBybitPaths() {
        return {
            SET_1_MAJOR_BTC: [
                { id: 'USDT_ETH_BTC_USDT', pairs: ['ETHUSDT', 'ETHBTC', 'BTCUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ETH_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_BTC_USDT', pairs: ['SOLUSDT', 'SOLBTC', 'BTCUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_SOL_USDT', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_BTC_USDT', pairs: ['XRPUSDT', 'XRPBTC', 'BTCUSDT'], sequence: 'USDT → XRP → BTC → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_XRP_USDT', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_LTC_BTC_USDT', pairs: ['LTCUSDT', 'LTCBTC', 'BTCUSDT'], sequence: 'USDT → LTC → BTC → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_LTC_USDT', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            SET_2_ALTCOINS_BTC: [
                { id: 'USDT_ADA_BTC_USDT', pairs: ['ADAUSDT', 'ADABTC', 'BTCUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADABTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ADA_USDT', pairs: ['BTCUSDT', 'ADABTC', 'ADAUSDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ADABTC', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_DOT_BTC_USDT', pairs: ['DOTUSDT', 'DOTBTC', 'BTCUSDT'], sequence: 'USDT → DOT → BTC → USDT', steps: [{ pair: 'DOTUSDT', side: 'buy' }, { pair: 'DOTBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_DOT_USDT', pairs: ['BTCUSDT', 'DOTBTC', 'DOTUSDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'DOTBTC', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_MATIC_BTC_USDT', pairs: ['MATICUSDT', 'MATICBTC', 'BTCUSDT'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_MATIC_USDT', pairs: ['BTCUSDT', 'MATICBTC', 'MATICUSDT'], sequence: 'USDT → BTC → MATIC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'MATICBTC', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'USDT_AVAX_BTC_USDT', pairs: ['AVAXUSDT', 'AVAXBTC', 'BTCUSDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_AVAX_USDT', pairs: ['BTCUSDT', 'AVAXBTC', 'AVAXUSDT'], sequence: 'USDT → BTC → AVAX → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'AVAXBTC', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_3_DEFI_BTC: [
                { id: 'USDT_LINK_BTC_USDT', pairs: ['LINKUSDT', 'LINKBTC', 'BTCUSDT'], sequence: 'USDT → LINK → BTC → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_LINK_USDT', pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'USDT_UNI_BTC_USDT', pairs: ['UNIUSDT', 'UNIBTC', 'BTCUSDT'], sequence: 'USDT → UNI → BTC → USDT', steps: [{ pair: 'UNIUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_UNI_USDT', pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'buy' }, { pair: 'UNIUSDT', side: 'sell' }] },
                { id: 'USDT_ATOM_BTC_USDT', pairs: ['ATOMUSDT', 'ATOMBTC', 'BTCUSDT'], sequence: 'USDT → ATOM → BTC → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ATOM_USDT', pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'USDT_ALGO_BTC_USDT', pairs: ['ALGOUSDT', 'ALGOBTC', 'BTCUSDT'], sequence: 'USDT → ALGO → BTC → USDT', steps: [{ pair: 'ALGOUSDT', side: 'buy' }, { pair: 'ALGOBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_ALGO_USDT', pairs: ['BTCUSDT', 'ALGOBTC', 'ALGOUSDT'], sequence: 'USDT → BTC → ALGO → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ALGOBTC', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }] }
            ],
            SET_4_ETH_BRIDGE: [
                { id: 'USDT_ETH_SOL_USDT', pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_ETH_USDT', pairs: ['SOLUSDT', 'SOLETH', 'ETHUSDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_ADA_USDT', pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'USDT_ADA_ETH_USDT', pairs: ['ADAUSDT', 'ADAETH', 'ETHUSDT'], sequence: 'USDT → ADA → ETH → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_DOT_USDT', pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'USDT_DOT_ETH_USDT', pairs: ['DOTUSDT', 'DOTETH', 'ETHUSDT'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'DOTUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_MATIC_USDT', pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'USDT_MATIC_ETH_USDT', pairs: ['MATICUSDT', 'MATICETH', 'ETHUSDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'sell' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_BTC: [
                { id: 'USDT_XLM_BTC_USDT', pairs: ['XLMUSDT', 'XLMBTC', 'BTCUSDT'], sequence: 'USDT → XLM → BTC → USDT', steps: [{ pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_XLM_USDT', pairs: ['BTCUSDT', 'XLMBTC', 'XLMUSDT'], sequence: 'USDT → BTC → XLM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XLMBTC', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }] },
                { id: 'USDT_DOGE_BTC_USDT', pairs: ['DOGEUSDT', 'DOGEBTC', 'BTCUSDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_DOGE_USDT', pairs: ['BTCUSDT', 'DOGEBTC', 'DOGEUSDT'], sequence: 'USDT → BTC → DOGE → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'DOGEBTC', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }] },
                { id: 'USDT_FIL_BTC_USDT', pairs: ['FILUSDT', 'FILBTC', 'BTCUSDT'], sequence: 'USDT → FIL → BTC → USDT', steps: [{ pair: 'FILUSDT', side: 'buy' }, { pair: 'FILBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_FIL_USDT', pairs: ['BTCUSDT', 'FILBTC', 'FILUSDT'], sequence: 'USDT → BTC → FIL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'FILBTC', side: 'buy' }, { pair: 'FILUSDT', side: 'sell' }] },
                { id: 'USDT_NEAR_BTC_USDT', pairs: ['NEARUSDT', 'NEARBTC', 'BTCUSDT'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEARUSDT', side: 'buy' }, { pair: 'NEARBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_NEAR_USDT', pairs: ['BTCUSDT', 'NEARBTC', 'NEARUSDT'], sequence: 'USDT → BTC → NEAR → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'NEARBTC', side: 'buy' }, { pair: 'NEARUSDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize KuCoin paths (32 paths across 5 sets)
     * Hyphenated format (ETH-USDT, BTC-ETH, BTC-USDT)
     * @private
     */
    _initializeKucoinPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'KCS_ETH_1', pairs: ['ETH-USDT', 'BTC-ETH', 'BTC-USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'BTC-ETH', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'KCS_ETH_2', pairs: ['ETH-USDT', 'SOL-ETH', 'SOL-USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'KCS_ETH_3', pairs: ['ETH-USDT', 'XRP-ETH', 'XRP-USDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'XRP-ETH', side: 'buy' }, { pair: 'XRP-USDT', side: 'sell' }] },
                { id: 'KCS_ETH_4', pairs: ['ETH-USDT', 'ADA-ETH', 'ADA-USDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'ADA-ETH', side: 'buy' }, { pair: 'ADA-USDT', side: 'sell' }] },
                { id: 'KCS_ETH_5', pairs: ['ETH-USDT', 'DOT-ETH', 'DOT-USDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'DOT-ETH', side: 'buy' }, { pair: 'DOT-USDT', side: 'sell' }] },
                { id: 'KCS_ETH_6', pairs: ['ETH-USDT', 'MATIC-ETH', 'MATIC-USDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'MATIC-ETH', side: 'buy' }, { pair: 'MATIC-USDT', side: 'sell' }] },
                { id: 'KCS_ETH_7', pairs: ['ETH-USDT', 'LINK-ETH', 'LINK-USDT'], sequence: 'USDT → ETH → LINK → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'LINK-ETH', side: 'buy' }, { pair: 'LINK-USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'KCS_BTC_1', pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_BTC_2', pairs: ['BTC-USDT', 'SOL-BTC', 'SOL-USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'SOL-BTC', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'KCS_BTC_3', pairs: ['BTC-USDT', 'AVAX-BTC', 'AVAX-USDT'], sequence: 'USDT → BTC → AVAX → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'AVAX-BTC', side: 'buy' }, { pair: 'AVAX-USDT', side: 'sell' }] },
                { id: 'KCS_BTC_4', pairs: ['BTC-USDT', 'ATOM-BTC', 'ATOM-USDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ATOM-BTC', side: 'buy' }, { pair: 'ATOM-USDT', side: 'sell' }] },
                { id: 'KCS_BTC_5', pairs: ['BTC-USDT', 'LTC-BTC', 'LTC-USDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'LTC-BTC', side: 'buy' }, { pair: 'LTC-USDT', side: 'sell' }] },
                { id: 'KCS_BTC_6', pairs: ['BTC-USDT', 'UNI-BTC', 'UNI-USDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'UNI-BTC', side: 'buy' }, { pair: 'UNI-USDT', side: 'sell' }] },
                { id: 'KCS_BTC_7', pairs: ['BTC-USDT', 'FIL-BTC', 'FIL-USDT'], sequence: 'USDT → BTC → FIL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'FIL-BTC', side: 'buy' }, { pair: 'FIL-USDT', side: 'sell' }] }
            ],
            SET_3_KCS_NATIVE_BRIDGE: [
                { id: 'KCS_NATIVE_1', pairs: ['KCS-USDT', 'BTC-KCS', 'BTC-USDT'], sequence: 'USDT → KCS → BTC → USDT', steps: [{ pair: 'KCS-USDT', side: 'buy' }, { pair: 'BTC-KCS', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'KCS_NATIVE_2', pairs: ['KCS-USDT', 'ETH-KCS', 'ETH-USDT'], sequence: 'USDT → KCS → ETH → USDT', steps: [{ pair: 'KCS-USDT', side: 'buy' }, { pair: 'ETH-KCS', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_NATIVE_3', pairs: ['KCS-USDT', 'SOL-KCS', 'SOL-USDT'], sequence: 'USDT → KCS → SOL → USDT', steps: [{ pair: 'KCS-USDT', side: 'buy' }, { pair: 'SOL-KCS', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'KCS_NATIVE_4', pairs: ['KCS-USDT', 'XRP-KCS', 'XRP-USDT'], sequence: 'USDT → KCS → XRP → USDT', steps: [{ pair: 'KCS-USDT', side: 'buy' }, { pair: 'XRP-KCS', side: 'buy' }, { pair: 'XRP-USDT', side: 'sell' }] },
                { id: 'KCS_NATIVE_5', pairs: ['KCS-USDT', 'ADA-KCS', 'ADA-USDT'], sequence: 'USDT → KCS → ADA → USDT', steps: [{ pair: 'KCS-USDT', side: 'buy' }, { pair: 'ADA-KCS', side: 'buy' }, { pair: 'ADA-USDT', side: 'sell' }] },
                { id: 'KCS_NATIVE_6', pairs: ['KCS-USDT', 'DOT-KCS', 'DOT-USDT'], sequence: 'USDT → KCS → DOT → USDT', steps: [{ pair: 'KCS-USDT', side: 'buy' }, { pair: 'DOT-KCS', side: 'buy' }, { pair: 'DOT-USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'KCS_VOL_1', pairs: ['DOGE-USDT', 'BTC-DOGE', 'BTC-USDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGE-USDT', side: 'buy' }, { pair: 'BTC-DOGE', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'KCS_VOL_2', pairs: ['SHIB-USDT', 'ETH-SHIB', 'ETH-USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB-USDT', side: 'buy' }, { pair: 'ETH-SHIB', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_VOL_3', pairs: ['PEPE-USDT', 'ETH-PEPE', 'ETH-USDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPE-USDT', side: 'buy' }, { pair: 'ETH-PEPE', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_VOL_4', pairs: ['NEAR-USDT', 'BTC-NEAR', 'BTC-USDT'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEAR-USDT', side: 'buy' }, { pair: 'BTC-NEAR', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'KCS_VOL_5', pairs: ['APT-USDT', 'ETH-APT', 'ETH-USDT'], sequence: 'USDT → APT → ETH → USDT', steps: [{ pair: 'APT-USDT', side: 'buy' }, { pair: 'ETH-APT', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_VOL_6', pairs: ['FTM-USDT', 'BTC-FTM', 'BTC-USDT'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTM-USDT', side: 'buy' }, { pair: 'BTC-FTM', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'KCS_EXT_1', pairs: ['BNB-USDT', 'ETH-BNB', 'ETH-USDT'], sequence: 'USDT → BNB → ETH → USDT', steps: [{ pair: 'BNB-USDT', side: 'buy' }, { pair: 'ETH-BNB', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_EXT_2', pairs: ['TRX-USDT', 'BTC-TRX', 'BTC-USDT'], sequence: 'USDT → TRX → BTC → USDT', steps: [{ pair: 'TRX-USDT', side: 'buy' }, { pair: 'BTC-TRX', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'KCS_EXT_3', pairs: ['ALGO-USDT', 'ETH-ALGO', 'ETH-USDT'], sequence: 'USDT → ALGO → ETH → USDT', steps: [{ pair: 'ALGO-USDT', side: 'buy' }, { pair: 'ETH-ALGO', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_EXT_4', pairs: ['VET-USDT', 'BTC-VET', 'BTC-USDT'], sequence: 'USDT → VET → BTC → USDT', steps: [{ pair: 'VET-USDT', side: 'buy' }, { pair: 'BTC-VET', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'KCS_EXT_5', pairs: ['HBAR-USDT', 'ETH-HBAR', 'ETH-USDT'], sequence: 'USDT → HBAR → ETH → USDT', steps: [{ pair: 'HBAR-USDT', side: 'buy' }, { pair: 'ETH-HBAR', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'KCS_EXT_6', pairs: ['BTC-USDT', 'ETH-BTC', 'SOL-ETH', 'SOL-USDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Chainex path definitions (28 paths, 6 sets)
     * Pair format: No separator (BTCZAR, ETHBTC)
     */
    _initializeChainexPaths() {
        return {
            SET_1_ZAR_FOCUS: [
                { id: 'ZAR_BTC_ETH_ZAR', pairs: ['BTCZAR', 'ETHBTC', 'ETHZAR'], sequence: 'ZAR → BTC → ETH → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_BTC_XRP_ZAR', pairs: ['BTCZAR', 'XRPBTC', 'XRPZAR'], sequence: 'ZAR → BTC → XRP → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_ETH_XRP_ZAR', pairs: ['ETHZAR', 'XRPETH', 'XRPZAR'], sequence: 'ZAR → ETH → XRP → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_BTC_LTC_ZAR', pairs: ['BTCZAR', 'LTCBTC', 'LTCZAR'], sequence: 'ZAR → BTC → LTC → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'ZAR_ETH_LTC_ZAR', pairs: ['ETHZAR', 'LTCETH', 'LTCZAR'], sequence: 'ZAR → ETH → LTC → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'ZAR_BTC_BCH_ZAR', pairs: ['BTCZAR', 'BCHBTC', 'BCHZAR'], sequence: 'ZAR → BTC → BCH → ZAR', steps: [{ pair: 'BTCZAR', side: 'buy' }, { pair: 'BCHBTC', side: 'buy' }, { pair: 'BCHZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BTC_ZAR', pairs: ['USDTZAR', 'BTCUSDT', 'BTCZAR'], sequence: 'ZAR → USDT → BTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BTCUSDT', side: 'buy' }, { pair: 'BTCZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] }
            ],
            SET_2_BTC_FOCUS: [
                { id: 'BTC_ETH_XRP_BTC', pairs: ['ETHBTC', 'XRPETH', 'XRPBTC'], sequence: 'BTC → ETH → XRP → BTC', steps: [{ pair: 'ETHBTC', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPBTC', side: 'sell' }] },
                { id: 'BTC_ETH_LTC_BTC', pairs: ['ETHBTC', 'LTCETH', 'LTCBTC'], sequence: 'BTC → ETH → LTC → BTC', steps: [{ pair: 'ETHBTC', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }] },
                { id: 'BTC_XRP_LTC_BTC', pairs: ['XRPBTC', 'LTCXRP', 'LTCBTC'], sequence: 'BTC → XRP → LTC → BTC', steps: [{ pair: 'XRPBTC', side: 'buy' }, { pair: 'LTCXRP', side: 'buy' }, { pair: 'LTCBTC', side: 'sell' }] },
                { id: 'BTC_ETH_USDT_BTC', pairs: ['ETHBTC', 'ETHUSDT', 'BTCUSDT'], sequence: 'BTC → ETH → USDT → BTC', steps: [{ pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BTC_XRP_USDT_BTC', pairs: ['XRPBTC', 'XRPUSDT', 'BTCUSDT'], sequence: 'BTC → XRP → USDT → BTC', steps: [{ pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BTC_LTC_USDT_BTC', pairs: ['LTCBTC', 'LTCUSDT', 'BTCUSDT'], sequence: 'BTC → LTC → USDT → BTC', steps: [{ pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BTC_BCH_USDT_BTC', pairs: ['BCHBTC', 'BCHUSDT', 'BTCUSDT'], sequence: 'BTC → BCH → USDT → BTC', steps: [{ pair: 'BCHBTC', side: 'buy' }, { pair: 'BCHUSDT', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_3_USDT_FOCUS: [
                { id: 'USDT_BTC_ETH_USDT', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_XRP_USDT', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_BTC_LTC_USDT', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_XRP_USDT', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_LTC_USDT', pairs: ['ETHUSDT', 'LTCETH', 'LTCUSDT'], sequence: 'USDT → ETH → LTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'LTCETH', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'USDT_ZAR_BTC_USDT', pairs: ['USDTZAR', 'BTCZAR', 'BTCUSDT'], sequence: 'USDT → ZAR → BTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BTCZAR', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_4_ETH_FOCUS: [
                { id: 'ETH_BTC_XRP_ETH', pairs: ['ETHBTC', 'XRPBTC', 'XRPETH'], sequence: 'ETH → BTC → XRP → ETH', steps: [{ pair: 'ETHBTC', side: 'sell' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPETH', side: 'sell' }] },
                { id: 'ETH_BTC_LTC_ETH', pairs: ['ETHBTC', 'LTCBTC', 'LTCETH'], sequence: 'ETH → BTC → LTC → ETH', steps: [{ pair: 'ETHBTC', side: 'sell' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }] },
                { id: 'ETH_USDT_ZAR_ETH', pairs: ['ETHUSDT', 'USDTZAR', 'ETHZAR'], sequence: 'ETH → USDT → ZAR → ETH', steps: [{ pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }] },
                { id: 'ETH_XRP_USDT_ETH', pairs: ['XRPETH', 'XRPUSDT', 'ETHUSDT'], sequence: 'ETH → XRP → USDT → ETH', steps: [{ pair: 'XRPETH', side: 'sell' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }] }
            ],
            SET_5_CROSS_CURRENCY: [
                { id: 'XRP_BTC_USDT_XRP', pairs: ['XRPBTC', 'BTCUSDT', 'XRPUSDT'], sequence: 'XRP → BTC → USDT → XRP', steps: [{ pair: 'XRPBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }, { pair: 'XRPUSDT', side: 'buy' }] },
                { id: 'LTC_BTC_ETH_LTC', pairs: ['LTCBTC', 'ETHBTC', 'LTCETH'], sequence: 'LTC → BTC → ETH → LTC', steps: [{ pair: 'LTCBTC', side: 'sell' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'LTCETH', side: 'sell' }] }
            ],
            SET_6_EXTENDED_ALTCOINS: [
                { id: 'BCH_BTC_USDT_BCH', pairs: ['BCHBTC', 'BTCUSDT', 'BCHUSDT'], sequence: 'BCH → BTC → USDT → BCH', steps: [{ pair: 'BCHBTC', side: 'sell' }, { pair: 'BTCUSDT', side: 'sell' }, { pair: 'BCHUSDT', side: 'buy' }] }
            ]
        };
    }

    /**
     * Initialize OKX path definitions (32 paths, 5 sets)
     * Pair format: Hyphenated (BTC-USDT, ETH-BTC)
     */
    _initializeOkxPaths() {
        return {
            SET_1_MAJOR_ETH_BRIDGE: [
                { id: 'USDT_BTC_ETH_USDT', pairs: ['BTC-USDT', 'BTC-ETH', 'ETH-USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'BTC-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_SOL_ETH_USDT', pairs: ['SOL-USDT', 'SOL-ETH', 'ETH-USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'SOL-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_XRP_ETH_USDT', pairs: ['XRP-USDT', 'XRP-ETH', 'ETH-USDT'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'XRP-USDT', side: 'buy' }, { pair: 'XRP-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_ADA_ETH_USDT', pairs: ['ADA-USDT', 'ADA-ETH', 'ETH-USDT'], sequence: 'USDT → ADA → ETH → USDT', steps: [{ pair: 'ADA-USDT', side: 'buy' }, { pair: 'ADA-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_DOT_ETH_USDT', pairs: ['DOT-USDT', 'DOT-ETH', 'ETH-USDT'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'DOT-USDT', side: 'buy' }, { pair: 'DOT-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_MATIC_ETH_USDT', pairs: ['MATIC-USDT', 'MATIC-ETH', 'ETH-USDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATIC-USDT', side: 'buy' }, { pair: 'MATIC-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_LINK_ETH_USDT', pairs: ['LINK-USDT', 'LINK-ETH', 'ETH-USDT'], sequence: 'USDT → LINK → ETH → USDT', steps: [{ pair: 'LINK-USDT', side: 'buy' }, { pair: 'LINK-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'USDT_ETH_BTC_USDT', pairs: ['ETH-USDT', 'ETH-BTC', 'BTC-USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'ETH-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_SOL_BTC_USDT', pairs: ['SOL-USDT', 'SOL-BTC', 'BTC-USDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'SOL-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_AVAX_BTC_USDT', pairs: ['AVAX-USDT', 'AVAX-BTC', 'BTC-USDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAX-USDT', side: 'buy' }, { pair: 'AVAX-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_ATOM_BTC_USDT', pairs: ['ATOM-USDT', 'ATOM-BTC', 'BTC-USDT'], sequence: 'USDT → ATOM → BTC → USDT', steps: [{ pair: 'ATOM-USDT', side: 'buy' }, { pair: 'ATOM-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_LTC_BTC_USDT', pairs: ['LTC-USDT', 'LTC-BTC', 'BTC-USDT'], sequence: 'USDT → LTC → BTC → USDT', steps: [{ pair: 'LTC-USDT', side: 'buy' }, { pair: 'LTC-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_UNI_BTC_USDT', pairs: ['UNI-USDT', 'UNI-BTC', 'BTC-USDT'], sequence: 'USDT → UNI → BTC → USDT', steps: [{ pair: 'UNI-USDT', side: 'buy' }, { pair: 'UNI-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_FIL_BTC_USDT', pairs: ['FIL-USDT', 'FIL-BTC', 'BTC-USDT'], sequence: 'USDT → FIL → BTC → USDT', steps: [{ pair: 'FIL-USDT', side: 'buy' }, { pair: 'FIL-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] }
            ],
            SET_3_OKB_NATIVE_BRIDGE: [
                { id: 'USDT_BTC_OKB_USDT', pairs: ['BTC-USDT', 'BTC-OKB', 'OKB-USDT'], sequence: 'USDT → BTC → OKB → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'BTC-OKB', side: 'sell' }, { pair: 'OKB-USDT', side: 'sell' }] },
                { id: 'USDT_ETH_OKB_USDT', pairs: ['ETH-USDT', 'ETH-OKB', 'OKB-USDT'], sequence: 'USDT → ETH → OKB → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'ETH-OKB', side: 'sell' }, { pair: 'OKB-USDT', side: 'sell' }] },
                { id: 'USDT_SOL_OKB_USDT', pairs: ['SOL-USDT', 'SOL-OKB', 'OKB-USDT'], sequence: 'USDT → SOL → OKB → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'SOL-OKB', side: 'sell' }, { pair: 'OKB-USDT', side: 'sell' }] },
                { id: 'USDT_XRP_OKB_USDT', pairs: ['XRP-USDT', 'XRP-OKB', 'OKB-USDT'], sequence: 'USDT → XRP → OKB → USDT', steps: [{ pair: 'XRP-USDT', side: 'buy' }, { pair: 'XRP-OKB', side: 'sell' }, { pair: 'OKB-USDT', side: 'sell' }] },
                { id: 'USDT_ADA_OKB_USDT', pairs: ['ADA-USDT', 'ADA-OKB', 'OKB-USDT'], sequence: 'USDT → ADA → OKB → USDT', steps: [{ pair: 'ADA-USDT', side: 'buy' }, { pair: 'ADA-OKB', side: 'sell' }, { pair: 'OKB-USDT', side: 'sell' }] },
                { id: 'USDT_DOT_OKB_USDT', pairs: ['DOT-USDT', 'DOT-OKB', 'OKB-USDT'], sequence: 'USDT → DOT → OKB → USDT', steps: [{ pair: 'DOT-USDT', side: 'buy' }, { pair: 'DOT-OKB', side: 'sell' }, { pair: 'OKB-USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'USDT_DOGE_ETH_USDT', pairs: ['DOGE-USDT', 'DOGE-ETH', 'ETH-USDT'], sequence: 'USDT → DOGE → ETH → USDT', steps: [{ pair: 'DOGE-USDT', side: 'buy' }, { pair: 'DOGE-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_SHIB_ETH_USDT', pairs: ['SHIB-USDT', 'SHIB-ETH', 'ETH-USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB-USDT', side: 'buy' }, { pair: 'SHIB-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_PEPE_ETH_USDT', pairs: ['PEPE-USDT', 'PEPE-ETH', 'ETH-USDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPE-USDT', side: 'buy' }, { pair: 'PEPE-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_NEAR_BTC_USDT', pairs: ['NEAR-USDT', 'NEAR-BTC', 'BTC-USDT'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEAR-USDT', side: 'buy' }, { pair: 'NEAR-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_APT_BTC_USDT', pairs: ['APT-USDT', 'APT-BTC', 'BTC-USDT'], sequence: 'USDT → APT → BTC → USDT', steps: [{ pair: 'APT-USDT', side: 'buy' }, { pair: 'APT-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'USDT_FTM_BTC_USDT', pairs: ['FTM-USDT', 'FTM-BTC', 'BTC-USDT'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTM-USDT', side: 'buy' }, { pair: 'FTM-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'USDT_BTC_ETH_SOL_USDT', pairs: ['BTC-USDT', 'ETH-BTC', 'SOL-ETH', 'SOL-USDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'USDT_ETH_SOL_USDT', pairs: ['ETH-USDT', 'ETH-SOL', 'SOL-USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'ETH-SOL', side: 'sell' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'USDT_SOL_ETH_USDT_REV', pairs: ['SOL-USDT', 'ETH-SOL', 'ETH-USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'ETH-SOL', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_BTC_SOL_USDT', pairs: ['BTC-USDT', 'BTC-SOL', 'SOL-USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'BTC-SOL', side: 'sell' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'USDT_OKB_ETH_USDT', pairs: ['OKB-USDT', 'OKB-ETH', 'ETH-USDT'], sequence: 'USDT → OKB → ETH → USDT', steps: [{ pair: 'OKB-USDT', side: 'buy' }, { pair: 'OKB-ETH', side: 'sell' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'USDT_OKB_BTC_USDT', pairs: ['OKB-USDT', 'OKB-BTC', 'BTC-USDT'], sequence: 'USDT → OKB → BTC → USDT', steps: [{ pair: 'OKB-USDT', side: 'buy' }, { pair: 'OKB-BTC', side: 'sell' }, { pair: 'BTC-USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Coinbase path definitions (32 paths, 5 sets)
     * Pair format: Hyphenated (ETH-USDC, BTC-ETH)
     * NOTE: Coinbase uses USDC, not USDT
     */
    _initializeCoinbasePaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'CB_ETH_1', pairs: ['ETH-USDC', 'BTC-ETH', 'BTC-USDC'], sequence: 'USDC → ETH → BTC → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'BTC-ETH', side: 'buy' }, { pair: 'BTC-USDC', side: 'sell' }] },
                { id: 'CB_ETH_2', pairs: ['ETH-USDC', 'SOL-ETH', 'SOL-USDC'], sequence: 'USDC → ETH → SOL → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDC', side: 'sell' }] },
                { id: 'CB_ETH_3', pairs: ['ETH-USDC', 'XRP-ETH', 'XRP-USDC'], sequence: 'USDC → ETH → XRP → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'XRP-ETH', side: 'buy' }, { pair: 'XRP-USDC', side: 'sell' }] },
                { id: 'CB_ETH_4', pairs: ['ETH-USDC', 'ADA-ETH', 'ADA-USDC'], sequence: 'USDC → ETH → ADA → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'ADA-ETH', side: 'buy' }, { pair: 'ADA-USDC', side: 'sell' }] },
                { id: 'CB_ETH_5', pairs: ['ETH-USDC', 'DOT-ETH', 'DOT-USDC'], sequence: 'USDC → ETH → DOT → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'DOT-ETH', side: 'buy' }, { pair: 'DOT-USDC', side: 'sell' }] },
                { id: 'CB_ETH_6', pairs: ['ETH-USDC', 'MATIC-ETH', 'MATIC-USDC'], sequence: 'USDC → ETH → MATIC → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'MATIC-ETH', side: 'buy' }, { pair: 'MATIC-USDC', side: 'sell' }] },
                { id: 'CB_ETH_7', pairs: ['ETH-USDC', 'LINK-ETH', 'LINK-USDC'], sequence: 'USDC → ETH → LINK → USDC', steps: [{ pair: 'ETH-USDC', side: 'buy' }, { pair: 'LINK-ETH', side: 'buy' }, { pair: 'LINK-USDC', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'CB_BTC_1', pairs: ['BTC-USDC', 'ETH-BTC', 'ETH-USDC'], sequence: 'USDC → BTC → ETH → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_BTC_2', pairs: ['BTC-USDC', 'SOL-BTC', 'SOL-USDC'], sequence: 'USDC → BTC → SOL → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'SOL-BTC', side: 'buy' }, { pair: 'SOL-USDC', side: 'sell' }] },
                { id: 'CB_BTC_3', pairs: ['BTC-USDC', 'AVAX-BTC', 'AVAX-USDC'], sequence: 'USDC → BTC → AVAX → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'AVAX-BTC', side: 'buy' }, { pair: 'AVAX-USDC', side: 'sell' }] },
                { id: 'CB_BTC_4', pairs: ['BTC-USDC', 'ATOM-BTC', 'ATOM-USDC'], sequence: 'USDC → BTC → ATOM → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'ATOM-BTC', side: 'buy' }, { pair: 'ATOM-USDC', side: 'sell' }] },
                { id: 'CB_BTC_5', pairs: ['BTC-USDC', 'LTC-BTC', 'LTC-USDC'], sequence: 'USDC → BTC → LTC → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'LTC-BTC', side: 'buy' }, { pair: 'LTC-USDC', side: 'sell' }] },
                { id: 'CB_BTC_6', pairs: ['BTC-USDC', 'UNI-BTC', 'UNI-USDC'], sequence: 'USDC → BTC → UNI → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'UNI-BTC', side: 'buy' }, { pair: 'UNI-USDC', side: 'sell' }] },
                { id: 'CB_BTC_7', pairs: ['BTC-USDC', 'ALGO-BTC', 'ALGO-USDC'], sequence: 'USDC → BTC → ALGO → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'ALGO-BTC', side: 'buy' }, { pair: 'ALGO-USDC', side: 'sell' }] }
            ],
            SET_3_DEFI_NATIVE: [
                { id: 'CB_DEFI_1', pairs: ['AAVE-USDC', 'ETH-AAVE', 'ETH-USDC'], sequence: 'USDC → AAVE → ETH → USDC', steps: [{ pair: 'AAVE-USDC', side: 'buy' }, { pair: 'ETH-AAVE', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_DEFI_2', pairs: ['COMP-USDC', 'ETH-COMP', 'ETH-USDC'], sequence: 'USDC → COMP → ETH → USDC', steps: [{ pair: 'COMP-USDC', side: 'buy' }, { pair: 'ETH-COMP', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_DEFI_3', pairs: ['MKR-USDC', 'ETH-MKR', 'ETH-USDC'], sequence: 'USDC → MKR → ETH → USDC', steps: [{ pair: 'MKR-USDC', side: 'buy' }, { pair: 'ETH-MKR', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_DEFI_4', pairs: ['SNX-USDC', 'ETH-SNX', 'ETH-USDC'], sequence: 'USDC → SNX → ETH → USDC', steps: [{ pair: 'SNX-USDC', side: 'buy' }, { pair: 'ETH-SNX', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_DEFI_5', pairs: ['CRV-USDC', 'ETH-CRV', 'ETH-USDC'], sequence: 'USDC → CRV → ETH → USDC', steps: [{ pair: 'CRV-USDC', side: 'buy' }, { pair: 'ETH-CRV', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_DEFI_6', pairs: ['SUSHI-USDC', 'ETH-SUSHI', 'ETH-USDC'], sequence: 'USDC → SUSHI → ETH → USDC', steps: [{ pair: 'SUSHI-USDC', side: 'buy' }, { pair: 'ETH-SUSHI', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'CB_VOL_1', pairs: ['DOGE-USDC', 'BTC-DOGE', 'BTC-USDC'], sequence: 'USDC → DOGE → BTC → USDC', steps: [{ pair: 'DOGE-USDC', side: 'buy' }, { pair: 'BTC-DOGE', side: 'buy' }, { pair: 'BTC-USDC', side: 'sell' }] },
                { id: 'CB_VOL_2', pairs: ['SHIB-USDC', 'ETH-SHIB', 'ETH-USDC'], sequence: 'USDC → SHIB → ETH → USDC', steps: [{ pair: 'SHIB-USDC', side: 'buy' }, { pair: 'ETH-SHIB', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_VOL_3', pairs: ['APE-USDC', 'ETH-APE', 'ETH-USDC'], sequence: 'USDC → APE → ETH → USDC', steps: [{ pair: 'APE-USDC', side: 'buy' }, { pair: 'ETH-APE', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_VOL_4', pairs: ['GALA-USDC', 'BTC-GALA', 'BTC-USDC'], sequence: 'USDC → GALA → BTC → USDC', steps: [{ pair: 'GALA-USDC', side: 'buy' }, { pair: 'BTC-GALA', side: 'buy' }, { pair: 'BTC-USDC', side: 'sell' }] },
                { id: 'CB_VOL_5', pairs: ['SAND-USDC', 'ETH-SAND', 'ETH-USDC'], sequence: 'USDC → SAND → ETH → USDC', steps: [{ pair: 'SAND-USDC', side: 'buy' }, { pair: 'ETH-SAND', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_VOL_6', pairs: ['MANA-USDC', 'ETH-MANA', 'ETH-USDC'], sequence: 'USDC → MANA → ETH → USDC', steps: [{ pair: 'MANA-USDC', side: 'buy' }, { pair: 'ETH-MANA', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'CB_EXT_1', pairs: ['FIL-USDC', 'BTC-FIL', 'BTC-USDC'], sequence: 'USDC → FIL → BTC → USDC', steps: [{ pair: 'FIL-USDC', side: 'buy' }, { pair: 'BTC-FIL', side: 'buy' }, { pair: 'BTC-USDC', side: 'sell' }] },
                { id: 'CB_EXT_2', pairs: ['GRT-USDC', 'ETH-GRT', 'ETH-USDC'], sequence: 'USDC → GRT → ETH → USDC', steps: [{ pair: 'GRT-USDC', side: 'buy' }, { pair: 'ETH-GRT', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_EXT_3', pairs: ['ICP-USDC', 'BTC-ICP', 'BTC-USDC'], sequence: 'USDC → ICP → BTC → USDC', steps: [{ pair: 'ICP-USDC', side: 'buy' }, { pair: 'BTC-ICP', side: 'buy' }, { pair: 'BTC-USDC', side: 'sell' }] },
                { id: 'CB_EXT_4', pairs: ['CHZ-USDC', 'ETH-CHZ', 'ETH-USDC'], sequence: 'USDC → CHZ → ETH → USDC', steps: [{ pair: 'CHZ-USDC', side: 'buy' }, { pair: 'ETH-CHZ', side: 'buy' }, { pair: 'ETH-USDC', side: 'sell' }] },
                { id: 'CB_EXT_5', pairs: ['ENJ-USDC', 'BTC-ENJ', 'BTC-USDC'], sequence: 'USDC → ENJ → BTC → USDC', steps: [{ pair: 'ENJ-USDC', side: 'buy' }, { pair: 'BTC-ENJ', side: 'buy' }, { pair: 'BTC-USDC', side: 'sell' }] },
                { id: 'CB_EXT_6', pairs: ['BTC-USDC', 'ETH-BTC', 'SOL-ETH', 'SOL-USDC'], sequence: 'USDC → BTC → ETH → SOL → USDC', steps: [{ pair: 'BTC-USDC', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDC', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize HTX path definitions (32 paths, 5 sets)
     * Pair format: Lowercase no separator (ethusdt, btceth)
     */
    _initializeHtxPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'HB_ETH_1', pairs: ['ethusdt', 'btceth', 'btcusdt'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'btceth', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] },
                { id: 'HB_ETH_2', pairs: ['ethusdt', 'soleth', 'solusdt'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'soleth', side: 'buy' }, { pair: 'solusdt', side: 'sell' }] },
                { id: 'HB_ETH_3', pairs: ['ethusdt', 'xrpeth', 'xrpusdt'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'xrpeth', side: 'buy' }, { pair: 'xrpusdt', side: 'sell' }] },
                { id: 'HB_ETH_4', pairs: ['ethusdt', 'trxeth', 'trxusdt'], sequence: 'USDT → ETH → TRX → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'trxeth', side: 'buy' }, { pair: 'trxusdt', side: 'sell' }] },
                { id: 'HB_ETH_5', pairs: ['ethusdt', 'doteth', 'dotusdt'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'doteth', side: 'buy' }, { pair: 'dotusdt', side: 'sell' }] },
                { id: 'HB_ETH_6', pairs: ['ethusdt', 'maticeth', 'maticusdt'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'maticeth', side: 'buy' }, { pair: 'maticusdt', side: 'sell' }] },
                { id: 'HB_ETH_7', pairs: ['ethusdt', 'linketh', 'linkusdt'], sequence: 'USDT → ETH → LINK → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'linketh', side: 'buy' }, { pair: 'linkusdt', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'HB_BTC_1', pairs: ['btcusdt', 'ethbtc', 'ethusdt'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'ethbtc', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_BTC_2', pairs: ['btcusdt', 'xrpbtc', 'xrpusdt'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'xrpbtc', side: 'buy' }, { pair: 'xrpusdt', side: 'sell' }] },
                { id: 'HB_BTC_3', pairs: ['btcusdt', 'ltcbtc', 'ltcusdt'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'ltcbtc', side: 'buy' }, { pair: 'ltcusdt', side: 'sell' }] },
                { id: 'HB_BTC_4', pairs: ['btcusdt', 'bchbtc', 'bchusdt'], sequence: 'USDT → BTC → BCH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'bchbtc', side: 'buy' }, { pair: 'bchusdt', side: 'sell' }] },
                { id: 'HB_BTC_5', pairs: ['btcusdt', 'adabtc', 'adausdt'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'adabtc', side: 'buy' }, { pair: 'adausdt', side: 'sell' }] },
                { id: 'HB_BTC_6', pairs: ['btcusdt', 'avaxbtc', 'avaxusdt'], sequence: 'USDT → BTC → AVAX → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'avaxbtc', side: 'buy' }, { pair: 'avaxusdt', side: 'sell' }] },
                { id: 'HB_BTC_7', pairs: ['btcusdt', 'unibtc', 'uniusdt'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'unibtc', side: 'buy' }, { pair: 'uniusdt', side: 'sell' }] }
            ],
            SET_3_HT_NATIVE_BRIDGE: [
                { id: 'HB_HT_1', pairs: ['htusdt', 'btcht', 'btcusdt'], sequence: 'USDT → HT → BTC → USDT', steps: [{ pair: 'htusdt', side: 'buy' }, { pair: 'btcht', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] },
                { id: 'HB_HT_2', pairs: ['htusdt', 'ethht', 'ethusdt'], sequence: 'USDT → HT → ETH → USDT', steps: [{ pair: 'htusdt', side: 'buy' }, { pair: 'ethht', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_HT_3', pairs: ['htusdt', 'xrpht', 'xrpusdt'], sequence: 'USDT → HT → XRP → USDT', steps: [{ pair: 'htusdt', side: 'buy' }, { pair: 'xrpht', side: 'buy' }, { pair: 'xrpusdt', side: 'sell' }] },
                { id: 'HB_HT_4', pairs: ['htusdt', 'trxht', 'trxusdt'], sequence: 'USDT → HT → TRX → USDT', steps: [{ pair: 'htusdt', side: 'buy' }, { pair: 'trxht', side: 'buy' }, { pair: 'trxusdt', side: 'sell' }] },
                { id: 'HB_HT_5', pairs: ['htusdt', 'dotht', 'dotusdt'], sequence: 'USDT → HT → DOT → USDT', steps: [{ pair: 'htusdt', side: 'buy' }, { pair: 'dotht', side: 'buy' }, { pair: 'dotusdt', side: 'sell' }] },
                { id: 'HB_HT_6', pairs: ['htusdt', 'solht', 'solusdt'], sequence: 'USDT → HT → SOL → USDT', steps: [{ pair: 'htusdt', side: 'buy' }, { pair: 'solht', side: 'buy' }, { pair: 'solusdt', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'HB_VOL_1', pairs: ['dogeusdt', 'btcdoge', 'btcusdt'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'dogeusdt', side: 'buy' }, { pair: 'btcdoge', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] },
                { id: 'HB_VOL_2', pairs: ['shibusdt', 'ethshib', 'ethusdt'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'shibusdt', side: 'buy' }, { pair: 'ethshib', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_VOL_3', pairs: ['apeusdt', 'ethape', 'ethusdt'], sequence: 'USDT → APE → ETH → USDT', steps: [{ pair: 'apeusdt', side: 'buy' }, { pair: 'ethape', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_VOL_4', pairs: ['nearusdt', 'btcnear', 'btcusdt'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'nearusdt', side: 'buy' }, { pair: 'btcnear', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] },
                { id: 'HB_VOL_5', pairs: ['aptusdt', 'ethapt', 'ethusdt'], sequence: 'USDT → APT → ETH → USDT', steps: [{ pair: 'aptusdt', side: 'buy' }, { pair: 'ethapt', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_VOL_6', pairs: ['ftmusdt', 'btcftm', 'btcusdt'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'ftmusdt', side: 'buy' }, { pair: 'btcftm', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'HB_EXT_1', pairs: ['filusdt', 'btcfil', 'btcusdt'], sequence: 'USDT → FIL → BTC → USDT', steps: [{ pair: 'filusdt', side: 'buy' }, { pair: 'btcfil', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] },
                { id: 'HB_EXT_2', pairs: ['atomusdt', 'ethatom', 'ethusdt'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'atomusdt', side: 'buy' }, { pair: 'ethatom', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_EXT_3', pairs: ['icpusdt', 'btcicp', 'btcusdt'], sequence: 'USDT → ICP → BTC → USDT', steps: [{ pair: 'icpusdt', side: 'buy' }, { pair: 'btcicp', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] },
                { id: 'HB_EXT_4', pairs: ['algousdt', 'ethalgo', 'ethusdt'], sequence: 'USDT → ALGO → ETH → USDT', steps: [{ pair: 'algousdt', side: 'buy' }, { pair: 'ethalgo', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'HB_EXT_5', pairs: ['etcusdt', 'btcetc', 'btcusdt'], sequence: 'USDT → ETC → BTC → USDT', steps: [{ pair: 'etcusdt', side: 'buy' }, { pair: 'btcetc', side: 'buy' }, { pair: 'btcusdt', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Gate.io path definitions (30 paths, 5 sets)
     * Pair format: Underscore (ETH_USDT, BTC_ETH)
     */
    _initializeGateioPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'GT_ETH_1', pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'BTC_ETH', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_ETH_2', pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'SOL_ETH', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'GT_ETH_3', pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'XRP_ETH', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] },
                { id: 'GT_ETH_4', pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'ADA_ETH', side: 'buy' }, { pair: 'ADA_USDT', side: 'sell' }] },
                { id: 'GT_ETH_5', pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'MATIC_ETH', side: 'buy' }, { pair: 'MATIC_USDT', side: 'sell' }] },
                { id: 'GT_ETH_6', pairs: ['ETH_USDT', 'LINK_ETH', 'LINK_USDT'], sequence: 'USDT → ETH → LINK → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'LINK_ETH', side: 'buy' }, { pair: 'LINK_USDT', side: 'sell' }] },
                { id: 'GT_ETH_7', pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'AVAX_ETH', side: 'buy' }, { pair: 'AVAX_USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'GT_BTC_1', pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ETH_BTC', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'GT_BTC_2', pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'SOL_BTC', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'GT_BTC_3', pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'LTC_BTC', side: 'buy' }, { pair: 'LTC_USDT', side: 'sell' }] },
                { id: 'GT_BTC_4', pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'DOT_BTC', side: 'buy' }, { pair: 'DOT_USDT', side: 'sell' }] },
                { id: 'GT_BTC_5', pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ATOM_BTC', side: 'buy' }, { pair: 'ATOM_USDT', side: 'sell' }] },
                { id: 'GT_BTC_6', pairs: ['BTC_USDT', 'UNI_BTC', 'UNI_USDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'UNI_BTC', side: 'buy' }, { pair: 'UNI_USDT', side: 'sell' }] },
                { id: 'GT_BTC_7', pairs: ['BTC_USDT', 'BCH_BTC', 'BCH_USDT'], sequence: 'USDT → BTC → BCH → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'BCH_BTC', side: 'buy' }, { pair: 'BCH_USDT', side: 'sell' }] }
            ],
            SET_3_GT_NATIVE_BRIDGE: [
                { id: 'GT_GT_1', pairs: ['GT_USDT', 'BTC_GT', 'BTC_USDT'], sequence: 'USDT → GT → BTC → USDT', steps: [{ pair: 'GT_USDT', side: 'buy' }, { pair: 'BTC_GT', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_GT_2', pairs: ['GT_USDT', 'ETH_GT', 'ETH_USDT'], sequence: 'USDT → GT → ETH → USDT', steps: [{ pair: 'GT_USDT', side: 'buy' }, { pair: 'ETH_GT', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'GT_GT_3', pairs: ['GT_USDT', 'SOL_GT', 'SOL_USDT'], sequence: 'USDT → GT → SOL → USDT', steps: [{ pair: 'GT_USDT', side: 'buy' }, { pair: 'SOL_GT', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'GT_GT_4', pairs: ['BTC_USDT', 'GT_BTC', 'GT_USDT'], sequence: 'USDT → BTC → GT → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'GT_BTC', side: 'buy' }, { pair: 'GT_USDT', side: 'sell' }] },
                { id: 'GT_GT_5', pairs: ['ETH_USDT', 'GT_ETH', 'GT_USDT'], sequence: 'USDT → ETH → GT → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'GT_ETH', side: 'buy' }, { pair: 'GT_USDT', side: 'sell' }] },
                { id: 'GT_GT_6', pairs: ['GT_USDT', 'TRX_GT', 'TRX_USDT'], sequence: 'USDT → GT → TRX → USDT', steps: [{ pair: 'GT_USDT', side: 'buy' }, { pair: 'TRX_GT', side: 'buy' }, { pair: 'TRX_USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'GT_VOL_1', pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGE_USDT', side: 'buy' }, { pair: 'BTC_DOGE', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_VOL_2', pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB_USDT', side: 'buy' }, { pair: 'ETH_SHIB', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'GT_VOL_3', pairs: ['FTM_USDT', 'BTC_FTM', 'BTC_USDT'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTM_USDT', side: 'buy' }, { pair: 'BTC_FTM', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_VOL_4', pairs: ['SAND_USDT', 'ETH_SAND', 'ETH_USDT'], sequence: 'USDT → SAND → ETH → USDT', steps: [{ pair: 'SAND_USDT', side: 'buy' }, { pair: 'ETH_SAND', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'GT_VOL_5', pairs: ['MANA_USDT', 'BTC_MANA', 'BTC_USDT'], sequence: 'USDT → MANA → BTC → USDT', steps: [{ pair: 'MANA_USDT', side: 'buy' }, { pair: 'BTC_MANA', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_VOL_6', pairs: ['APE_USDT', 'ETH_APE', 'ETH_USDT'], sequence: 'USDT → APE → ETH → USDT', steps: [{ pair: 'APE_USDT', side: 'buy' }, { pair: 'ETH_APE', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'GT_EXT_1', pairs: ['SOL_USDT', 'ETH_SOL', 'ETH_USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL_USDT', side: 'buy' }, { pair: 'ETH_SOL', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'GT_EXT_2', pairs: ['XRP_USDT', 'BTC_XRP', 'BTC_USDT'], sequence: 'USDT → XRP → BTC → USDT', steps: [{ pair: 'XRP_USDT', side: 'buy' }, { pair: 'BTC_XRP', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_EXT_3', pairs: ['TRX_USDT', 'BTC_TRX', 'BTC_USDT'], sequence: 'USDT → TRX → BTC → USDT', steps: [{ pair: 'TRX_USDT', side: 'buy' }, { pair: 'BTC_TRX', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'GT_EXT_4', pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADA_USDT', side: 'buy' }, { pair: 'BTC_ADA', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Crypto.com path definitions (30 paths, 5 sets)
     * Pair format: Underscore (ETH_USDT, BTC_ETH)
     */
    _initializeCryptocomPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'CDC_ETH_1', pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'BTC_ETH', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_ETH_2', pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'SOL_ETH', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'CDC_ETH_3', pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'XRP_ETH', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] },
                { id: 'CDC_ETH_4', pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'ADA_ETH', side: 'buy' }, { pair: 'ADA_USDT', side: 'sell' }] },
                { id: 'CDC_ETH_5', pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'MATIC_ETH', side: 'buy' }, { pair: 'MATIC_USDT', side: 'sell' }] },
                { id: 'CDC_ETH_6', pairs: ['ETH_USDT', 'DOT_ETH', 'DOT_USDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'DOT_ETH', side: 'buy' }, { pair: 'DOT_USDT', side: 'sell' }] },
                { id: 'CDC_ETH_7', pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'AVAX_ETH', side: 'buy' }, { pair: 'AVAX_USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'CDC_BTC_1', pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ETH_BTC', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'CDC_BTC_2', pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'SOL_BTC', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'CDC_BTC_3', pairs: ['BTC_USDT', 'ADA_BTC', 'ADA_USDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ADA_BTC', side: 'buy' }, { pair: 'ADA_USDT', side: 'sell' }] },
                { id: 'CDC_BTC_4', pairs: ['BTC_USDT', 'DOT_BTC', 'DOT_USDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'DOT_BTC', side: 'buy' }, { pair: 'DOT_USDT', side: 'sell' }] },
                { id: 'CDC_BTC_5', pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ATOM_BTC', side: 'buy' }, { pair: 'ATOM_USDT', side: 'sell' }] },
                { id: 'CDC_BTC_6', pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'LTC_BTC', side: 'buy' }, { pair: 'LTC_USDT', side: 'sell' }] },
                { id: 'CDC_BTC_7', pairs: ['BTC_USDT', 'XRP_BTC', 'XRP_USDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'XRP_BTC', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] }
            ],
            SET_3_CRO_NATIVE_BRIDGE: [
                { id: 'CDC_CRO_1', pairs: ['CRO_USDT', 'BTC_CRO', 'BTC_USDT'], sequence: 'USDT → CRO → BTC → USDT', steps: [{ pair: 'CRO_USDT', side: 'buy' }, { pair: 'BTC_CRO', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_CRO_2', pairs: ['CRO_USDT', 'ETH_CRO', 'ETH_USDT'], sequence: 'USDT → CRO → ETH → USDT', steps: [{ pair: 'CRO_USDT', side: 'buy' }, { pair: 'ETH_CRO', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'CDC_CRO_3', pairs: ['CRO_USDT', 'SOL_CRO', 'SOL_USDT'], sequence: 'USDT → CRO → SOL → USDT', steps: [{ pair: 'CRO_USDT', side: 'buy' }, { pair: 'SOL_CRO', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'CDC_CRO_4', pairs: ['BTC_USDT', 'CRO_BTC', 'CRO_USDT'], sequence: 'USDT → BTC → CRO → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'CRO_BTC', side: 'buy' }, { pair: 'CRO_USDT', side: 'sell' }] },
                { id: 'CDC_CRO_5', pairs: ['ETH_USDT', 'CRO_ETH', 'CRO_USDT'], sequence: 'USDT → ETH → CRO → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'CRO_ETH', side: 'buy' }, { pair: 'CRO_USDT', side: 'sell' }] },
                { id: 'CDC_CRO_6', pairs: ['CRO_USDT', 'MATIC_CRO', 'MATIC_USDT'], sequence: 'USDT → CRO → MATIC → USDT', steps: [{ pair: 'CRO_USDT', side: 'buy' }, { pair: 'MATIC_CRO', side: 'buy' }, { pair: 'MATIC_USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'CDC_VOL_1', pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGE_USDT', side: 'buy' }, { pair: 'BTC_DOGE', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_VOL_2', pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB_USDT', side: 'buy' }, { pair: 'ETH_SHIB', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'CDC_VOL_3', pairs: ['MATIC_USDT', 'BTC_MATIC', 'BTC_USDT'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'MATIC_USDT', side: 'buy' }, { pair: 'BTC_MATIC', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_VOL_4', pairs: ['SOL_USDT', 'ETH_SOL', 'ETH_USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL_USDT', side: 'buy' }, { pair: 'ETH_SOL', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'CDC_VOL_5', pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADA_USDT', side: 'buy' }, { pair: 'BTC_ADA', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_VOL_6', pairs: ['DOT_USDT', 'ETH_DOT', 'ETH_USDT'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'DOT_USDT', side: 'buy' }, { pair: 'ETH_DOT', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'CDC_EXT_1', pairs: ['SOL_USDT', 'BTC_SOL', 'BTC_USDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOL_USDT', side: 'buy' }, { pair: 'BTC_SOL', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_EXT_2', pairs: ['XRP_USDT', 'ETH_XRP', 'ETH_USDT'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'XRP_USDT', side: 'buy' }, { pair: 'ETH_XRP', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'CDC_EXT_3', pairs: ['AVAX_USDT', 'BTC_AVAX', 'BTC_USDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAX_USDT', side: 'buy' }, { pair: 'BTC_AVAX', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'CDC_EXT_4', pairs: ['ATOM_USDT', 'ETH_ATOM', 'ETH_USDT'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'ATOM_USDT', side: 'buy' }, { pair: 'ETH_ATOM', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize MEXC path definitions (30 paths, 5 sets)
     * Pair format: No separator (ETHUSDT, BTCETH)
     */
    _initializeMexcPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'MEXC_ETH_1', pairs: ['ETHUSDT', 'BTCETH', 'BTCUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'BTCETH', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_ETH_2', pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'MEXC_ETH_3', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'MEXC_ETH_4', pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'MEXC_ETH_5', pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'MEXC_ETH_6', pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'MEXC_ETH_7', pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'AVAXETH', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'MEXC_BTC_1', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'MEXC_BTC_2', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'MEXC_BTC_3', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'MEXC_BTC_4', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'MEXC_BTC_5', pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] },
                { id: 'MEXC_BTC_6', pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'MEXC_BTC_7', pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'buy' }, { pair: 'UNIUSDT', side: 'sell' }] }
            ],
            SET_3_MX_NATIVE_BRIDGE: [
                { id: 'MEXC_MX_1', pairs: ['MXUSDT', 'BTCMX', 'BTCUSDT'], sequence: 'USDT → MX → BTC → USDT', steps: [{ pair: 'MXUSDT', side: 'buy' }, { pair: 'BTCMX', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_MX_2', pairs: ['MXUSDT', 'ETHMX', 'ETHUSDT'], sequence: 'USDT → MX → ETH → USDT', steps: [{ pair: 'MXUSDT', side: 'buy' }, { pair: 'ETHMX', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'MEXC_MX_3', pairs: ['MXUSDT', 'SOLMX', 'SOLUSDT'], sequence: 'USDT → MX → SOL → USDT', steps: [{ pair: 'MXUSDT', side: 'buy' }, { pair: 'SOLMX', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'MEXC_MX_4', pairs: ['BTCUSDT', 'MXBTC', 'MXUSDT'], sequence: 'USDT → BTC → MX → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'MXBTC', side: 'buy' }, { pair: 'MXUSDT', side: 'sell' }] },
                { id: 'MEXC_MX_5', pairs: ['ETHUSDT', 'MXETH', 'MXUSDT'], sequence: 'USDT → ETH → MX → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'MXETH', side: 'buy' }, { pair: 'MXUSDT', side: 'sell' }] },
                { id: 'MEXC_MX_6', pairs: ['MXUSDT', 'BNBMX', 'BNBUSDT'], sequence: 'USDT → MX → BNB → USDT', steps: [{ pair: 'MXUSDT', side: 'buy' }, { pair: 'BNBMX', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'MEXC_VOL_1', pairs: ['DOGEUSDT', 'BTCDOGE', 'BTCUSDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'BTCDOGE', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_VOL_2', pairs: ['SHIBUSDT', 'ETHSHIB', 'ETHUSDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'ETHSHIB', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'MEXC_VOL_3', pairs: ['PEPEUSDT', 'ETHPEPE', 'ETHUSDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPEUSDT', side: 'buy' }, { pair: 'ETHPEPE', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'MEXC_VOL_4', pairs: ['FLOKIUSDT', 'BTCFLOKI', 'BTCUSDT'], sequence: 'USDT → FLOKI → BTC → USDT', steps: [{ pair: 'FLOKIUSDT', side: 'buy' }, { pair: 'BTCFLOKI', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_VOL_5', pairs: ['TONUSDT', 'ETHTON', 'ETHUSDT'], sequence: 'USDT → TON → ETH → USDT', steps: [{ pair: 'TONUSDT', side: 'buy' }, { pair: 'ETHTON', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'MEXC_VOL_6', pairs: ['SUIUSDT', 'BTCSUI', 'BTCUSDT'], sequence: 'USDT → SUI → BTC → USDT', steps: [{ pair: 'SUIUSDT', side: 'buy' }, { pair: 'BTCSUI', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'MEXC_EXT_1', pairs: ['SOLUSDT', 'BTCSOL', 'BTCUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'BTCSOL', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_EXT_2', pairs: ['ADAUSDT', 'BTCADA', 'BTCUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'BTCADA', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_EXT_3', pairs: ['AVAXUSDT', 'BTCAVAX', 'BTCUSDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'BTCAVAX', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'MEXC_EXT_4', pairs: ['MATICUSDT', 'ETHMATIC', 'ETHUSDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'ETHMATIC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize XT path definitions (32 paths, 5 sets)
     * Pair format: Lowercase underscore (eth_usdt, btc_eth)
     */
    _initializeXtPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'XT_ETH_1', pairs: ['eth_usdt', 'btc_eth', 'btc_usdt'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'btc_eth', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_ETH_2', pairs: ['eth_usdt', 'sol_eth', 'sol_usdt'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'sol_eth', side: 'buy' }, { pair: 'sol_usdt', side: 'sell' }] },
                { id: 'XT_ETH_3', pairs: ['eth_usdt', 'xrp_eth', 'xrp_usdt'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'xrp_eth', side: 'buy' }, { pair: 'xrp_usdt', side: 'sell' }] },
                { id: 'XT_ETH_4', pairs: ['eth_usdt', 'ada_eth', 'ada_usdt'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'ada_eth', side: 'buy' }, { pair: 'ada_usdt', side: 'sell' }] },
                { id: 'XT_ETH_5', pairs: ['eth_usdt', 'matic_eth', 'matic_usdt'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'matic_eth', side: 'buy' }, { pair: 'matic_usdt', side: 'sell' }] },
                { id: 'XT_ETH_6', pairs: ['eth_usdt', 'dot_eth', 'dot_usdt'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'dot_eth', side: 'buy' }, { pair: 'dot_usdt', side: 'sell' }] },
                { id: 'XT_ETH_7', pairs: ['eth_usdt', 'avax_eth', 'avax_usdt'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'avax_eth', side: 'buy' }, { pair: 'avax_usdt', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'XT_BTC_1', pairs: ['btc_usdt', 'eth_btc', 'eth_usdt'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'eth_btc', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] },
                { id: 'XT_BTC_2', pairs: ['btc_usdt', 'sol_btc', 'sol_usdt'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'sol_btc', side: 'buy' }, { pair: 'sol_usdt', side: 'sell' }] },
                { id: 'XT_BTC_3', pairs: ['btc_usdt', 'ada_btc', 'ada_usdt'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'ada_btc', side: 'buy' }, { pair: 'ada_usdt', side: 'sell' }] },
                { id: 'XT_BTC_4', pairs: ['btc_usdt', 'dot_btc', 'dot_usdt'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'dot_btc', side: 'buy' }, { pair: 'dot_usdt', side: 'sell' }] },
                { id: 'XT_BTC_5', pairs: ['btc_usdt', 'atom_btc', 'atom_usdt'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'atom_btc', side: 'buy' }, { pair: 'atom_usdt', side: 'sell' }] },
                { id: 'XT_BTC_6', pairs: ['btc_usdt', 'ltc_btc', 'ltc_usdt'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'ltc_btc', side: 'buy' }, { pair: 'ltc_usdt', side: 'sell' }] },
                { id: 'XT_BTC_7', pairs: ['btc_usdt', 'xrp_btc', 'xrp_usdt'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'xrp_btc', side: 'buy' }, { pair: 'xrp_usdt', side: 'sell' }] }
            ],
            SET_3_XT_NATIVE_BRIDGE: [
                { id: 'XT_XT_1', pairs: ['xt_usdt', 'btc_xt', 'btc_usdt'], sequence: 'USDT → XT → BTC → USDT', steps: [{ pair: 'xt_usdt', side: 'buy' }, { pair: 'btc_xt', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_XT_2', pairs: ['xt_usdt', 'eth_xt', 'eth_usdt'], sequence: 'USDT → XT → ETH → USDT', steps: [{ pair: 'xt_usdt', side: 'buy' }, { pair: 'eth_xt', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] },
                { id: 'XT_XT_3', pairs: ['xt_usdt', 'sol_xt', 'sol_usdt'], sequence: 'USDT → XT → SOL → USDT', steps: [{ pair: 'xt_usdt', side: 'buy' }, { pair: 'sol_xt', side: 'buy' }, { pair: 'sol_usdt', side: 'sell' }] },
                { id: 'XT_XT_4', pairs: ['btc_usdt', 'xt_btc', 'xt_usdt'], sequence: 'USDT → BTC → XT → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'xt_btc', side: 'buy' }, { pair: 'xt_usdt', side: 'sell' }] },
                { id: 'XT_XT_5', pairs: ['eth_usdt', 'xt_eth', 'xt_usdt'], sequence: 'USDT → ETH → XT → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'xt_eth', side: 'buy' }, { pair: 'xt_usdt', side: 'sell' }] },
                { id: 'XT_XT_6', pairs: ['xt_usdt', 'matic_xt', 'matic_usdt'], sequence: 'USDT → XT → MATIC → USDT', steps: [{ pair: 'xt_usdt', side: 'buy' }, { pair: 'matic_xt', side: 'buy' }, { pair: 'matic_usdt', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'XT_VOL_1', pairs: ['doge_usdt', 'btc_doge', 'btc_usdt'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'doge_usdt', side: 'buy' }, { pair: 'btc_doge', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_VOL_2', pairs: ['shib_usdt', 'eth_shib', 'eth_usdt'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'shib_usdt', side: 'buy' }, { pair: 'eth_shib', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] },
                { id: 'XT_VOL_3', pairs: ['matic_usdt', 'btc_matic', 'btc_usdt'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'matic_usdt', side: 'buy' }, { pair: 'btc_matic', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_VOL_4', pairs: ['sol_usdt', 'eth_sol', 'eth_usdt'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'sol_usdt', side: 'buy' }, { pair: 'eth_sol', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] },
                { id: 'XT_VOL_5', pairs: ['ada_usdt', 'btc_ada', 'btc_usdt'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ada_usdt', side: 'buy' }, { pair: 'btc_ada', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_VOL_6', pairs: ['dot_usdt', 'eth_dot', 'eth_usdt'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'dot_usdt', side: 'buy' }, { pair: 'eth_dot', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'XT_EXT_1', pairs: ['sol_usdt', 'btc_sol', 'btc_usdt'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'sol_usdt', side: 'buy' }, { pair: 'btc_sol', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_EXT_2', pairs: ['xrp_usdt', 'eth_xrp', 'eth_usdt'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'xrp_usdt', side: 'buy' }, { pair: 'eth_xrp', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] },
                { id: 'XT_EXT_3', pairs: ['avax_usdt', 'btc_avax', 'btc_usdt'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'avax_usdt', side: 'buy' }, { pair: 'btc_avax', side: 'buy' }, { pair: 'btc_usdt', side: 'sell' }] },
                { id: 'XT_EXT_4', pairs: ['atom_usdt', 'eth_atom', 'eth_usdt'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'atom_usdt', side: 'buy' }, { pair: 'eth_atom', side: 'buy' }, { pair: 'eth_usdt', side: 'sell' }] },
                { id: 'XT_EXT_5', pairs: ['btc_usdt', 'eth_btc', 'sol_eth', 'sol_usdt'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'btc_usdt', side: 'buy' }, { pair: 'eth_btc', side: 'buy' }, { pair: 'sol_eth', side: 'buy' }, { pair: 'sol_usdt', side: 'sell' }] },
                { id: 'XT_EXT_6', pairs: ['eth_usdt', 'btc_eth', 'ada_btc', 'ada_usdt'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'eth_usdt', side: 'buy' }, { pair: 'btc_eth', side: 'buy' }, { pair: 'ada_btc', side: 'buy' }, { pair: 'ada_usdt', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize AscendEX path definitions (32 paths, 5 sets)
     * Pair format: Slash (ETH/USDT, BTC/ETH)
     */
    _initializeAscendexPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'ASCENDEX_ETH_1', pairs: ['ETH/USDT', 'BTC/ETH', 'BTC/USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'BTC/ETH', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ETH_2', pairs: ['ETH/USDT', 'SOL/ETH', 'SOL/USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'SOL/ETH', side: 'buy' }, { pair: 'SOL/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ETH_3', pairs: ['ETH/USDT', 'XRP/ETH', 'XRP/USDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'XRP/ETH', side: 'buy' }, { pair: 'XRP/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ETH_4', pairs: ['ETH/USDT', 'ADA/ETH', 'ADA/USDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'ADA/ETH', side: 'buy' }, { pair: 'ADA/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ETH_5', pairs: ['ETH/USDT', 'MATIC/ETH', 'MATIC/USDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'MATIC/ETH', side: 'buy' }, { pair: 'MATIC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ETH_6', pairs: ['ETH/USDT', 'DOT/ETH', 'DOT/USDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'DOT/ETH', side: 'buy' }, { pair: 'DOT/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ETH_7', pairs: ['ETH/USDT', 'AVAX/ETH', 'AVAX/USDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'AVAX/ETH', side: 'buy' }, { pair: 'AVAX/USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'ASCENDEX_BTC_1', pairs: ['BTC/USDT', 'ETH/BTC', 'ETH/USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'ETH/BTC', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_BTC_2', pairs: ['BTC/USDT', 'SOL/BTC', 'SOL/USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'SOL/BTC', side: 'buy' }, { pair: 'SOL/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_BTC_3', pairs: ['BTC/USDT', 'ADA/BTC', 'ADA/USDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'ADA/BTC', side: 'buy' }, { pair: 'ADA/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_BTC_4', pairs: ['BTC/USDT', 'DOT/BTC', 'DOT/USDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'DOT/BTC', side: 'buy' }, { pair: 'DOT/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_BTC_5', pairs: ['BTC/USDT', 'ATOM/BTC', 'ATOM/USDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'ATOM/BTC', side: 'buy' }, { pair: 'ATOM/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_BTC_6', pairs: ['BTC/USDT', 'LTC/BTC', 'LTC/USDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'LTC/BTC', side: 'buy' }, { pair: 'LTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_BTC_7', pairs: ['BTC/USDT', 'XRP/BTC', 'XRP/USDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'XRP/BTC', side: 'buy' }, { pair: 'XRP/USDT', side: 'sell' }] }
            ],
            SET_3_ASD_NATIVE_BRIDGE: [
                { id: 'ASCENDEX_ASD_1', pairs: ['ASD/USDT', 'BTC/ASD', 'BTC/USDT'], sequence: 'USDT → ASD → BTC → USDT', steps: [{ pair: 'ASD/USDT', side: 'buy' }, { pair: 'BTC/ASD', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ASD_2', pairs: ['ASD/USDT', 'ETH/ASD', 'ETH/USDT'], sequence: 'USDT → ASD → ETH → USDT', steps: [{ pair: 'ASD/USDT', side: 'buy' }, { pair: 'ETH/ASD', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ASD_3', pairs: ['ASD/USDT', 'SOL/ASD', 'SOL/USDT'], sequence: 'USDT → ASD → SOL → USDT', steps: [{ pair: 'ASD/USDT', side: 'buy' }, { pair: 'SOL/ASD', side: 'buy' }, { pair: 'SOL/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ASD_4', pairs: ['BTC/USDT', 'ASD/BTC', 'ASD/USDT'], sequence: 'USDT → BTC → ASD → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'ASD/BTC', side: 'buy' }, { pair: 'ASD/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ASD_5', pairs: ['ETH/USDT', 'ASD/ETH', 'ASD/USDT'], sequence: 'USDT → ETH → ASD → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'ASD/ETH', side: 'buy' }, { pair: 'ASD/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_ASD_6', pairs: ['ASD/USDT', 'MATIC/ASD', 'MATIC/USDT'], sequence: 'USDT → ASD → MATIC → USDT', steps: [{ pair: 'ASD/USDT', side: 'buy' }, { pair: 'MATIC/ASD', side: 'buy' }, { pair: 'MATIC/USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'ASCENDEX_VOL_1', pairs: ['DOGE/USDT', 'BTC/DOGE', 'BTC/USDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGE/USDT', side: 'buy' }, { pair: 'BTC/DOGE', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_VOL_2', pairs: ['SHIB/USDT', 'ETH/SHIB', 'ETH/USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB/USDT', side: 'buy' }, { pair: 'ETH/SHIB', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_VOL_3', pairs: ['MATIC/USDT', 'BTC/MATIC', 'BTC/USDT'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'MATIC/USDT', side: 'buy' }, { pair: 'BTC/MATIC', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_VOL_4', pairs: ['SOL/USDT', 'ETH/SOL', 'ETH/USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL/USDT', side: 'buy' }, { pair: 'ETH/SOL', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_VOL_5', pairs: ['ADA/USDT', 'BTC/ADA', 'BTC/USDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADA/USDT', side: 'buy' }, { pair: 'BTC/ADA', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_VOL_6', pairs: ['DOT/USDT', 'ETH/DOT', 'ETH/USDT'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'DOT/USDT', side: 'buy' }, { pair: 'ETH/DOT', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'ASCENDEX_EXT_1', pairs: ['SOL/USDT', 'BTC/SOL', 'BTC/USDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOL/USDT', side: 'buy' }, { pair: 'BTC/SOL', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_EXT_2', pairs: ['XRP/USDT', 'ETH/XRP', 'ETH/USDT'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'XRP/USDT', side: 'buy' }, { pair: 'ETH/XRP', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_EXT_3', pairs: ['AVAX/USDT', 'BTC/AVAX', 'BTC/USDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAX/USDT', side: 'buy' }, { pair: 'BTC/AVAX', side: 'buy' }, { pair: 'BTC/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_EXT_4', pairs: ['ATOM/USDT', 'ETH/ATOM', 'ETH/USDT'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'ATOM/USDT', side: 'buy' }, { pair: 'ETH/ATOM', side: 'buy' }, { pair: 'ETH/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_EXT_5', pairs: ['BTC/USDT', 'ETH/BTC', 'SOL/ETH', 'SOL/USDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTC/USDT', side: 'buy' }, { pair: 'ETH/BTC', side: 'buy' }, { pair: 'SOL/ETH', side: 'buy' }, { pair: 'SOL/USDT', side: 'sell' }] },
                { id: 'ASCENDEX_EXT_6', pairs: ['ETH/USDT', 'BTC/ETH', 'ADA/BTC', 'ADA/USDT'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'ETH/USDT', side: 'buy' }, { pair: 'BTC/ETH', side: 'buy' }, { pair: 'ADA/BTC', side: 'buy' }, { pair: 'ADA/USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize BingX path definitions (32 paths, 5 sets)
     * Pair format: Hyphenated (ETH-USDT, BTC-ETH)
     */
    _initializeBingxPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'BINGX_ETH_1', pairs: ['ETH-USDT', 'BTC-ETH', 'BTC-USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'BTC-ETH', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_ETH_2', pairs: ['ETH-USDT', 'SOL-ETH', 'SOL-USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'BINGX_ETH_3', pairs: ['ETH-USDT', 'XRP-ETH', 'XRP-USDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'XRP-ETH', side: 'buy' }, { pair: 'XRP-USDT', side: 'sell' }] },
                { id: 'BINGX_ETH_4', pairs: ['ETH-USDT', 'ADA-ETH', 'ADA-USDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'ADA-ETH', side: 'buy' }, { pair: 'ADA-USDT', side: 'sell' }] },
                { id: 'BINGX_ETH_5', pairs: ['ETH-USDT', 'MATIC-ETH', 'MATIC-USDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'MATIC-ETH', side: 'buy' }, { pair: 'MATIC-USDT', side: 'sell' }] },
                { id: 'BINGX_ETH_6', pairs: ['ETH-USDT', 'DOT-ETH', 'DOT-USDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'DOT-ETH', side: 'buy' }, { pair: 'DOT-USDT', side: 'sell' }] },
                { id: 'BINGX_ETH_7', pairs: ['ETH-USDT', 'AVAX-ETH', 'AVAX-USDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'AVAX-ETH', side: 'buy' }, { pair: 'AVAX-USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'BINGX_BTC_1', pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'BINGX_BTC_2', pairs: ['BTC-USDT', 'SOL-BTC', 'SOL-USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'SOL-BTC', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'BINGX_BTC_3', pairs: ['BTC-USDT', 'XRP-BTC', 'XRP-USDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'XRP-BTC', side: 'buy' }, { pair: 'XRP-USDT', side: 'sell' }] },
                { id: 'BINGX_BTC_4', pairs: ['BTC-USDT', 'ADA-BTC', 'ADA-USDT'], sequence: 'USDT → BTC → ADA → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ADA-BTC', side: 'buy' }, { pair: 'ADA-USDT', side: 'sell' }] },
                { id: 'BINGX_BTC_5', pairs: ['BTC-USDT', 'DOT-BTC', 'DOT-USDT'], sequence: 'USDT → BTC → DOT → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'DOT-BTC', side: 'buy' }, { pair: 'DOT-USDT', side: 'sell' }] },
                { id: 'BINGX_BTC_6', pairs: ['BTC-USDT', 'LTC-BTC', 'LTC-USDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'LTC-BTC', side: 'buy' }, { pair: 'LTC-USDT', side: 'sell' }] },
                { id: 'BINGX_BTC_7', pairs: ['BTC-USDT', 'ATOM-BTC', 'ATOM-USDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ATOM-BTC', side: 'buy' }, { pair: 'ATOM-USDT', side: 'sell' }] }
            ],
            SET_3_SOL_HIGH_LIQUIDITY: [
                { id: 'BINGX_SOL_1', pairs: ['SOL-USDT', 'BTC-SOL', 'BTC-USDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'BTC-SOL', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_SOL_2', pairs: ['SOL-USDT', 'ETH-SOL', 'ETH-USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'ETH-SOL', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'BINGX_SOL_3', pairs: ['SOL-USDT', 'XRP-SOL', 'XRP-USDT'], sequence: 'USDT → SOL → XRP → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'XRP-SOL', side: 'buy' }, { pair: 'XRP-USDT', side: 'sell' }] },
                { id: 'BINGX_SOL_4', pairs: ['BTC-USDT', 'SOL-BTC', 'SOL-USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'SOL-BTC', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'BINGX_SOL_5', pairs: ['ETH-USDT', 'SOL-ETH', 'SOL-USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'BINGX_SOL_6', pairs: ['SOL-USDT', 'MATIC-SOL', 'MATIC-USDT'], sequence: 'USDT → SOL → MATIC → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'MATIC-SOL', side: 'buy' }, { pair: 'MATIC-USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'BINGX_VOL_1', pairs: ['DOGE-USDT', 'BTC-DOGE', 'BTC-USDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGE-USDT', side: 'buy' }, { pair: 'BTC-DOGE', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_VOL_2', pairs: ['SHIB-USDT', 'ETH-SHIB', 'ETH-USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB-USDT', side: 'buy' }, { pair: 'ETH-SHIB', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'BINGX_VOL_3', pairs: ['MATIC-USDT', 'BTC-MATIC', 'BTC-USDT'], sequence: 'USDT → MATIC → BTC → USDT', steps: [{ pair: 'MATIC-USDT', side: 'buy' }, { pair: 'BTC-MATIC', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_VOL_4', pairs: ['SOL-USDT', 'ETH-SOL', 'ETH-USDT'], sequence: 'USDT → SOL → ETH → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'ETH-SOL', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'BINGX_VOL_5', pairs: ['ADA-USDT', 'BTC-ADA', 'BTC-USDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADA-USDT', side: 'buy' }, { pair: 'BTC-ADA', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_VOL_6', pairs: ['DOT-USDT', 'ETH-DOT', 'ETH-USDT'], sequence: 'USDT → DOT → ETH → USDT', steps: [{ pair: 'DOT-USDT', side: 'buy' }, { pair: 'ETH-DOT', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'BINGX_EXT_1', pairs: ['SOL-USDT', 'BTC-SOL', 'BTC-USDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOL-USDT', side: 'buy' }, { pair: 'BTC-SOL', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_EXT_2', pairs: ['XRP-USDT', 'ETH-XRP', 'ETH-USDT'], sequence: 'USDT → XRP → ETH → USDT', steps: [{ pair: 'XRP-USDT', side: 'buy' }, { pair: 'ETH-XRP', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'BINGX_EXT_3', pairs: ['AVAX-USDT', 'BTC-AVAX', 'BTC-USDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAX-USDT', side: 'buy' }, { pair: 'BTC-AVAX', side: 'buy' }, { pair: 'BTC-USDT', side: 'sell' }] },
                { id: 'BINGX_EXT_4', pairs: ['ATOM-USDT', 'ETH-ATOM', 'ETH-USDT'], sequence: 'USDT → ATOM → ETH → USDT', steps: [{ pair: 'ATOM-USDT', side: 'buy' }, { pair: 'ETH-ATOM', side: 'buy' }, { pair: 'ETH-USDT', side: 'sell' }] },
                { id: 'BINGX_EXT_5', pairs: ['BTC-USDT', 'ETH-BTC', 'SOL-ETH', 'SOL-USDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTC-USDT', side: 'buy' }, { pair: 'ETH-BTC', side: 'buy' }, { pair: 'SOL-ETH', side: 'buy' }, { pair: 'SOL-USDT', side: 'sell' }] },
                { id: 'BINGX_EXT_6', pairs: ['ETH-USDT', 'BTC-ETH', 'ADA-BTC', 'ADA-USDT'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'ETH-USDT', side: 'buy' }, { pair: 'BTC-ETH', side: 'buy' }, { pair: 'ADA-BTC', side: 'buy' }, { pair: 'ADA-USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Bitget path definitions (32 paths, 5 sets)
     * Pair format: Suffix _SPBL (ETHUSDT_SPBL, BTCUSDT_SPBL)
     */
    _initializeBitgetPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'BITGET_ETH_1', pairs: ['ETHUSDT_SPBL', 'BTCETH_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'BTCETH_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_ETH_2', pairs: ['ETHUSDT_SPBL', 'SOLETH_SPBL', 'SOLUSDT_SPBL'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'SOLETH_SPBL', side: 'buy' }, { pair: 'SOLUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_ETH_3', pairs: ['ETHUSDT_SPBL', 'XRPETH_SPBL', 'XRPUSDT_SPBL'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'XRPETH_SPBL', side: 'buy' }, { pair: 'XRPUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_ETH_4', pairs: ['ETHUSDT_SPBL', 'ADAETH_SPBL', 'ADAUSDT_SPBL'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'ADAETH_SPBL', side: 'buy' }, { pair: 'ADAUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_ETH_5', pairs: ['ETHUSDT_SPBL', 'MATICETH_SPBL', 'MATICUSDT_SPBL'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'MATICETH_SPBL', side: 'buy' }, { pair: 'MATICUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_ETH_6', pairs: ['ETHUSDT_SPBL', 'DOTETH_SPBL', 'DOTUSDT_SPBL'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'DOTETH_SPBL', side: 'buy' }, { pair: 'DOTUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_ETH_7', pairs: ['ETHUSDT_SPBL', 'AVAXETH_SPBL', 'AVAXUSDT_SPBL'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'AVAXETH_SPBL', side: 'buy' }, { pair: 'AVAXUSDT_SPBL', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'BITGET_BTC_1', pairs: ['BTCUSDT_SPBL', 'ETHBTC_SPBL', 'ETHUSDT_SPBL'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'ETHBTC_SPBL', side: 'buy' }, { pair: 'ETHUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BTC_2', pairs: ['BTCUSDT_SPBL', 'SOLBTC_SPBL', 'SOLUSDT_SPBL'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'SOLBTC_SPBL', side: 'buy' }, { pair: 'SOLUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BTC_3', pairs: ['BTCUSDT_SPBL', 'XRPBTC_SPBL', 'XRPUSDT_SPBL'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'XRPBTC_SPBL', side: 'buy' }, { pair: 'XRPUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BTC_4', pairs: ['BTCUSDT_SPBL', 'LTCBTC_SPBL', 'LTCUSDT_SPBL'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'LTCBTC_SPBL', side: 'buy' }, { pair: 'LTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BTC_5', pairs: ['BTCUSDT_SPBL', 'ATOMBTC_SPBL', 'ATOMUSDT_SPBL'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'ATOMBTC_SPBL', side: 'buy' }, { pair: 'ATOMUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BTC_6', pairs: ['BTCUSDT_SPBL', 'UNIBTC_SPBL', 'UNIUSDT_SPBL'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'UNIBTC_SPBL', side: 'buy' }, { pair: 'UNIUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BTC_7', pairs: ['BTCUSDT_SPBL', 'LINKBTC_SPBL', 'LINKUSDT_SPBL'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'LINKBTC_SPBL', side: 'buy' }, { pair: 'LINKUSDT_SPBL', side: 'sell' }] }
            ],
            SET_3_BGB_NATIVE_BRIDGE: [
                { id: 'BITGET_BGB_1', pairs: ['BGBUSDT_SPBL', 'BTCBGB_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → BGB → BTC → USDT', steps: [{ pair: 'BGBUSDT_SPBL', side: 'buy' }, { pair: 'BTCBGB_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BGB_2', pairs: ['BGBUSDT_SPBL', 'ETHBGB_SPBL', 'ETHUSDT_SPBL'], sequence: 'USDT → BGB → ETH → USDT', steps: [{ pair: 'BGBUSDT_SPBL', side: 'buy' }, { pair: 'ETHBGB_SPBL', side: 'buy' }, { pair: 'ETHUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BGB_3', pairs: ['BGBUSDT_SPBL', 'SOLBGB_SPBL', 'SOLUSDT_SPBL'], sequence: 'USDT → BGB → SOL → USDT', steps: [{ pair: 'BGBUSDT_SPBL', side: 'buy' }, { pair: 'SOLBGB_SPBL', side: 'buy' }, { pair: 'SOLUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BGB_4', pairs: ['BTCUSDT_SPBL', 'BGBBTC_SPBL', 'BGBUSDT_SPBL'], sequence: 'USDT → BTC → BGB → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'BGBBTC_SPBL', side: 'buy' }, { pair: 'BGBUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BGB_5', pairs: ['ETHUSDT_SPBL', 'BGBETH_SPBL', 'BGBUSDT_SPBL'], sequence: 'USDT → ETH → BGB → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'BGBETH_SPBL', side: 'buy' }, { pair: 'BGBUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_BGB_6', pairs: ['BGBUSDT_SPBL', 'XRPBGB_SPBL', 'XRPUSDT_SPBL'], sequence: 'USDT → BGB → XRP → USDT', steps: [{ pair: 'BGBUSDT_SPBL', side: 'buy' }, { pair: 'XRPBGB_SPBL', side: 'buy' }, { pair: 'XRPUSDT_SPBL', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'BITGET_VOL_1', pairs: ['DOGEUSDT_SPBL', 'BTCDOGE_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGEUSDT_SPBL', side: 'buy' }, { pair: 'BTCDOGE_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_VOL_2', pairs: ['SHIBUSDT_SPBL', 'ETHSHIB_SPBL', 'ETHUSDT_SPBL'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIBUSDT_SPBL', side: 'buy' }, { pair: 'ETHSHIB_SPBL', side: 'buy' }, { pair: 'ETHUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_VOL_3', pairs: ['PEPEUSDT_SPBL', 'ETHPEPE_SPBL', 'ETHUSDT_SPBL'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPEUSDT_SPBL', side: 'buy' }, { pair: 'ETHPEPE_SPBL', side: 'buy' }, { pair: 'ETHUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_VOL_4', pairs: ['NEARUSDT_SPBL', 'BTCNEAR_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEARUSDT_SPBL', side: 'buy' }, { pair: 'BTCNEAR_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_VOL_5', pairs: ['APTUSDT_SPBL', 'ETHAPT_SPBL', 'ETHUSDT_SPBL'], sequence: 'USDT → APT → ETH → USDT', steps: [{ pair: 'APTUSDT_SPBL', side: 'buy' }, { pair: 'ETHAPT_SPBL', side: 'buy' }, { pair: 'ETHUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_VOL_6', pairs: ['FTMUSDT_SPBL', 'BTCFTM_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTMUSDT_SPBL', side: 'buy' }, { pair: 'BTCFTM_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'BITGET_EXT_1', pairs: ['SOLUSDT_SPBL', 'BTCSOL_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT_SPBL', side: 'buy' }, { pair: 'BTCSOL_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_EXT_2', pairs: ['ADAUSDT_SPBL', 'BTCADA_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT_SPBL', side: 'buy' }, { pair: 'BTCADA_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_EXT_3', pairs: ['AVAXUSDT_SPBL', 'BTCAVAX_SPBL', 'BTCUSDT_SPBL'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT_SPBL', side: 'buy' }, { pair: 'BTCAVAX_SPBL', side: 'buy' }, { pair: 'BTCUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_EXT_4', pairs: ['MATICUSDT_SPBL', 'ETHMATIC_SPBL', 'ETHUSDT_SPBL'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATICUSDT_SPBL', side: 'buy' }, { pair: 'ETHMATIC_SPBL', side: 'buy' }, { pair: 'ETHUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_EXT_5', pairs: ['BTCUSDT_SPBL', 'ETHBTC_SPBL', 'SOLETH_SPBL', 'SOLUSDT_SPBL'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTCUSDT_SPBL', side: 'buy' }, { pair: 'ETHBTC_SPBL', side: 'buy' }, { pair: 'SOLETH_SPBL', side: 'buy' }, { pair: 'SOLUSDT_SPBL', side: 'sell' }] },
                { id: 'BITGET_EXT_6', pairs: ['ETHUSDT_SPBL', 'BTCETH_SPBL', 'ADABTC_SPBL', 'ADAUSDT_SPBL'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'ETHUSDT_SPBL', side: 'buy' }, { pair: 'BTCETH_SPBL', side: 'buy' }, { pair: 'ADABTC_SPBL', side: 'buy' }, { pair: 'ADAUSDT_SPBL', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize BitMart path definitions (32 paths, 5 sets)
     * Pair format: Underscore (ETH_USDT, BTC_ETH)
     */
    _initializeBitmartPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'BITMART_ETH_1', pairs: ['ETH_USDT', 'BTC_ETH', 'BTC_USDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'BTC_ETH', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_ETH_2', pairs: ['ETH_USDT', 'SOL_ETH', 'SOL_USDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'SOL_ETH', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'BITMART_ETH_3', pairs: ['ETH_USDT', 'XRP_ETH', 'XRP_USDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'XRP_ETH', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] },
                { id: 'BITMART_ETH_4', pairs: ['ETH_USDT', 'ADA_ETH', 'ADA_USDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'ADA_ETH', side: 'buy' }, { pair: 'ADA_USDT', side: 'sell' }] },
                { id: 'BITMART_ETH_5', pairs: ['ETH_USDT', 'MATIC_ETH', 'MATIC_USDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'MATIC_ETH', side: 'buy' }, { pair: 'MATIC_USDT', side: 'sell' }] },
                { id: 'BITMART_ETH_6', pairs: ['ETH_USDT', 'DOT_ETH', 'DOT_USDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'DOT_ETH', side: 'buy' }, { pair: 'DOT_USDT', side: 'sell' }] },
                { id: 'BITMART_ETH_7', pairs: ['ETH_USDT', 'AVAX_ETH', 'AVAX_USDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'AVAX_ETH', side: 'buy' }, { pair: 'AVAX_USDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'BITMART_BTC_1', pairs: ['BTC_USDT', 'ETH_BTC', 'ETH_USDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ETH_BTC', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'BITMART_BTC_2', pairs: ['BTC_USDT', 'SOL_BTC', 'SOL_USDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'SOL_BTC', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'BITMART_BTC_3', pairs: ['BTC_USDT', 'XRP_BTC', 'XRP_USDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'XRP_BTC', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] },
                { id: 'BITMART_BTC_4', pairs: ['BTC_USDT', 'LTC_BTC', 'LTC_USDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'LTC_BTC', side: 'buy' }, { pair: 'LTC_USDT', side: 'sell' }] },
                { id: 'BITMART_BTC_5', pairs: ['BTC_USDT', 'ATOM_BTC', 'ATOM_USDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ATOM_BTC', side: 'buy' }, { pair: 'ATOM_USDT', side: 'sell' }] },
                { id: 'BITMART_BTC_6', pairs: ['BTC_USDT', 'UNI_BTC', 'UNI_USDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'UNI_BTC', side: 'buy' }, { pair: 'UNI_USDT', side: 'sell' }] },
                { id: 'BITMART_BTC_7', pairs: ['BTC_USDT', 'LINK_BTC', 'LINK_USDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'LINK_BTC', side: 'buy' }, { pair: 'LINK_USDT', side: 'sell' }] }
            ],
            SET_3_BMX_NATIVE_BRIDGE: [
                { id: 'BITMART_BMX_1', pairs: ['BMX_USDT', 'BTC_BMX', 'BTC_USDT'], sequence: 'USDT → BMX → BTC → USDT', steps: [{ pair: 'BMX_USDT', side: 'buy' }, { pair: 'BTC_BMX', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_BMX_2', pairs: ['BMX_USDT', 'ETH_BMX', 'ETH_USDT'], sequence: 'USDT → BMX → ETH → USDT', steps: [{ pair: 'BMX_USDT', side: 'buy' }, { pair: 'ETH_BMX', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'BITMART_BMX_3', pairs: ['BMX_USDT', 'SOL_BMX', 'SOL_USDT'], sequence: 'USDT → BMX → SOL → USDT', steps: [{ pair: 'BMX_USDT', side: 'buy' }, { pair: 'SOL_BMX', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'BITMART_BMX_4', pairs: ['BTC_USDT', 'BMX_BTC', 'BMX_USDT'], sequence: 'USDT → BTC → BMX → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'BMX_BTC', side: 'buy' }, { pair: 'BMX_USDT', side: 'sell' }] },
                { id: 'BITMART_BMX_5', pairs: ['ETH_USDT', 'BMX_ETH', 'BMX_USDT'], sequence: 'USDT → ETH → BMX → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'BMX_ETH', side: 'buy' }, { pair: 'BMX_USDT', side: 'sell' }] },
                { id: 'BITMART_BMX_6', pairs: ['BMX_USDT', 'XRP_BMX', 'XRP_USDT'], sequence: 'USDT → BMX → XRP → USDT', steps: [{ pair: 'BMX_USDT', side: 'buy' }, { pair: 'XRP_BMX', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'BITMART_VOL_1', pairs: ['DOGE_USDT', 'BTC_DOGE', 'BTC_USDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGE_USDT', side: 'buy' }, { pair: 'BTC_DOGE', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_VOL_2', pairs: ['SHIB_USDT', 'ETH_SHIB', 'ETH_USDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIB_USDT', side: 'buy' }, { pair: 'ETH_SHIB', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'BITMART_VOL_3', pairs: ['PEPE_USDT', 'ETH_PEPE', 'ETH_USDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPE_USDT', side: 'buy' }, { pair: 'ETH_PEPE', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'BITMART_VOL_4', pairs: ['NEAR_USDT', 'BTC_NEAR', 'BTC_USDT'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEAR_USDT', side: 'buy' }, { pair: 'BTC_NEAR', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_VOL_5', pairs: ['APT_USDT', 'ETH_APT', 'ETH_USDT'], sequence: 'USDT → APT → ETH → USDT', steps: [{ pair: 'APT_USDT', side: 'buy' }, { pair: 'ETH_APT', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'BITMART_VOL_6', pairs: ['FTM_USDT', 'BTC_FTM', 'BTC_USDT'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTM_USDT', side: 'buy' }, { pair: 'BTC_FTM', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'BITMART_EXT_1', pairs: ['SOL_USDT', 'BTC_SOL', 'BTC_USDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOL_USDT', side: 'buy' }, { pair: 'BTC_SOL', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_EXT_2', pairs: ['ADA_USDT', 'BTC_ADA', 'BTC_USDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADA_USDT', side: 'buy' }, { pair: 'BTC_ADA', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_EXT_3', pairs: ['AVAX_USDT', 'BTC_AVAX', 'BTC_USDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAX_USDT', side: 'buy' }, { pair: 'BTC_AVAX', side: 'buy' }, { pair: 'BTC_USDT', side: 'sell' }] },
                { id: 'BITMART_EXT_4', pairs: ['MATIC_USDT', 'ETH_MATIC', 'ETH_USDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATIC_USDT', side: 'buy' }, { pair: 'ETH_MATIC', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] },
                { id: 'BITMART_EXT_5', pairs: ['BTC_USDT', 'ETH_BTC', 'SOL_ETH', 'SOL_USDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTC_USDT', side: 'buy' }, { pair: 'ETH_BTC', side: 'buy' }, { pair: 'SOL_ETH', side: 'buy' }, { pair: 'SOL_USDT', side: 'sell' }] },
                { id: 'BITMART_EXT_6', pairs: ['ETH_USDT', 'BTC_ETH', 'ADA_BTC', 'ADA_USDT'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'BTC_ETH', side: 'buy' }, { pair: 'ADA_BTC', side: 'buy' }, { pair: 'ADA_USDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Bitrue path definitions (32 paths, 5 sets)
     * Pair format: No separator (ETHUSDT, BTCETH)
     */
    _initializeBitruePaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'BITRUE_ETH_1', pairs: ['ETHUSDT', 'BTCETH', 'BTCUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'BTCETH', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_ETH_2', pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'BITRUE_ETH_3', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'BITRUE_ETH_4', pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'BITRUE_ETH_5', pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'BITRUE_ETH_6', pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'BITRUE_ETH_7', pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'AVAXETH', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'BITRUE_BTC_1', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTC_2', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTC_3', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTC_4', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTC_5', pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTC_6', pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'buy' }, { pair: 'UNIUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTC_7', pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] }
            ],
            SET_3_BTR_NATIVE_BRIDGE: [
                { id: 'BITRUE_BTR_1', pairs: ['BTRUSDT', 'BTCBTR', 'BTCUSDT'], sequence: 'USDT → BTR → BTC → USDT', steps: [{ pair: 'BTRUSDT', side: 'buy' }, { pair: 'BTCBTR', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTR_2', pairs: ['BTRUSDT', 'ETHBTR', 'ETHUSDT'], sequence: 'USDT → BTR → ETH → USDT', steps: [{ pair: 'BTRUSDT', side: 'buy' }, { pair: 'ETHBTR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTR_3', pairs: ['BTRUSDT', 'SOLBTR', 'SOLUSDT'], sequence: 'USDT → BTR → SOL → USDT', steps: [{ pair: 'BTRUSDT', side: 'buy' }, { pair: 'SOLBTR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTR_4', pairs: ['BTCUSDT', 'BTRBTC', 'BTRUSDT'], sequence: 'USDT → BTC → BTR → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'BTRBTC', side: 'buy' }, { pair: 'BTRUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTR_5', pairs: ['ETHUSDT', 'BTRETH', 'BTRUSDT'], sequence: 'USDT → ETH → BTR → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'BTRETH', side: 'buy' }, { pair: 'BTRUSDT', side: 'sell' }] },
                { id: 'BITRUE_BTR_6', pairs: ['BTRUSDT', 'XRPBTR', 'XRPUSDT'], sequence: 'USDT → BTR → XRP → USDT', steps: [{ pair: 'BTRUSDT', side: 'buy' }, { pair: 'XRPBTR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'BITRUE_VOL_1', pairs: ['DOGEUSDT', 'BTCDOGE', 'BTCUSDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'BTCDOGE', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_VOL_2', pairs: ['SHIBUSDT', 'ETHSHIB', 'ETHUSDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'ETHSHIB', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'BITRUE_VOL_3', pairs: ['PEPEUSDT', 'ETHPEPE', 'ETHUSDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPEUSDT', side: 'buy' }, { pair: 'ETHPEPE', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'BITRUE_VOL_4', pairs: ['NEARUSDT', 'BTCNEAR', 'BTCUSDT'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEARUSDT', side: 'buy' }, { pair: 'BTCNEAR', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_VOL_5', pairs: ['APTUSDT', 'ETHAPT', 'ETHUSDT'], sequence: 'USDT → APT → ETH → USDT', steps: [{ pair: 'APTUSDT', side: 'buy' }, { pair: 'ETHAPT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'BITRUE_VOL_6', pairs: ['FTMUSDT', 'BTCFTM', 'BTCUSDT'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTMUSDT', side: 'buy' }, { pair: 'BTCFTM', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'BITRUE_EXT_1', pairs: ['SOLUSDT', 'BTCSOL', 'BTCUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'BTCSOL', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_EXT_2', pairs: ['ADAUSDT', 'BTCADA', 'BTCUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'BTCADA', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_EXT_3', pairs: ['AVAXUSDT', 'BTCAVAX', 'BTCUSDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'BTCAVAX', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'BITRUE_EXT_4', pairs: ['MATICUSDT', 'ETHMATIC', 'ETHUSDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'ETHMATIC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'BITRUE_EXT_5', pairs: ['BTCUSDT', 'ETHBTC', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'BITRUE_EXT_6', pairs: ['ETHUSDT', 'BTCETH', 'ADABTC', 'ADAUSDT'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'BTCETH', side: 'buy' }, { pair: 'ADABTC', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Gemini path definitions (10 paths, 5 sets)
     * Pair format: Lowercase no separator (btcusdt, ethbtc)
     * NOTE: Gemini has limited USDT pairs, includes 4-leg paths
     */
    _initializeGeminiPaths() {
        return {
            SET_1_BTC_ETH_DIRECT: [
                { id: 'GEMINI_BTCETH_1', pairs: ['btcusdt', 'ethbtc', 'ethusdt'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'ethbtc', side: 'buy' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'GEMINI_ETHBTC_1', pairs: ['ethusdt', 'ethbtc', 'btcusdt'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'ethbtc', side: 'sell' }, { pair: 'btcusdt', side: 'sell' }] }
            ],
            SET_2_DOGE_BRIDGE: [
                { id: 'GEMINI_DOGE_1', pairs: ['btcusdt', 'dogebtc', 'dogeeth', 'ethusdt'], sequence: 'USDT → BTC → DOGE → ETH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'dogebtc', side: 'buy' }, { pair: 'dogeeth', side: 'sell' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'GEMINI_DOGE_2', pairs: ['ethusdt', 'dogeeth', 'dogebtc', 'btcusdt'], sequence: 'USDT → ETH → DOGE → BTC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'dogeeth', side: 'buy' }, { pair: 'dogebtc', side: 'sell' }, { pair: 'btcusdt', side: 'sell' }] }
            ],
            SET_3_LINK_BRIDGE: [
                { id: 'GEMINI_LINK_1', pairs: ['btcusdt', 'linkbtc', 'linketh', 'ethusdt'], sequence: 'USDT → BTC → LINK → ETH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'linkbtc', side: 'buy' }, { pair: 'linketh', side: 'sell' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'GEMINI_LINK_2', pairs: ['ethusdt', 'linketh', 'linkbtc', 'btcusdt'], sequence: 'USDT → ETH → LINK → BTC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'linketh', side: 'buy' }, { pair: 'linkbtc', side: 'sell' }, { pair: 'btcusdt', side: 'sell' }] }
            ],
            SET_4_LTC_BRIDGE: [
                { id: 'GEMINI_LTC_1', pairs: ['btcusdt', 'ltcbtc', 'ltceth', 'ethusdt'], sequence: 'USDT → BTC → LTC → ETH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'ltcbtc', side: 'buy' }, { pair: 'ltceth', side: 'sell' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'GEMINI_LTC_2', pairs: ['ethusdt', 'ltceth', 'ltcbtc', 'btcusdt'], sequence: 'USDT → ETH → LTC → BTC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'ltceth', side: 'buy' }, { pair: 'ltcbtc', side: 'sell' }, { pair: 'btcusdt', side: 'sell' }] }
            ],
            SET_5_SOL_BRIDGE: [
                { id: 'GEMINI_SOL_1', pairs: ['btcusdt', 'solbtc', 'soleth', 'ethusdt'], sequence: 'USDT → BTC → SOL → ETH → USDT', steps: [{ pair: 'btcusdt', side: 'buy' }, { pair: 'solbtc', side: 'buy' }, { pair: 'soleth', side: 'sell' }, { pair: 'ethusdt', side: 'sell' }] },
                { id: 'GEMINI_SOL_2', pairs: ['ethusdt', 'soleth', 'solbtc', 'btcusdt'], sequence: 'USDT → ETH → SOL → BTC → USDT', steps: [{ pair: 'ethusdt', side: 'buy' }, { pair: 'soleth', side: 'buy' }, { pair: 'solbtc', side: 'sell' }, { pair: 'btcusdt', side: 'sell' }] }
            ]
        };
    }

    /**
     * Initialize Coincatch path definitions (32 paths, 5 sets)
     * Pair format: No separator (ETHUSDT, BTCETH)
     */
    _initializeCoincatchPaths() {
        return {
            SET_1_ESSENTIAL_ETH_BRIDGE: [
                { id: 'COINCATCH_ETH_1', pairs: ['ETHUSDT', 'BTCETH', 'BTCUSDT'], sequence: 'USDT → ETH → BTC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'BTCETH', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_ETH_2', pairs: ['ETHUSDT', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → ETH → SOL → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'COINCATCH_ETH_3', pairs: ['ETHUSDT', 'XRPETH', 'XRPUSDT'], sequence: 'USDT → ETH → XRP → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'XRPETH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'COINCATCH_ETH_4', pairs: ['ETHUSDT', 'ADAETH', 'ADAUSDT'], sequence: 'USDT → ETH → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ADAETH', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] },
                { id: 'COINCATCH_ETH_5', pairs: ['ETHUSDT', 'MATICETH', 'MATICUSDT'], sequence: 'USDT → ETH → MATIC → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'MATICETH', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] },
                { id: 'COINCATCH_ETH_6', pairs: ['ETHUSDT', 'DOTETH', 'DOTUSDT'], sequence: 'USDT → ETH → DOT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'DOTETH', side: 'buy' }, { pair: 'DOTUSDT', side: 'sell' }] },
                { id: 'COINCATCH_ETH_7', pairs: ['ETHUSDT', 'AVAXETH', 'AVAXUSDT'], sequence: 'USDT → ETH → AVAX → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'AVAXETH', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_2_MIDCAP_BTC_BRIDGE: [
                { id: 'COINCATCH_BTC_1', pairs: ['BTCUSDT', 'ETHBTC', 'ETHUSDT'], sequence: 'USDT → BTC → ETH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_BTC_2', pairs: ['BTCUSDT', 'SOLBTC', 'SOLUSDT'], sequence: 'USDT → BTC → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'SOLBTC', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'COINCATCH_BTC_3', pairs: ['BTCUSDT', 'XRPBTC', 'XRPUSDT'], sequence: 'USDT → BTC → XRP → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'XRPBTC', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'COINCATCH_BTC_4', pairs: ['BTCUSDT', 'LTCBTC', 'LTCUSDT'], sequence: 'USDT → BTC → LTC → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LTCBTC', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_BTC_5', pairs: ['BTCUSDT', 'ATOMBTC', 'ATOMUSDT'], sequence: 'USDT → BTC → ATOM → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ATOMBTC', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] },
                { id: 'COINCATCH_BTC_6', pairs: ['BTCUSDT', 'UNIBTC', 'UNIUSDT'], sequence: 'USDT → BTC → UNI → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'UNIBTC', side: 'buy' }, { pair: 'UNIUSDT', side: 'sell' }] },
                { id: 'COINCATCH_BTC_7', pairs: ['BTCUSDT', 'LINKBTC', 'LINKUSDT'], sequence: 'USDT → BTC → LINK → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'LINKBTC', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] }
            ],
            SET_3_CATCH_NATIVE_BRIDGE: [
                { id: 'COINCATCH_CATCH_1', pairs: ['CATCHUSDT', 'BTCCATCH', 'BTCUSDT'], sequence: 'USDT → CATCH → BTC → USDT', steps: [{ pair: 'CATCHUSDT', side: 'buy' }, { pair: 'BTCCATCH', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_CATCH_2', pairs: ['CATCHUSDT', 'ETHCATCH', 'ETHUSDT'], sequence: 'USDT → CATCH → ETH → USDT', steps: [{ pair: 'CATCHUSDT', side: 'buy' }, { pair: 'ETHCATCH', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_CATCH_3', pairs: ['CATCHUSDT', 'SOLCATCH', 'SOLUSDT'], sequence: 'USDT → CATCH → SOL → USDT', steps: [{ pair: 'CATCHUSDT', side: 'buy' }, { pair: 'SOLCATCH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'COINCATCH_CATCH_4', pairs: ['BTCUSDT', 'CATCHBTC', 'CATCHUSDT'], sequence: 'USDT → BTC → CATCH → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'CATCHBTC', side: 'buy' }, { pair: 'CATCHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_CATCH_5', pairs: ['ETHUSDT', 'CATCHETH', 'CATCHUSDT'], sequence: 'USDT → ETH → CATCH → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'CATCHETH', side: 'buy' }, { pair: 'CATCHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_CATCH_6', pairs: ['CATCHUSDT', 'XRPCATCH', 'XRPUSDT'], sequence: 'USDT → CATCH → XRP → USDT', steps: [{ pair: 'CATCHUSDT', side: 'buy' }, { pair: 'XRPCATCH', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_4_HIGH_VOLATILITY: [
                { id: 'COINCATCH_VOL_1', pairs: ['DOGEUSDT', 'BTCDOGE', 'BTCUSDT'], sequence: 'USDT → DOGE → BTC → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'BTCDOGE', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_VOL_2', pairs: ['SHIBUSDT', 'ETHSHIB', 'ETHUSDT'], sequence: 'USDT → SHIB → ETH → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'ETHSHIB', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_VOL_3', pairs: ['PEPEUSDT', 'ETHPEPE', 'ETHUSDT'], sequence: 'USDT → PEPE → ETH → USDT', steps: [{ pair: 'PEPEUSDT', side: 'buy' }, { pair: 'ETHPEPE', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_VOL_4', pairs: ['NEARUSDT', 'BTCNEAR', 'BTCUSDT'], sequence: 'USDT → NEAR → BTC → USDT', steps: [{ pair: 'NEARUSDT', side: 'buy' }, { pair: 'BTCNEAR', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_VOL_5', pairs: ['APTUSDT', 'ETHAPT', 'ETHUSDT'], sequence: 'USDT → APT → ETH → USDT', steps: [{ pair: 'APTUSDT', side: 'buy' }, { pair: 'ETHAPT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_VOL_6', pairs: ['FTMUSDT', 'BTCFTM', 'BTCUSDT'], sequence: 'USDT → FTM → BTC → USDT', steps: [{ pair: 'FTMUSDT', side: 'buy' }, { pair: 'BTCFTM', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] }
            ],
            SET_5_EXTENDED_MULTIBRIDGE: [
                { id: 'COINCATCH_EXT_1', pairs: ['SOLUSDT', 'BTCSOL', 'BTCUSDT'], sequence: 'USDT → SOL → BTC → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'BTCSOL', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_EXT_2', pairs: ['ADAUSDT', 'BTCADA', 'BTCUSDT'], sequence: 'USDT → ADA → BTC → USDT', steps: [{ pair: 'ADAUSDT', side: 'buy' }, { pair: 'BTCADA', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_EXT_3', pairs: ['AVAXUSDT', 'BTCAVAX', 'BTCUSDT'], sequence: 'USDT → AVAX → BTC → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'BTCAVAX', side: 'buy' }, { pair: 'BTCUSDT', side: 'sell' }] },
                { id: 'COINCATCH_EXT_4', pairs: ['MATICUSDT', 'ETHMATIC', 'ETHUSDT'], sequence: 'USDT → MATIC → ETH → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'ETHMATIC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'COINCATCH_EXT_5', pairs: ['BTCUSDT', 'ETHBTC', 'SOLETH', 'SOLUSDT'], sequence: 'USDT → BTC → ETH → SOL → USDT', steps: [{ pair: 'BTCUSDT', side: 'buy' }, { pair: 'ETHBTC', side: 'buy' }, { pair: 'SOLETH', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'COINCATCH_EXT_6', pairs: ['ETHUSDT', 'BTCETH', 'ADABTC', 'ADAUSDT'], sequence: 'USDT → ETH → BTC → ADA → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'BTCETH', side: 'buy' }, { pair: 'ADABTC', side: 'buy' }, { pair: 'ADAUSDT', side: 'sell' }] }
            ]
        };
    }
}

module.exports = PathDefinitionsService;
