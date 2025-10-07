// Currency Swap Execution Service
// Handles currency conversion through crypto bridges (XRP/USDT)

const crypto = require('crypto');
const { systemLogger } = require('../utils/logger');
const CurrencySwap = require('../models/CurrencySwap');
const CurrencySwapSettings = require('../models/CurrencySwapSettings');
const priceCacheService = require('./priceCacheService');

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
 * Cache for forex rates (1 hour TTL)
 */
let forexRateCache = {
    rates: {},
    lastUpdated: null,
    ttl: 3600000 // 1 hour in milliseconds
};

/**
 * Fetch real forex rates from free API
 */
async function fetchForexRates(baseCurrency = 'USD') {
    // Check cache first
    if (forexRateCache.rates[baseCurrency] && forexRateCache.lastUpdated) {
        const cacheAge = Date.now() - forexRateCache.lastUpdated;
        if (cacheAge < forexRateCache.ttl) {
            systemLogger.trading(`Using cached forex rates for ${baseCurrency}`, {
                age: `${Math.floor(cacheAge / 1000)}s`
            });
            return forexRateCache.rates[baseCurrency];
        }
    }

    try {
        // Using exchangerate-api.com free tier (1,500 requests/month)
        // Alternative: api.exchangerate.host (also free)
        const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${baseCurrency}`);

        if (!response.ok) {
            throw new Error(`Forex API error: ${response.status}`);
        }

        const data = await response.json();

        // Cache the rates
        if (!forexRateCache.rates) forexRateCache.rates = {};
        forexRateCache.rates[baseCurrency] = data.rates;
        forexRateCache.lastUpdated = Date.now();

        systemLogger.trading(`Fetched fresh forex rates for ${baseCurrency}`, {
            pairCount: Object.keys(data.rates).length
        });

        return data.rates;

    } catch (error) {
        systemLogger.error(`Failed to fetch forex rates for ${baseCurrency}`, {
            error: error.message
        });

        // Return cached data even if stale
        if (forexRateCache.rates[baseCurrency]) {
            systemLogger.warn(`Using stale forex rates for ${baseCurrency}`);
            return forexRateCache.rates[baseCurrency];
        }

        throw error;
    }
}

/**
 * Compare with Wise/TransferWise rates (using real forex data)
 */
async function compareWithWiseRate(fromCurrency, toCurrency, effectiveRate) {
    try {
        // Normalize currency codes (USDT -> USD for forex comparison)
        const fromFiat = fromCurrency === 'USDT' ? 'USD' : fromCurrency;
        const toFiat = toCurrency === 'USDT' ? 'USD' : toCurrency;

        // Fetch real forex rates
        const rates = await fetchForexRates(fromFiat);

        if (!rates || !rates[toFiat]) {
            systemLogger.warn(`No forex rate available for ${fromFiat}/${toFiat}`);
            return {
                wiseRate: null,
                yourRate: effectiveRate,
                savingsPercent: null
            };
        }

        // Real market rate (similar to what Wise would charge before fees)
        const marketRate = rates[toFiat];

        // Wise typically adds 0.5-1% markup on top of market rate
        // We'll use 0.7% as average Wise fee
        const wiseMarkup = 1.007;
        const wiseRate = marketRate * wiseMarkup;

        // Calculate savings: how much better is your rate vs Wise
        // For direct comparison, we compare how much of toCurrency you get per 1 unit of fromCurrency
        // Lower rate means worse deal (paying more fromCurrency for each toCurrency)
        // Higher rate means better deal (paying less fromCurrency for each toCurrency)

        // effectiveRate is how much fromCurrency you pay per 1 toCurrency
        // wiseRate is how much fromCurrency Wise charges per 1 toCurrency
        // If your rate is lower, you're saving money vs Wise

        const savingsPercent = ((wiseRate - effectiveRate) / wiseRate) * 100;

        systemLogger.trading(`Forex comparison for ${fromFiat}/${toFiat}`, {
            marketRate,
            wiseRate,
            yourRate: effectiveRate,
            savingsPercent: savingsPercent.toFixed(2) + '%'
        });

        return {
            wiseRate,
            marketRate,
            yourRate: effectiveRate,
            savingsPercent,
            betterThanWise: savingsPercent > 0
        };
    } catch (error) {
        systemLogger.error('Failed to compare with Wise rate', { error: error.message });

        // Return mock fallback for critical pairs
        const mockWiseRates = {
            'ZAR-USDT': 18.5,
            'ZAR-USD': 18.5,
            'USD-EUR': 0.92,
            'EUR-GBP': 0.86,
            'USD-GBP': 0.79
        };

        const pairKey = `${fromCurrency}-${toCurrency}`;
        const fallbackRate = mockWiseRates[pairKey];

        if (fallbackRate) {
            const savingsPercent = ((fallbackRate - effectiveRate) / fallbackRate) * 100;
            return {
                wiseRate: fallbackRate,
                yourRate: effectiveRate,
                savingsPercent,
                betterThanWise: savingsPercent > 0,
                isFallback: true
            };
        }

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

            for (const route of routes) {
                try {
                    // Fetch REAL prices for each hop in the route
                    const routeWithPrices = [];
                    let pricesAvailable = true;

                    for (const hop of route.path) {
                        const [crypto, fiat] = hop.pair.split('/');
                        const exchange = hop.exchange;

                        // Fetch real price from exchange
                        const price = await priceCacheService.getFiatCryptoPrice(
                            exchange.toLowerCase(),
                            crypto,
                            fiat
                        );

                        if (!price) {
                            systemLogger.warn(`Price not available for ${hop.pair} on ${exchange}`);
                            pricesAvailable = false;
                            break;
                        }

                        routeWithPrices.push({
                            ...hop,
                            rate: price
                        });
                    }

                    // Skip this route if any price is unavailable
                    if (!pricesAvailable) {
                        continue;
                    }

                    // Calculate effective rate with REAL prices
                    const testAmount = 10000; // Test with 10000 units of fromCurrency
                    const calculation = calculateEffectiveRate(
                        fromCurrency,
                        toCurrency,
                        routeWithPrices,
                        testAmount
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
                            route: routeWithPrices,
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

                } catch (error) {
                    systemLogger.error(`Error calculating route`, {
                        route: route.path.map(p => p.description).join(' → '),
                        error: error.message
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
