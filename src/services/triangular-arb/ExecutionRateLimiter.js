/**
 * Execution Rate Limiter
 * Prevents overwhelming exchanges with rapid consecutive executions
 *
 * Purpose: Avoid 429 rate limit errors during live trading by:
 * - Tracking last execution time per exchange
 * - Enforcing minimum delays between executions
 * - Queuing executions if exchange is busy
 *
 * IMPORTANT: Shared singleton across all users and requests
 */

const { systemLogger } = require('../../utils/logger');

class ExecutionRateLimiter {
    constructor() {
        // Track last execution time per exchange
        this.lastExecutionTime = new Map();

        // Track active executions per exchange
        this.activeExecutions = new Map();

        // Exchange-specific rate limits (in milliseconds)
        this.rateLimits = {
            // South African exchanges (stricter limits)
            valr: 30000,      // 30 seconds between executions
            luno: 30000,      // 30 seconds
            chainex: 30000,   // 30 seconds

            // International exchanges (moderate limits)
            binance: 15000,   // 15 seconds
            bybit: 15000,     // 15 seconds
            okx: 15000,       // 15 seconds
            kucoin: 15000,    // 15 seconds
            coinbase: 15000,  // 15 seconds
            kraken: 20000,    // 20 seconds (more conservative)

            // Smaller exchanges (conservative limits)
            htx: 20000,       // 20 seconds
            gateio: 20000,    // 20 seconds
            cryptocom: 20000, // 20 seconds
            mexc: 20000,      // 20 seconds
            xt: 20000,        // 20 seconds
            ascendex: 20000,  // 20 seconds
            bingx: 20000,     // 20 seconds
            bitget: 20000,    // 20 seconds
            bitmart: 20000,   // 20 seconds
            bitrue: 20000,    // 20 seconds
            gemini: 20000,    // 20 seconds
            coincatch: 20000, // 20 seconds

            // Default for unknown exchanges
            default: 20000    // 20 seconds
        };
    }

    /**
     * Check if execution is allowed for an exchange
     * @param {string} exchange - Exchange name
     * @param {string} userId - User ID (for logging)
     * @returns {Promise<object>} { allowed: boolean, waitTime: number, message: string }
     */
    async checkExecutionAllowed(exchange, userId = 'anonymous') {
        const exchangeLower = exchange.toLowerCase();
        const now = Date.now();
        const rateLimit = this.rateLimits[exchangeLower] || this.rateLimits.default;

        // Check if there's an active execution on this exchange
        const activeCount = this.activeExecutions.get(exchangeLower) || 0;
        if (activeCount > 0) {
            systemLogger.warn(`[RATE LIMIT] Exchange busy - execution already in progress`, {
                exchange: exchangeLower,
                userId,
                activeExecutions: activeCount
            });

            return {
                allowed: false,
                waitTime: 5000, // Suggest 5 second retry
                message: `Exchange ${exchange} is currently processing another trade. Please wait a few seconds and try again.`,
                reason: 'EXCHANGE_BUSY'
            };
        }

        // Check last execution time
        const lastExecution = this.lastExecutionTime.get(exchangeLower);
        if (lastExecution) {
            const timeSinceLastExecution = now - lastExecution;
            const remainingWait = rateLimit - timeSinceLastExecution;

            if (remainingWait > 0) {
                systemLogger.warn(`[RATE LIMIT] Too soon since last execution`, {
                    exchange: exchangeLower,
                    userId,
                    timeSinceLastExecution: `${Math.floor(timeSinceLastExecution / 1000)}s`,
                    requiredWait: `${Math.floor(rateLimit / 1000)}s`,
                    remainingWait: `${Math.floor(remainingWait / 1000)}s`
                });

                return {
                    allowed: false,
                    waitTime: remainingWait,
                    message: `Please wait ${Math.ceil(remainingWait / 1000)} seconds before executing another trade on ${exchange} to avoid rate limits.`,
                    reason: 'RATE_LIMIT_COOLDOWN'
                };
            }
        }

        // Execution allowed
        systemLogger.trading(`[RATE LIMIT] ✅ Execution allowed`, {
            exchange: exchangeLower,
            userId,
            lastExecution: lastExecution ? `${Math.floor((now - lastExecution) / 1000)}s ago` : 'never'
        });

        return {
            allowed: true,
            waitTime: 0,
            message: 'Execution allowed'
        };
    }

    /**
     * Mark execution as started
     * @param {string} exchange - Exchange name
     * @param {string} executionId - Execution ID for tracking
     */
    markExecutionStarted(exchange, executionId) {
        const exchangeLower = exchange.toLowerCase();
        const now = Date.now();

        // Increment active execution count
        const currentActive = this.activeExecutions.get(exchangeLower) || 0;
        this.activeExecutions.set(exchangeLower, currentActive + 1);

        // Update last execution time
        this.lastExecutionTime.set(exchangeLower, now);

        systemLogger.trading(`[RATE LIMIT] Execution started`, {
            exchange: exchangeLower,
            executionId,
            activeExecutions: currentActive + 1
        });
    }

    /**
     * Mark execution as completed
     * @param {string} exchange - Exchange name
     * @param {string} executionId - Execution ID for tracking
     */
    markExecutionCompleted(exchange, executionId) {
        const exchangeLower = exchange.toLowerCase();

        // Decrement active execution count
        const currentActive = this.activeExecutions.get(exchangeLower) || 0;
        const newActive = Math.max(0, currentActive - 1);

        if (newActive === 0) {
            this.activeExecutions.delete(exchangeLower);
        } else {
            this.activeExecutions.set(exchangeLower, newActive);
        }

        systemLogger.trading(`[RATE LIMIT] Execution completed`, {
            exchange: exchangeLower,
            executionId,
            activeExecutions: newActive
        });
    }

    /**
     * Get current status for an exchange
     * @param {string} exchange - Exchange name
     * @returns {object} Status information
     */
    getExchangeStatus(exchange) {
        const exchangeLower = exchange.toLowerCase();
        const now = Date.now();
        const lastExecution = this.lastExecutionTime.get(exchangeLower);
        const activeCount = this.activeExecutions.get(exchangeLower) || 0;
        const rateLimit = this.rateLimits[exchangeLower] || this.rateLimits.default;

        let nextAvailable = 0;
        if (lastExecution) {
            const timeSinceLastExecution = now - lastExecution;
            const remainingWait = rateLimit - timeSinceLastExecution;
            nextAvailable = remainingWait > 0 ? remainingWait : 0;
        }

        return {
            exchange: exchangeLower,
            activeExecutions: activeCount,
            lastExecutionAgo: lastExecution ? now - lastExecution : null,
            nextAvailableIn: nextAvailable,
            rateLimitMs: rateLimit,
            status: activeCount > 0 ? 'BUSY' : (nextAvailable > 0 ? 'COOLDOWN' : 'READY')
        };
    }

    /**
     * Get status for all exchanges
     * @returns {object} Status for all exchanges
     */
    getAllExchangeStatus() {
        const status = {};
        const allExchanges = Object.keys(this.rateLimits).filter(ex => ex !== 'default');

        for (const exchange of allExchanges) {
            status[exchange] = this.getExchangeStatus(exchange);
        }

        return status;
    }

    /**
     * Reset rate limiter (for testing or emergency use)
     */
    reset() {
        this.lastExecutionTime.clear();
        this.activeExecutions.clear();
        systemLogger.warn(`[RATE LIMIT] Rate limiter reset - all exchange cooldowns cleared`);
    }
}

// Export singleton instance
module.exports = new ExecutionRateLimiter();
