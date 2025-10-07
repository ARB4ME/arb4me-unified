// Currency Swap Execution Service
// Handles currency conversion through crypto bridges (XRP/USDT)

const crypto = require('crypto');
const { systemLogger } = require('../utils/logger');
const CurrencySwap = require('../models/CurrencySwap');
const CurrencySwapSettings = require('../models/CurrencySwapSettings');

/**
 * Exchange configuration for fiat currency support
 */
const EXCHANGE_FIAT_SUPPORT = {
    VALR: { fiats: ['ZAR', 'USD'], bridges: ['USDT', 'XRP'] },
    Luno: { fiats: ['ZAR', 'USD', 'NGN'], bridges: ['USDT', 'USDC', 'XRP'] },
    ChainEX: { fiats: ['ZAR'], bridges: ['USDT', 'USDC', 'XRP'] },
    Kraken: { fiats: ['USD', 'EUR', 'GBP', 'AUD', 'CAD'], bridges: ['USDT', 'USDC', 'XRP'] },
    Bybit: { fiats: ['USD', 'EUR'], bridges: ['USDT', 'USDC', 'XRP'] },
    Gate: { fiats: ['EUR', 'GBP', 'BRL', 'TRY', 'PLN'], bridges: ['USDT', 'USDC', 'XRP'] },
    OKX: { fiats: ['USD', 'EUR', 'GBP', 'BRL', 'TRY', 'PLN'], bridges: ['USDT', 'USDC', 'XRP'] },
    MEXC: { fiats: ['USD', 'AUD'], bridges: ['USDT', 'XRP'] },
    KuCoin: { fiats: ['USD', 'EUR', 'BRL', 'TRY', 'PLN'], bridges: ['USDT', 'USDC', 'XRP'] },
    XT: { fiats: [], bridges: ['USDT', 'USDC', 'XRP'] },
    AscendEX: { fiats: ['USD'], bridges: ['USDT', 'XRP'] },
    HTX: { fiats: [], bridges: ['USDT', 'USDC', 'XRP'] },
    BingX: { fiats: [], bridges: ['USDT', 'USDC', 'XRP'] },
    Bitget: { fiats: ['EUR'], bridges: ['USDT', 'USDC', 'XRP'] },
    BitMart: { fiats: ['USD', 'EUR'], bridges: ['USDT', 'USDC', 'XRP'] },
    Bitrue: { fiats: [], bridges: ['USDT', 'USDC', 'XRP'] },
    Gemini: { fiats: ['EUR'], bridges: ['USDT', 'USDC', 'XRP'] },
    'Crypto.com': { fiats: ['EUR'], bridges: ['USDT', 'USDC', 'XRP'] }
};

/**
 * Network fees for different cryptocurrencies (approximate in USDT)
 */
const NETWORK_FEES = {
    XRP: 0.0001,      // Extremely cheap
    USDT_TRC20: 1.0,  // Tron network
    USDT_ERC20: 5.0,  // Ethereum network
    USDT_POLYGON: 0.1, // Polygon network
    USDC_TRC20: 1.0,
    USDC_ERC20: 5.0
};

/**
 * Calculate all fees for a swap route
 */
function calculateAllFees(route, amount) {
    let tradingFees = 0;
    let withdrawalFees = 0;
    let networkFees = 0;

    route.forEach((hop, index) => {
        // Trading fees (assume 0.1% maker/taker average per exchange)
        const tradingFee = (hop.amount || amount) * 0.001; // 0.1%
        tradingFees += tradingFee;

        // Withdrawal fee (only on transfers between exchanges)
        if (index < route.length - 1) {
            const bridge = hop.bridge || 'XRP';

            // Network fee based on bridge currency
            if (bridge === 'XRP') {
                networkFees += NETWORK_FEES.XRP;
            } else if (bridge === 'USDT') {
                networkFees += NETWORK_FEES.USDT_TRC20; // Assume TRC20
            } else if (bridge === 'USDC') {
                networkFees += NETWORK_FEES.USDC_TRC20;
            }

            // Exchange withdrawal fee (approx)
            withdrawalFees += networkFees * 0.2; // 20% markup
        }
    });

    const totalFees = tradingFees + withdrawalFees + networkFees;

    return {
        trading: tradingFees,
        withdrawal: withdrawalFees,
        network: networkFees,
        total: totalFees
    };
}

/**
 * Calculate effective exchange rate through multi-hop route
 */
function calculateEffectiveRate(fromCurrency, toCurrency, route, amount) {
    let currentAmount = amount;

    // Simulate conversion through each hop
    route.forEach(hop => {
        const { exchange, action, pair, rate } = hop;

        if (action === 'buy') {
            // Buy bridge with fiat: amount of fiat → amount of bridge
            currentAmount = currentAmount / rate; // e.g., 10000 ZAR / 18.5 = 540.5 XRP
        } else if (action === 'sell') {
            // Sell bridge for fiat: amount of bridge → amount of fiat
            currentAmount = currentAmount * rate; // e.g., 540.5 XRP * 1.02 = 551.3 USDT
        }
    });

    // Calculate fees and deduct
    const fees = calculateAllFees(route, amount);
    const finalAmount = currentAmount - fees.total;

    // Effective rate: how much fromCurrency per toCurrency
    const effectiveRate = amount / finalAmount;

    return {
        effectiveRate,
        finalAmount,
        fees,
        grossAmount: currentAmount
    };
}

/**
 * Select optimal bridge currency for a route
 */
function selectOptimalBridge(fromExchange, toExchange, preference = 'AUTO') {
    const fromBridges = EXCHANGE_FIAT_SUPPORT[fromExchange]?.bridges || [];
    const toBridges = EXCHANGE_FIAT_SUPPORT[toExchange]?.bridges || [];

    // Find common bridges
    const commonBridges = fromBridges.filter(b => toBridges.includes(b));

    if (commonBridges.length === 0) {
        throw new Error(`No common bridge currency between ${fromExchange} and ${toExchange}`);
    }

    // If user has preference and it's available, use it
    if (preference !== 'AUTO' && commonBridges.includes(preference)) {
        return preference;
    }

    // Auto-select: prefer XRP (fastest, cheapest), then USDT (most liquid)
    if (commonBridges.includes('XRP')) return 'XRP';
    if (commonBridges.includes('USDT')) return 'USDT';
    if (commonBridges.includes('USDC')) return 'USDC';

    return commonBridges[0];
}

/**
 * Find all possible routes for a currency swap
 */
function findAllRoutes(fromCurrency, toCurrency, bridgePreference = 'AUTO') {
    const routes = [];

    // Find exchanges that support fromCurrency
    const fromExchanges = Object.keys(EXCHANGE_FIAT_SUPPORT).filter(ex =>
        EXCHANGE_FIAT_SUPPORT[ex].fiats.includes(fromCurrency)
    );

    // Find exchanges that support toCurrency
    const toExchanges = Object.keys(EXCHANGE_FIAT_SUPPORT).filter(ex =>
        EXCHANGE_FIAT_SUPPORT[ex].fiats.includes(toCurrency)
    );

    systemLogger.trading(`Currency swap route search`, {
        fromCurrency,
        toCurrency,
        fromExchanges: fromExchanges.length,
        toExchanges: toExchanges.length
    });

    // Generate 2-hop routes (direct bridge)
    fromExchanges.forEach(fromEx => {
        toExchanges.forEach(toEx => {
            try {
                const bridge = selectOptimalBridge(fromEx, toEx, bridgePreference);

                routes.push({
                    type: '2-hop',
                    fromExchange: fromEx,
                    toExchange: toEx,
                    bridge,
                    path: [
                        {
                            exchange: fromEx,
                            action: 'buy',
                            pair: `${bridge}/${fromCurrency}`,
                            description: `Buy ${bridge} with ${fromCurrency} on ${fromEx}`
                        },
                        {
                            exchange: toEx,
                            action: 'sell',
                            pair: `${bridge}/${toCurrency}`,
                            description: `Sell ${bridge} for ${toCurrency} on ${toEx}`
                        }
                    ]
                });
            } catch (error) {
                // No common bridge, skip this route
            }
        });
    });

    systemLogger.trading(`Generated ${routes.length} possible routes`, {
        fromCurrency,
        toCurrency
    });

    return routes;
}

/**
 * Compare with Wise/TransferWise rates (or other forex baseline)
 */
async function compareWithWiseRate(fromCurrency, toCurrency, effectiveRate) {
    try {
        // TODO: Integrate with Wise API or forex rate API
        // For now, use mock comparison

        // Mock Wise rates (approximate)
        const mockWiseRates = {
            'ZAR-USDT': 18.5,
            'ZAR-USD': 18.5,
            'USD-EUR': 0.92,
            'EUR-GBP': 0.86,
            'USD-GBP': 0.79
        };

        const pairKey = `${fromCurrency}-${toCurrency}`;
        const wiseRate = mockWiseRates[pairKey];

        if (!wiseRate) {
            systemLogger.trading(`No Wise rate available for ${pairKey}`);
            return {
                wiseRate: null,
                yourRate: effectiveRate,
                savingsPercent: null
            };
        }

        // Calculate savings: how much better is your rate vs Wise
        // Lower rate is better (less fromCurrency per toCurrency)
        const savingsPercent = ((wiseRate - effectiveRate) / wiseRate) * 100;

        return {
            wiseRate,
            yourRate: effectiveRate,
            savingsPercent,
            betterThanWise: savingsPercent > 0
        };
    } catch (error) {
        systemLogger.error('Failed to compare with Wise rate', { error: error.message });
        return {
            wiseRate: null,
            yourRate: effectiveRate,
            savingsPercent: null
        };
    }
}

/**
 * Detect currency swap opportunities
 */
async function detectCurrencySwapOpportunities(userId, category = 'ZAR') {
    try {
        const settings = await CurrencySwapSettings.getOrCreate(userId);
        const opportunities = [];

        // Check if category is enabled
        const enabledCategories = typeof settings.enabled_categories === 'string'
            ? JSON.parse(settings.enabled_categories)
            : settings.enabled_categories;

        if (!enabledCategories[category]) {
            systemLogger.trading(`Category ${category} is disabled for user ${userId}`);
            return [];
        }

        // Get allowed pairs
        const allowedPairs = settings.allowed_pairs || [];

        systemLogger.trading(`Scanning for ${category} currency swap opportunities`, {
            userId,
            allowedPairs: allowedPairs.length,
            threshold: settings.threshold_percent
        });

        // Scan each allowed pair
        for (const pair of allowedPairs) {
            const [fromCurrency, toCurrency] = pair.split('-');

            // Find routes
            const routes = findAllRoutes(fromCurrency, toCurrency, settings.preferred_bridge);

            // TODO: Get real-time prices from exchanges
            // For now, calculate with mock rates

            for (const route of routes) {
                // Mock calculation (in production, fetch real prices)
                const mockAmount = 10000; // Test with 10000 units of fromCurrency
                const calculation = calculateEffectiveRate(
                    fromCurrency,
                    toCurrency,
                    route.path.map(p => ({
                        ...p,
                        rate: Math.random() * 20 + 15 // Mock rate
                    })),
                    mockAmount
                );

                // Compare with Wise
                const comparison = await compareWithWiseRate(
                    fromCurrency,
                    toCurrency,
                    calculation.effectiveRate
                );

                // Calculate net profit percentage
                const netProfitPercent = comparison.savingsPercent || 0;

                // Check if meets threshold
                if (netProfitPercent >= settings.threshold_percent) {
                    opportunities.push({
                        category,
                        pair,
                        fromCurrency,
                        toCurrency,
                        route: route.path,
                        fromExchange: route.fromExchange,
                        toExchange: route.toExchange,
                        bridge: route.bridge,
                        effectiveRate: calculation.effectiveRate,
                        wiseRate: comparison.wiseRate,
                        netProfit: netProfitPercent,
                        fees: calculation.fees,
                        estimatedAmount: calculation.finalAmount,
                        meetsThreshold: true
                    });
                }
            }
        }

        systemLogger.trading(`Found ${opportunities.length} opportunities above threshold`, {
            userId,
            category,
            threshold: settings.threshold_percent
        });

        return opportunities;
    } catch (error) {
        systemLogger.error('Failed to detect currency swap opportunities', {
            userId,
            category,
            error: error.message
        });
        throw error;
    }
}

/**
 * Execute currency swap
 * NOTE: This uses the same exchange execution methods from transferExecutionService
 */
async function executeCurrencySwap(swapId, userId, credentials) {
    const startTime = Date.now();

    try {
        // Get swap record
        const swap = await CurrencySwap.findById(swapId);
        if (!swap) {
            throw new Error(`Swap ${swapId} not found`);
        }

        // Update status to executing
        await CurrencySwap.updateStatus(swapId, 'executing');

        systemLogger.trading('Executing currency swap', {
            swapId,
            userId,
            from: swap.from_currency,
            to: swap.to_currency,
            bridge: swap.bridge_currency,
            amount: swap.amount
        });

        // Parse route
        const route = typeof swap.route === 'string' ? JSON.parse(swap.route) : swap.route;
        const txHashes = [];

        // Execute each hop in the route
        for (let i = 0; i < route.length; i++) {
            const hop = route[i];
            const { exchange, action, pair } = hop;

            systemLogger.trading(`Executing hop ${i + 1}/${route.length}`, {
                exchange,
                action,
                pair
            });

            // Import transferExecutionService to reuse exchange methods
            const transferExecService = require('./transferExecutionService');
            const [crypto, fiat] = pair.split('/');

            if (action === 'buy') {
                // Buy crypto with fiat
                const result = await transferExecService.executeBuy(
                    exchange,
                    crypto,
                    swap.amount,
                    credentials[exchange]
                );

                hop.filled = result.quantity;
                hop.rate = result.averagePrice;
                hop.fees = result.fee || 0;
                hop.timestamp = new Date();

                if (result.txHash) txHashes.push(result.txHash);

            } else if (action === 'sell') {
                // Sell crypto for fiat
                const result = await transferExecService.executeSell(
                    exchange,
                    crypto,
                    route[i-1].filled, // Use quantity from previous hop
                    credentials[exchange]
                );

                hop.filled = result.usdtReceived || result.quantity;
                hop.rate = result.averagePrice;
                hop.fees = result.fee || 0;
                hop.timestamp = new Date();

                if (result.txHash) txHashes.push(result.txHash);
            }

            // If not the last hop, need to transfer between exchanges
            if (i < route.length - 1) {
                const nextExchange = route[i + 1].exchange;

                systemLogger.trading(`Transferring ${crypto} from ${exchange} to ${nextExchange}`);

                // TODO: Implement withdrawal and deposit monitoring
                // For now, just log
                systemLogger.trading('Transfer between exchanges not yet implemented', {
                    from: exchange,
                    to: nextExchange,
                    crypto,
                    amount: hop.filled
                });
            }
        }

        // Calculate final results
        const executionTime = Date.now() - startTime;
        const finalHop = route[route.length - 1];
        const finalAmount = finalHop.filled;

        // Recalculate effective rate with actual execution data
        const effectiveRate = swap.amount / finalAmount;

        // Compare with Wise
        const comparison = await compareWithWiseRate(
            swap.from_currency,
            swap.to_currency,
            effectiveRate
        );

        // Calculate total fees
        const totalFees = calculateAllFees(route, swap.amount);

        // Update swap with results
        await CurrencySwap.updateResults(swapId, {
            route,
            effectiveRate,
            wiseRate: comparison.wiseRate,
            savingsPercent: comparison.savingsPercent,
            netProfit: comparison.savingsPercent,
            totalFees,
            executionTime,
            txHashes,
            status: 'completed'
        });

        systemLogger.trading('Currency swap completed successfully', {
            swapId,
            effectiveRate,
            savingsVsWise: `${comparison.savingsPercent?.toFixed(2)}%`,
            executionTime: `${executionTime}ms`
        });

        return {
            success: true,
            swapId,
            effectiveRate,
            wiseRate: comparison.wiseRate,
            savings: comparison.savingsPercent,
            finalAmount,
            executionTime,
            txHashes
        };

    } catch (error) {
        systemLogger.error('Currency swap execution failed', {
            swapId,
            userId,
            error: error.message
        });

        // Update swap status to failed
        await CurrencySwap.updateStatus(swapId, 'failed', error.message);

        throw error;
    }
}

module.exports = {
    calculateAllFees,
    calculateEffectiveRate,
    selectOptimalBridge,
    findAllRoutes,
    compareWithWiseRate,
    detectCurrencySwapOpportunities,
    executeCurrencySwap,
    EXCHANGE_FIAT_SUPPORT,
    NETWORK_FEES
};
