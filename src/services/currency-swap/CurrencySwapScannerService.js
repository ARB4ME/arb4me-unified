// Currency Swap Scanner Service
// Scans all exchanges for XRP prices and calculates best arbitrage opportunity

const CurrencySwapSettings = require('../../models/CurrencySwapSettings');
// REMOVED: CurrencySwapCredentials - no longer needed for scanning
const RiskCalculatorService = require('./RiskCalculatorService');
const { logger } = require('../../utils/logger');
const fetch = require('node-fetch');

class CurrencySwapScannerService {
    /**
     * Scan all exchanges and find best profitable path
     * @param {number} userId - User ID
     * @returns {object} Best opportunity or null
     */
    static async scanOpportunities(userId) {
        try {
            logger.info(`Starting Currency Swap scan for user ${userId}`);

            // 1. Load user settings
            const settings = await CurrencySwapSettings.getOrCreate(userId);

            const selectedExchanges = typeof settings.selected_exchanges === 'string'
                ? JSON.parse(settings.selected_exchanges)
                : (settings.selected_exchanges || []);

            const selectedCurrencies = typeof settings.selected_currencies === 'string'
                ? JSON.parse(settings.selected_currencies)
                : (settings.selected_currencies || []);

            // XRP is bridge only, not a source/destination
            const tradableCurrencies = selectedCurrencies.filter(c => c !== 'XRP');

            if (selectedExchanges.length === 0 || tradableCurrencies.length === 0) {
                logger.warn('No exchanges or currencies selected', { userId });
                return {
                    success: false,
                    message: 'No exchanges or currencies selected'
                };
            }

            // 2. Fetch all XRP prices from exchanges
            logger.info(`Fetching XRP prices from ${selectedExchanges.length} exchanges`);
            const priceData = await this._fetchAllPrices(selectedExchanges, tradableCurrencies);

            logger.info(`Fetched prices for ${Object.keys(priceData).length} exchanges`);

            // 3. Calculate all possible paths
            logger.info('Calculating path profitability...');
            const paths = await this._calculateAllPaths(
                selectedExchanges,
                tradableCurrencies,
                priceData,
                settings
            );

            if (paths.length === 0) {
                logger.info('No profitable paths found');
                return {
                    success: true,
                    opportunity: null,
                    message: 'No profitable paths found',
                    scannedPaths: 0
                };
            }

            // 4. Sort by profit and get best one
            paths.sort((a, b) => b.profitPercent - a.profitPercent);
            const bestPath = paths[0];

            logger.info(`Best opportunity found: ${bestPath.profitPercent.toFixed(2)}% profit`, {
                path: bestPath.id,
                profit: bestPath.profitAmount
            });

            return {
                success: true,
                opportunity: bestPath,
                scannedPaths: paths.length,
                totalPaths: selectedExchanges.length * (selectedExchanges.length - 1) * tradableCurrencies.length * (tradableCurrencies.length - 1)
            };

        } catch (error) {
            logger.error('Currency Swap scan failed', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Fetch XRP prices from all exchanges
     * @private
     */
    static async _fetchAllPrices(exchanges, currencies) {
        const priceData = {};
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        for (const exchange of exchanges) {
            priceData[exchange] = {};

            for (const currency of currencies) {
                try {
                    const pair = `XRP/${currency}`;
                    const exchangeLower = exchange.toLowerCase();

                    const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/ticker`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pair })
                    });

                    const data = await response.json();

                    if (data.success && data.data) {
                        // Extract bid/ask prices (format varies by exchange)
                        const price = data.data;
                        priceData[exchange][currency] = {
                            bid: parseFloat(price.bid || price.bidPrice || price.buy || 0),
                            ask: parseFloat(price.ask || price.askPrice || price.sell || 0),
                            last: parseFloat(price.last || price.lastPrice || price.price || 0)
                        };

                        logger.info(`${exchange} ${pair}: bid=${priceData[exchange][currency].bid}, ask=${priceData[exchange][currency].ask}`);
                    } else {
                        logger.warn(`No price data for ${exchange} ${pair}`);
                    }

                } catch (error) {
                    logger.warn(`Failed to fetch ${exchange} XRP/${currency} price`, {
                        error: error.message
                    });
                }
            }
        }

        return priceData;
    }

    /**
     * Calculate profitability for all possible paths
     * @private
     */
    static async _calculateAllPaths(exchanges, currencies, priceData, settings) {
        const profitablePaths = [];

        // Get fee structure (simplified - can be enhanced per exchange)
        const defaultFees = {
            makerFee: 0.001,  // 0.1%
            takerFee: 0.001,  // 0.1%
            withdrawalFee: 0.1 // 0.1 XRP flat fee
        };

        for (const sourceExchange of exchanges) {
            for (const destExchange of exchanges) {
                if (sourceExchange === destExchange) continue;

                for (const sourceCurrency of currencies) {
                    for (const destCurrency of currencies) {
                        if (sourceCurrency === destCurrency) continue;

                        // Check if we have prices
                        if (!priceData[sourceExchange]?.[sourceCurrency] ||
                            !priceData[destExchange]?.[destCurrency]) {
                            continue;
                        }

                        // Calculate path profit
                        const pathProfit = this._calculatePathProfit(
                            sourceExchange,
                            sourceCurrency,
                            destExchange,
                            destCurrency,
                            priceData,
                            defaultFees,
                            settings.max_trade_amount_usdt || 5000
                        );

                        // Check if profitable above threshold
                        if (pathProfit.profitPercent >= (settings.threshold_percent || 0.5)) {
                            profitablePaths.push({
                                id: `${sourceExchange}-${sourceCurrency}-${destExchange}-${destCurrency}`,
                                sourceExchange,
                                sourceCurrency,
                                destExchange,
                                destCurrency,
                                bridgeAsset: 'XRP',
                                ...pathProfit
                            });
                        }
                    }
                }
            }
        }

        return profitablePaths;
    }

    /**
     * Calculate profit for a single path
     * @private
     */
    static _calculatePathProfit(sourceExchange, sourceCurrency, destExchange, destCurrency, priceData, fees, tradeAmount) {
        // Input amount in source currency (e.g., 1000 USD)
        const inputAmount = tradeAmount;

        // Leg 1: Buy XRP with source currency on source exchange
        const sourcePrice = priceData[sourceExchange][sourceCurrency];
        const xrpBought = (inputAmount / sourcePrice.ask) * (1 - fees.takerFee);

        // Leg 2: Withdraw XRP (flat fee)
        const xrpAfterWithdrawal = xrpBought - fees.withdrawalFee;

        if (xrpAfterWithdrawal <= 0) {
            return { profitPercent: -100, profitAmount: -inputAmount };
        }

        // Leg 3: Sell XRP for dest currency on dest exchange
        const destPrice = priceData[destExchange][destCurrency];
        const outputAmount = (xrpAfterWithdrawal * destPrice.bid) * (1 - fees.takerFee);

        // Calculate profit
        const profitAmount = outputAmount - inputAmount;
        const profitPercent = (profitAmount / inputAmount) * 100;

        return {
            profitPercent,
            profitAmount,
            inputAmount,
            outputAmount,
            xrpBought,
            xrpAfterWithdrawal,
            fees: {
                leg1Fee: inputAmount * fees.takerFee,
                withdrawalFee: fees.withdrawalFee,
                leg3Fee: (xrpAfterWithdrawal * destPrice.bid) * fees.takerFee
            }
        };
    }
}

module.exports = CurrencySwapScannerService;
