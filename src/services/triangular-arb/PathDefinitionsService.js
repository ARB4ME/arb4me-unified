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
            // Other exchanges will be added as they're implemented
            chainex: [],
            binance: [],
            kraken: [],
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
            // Add more sets as needed - for now starting with first 3 sets
            // Full implementation will include all 20+ sets
        };
    }

    /**
     * Initialize Luno paths - Comprehensive (52 paths across 3 sets)
     * Only ZAR and USDT focused (fundable currencies)
     * Based on 135 available Luno pairs
     * @private
     */
    _initializeLunoPaths() {
        return {
            SET_1_USDT_FOCUS: [
                // USDT via XBT bridge
                { id: 'USDT_XBT_ETH_USDT', pairs: ['XBTUSDT', 'ETHXBT', 'ETHUSDT'], sequence: 'USDT → XBT → ETH → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_XBT_USDT', pairs: ['ETHUSDT', 'ETHXBT', 'XBTUSDT'], sequence: 'USDT → ETH → XBT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_XBT_SOL_USDT', pairs: ['XBTUSDT', 'SOLXBT', 'SOLUSDT'], sequence: 'USDT → XBT → SOL → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_XBT_USDT', pairs: ['SOLUSDT', 'SOLXBT', 'XBTUSDT'], sequence: 'USDT → SOL → XBT → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_XBT_XRP_USDT', pairs: ['XBTUSDT', 'XRPXBT', 'XRPUSDT'], sequence: 'USDT → XBT → XRP → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_XBT_USDT', pairs: ['XRPUSDT', 'XRPXBT', 'XBTUSDT'], sequence: 'USDT → XRP → XBT → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                // USDT via USDC bridge
                { id: 'USDT_USDC_ETH_USDT', pairs: ['USDCUSDT', 'ETHUSDC', 'ETHUSDT'], sequence: 'USDT → USDC → ETH → USDT', steps: [{ pair: 'USDCUSDT', side: 'buy' }, { pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                // USDT via ZAR bridge
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETHUSDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_ZAR_SOL_USDT', pairs: ['USDTZAR', 'SOLZAR', 'SOLUSDT'], sequence: 'USDT → ZAR → SOL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRPUSDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_ZAR_XBT_USDT', pairs: ['USDTZAR', 'XBTZAR', 'XBTUSDT'], sequence: 'USDT → ZAR → XBT → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_INJ_ZAR_USDT', pairs: ['INJUSDT', 'INJZAR', 'USDTZAR'], sequence: 'USDT → INJ → ZAR → USDT', steps: [{ pair: 'INJUSDT', side: 'buy' }, { pair: 'INJZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] }
            ],
            SET_2_ZAR_MAJOR: [
                // ZAR with major coins via XBT
                { id: 'ZAR_XBT_ETH_ZAR', pairs: ['XBTZAR', 'ETHXBT', 'ETHZAR'], sequence: 'ZAR → XBT → ETH → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_ETH_XBT_ZAR', pairs: ['ETHZAR', 'ETHXBT', 'XBTZAR'], sequence: 'ZAR → ETH → XBT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_SOL_ZAR', pairs: ['XBTZAR', 'SOLXBT', 'SOLZAR'], sequence: 'ZAR → XBT → SOL → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'ZAR_SOL_XBT_ZAR', pairs: ['SOLZAR', 'SOLXBT', 'XBTZAR'], sequence: 'ZAR → SOL → XBT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_XRP_ZAR', pairs: ['XBTZAR', 'XRPXBT', 'XRPZAR'], sequence: 'ZAR → XBT → XRP → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_XRP_XBT_ZAR', pairs: ['XRPZAR', 'XRPXBT', 'XBTZAR'], sequence: 'ZAR → XRP → XBT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                // ZAR via USDT bridge
                { id: 'ZAR_USDT_XBT_ZAR', pairs: ['USDTZAR', 'XBTUSDT', 'XBTZAR'], sequence: 'ZAR → USDT → XBT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_INJ_USDT_ZAR', pairs: ['INJZAR', 'INJUSDT', 'USDTZAR'], sequence: 'ZAR → INJ → USDT → ZAR', steps: [{ pair: 'INJZAR', side: 'buy' }, { pair: 'INJUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                // ZAR via USDC bridge
                { id: 'ZAR_USDC_ETH_ZAR', pairs: ['USDCZAR', 'ETHUSDC', 'ETHZAR'], sequence: 'ZAR → USDC → ETH → ZAR', steps: [{ pair: 'USDCZAR', side: 'buy' }, { pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] }
            ],
            SET_3_ZAR_ALTCOINS: [
                // ZAR with altcoins via XBT bridge
                { id: 'ZAR_ADA_XBT_ZAR', pairs: ['ADAZAR', 'ADAXBT', 'XBTZAR'], sequence: 'ZAR → ADA → XBT → ZAR', steps: [{ pair: 'ADAZAR', side: 'buy' }, { pair: 'ADAXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_ADA_ZAR', pairs: ['XBTZAR', 'ADAXBT', 'ADAZAR'], sequence: 'ZAR → XBT → ADA → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAZAR', side: 'sell' }] },
                { id: 'ZAR_DOT_XBT_ZAR', pairs: ['DOTZAR', 'DOTXBT', 'XBTZAR'], sequence: 'ZAR → DOT → XBT → ZAR', steps: [{ pair: 'DOTZAR', side: 'buy' }, { pair: 'DOTXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_DOT_ZAR', pairs: ['XBTZAR', 'DOTXBT', 'DOTZAR'], sequence: 'ZAR → XBT → DOT → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTZAR', side: 'sell' }] },
                { id: 'ZAR_AVAX_XBT_ZAR', pairs: ['AVAXZAR', 'AVAXXBT', 'XBTZAR'], sequence: 'ZAR → AVAX → XBT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_AVAX_ZAR', pairs: ['XBTZAR', 'AVAXXBT', 'AVAXZAR'], sequence: 'ZAR → XBT → AVAX → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'ZAR_LTC_XBT_ZAR', pairs: ['LTCZAR', 'LTCXBT', 'XBTZAR'], sequence: 'ZAR → LTC → XBT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_LTC_ZAR', pairs: ['XBTZAR', 'LTCXBT', 'LTCZAR'], sequence: 'ZAR → XBT → LTC → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'ZAR_ALGO_XBT_ZAR', pairs: ['ALGOZAR', 'ALGOXBT', 'XBTZAR'], sequence: 'ZAR → ALGO → XBT → ZAR', steps: [{ pair: 'ALGOZAR', side: 'buy' }, { pair: 'ALGOXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_ALGO_ZAR', pairs: ['XBTZAR', 'ALGOXBT', 'ALGOZAR'], sequence: 'ZAR → XBT → ALGO → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ALGOXBT', side: 'buy' }, { pair: 'ALGOZAR', side: 'sell' }] },
                { id: 'ZAR_ATOM_XBT_ZAR', pairs: ['ATOMZAR', 'ATOMXBT', 'XBTZAR'], sequence: 'ZAR → ATOM → XBT → ZAR', steps: [{ pair: 'ATOMZAR', side: 'buy' }, { pair: 'ATOMXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_ATOM_ZAR', pairs: ['XBTZAR', 'ATOMXBT', 'ATOMZAR'], sequence: 'ZAR → XBT → ATOM → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ATOMXBT', side: 'buy' }, { pair: 'ATOMZAR', side: 'sell' }] },
                { id: 'ZAR_CRV_XBT_ZAR', pairs: ['CRVZAR', 'CRVXBT', 'XBTZAR'], sequence: 'ZAR → CRV → XBT → ZAR', steps: [{ pair: 'CRVZAR', side: 'buy' }, { pair: 'CRVXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_CRV_ZAR', pairs: ['XBTZAR', 'CRVXBT', 'CRVZAR'], sequence: 'ZAR → XBT → CRV → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'CRVXBT', side: 'buy' }, { pair: 'CRVZAR', side: 'sell' }] },
                { id: 'ZAR_GRT_XBT_ZAR', pairs: ['GRTZAR', 'GRTXBT', 'XBTZAR'], sequence: 'ZAR → GRT → XBT → ZAR', steps: [{ pair: 'GRTZAR', side: 'buy' }, { pair: 'GRTXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_GRT_ZAR', pairs: ['XBTZAR', 'GRTXBT', 'GRTZAR'], sequence: 'ZAR → XBT → GRT → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'GRTXBT', side: 'buy' }, { pair: 'GRTZAR', side: 'sell' }] },
                { id: 'ZAR_NEAR_XBT_ZAR', pairs: ['NEARZAR', 'NEARXBT', 'XBTZAR'], sequence: 'ZAR → NEAR → XBT → ZAR', steps: [{ pair: 'NEARZAR', side: 'buy' }, { pair: 'NEARXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_NEAR_ZAR', pairs: ['XBTZAR', 'NEARXBT', 'NEARZAR'], sequence: 'ZAR → XBT → NEAR → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'NEARXBT', side: 'buy' }, { pair: 'NEARZAR', side: 'sell' }] },
                { id: 'ZAR_POL_XBT_ZAR', pairs: ['POLZAR', 'POLXBT', 'XBTZAR'], sequence: 'ZAR → POL → XBT → ZAR', steps: [{ pair: 'POLZAR', side: 'buy' }, { pair: 'POLXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_POL_ZAR', pairs: ['XBTZAR', 'POLXBT', 'POLZAR'], sequence: 'ZAR → XBT → POL → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'POLXBT', side: 'buy' }, { pair: 'POLZAR', side: 'sell' }] },
                { id: 'ZAR_SAND_XBT_ZAR', pairs: ['SANDZAR', 'SANDXBT', 'XBTZAR'], sequence: 'ZAR → SAND → XBT → ZAR', steps: [{ pair: 'SANDZAR', side: 'buy' }, { pair: 'SANDXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_SAND_ZAR', pairs: ['XBTZAR', 'SANDXBT', 'SANDZAR'], sequence: 'ZAR → XBT → SAND → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SANDXBT', side: 'buy' }, { pair: 'SANDZAR', side: 'sell' }] },
                { id: 'ZAR_SNX_XBT_ZAR', pairs: ['SNXZAR', 'SNXXBT', 'XBTZAR'], sequence: 'ZAR → SNX → XBT → ZAR', steps: [{ pair: 'SNXZAR', side: 'buy' }, { pair: 'SNXXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_SNX_ZAR', pairs: ['XBTZAR', 'SNXXBT', 'SNXZAR'], sequence: 'ZAR → XBT → SNX → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SNXXBT', side: 'buy' }, { pair: 'SNXZAR', side: 'sell' }] },
                { id: 'ZAR_TRX_XBT_ZAR', pairs: ['TRXZAR', 'TRXXBT', 'XBTZAR'], sequence: 'ZAR → TRX → XBT → ZAR', steps: [{ pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_TRX_ZAR', pairs: ['XBTZAR', 'TRXXBT', 'TRXZAR'], sequence: 'ZAR → XBT → TRX → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'TRXXBT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }] },
                { id: 'ZAR_XLM_XBT_ZAR', pairs: ['XLMZAR', 'XLMXBT', 'XBTZAR'], sequence: 'ZAR → XLM → XBT → ZAR', steps: [{ pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_XLM_ZAR', pairs: ['XBTZAR', 'XLMXBT', 'XLMZAR'], sequence: 'ZAR → XBT → XLM → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'XLMXBT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }] },
                { id: 'ZAR_SONIC_XBT_ZAR', pairs: ['SONICZAR', 'SONICXBT', 'XBTZAR'], sequence: 'ZAR → SONIC → XBT → ZAR', steps: [{ pair: 'SONICZAR', side: 'buy' }, { pair: 'SONICXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_SONIC_ZAR', pairs: ['XBTZAR', 'SONICXBT', 'SONICZAR'], sequence: 'ZAR → XBT → SONIC → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SONICXBT', side: 'buy' }, { pair: 'SONICZAR', side: 'sell' }] }
            ]
        };
    }
}

module.exports = PathDefinitionsService;
