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
            case 'valr':
                return await this.executeVALRBuy(crypto, usdtAmount, credentials);
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
            case 'valr':
                return await this.executeVALRWithdrawal(crypto, amount, destinationAddress, credentials);
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
            case 'valr':
                return await this.executeVALRSell(crypto, amount, credentials);
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
            case 'valr':
                return await this.checkVALRDeposit(crypto, credentials);
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
    // VALR Exchange Implementation
    // ========================================

    async executeVALRBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing VALR buy order', {
            crypto,
            usdtAmount,
            type: 'MARKET'
        });

        try {
            // VALR uses pair format like BTCUSDT
            const pair = `${crypto}USDT`;

            // VALR market buy order - specify quote currency amount (USDT)
            const orderPayload = {
                side: 'BUY',
                quantity: usdtAmount.toFixed(2),
                pair: pair,
                postOnly: false,
                customerOrderId: `BUY-${Date.now()}`
            };

            const timestamp = Date.now().toString();
            const endpoint = '/v1/orders/market';
            const bodyString = JSON.stringify(orderPayload);
            const payload = timestamp + 'POST' + endpoint + bodyString;

            const signature = crypto
                .createHmac('sha512', credentials.apiSecret)
                .update(payload)
                .digest('hex');

            const response = await fetch(`https://api.valr.com${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-VALR-API-KEY': credentials.apiKey,
                    'X-VALR-SIGNATURE': signature,
                    'X-VALR-TIMESTAMP': timestamp
                },
                body: bodyString
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR buy order failed: HTTP ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Get order status to confirm execution
            const orderId = orderData.id;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for order to settle

            const statusData = await this.getVALROrderStatus(orderId, credentials);

            systemLogger.trading('VALR buy order executed', {
                orderId,
                pair,
                status: statusData.orderStatusType
            });

            // Calculate average price and quantity from fills
            const totalCost = parseFloat(statusData.totalPrice || usdtAmount);
            const quantity = parseFloat(statusData.totalQuantity || 0);
            const averagePrice = quantity > 0 ? totalCost / quantity : 0;

            return {
                orderId,
                symbol: pair,
                quantity,
                averagePrice,
                totalCost,
                status: statusData.orderStatusType
            };

        } catch (error) {
            systemLogger.error('VALR buy order failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async executeVALRSell(crypto, amount, credentials) {
        systemLogger.trading('Executing VALR sell order', {
            crypto,
            amount,
            type: 'MARKET'
        });

        try {
            // VALR uses pair format like BTCUSDT
            const pair = `${crypto}USDT`;

            // VALR market sell order - specify base currency amount (crypto)
            const orderPayload = {
                side: 'SELL',
                quantity: amount.toFixed(8),
                pair: pair,
                postOnly: false,
                customerOrderId: `SELL-${Date.now()}`
            };

            const timestamp = Date.now().toString();
            const endpoint = '/v1/orders/market';
            const bodyString = JSON.stringify(orderPayload);
            const payload = timestamp + 'POST' + endpoint + bodyString;

            const signature = crypto
                .createHmac('sha512', credentials.apiSecret)
                .update(payload)
                .digest('hex');

            const response = await fetch(`https://api.valr.com${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-VALR-API-KEY': credentials.apiKey,
                    'X-VALR-SIGNATURE': signature,
                    'X-VALR-TIMESTAMP': timestamp
                },
                body: bodyString
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR sell order failed: HTTP ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Get order status to confirm execution
            const orderId = orderData.id;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for order to settle

            const statusData = await this.getVALROrderStatus(orderId, credentials);

            systemLogger.trading('VALR sell order executed', {
                orderId,
                pair,
                status: statusData.orderStatusType
            });

            // Calculate USDT received
            const usdtReceived = parseFloat(statusData.totalPrice || 0);
            const quantity = parseFloat(statusData.totalQuantity || 0);
            const averagePrice = quantity > 0 ? usdtReceived / quantity : 0;

            return {
                orderId,
                symbol: pair,
                quantity,
                averagePrice,
                usdtReceived,
                status: statusData.orderStatusType
            };

        } catch (error) {
            systemLogger.error('VALR sell order failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async executeVALRWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing VALR withdrawal', {
            crypto,
            amount,
            destination: address.substring(0, 10) + '...'
        });

        try {
            // VALR withdrawal endpoint
            const orderPayload = {
                currency: crypto,
                amount: amount.toFixed(8),
                address: address
            };

            const timestamp = Date.now().toString();
            const endpoint = '/v1/wallet/crypto/withdraw';
            const bodyString = JSON.stringify(orderPayload);
            const payload = timestamp + 'POST' + endpoint + bodyString;

            const signature = crypto
                .createHmac('sha512', credentials.apiSecret)
                .update(payload)
                .digest('hex');

            const response = await fetch(`https://api.valr.com${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-VALR-API-KEY': credentials.apiKey,
                    'X-VALR-SIGNATURE': signature,
                    'X-VALR-TIMESTAMP': timestamp
                },
                body: bodyString
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR withdrawal failed: HTTP ${response.status} - ${errorText}`);
            }

            const withdrawalData = await response.json();

            systemLogger.trading('VALR withdrawal initiated', {
                withdrawalId: withdrawalData.id,
                crypto,
                amount
            });

            return {
                withdrawalId: withdrawalData.id,
                crypto: crypto,
                amount: amount,
                address: address,
                txHash: null // Will be available later
            };

        } catch (error) {
            systemLogger.error('VALR withdrawal failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async getVALROrderStatus(orderId, credentials) {
        const timestamp = Date.now().toString();
        const endpoint = `/v1/orders/${orderId}`;
        const payload = timestamp + 'GET' + endpoint;

        const signature = crypto
            .createHmac('sha512', credentials.apiSecret)
            .update(payload)
            .digest('hex');

        const response = await fetch(`https://api.valr.com${endpoint}`, {
            method: 'GET',
            headers: {
                'X-VALR-API-KEY': credentials.apiKey,
                'X-VALR-SIGNATURE': signature,
                'X-VALR-TIMESTAMP': timestamp
            }
        });

        if (!response.ok) {
            throw new Error(`VALR order status check failed: ${response.status}`);
        }

        return await response.json();
    }

    async checkVALRDeposit(crypto, credentials) {
        try {
            // Get deposit history
            const timestamp = Date.now().toString();
            const endpoint = `/v1/wallet/crypto/deposit/history?currency=${crypto}`;
            const payload = timestamp + 'GET' + endpoint;

            const signature = crypto
                .createHmac('sha512', credentials.apiSecret)
                .update(payload)
                .digest('hex');

            const response = await fetch(`https://api.valr.com${endpoint}`, {
                method: 'GET',
                headers: {
                    'X-VALR-API-KEY': credentials.apiKey,
                    'X-VALR-SIGNATURE': signature,
                    'X-VALR-TIMESTAMP': timestamp
                }
            });

            if (!response.ok) {
                throw new Error(`VALR deposit check failed: ${response.status}`);
            }

            const deposits = await response.json();

            // Look for most recent completed deposit
            if (Array.isArray(deposits) && deposits.length > 0) {
                const recentDeposit = deposits.find(d =>
                    d.currencyCode === crypto &&
                    d.confirmations >= d.confirmedThreshold
                );

                if (recentDeposit) {
                    return {
                        arrived: true,
                        amount: parseFloat(recentDeposit.amount),
                        confirmations: recentDeposit.confirmations,
                        txHash: recentDeposit.transactionHash
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
            systemLogger.error('VALR deposit check failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    // ========================================
    // OKX Exchange Implementation
    // ========================================

    async executeOKXBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing OKX buy order', {
            crypto,
            usdtAmount,
            type: 'MARKET'
        });

        try {
            const symbol = `${crypto}-USDT`;
            const timestamp = new Date().toISOString();

            const orderPayload = {
                instId: symbol,
                tdMode: 'cash',
                side: 'buy',
                ordType: 'market',
                sz: usdtAmount.toFixed(2)
            };

            const bodyString = JSON.stringify(orderPayload);
            const prehash = timestamp + 'POST' + '/api/v5/trade/order' + bodyString;
            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(prehash)
                .digest('base64');

            const response = await fetch('https://www.okx.com/api/v5/trade/order', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || ''
                },
                body: bodyString
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX buy order failed: HTTP ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            if (orderData.code !== '0') {
                throw new Error(`OKX error ${orderData.code}: ${orderData.msg}`);
            }

            const orderId = orderData.data[0].ordId;
            await new Promise(resolve => setTimeout(resolve, 2000));

            const statusData = await this.getOKXOrderStatus(orderId, symbol, credentials);

            systemLogger.trading('OKX buy order executed', {
                orderId,
                symbol,
                status: statusData.state
            });

            const quantity = parseFloat(statusData.fillSz || 0);
            const totalCost = parseFloat(statusData.fillNotionalUsd || usdtAmount);
            const averagePrice = quantity > 0 ? totalCost / quantity : 0;

            return {
                orderId,
                symbol,
                quantity,
                averagePrice,
                totalCost,
                status: statusData.state
            };

        } catch (error) {
            systemLogger.error('OKX buy order failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async executeOKXSell(crypto, amount, credentials) {
        systemLogger.trading('Executing OKX sell order', {
            crypto,
            amount,
            type: 'MARKET'
        });

        try {
            const symbol = `${crypto}-USDT`;
            const timestamp = new Date().toISOString();

            const orderPayload = {
                instId: symbol,
                tdMode: 'cash',
                side: 'sell',
                ordType: 'market',
                sz: amount.toFixed(8)
            };

            const bodyString = JSON.stringify(orderPayload);
            const prehash = timestamp + 'POST' + '/api/v5/trade/order' + bodyString;
            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(prehash)
                .digest('base64');

            const response = await fetch('https://www.okx.com/api/v5/trade/order', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || ''
                },
                body: bodyString
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX sell order failed: HTTP ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            if (orderData.code !== '0') {
                throw new Error(`OKX error ${orderData.code}: ${orderData.msg}`);
            }

            const orderId = orderData.data[0].ordId;
            await new Promise(resolve => setTimeout(resolve, 2000));

            const statusData = await this.getOKXOrderStatus(orderId, symbol, credentials);

            systemLogger.trading('OKX sell order executed', {
                orderId,
                symbol,
                status: statusData.state
            });

            const quantity = parseFloat(statusData.fillSz || 0);
            const usdtReceived = parseFloat(statusData.fillNotionalUsd || 0);
            const averagePrice = quantity > 0 ? usdtReceived / quantity : 0;

            return {
                orderId,
                symbol,
                quantity,
                averagePrice,
                usdtReceived,
                status: statusData.state
            };

        } catch (error) {
            systemLogger.error('OKX sell order failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async executeOKXWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing OKX withdrawal', {
            crypto,
            amount,
            destination: address.substring(0, 10) + '...'
        });

        try {
            const timestamp = new Date().toISOString();

            const withdrawPayload = {
                ccy: crypto,
                amt: amount.toFixed(8),
                dest: '4',
                toAddr: address,
                fee: '0.0001'
            };

            const bodyString = JSON.stringify(withdrawPayload);
            const prehash = timestamp + 'POST' + '/api/v5/asset/withdrawal' + bodyString;
            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(prehash)
                .digest('base64');

            const response = await fetch('https://www.okx.com/api/v5/asset/withdrawal', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || ''
                },
                body: bodyString
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX withdrawal failed: HTTP ${response.status} - ${errorText}`);
            }

            const withdrawalData = await response.json();

            if (withdrawalData.code !== '0') {
                throw new Error(`OKX error ${withdrawalData.code}: ${withdrawalData.msg}`);
            }

            systemLogger.trading('OKX withdrawal initiated', {
                withdrawalId: withdrawalData.data[0].wdId,
                crypto,
                amount
            });

            return {
                withdrawalId: withdrawalData.data[0].wdId,
                crypto,
                amount,
                address,
                txHash: null
            };

        } catch (error) {
            systemLogger.error('OKX withdrawal failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
    }

    async getOKXOrderStatus(orderId, symbol, credentials) {
        const timestamp = new Date().toISOString();
        const endpoint = `/api/v5/trade/order?ordId=${orderId}&instId=${symbol}`;
        const prehash = timestamp + 'GET' + endpoint;

        const signature = crypto
            .createHmac('sha256', credentials.apiSecret)
            .update(prehash)
            .digest('base64');

        const response = await fetch(`https://www.okx.com${endpoint}`, {
            method: 'GET',
            headers: {
                'OK-ACCESS-KEY': credentials.apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': credentials.passphrase || ''
            }
        });

        if (!response.ok) {
            throw new Error(`OKX order status check failed: ${response.status}`);
        }

        const data = await response.json();
        return data.data[0];
    }

    async checkOKXDeposit(crypto, credentials) {
        try {
            const timestamp = new Date().toISOString();
            const endpoint = `/api/v5/asset/deposit-history?ccy=${crypto}`;
            const prehash = timestamp + 'GET' + endpoint;

            const signature = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(prehash)
                .digest('base64');

            const response = await fetch(`https://www.okx.com${endpoint}`, {
                method: 'GET',
                headers: {
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || ''
                }
            });

            if (!response.ok) {
                throw new Error(`OKX deposit check failed: ${response.status}`);
            }

            const data = await response.json();

            if (data.code === '0' && data.data.length > 0) {
                const recentDeposit = data.data.find(d => d.state === '2');

                if (recentDeposit) {
                    return {
                        arrived: true,
                        amount: parseFloat(recentDeposit.amt),
                        confirmations: 0,
                        txHash: recentDeposit.txId
                    };
                }
            }

            return {
                arrived: false,
                amount: 0,
                confirmations: 0,
                txHash: null
            };

        } catch (error) {
            systemLogger.error('OKX deposit check failed', {
                crypto,
                error: error.message
            });
            throw error;
        }
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
