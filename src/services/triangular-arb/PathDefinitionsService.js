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
            chainex: [],
            binance: [],
            bybit: [],
            okx: [],
            kucoin: [],
            coinbase: [],
            htx: [],
            gateio: [],
            cryptocom: [],
            mexc: [],
            xt: [],
            ascendex: [],
            bingx: [],
            bitget: [],
            bitmart: [],
            bitrue: [],
            gemini: [],
            coincatch: []
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

        // If specific sets requested
        if (Array.isArray(pathFilter)) {
            return this._filterPathSets(allPaths, pathFilter);
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
}

module.exports = PathDefinitionsService;
