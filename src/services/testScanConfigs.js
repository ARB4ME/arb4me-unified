/**
 * Test Scan Strategy Configurations
 *
 * Defines how each arbitrage strategy uses the TestScanService
 * Each strategy has unique data models, route keys, and analysis needs
 */

/**
 * Triangular Arbitrage Configuration
 * Scans for 3-way trading imbalances on a single exchange
 * Example: BTC → ETH → USDT → BTC with profit
 */
const triangularArbConfig = {
    strategyName: 'triangular',
    maxResults: 10000, // Can store more (no transfer time delays)

    // Create unique route identifier
    createRouteKey: (opp) => {
        return `${opp.exchange}_${opp.path}`;
    },

    // Data model specific to triangular arb
    dataModel: {
        assetField: 'baseCrypto', // Which field represents the asset

        // For exchange pair analysis (triangular uses single exchange)
        createExchangePairKey: (opp) => {
            return `${opp.exchange} (${opp.path})`;
        },

        // Required fields for each opportunity
        requiredFields: [
            'exchange',      // Which exchange (e.g., 'Binance')
            'path',          // Trading path (e.g., 'BTC→ETH→USDT→BTC')
            'baseCrypto',    // Starting crypto (e.g., 'BTC')
            'netProfitPercent', // Net profit after fees
            'totalFees',     // Combined trading fees
            'slippage',      // Estimated slippage
            'liquidity'      // Path liquidity rating (1-5)
        ]
    }
};

/**
 * Cross-Exchange Arbitrage Configuration
 * Scans for same pair price differences across exchanges
 * Example: BTC/USDT is $50,000 on Binance, $50,500 on Kraken
 */
const crossExchangeArbConfig = {
    strategyName: 'cross-exchange',
    maxResults: 5000,

    // Create unique route identifier
    createRouteKey: (opp) => {
        return `${opp.buyExchange}_${opp.sellExchange}_${opp.pair}`;
    },

    // Data model specific to cross-exchange arb
    dataModel: {
        assetField: 'pair', // Trading pair (e.g., 'BTC/USDT')

        createExchangePairKey: (opp) => {
            return `${opp.buyExchange}→${opp.sellExchange}`;
        },

        requiredFields: [
            'pair',          // Trading pair (e.g., 'BTC/USDT')
            'buyExchange',   // Where to buy
            'sellExchange',  // Where to sell
            'buyPrice',      // Buy price
            'sellPrice',     // Sell price
            'netProfitPercent', // Net profit after fees
            'tradingFees',   // Trading fees both sides
            'liquidity',     // Liquidity rating (1-5)
            'volume24h'      // 24h volume on both exchanges
        ]
    }
};

/**
 * Futures Arbitrage Configuration
 * Scans for basis spread (futures vs spot price difference)
 * Example: BTC spot $50,000, BTC futures $50,500 = $500 basis
 */
const futuresArbConfig = {
    strategyName: 'futures',
    maxResults: 5000,

    // Create unique route identifier
    createRouteKey: (opp) => {
        return `${opp.exchange}_${opp.pair}_${opp.futuresContract}`;
    },

    // Data model specific to futures arb
    dataModel: {
        assetField: 'pair',

        createExchangePairKey: (opp) => {
            return `${opp.exchange} (${opp.futuresContract})`;
        },

        requiredFields: [
            'exchange',         // Exchange (e.g., 'Binance')
            'pair',            // Trading pair (e.g., 'BTC/USDT')
            'spotPrice',       // Current spot price
            'futuresPrice',    // Futures contract price
            'futuresContract', // Contract type (e.g., 'BTCUSDT-PERP')
            'basis',           // Price difference (futures - spot)
            'basisPercent',    // Basis as percentage
            'netProfitPercent', // Net profit after fees & funding
            'fundingRate',     // Funding rate
            'timeToExpiry',    // For dated contracts (null for perps)
            'liquidity'        // Liquidity rating (1-5)
        ]
    }
};

/**
 * Funding Rate Arbitrage Configuration
 * Scans for funding rate differences across exchanges
 * Example: Binance funding 0.01%, Bybit -0.05% = 0.06% arbitrage
 */
const fundingRateArbConfig = {
    strategyName: 'funding-rate',
    maxResults: 5000,

    // Create unique route identifier
    createRouteKey: (opp) => {
        return `${opp.longExchange}_${opp.shortExchange}_${opp.pair}`;
    },

    // Data model specific to funding rate arb
    dataModel: {
        assetField: 'pair',

        createExchangePairKey: (opp) => {
            return `${opp.longExchange}(long)/${opp.shortExchange}(short)`;
        },

        requiredFields: [
            'pair',              // Trading pair (e.g., 'BTC/USDT')
            'longExchange',      // Where to go long
            'shortExchange',     // Where to go short
            'longFundingRate',   // Funding rate on long side
            'shortFundingRate',  // Funding rate on short side
            'netFundingRate',    // Net funding collected
            'fundingInterval',   // Hours between funding (usually 8)
            'dailyRate',         // Annualized daily rate
            'netProfitPercent',  // Net profit after fees
            'openingCost',       // Cost to open positions
            'liquidity'          // Liquidity rating (1-5)
        ]
    }
};

/**
 * Helper function to get config by strategy name
 */
function getConfigByStrategy(strategyName) {
    const configs = {
        'triangular': triangularArbConfig,
        'cross-exchange': crossExchangeArbConfig,
        'futures': futuresArbConfig,
        'funding-rate': fundingRateArbConfig
    };

    return configs[strategyName] || null;
}

module.exports = {
    triangularArbConfig,
    crossExchangeArbConfig,
    futuresArbConfig,
    fundingRateArbConfig,
    getConfigByStrategy
};
