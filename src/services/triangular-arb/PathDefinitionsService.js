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
     * Initialize Luno paths (42 paths across 6 sets)
     * @private
     */
    _initializeLunoPaths() {
        return {
            SET_1_USDT_FOCUS: [
                { id: 'USDT_XBT_ETH_USDT', pairs: ['XBTUSDT', 'ETHXBT', 'ETHUSDT'], sequence: 'USDT → XBT → ETH → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] },
                { id: 'USDT_XBT_XRP_USDT', pairs: ['XBTUSDT', 'XRPXBT', 'XRPUSDT'], sequence: 'USDT → XBT → XRP → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] },
                { id: 'USDT_XBT_SOL_USDT', pairs: ['XBTUSDT', 'SOLXBT', 'SOLUSDT'], sequence: 'USDT → XBT → SOL → USDT', steps: [{ pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] },
                { id: 'USDT_ETH_XBT_USDT', pairs: ['ETHUSDT', 'ETHXBT', 'XBTUSDT'], sequence: 'USDT → ETH → XBT → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_XRP_XBT_USDT', pairs: ['XRPUSDT', 'XRPXBT', 'XBTUSDT'], sequence: 'USDT → XRP → XBT → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_SOL_XBT_USDT', pairs: ['SOLUSDT', 'SOLXBT', 'XBTUSDT'], sequence: 'USDT → SOL → XBT → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }] },
                { id: 'USDT_USDC_ETH_USDT', pairs: ['USDCUSDT', 'ETHUSDC', 'ETHUSDT'], sequence: 'USDT → USDC → ETH → USDT', steps: [{ pair: 'USDCUSDT', side: 'buy' }, { pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_2_XBT_FOCUS: [
                { id: 'XBT_ETH_USDT_XBT', pairs: ['ETHXBT', 'ETHUSDT', 'XBTUSDT'], sequence: 'XBT → ETH → USDT → XBT', steps: [{ pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }] },
                { id: 'XBT_ETH_ZAR_XBT', pairs: ['ETHXBT', 'ETHZAR', 'XBTZAR'], sequence: 'XBT → ETH → ZAR → XBT', steps: [{ pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_SOL_USDT_XBT', pairs: ['SOLXBT', 'SOLUSDT', 'XBTUSDT'], sequence: 'XBT → SOL → USDT → XBT', steps: [{ pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }] },
                { id: 'XBT_SOL_XRP_XBT', pairs: ['SOLXBT', 'SOLXRP', 'XRPXBT'], sequence: 'XBT → SOL → XRP → XBT', steps: [{ pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLXRP', side: 'sell' }, { pair: 'XRPXBT', side: 'buy' }] },
                { id: 'XBT_XRP_USDT_XBT', pairs: ['XRPXBT', 'XRPUSDT', 'XBTUSDT'], sequence: 'XBT → XRP → USDT → XBT', steps: [{ pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }] },
                { id: 'XBT_XRP_ZAR_XBT', pairs: ['XRPXBT', 'XRPZAR', 'XBTZAR'], sequence: 'XBT → XRP → ZAR → XBT', steps: [{ pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_ADA_ZAR_XBT', pairs: ['ADAXBT', 'ADAZAR', 'XBTZAR'], sequence: 'XBT → ADA → ZAR → XBT', steps: [{ pair: 'ADAXBT', side: 'buy' }, { pair: 'ADAZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_DOT_ZAR_XBT', pairs: ['DOTXBT', 'DOTZAR', 'XBTZAR'], sequence: 'XBT → DOT → ZAR → XBT', steps: [{ pair: 'DOTXBT', side: 'buy' }, { pair: 'DOTZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_AVAX_ZAR_XBT', pairs: ['AVAXXBT', 'AVAXZAR', 'XBTZAR'], sequence: 'XBT → AVAX → ZAR → XBT', steps: [{ pair: 'AVAXXBT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_LINK_ZAR_XBT', pairs: ['LINKXBT', 'LINKZAR', 'XBTZAR'], sequence: 'XBT → LINK → ZAR → XBT', steps: [{ pair: 'LINKXBT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_UNI_ZAR_XBT', pairs: ['UNIXBT', 'UNIZAR', 'XBTZAR'], sequence: 'XBT → UNI → ZAR → XBT', steps: [{ pair: 'UNIXBT', side: 'buy' }, { pair: 'UNIZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] },
                { id: 'XBT_LTC_ZAR_XBT', pairs: ['LTCXBT', 'LTCZAR', 'XBTZAR'], sequence: 'XBT → LTC → ZAR → XBT', steps: [{ pair: 'LTCXBT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }] }
            ],
            SET_3_ZAR_FOCUS: [
                { id: 'ZAR_XBT_ETH_ZAR', pairs: ['XBTZAR', 'ETHXBT', 'ETHZAR'], sequence: 'ZAR → XBT → ETH → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_SOL_ZAR', pairs: ['XBTZAR', 'SOLXBT', 'SOLZAR'], sequence: 'ZAR → XBT → SOL → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'ZAR_XBT_XRP_ZAR', pairs: ['XBTZAR', 'XRPXBT', 'XRPZAR'], sequence: 'ZAR → XBT → XRP → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'ZAR_ETH_XBT_ZAR', pairs: ['ETHZAR', 'ETHXBT', 'XBTZAR'], sequence: 'ZAR → ETH → XBT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_SOL_XBT_ZAR', pairs: ['SOLZAR', 'SOLXBT', 'XBTZAR'], sequence: 'ZAR → SOL → XBT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_XRP_XBT_ZAR', pairs: ['XRPZAR', 'XRPXBT', 'XBTZAR'], sequence: 'ZAR → XRP → XBT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XBT_ZAR', pairs: ['USDTZAR', 'XBTUSDT', 'XBTZAR'], sequence: 'ZAR → USDT → XBT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'ZAR_USDC_ETH_ZAR', pairs: ['USDCZAR', 'ETHUSDC', 'ETHZAR'], sequence: 'ZAR → USDC → ETH → ZAR', steps: [{ pair: 'USDCZAR', side: 'buy' }, { pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] }
            ],
            SET_4_ETH_FOCUS: [
                { id: 'ETH_XBT_USDT_ETH', pairs: ['ETHXBT', 'XBTUSDT', 'ETHUSDT'], sequence: 'ETH → XBT → USDT → ETH', steps: [{ pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }] },
                { id: 'ETH_XBT_ZAR_ETH', pairs: ['ETHXBT', 'XBTZAR', 'ETHZAR'], sequence: 'ETH → XBT → ZAR → ETH', steps: [{ pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }] },
                { id: 'ETH_USDT_XBT_ETH', pairs: ['ETHUSDT', 'XBTUSDT', 'ETHXBT'], sequence: 'ETH → USDT → XBT → ETH', steps: [{ pair: 'ETHUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }] },
                { id: 'ETH_USDC_USDT_ETH', pairs: ['ETHUSDC', 'USDCUSDT', 'ETHUSDT'], sequence: 'ETH → USDC → USDT → ETH', steps: [{ pair: 'ETHUSDC', side: 'sell' }, { pair: 'USDCUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }] },
                { id: 'ETH_ZAR_XBT_ETH', pairs: ['ETHZAR', 'XBTZAR', 'ETHXBT'], sequence: 'ETH → ZAR → XBT → ETH', steps: [{ pair: 'ETHZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }, { pair: 'ETHXBT', side: 'buy' }] },
                { id: 'ETH_XBT_SOL_ETH', pairs: ['ETHXBT', 'SOLXBT', 'SOLETH'], sequence: 'ETH → XBT → SOL → ETH', steps: [{ pair: 'ETHXBT', side: 'sell' }, { pair: 'SOLXBT', side: 'buy' }, { pair: 'SOLETH', side: 'sell' }] }
            ],
            SET_5_SOL_UNIQUE: [
                { id: 'SOL_ADA_ZAR_SOL', pairs: ['SOLADA', 'ADAZAR', 'SOLZAR'], sequence: 'SOL → ADA → ZAR → SOL', steps: [{ pair: 'SOLADA', side: 'sell' }, { pair: 'ADAZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }] },
                { id: 'SOL_XRP_XBT_SOL', pairs: ['SOLXRP', 'XRPXBT', 'SOLXBT'], sequence: 'SOL → XRP → XBT → SOL', steps: [{ pair: 'SOLXRP', side: 'sell' }, { pair: 'XRPXBT', side: 'sell' }, { pair: 'SOLXBT', side: 'buy' }] },
                { id: 'SOL_XBT_USDT_SOL', pairs: ['SOLXBT', 'XBTUSDT', 'SOLUSDT'], sequence: 'SOL → XBT → USDT → SOL', steps: [{ pair: 'SOLXBT', side: 'sell' }, { pair: 'XBTUSDT', side: 'sell' }, { pair: 'SOLUSDT', side: 'buy' }] },
                { id: 'SOL_USDT_XBT_SOL', pairs: ['SOLUSDT', 'XBTUSDT', 'SOLXBT'], sequence: 'SOL → USDT → XBT → SOL', steps: [{ pair: 'SOLUSDT', side: 'sell' }, { pair: 'XBTUSDT', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }] },
                { id: 'SOL_ZAR_XBT_SOL', pairs: ['SOLZAR', 'XBTZAR', 'SOLXBT'], sequence: 'SOL → ZAR → XBT → SOL', steps: [{ pair: 'SOLZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }, { pair: 'SOLXBT', side: 'buy' }] }
            ],
            SET_6_STABLECOIN_ARB: [
                { id: 'USDC_ETH_XBT_USDC', pairs: ['ETHUSDC', 'ETHXBT', 'XBTUSDC'], sequence: 'USDC → ETH → XBT → USDC', steps: [{ pair: 'ETHUSDC', side: 'buy' }, { pair: 'ETHXBT', side: 'sell' }, { pair: 'XBTUSDC', side: 'sell' }] },
                { id: 'USDC_USDT_ETH_USDC', pairs: ['USDCUSDT', 'ETHUSDT', 'ETHUSDC'], sequence: 'USDC → USDT → ETH → USDC', steps: [{ pair: 'USDCUSDT', side: 'sell' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHUSDC', side: 'sell' }] },
                { id: 'XRP_SOL_XBT_XRP', pairs: ['SOLXRP', 'SOLXBT', 'XRPXBT'], sequence: 'XRP → SOL → XBT → XRP', steps: [{ pair: 'SOLXRP', side: 'buy' }, { pair: 'SOLXBT', side: 'sell' }, { pair: 'XRPXBT', side: 'buy' }] },
                { id: 'ADA_SOL_ZAR_ADA', pairs: ['SOLADA', 'SOLZAR', 'ADAZAR'], sequence: 'ADA → SOL → ZAR → ADA', steps: [{ pair: 'SOLADA', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'ADAZAR', side: 'buy' }] }
            ]
        };
    }
}

module.exports = PathDefinitionsService;
