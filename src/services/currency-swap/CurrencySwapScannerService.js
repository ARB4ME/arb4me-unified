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

            // Calculate total possible paths
            const totalPossiblePaths = selectedExchanges.length * (selectedExchanges.length - 1) * tradableCurrencies.length * (tradableCurrencies.length - 1);

            if (paths.length === 0) {
                logger.warn('[SCANNER] No paths could be calculated - likely missing price data');
                return {
                    success: true,
                    opportunity: null,
                    message: 'No paths could be calculated (missing price data)',
                    scannedPaths: 0,
                    totalPossiblePaths
                };
            }

            // 4. Sort by profit and get best one (even if it's a loss)
            paths.sort((a, b) => b.profitPercent - a.profitPercent);
            const bestPath = paths[0];

            // Check if best path is profitable
            const isProfitable = bestPath.profitPercent > 0;
            const meetsThreshold = bestPath.profitPercent >= (settings.threshold_percent || 0.5);

            if (isProfitable && meetsThreshold) {
                logger.info(`[SCANNER] ✅ Best opportunity PROFITABLE and meets threshold: ${bestPath.profitPercent.toFixed(4)}%`, {
                    path: bestPath.id,
                    profit: bestPath.profitAmount,
                    threshold: settings.threshold_percent || 0.5
                });
            } else if (isProfitable) {
                logger.info(`[SCANNER] ⚠️ Best opportunity profitable but BELOW threshold: ${bestPath.profitPercent.toFixed(4)}%`, {
                    path: bestPath.id,
                    profit: bestPath.profitAmount,
                    threshold: settings.threshold_percent || 0.5
                });
            } else {
                logger.warn(`[SCANNER] 📉 Best path is a LOSS: ${bestPath.profitPercent.toFixed(4)}%`, {
                    path: bestPath.id,
                    loss: bestPath.profitAmount
                });
            }

            return {
                success: true,
                opportunity: bestPath,
                scannedPaths: paths.length,
                totalPossiblePaths,
                isProfitable,
                meetsThreshold
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
        const allPaths = [];
        let calculatedCount = 0;
        let skippedNoPriceData = 0;

        // Get fee structure (simplified - can be enhanced per exchange)
        const defaultFees = {
            makerFee: 0.001,  // 0.1%
            takerFee: 0.001,  // 0.1%
            withdrawalFee: 0.1 // 0.1 XRP flat fee
        };

        logger.info(`[SCANNER] Starting path calculation for ${exchanges.length} exchanges and ${currencies.length} currencies`);

        for (const sourceExchange of exchanges) {
            for (const destExchange of exchanges) {
                if (sourceExchange === destExchange) continue;

                for (const sourceCurrency of currencies) {
                    for (const destCurrency of currencies) {
                        if (sourceCurrency === destCurrency) continue;

                        // Check if we have prices
                        if (!priceData[sourceExchange]?.[sourceCurrency] ||
                            !priceData[destExchange]?.[destCurrency]) {
                            skippedNoPriceData++;
                            logger.debug(`[SCANNER] Skipping path ${sourceExchange}/${sourceCurrency} -> ${destExchange}/${destCurrency} - no price data`);
                            continue;
                        }

                        // Calculate path profit (ALWAYS - don't filter here)
                        const pathProfit = this._calculatePathProfit(
                            sourceExchange,
                            sourceCurrency,
                            destExchange,
                            destCurrency,
                            priceData,
                            defaultFees,
                            settings.max_trade_amount_usdt || 5000
                        );

                        calculatedCount++;

                        // Add ALL paths to array (including losses)
                        const path = {
                            id: `${sourceExchange}-${sourceCurrency}-${destExchange}-${destCurrency}`,
                            sourceExchange,
                            sourceCurrency,
                            destExchange,
                            destCurrency,
                            bridgeAsset: 'XRP',
                            ...pathProfit
                        };

                        allPaths.push(path);

                        // Log notable paths (profitable or significant losses)
                        if (pathProfit.profitPercent > 0) {
                            logger.info(`[SCANNER] 💰 PROFIT: ${path.id} = +${pathProfit.profitPercent.toFixed(4)}%`);
                        } else if (pathProfit.profitPercent < -1) {
                            logger.info(`[SCANNER] 📉 LOSS: ${path.id} = ${pathProfit.profitPercent.toFixed(4)}%`);
                        }
                    }
                }
            }
        }

        logger.info(`[SCANNER] Path calculation complete:`, {
            totalCalculated: calculatedCount,
            skippedNoPriceData,
            pathsReturned: allPaths.length
        });

        return allPaths;
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
