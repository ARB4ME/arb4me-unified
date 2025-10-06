/**
 * Transfer Arbitrage Smart Shopper
 * Scans all exchanges for profitable transfer opportunities
 */

const {
    TRANSFER_CRYPTOS,
    EXCHANGE_CRYPTO_SUPPORT,
    MIN_PROFITABLE_SPREAD,
    findCommonCryptos,
    calculateTransferCost,
    isViableRoute
} = require('../config/transfer-arb-config');

class TransferArbScanner {
    constructor() {
        this.opportunities = [];
        this.lastScan = null;
    }

    /**
     * Main scanning function - finds all profitable transfer routes
     * @param {Object} exchangePrices - Current prices from all exchanges
     * @param {Object} userBalances - User's USDT balances on each exchange
     * @returns {Array} Sorted list of opportunities
     */
    async scanOpportunities(exchangePrices, userBalances) {
        console.log('🔍 Starting Transfer Arbitrage scan across all exchanges...');

        this.opportunities = [];
        const exchanges = Object.keys(EXCHANGE_CRYPTO_SUPPORT);

        // Check all exchange pairs
        for (let i = 0; i < exchanges.length; i++) {
            for (let j = 0; j < exchanges.length; j++) {
                if (i === j) continue; // Skip same exchange

                const fromExchange = exchanges[i];
                const toExchange = exchanges[j];

                // Find cryptos supported by both
                const commonCryptos = findCommonCryptos(fromExchange, toExchange);

                // Check each common crypto for arbitrage opportunity
                for (const crypto of commonCryptos) {
                    const opportunity = await this.analyzeRoute(
                        fromExchange,
                        toExchange,
                        crypto,
                        exchangePrices,
                        userBalances
                    );

                    if (opportunity && opportunity.profitable) {
                        this.opportunities.push(opportunity);
                    }
                }
            }
        }

        // Sort by profitability (highest first)
        this.opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);

        this.lastScan = new Date();
        console.log(`✅ Scan complete. Found ${this.opportunities.length} opportunities`);

        return this.opportunities;
    }

    /**
     * Analyze a specific transfer route
     */
    async analyzeRoute(fromExchange, toExchange, crypto, exchangePrices, userBalances) {
        // Check if route is viable
        if (!isViableRoute(crypto, fromExchange, toExchange)) {
            return null;
        }

        // Get prices
        const buyPrice = exchangePrices[fromExchange]?.[crypto]?.ask; // We buy at ask price
        const sellPrice = exchangePrices[toExchange]?.[crypto]?.bid; // We sell at bid price

        if (!buyPrice || !sellPrice) {
            return null; // No price data
        }

        // Get user's USDT balance on source exchange
        const availableUSDT = userBalances[fromExchange]?.USDT || 0;
        if (availableUSDT < 10) {
            return null; // Not enough USDT to transfer
        }

        // Calculate fees
        const transferCosts = calculateTransferCost(crypto, fromExchange, toExchange);
        const cryptoInfo = TRANSFER_CRYPTOS[crypto];

        // Calculate quantities
        const usdtToSpend = Math.min(availableUSDT, 1000); // Max $1000 per transfer
        const cryptoQuantity = usdtToSpend / buyPrice;

        // Calculate withdrawal fee in USD
        const withdrawalFeeUSD = transferCosts.withdrawalFee * buyPrice;

        // Calculate revenue at destination
        const cryptoReceived = cryptoQuantity - transferCosts.withdrawalFee;
        const revenueUSDT = cryptoReceived * sellPrice;

        // Calculate net profit
        const totalCost = usdtToSpend + withdrawalFeeUSD + transferCosts.networkFee;
        const netProfit = revenueUSDT - totalCost;
        const netProfitPercent = (netProfit / usdtToSpend) * 100;

        // Check if profitable
        const profitable = netProfitPercent >= MIN_PROFITABLE_SPREAD;

        return {
            fromExchange,
            toExchange,
            crypto,
            buyPrice,
            sellPrice,
            priceSpread: ((sellPrice - buyPrice) / buyPrice) * 100,

            // Execution details
            usdtToSpend,
            cryptoQuantity,
            cryptoReceived,
            revenueUSDT,

            // Costs
            withdrawalFee: transferCosts.withdrawalFee,
            withdrawalFeeUSD,
            networkFee: transferCosts.networkFee,
            totalFees: withdrawalFeeUSD + transferCosts.networkFee,

            // Profit
            netProfit,
            netProfitPercent,
            profitable,

            // Timing
            estimatedTransferTime: cryptoInfo?.avgTransferTime || 30,
            confirmations: cryptoInfo?.confirmations || 3,

            // Risk score (1-10, lower is better)
            riskScore: this.calculateRiskScore(crypto, fromExchange, toExchange, netProfitPercent),

            // Timestamp
            scannedAt: new Date()
        };
    }

    /**
     * Calculate risk score for a route
     */
    calculateRiskScore(crypto, fromExchange, toExchange, profitPercent) {
        let risk = 5; // Base risk

        // Crypto tier affects risk
        const tier = TRANSFER_CRYPTOS[crypto]?.tier || 4;
        risk += (tier - 1); // Tier 1 = +0, Tier 4 = +3

        // Transfer time affects risk
        const transferTime = TRANSFER_CRYPTOS[crypto]?.avgTransferTime || 30;
        if (transferTime > 20) risk += 2;
        else if (transferTime > 10) risk += 1;

        // Lower profit margin = higher risk
        if (profitPercent < 2) risk += 2;
        else if (profitPercent < 3) risk += 1;

        // Exchange reliability (could be enhanced with historical data)
        const reliableExchanges = ['binance', 'kraken', 'coinbase', 'okx'];
        if (!reliableExchanges.includes(fromExchange)) risk += 1;
        if (!reliableExchanges.includes(toExchange)) risk += 1;

        return Math.min(10, Math.max(1, risk)); // Clamp between 1-10
    }

    /**
     * Get top opportunities filtered by criteria
     */
    getTopOpportunities(limit = 10, filters = {}) {
        let filtered = [...this.opportunities];

        // Apply filters
        if (filters.minProfit) {
            filtered = filtered.filter(opp => opp.netProfitPercent >= filters.minProfit);
        }

        if (filters.maxRisk) {
            filtered = filtered.filter(opp => opp.riskScore <= filters.maxRisk);
        }

        if (filters.maxTransferTime) {
            filtered = filtered.filter(opp => opp.estimatedTransferTime <= filters.maxTransferTime);
        }

        if (filters.preferredCryptos && filters.preferredCryptos.length > 0) {
            filtered = filtered.filter(opp => filters.preferredCryptos.includes(opp.crypto));
        }

        if (filters.preferredExchanges && filters.preferredExchanges.length > 0) {
            filtered = filtered.filter(opp =>
                filters.preferredExchanges.includes(opp.fromExchange) &&
                filters.preferredExchanges.includes(opp.toExchange)
            );
        }

        return filtered.slice(0, limit);
    }

    /**
     * Get specific route analysis
     */
    getRouteAnalysis(fromExchange, toExchange, crypto) {
        return this.opportunities.find(opp =>
            opp.fromExchange === fromExchange &&
            opp.toExchange === toExchange &&
            opp.crypto === crypto
        );
    }

    /**
     * Get all opportunities for a specific crypto
     */
    getOpportunitiesForCrypto(crypto) {
        return this.opportunities.filter(opp => opp.crypto === crypto);
    }

    /**
     * Get summary statistics
     */
    getScanSummary() {
        if (this.opportunities.length === 0) {
            return {
                totalOpportunities: 0,
                profitableRoutes: 0,
                avgProfitPercent: 0,
                bestOpportunity: null
            };
        }

        const profitable = this.opportunities.filter(opp => opp.profitable);

        return {
            totalOpportunities: this.opportunities.length,
            profitableRoutes: profitable.length,
            avgProfitPercent: profitable.reduce((sum, opp) => sum + opp.netProfitPercent, 0) / profitable.length || 0,
            bestOpportunity: this.opportunities[0], // Already sorted by profit
            lastScan: this.lastScan
        };
    }
}

module.exports = TransferArbScanner;
