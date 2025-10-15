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

class TriangularArbService {
    constructor() {
        // Initialize supporting services (all stateless)
        this.pathDefinitions = new PathDefinitionsService();
        this.profitCalculator = new ProfitCalculatorService();
        this.orderBookFetcher = new OrderBookFetcherService();
        this.tradeExecutor = new TradeExecutorService();
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
        const { credentials, paths = 'all', amount = 1000 } = options;

        systemLogger.trading(`Triangular arb scan initiated`, {
            exchange,
            pathsRequested: paths,
            amount,
            timestamp: new Date().toISOString()
        });

        try {
            // Step 1: Get path definitions for this exchange
            const pathsToScan = this.pathDefinitions.getPathsForExchange(exchange, paths);

            if (!pathsToScan || pathsToScan.length === 0) {
                systemLogger.warn(`No paths found for exchange: ${exchange}`);
                return [];
            }

            systemLogger.trading(`Scanning ${pathsToScan.length} paths for ${exchange}`);

            // Step 2: Get unique trading pairs from all paths
            const uniquePairs = this._extractUniquePairs(pathsToScan);

            // Step 3: Fetch order books for all required pairs (pass credentials through)
            const orderBooks = await this.orderBookFetcher.fetchMultiple(
                exchange,
                uniquePairs,
                credentials  // Forward user's credentials
            );

            // Step 4: Calculate profits for each path
            const opportunities = [];

            for (const path of pathsToScan) {
                try {
                    // Calculate profit for this path (credentials not needed for calculation)
                    const result = this.profitCalculator.calculate(
                        exchange,
                        path,
                        orderBooks,
                        amount
                    );

                    // Only include profitable opportunities
                    if (result.success && result.profitPercentage > 0) {
                        opportunities.push(result);
                    }
                } catch (error) {
                    systemLogger.error(`Error calculating path ${path.id}`, {
                        error: error.message,
                        exchange,
                        pathId: path.id
                    });
                }
            }

            // Sort by profit percentage (highest first)
            opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

            systemLogger.trading(`Scan complete: found ${opportunities.length} opportunities`, {
                exchange,
                opportunitiesFound: opportunities.length,
                topProfit: opportunities[0]?.profitPercentage || 0
            });

            return opportunities;

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
     * @returns {Promise<object>} Execution result
     */
    async execute(exchange, pathId, amount, credentials) {
        systemLogger.trading(`Triangular arb execution initiated`, {
            exchange,
            pathId,
            amount,
            timestamp: new Date().toISOString()
        });

        try {
            // Step 1: Get the specific path definition
            const path = this.pathDefinitions.getPathById(exchange, pathId);

            if (!path) {
                throw new Error(`Path not found: ${pathId} on ${exchange}`);
            }

            // Step 2: Fetch fresh order books (pass credentials through)
            const uniquePairs = path.pairs;
            const orderBooks = await this.orderBookFetcher.fetchMultiple(
                exchange,
                uniquePairs,
                credentials  // Forward user's credentials
            );

            // Step 3: Recalculate opportunity with current prices
            const currentOpportunity = this.profitCalculator.calculate(
                exchange,
                path,
                orderBooks,
                amount
            );

            if (!currentOpportunity.success) {
                throw new Error(`Opportunity calculation failed: ${currentOpportunity.error}`);
            }

            systemLogger.trading(`Executing opportunity`, {
                exchange,
                pathId,
                expectedProfit: currentOpportunity.profitPercentage,
                sequence: currentOpportunity.sequence
            });

            // Step 4: Execute the 3-leg trade (pass credentials through)
            const executionResult = await this.tradeExecutor.executeAtomic(
                exchange,
                currentOpportunity,
                credentials  // Forward user's credentials
            );

            systemLogger.trading(`Execution complete`, {
                exchange,
                pathId,
                success: executionResult.success,
                actualProfit: executionResult.actualProfit,
                executionId: executionResult.executionId
            });

            return executionResult;

        } catch (error) {
            systemLogger.error(`Triangular arb execution failed`, {
                exchange,
                pathId,
                amount,
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
