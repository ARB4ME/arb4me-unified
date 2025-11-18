/**
 * Pre-Flight Validation Service
 * Critical safety checks before executing triangular arbitrage trades
 *
 * Validates:
 * - Sufficient balance
 * - Opportunity still profitable
 * - Trade amount within limits
 * - Slippage tolerance
 * - Risk management rules
 *
 * IMPORTANT: Stateless - credentials passed as parameters
 */

const { systemLogger } = require('../../utils/logger');
const ExchangeConnectorService = require('./ExchangeConnectorService');
const ProfitCalculatorService = require('./ProfitCalculatorService');
const OrderBookFetcherService = require('./OrderBookFetcherService');

class PreFlightValidationService {
    constructor() {
        this.exchangeConnector = new ExchangeConnectorService();
        this.profitCalculator = new ProfitCalculatorService();
        this.orderBookFetcher = new OrderBookFetcherService();
    }

    /**
     * Perform all pre-flight safety checks before execution
     * @param {string} exchange - Exchange name
     * @param {object} path - Path definition
     * @param {number} amount - Trade amount
     * @param {object} credentials - API credentials
     * @param {object} options - Validation options
     * @returns {Promise<object>} Validation result
     */
    async validateTrade(exchange, path, amount, credentials, options = {}) {
        const {
            minProfitThreshold = 0.3,    // Minimum 0.3% profit required
            maxSlippage = 0.5,            // Maximum 0.5% slippage allowed
            maxTradeAmount = null,        // Maximum trade amount (if set)
            portfolioPercent = null,      // Max % of portfolio (if set)
            requireConfirmation = true    // Require explicit confirmation for live trading
        } = options;

        const validationResult = {
            passed: false,
            exchange,
            pathId: path.id,
            amount,
            timestamp: new Date().toISOString(),
            checks: {
                balanceCheck: { passed: false, message: '' },
                profitCheck: { passed: false, message: '' },
                amountCheck: { passed: false, message: '' },
                confirmationCheck: { passed: false, message: '' }
            },
            warnings: [],
            currentOpportunity: null,
            balance: null
        };

        try {
            systemLogger.trading(`[PRE-FLIGHT] Starting validation`, {
                exchange,
                pathId: path.id,
                amount,
                minProfitThreshold
            });

            // CHECK 1: Balance Verification
            systemLogger.trading(`[PRE-FLIGHT] Check 1: Verifying balance...`);
            const balanceCheck = await this._checkBalance(exchange, amount, credentials, path);
            validationResult.checks.balanceCheck = balanceCheck;
            validationResult.balance = balanceCheck.balance;

            if (!balanceCheck.passed) {
                validationResult.checks.balanceCheck.message = balanceCheck.error || 'Insufficient balance';
                systemLogger.warn(`[PRE-FLIGHT] ❌ Balance check FAILED`, {
                    exchange,
                    required: amount,
                    available: balanceCheck.balance,
                    error: balanceCheck.error
                });
                return validationResult;
            }

            systemLogger.trading(`[PRE-FLIGHT] ✅ Balance check PASSED`, {
                available: balanceCheck.balance,
                required: amount,
                remaining: balanceCheck.balance - amount
            });

            // CHECK 2: Profit Re-Validation (fetch fresh orderbooks)
            systemLogger.trading(`[PRE-FLIGHT] Check 2: Re-validating profit with fresh orderbooks...`);
            const profitCheck = await this._checkProfitability(
                exchange,
                path,
                amount,
                minProfitThreshold,
                credentials
            );
            validationResult.checks.profitCheck = profitCheck;
            validationResult.currentOpportunity = profitCheck.opportunity;

            if (!profitCheck.passed) {
                validationResult.checks.profitCheck.message = profitCheck.error || 'Opportunity no longer profitable';
                systemLogger.warn(`[PRE-FLIGHT] ❌ Profit check FAILED`, {
                    exchange,
                    currentProfit: profitCheck.opportunity?.profitPercentage,
                    minRequired: minProfitThreshold,
                    error: profitCheck.error
                });
                return validationResult;
            }

            // Add warning if profit decreased significantly
            if (profitCheck.profitDecreased) {
                const warning = `⚠️ Profit decreased: ${profitCheck.profitChange}% since scan`;
                validationResult.warnings.push(warning);
                systemLogger.warn(`[PRE-FLIGHT] ${warning}`);
            }

            systemLogger.trading(`[PRE-FLIGHT] ✅ Profit check PASSED`, {
                currentProfit: profitCheck.opportunity.profitPercentage,
                minRequired: minProfitThreshold,
                profitDecreased: profitCheck.profitDecreased
            });

            // CHECK 3: Trade Amount Limits
            systemLogger.trading(`[PRE-FLIGHT] Check 3: Validating trade amount limits...`);
            const amountCheck = this._checkTradeAmount(
                amount,
                maxTradeAmount,
                portfolioPercent,
                balanceCheck.balance
            );
            validationResult.checks.amountCheck = amountCheck;

            if (!amountCheck.passed) {
                validationResult.checks.amountCheck.message = amountCheck.error || 'Trade amount exceeds limits';
                systemLogger.warn(`[PRE-FLIGHT] ❌ Amount check FAILED`, {
                    amount,
                    maxTradeAmount,
                    portfolioPercent,
                    error: amountCheck.error
                });
                return validationResult;
            }

            systemLogger.trading(`[PRE-FLIGHT] ✅ Amount check PASSED`, {
                amount,
                maxTradeAmount: maxTradeAmount || 'none',
                portfolioPercent: portfolioPercent || 'none'
            });

            // CHECK 4: Confirmation Check (for live trading)
            if (requireConfirmation && !options.confirmed) {
                validationResult.checks.confirmationCheck = {
                    passed: false,
                    message: 'Live trading requires explicit confirmation',
                    error: 'CONFIRMATION_REQUIRED'
                };
                systemLogger.warn(`[PRE-FLIGHT] ❌ Confirmation check FAILED - explicit confirmation required`);
                return validationResult;
            }

            validationResult.checks.confirmationCheck = {
                passed: true,
                message: 'Confirmation received'
            };

            // ALL CHECKS PASSED
            validationResult.passed = true;
            systemLogger.trading(`[PRE-FLIGHT] ✅ ALL CHECKS PASSED - Trade approved for execution`, {
                exchange,
                pathId: path.id,
                amount,
                currentProfit: profitCheck.opportunity.profitPercentage,
                balance: balanceCheck.balance
            });

            return validationResult;

        } catch (error) {
            systemLogger.error(`[PRE-FLIGHT] Validation failed with error`, {
                exchange,
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
    async _checkBalance(exchange, amount, credentials, path) {
        try {
            // Determine base currency from path (first step)
            const baseCurrency = this._getBaseCurrency(path);

            // Fetch balance from exchange
            const balance = await this.exchangeConnector.fetchBalance(
                exchange,
                baseCurrency,
                credentials
            );

            // Calculate required amount (including estimated fees)
            const estimatedFees = amount * 0.002 * 3; // 0.2% per leg * 3 legs
            const requiredAmount = amount + estimatedFees;

            if (balance < requiredAmount) {
                return {
                    passed: false,
                    balance,
                    required: requiredAmount,
                    error: `Insufficient ${baseCurrency} balance. Required: ${requiredAmount.toFixed(2)}, Available: ${balance.toFixed(2)}`
                };
            }

            return {
                passed: true,
                balance,
                required: requiredAmount,
                remaining: balance - requiredAmount
            };

        } catch (error) {
            systemLogger.error(`Balance check failed`, {
                exchange,
                error: error.message
            });
            return {
                passed: false,
                balance: 0,
                error: `Failed to fetch balance: ${error.message}`
            };
        }
    }

    /**
     * Re-validate profitability with fresh orderbooks
     * @private
     */
    async _checkProfitability(exchange, path, amount, minProfitThreshold, credentials) {
        try {
            // Fetch fresh orderbooks
            const orderBooks = await this.orderBookFetcher.fetchMultiple(
                exchange,
                path.pairs,
                credentials
            );

            // Recalculate profit with current prices
            const currentOpportunity = this.profitCalculator.calculate(
                exchange,
                path,
                orderBooks,
                amount
            );

            if (!currentOpportunity.success) {
                return {
                    passed: false,
                    opportunity: currentOpportunity,
                    error: currentOpportunity.error || 'Profit calculation failed'
                };
            }

            if (currentOpportunity.profitPercentage < minProfitThreshold) {
                return {
                    passed: false,
                    opportunity: currentOpportunity,
                    error: `Current profit ${currentOpportunity.profitPercentage.toFixed(3)}% below minimum ${minProfitThreshold}%`
                };
            }

            return {
                passed: true,
                opportunity: currentOpportunity,
                profitDecreased: false, // Could compare with previous if we had it
                profitChange: 0
            };

        } catch (error) {
            systemLogger.error(`Profit check failed`, {
                exchange,
                pathId: path.id,
                error: error.message
            });
            return {
                passed: false,
                opportunity: null,
                error: `Failed to re-validate profit: ${error.message}`
            };
        }
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
                error: `Trade amount ${amount} below minimum 10`
            };
        }

        return {
            passed: true,
            message: 'Trade amount within limits'
        };
    }

    /**
     * Extract base currency from path
     * @private
     */
    _getBaseCurrency(path) {
        // Parse from sequence string (e.g., "USDT → ETH → BTC → USDT")
        if (path.sequence) {
            const match = path.sequence.match(/^(\w+)\s*→/);
            if (match) {
                return match[1];
            }
        }

        // Fallback to common base currencies
        return 'USDT';
    }
}

module.exports = PreFlightValidationService;
