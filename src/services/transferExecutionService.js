/**
 * Transfer Execution Service
 * Handles the complete 5-step transfer arbitrage execution:
 * 1. Buy crypto on source exchange
 * 2. Withdraw crypto to destination exchange
 * 3. Monitor blockchain for arrival
 * 4. Sell crypto on destination exchange
 * 5. Track and log the transfer
 */

const { systemLogger } = require('../utils/logger');
const crypto = require('crypto');

class TransferExecutionService {
    constructor() {
        this.activeTransfers = new Map(); // Track ongoing transfers
        this.transferHistory = [];
        this.isExecuting = false;
    }

    /**
     * Execute a transfer arbitrage opportunity
     * Option 1: ONE transfer at a time (simple & safe)
     */
    async executeTransfer(opportunity, credentials) {
        // Check if already executing
        if (this.isExecuting) {
            throw new Error('Transfer already in progress. Wait for completion before starting another.');
        }

        this.isExecuting = true;
        const transferId = this.generateTransferId();
        const startTime = Date.now();

        systemLogger.trading('Transfer execution started', {
            transferId,
            crypto: opportunity.crypto,
            fromExchange: opportunity.fromExchange,
            toExchange: opportunity.toExchange,
            expectedProfit: opportunity.netProfit
        });

        // Create transfer tracking object
        const transfer = {
            id: transferId,
            opportunity,
            credentials,
            status: 'INITIATED',
            steps: {
                buy: { status: 'PENDING', result: null, error: null },
                withdraw: { status: 'PENDING', result: null, error: null },
                monitor: { status: 'PENDING', result: null, error: null },
                sell: { status: 'PENDING', result: null, error: null }
            },
            startTime,
            endTime: null,
            actualProfit: null,
            error: null
        };

        this.activeTransfers.set(transferId, transfer);

        try {
            // STEP 1: BUY CRYPTO ON SOURCE EXCHANGE
            systemLogger.trading('Step 1: Buying crypto', {
                transferId,
                exchange: opportunity.fromExchange,
                crypto: opportunity.crypto,
                amount: opportunity.usdtToSpend
            });

            transfer.steps.buy.status = 'IN_PROGRESS';
            const buyResult = await this.executeBuyOrder(
                opportunity.fromExchange,
                opportunity.crypto,
                opportunity.usdtToSpend,
                credentials.fromExchange
            );

            transfer.steps.buy.status = 'COMPLETED';
            transfer.steps.buy.result = buyResult;

            systemLogger.trading('Step 1 completed', {
                transferId,
                cryptoReceived: buyResult.quantity,
                price: buyResult.averagePrice
            });

            // STEP 2: WITHDRAW CRYPTO TO DESTINATION
            systemLogger.trading('Step 2: Withdrawing crypto', {
                transferId,
                fromExchange: opportunity.fromExchange,
                toExchange: opportunity.toExchange,
                amount: buyResult.quantity
            });

            transfer.steps.withdraw.status = 'IN_PROGRESS';
            const withdrawResult = await this.executeWithdrawal(
                opportunity.fromExchange,
                opportunity.crypto,
                buyResult.quantity,
                credentials.fromExchange,
                credentials.depositAddress
            );

            transfer.steps.withdraw.status = 'COMPLETED';
            transfer.steps.withdraw.result = withdrawResult;

            systemLogger.trading('Step 2 completed', {
                transferId,
                txHash: withdrawResult.txHash,
                withdrawalId: withdrawResult.withdrawalId
            });

            // STEP 3: MONITOR BLOCKCHAIN FOR ARRIVAL
            systemLogger.trading('Step 3: Monitoring blockchain', {
                transferId,
                txHash: withdrawResult.txHash,
                estimatedTime: opportunity.estimatedTransferTime
            });

            transfer.steps.monitor.status = 'IN_PROGRESS';
            transfer.status = 'IN_TRANSIT';

            const depositResult = await this.monitorDeposit(
                opportunity.toExchange,
                opportunity.crypto,
                withdrawResult.txHash,
                credentials.toExchange
            );

            transfer.steps.monitor.status = 'COMPLETED';
            transfer.steps.monitor.result = depositResult;

            systemLogger.trading('Step 3 completed', {
                transferId,
                arrived: true,
                actualAmount: depositResult.amountReceived
            });

            // STEP 4: SELL CRYPTO ON DESTINATION EXCHANGE
            systemLogger.trading('Step 4: Selling crypto', {
                transferId,
                exchange: opportunity.toExchange,
                crypto: opportunity.crypto,
                amount: depositResult.amountReceived
            });

            transfer.steps.sell.status = 'IN_PROGRESS';
            const sellResult = await this.executeSellOrder(
                opportunity.toExchange,
                opportunity.crypto,
                depositResult.amountReceived,
                credentials.toExchange
            );

            transfer.steps.sell.status = 'COMPLETED';
            transfer.steps.sell.result = sellResult;

            // Calculate actual profit
            const actualProfit = sellResult.usdtReceived - opportunity.usdtToSpend;
            const actualProfitPercent = (actualProfit / opportunity.usdtToSpend) * 100;

            transfer.status = 'COMPLETED';
            transfer.endTime = Date.now();
            transfer.actualProfit = actualProfit;

            systemLogger.trading('Transfer execution COMPLETED', {
                transferId,
                duration: `${(transfer.endTime - transfer.startTime) / 1000}s`,
                expectedProfit: opportunity.netProfit,
                actualProfit,
                actualProfitPercent: actualProfitPercent.toFixed(2) + '%',
                slippage: (actualProfit - opportunity.netProfit).toFixed(2)
            });

            // Move to history
            this.transferHistory.push(transfer);
            this.activeTransfers.delete(transferId);
            this.isExecuting = false;

            return {
                success: true,
                transferId,
                actualProfit,
                actualProfitPercent,
                duration: transfer.endTime - transfer.startTime,
                steps: transfer.steps
            };

        } catch (error) {
            transfer.status = 'FAILED';
            transfer.error = error.message;
            transfer.endTime = Date.now();

            systemLogger.error('Transfer execution FAILED', {
                transferId,
                error: error.message,
                stack: error.stack,
                failedAt: this.getFailedStep(transfer)
            });

            // Move to history
            this.transferHistory.push(transfer);
            this.activeTransfers.delete(transferId);
            this.isExecuting = false;

            throw error;
        }
    }

    /**
     * STEP 1: Execute buy order on source exchange
     */
    async executeBuyOrder(exchange, crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing buy order', {
            exchange,
            crypto,
            usdtAmount
        });

        // Call exchange-specific buy logic
        switch (exchange) {
            case 'binance':
                return await this.executeBinanceBuy(crypto, usdtAmount, credentials);
            case 'kraken':
                return await this.executeKrakenBuy(crypto, usdtAmount, credentials);
            case 'okx':
                return await this.executeOKXBuy(crypto, usdtAmount, credentials);
            case 'bybit':
                return await this.executeBybitBuy(crypto, usdtAmount, credentials);
            // Add more exchanges as needed
            default:
                throw new Error(`Buy order not implemented for ${exchange}`);
        }
    }

    /**
     * STEP 2: Execute withdrawal to destination exchange
     */
    async executeWithdrawal(exchange, crypto, amount, credentials, destinationAddress) {
        systemLogger.trading('Executing withdrawal', {
            exchange,
            crypto,
            amount,
            destination: destinationAddress.substring(0, 10) + '...'
        });

        // Call exchange-specific withdrawal logic
        switch (exchange) {
            case 'binance':
                return await this.executeBinanceWithdrawal(crypto, amount, destinationAddress, credentials);
            case 'kraken':
                return await this.executeKrakenWithdrawal(crypto, amount, destinationAddress, credentials);
            case 'okx':
                return await this.executeOKXWithdrawal(crypto, amount, destinationAddress, credentials);
            case 'bybit':
                return await this.executeBybitWithdrawal(crypto, amount, destinationAddress, credentials);
            // Add more exchanges as needed
            default:
                throw new Error(`Withdrawal not implemented for ${exchange}`);
        }
    }

    /**
     * STEP 3: Monitor blockchain for deposit arrival
     */
    async monitorDeposit(exchange, crypto, txHash, credentials) {
        systemLogger.trading('Monitoring deposit', {
            exchange,
            crypto,
            txHash
        });

        const maxWaitTime = 3600000; // 1 hour max
        const checkInterval = 10000; // Check every 10 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            try {
                // Check if deposit has arrived
                const depositStatus = await this.checkDepositStatus(
                    exchange,
                    crypto,
                    txHash,
                    credentials
                );

                if (depositStatus.arrived) {
                    systemLogger.trading('Deposit arrived', {
                        exchange,
                        crypto,
                        amount: depositStatus.amount,
                        confirmations: depositStatus.confirmations
                    });

                    return {
                        arrived: true,
                        amountReceived: depositStatus.amount,
                        confirmations: depositStatus.confirmations,
                        waitTime: Date.now() - startTime
                    };
                }

                // Wait before checking again
                await new Promise(resolve => setTimeout(resolve, checkInterval));

            } catch (error) {
                systemLogger.warn('Deposit check failed, retrying...', {
                    exchange,
                    error: error.message
                });
                await new Promise(resolve => setTimeout(resolve, checkInterval));
            }
        }

        throw new Error('Deposit monitoring timeout - transfer took too long');
    }

    /**
     * STEP 4: Execute sell order on destination exchange
     */
    async executeSellOrder(exchange, crypto, amount, credentials) {
        systemLogger.trading('Executing sell order', {
            exchange,
            crypto,
            amount
        });

        // Call exchange-specific sell logic
        switch (exchange) {
            case 'binance':
                return await this.executeBinanceSell(crypto, amount, credentials);
            case 'kraken':
                return await this.executeKrakenSell(crypto, amount, credentials);
            case 'okx':
                return await this.executeOKXSell(crypto, amount, credentials);
            case 'bybit':
                return await this.executeBybitSell(crypto, amount, credentials);
            // Add more exchanges as needed
            default:
                throw new Error(`Sell order not implemented for ${exchange}`);
        }
    }

    // ========================================
    // Exchange-specific implementations
    // ========================================

    async executeBinanceBuy(crypto, usdtAmount, credentials) {
        const symbol = `${crypto}USDT`;
        const timestamp = Date.now();

        systemLogger.trading('Executing Binance buy order', {
            symbol,
            usdtAmount,
            type: 'MARKET'
        });

        try {
            // Create market buy order with quote quantity (USDT amount)
            const params = {
                symbol: symbol,
                side: 'BUY',
                type: 'MARKET',
                quoteOrderQty: usdtAmount.toFixed(2), // Amount in USDT to spend
                timestamp: timestamp
            };

            const queryString = Object.entries(params)
                .map(([key, value]) => `${key}=${value}`)
                .join('&');

            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(queryString)
                .digest('hex');

            const response = await fetch(`https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: {
                    'X-MBX-APIKEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance buy order failed: HTTP ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Check for Binance error
            if (orderData.code && orderData.msg) {
                throw new Error(`Binance error ${orderData.code}: ${orderData.msg}`);
            }

            // Calculate quantity received
            const executedQty = parseFloat(orderData.executedQty || 0);
            const cummulativeQuoteQty = parseFloat(orderData.cummulativeQuoteQty || 0);
            const averagePrice = cummulativeQuoteQty / executedQty;

            systemLogger.trading('Binance buy order executed', {
                orderId: orderData.orderId,
                symbol,
                quantity: executedQty,
                averagePrice,
                totalCost: cummulativeQuoteQty
            });

            return {
                orderId: orderData.orderId,
                symbol: symbol,
                quantity: executedQty,
                averagePrice: averagePrice,
                totalCost: cummulativeQuoteQty,
                status: orderData.status,
                fills: orderData.fills
            };

        } catch (error) {
            systemLogger.error('Binance buy order failed', {
                symbol,
                error: error.message
            });
            throw error;
        }
    }

    async executeBinanceSell(crypto, amount, credentials) {
        const symbol = `${crypto}USDT`;
        const timestamp = Date.now();

        systemLogger.trading('Executing Binance sell order', {
            symbol,
            amount,
            type: 'MARKET'
        });

        try {
            // Create market sell order with base quantity (crypto amount)
            const params = {
                symbol: symbol,
                side: 'SELL',
                type: 'MARKET',
                quantity: amount.toFixed(8), // Amount of crypto to sell
                timestamp: timestamp
            };

            const queryString = Object.entries(params)
                .map(([key, value]) => `${key}=${value}`)
                .join('&');

            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(queryString)
                .digest('hex');

            const response = await fetch(`https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: {
                    'X-MBX-APIKEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance sell order failed: HTTP ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Check for Binance error
            if (orderData.code && orderData.msg) {
                throw new Error(`Binance error ${orderData.code}: ${orderData.msg}`);
            }

            // Calculate USDT received
            const executedQty = parseFloat(orderData.executedQty || 0);
            const cummulativeQuoteQty = parseFloat(orderData.cummulativeQuoteQty || 0);
            const averagePrice = cummulativeQuoteQty / executedQty;

            systemLogger.trading('Binance sell order executed', {
                orderId: orderData.orderId,
                symbol,
                quantity: executedQty,
                averagePrice,
                usdtReceived: cummulativeQuoteQty
            });

            return {
                orderId: orderData.orderId,
                symbol: symbol,
                quantity: executedQty,
                averagePrice: averagePrice,
                usdtReceived: cummulativeQuoteQty,
                status: orderData.status,
                fills: orderData.fills
            };

        } catch (error) {
            systemLogger.error('Binance sell order failed', {
                symbol,
                error: error.message
            });
            throw error;
        }
    }

    async executeBinanceWithdrawal(crypto, amount, address, credentials) {
        const timestamp = Date.now();

        systemLogger.trading('Executing Binance withdrawal', {
            crypto,
            amount,
            destination: address.substring(0, 10) + '...'
        });

        try {
            // Create withdrawal request
            const params = {
                coin: crypto,
                address: address,
                amount: amount.toFixed(8),
                timestamp: timestamp
            };

            const queryString = Object.entries(params)
                .map(([key, value]) => `${key}=${value}`)
                .join('&');

            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(queryString)
                .digest('hex');

            const response = await fetch(`https://api.binance.com/sapi/v1/capital/withdraw/apply?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: {
                    'X-MBX-APIKEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance withdrawal failed: HTTP ${response.status} - ${errorText}`);
            }

            const withdrawalData = await response.json();

            // Check for Binance error
            if (withdrawalData.code && withdrawalData.msg) {
                throw new Error(`Binance error ${withdrawalData.code}: ${withdrawalData.msg}`);
            }

            systemLogger.trading('Binance withdrawal initiated', {
                withdrawalId: withdrawalData.id,
                crypto,
                amount
            });

            return {
                withdrawalId: withdrawalData.id,
                crypto: crypto,
                amount: amount,
                address: address,
                txHash: null // Will be available later via status check
            };

        } catch (error) {
            systemLogger.error('Binance withdrawal failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async checkDepositStatus(exchange, crypto, txHash, credentials) {
        switch (exchange) {
            case 'binance':
                return await this.checkBinanceDeposit(crypto, credentials);
            case 'kraken':
                return await this.checkKrakenDeposit(crypto, credentials);
            case 'okx':
                return await this.checkOKXDeposit(crypto, credentials);
            case 'bybit':
                return await this.checkBybitDeposit(crypto, credentials);
            default:
                throw new Error(`Deposit checking not implemented for ${exchange}`);
        }
    }

    async checkBinanceDeposit(crypto, credentials) {
        const timestamp = Date.now();

        try {
            // Get recent deposit history
            const params = {
                coin: crypto,
                timestamp: timestamp
            };

            const queryString = Object.entries(params)
                .map(([key, value]) => `${key}=${value}`)
                .join('&');

            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(queryString)
                .digest('hex');

            const response = await fetch(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: {
                    'X-MBX-APIKEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance deposit check failed: HTTP ${response.status} - ${errorText}`);
            }

            const deposits = await response.json();

            // Check for Binance error
            if (deposits.code && deposits.msg) {
                throw new Error(`Binance error ${deposits.code}: ${deposits.msg}`);
            }

            // Look for most recent successful deposit
            if (Array.isArray(deposits) && deposits.length > 0) {
                const recentDeposit = deposits.find(d => d.status === 1); // status 1 = success

                if (recentDeposit) {
                    return {
                        arrived: true,
                        amount: parseFloat(recentDeposit.amount),
                        confirmations: recentDeposit.confirmTimes,
                        txHash: recentDeposit.txId
                    };
                }
            }

            // Not arrived yet
            return {
                arrived: false,
                amount: 0,
                confirmations: 0,
                txHash: null
            };

        } catch (error) {
            systemLogger.error('Binance deposit check failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async checkKrakenDeposit(crypto, credentials) {
        // TODO: Implement Kraken deposit checking
        throw new Error('Kraken deposit checking not implemented yet');
    }

    async checkOKXDeposit(crypto, credentials) {
        // TODO: Implement OKX deposit checking
        throw new Error('OKX deposit checking not implemented yet');
    }

    async checkBybitDeposit(crypto, credentials) {
        // TODO: Implement Bybit deposit checking
        throw new Error('Bybit deposit checking not implemented yet');
    }

    // ========================================
    // Helper methods
    // ========================================

    generateTransferId() {
        return `TXF-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    }

    getFailedStep(transfer) {
        for (const [stepName, step] of Object.entries(transfer.steps)) {
            if (step.error) return stepName;
            if (step.status === 'IN_PROGRESS') return stepName;
        }
        return 'unknown';
    }

    getActiveTransfers() {
        return Array.from(this.activeTransfers.values());
    }

    getTransferHistory(limit = 50) {
        return this.transferHistory.slice(-limit).reverse();
    }

    isTransferInProgress() {
        return this.isExecuting;
    }
}

// Create singleton instance
const transferExecutionService = new TransferExecutionService();

module.exports = transferExecutionService;
