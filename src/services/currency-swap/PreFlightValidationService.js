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
                confirmationCheck: { passed: false, message: '' }
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
}

module.exports = PreFlightValidationService;
