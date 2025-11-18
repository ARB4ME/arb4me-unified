/**
 * Pre-Flight Validation Service for Transfer Arbitrage
 * Critical safety checks before executing transfer arbitrage trades
 *
 * Validates:
 * - Sufficient balance on source exchange
 * - Opportunity still profitable (fresh prices)
 * - Trade amount within limits
 * - Network match validation
 * - Deposit address configured
 * - Minimum profit threshold
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
     * @param {object} opportunity - Transfer opportunity with prices and amounts
     * @param {object} credentials - API credentials and configuration
     * @param {object} options - Validation options
     * @returns {Promise<object>} Validation result
     */
    async validateTransfer(opportunity, credentials, options = {}) {
        const {
            minProfitThreshold = 1.0,      // Minimum 1% profit required (transfer arb has higher costs)
            maxTradeAmount = 10000,         // Maximum $10,000 per trade
            portfolioPercent = null,        // Max % of portfolio (if set)
            requireConfirmation = true      // Require explicit confirmation for live trading
        } = options;

        const validationResult = {
            passed: false,
            opportunity,
            timestamp: new Date().toISOString(),
            checks: {
                balanceCheck: { passed: false, message: '', balance: null },
                profitCheck: { passed: false, message: '', currentProfit: null },
                networkCheck: { passed: false, message: '' },
                addressCheck: { passed: false, message: '' },
                amountCheck: { passed: false, message: '' },
                confirmationCheck: { passed: false, message: '' }
            },
            warnings: [],
            currentOpportunity: null
        };

        try {
            systemLogger.trading('[PRE-FLIGHT] Starting validation', {
                fromExchange: opportunity.fromExchange,
                toExchange: opportunity.toExchange,
                crypto: opportunity.crypto,
                expectedProfit: opportunity.netProfitPercent,
                amount: opportunity.usdtToSpend
            });

            // CHECK 1: Balance Verification on Source Exchange
            systemLogger.trading('[PRE-FLIGHT] Check 1: Verifying balance...');
            const balanceCheck = await this._checkBalance(
                opportunity.fromExchange,
                opportunity.usdtToSpend,
                credentials.fromExchange
            );
            validationResult.checks.balanceCheck = balanceCheck;

            if (!balanceCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Balance check FAILED', {
                    exchange: opportunity.fromExchange,
                    required: opportunity.usdtToSpend,
                    available: balanceCheck.balance,
                    error: balanceCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Balance check PASSED', {
                exchange: opportunity.fromExchange,
                available: balanceCheck.balance,
                required: opportunity.usdtToSpend,
                remaining: balanceCheck.balance - opportunity.usdtToSpend
            });

            // CHECK 2: Network Validation
            systemLogger.trading('[PRE-FLIGHT] Check 2: Validating network configuration...');
            const networkCheck = this._checkNetworkConfiguration(credentials);
            validationResult.checks.networkCheck = networkCheck;

            if (!networkCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Network check FAILED', {
                    fromNetwork: credentials.fromNetwork,
                    toNetwork: credentials.toNetwork,
                    error: networkCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Network check PASSED', {
                network: credentials.fromNetwork
            });

            // CHECK 3: Deposit Address Validation
            systemLogger.trading('[PRE-FLIGHT] Check 3: Validating deposit address...');
            const addressCheck = this._checkDepositAddress(
                credentials.depositAddress,
                credentials.depositTag,
                opportunity.crypto
            );
            validationResult.checks.addressCheck = addressCheck;

            if (!addressCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Address check FAILED', {
                    error: addressCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Address check PASSED');

            // CHECK 4: Profit Re-Validation (with fresh prices)
            // NOTE: For MVP, we trust the scan prices. In production, we should re-fetch prices here.
            systemLogger.trading('[PRE-FLIGHT] Check 4: Validating profit threshold...');
            const profitCheck = this._checkProfitability(
                opportunity,
                minProfitThreshold
            );
            validationResult.checks.profitCheck = profitCheck;
            validationResult.currentOpportunity = opportunity; // Use existing opportunity

            if (!profitCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Profit check FAILED', {
                    currentProfit: opportunity.netProfitPercent,
                    minRequired: minProfitThreshold,
                    error: profitCheck.error
                });
                return validationResult;
            }

            // Add warning if profit is marginal
            if (opportunity.netProfitPercent < minProfitThreshold * 1.5) {
                const warning = `⚠️ Low profit margin: ${opportunity.netProfitPercent.toFixed(2)}% (close to minimum ${minProfitThreshold}%)`;
                validationResult.warnings.push(warning);
                systemLogger.warn(`[PRE-FLIGHT] ${warning}`);
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Profit check PASSED', {
                currentProfit: opportunity.netProfitPercent,
                minRequired: minProfitThreshold
            });

            // CHECK 5: Trade Amount Limits
            systemLogger.trading('[PRE-FLIGHT] Check 5: Validating trade amount limits...');
            const amountCheck = this._checkTradeAmount(
                opportunity.usdtToSpend,
                maxTradeAmount,
                portfolioPercent,
                balanceCheck.balance
            );
            validationResult.checks.amountCheck = amountCheck;

            if (!amountCheck.passed) {
                systemLogger.warn('[PRE-FLIGHT] ❌ Amount check FAILED', {
                    amount: opportunity.usdtToSpend,
                    maxTradeAmount,
                    portfolioPercent,
                    error: amountCheck.error
                });
                return validationResult;
            }

            systemLogger.trading('[PRE-FLIGHT] ✅ Amount check PASSED', {
                amount: opportunity.usdtToSpend,
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
            systemLogger.trading('[PRE-FLIGHT] ✅ ALL CHECKS PASSED - Transfer approved for execution', {
                fromExchange: opportunity.fromExchange,
                toExchange: opportunity.toExchange,
                crypto: opportunity.crypto,
                amount: opportunity.usdtToSpend,
                currentProfit: opportunity.netProfitPercent,
                network: credentials.fromNetwork,
                balance: balanceCheck.balance
            });

            return validationResult;

        } catch (error) {
            systemLogger.error('[PRE-FLIGHT] Validation failed with error', {
                fromExchange: opportunity.fromExchange,
                toExchange: opportunity.toExchange,
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
    async _checkBalance(exchange, requiredAmount, credentials) {
        try {
            // Use CCXT to fetch balance
            const ccxt = require('ccxt');
            const exchangeId = exchange.toLowerCase();

            // Map exchange names to CCXT IDs
            const exchangeMap = {
                'valr': 'valr',
                'luno': 'luno',
                'binance': 'binance',
                'okx': 'okx',
                'bybit': 'bybit',
                'kraken': 'kraken',
                'mexc': 'mexc',
                'kucoin': 'kucoin',
                'htx': 'htx',
                'gateio': 'gateio'
            };

            const ccxtExchangeId = exchangeMap[exchangeId] || exchangeId;

            if (!ccxt[ccxtExchangeId]) {
                throw new Error(`Exchange ${exchange} not supported by CCXT`);
            }

            const exchangeInstance = new ccxt[ccxtExchangeId]({
                apiKey: credentials.apiKey,
                secret: credentials.apiSecret,
                enableRateLimit: true
            });

            // Fetch balance
            const balance = await exchangeInstance.fetchBalance();
            const usdtBalance = balance.free?.USDT || balance.USDT?.free || 0;

            // Calculate required amount (including estimated fees)
            const estimatedFees = requiredAmount * 0.002; // 0.2% trading fee estimate
            const totalRequired = requiredAmount + estimatedFees;

            if (usdtBalance < totalRequired) {
                return {
                    passed: false,
                    balance: usdtBalance,
                    required: totalRequired,
                    error: `Insufficient USDT balance on ${exchange}. Required: ${totalRequired.toFixed(2)}, Available: ${usdtBalance.toFixed(2)}`
                };
            }

            return {
                passed: true,
                balance: usdtBalance,
                required: totalRequired,
                remaining: usdtBalance - totalRequired
            };

        } catch (error) {
            systemLogger.error('Balance check failed', {
                exchange,
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
     * Validate network configuration
     * @private
     */
    _checkNetworkConfiguration(credentials) {
        // Check if networks are configured
        if (!credentials.fromNetwork) {
            return {
                passed: false,
                error: 'Withdrawal network not configured'
            };
        }

        if (!credentials.toNetwork) {
            return {
                passed: false,
                error: 'Deposit network not configured'
            };
        }

        // Check if networks match
        if (credentials.fromNetwork !== credentials.toNetwork) {
            return {
                passed: false,
                error: `Network mismatch: Withdrawal (${credentials.fromNetwork}) ≠ Deposit (${credentials.toNetwork})`
            };
        }

        return {
            passed: true,
            network: credentials.fromNetwork,
            message: `Networks match: ${credentials.fromNetwork}`
        };
    }

    /**
     * Validate deposit address configuration
     * @private
     */
    _checkDepositAddress(depositAddress, depositTag, crypto) {
        if (!depositAddress || depositAddress.trim() === '') {
            return {
                passed: false,
                error: 'Deposit address not configured'
            };
        }

        // Basic format validation (can be enhanced)
        if (depositAddress.length < 20) {
            return {
                passed: false,
                error: 'Deposit address appears to be invalid (too short)'
            };
        }

        // Check destination tag for XRP and XLM
        if (['XRP', 'XLM'].includes(crypto)) {
            if (!depositTag || depositTag.trim() === '') {
                return {
                    passed: false,
                    error: `${crypto} requires a destination tag/memo. Missing tag will result in PERMANENT FUND LOSS!`
                };
            }
        }

        return {
            passed: true,
            message: 'Deposit address configured and validated'
        };
    }

    /**
     * Check profitability against minimum threshold
     * @private
     */
    _checkProfitability(opportunity, minProfitThreshold) {
        // NOTE: In production, we should re-fetch fresh prices here and recalculate
        // For MVP, we trust the opportunity prices from the scan

        if (opportunity.netProfitPercent < minProfitThreshold) {
            return {
                passed: false,
                currentProfit: opportunity.netProfitPercent,
                error: `Current profit ${opportunity.netProfitPercent.toFixed(2)}% below minimum ${minProfitThreshold}%`
            };
        }

        return {
            passed: true,
            currentProfit: opportunity.netProfitPercent,
            message: `Profit ${opportunity.netProfitPercent.toFixed(2)}% exceeds minimum ${minProfitThreshold}%`
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
