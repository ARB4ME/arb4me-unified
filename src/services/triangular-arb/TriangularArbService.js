/**
 * Triangular Arbitrage Service
 * Main orchestrator for triangular arbitrage operations
 * Coordinates path definitions, profit calculations, order book fetching, and trade execution
 *
 * IMPORTANT: This service is STATELESS - credentials are never stored
 * Credentials flow through as parameters for multi-user support
 */

const { systemLogger } = require('../../utils/logger');
const PathDefinitionsService = require('./PathDefinitionsService');
const ProfitCalculatorService = require('./ProfitCalculatorService');
const OrderBookFetcherService = require('./OrderBookFetcherService');
const TradeExecutorService = require('./TradeExecutorService');
const PreFlightValidationService = require('./PreFlightValidationService');
const executionRateLimiter = require('./ExecutionRateLimiter');

class TriangularArbService {
    constructor() {
        // Initialize supporting services (all stateless)
        this.pathDefinitions = new PathDefinitionsService();
        this.profitCalculator = new ProfitCalculatorService();
        this.orderBookFetcher = new OrderBookFetcherService();
        this.tradeExecutor = new TradeExecutorService();
        this.preFlightValidator = new PreFlightValidationService();
    }

    /**
     * Scan for triangular arbitrage opportunities on a specific exchange
     * @param {string} exchange - Exchange name ('valr', 'luno', etc.)
     * @param {object} options - Configuration options
     * @param {object} options.credentials - User's API credentials { apiKey, apiSecret }
     * @param {string|array} options.paths - Path sets to scan ('all' or specific sets)
     * @param {number} options.amount - Amount to simulate (default: 1000)
     * @returns {Promise<Array>} Array of profitable opportunities
     */
    async scan(exchange, options) {
        const { credentials, paths = 'all', amount = 1000, profitThreshold = 0 } = options;

        systemLogger.trading(`[DEBUG] Triangular arb scan initiated`, {
            exchange,
            pathsRequested: paths,
            amount,
            profitThreshold,
            hasCredentials: !!credentials,
            timestamp: new Date().toISOString()
        });

        try {
            // Step 1: Get path definitions for this exchange
            const pathsToScan = this.pathDefinitions.getPathsForExchange(exchange, paths);

            systemLogger.trading(`[DEBUG] Step 1: Path definitions loaded`, {
                exchange,
                pathsRequested: paths,
                pathsFound: pathsToScan?.length || 0,
                pathIds: pathsToScan?.map(p => p.id).slice(0, 5) // First 5 path IDs
            });

            if (!pathsToScan || pathsToScan.length === 0) {
                systemLogger.warn(`No paths found for exchange: ${exchange}, paths: ${paths}`);
                return [];
            }

            // Step 2: Get unique trading pairs from all paths
            const uniquePairs = this._extractUniquePairs(pathsToScan);

            systemLogger.trading(`[DEBUG] Step 2: Unique pairs extracted`, {
                exchange,
                uniquePairsCount: uniquePairs.length,
                pairs: uniquePairs
            });

            // Step 3: Fetch order books for all required pairs (pass credentials through)
            const orderBooks = await this.orderBookFetcher.fetchMultiple(
                exchange,
                uniquePairs,
                credentials  // Forward user's credentials
            );

            systemLogger.trading(`[DEBUG] Step 3: Orderbooks fetched`, {
                exchange,
                orderbooksFetched: Object.keys(orderBooks).length,
                pairsRequested: uniquePairs.length,
                orderbookPairs: Object.keys(orderBooks),
                sampleOrderbook: orderBooks[Object.keys(orderBooks)[0]] ? {
                    pair: Object.keys(orderBooks)[0],
                    hasBids: !!orderBooks[Object.keys(orderBooks)[0]]?.Bids || !!orderBooks[Object.keys(orderBooks)[0]]?.bids,
                    hasAsks: !!orderBooks[Object.keys(orderBooks)[0]]?.Asks || !!orderBooks[Object.keys(orderBooks)[0]]?.asks
                } : 'No orderbooks'
            });

            // Step 4: Calculate profits for each path
            const opportunities = [];
            const calculationResults = { success: 0, failed: 0, belowThreshold: 0 };

            for (const path of pathsToScan) {
                try {
                    // Calculate profit for this path (credentials not needed for calculation)
                    const result = this.profitCalculator.calculate(
                        exchange,
                        path,
                        orderBooks,
                        amount
                    );

                    if (result.success) {
                        calculationResults.success++;
                        // Include ALL opportunities (even negative profit) if profitThreshold allows
                        if (result.profitPercentage >= profitThreshold) {
                            opportunities.push(result);
                        } else {
                            calculationResults.belowThreshold++;
                        }
                    } else {
                        calculationResults.failed++;
                    }
                } catch (error) {
                    calculationResults.failed++;
                    systemLogger.error(`Error calculating path ${path.id}`, {
                        error: error.message,
                        exchange,
                        pathId: path.id
                    });
                }
            }

            systemLogger.trading(`[DEBUG] Step 4: Profit calculations complete`, {
                exchange,
                pathsCalculated: pathsToScan.length,
                successfulCalculations: calculationResults.success,
                failedCalculations: calculationResults.failed,
                belowThreshold: calculationResults.belowThreshold,
                profitThreshold,
                opportunitiesFound: opportunities.length
            });

            // Sort by profit percentage (highest first)
            opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

            systemLogger.trading(`[DEBUG] Scan complete`, {
                exchange,
                opportunitiesFound: opportunities.length,
                topProfit: opportunities[0]?.profitPercentage || 0,
                top3Paths: opportunities.slice(0, 3).map(o => ({
                    path: o.path,
                    profit: o.profitPercentage
                }))
            });

            // Return opportunities with detailed debug info for frontend console
            return {
                opportunities,
                debug: {
                    step1_pathsLoaded: pathsToScan.length,
                    step1_pathIds: pathsToScan.map(p => p.id),
                    step2_uniquePairs: uniquePairs,
                    step3_orderbooksFetched: Object.keys(orderBooks).length,
                    step3_orderbooksRequested: uniquePairs.length,
                    step3_orderbookPairs: Object.keys(orderBooks),
                    step3_sampleOrderbook: orderBooks[Object.keys(orderBooks)[0]] ? {
                        pair: Object.keys(orderBooks)[0],
                        bidsCount: (orderBooks[Object.keys(orderBooks)[0]]?.Bids || orderBooks[Object.keys(orderBooks)[0]]?.bids || []).length,
                        asksCount: (orderBooks[Object.keys(orderBooks)[0]]?.Asks || orderBooks[Object.keys(orderBooks)[0]]?.asks || []).length
                    } : null,
                    step4_calculationsSuccessful: calculationResults.success,
                    step4_calculationsFailed: calculationResults.failed,
                    step4_calculationsBelowThreshold: calculationResults.belowThreshold,
                    step4_profitThreshold: profitThreshold
                }
            };

        } catch (error) {
            systemLogger.error(`Triangular arb scan failed`, {
                exchange,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Execute a triangular arbitrage opportunity
     * @param {string} exchange - Exchange name
     * @param {string} pathId - ID of the path to execute
     * @param {number} amount - Amount to trade
     * @param {object} credentials - User's API credentials { apiKey, apiSecret }
     * @param {object} options - Execution options
     * @returns {Promise<object>} Execution result
     */
    async execute(exchange, pathId, amount, credentials, options = {}) {
        const {
            dryRun = true,              // Default to dry run for safety
            confirmed = false,           // Requires explicit confirmation for live trading
            minProfitThreshold = 0.3,    // Minimum profit required
            maxTradeAmount = null,       // Maximum trade amount limit
            portfolioPercent = null,     // Max % of portfolio
            userId = 'anonymous'         // User ID for rate limiting
        } = options;

        systemLogger.trading(`Triangular arb execution initiated ${dryRun ? '[DRY RUN]' : '[LIVE]'}`, {
            exchange,
            pathId,
            amount,
            dryRun,
            confirmed,
            userId,
            timestamp: new Date().toISOString()
        });

        const executionId = `EXEC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        try {
            // STEP 0: RATE LIMIT CHECK (prevent overwhelming exchanges)
            // Skip rate limiting for dry runs (they don't hit exchange APIs for execution)
            if (!dryRun) {
                systemLogger.trading(`[RATE LIMIT] Checking execution rate limit...`);

                const rateLimitCheck = await executionRateLimiter.checkExecutionAllowed(exchange, userId);

                if (!rateLimitCheck.allowed) {
                    systemLogger.warn(`[RATE LIMIT] Execution blocked`, {
                        exchange,
                        userId,
                        reason: rateLimitCheck.reason,
                        waitTime: `${Math.ceil(rateLimitCheck.waitTime / 1000)}s`
                    });

                    return {
                        success: false,
                        error: rateLimitCheck.reason,
                        message: rateLimitCheck.message,
                        waitTime: rateLimitCheck.waitTime,
                        retryAfter: Date.now() + rateLimitCheck.waitTime
                    };
                }

                // Mark execution as started
                executionRateLimiter.markExecutionStarted(exchange, executionId);
                systemLogger.trading(`[RATE LIMIT] ✅ Rate limit check passed - execution allowed`);
            }

            // Step 1: Get the specific path definition
            const path = this.pathDefinitions.getPathById(exchange, pathId);

            if (!path) {
                throw new Error(`Path not found: ${pathId} on ${exchange}`);
            }

            // Step 2: PRE-FLIGHT VALIDATION (Critical Safety Checks)
            systemLogger.trading(`[SAFETY] Running pre-flight validation...`);

            const validationResult = await this.preFlightValidator.validateTrade(
                exchange,
                path,
                amount,
                credentials,
                {
                    minProfitThreshold,
                    maxTradeAmount,
                    portfolioPercent,
                    requireConfirmation: !dryRun,  // Only require confirmation for live trading
                    confirmed
                }
            );

            if (!validationResult.passed) {
                systemLogger.warn(`[SAFETY] Pre-flight validation FAILED`, {
                    exchange,
                    pathId,
                    checks: validationResult.checks,
                    warnings: validationResult.warnings
                });

                return {
                    success: false,
                    error: 'PRE_FLIGHT_VALIDATION_FAILED',
                    validationResult,
                    message: 'Trade blocked by safety checks'
                };
            }

            systemLogger.trading(`[SAFETY] ✅ Pre-flight validation PASSED - proceeding with execution`);

            // Use the freshly calculated opportunity from validation
            const currentOpportunity = validationResult.currentOpportunity;

            systemLogger.trading(`Executing opportunity`, {
                exchange,
                pathId,
                expectedProfit: currentOpportunity.profitPercentage,
                sequence: currentOpportunity.sequence,
                dryRun
            });

            // Step 3: Execute the 3-leg trade (pass credentials and dry run flag)
            const executionResult = await this.tradeExecutor.executeAtomic(
                exchange,
                currentOpportunity,
                credentials,  // Forward user's credentials
                {
                    dryRun,
                    maxSlippage: 0.5,
                    timeoutMs: 30000
                }
            );

            systemLogger.trading(`Execution complete ${dryRun ? '[DRY RUN]' : '[LIVE]'}`, {
                exchange,
                pathId,
                success: executionResult.success,
                actualProfit: executionResult.actualProfit,
                executionId: executionResult.executionId,
                dryRun
            });

            // Include validation result in response
            executionResult.validationResult = validationResult;

            // Mark execution as completed (for live trading rate limiting)
            if (!dryRun) {
                executionRateLimiter.markExecutionCompleted(exchange, executionId);
            }

            return executionResult;

        } catch (error) {
            // Mark execution as completed even on error (for live trading rate limiting)
            if (!dryRun) {
                executionRateLimiter.markExecutionCompleted(exchange, executionId);
            }

            systemLogger.error(`Triangular arb execution failed`, {
                exchange,
                pathId,
                amount,
                dryRun,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get available paths for an exchange
     * @param {string} exchange - Exchange name
     * @returns {Array} Available path sets
     */
    getAvailablePaths(exchange) {
        return this.pathDefinitions.getAvailablePathSets(exchange);
    }

    /**
     * Get trading history (if implemented)
     * @param {string} exchange - Exchange name
     * @param {object} filters - Filter criteria
     * @returns {Array} Trade history
     */
    async getHistory(exchange, filters = {}) {
        // TODO: Implement trade history tracking
        // For now, return empty array
        systemLogger.warn(`Trade history not yet implemented for ${exchange}`);
        return [];
    }

    /**
     * Extract unique trading pairs from paths
     * @private
     */
    _extractUniquePairs(paths) {
        const pairsSet = new Set();

        for (const path of paths) {
            if (path.pairs && Array.isArray(path.pairs)) {
                path.pairs.forEach(pair => pairsSet.add(pair));
            }
        }

        return Array.from(pairsSet);
    }
}

// Export singleton instance (stateless, safe for multi-user)
module.exports = new TriangularArbService();
