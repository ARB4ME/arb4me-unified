// Risk Calculator Service
// Calculates safe trade amounts based on user's risk settings and current balances
// Prevents over-trading and ensures capital preservation

const Balance = require('../../models/Balance');
const CurrencySwapSettings = require('../../models/CurrencySwapSettings');
const { logger } = require('../../utils/logger');

class RiskCalculatorService {
    /**
     * Calculate safe trade amount for a swap path
     * @param {number} userId - User ID
     * @param {string} sourceExchange - Source exchange
     * @param {string} sourceAsset - Source asset (ZAR, USD, etc.)
     * @param {object} prices - Current prices (optional, for USDT conversion)
     * @returns {object} Trade sizing recommendation
     */
    static async calculateTradeAmount(userId, sourceExchange, sourceAsset, prices = {}) {
        try {
            logger.info(`Calculating trade amount for ${sourceAsset} on ${sourceExchange}`, {
                userId
            });

            // Get user's risk settings
            const settings = await CurrencySwapSettings.getOrCreate(userId);

            // Get current balance
            const balance = await Balance.getBalance(userId, sourceExchange, sourceAsset);

            if (!balance) {
                return {
                    canTrade: false,
                    reason: 'No balance record found',
                    recommendedAmount: 0
                };
            }

            if (balance.availableBalance <= 0) {
                return {
                    canTrade: false,
                    reason: 'Insufficient available balance',
                    recommendedAmount: 0,
                    currentBalance: balance.availableBalance
                };
            }

            // Calculate maximum trade amount using multiple constraints
            const calculations = this._applyRiskConstraints(
                balance.availableBalance,
                sourceAsset,
                settings,
                prices
            );

            logger.info(`Trade amount calculated`, {
                userId,
                sourceExchange,
                sourceAsset,
                ...calculations
            });

            return {
                canTrade: calculations.recommendedAmount > 0,
                recommendedAmount: calculations.recommendedAmount,
                maxByBalance: calculations.maxByBalance,
                maxByPercentage: calculations.maxByPercentage,
                maxByUSDTLimit: calculations.maxByUSDTLimit,
                reserveAmount: calculations.reserveAmount,
                availableBalance: balance.availableBalance,
                constraint: calculations.constraint,
                settings: {
                    maxBalancePercentage: settings.max_balance_percentage,
                    maxTradeAmountUSDT: settings.max_trade_amount_usdt,
                    minReservePercent: settings.min_balance_reserve_percent
                }
            };

        } catch (error) {
            logger.error('Failed to calculate trade amount', {
                userId,
                sourceExchange,
                sourceAsset,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Apply risk constraints to determine safe trade amount
     * @private
     */
    static _applyRiskConstraints(availableBalance, sourceAsset, settings, prices = {}) {
        // Constraint 1: Reserve percentage (keep some balance in reserve)
        const reservePercent = settings.min_balance_reserve_percent || 5.0;
        const reserveAmount = availableBalance * (reservePercent / 100);
        const balanceAfterReserve = availableBalance - reserveAmount;

        // Constraint 2: Max percentage of balance
        const maxBalancePercent = settings.max_balance_percentage || 10.0;
        const maxByPercentage = availableBalance * (maxBalancePercent / 100);

        // Constraint 3: Max trade amount in USDT
        const maxTradeUSDT = settings.max_trade_amount_usdt || 5000;
        const maxByUSDTLimit = this._convertUSDTToAsset(
            maxTradeUSDT,
            sourceAsset,
            prices
        );

        // Take the minimum of all constraints
        let recommendedAmount = Math.min(
            balanceAfterReserve,
            maxByPercentage,
            maxByUSDTLimit
        );

        // Ensure positive amount
        recommendedAmount = Math.max(0, recommendedAmount);

        // Determine which constraint was the limiting factor
        let constraint = 'none';
        if (recommendedAmount === balanceAfterReserve) {
            constraint = 'reserve';
        } else if (recommendedAmount === maxByPercentage) {
            constraint = 'percentage';
        } else if (recommendedAmount === maxByUSDTLimit) {
            constraint = 'usdt_limit';
        }

        return {
            recommendedAmount,
            maxByBalance: balanceAfterReserve,
            maxByPercentage,
            maxByUSDTLimit,
            reserveAmount,
            constraint
        };
    }

    /**
     * Convert USDT amount to target asset
     * Uses provided prices or estimated rates
     * @private
     */
    static _convertUSDTToAsset(usdtAmount, asset, prices = {}) {
        // If price provided, use it
        if (prices[`${asset}/USDT`]) {
            return usdtAmount / prices[`${asset}/USDT`];
        }

        // Use estimated rates (fallback)
        const estimatedRates = {
            'USDT': 1.0,
            'USDC': 1.0,
            'USD': 1.0,
            'ZAR': 19.0,  // ~19 ZAR per USDT
            'EUR': 0.92,  // ~0.92 EUR per USDT
            'GBP': 0.79   // ~0.79 GBP per USDT
        };

        const rate = estimatedRates[asset] || 1.0;
        return usdtAmount * rate;
    }

    /**
     * Check if user can execute a swap based on daily limits
     * @param {number} userId - User ID
     */
    static async canExecuteSwap(userId) {
        try {
            const result = await CurrencySwapSettings.canExecuteSwap(userId);

            logger.info(`Daily swap limit check for user ${userId}`, result);

            return result;

        } catch (error) {
            logger.error('Failed to check swap execution limit', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Check if user can execute concurrent swaps
     * @param {number} userId - User ID
     */
    static async canExecuteConcurrentSwap(userId) {
        try {
            const settings = await CurrencySwapSettings.getOrCreate(userId);

            // Count currently executing swaps
            // Note: This will be implemented when we build the ExecutionQueueService
            // For now, return true (no concurrent swaps yet)
            const currentlyExecuting = 0; // TODO: Get from execution queue

            const canExecute = currentlyExecuting < settings.max_concurrent_trades;

            logger.info(`Concurrent swap check for user ${userId}`, {
                currentlyExecuting,
                maxConcurrent: settings.max_concurrent_trades,
                canExecute
            });

            return {
                canExecute,
                currentlyExecuting,
                maxConcurrent: settings.max_concurrent_trades,
                remaining: settings.max_concurrent_trades - currentlyExecuting
            };

        } catch (error) {
            logger.error('Failed to check concurrent swap limit', {
                userId,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Validate trade amount against balance
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {string} asset - Asset code
     * @param {number} amount - Requested trade amount
     */
    static async validateTradeAmount(userId, exchange, asset, amount) {
        try {
            const balance = await Balance.getBalance(userId, exchange, asset);

            if (!balance) {
                return {
                    valid: false,
                    reason: 'No balance record found'
                };
            }

            const hasSufficient = await Balance.hasSufficientBalance(
                userId,
                exchange,
                asset,
                amount
            );

            if (!hasSufficient) {
                return {
                    valid: false,
                    reason: 'Insufficient available balance',
                    requested: amount,
                    available: balance.availableBalance
                };
            }

            return {
                valid: true,
                requested: amount,
                available: balance.availableBalance,
                remaining: balance.availableBalance - amount
            };

        } catch (error) {
            logger.error('Failed to validate trade amount', {
                userId,
                exchange,
                asset,
                amount,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Calculate profit percentage from swap execution
     * @param {number} inputAmount - Amount in source asset
     * @param {number} outputAmount - Amount in destination asset
     * @param {object} prices - Current prices for conversion
     */
    static calculateProfitPercentage(inputAmount, outputAmount, prices = {}) {
        try {
            // Convert both to USDT equivalent for comparison
            // This is a simplified calculation - real implementation would use actual prices

            // For now, assume 1:1 if both are stablecoins
            const profitPercent = ((outputAmount - inputAmount) / inputAmount) * 100;

            return {
                profitPercent,
                profitAmount: outputAmount - inputAmount,
                inputAmount,
                outputAmount
            };

        } catch (error) {
            logger.error('Failed to calculate profit percentage', {
                inputAmount,
                outputAmount,
                error: error.message
            });

            return {
                profitPercent: 0,
                profitAmount: 0,
                inputAmount,
                outputAmount
            };
        }
    }

    /**
     * Get comprehensive risk assessment for a swap
     * @param {number} userId - User ID
     * @param {object} path - Swap path object
     * @param {object} prices - Current market prices
     */
    static async assessSwapRisk(userId, path, prices = {}) {
        try {
            logger.info(`Assessing swap risk for user ${userId}`, {
                path: path.id
            });

            // Get trade amount calculation
            const tradeAmount = await this.calculateTradeAmount(
                userId,
                path.sourceExchange,
                path.sourceAsset,
                prices
            );

            // Check daily limit
            const dailyLimit = await this.canExecuteSwap(userId);

            // Check concurrent limit
            const concurrentLimit = await this.canExecuteConcurrentSwap(userId);

            // Overall risk assessment
            const canProceed =
                tradeAmount.canTrade &&
                dailyLimit.canExecute &&
                concurrentLimit.canExecute;

            const assessment = {
                canProceed,
                tradeAmount,
                dailyLimit,
                concurrentLimit,
                risks: []
            };

            // Identify risks
            if (!tradeAmount.canTrade) {
                assessment.risks.push({
                    type: 'insufficient_balance',
                    severity: 'high',
                    message: tradeAmount.reason
                });
            }

            if (!dailyLimit.canExecute) {
                assessment.risks.push({
                    type: 'daily_limit_reached',
                    severity: 'medium',
                    message: `Daily swap limit reached (${dailyLimit.dailyCount}/${dailyLimit.maxDaily})`
                });
            }

            if (!concurrentLimit.canExecute) {
                assessment.risks.push({
                    type: 'concurrent_limit_reached',
                    severity: 'medium',
                    message: `Max concurrent trades reached (${concurrentLimit.currentlyExecuting}/${concurrentLimit.maxConcurrent})`
                });
            }

            logger.info(`Risk assessment completed`, {
                userId,
                canProceed,
                risksCount: assessment.risks.length
            });

            return assessment;

        } catch (error) {
            logger.error('Failed to assess swap risk', {
                userId,
                path: path.id,
                error: error.message
            });

            throw error;
        }
    }
}

module.exports = RiskCalculatorService;
