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

        // Debug statistics
        const fetchStats = {
            totalAttempts: 0,
            successful: 0,
            failedNoData: 0,
            failedInvalidPrice: 0,
            failedError: 0,
            byExchange: {}
        };

        logger.info(`[PRICE FETCH] Starting price fetch for ${exchanges.length} exchanges × ${currencies.length} currencies = ${exchanges.length * currencies.length} pairs`);

        for (const exchange of exchanges) {
            priceData[exchange] = {};
            fetchStats.byExchange[exchange] = {
                successful: [],
                failed: []
            };

            for (const currency of currencies) {
                fetchStats.totalAttempts++;
                const pair = `XRP/${currency}`;

                try {
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
                        const bid = parseFloat(price.bid || price.bidPrice || price.buy || 0);
                        const ask = parseFloat(price.ask || price.askPrice || price.sell || 0);
                        const last = parseFloat(price.last || price.lastPrice || price.price || 0);

                        // Validate prices are non-zero
                        if (bid > 0 && ask > 0) {
                            priceData[exchange][currency] = { bid, ask, last };
                            fetchStats.successful++;
                            fetchStats.byExchange[exchange].successful.push(currency);
                            logger.info(`[PRICE FETCH] ✅ ${exchange} ${pair}: bid=${bid.toFixed(6)}, ask=${ask.toFixed(6)}`);
                        } else {
                            fetchStats.failedInvalidPrice++;
                            fetchStats.byExchange[exchange].failed.push(`${currency} (zero prices: bid=${bid}, ask=${ask})`);
                            logger.warn(`[PRICE FETCH] ⚠️ ${exchange} ${pair}: Invalid prices (bid=${bid}, ask=${ask})`);
                        }
                    } else {
                        fetchStats.failedNoData++;
                        fetchStats.byExchange[exchange].failed.push(`${currency} (no data: ${data.error || 'unknown'})`);
                        logger.warn(`[PRICE FETCH] ❌ ${exchange} ${pair}: No data returned (${data.error || 'no error message'})`);
                    }

                } catch (error) {
                    fetchStats.failedError++;
                    fetchStats.byExchange[exchange].failed.push(`${currency} (error: ${error.message})`);
                    logger.warn(`[PRICE FETCH] ❌ ${exchange} ${pair}: Error - ${error.message}`);
                }
            }
        }

        // Log detailed summary
        logger.info(`[PRICE FETCH] ═══════════════════════════════════════════════════════`);
        logger.info(`[PRICE FETCH] SUMMARY:`, {
            totalAttempts: fetchStats.totalAttempts,
            successful: fetchStats.successful,
            failedNoData: fetchStats.failedNoData,
            failedInvalidPrice: fetchStats.failedInvalidPrice,
            failedError: fetchStats.failedError,
            successRate: `${((fetchStats.successful / fetchStats.totalAttempts) * 100).toFixed(1)}%`
        });

        logger.info(`[PRICE FETCH] ═══════════════════════════════════════════════════════`);
        logger.info(`[PRICE FETCH] BY EXCHANGE:`);
        for (const exchange of exchanges) {
            const stats = fetchStats.byExchange[exchange];
            logger.info(`[PRICE FETCH] ${exchange}:`, {
                successful: stats.successful.length,
                failed: stats.failed.length,
                successfulPairs: stats.successful.join(', ') || 'none',
                failedPairs: stats.failed.length > 0 ? stats.failed : 'none'
            });
        }
        logger.info(`[PRICE FETCH] ═══════════════════════════════════════════════════════`);

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
                        // IMPORTANT: For Currency Swap, source and dest currencies must match
                        // We're arbitraging the XRP rate between exchanges, not converting currencies
                        // Example: Buy XRP with USDT on Binance, sell XRP for USDT on Kraken
                        if (sourceCurrency !== destCurrency) continue;

                        // Check if we have prices
                        if (!priceData[sourceExchange]?.[sourceCurrency] ||
                            !priceData[destExchange]?.[destCurrency]) {
                            skippedNoPriceData++;
                            logger.debug(`[SCANNER] Skipping path ${sourceExchange}/${sourceCurrency} -> ${destExchange}/${destCurrency} - no price data`);
                            continue;
                        }

                        // Validate prices are valid numbers > 0
                        const sourcePrice = priceData[sourceExchange][sourceCurrency];
                        const destPrice = priceData[destExchange][destCurrency];

                        if (!sourcePrice.ask || sourcePrice.ask <= 0 || !sourcePrice.bid || sourcePrice.bid <= 0) {
                            skippedNoPriceData++;
                            logger.debug(`[SCANNER] Skipping path ${sourceExchange}/${sourceCurrency} - invalid source price (ask: ${sourcePrice.ask}, bid: ${sourcePrice.bid})`);
                            continue;
                        }

                        if (!destPrice.ask || destPrice.ask <= 0 || !destPrice.bid || destPrice.bid <= 0) {
                            skippedNoPriceData++;
                            logger.debug(`[SCANNER] Skipping path ${destExchange}/${destCurrency} - invalid dest price (ask: ${destPrice.ask}, bid: ${destPrice.bid})`);
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
        try {
            // Input amount in source currency (e.g., 1000 USD)
            const inputAmount = tradeAmount;

            // Leg 1: Buy XRP with source currency on source exchange
            const sourcePrice = priceData[sourceExchange][sourceCurrency];

            // Safety check: ensure ask price is valid
            if (!sourcePrice || !sourcePrice.ask || sourcePrice.ask <= 0) {
                logger.warn(`[SCANNER] Invalid source ask price for ${sourceExchange}/${sourceCurrency}`);
                return {
                    profitPercent: -100,
                    profitAmount: -inputAmount,
                    inputAmount,
                    outputAmount: 0,
                    xrpBought: 0,
                    xrpAfterWithdrawal: 0,
                    fees: { leg1Fee: 0, withdrawalFee: fees.withdrawalFee, leg3Fee: 0 }
                };
            }

            const xrpBought = (inputAmount / sourcePrice.ask) * (1 - fees.takerFee);

            // Leg 2: Withdraw XRP (flat fee)
            const xrpAfterWithdrawal = xrpBought - fees.withdrawalFee;

            if (xrpAfterWithdrawal <= 0) {
                return {
                    profitPercent: -100,
                    profitAmount: -inputAmount,
                    inputAmount,
                    outputAmount: 0,
                    xrpBought,
                    xrpAfterWithdrawal: 0,
                    fees: {
                        leg1Fee: inputAmount * fees.takerFee,
                        withdrawalFee: fees.withdrawalFee,
                        leg3Fee: 0
                    }
                };
            }

            // Leg 3: Sell XRP for dest currency on dest exchange
            const destPrice = priceData[destExchange][destCurrency];

            // Safety check: ensure bid price is valid
            if (!destPrice || !destPrice.bid || destPrice.bid <= 0) {
                logger.warn(`[SCANNER] Invalid dest bid price for ${destExchange}/${destCurrency}`);
                return {
                    profitPercent: -100,
                    profitAmount: -inputAmount,
                    inputAmount,
                    outputAmount: 0,
                    xrpBought,
                    xrpAfterWithdrawal,
                    fees: {
                        leg1Fee: inputAmount * fees.takerFee,
                        withdrawalFee: fees.withdrawalFee,
                        leg3Fee: 0
                    }
                };
            }

            const outputAmount = (xrpAfterWithdrawal * destPrice.bid) * (1 - fees.takerFee);

            // Calculate profit
            const profitAmount = outputAmount - inputAmount;
            const profitPercent = (profitAmount / inputAmount) * 100;

            // Final safety check for NaN values
            if (isNaN(profitPercent) || isNaN(profitAmount) || !isFinite(profitPercent) || !isFinite(profitAmount)) {
                logger.error(`[SCANNER] Calculation resulted in invalid values for ${sourceExchange}->${destExchange}`, {
                    profitPercent,
                    profitAmount,
                    xrpBought,
                    outputAmount
                });
                return {
                    profitPercent: -100,
                    profitAmount: -inputAmount,
                    inputAmount,
                    outputAmount: 0,
                    xrpBought: 0,
                    xrpAfterWithdrawal: 0,
                    fees: { leg1Fee: 0, withdrawalFee: fees.withdrawalFee, leg3Fee: 0 }
                };
            }

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

        } catch (error) {
            logger.error(`[SCANNER] Error calculating path profit`, {
                sourceExchange,
                sourceCurrency,
                destExchange,
                destCurrency,
                error: error.message
            });

            // Return safe default values
            return {
                profitPercent: -100,
                profitAmount: -tradeAmount,
                inputAmount: tradeAmount,
                outputAmount: 0,
                xrpBought: 0,
                xrpAfterWithdrawal: 0,
                fees: { leg1Fee: 0, withdrawalFee: fees.withdrawalFee, leg3Fee: 0 }
            };
        }
    }
}

module.exports = CurrencySwapScannerService;
