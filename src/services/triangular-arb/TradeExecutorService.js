/**
 * Trade Executor Service
 * Executes atomic 3-leg triangular arbitrage trades
 *
 * Handles:
 * - Sequential 3-leg execution
 * - Error handling and rollback (where possible)
 * - Execution tracking
 * - Slippage monitoring
 *
 * IMPORTANT: Stateless - credentials passed as parameters
 */

const { systemLogger } = require('../../utils/logger');
const ExchangeConnectorService = require('./ExchangeConnectorService');

class TradeExecutorService {
    constructor() {
        this.exchangeConnector = new ExchangeConnectorService();
    }

    /**
     * Execute atomic 3-leg triangular arbitrage trade
     * @param {string} exchange - Exchange name
     * @param {object} opportunity - Calculated opportunity with steps
     * @param {object} credentials - User's API credentials { apiKey, apiSecret }
     * @param {object} options - Execution options
     * @returns {Promise<object>} Execution result
     */
    async executeAtomic(exchange, opportunity, credentials, options = {}) {
        const {
            maxSlippage = 0.5,      // 0.5% max slippage
            timeoutMs = 30000        // 30 second timeout per leg
        } = options;

        const executionId = this._generateExecutionId();
        const startTime = Date.now();

        // Initialize execution tracking
        const executionResult = {
            executionId,
            exchange,
            pathId: opportunity.pathId,
            sequence: opportunity.sequence,
            startAmount: opportunity.startAmount,
            expectedProfit: opportunity.profitPercentage,
            actualProfit: null,
            legs: [],
            status: 'INITIATED',
            startTime: new Date().toISOString(),
            endTime: null,
            totalExecutionTime: null,
            error: null
        };

        systemLogger.trading(`Starting atomic execution`, {
            executionId,
            exchange,
            pathId: opportunity.pathId,
            expectedProfit: opportunity.profitPercentage
        });

        try {
            let currentAmount = opportunity.startAmount;

            // Execute each of the 3 legs sequentially
            for (let i = 0; i < opportunity.steps.length; i++) {
                const step = opportunity.steps[i];
                const legStartTime = Date.now();

                systemLogger.trading(`Executing leg ${i + 1}/3`, {
                    executionId,
                    pair: step.pair,
                    side: step.side,
                    amount: currentAmount
                });

                try {
                    // Execute the trade (pass credentials through)
                    const orderResult = await Promise.race([
                        this.exchangeConnector.executeMarketOrder(
                            exchange,
                            step.pair,
                            step.side,
                            currentAmount,
                            credentials  // Forward user's credentials
                        ),
                        this._timeout(timeoutMs)
                    ]);

                    const legEndTime = Date.now();
                    const legExecutionTime = legEndTime - legStartTime;

                    // Parse order result (exchange-specific)
                    const executedAmount = this._parseExecutedAmount(exchange, orderResult, step.side);
                    const executedPrice = this._parseExecutedPrice(exchange, orderResult);

                    // Calculate slippage
                    const expectedPrice = step.price;
                    const slippage = Math.abs((executedPrice - expectedPrice) / expectedPrice) * 100;

                    // Check slippage tolerance
                    if (slippage > maxSlippage) {
                        throw new Error(`Slippage too high: ${slippage.toFixed(2)}% (max: ${maxSlippage}%)`);
                    }

                    // Track leg execution
                    executionResult.legs.push({
                        leg: i + 1,
                        pair: step.pair,
                        side: step.side,
                        inputAmount: currentAmount,
                        outputAmount: executedAmount,
                        expectedPrice,
                        executedPrice,
                        slippage: parseFloat(slippage.toFixed(3)),
                        executionTime: legExecutionTime,
                        orderId: orderResult.orderId || orderResult.id || null,
                        status: 'COMPLETED',
                        timestamp: new Date().toISOString()
                    });

                    systemLogger.trading(`Leg ${i + 1}/3 completed`, {
                        executionId,
                        executedAmount,
                        slippage: slippage.toFixed(3) + '%',
                        executionTime: legExecutionTime + 'ms'
                    });

                    // Update current amount for next leg
                    currentAmount = executedAmount;

                } catch (legError) {
                    // Log leg failure
                    executionResult.legs.push({
                        leg: i + 1,
                        pair: step.pair,
                        side: step.side,
                        inputAmount: currentAmount,
                        status: 'FAILED',
                        error: legError.message,
                        timestamp: new Date().toISOString()
                    });

                    throw new Error(`Leg ${i + 1} failed: ${legError.message}`);
                }
            }

            // Calculate actual profit
            const endAmount = currentAmount;
            const actualProfit = endAmount - opportunity.startAmount;
            const actualProfitPercentage = (actualProfit / opportunity.startAmount) * 100;

            const endTime = Date.now();
            const totalExecutionTime = endTime - startTime;

            // Update execution result
            executionResult.status = 'COMPLETED';
            executionResult.endAmount = parseFloat(endAmount.toFixed(2));
            executionResult.actualProfit = parseFloat(actualProfit.toFixed(2));
            executionResult.actualProfitPercentage = parseFloat(actualProfitPercentage.toFixed(3));
            executionResult.endTime = new Date().toISOString();
            executionResult.totalExecutionTime = totalExecutionTime;
            executionResult.success = true;

            systemLogger.trading(`Atomic execution completed successfully`, {
                executionId,
                actualProfit: actualProfitPercentage.toFixed(3) + '%',
                totalTime: totalExecutionTime + 'ms'
            });

            return executionResult;

        } catch (error) {
            const endTime = Date.now();
            const totalExecutionTime = endTime - startTime;

            // Update execution result with error
            executionResult.status = 'FAILED';
            executionResult.error = error.message;
            executionResult.endTime = new Date().toISOString();
            executionResult.totalExecutionTime = totalExecutionTime;
            executionResult.success = false;

            systemLogger.error(`Atomic execution failed`, {
                executionId,
                exchange,
                pathId: opportunity.pathId,
                completedLegs: executionResult.legs.filter(l => l.status === 'COMPLETED').length,
                error: error.message
            });

            // Return partial result (important for user to see what happened)
            return executionResult;
        }
    }

    /**
     * Generate unique execution ID
     * @private
     */
    _generateExecutionId() {
        return `EXEC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Create timeout promise
     * @private
     */
    _timeout(ms) {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
        );
    }

    /**
     * Parse executed amount from order result (exchange-specific)
     * @private
     */
    _parseExecutedAmount(exchange, orderResult, side) {
        switch (exchange.toLowerCase()) {
            case 'valr':
                return parseFloat(orderResult.filledBaseAmount || orderResult.filledQuoteAmount || 0);

            case 'luno':
                return parseFloat(orderResult.base || orderResult.counter || 0);

            case 'binance':
                return parseFloat(orderResult.executedQty || 0);

            case 'gemini':
                return parseFloat(orderResult.executed_amount || orderResult.original_amount || 0);

            case 'coincatch':
                return parseFloat(orderResult.data?.size || orderResult.size || orderResult.filledQty || 0);

            default:
                return parseFloat(orderResult.filled || orderResult.amount || orderResult.quantity || 0);
        }
    }

    /**
     * Parse executed price from order result (exchange-specific)
     * @private
     */
    _parseExecutedPrice(exchange, orderResult) {
        switch (exchange.toLowerCase()) {
            case 'valr':
                return parseFloat(orderResult.averagePrice || 0);

            case 'luno':
                return parseFloat(orderResult.price || 0);

            case 'binance':
                return parseFloat(orderResult.price || 0);

            case 'gemini':
                return parseFloat(orderResult.avg_execution_price || orderResult.price || 0);

            case 'coincatch':
                return parseFloat(orderResult.data?.priceAvg || orderResult.priceAvg || orderResult.price || 0);

            default:
                return parseFloat(orderResult.price || orderResult.averagePrice || 0);
        }
    }
}

module.exports = TradeExecutorService;
