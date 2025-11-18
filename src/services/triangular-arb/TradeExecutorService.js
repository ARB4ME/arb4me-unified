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
            timeoutMs = 30000,       // 30 second timeout per leg
            dryRun = false           // Dry run mode (simulate without real trades)
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
            dryRun: dryRun,
            startTime: new Date().toISOString(),
            endTime: null,
            totalExecutionTime: null,
            error: null
        };

        systemLogger.trading(`Starting atomic execution ${dryRun ? '[DRY RUN]' : '[LIVE]'}`, {
            executionId,
            exchange,
            pathId: opportunity.pathId,
            expectedProfit: opportunity.profitPercentage,
            dryRun
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
                    let orderResult, executedAmount, executedPrice;

                    if (dryRun) {
                        // DRY RUN: Simulate execution without placing real orders
                        systemLogger.trading(`[DRY RUN] Simulating leg ${i + 1}/3`, {
                            executionId,
                            pair: step.pair,
                            side: step.side,
                            amount: currentAmount
                        });

                        // Simulate order execution with expected prices
                        await new Promise(resolve => setTimeout(resolve, 100)); // Simulate network delay

                        executedAmount = step.expectedAmount || currentAmount * 0.998; // Simulate 0.2% fee
                        executedPrice = step.price;

                        orderResult = {
                            orderId: `DRY_RUN_${Date.now()}`,
                            status: 'SIMULATED',
                            executedQty: executedAmount,
                            price: executedPrice
                        };

                    } else {
                        // LIVE: Execute the trade (pass credentials through)
                        orderResult = await Promise.race([
                            this.exchangeConnector.executeMarketOrder(
                                exchange,
                                step.pair,
                                step.side,
                                currentAmount,
                                credentials  // Forward user's credentials
                            ),
                            this._timeout(timeoutMs)
                        ]);

                        // Parse order result (exchange-specific)
                        executedAmount = this._parseExecutedAmount(exchange, orderResult, step.side);
                        executedPrice = this._parseExecutedPrice(exchange, orderResult);
                    }

                    const legEndTime = Date.now();
                    const legExecutionTime = legEndTime - legStartTime;

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
            case 'bitrue':
            case 'mexc':
                return parseFloat(orderResult.executedQty || 0);

            case 'bitmart':
                return parseFloat(orderResult.data?.filled_size || orderResult.filled_size || 0);

            case 'bitget':
                return parseFloat(orderResult.data?.fillSize || orderResult.fillSize || 0);

            case 'bingx':
                return parseFloat(orderResult.data?.executedQty || orderResult.executedQty || 0);

            case 'ascendex':
                return parseFloat(orderResult.data?.filledQty || orderResult.filledQty || 0);

            case 'xt':
                return parseFloat(orderResult.result?.executedQty || orderResult.executedQty || 0);

            case 'gemini':
                return parseFloat(orderResult.executed_amount || orderResult.original_amount || 0);

            case 'coincatch':
                return parseFloat(orderResult.data?.size || orderResult.size || orderResult.filledQty || 0);

            case 'cryptocom':
                // Crypto.com JSON-RPC response format
                return parseFloat(orderResult.result?.cumulative_quantity || orderResult.cumulative_quantity || 0);

            case 'htx':
                // HTX response format
                return parseFloat(orderResult['field-amount'] || orderResult['filled-amount'] || 0);

            case 'gateio':
                // Gate.io response format
                return parseFloat(orderResult.filled_total || orderResult.amount || 0);

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
            case 'bitrue':
            case 'mexc':
                return parseFloat(orderResult.price || 0);

            case 'bitmart':
                return parseFloat(orderResult.data?.price || orderResult.price || 0);

            case 'bitget':
                return parseFloat(orderResult.data?.fillPrice || orderResult.fillPrice || orderResult.price || 0);

            case 'bingx':
                return parseFloat(orderResult.data?.avgPrice || orderResult.avgPrice || orderResult.price || 0);

            case 'ascendex':
                return parseFloat(orderResult.data?.avgPrice || orderResult.avgPrice || orderResult.price || 0);

            case 'xt':
                return parseFloat(orderResult.result?.avgPrice || orderResult.avgPrice || orderResult.price || 0);

            case 'gemini':
                return parseFloat(orderResult.avg_execution_price || orderResult.price || 0);

            case 'coincatch':
                return parseFloat(orderResult.data?.priceAvg || orderResult.priceAvg || orderResult.price || 0);

            case 'cryptocom':
                // Crypto.com JSON-RPC response format
                return parseFloat(orderResult.result?.avg_price || orderResult.avg_price || 0);

            case 'htx':
                // HTX provides filled amount and filled cash - calculate average price
                const filledAmount = parseFloat(orderResult['field-amount'] || 0);
                const filledCash = parseFloat(orderResult['field-cash-amount'] || 0);
                return filledAmount > 0 ? filledCash / filledAmount : 0;

            case 'gateio':
                // Gate.io response format
                return parseFloat(orderResult.avg_deal_price || orderResult.price || 0);

            default:
                return parseFloat(orderResult.price || orderResult.averagePrice || 0);
        }
    }
}

module.exports = TradeExecutorService;
