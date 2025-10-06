/**
 * Transfer Arbitrage Configuration
 * Maps exchanges, supported cryptocurrencies, and transfer fees
 */

// Recommended cryptocurrencies for transfer arbitrage (fast, low fees)
const TRANSFER_CRYPTOS = {
    // TIER 1: Fast & Cheap (Recommended)
    XRP: {
        name: 'Ripple',
        avgTransferTime: 3, // minutes
        avgNetworkFee: 0.02, // USD
        confirmations: 1,
        tier: 1
    },
    XLM: {
        name: 'Stellar',
        avgTransferTime: 5,
        avgNetworkFee: 0.01,
        confirmations: 1,
        tier: 1
    },
    TRX: {
        name: 'Tron',
        avgTransferTime: 3,
        avgNetworkFee: 1.00,
        confirmations: 1,
        tier: 1
    },

    // TIER 2: Medium Speed
    LTC: {
        name: 'Litecoin',
        avgTransferTime: 15,
        avgNetworkFee: 0.10,
        confirmations: 3,
        tier: 2
    },
    BCH: {
        name: 'Bitcoin Cash',
        avgTransferTime: 15,
        avgNetworkFee: 0.05,
        confirmations: 3,
        tier: 2
    },
    DOGE: {
        name: 'Dogecoin',
        avgTransferTime: 10,
        avgNetworkFee: 2.00,
        confirmations: 6,
        tier: 2
    },

    // TIER 3: Stablecoins (Lower risk but higher fees)
    'USDT-TRC20': {
        name: 'Tether (TRC20)',
        avgTransferTime: 3,
        avgNetworkFee: 1.00,
        confirmations: 1,
        tier: 3
    },
    'USDC-ERC20': {
        name: 'USD Coin',
        avgTransferTime: 5,
        avgNetworkFee: 3.00,
        confirmations: 12,
        tier: 3
    },

    // TIER 4: Slow & Expensive (Not recommended for transfer arb)
    BTC: {
        name: 'Bitcoin',
        avgTransferTime: 30,
        avgNetworkFee: 5.00,
        confirmations: 3,
        tier: 4
    },
    ETH: {
        name: 'Ethereum',
        avgTransferTime: 10,
        avgNetworkFee: 8.00,
        confirmations: 12,
        tier: 4
    }
};

// Exchange capabilities for transfer arbitrage
// Note: This needs to be verified with actual exchange APIs
const EXCHANGE_CRYPTO_SUPPORT = {
    // South African Exchanges
    valr: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'BCH'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0001, ETH: 0.005, XRP: 0.25, LTC: 0.01 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0001, ETH: 0.01, XRP: 10 }
    },
    luno: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'BCH'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0002, ETH: 0.007, XRP: 0.50, LTC: 0.01 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0002, ETH: 0.01, XRP: 10 }
    },
    altcointrader: {
        supports: ['BTC', 'ETH', 'LTC'],
        hasUSDT: false, // Uses ZAR
        withdrawalFees: { BTC: 0.0003, ETH: 0.01, LTC: 0.01 },
        depositFees: {},
        minWithdrawal: { BTC: 0.001, ETH: 0.01 }
    },
    chainex: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.00025, ETH: 0.006, XRP: 0.20, TRX: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0005, ETH: 0.01, XRP: 10 }
    },

    // International Exchanges
    binance: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'BCH', 'TRX', 'XLM', 'DOGE', 'USDT', 'USDC'],
        hasUSDT: true,
        withdrawalFees: {
            BTC: 0.0001, ETH: 0.005, XRP: 0.25, LTC: 0.001,
            TRX: 1.0, XLM: 0.01, USDT: 1.0
        },
        depositFees: {},
        minWithdrawal: { BTC: 0.0001, ETH: 0.01, XRP: 10, USDT: 10 }
    },
    bybit: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'USDT'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0005, ETH: 0.008, XRP: 0.25, USDT: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.001, ETH: 0.02, USDT: 10 }
    },
    kraken: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'BCH', 'XLM', 'USDT'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.00015, ETH: 0.0035, XRP: 0.02, USDT: 5.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0002, ETH: 0.01, XRP: 10, USDT: 10 }
    },
    okx: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'XLM', 'USDT', 'USDC'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0004, ETH: 0.006, XRP: 0.1, TRX: 1.0, USDT: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.001, ETH: 0.01, USDT: 10 }
    },
    mexc: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'XLM', 'DOGE', 'USDT'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0002, ETH: 0.004, XRP: 0.25, TRX: 1.0, USDT: 0.8 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0001, ETH: 0.01, USDT: 5 }
    },
    kucoin: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'XLM', 'USDT', 'USDC'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0005, ETH: 0.007, XRP: 0.25, TRX: 1.0, USDT: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0005, ETH: 0.01, USDT: 10 }
    },
    htx: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'USDT'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0004, ETH: 0.005, XRP: 0.1, TRX: 1.0, USDT: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.001, ETH: 0.01, USDT: 10 }
    },
    bitget: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'USDT'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0005, ETH: 0.006, XRP: 0.25, TRX: 1.0, USDT: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.001, ETH: 0.01, USDT: 10 }
    },
    gateio: {
        supports: ['BTC', 'ETH', 'XRP', 'LTC', 'TRX', 'XLM', 'DOGE', 'USDT', 'USDC'],
        hasUSDT: true,
        withdrawalFees: { BTC: 0.0005, ETH: 0.007, XRP: 0.25, TRX: 1.0, USDT: 1.0 },
        depositFees: {},
        minWithdrawal: { BTC: 0.0005, ETH: 0.01, USDT: 10 }
    },
    gemini: {
        supports: ['BTC', 'ETH', 'LTC', 'BCH'],
        hasUSDT: false, // Uses USD
        withdrawalFees: { BTC: 0.0, ETH: 0.0, LTC: 0.0 }, // Free withdrawals (Gemini pays fees)
        depositFees: {},
        minWithdrawal: { BTC: 0.001, ETH: 0.01 }
    },
    // Add other exchanges...
};

// Minimum profitable spread (after all fees)
const MIN_PROFITABLE_SPREAD = 1.5; // 1.5% minimum profit

// Rate limiting: Sequential execution delays
const RATE_LIMITS = {
    priceCheck: 100, // ms between price checks on same exchange
    orderExecution: 200, // ms between orders
    withdrawalCheck: 5000 // ms between withdrawal status checks
};

/**
 * Find common cryptocurrencies between two exchanges
 */
function findCommonCryptos(exchange1, exchange2) {
    const ex1 = EXCHANGE_CRYPTO_SUPPORT[exchange1];
    const ex2 = EXCHANGE_CRYPTO_SUPPORT[exchange2];

    if (!ex1 || !ex2) return [];

    return ex1.supports.filter(crypto => ex2.supports.includes(crypto));
}

/**
 * Calculate total transfer cost
 */
function calculateTransferCost(crypto, fromExchange, toExchange) {
    const withdrawalFee = EXCHANGE_CRYPTO_SUPPORT[fromExchange]?.withdrawalFees[crypto] || 0;
    const depositFee = EXCHANGE_CRYPTO_SUPPORT[toExchange]?.depositFees[crypto] || 0;
    const networkFee = TRANSFER_CRYPTOS[crypto]?.avgNetworkFee || 0;

    return {
        withdrawalFee,
        depositFee,
        networkFee,
        totalUSD: withdrawalFee + depositFee + networkFee
    };
}

/**
 * Check if transfer route is viable
 */
function isViableRoute(crypto, fromExchange, toExchange) {
    const commonCryptos = findCommonCryptos(fromExchange, toExchange);
    if (!commonCryptos.includes(crypto)) return false;

    // Check if both exchanges have USDT (for start and end)
    const from = EXCHANGE_CRYPTO_SUPPORT[fromExchange];
    const to = EXCHANGE_CRYPTO_SUPPORT[toExchange];

    return from?.hasUSDT && to?.hasUSDT;
}

module.exports = {
    TRANSFER_CRYPTOS,
    EXCHANGE_CRYPTO_SUPPORT,
    MIN_PROFITABLE_SPREAD,
    RATE_LIMITS,
    findCommonCryptos,
    calculateTransferCost,
    isViableRoute
};
