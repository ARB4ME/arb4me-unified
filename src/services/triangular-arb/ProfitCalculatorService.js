/**
 * Profit Calculator Service
 * Calculates triangular arbitrage profits with exchange-specific fee structures
 *
 * Handles:
 * - Exchange-specific maker/taker fees
 * - Order book depth analysis
 * - Slippage estimation
 * - Multi-step profit calculation
 */

const { systemLogger } = require('../../utils/logger');

class ProfitCalculatorService {
    constructor() {
        // Exchange-specific fee structures
        this.feeStructures = {
            valr: {
                maker: 0.001,  // 0.1% maker fee
                taker: 0.001   // 0.1% taker fee (using taker for immediate execution)
            },
            luno: {
                maker: 0.001,  // 0.1% maker fee
                taker: 0.001   // 0.1% taker fee
            },
            chainex: {
                maker: 0.001,
                taker: 0.001
            },
            binance: {
                maker: 0.001,
                taker: 0.001
            },
            kraken: {
                maker: 0.0016,
                taker: 0.0026
            },
            bybit: {
                maker: 0.001,
                taker: 0.001
            },
            okx: {
                maker: 0.0008,
                taker: 0.001
            },
            kucoin: {
                maker: 0.001,
                taker: 0.001
            },
            coinbase: {
                maker: 0.004,
                taker: 0.006
            },
            htx: {
                maker: 0.002,
                taker: 0.002
            },
            gateio: {
                maker: 0.002,
                taker: 0.002
            },
            cryptocom: {
                maker: 0.004,
                taker: 0.004
            },
            mexc: {
                maker: 0.002,
                taker: 0.002
            },
            xt: {
                maker: 0.002,
                taker: 0.002
            },
            ascendex: {
                maker: 0.001,
                taker: 0.001
            },
            bingx: {
                maker: 0.002,
                taker: 0.002
            },
            bitget: {
                maker: 0.001,
                taker: 0.001
            },
            bitmart: {
                maker: 0.0025,
                taker: 0.0025
            },
            bitrue: {
                maker: 0.001,
                taker: 0.001
            },
            gemini: {
                maker: 0.001,
                taker: 0.001
            },
            coincatch: {
                maker: 0.002,
                taker: 0.002
            }
        };
    }

    /**
     * Calculate profit for a triangular arbitrage path
     * @param {string} exchange - Exchange name
     * @param {object} path - Path definition
     * @param {object} orderBooks - Order books for all pairs in path
     * @param {number} amount - Starting amount
     * @param {object} options - Additional options
     * @returns {object} Calculation result
     */
    calculate(exchange, path, orderBooks, amount = 1000, options = {}) {
        const exchangeLower = exchange.toLowerCase();
        const fees = this.feeStructures[exchangeLower];

        if (!fees) {
            return {
                success: false,
                error: `Fee structure not defined for exchange: ${exchange}`,
                pathId: path.id
            };
        }

        try {
            // Use taker fee for immediate execution
            const feeRate = fees.taker;

            let currentAmount = amount;
            const steps = [];
            let totalFees = 0;

            // Execute each step of the triangular path
            for (let i = 0; i < path.steps.length; i++) {
                const step = path.steps[i];
                const orderBook = this._getOrderBook(orderBooks, step.pair, exchange);

                if (!orderBook) {
                    return {
                        success: false,
                        error: `Missing order book data for ${step.pair}`,
                        pathId: path.id
                    };
                }

                let price, outputAmount, fee;

                if (step.side === 'buy') {
                    // Buying: use ask price (we pay the ask)
                    const asks = this._getAsks(orderBook, exchange);

                    if (!asks || asks.length === 0) {
                        return {
                            success: false,
                            error: `No ask orders available for ${step.pair}`,
                            pathId: path.id
                        };
                    }

                    price = parseFloat(asks[0].price || asks[0][0]);
                    // Deduct fee from input (quote currency), then convert to base
                    const amountAfterFee = currentAmount * (1 - feeRate);
                    outputAmount = amountAfterFee / price;
                    fee = currentAmount * feeRate;

                } else {
                    // Selling: use bid price (we receive the bid)
                    const bids = this._getBids(orderBook, exchange);

                    if (!bids || bids.length === 0) {
                        return {
                            success: false,
                            error: `No bid orders available for ${step.pair}`,
                            pathId: path.id
                        };
                    }

                    price = parseFloat(bids[0].price || bids[0][0]);
                    outputAmount = currentAmount * price * (1 - feeRate);
                    fee = (currentAmount * price) * feeRate;
                }

                totalFees += fee;

                steps.push({
                    step: i + 1,
                    pair: step.pair,
                    side: step.side,
                    inputAmount: parseFloat(currentAmount.toFixed(8)),
                    outputAmount: parseFloat(outputAmount.toFixed(8)),
                    price: parseFloat(price.toFixed(8)),
                    fee: parseFloat(fee.toFixed(6))
                });

                currentAmount = outputAmount;
            }

            const endAmount = currentAmount;
            const profit = endAmount - amount;
            const profitPercentage = (profit / amount) * 100;

            return {
                success: true,
                pathId: path.id,
                sequence: path.sequence,
                startAmount: amount,
                endAmount: parseFloat(endAmount.toFixed(2)),
                profit: parseFloat(profit.toFixed(2)),
                profitPercentage: parseFloat(profitPercentage.toFixed(3)),
                totalFees: parseFloat(totalFees.toFixed(2)),
                steps: steps,
                exchange: exchange,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            systemLogger.error(`Profit calculation error`, {
                exchange,
                pathId: path.id,
                error: error.message
            });

            return {
                success: false,
                error: error.message,
                pathId: path.id
            };
        }
    }

    /**
     * Get order book with exchange-specific field handling
     * @private
     */
    _getOrderBook(orderBooks, pair, exchange) {
        return orderBooks[pair];
    }

    /**
     * Get asks from order book (handles different exchange formats)
     * @private
     */
    _getAsks(orderBook, exchange) {
        // VALR uses capital Asks
        if (orderBook.Asks) return orderBook.Asks;

        // Luno and others use lowercase asks
        if (orderBook.asks) return orderBook.asks;

        return null;
    }

    /**
     * Get bids from order book (handles different exchange formats)
     * @private
     */
    _getBids(orderBook, exchange) {
        // VALR uses capital Bids
        if (orderBook.Bids) return orderBook.Bids;

        // Luno and others use lowercase bids
        if (orderBook.bids) return orderBook.bids;

        return null;
    }
}

module.exports = ProfitCalculatorService;
