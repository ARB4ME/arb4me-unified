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
     * Initialize Luno paths
     * @private
     */
    _initializeLunoPaths() {
        return {
            SET_1_BTC_FOCUS: [
                { id: 'ZAR_BTC_USDT_ZAR', pairs: ['XBTZAR', 'XBT_USDT', 'USDTZAR'], sequence: 'ZAR → BTC → USDT → ZAR', steps: [{ pair: 'XBTZAR', side: 'buy' }, { pair: 'XBT_USDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BTC_ZAR', pairs: ['USDTZAR', 'XBT_USDT', 'XBTZAR'], sequence: 'ZAR → USDT → BTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XBT_USDT', side: 'buy' }, { pair: 'XBTZAR', side: 'sell' }] },
                { id: 'USDT_BTC_ZAR_USDT', pairs: ['XBT_USDT', 'XBTZAR', 'USDTZAR'], sequence: 'USDT → BTC → ZAR → USDT', steps: [{ pair: 'XBT_USDT', side: 'buy' }, { pair: 'XBTZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BTC_USDT', pairs: ['USDTZAR', 'XBTZAR', 'XBT_USDT'], sequence: 'USDT → ZAR → BTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XBTZAR', side: 'buy' }, { pair: 'XBT_USDT', side: 'sell' }] }
            ],
            SET_2_ETH_FOCUS: [
                { id: 'ZAR_ETH_USDT_ZAR', pairs: ['ETHZAR', 'ETH_USDT', 'USDTZAR'], sequence: 'ZAR → ETH → USDT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETH_USDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETH_USDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'USDT_ETH_ZAR_USDT', pairs: ['ETH_USDT', 'ETHZAR', 'USDTZAR'], sequence: 'USDT → ETH → ZAR → USDT', steps: [{ pair: 'ETH_USDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETH_USDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETH_USDT', side: 'sell' }] }
            ],
            SET_3_XRP_FOCUS: [
                { id: 'ZAR_XRP_USDT_ZAR', pairs: ['XRPZAR', 'XRP_USDT', 'USDTZAR'], sequence: 'ZAR → XRP → USDT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRP_USDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRP_USDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'USDT_XRP_ZAR_USDT', pairs: ['XRP_USDT', 'XRPZAR', 'USDTZAR'], sequence: 'USDT → XRP → ZAR → USDT', steps: [{ pair: 'XRP_USDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRP_USDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRP_USDT', side: 'sell' }] }
            ]
            // Add more Luno sets as needed
        };
    }
}

module.exports = PathDefinitionsService;
