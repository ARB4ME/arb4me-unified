/**
 * Portfolio Percentage Calculator
 *
 * Calculates trade amounts based on portfolio percentage with safety caps.
 * Formula: MIN(portfolioPercent * balance, maxTradeAmount)
 *
 * Features:
 * - Currency-specific portfolios (USDT separate from ZAR)
 * - Portfolio % as primary driver, maxTradeAmount as safety cap
 * - Non-blocking warnings when limits apply
 * - Graceful handling of insufficient balance
 */

const { systemLogger } = require('./logger');

// Minimum trade amount (in USD equivalent)
const MIN_TRADE_AMOUNT = 10;

class PortfolioCalculator {
    /**
     * Calculate trade amount based on portfolio percentage
     *
     * @param {object} options - Calculation parameters
     * @param {number} options.balance - Current balance in the currency
     * @param {number} options.portfolioPercent - Portfolio percentage to use (e.g., 10 for 10%)
     * @param {number} options.maxTradeAmount - Maximum trade amount cap
     * @param {string} options.currency - Currency (USDT, ZAR, etc.)
     * @param {string} options.exchange - Exchange name for logging
     * @param {object} options.path - Trading path for logging
     * @returns {object} { amount, canTrade, warning, reason }
     */
    calculateTradeAmount({
        balance,
        portfolioPercent,
        maxTradeAmount,
        currency,
        exchange,
        path
    }) {
        // Calculate portfolio-based amount
        const portfolioAmount = (balance * portfolioPercent) / 100;

        // Apply safety cap: MIN(portfolioAmount, maxTradeAmount)
        // Portfolio % is conservative default when there's a conflict
        const tradeAmount = Math.min(portfolioAmount, maxTradeAmount);

        // Check minimum trade threshold
        const canTrade = tradeAmount >= MIN_TRADE_AMOUNT;

        // Generate warnings and reasons
        let warning = null;
        let reason = null;

        if (!canTrade) {
            // Insufficient balance - log lost opportunity but don't block scanning
            reason = `Insufficient ${currency} balance: ${balance.toFixed(2)} (${portfolioPercent}% = $${portfolioAmount.toFixed(2)}, min $${MIN_TRADE_AMOUNT} required)`;

            systemLogger.info(`Lost opportunity - insufficient balance`, {
                exchange,
                path: path ? `${path.path[0]}→${path.path[1]}→${path.path[2]}` : 'unknown',
                currency,
                balance: balance.toFixed(2),
                portfolioPercent,
                portfolioAmount: portfolioAmount.toFixed(2),
                minRequired: MIN_TRADE_AMOUNT,
                profitIfFunded: path?.profitPercentage || 0
            });

        } else if (portfolioAmount > maxTradeAmount) {
            // Max trade cap is limiting - warn but allow trade
            warning = `Max trade cap limiting: Portfolio ${portfolioPercent}% = $${portfolioAmount.toFixed(2)}, capped at $${maxTradeAmount.toFixed(2)}`;

            systemLogger.warn(`Trade amount capped by maxTradeAmount`, {
                exchange,
                path: path ? `${path.path[0]}→${path.path[1]}→${path.path[2]}` : 'unknown',
                currency,
                portfolioAmount: portfolioAmount.toFixed(2),
                maxTradeAmount: maxTradeAmount.toFixed(2),
                cappedAmount: tradeAmount.toFixed(2)
            });
        }

        return {
            amount: tradeAmount,
            canTrade,
            warning,
            reason,
            details: {
                balance,
                portfolioPercent,
                portfolioAmount: portfolioAmount.toFixed(2),
                maxTradeAmount,
                appliedCap: portfolioAmount > maxTradeAmount ? 'maxTrade' : 'portfolio',
                currency
            }
        };
    }

    /**
     * Detect the base currency from various input types
     * Works with: Triangular paths, trading pairs, or explicit currency
     *
     * @param {array|string} input - Trading path, pair, or currency
     *   - Array: [USDT, BTC, ETH, USDT] (triangular arb)
     *   - String: 'BTCUSDT', 'BTC/USDT', 'BTC-USDT' (regular arb/trading)
     *   - String: 'USDT', 'ZAR' (explicit currency)
     * @returns {string} Base currency (USDT, ZAR, etc.)
     */
    getPathBaseCurrency(input) {
        // Default to USDT if no input
        if (!input) {
            return 'USDT';
        }

        // Common base/quote currencies (in priority order)
        const baseCurrencies = ['USDT', 'ZAR', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'];

        // Case 1: Input is an array (triangular arb path)
        if (Array.isArray(input)) {
            if (input.length < 1) return 'USDT';

            const startCurrency = input[0];

            // Check if start currency is a known base currency
            if (baseCurrencies.includes(startCurrency)) {
                return startCurrency;
            }

            // Check if USDT or ZAR appears in the first position
            if (startCurrency.includes('USDT')) return 'USDT';
            if (startCurrency.includes('ZAR')) return 'ZAR';

            // Default to USDT
            return 'USDT';
        }

        // Case 2: Input is a string
        if (typeof input === 'string') {
            const inputUpper = input.toUpperCase();

            // Check if input is already a base currency (explicit)
            if (baseCurrencies.includes(inputUpper)) {
                return inputUpper;
            }

            // Extract base currency from trading pair
            // Formats: BTCUSDT, BTC/USDT, BTC-USDT, BTC_USDT
            const pairClean = inputUpper.replace(/[\/\-_]/g, ''); // Remove separators

            // Try to match base currencies at the end (most common: quote currency)
            // For pair like BTCUSDT, the quote (base for trading) is USDT
            for (const currency of baseCurrencies) {
                if (pairClean.endsWith(currency)) {
                    return currency;
                }
            }

            // Try to match at the beginning (less common but possible)
            for (const currency of baseCurrencies) {
                if (pairClean.startsWith(currency)) {
                    return currency;
                }
            }

            // Default to USDT
            return 'USDT';
        }

        // Fallback default
        return 'USDT';
    }

    /**
     * Update balance after trade execution
     * Balances are stateless - only update on:
     * - Trade execution
     * - Manual funding
     * - Manual rebalance
     *
     * @param {number} currentBalance - Current balance
     * @param {number} amountUsed - Amount used in trade
     * @param {number} profitAmount - Profit from trade
     * @returns {number} New balance
     */
    updateBalanceAfterTrade(currentBalance, amountUsed, profitAmount) {
        // Balance stays the same + profit (amount used is already in the current balance)
        return currentBalance + profitAmount;
    }

    /**
     * Format balance display with change tracking
     *
     * @param {number} startingBalance - Starting balance
     * @param {number} currentBalance - Current balance
     * @param {string} currency - Currency symbol
     * @returns {object} Formatted display strings
     */
    formatBalanceDisplay(startingBalance, currentBalance, currency) {
        const change = currentBalance - startingBalance;
        const changePercent = startingBalance > 0
            ? ((change / startingBalance) * 100).toFixed(2)
            : '0.00';

        const changeSign = change >= 0 ? '+' : '';
        const changeColor = change >= 0 ? '#00d26a' : '#ff4444';

        return {
            starting: `${currency} ${startingBalance.toFixed(2)}`,
            current: `${currency} ${currentBalance.toFixed(2)}`,
            change: `${changeSign}${currency} ${change.toFixed(2)}`,
            changePercent: `${changeSign}${changePercent}%`,
            changeColor
        };
    }
}

module.exports = new PortfolioCalculator();
