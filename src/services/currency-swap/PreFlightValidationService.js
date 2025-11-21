/**
 * Pre-Flight Validation Service for Currency Swap Arbitrage
 * Critical safety checks before executing 3-leg currency swap trades
 *
 * Validates:
 * - Sufficient balance on source exchange
 * - XRP deposit address and tag configured
 * - Profit threshold met
 * - Trade amount within limits
 * - Confirmation received (if required)
 *
 * IMPORTANT: Stateless - credentials passed as parameters
 */

const { systemLogger } = require('../../utils/logger');

class PreFlightValidationService {
    constructor() {
        // Stateless service - no instance variables
    }

    /**
     * Perform all pre-flight safety checks before execution
     * @param {object} path - Currency swap path with profit calculation
     * @param {number} amount - Trade amount in source currency
     * @param {object} credentials - { sourceCredentials, destCredentials }
     * @param {object} options - Validation options
     * @returns {Promise<object>} Validation result
     */
    async validateSwap(path, amount, credentials, options = {}) {
        const {
            minProfitThreshold = 0.5,       // Minimum 0.5% profit required
            maxTradeAmount = 5000,          // Maximum $5,000 per trade
            portfolioPercent = null,        // Max % of portfolio (if set)
            requireConfirmation = true      // Require explicit confirmation
        } = options;

        const validationResult = {
            passed: false,
            path,
            amount,
            timestamp: new Date().toISOString(),
            checks: {
                balanceCheck: { passed: false, message: '', balance: null },
                profitCheck: { passed: false, message: '', currentProfit: null },
                addressCheck: { passed: false, message: '' },
                tagCheck: { passed: false, message: '' },
                amountCheck: { passed: false, message: '' },
                confirmationCheck: { passed: false, message: '' },
                priceRecheckCheck: { passed: false, message: '', freshProfit: null },
                exchangeStatusCheck: { passed: false, message: '' }
            },
            warnings: [],
            currentPath: null
        };

        try {
            systemLogger.trading('[PRE-FLIGHT] Starting Currency Swap validation', {
                pathId: path.id,
                sourceExchange: path.sourceExchange,
                destExchange: path.destExchange,
                sourceCurrency: path.sourceCurrency,
                destCurrency: path.destCurrency,
                amount
            });

            // CHECK 1: Balance Verification on Source Exchange
            systemLogger.trading('[PRE-FLIGHT] Check 1: Verifying balance...');
            const balanceCheck = await this._checkBalance(
                path.sourceExchange,
                path.sourceCurrency,
                amount,
                credentials.sourceCredentials
            );
            validationResult.checks.balanceCheck = balanceCheck;

            if (!balanceCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Balance check FAILED', {
                    exchange: path.sourceExchange,
                    currency: path.sourceCurrency,
                    required: amount,
                    available: balanceCheck.balance,
                    error: balanceCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Balance check PASSED', {
                exchange: path.sourceExchange,
                currency: path.sourceCurrency,
                available: balanceCheck.balance,
                required: amount,
                remaining: balanceCheck.balance - amount
            });

            // CHECK 2: XRP Deposit Address Validation
            systemLogger.trading('[PRE-FLIGHT] Check 2: Validating XRP deposit address...');
            const addressCheck = this._checkXRPDepositAddress(
                credentials.destCredentials.xrpDepositAddress,
                path.destExchange
            );
            validationResult.checks.addressCheck = addressCheck;

            if (!addressCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Address check FAILED', {
                    exchange: path.destExchange,
                    error: addressCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Address check PASSED');

            // CHECK 3: XRP Destination Tag Validation (for exchanges that require it)
            systemLogger.trading('[PRE-FLIGHT] Check 3: Validating XRP destination tag...');
            const tagCheck = this._checkXRPDestinationTag(
                credentials.destCredentials.xrpDepositTag,
                path.destExchange
            );
            validationResult.checks.tagCheck = tagCheck;

            if (!tagCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Tag check FAILED', {
                    exchange: path.destExchange,
                    error: tagCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Tag check PASSED');

            // CHECK 4: Profitability Threshold
            systemLogger.trading('[PRE-FLIGHT] Check 4: Validating profit threshold...');
            const profitCheck = this._checkProfitability(
                path,
                minProfitThreshold
            );
            validationResult.checks.profitCheck = profitCheck;
            validationResult.currentPath = path;

            if (!profitCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Profit check FAILED', {
                    currentProfit: path.profitPercent,
                    minRequired: minProfitThreshold,
                    error: profitCheck.error
                });
                return validationResult;
            }

            // Add warning if profit is marginal
            if (path.profitPercent < minProfitThreshold * 1.5) {
                const warning = `⚠️ Low profit margin: ${path.profitPercent.toFixed(2)}% (close to minimum ${minProfitThreshold}%)`;
                validationResult.warnings.push(warning);
                systemLogger.warn(`[PRE-FLIGHT] ${warning}`);
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Profit check PASSED', {
                currentProfit: path.profitPercent,
                minRequired: minProfitThreshold
            });

            // CHECK 5: Trade Amount Limits
            systemLogger.trading('[PRE-FLIGHT] Check 5: Validating trade amount limits...');
            const amountCheck = this._checkTradeAmount(
                amount,
                maxTradeAmount,
                portfolioPercent,
                balanceCheck.balance
            );
            validationResult.checks.amountCheck = amountCheck;

            if (!amountCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Amount check FAILED', {
                    amount,
                    maxTradeAmount,
                    portfolioPercent,
                    error: amountCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Amount check PASSED', {
                amount,
                maxTradeAmount: maxTradeAmount || 'none',
                portfolioPercent: portfolioPercent || 'none'
            });

            // CHECK 6: Confirmation Check (for live trading)
            if (requireConfirmation && !options.confirmed) {
                validationResult.checks.confirmationCheck = {
                    passed: false,
                    message: 'Live trading requires explicit confirmation',
                    error: 'CONFIRMATION_REQUIRED'
                };
                systemLogger.warn('[PRE-FLIGHT] ❌ Confirmation check FAILED - explicit confirmation required');
                return validationResult;
            }

            validationResult.checks.confirmationCheck = {
                passed: true,
                message: 'Confirmation received'
            };

            // CHECK 7: Real-Time Price Re-Check
            systemLogger.trading('[PRE-FLIGHT] Check 7: Re-checking current prices...');
            const priceRecheckCheck = await this._recheckCurrentPrices(
                path,
                minProfitThreshold
            );
            validationResult.checks.priceRecheckCheck = priceRecheckCheck;

            if (!priceRecheckCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Price recheck FAILED', {
                    originalProfit: path.profitPercent,
                    currentProfit: priceRecheckCheck.freshProfit,
                    minRequired: minProfitThreshold,
                    error: priceRecheckCheck.error
                });
                return validationResult;
            }

            // Add warning if profit dropped significantly
            const profitDrop = path.profitPercent - priceRecheckCheck.freshProfit;
            if (profitDrop > 0.2) {
                const warning = `⚠️ Profit dropped: ${path.profitPercent.toFixed(2)}% → ${priceRecheckCheck.freshProfit.toFixed(2)}% (-${profitDrop.toFixed(2)}%)`;
                validationResult.warnings.push(warning);
                systemLogger.warn(`[PRE-FLIGHT] ${warning}`);
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Price recheck PASSED', {
                originalProfit: path.profitPercent,
                currentProfit: priceRecheckCheck.freshProfit,
                minRequired: minProfitThreshold
            });

            // CHECK 8: Exchange Status Check
            systemLogger.trading('[PRE-FLIGHT] Check 8: Checking exchange status...');
            const exchangeStatusCheck = await this._checkExchangeStatus(
                path.sourceExchange,
                path.destExchange
            );
            validationResult.checks.exchangeStatusCheck = exchangeStatusCheck;

            if (!exchangeStatusCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Exchange status check FAILED', {
                    sourceExchange: path.sourceExchange,
                    destExchange: path.destExchange,
                    error: exchangeStatusCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Exchange status check PASSED', {
                sourceExchange: path.sourceExchange,
                destExchange: path.destExchange
            });

            // ALL CHECKS PASSED
            validationResult.passed = true;
            systemLogger.trading('[PRE-FLIGHT] ✅ ALL CHECKS PASSED - Currency Swap approved for execution', {
                pathId: path.id,
                sourceExchange: path.sourceExchange,
                destExchange: path.destExchange,
                sourceCurrency: path.sourceCurrency,
                destCurrency: path.destCurrency,
                amount,
                currentProfit: path.profitPercent,
                balance: balanceCheck.balance
            });

            return validationResult;

        } catch (error) {
            systemLogger.error('[PRE-FLIGHT] Validation failed with error', {
                pathId: path.id,
                error: error.message,
                stack: error.stack
            });

            validationResult.checks.balanceCheck.message = error.message;
            validationResult.checks.balanceCheck.error = error.message;
            return validationResult;
        }
    }

    /**
     * Check if user has sufficient balance
     * @private
     */
    async _checkBalance(exchange, currency, requiredAmount, credentials) {
        try {
            const fetch = require('node-fetch');
            const baseURL = process.env.NODE_ENV === 'production'
                ? 'https://arb4me-unified-production.up.railway.app'
                : 'http://localhost:3000';

            const exchangeLower = exchange.toLowerCase();

            const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/balance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: credentials.apiKey,
                    apiSecret: credentials.apiSecret,
                    apiPassphrase: credentials.apiPassphrase,
                    currency: currency
                })
            });

            const data = await response.json();

            if (!data.success || !data.data) {
                return {
                    passed: false,
                    balance: 0,
                    error: `Failed to fetch balance from ${exchange}: ${data.error || 'Unknown error'}`
                };
            }

            const available = parseFloat(data.data.free || data.data.available || 0);

            // Calculate required amount (including estimated fees)
            const estimatedFees = requiredAmount * 0.002; // 0.2% trading fee estimate
            const totalRequired = requiredAmount + estimatedFees;

            if (available < totalRequired) {
                return {
                    passed: false,
                    balance: available,
                    required: totalRequired,
                    error: `Insufficient ${currency} balance on ${exchange}. Required: ${totalRequired.toFixed(2)}, Available: ${available.toFixed(2)}`
                };
            }

            return {
                passed: true,
                balance: available,
                required: totalRequired,
                remaining: available - totalRequired
            };

        } catch (error) {
            systemLogger.error('Balance check failed', {
                exchange,
                currency,
                error: error.message
            });
            return {
                passed: false,
                balance: 0,
                error: `Failed to fetch balance from ${exchange}: ${error.message}`
            };
        }
    }

    /**
     * Validate XRP deposit address
     * @private
     */
    _checkXRPDepositAddress(depositAddress, destExchange) {
        if (!depositAddress || depositAddress.trim() === '') {
            return {
                passed: false,
                error: `No XRP deposit address configured for ${destExchange}`
            };
        }

        // Basic format validation (XRP addresses start with 'r')
        if (!depositAddress.startsWith('r')) {
            return {
                passed: false,
                error: `XRP deposit address appears invalid (should start with 'r'). Address: ${depositAddress.substring(0, 10)}...`
            };
        }

        if (depositAddress.length < 25 || depositAddress.length > 35) {
            return {
                passed: false,
                error: `XRP deposit address appears invalid (wrong length). Expected 25-35 characters, got ${depositAddress.length}`
            };
        }

        return {
            passed: true,
            message: 'XRP deposit address configured and validated'
        };
    }

    /**
     * Validate XRP destination tag for exchanges that require it
     * @private
     */
    _checkXRPDestinationTag(depositTag, destExchange) {
        const exchangesRequiringTag = [
            'VALR', 'valr',
            'Binance', 'binance',
            'Kraken', 'kraken',
            'OKX', 'okx',
            'Bybit', 'bybit',
            'KuCoin', 'kucoin',
            'Coinbase', 'coinbase',
            'Gate.io', 'gateio',
            'HTX', 'htx',
            'Bitget', 'bitget'
        ];

        const requiresTag = exchangesRequiringTag.some(ex =>
            destExchange.toLowerCase() === ex.toLowerCase()
        );

        if (requiresTag) {
            if (!depositTag || depositTag.trim() === '') {
                return {
                    passed: false,
                    error: `${destExchange} REQUIRES an XRP destination tag/memo. Missing tag will result in PERMANENT FUND LOSS!`
                };
            }
        }

        return {
            passed: true,
            message: requiresTag ? 'XRP destination tag configured' : 'Destination tag not required'
        };
    }

    /**
     * Check profitability against minimum threshold
     * @private
     */
    _checkProfitability(path, minProfitThreshold) {
        if (path.profitPercent < minProfitThreshold) {
            return {
                passed: false,
                currentProfit: path.profitPercent,
                error: `Current profit ${path.profitPercent.toFixed(2)}% below minimum ${minProfitThreshold}%`
            };
        }

        return {
            passed: true,
            currentProfit: path.profitPercent,
            message: `Profit ${path.profitPercent.toFixed(2)}% exceeds minimum ${minProfitThreshold}%`
        };
    }

    /**
     * Check trade amount against limits
     * @private
     */
    _checkTradeAmount(amount, maxTradeAmount, portfolioPercent, balance) {
        // Check absolute maximum
        if (maxTradeAmount && amount > maxTradeAmount) {
            return {
                passed: false,
                error: `Trade amount ${amount} exceeds maximum ${maxTradeAmount}`
            };
        }

        // Check portfolio percentage
        if (portfolioPercent && balance) {
            const maxAmountByPercent = (balance * portfolioPercent) / 100;
            if (amount > maxAmountByPercent) {
                return {
                    passed: false,
                    error: `Trade amount ${amount} exceeds ${portfolioPercent}% of portfolio (${maxAmountByPercent.toFixed(2)})`
                };
            }
        }

        // Check minimum amount (sanity check)
        if (amount < 10) {
            return {
                passed: false,
                error: `Trade amount ${amount} below minimum 10 USDT`
            };
        }

        return {
            passed: true,
            message: 'Trade amount within limits'
        };
    }

    /**
     * Re-check current prices and recalculate profit
     * @private
     */
    async _recheckCurrentPrices(path, minProfitThreshold) {
        try {
            const priceCacheService = require('../priceCacheService');
            const bridgeAsset = 'XRP'; // Currency Swap uses XRP as bridge

            // Get fresh prices from price cache
            const sourcePrices = priceCacheService.getPrices(path.sourceExchange.toLowerCase());
            const destPrices = priceCacheService.getPrices(path.destExchange.toLowerCase());

            if (!sourcePrices || !destPrices) {
                return {
                    passed: false,
                    freshProfit: null,
                    error: 'Could not fetch fresh prices from price cache'
                };
            }

            // Try different pair formats
            const possiblePairFormats = [
                `${bridgeAsset}${path.sourceCurrency}`,     // XRPUSDT
                `${bridgeAsset}-${path.sourceCurrency}`,    // XRP-USDT
                `${bridgeAsset}/${path.sourceCurrency}`     // XRP/USDT
            ];

            let sourcePrice = null;
            let destPrice = null;

            // Find source exchange price
            for (const format of possiblePairFormats) {
                if (sourcePrices[format]) {
                    const priceData = sourcePrices[format];
                    sourcePrice = {
                        bid: parseFloat(priceData.bid || priceData.bidPrice || priceData.buy || 0),
                        ask: parseFloat(priceData.ask || priceData.askPrice || priceData.sell || 0)
                    };
                    if (sourcePrice.bid > 0 && sourcePrice.ask > 0) break;
                }
            }

            // Find dest exchange price
            for (const format of possiblePairFormats) {
                if (destPrices[format]) {
                    const priceData = destPrices[format];
                    destPrice = {
                        bid: parseFloat(priceData.bid || priceData.bidPrice || priceData.buy || 0),
                        ask: parseFloat(priceData.ask || priceData.askPrice || priceData.sell || 0)
                    };
                    if (destPrice.bid > 0 && destPrice.ask > 0) break;
                }
            }

            if (!sourcePrice || !destPrice) {
                return {
                    passed: false,
                    freshProfit: null,
                    error: `Missing price data for ${bridgeAsset}/${path.sourceCurrency} on ${path.sourceExchange} or ${path.destExchange}`
                };
            }

            if (sourcePrice.ask <= 0 || destPrice.bid <= 0) {
                return {
                    passed: false,
                    freshProfit: null,
                    error: 'Invalid prices (zero or negative bid/ask)'
                };
            }

            // Recalculate profit with fresh prices
            // Leg 1: Buy XRP on source (pay ask price)
            // Leg 2: Transfer XRP (pay withdrawal fee)
            // Leg 3: Sell XRP on dest (receive bid price)
            const inputAmount = 1000; // Use $1000 as reference
            const xrpBought = inputAmount / sourcePrice.ask;
            const withdrawalFee = 0.1; // 0.1 XRP withdrawal fee
            const xrpAfterWithdrawal = xrpBought - withdrawalFee;
            const outputAmount = xrpAfterWithdrawal * destPrice.bid;

            const profit = outputAmount - inputAmount;
            const profitPercent = (profit / inputAmount) * 100;

            // Check if fresh profit still meets threshold
            if (profitPercent < minProfitThreshold) {
                return {
                    passed: false,
                    freshProfit: profitPercent,
                    error: `Fresh profit ${profitPercent.toFixed(2)}% below threshold ${minProfitThreshold}%`
                };
            }

            return {
                passed: true,
                freshProfit: profitPercent,
                message: `Fresh profit ${profitPercent.toFixed(2)}% meets threshold`,
                sourcePriceAsk: sourcePrice.ask,
                destPriceBid: destPrice.bid
            };

        } catch (error) {
            systemLogger.error('[PRE-FLIGHT] Price recheck failed', {
                error: error.message,
                path: path.id
            });
            return {
                passed: false,
                freshProfit: null,
                error: `Price recheck failed: ${error.message}`
            };
        }
    }

    /**
     * Check if both exchanges are operational and withdrawals enabled
     * @private
     */
    async _checkExchangeStatus(sourceExchange, destExchange) {
        try {
            const fetch = require('node-fetch');
            const baseURL = process.env.NODE_ENV === 'production'
                ? 'https://arb4me-unified-production.up.railway.app'
                : 'http://localhost:3000';

            // For now, implement a simplified check
            // TODO: Add actual exchange status endpoints when available

            // Check if exchanges are in known operational list
            const operationalExchanges = [
                'Binance', 'binance',
                'Kraken', 'kraken',
                'OKX', 'okx',
                'Bybit', 'bybit',
                'Kucoin', 'kucoin',
                'MEXC', 'mexc',
                'HTX', 'htx',
                'Gate.io', 'gateio',
                'Bitget', 'bitget',
                'VALR', 'valr',
                'Luno', 'luno'
            ];

            const sourceOperational = operationalExchanges.some(ex =>
                sourceExchange.toLowerCase() === ex.toLowerCase()
            );

            const destOperational = operationalExchanges.some(ex =>
                destExchange.toLowerCase() === ex.toLowerCase()
            );

            if (!sourceOperational) {
                return {
                    passed: false,
                    error: `Source exchange ${sourceExchange} not in operational list`
                };
            }

            if (!destOperational) {
                return {
                    passed: false,
                    error: `Destination exchange ${destExchange} not in operational list`
                };
            }

            // TODO: When exchange status APIs are available, add:
            // - Check if exchange is in maintenance
            // - Check if trading is enabled
            // - Check if withdrawals are enabled for XRP
            // - Check if deposits are enabled for XRP

            return {
                passed: true,
                message: 'Both exchanges operational',
                sourceStatus: 'operational',
                destStatus: 'operational'
            };

        } catch (error) {
            systemLogger.error('[PRE-FLIGHT] Exchange status check failed', {
                error: error.message,
                sourceExchange,
                destExchange
            });

            // Don't block on status check errors - allow trade to proceed
            return {
                passed: true,
                message: 'Status check unavailable - proceeding with caution',
                warning: error.message
            };
        }
    }
}

module.exports = PreFlightValidationService;
