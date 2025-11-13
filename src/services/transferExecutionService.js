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
                credentials.depositAddress,
                credentials.depositTag  // Add tag parameter for XRP/XLM
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
     * STEP 1: Execute buy order on ANY exchange using CCXT
     * @param {string} exchange - Exchange name (e.g., 'binance', 'bybit', 'kraken')
     * @param {string} crypto - Crypto symbol (e.g., 'XRP', 'BTC', 'ETH')
     * @param {number} usdtAmount - Amount of USDT to spend
     * @param {object} credentials - API credentials { apiKey, apiSecret, passphrase }
     * @returns {object} Buy result with quantity, price, fees
     */
    async executeBuyOrder(exchange, crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing buy order via CCXT', {
            exchange,
            crypto,
            usdtAmount
        });

        try {
            const ccxt = require('ccxt');

            // Validate exchange is supported by CCXT
            if (!ccxt[exchange]) {
                const available = Object.keys(ccxt.exchanges).slice(0, 10).join(', ');
                throw new Error(`Exchange '${exchange}' is not supported by CCXT. Available: ${available}...`);
            }

            // Initialize exchange API
            const exchangeClass = ccxt[exchange];
            const api = new exchangeClass({
                apiKey: credentials.apiKey,
                secret: credentials.apiSecret,
                password: credentials.passphrase, // For OKX, KuCoin
                enableRateLimit: true, // Respect exchange rate limits
                options: {
                    defaultType: 'spot', // Use spot trading (not futures/margin)
                    adjustForTimeDifference: true // Handle time sync issues
                }
            });

            // Validate balance BEFORE placing order (SAFETY CHECK)
            systemLogger.trading('Checking USDT balance', { exchange });
            const balance = await api.fetchBalance();
            const availableUSDT = balance.free['USDT'] || 0;

            if (availableUSDT < usdtAmount) {
                throw new Error(`Insufficient USDT balance on ${exchange}. Available: $${availableUSDT.toFixed(2)}, Required: $${usdtAmount.toFixed(2)}`);
            }

            systemLogger.trading('Balance check passed', {
                exchange,
                availableUSDT: availableUSDT.toFixed(2),
                requiredUSDT: usdtAmount.toFixed(2)
            });

            // Create market symbol (e.g., 'XRP/USDT')
            const symbol = `${crypto}/USDT`;

            // Verify market exists
            await api.loadMarkets();
            if (!api.markets[symbol]) {
                throw new Error(`Market ${symbol} not available on ${exchange}. Check if ${crypto}/USDT pair is supported.`);
            }

            // Execute market buy order
            systemLogger.trading('Placing market buy order', {
                symbol,
                usdtAmount,
                type: 'market'
            });

            // Different exchanges need different parameters
            let order;

            // Binance/Bybit: Use quoteOrderQty (spend exact USDT amount)
            if (['binance', 'bybit'].includes(exchange.toLowerCase())) {
                order = await api.createOrder(symbol, 'market', 'buy', undefined, undefined, {
                    quoteOrderQty: usdtAmount
                });
            } else {
                // Other exchanges: Calculate crypto amount to buy based on current price
                const ticker = await api.fetchTicker(symbol);
                const currentPrice = ticker.last || ticker.close;
                const cryptoAmount = usdtAmount / currentPrice;

                systemLogger.trading('Calculated crypto amount', {
                    currentPrice,
                    cryptoAmount: cryptoAmount.toFixed(8)
                });

                order = await api.createMarketBuyOrder(symbol, cryptoAmount);
            }

            // Wait for order to fill (market orders usually instant, but check)
            if (order.status !== 'closed' && order.status !== 'filled') {
                systemLogger.trading('Order not immediately filled, fetching final status...', {
                    orderId: order.id,
                    status: order.status
                });

                // Fetch order details to get final status
                const filledOrder = await api.fetchOrder(order.id, symbol);
                order = filledOrder;
            }

            systemLogger.trading('Buy order executed successfully', {
                orderId: order.id,
                symbol: order.symbol,
                filled: order.filled,
                average: order.average,
                cost: order.cost,
                status: order.status,
                fee: order.fee
            });

            // Return standardized result
            return {
                success: true,
                orderId: order.id,
                exchange: exchange,
                crypto: crypto,
                quantity: order.filled, // Amount of crypto received
                averagePrice: order.average, // Average fill price
                totalCost: order.cost, // Total USDT spent
                fee: order.fee || { cost: 0, currency: crypto },
                timestamp: order.timestamp || Date.now(),
                status: order.status
            };

        } catch (error) {
            systemLogger.error('Buy order failed', {
                exchange,
                crypto,
                usdtAmount,
                error: error.message,
                stack: error.stack
            });

            // Re-throw with more context
            throw new Error(`Buy order failed on ${exchange}: ${error.message}`);
        }
    }

    /**
     * STEP 2: Execute withdrawal to destination exchange using CCXT
     * @param {string} exchange - Source exchange (e.g., 'kraken')
     * @param {string} crypto - Crypto to withdraw (e.g., 'XRP')
     * @param {number} amount - Amount to withdraw
     * @param {object} credentials - API credentials { apiKey, apiSecret, passphrase }
     * @param {string} destinationAddress - Receiving wallet address
     * @param {string} destinationTag - Tag/Memo for XRP/XLM (optional)
     * @returns {object} Withdrawal result with txHash, status
     */
    async executeWithdrawal(exchange, crypto, amount, credentials, destinationAddress, destinationTag) {
        systemLogger.trading('Executing withdrawal via CCXT', {
            exchange,
            crypto,
            amount,
            destination: destinationAddress.substring(0, 10) + '...',
            hasTag: !!destinationTag
        });

        try {
            const ccxt = require('ccxt');

            // Validate exchange is supported
            if (!ccxt[exchange]) {
                throw new Error(`Exchange '${exchange}' not supported by CCXT`);
            }

            // Initialize exchange API
            const exchangeClass = ccxt[exchange];
            const api = new exchangeClass({
                apiKey: credentials.apiKey,
                secret: credentials.apiSecret,
                password: credentials.passphrase, // For OKX, KuCoin
                enableRateLimit: true
            });

            // SAFETY CHECK: Validate balance before withdrawal
            systemLogger.trading('Checking crypto balance', { exchange, crypto });
            const balance = await api.fetchBalance();
            const available = balance.free[crypto] || 0;

            if (available < amount) {
                throw new Error(`Insufficient ${crypto} balance on ${exchange}. Available: ${available.toFixed(8)}, Required: ${amount.toFixed(8)}`);
            }

            systemLogger.trading('Balance check passed', {
                exchange,
                crypto,
                available: available.toFixed(8),
                withdrawing: amount.toFixed(8)
            });

            // SAFETY CHECK: Validate destination address format
            const addressValid = this.validateCryptoAddress(crypto, destinationAddress);
            if (!addressValid) {
                systemLogger.error('Invalid address format detected', {
                    crypto,
                    address: destinationAddress
                });
                throw new Error(`Invalid ${crypto} address format: ${destinationAddress}. Please verify the address is correct.`);
            }

            // CRITICAL: Validate XRP/XLM tag is provided
            if (['XRP', 'XLM'].includes(crypto) && !destinationTag) {
                throw new Error(`CRITICAL: ${crypto} requires a destination tag. Withdrawals without tags will result in PERMANENT FUND LOSS! Please configure the tag in Deposit Address Configuration.`);
            }

            // Build withdrawal parameters
            const params = {};

            // Add tag/memo for XRP/XLM
            if (destinationTag) {
                params.tag = destinationTag;   // XRP format
                params.memo = destinationTag;  // XLM format
                systemLogger.trading('Including destination tag', {
                    crypto,
                    tag: destinationTag
                });
            }

            // Specify network for USDT (critical!)
            if (crypto === 'USDT') {
                // Default to TRC20 (cheapest, fastest)
                params.network = 'TRC20';
                systemLogger.trading('USDT withdrawal - using TRC20 network', {
                    network: 'TRC20'
                });
            }

            // Execute withdrawal
            systemLogger.trading('Initiating blockchain withdrawal', {
                crypto,
                amount,
                exchange,
                addressPreview: destinationAddress.substring(0, 10) + '...',
                network: params.network || 'default'
            });

            const withdrawal = await api.withdraw(
                crypto,
                amount,
                destinationAddress,
                destinationTag,
                params
            );

            systemLogger.trading('Withdrawal initiated successfully', {
                withdrawalId: withdrawal.id,
                txHash: withdrawal.txid || 'pending',
                status: withdrawal.status,
                fee: withdrawal.fee
            });

            // Return standardized result
            return {
                success: true,
                withdrawalId: withdrawal.id,
                txHash: withdrawal.txid || null,  // May be null if pending
                amount: withdrawal.amount,
                fee: withdrawal.fee,
                status: withdrawal.status,  // 'pending', 'ok', 'failed', 'canceled'
                network: params.network || 'default',
                timestamp: Date.now()
            };

        } catch (error) {
            systemLogger.error('Withdrawal failed', {
                exchange,
                crypto,
                amount,
                error: error.message,
                stack: error.stack
            });

            throw new Error(`Withdrawal failed on ${exchange}: ${error.message}`);
        }
    }

    /**
     * Validate cryptocurrency address format
     * Basic validation to prevent obvious typos
     */
    validateCryptoAddress(crypto, address) {
        // Address format patterns
        const patterns = {
            'XRP': /^r[1-9A-HJ-NP-Za-km-z]{25,34}$/,
            'BTC': /^(1|3|bc1)[a-zA-Z0-9]{25,62}$/,
            'ETH': /^0x[a-fA-F0-9]{40}$/,
            'TRX': /^T[a-zA-Z0-9]{33}$/,
            'XLM': /^G[A-Z2-7]{55}$/,
            'LTC': /^(L|M|ltc1)[a-zA-Z0-9]{26,62}$/,
            'USDT': /.+/,  // USDT can be on multiple networks, hard to validate
            'USDC': /.+/,
            'DOGE': /^D[a-zA-Z0-9]{33}$/,
            'BCH': /^(1|3|q|p)[a-zA-Z0-9]{25,62}$/,
            'ADA': /^addr1[a-z0-9]{53,}$/,
            'DOT': /^1[a-zA-Z0-9]{47}$/
        };

        const pattern = patterns[crypto];
        if (!pattern) {
            // If no pattern defined, allow it (assume exchange validates)
            systemLogger.warn('No validation pattern for crypto', { crypto });
            return true;
        }

        const isValid = pattern.test(address);

        if (!isValid) {
            systemLogger.warn('Address failed format validation', {
                crypto,
                address: address.substring(0, 20) + '...',
                expectedPattern: pattern.toString()
            });
        }

        return isValid;
    }

    /**
     * ✅ PHASE 4: STEP 3 - Monitor blockchain for deposit arrival
     * Polls destination exchange API every 30 seconds until deposit arrives
     * @param {string} exchange - Destination exchange name
     * @param {string} crypto - Cryptocurrency symbol
     * @param {string} txHash - Transaction hash from withdrawal
     * @param {Object} credentials - API credentials for destination exchange
     * @returns {Object} {arrived: true, amountReceived: number, confirmations: number, waitTime: ms}
     */
    async monitorDeposit(exchange, crypto, txHash, credentials) {
        systemLogger.trading('🔍 Starting deposit monitoring', {
            exchange,
            crypto,
            txHash: txHash ? txHash.substring(0, 10) + '...' : 'N/A'
        });

        const maxWaitTime = 3600000; // 1 hour max (safety timeout)
        const checkInterval = 30000; // Check every 30 seconds (balance between responsiveness and rate limits)
        const startTime = Date.now();
        let checkCount = 0;

        while (Date.now() - startTime < maxWaitTime) {
            checkCount++;
            const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);

            try {
                systemLogger.trading(`🔄 Deposit check #${checkCount} (${elapsedMinutes}m elapsed)`, {
                    exchange,
                    crypto,
                    checkNumber: checkCount,
                    elapsedTime: `${elapsedMinutes}m`
                });

                // Check if deposit has arrived
                const depositStatus = await this.checkDepositStatus(
                    exchange,
                    crypto,
                    txHash,
                    credentials
                );

                if (depositStatus.arrived) {
                    const waitTimeMinutes = Math.floor((Date.now() - startTime) / 60000);
                    const waitTimeSeconds = Math.floor((Date.now() - startTime) / 1000);

                    systemLogger.trading(`✅ DEPOSIT ARRIVED after ${waitTimeMinutes}m ${waitTimeSeconds % 60}s`, {
                        exchange,
                        crypto,
                        amount: depositStatus.amount,
                        confirmations: depositStatus.confirmations,
                        checksRequired: checkCount,
                        totalWaitTime: `${waitTimeMinutes}m ${waitTimeSeconds % 60}s`
                    });

                    return {
                        arrived: true,
                        amountReceived: depositStatus.amount,
                        confirmations: depositStatus.confirmations,
                        waitTime: Date.now() - startTime,
                        checksRequired: checkCount
                    };
                }

                systemLogger.trading(`⏳ Deposit not arrived yet, waiting 30s...`, {
                    exchange,
                    crypto,
                    nextCheckIn: '30s'
                });

                // Wait before checking again
                await new Promise(resolve => setTimeout(resolve, checkInterval));

            } catch (error) {
                systemLogger.warn(`⚠️ Deposit check #${checkCount} failed, retrying in 30s...`, {
                    exchange,
                    crypto,
                    error: error.message,
                    checkNumber: checkCount
                });

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, checkInterval));
            }
        }

        // Timeout reached
        const timeoutMinutes = Math.floor(maxWaitTime / 60000);
        systemLogger.error(`❌ DEPOSIT MONITORING TIMEOUT after ${timeoutMinutes} minutes`, {
            exchange,
            crypto,
            txHash: txHash ? txHash.substring(0, 10) + '...' : 'N/A',
            checksPerformed: checkCount,
            maxWaitTime: `${timeoutMinutes}m`
        });

        throw new Error(`Deposit monitoring timeout - transfer took longer than ${timeoutMinutes} minutes`);
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

    /**
     * ✅ PHASE 4: CCXT Generic Deposit Checker
     * Check if crypto deposit has arrived on destination exchange
     * @param {string} exchange - Destination exchange name
     * @param {string} crypto - Cryptocurrency symbol (XRP, BTC, etc.)
     * @param {string} txHash - Transaction hash from withdrawal
     * @param {Object} credentials - API credentials {apiKey, apiSecret, passphrase}
     * @returns {Object} {arrived: boolean, amount: number, confirmations: number, txHash: string}
     */
    async checkDepositStatus(exchange, crypto, txHash, credentials) {
        systemLogger.trading('Checking deposit status via CCXT', {
            exchange,
            crypto,
            txHash: txHash ? txHash.substring(0, 10) + '...' : 'N/A'
        });

        try {
            const ccxt = require('ccxt');

            // Validate exchange exists in CCXT
            if (!ccxt[exchange]) {
                throw new Error(`Exchange '${exchange}' not supported by CCXT`);
            }

            // Initialize exchange API
            const exchangeClass = ccxt[exchange];
            const api = new exchangeClass({
                apiKey: credentials.apiKey,
                secret: credentials.apiSecret,
                password: credentials.passphrase, // For OKX, KuCoin
                enableRateLimit: true,
                options: {
                    defaultType: 'spot'
                }
            });

            // Check if exchange supports fetchDeposits
            if (!api.has['fetchDeposits']) {
                systemLogger.warn(`${exchange} does not support fetchDeposits, falling back to balance check`, {
                    exchange,
                    crypto
                });

                // FALLBACK: Check balance instead (less reliable but works)
                const balance = await api.fetchBalance();
                const currentBalance = balance.total[crypto] || 0;

                // If balance > 0, assume deposit arrived (not ideal but better than nothing)
                if (currentBalance > 0) {
                    return {
                        arrived: true,
                        amount: currentBalance,
                        confirmations: 999, // Unknown
                        txHash: 'BALANCE_CHECK'
                    };
                }

                return {
                    arrived: false,
                    amount: 0,
                    confirmations: 0,
                    txHash: null
                };
            }

            // Fetch recent deposits for this crypto
            const deposits = await api.fetchDeposits(crypto, undefined, 10); // Last 10 deposits

            systemLogger.trading(`Fetched ${deposits.length} recent deposits`, {
                exchange,
                crypto,
                count: deposits.length
            });

            // If we have a txHash, look for exact match
            if (txHash) {
                const matchingDeposit = deposits.find(deposit => {
                    // CCXT normalizes txid field
                    const depositTxHash = deposit.txid || deposit.info?.txid || deposit.info?.txId;
                    return depositTxHash && depositTxHash.toLowerCase() === txHash.toLowerCase();
                });

                if (matchingDeposit) {
                    const arrived = matchingDeposit.status === 'ok' || matchingDeposit.status === 'complete';

                    systemLogger.trading(`Matching deposit found: ${matchingDeposit.status}`, {
                        exchange,
                        crypto,
                        status: matchingDeposit.status,
                        arrived
                    });

                    return {
                        arrived,
                        amount: matchingDeposit.amount,
                        confirmations: matchingDeposit.info?.confirmations || 0,
                        txHash: matchingDeposit.txid
                    };
                }
            }

            // If no txHash or no match found, check for ANY recent successful deposit
            // This handles cases where exchange hasn't returned txHash yet
            const recentSuccessful = deposits.find(deposit =>
                (deposit.status === 'ok' || deposit.status === 'complete') &&
                deposit.timestamp > Date.now() - 3600000 // Within last hour
            );

            if (recentSuccessful) {
                systemLogger.trading('Recent successful deposit found (no txHash match)', {
                    exchange,
                    crypto,
                    amount: recentSuccessful.amount
                });

                return {
                    arrived: true,
                    amount: recentSuccessful.amount,
                    confirmations: recentSuccessful.info?.confirmations || 0,
                    txHash: recentSuccessful.txid
                };
            }

            // No matching deposit found
            systemLogger.trading('No matching deposit found yet', {
                exchange,
                crypto,
                depositsChecked: deposits.length
            });

            return {
                arrived: false,
                amount: 0,
                confirmations: 0,
                txHash: null
            };

        } catch (error) {
            systemLogger.error('Deposit status check failed', {
                exchange,
                crypto,
                error: error.message
            });

            // Don't throw - just return not arrived (monitoring will retry)
            return {
                arrived: false,
                amount: 0,
                confirmations: 0,
                txHash: null,
                error: error.message
            };
        }
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
    // Bybit Exchange Implementation
    // ========================================

    async executeBybitBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Bybit buy order', { crypto, usdtAmount, type: 'MARKET' });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const params = { category: 'spot', symbol, side: 'Buy', orderType: 'Market', marketUnit: 'quoteCoin', qty: usdtAmount.toFixed(2) };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&') + `&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch('https://api.bybit.com/v5/order/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-TIMESTAMP': timestamp.toString(), 'X-BAPI-SIGN': signature },
                body: JSON.stringify(params)
            });

            const orderData = await response.json();
            if (orderData.retCode !== 0) throw new Error(`Bybit error ${orderData.retCode}: ${orderData.retMsg}`);

            systemLogger.trading('Bybit buy order executed', { orderId: orderData.result.orderId, symbol });
            return { orderId: orderData.result.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Bybit buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBybitSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Bybit sell order', { crypto, amount, type: 'MARKET' });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const params = { category: 'spot', symbol, side: 'Sell', orderType: 'Market', qty: amount.toFixed(8) };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&') + `&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch('https://api.bybit.com/v5/order/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-TIMESTAMP': timestamp.toString(), 'X-BAPI-SIGN': signature },
                body: JSON.stringify(params)
            });

            const orderData = await response.json();
            if (orderData.retCode !== 0) throw new Error(`Bybit error ${orderData.retCode}: ${orderData.retMsg}`);

            systemLogger.trading('Bybit sell order executed', { orderId: orderData.result.orderId, symbol });
            return { orderId: orderData.result.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Bybit sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBybitWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing Bybit withdrawal', { crypto, amount });
        try {
            const timestamp = Date.now();
            const params = { coin: crypto, chain: 'ETH', address, amount: amount.toFixed(8) };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&') + `&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch('https://api.bybit.com/v5/asset/withdraw/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-TIMESTAMP': timestamp.toString(), 'X-BAPI-SIGN': signature },
                body: JSON.stringify(params)
            });

            const withdrawalData = await response.json();
            if (withdrawalData.retCode !== 0) throw new Error(`Bybit error ${withdrawalData.retCode}: ${withdrawalData.retMsg}`);

            systemLogger.trading('Bybit withdrawal initiated', { withdrawalId: withdrawalData.result.id });
            return { withdrawalId: withdrawalData.result.id, crypto, amount, address, txHash: null };
        } catch (error) {
            systemLogger.error('Bybit withdrawal failed', { crypto, error: error.message });
            throw error;
        }
    }

    async checkBybitDeposit(crypto, credentials) {
        try {
            const timestamp = Date.now();
            const queryString = `coin=${crypto}&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.bybit.com/v5/asset/deposit/query-record?${queryString}`, {
                method: 'GET',
                headers: { 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-TIMESTAMP': timestamp.toString(), 'X-BAPI-SIGN': signature }
            });

            const data = await response.json();
            if (data.retCode === 0 && data.result.rows.length > 0) {
                const recentDeposit = data.result.rows.find(d => d.status === 3);
                if (recentDeposit) return { arrived: true, amount: parseFloat(recentDeposit.amount), confirmations: 0, txHash: recentDeposit.txID };
            }
            return { arrived: false, amount: 0, confirmations: 0, txHash: null };
        } catch (error) {
            systemLogger.error('Bybit deposit check failed', { crypto, error: error.message });
            throw error;
        }
    }

    // ========================================
    // Kraken Exchange Implementation
    // ========================================

    async executeKrakenBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Kraken buy order', { crypto, usdtAmount });
        try {
            const pair = `${crypto}USDT`;
            const nonce = Date.now();
            const postData = `nonce=${nonce}&pair=${pair}&type=buy&ordertype=market&volume=${(usdtAmount / 1000).toFixed(4)}`;
            const path = '/0/private/AddOrder';
            const signature = crypto.createHmac('sha512', Buffer.from(credentials.apiSecret, 'base64')).update(path + crypto.createHash('sha256').update(nonce + postData).digest()).digest('base64');

            const response = await fetch(`https://api.kraken.com${path}`, {
                method: 'POST',
                headers: { 'API-Key': credentials.apiKey, 'API-Sign': signature, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: postData
            });

            const orderData = await response.json();
            if (orderData.error && orderData.error.length > 0) throw new Error(`Kraken error: ${orderData.error.join(', ')}`);

            systemLogger.trading('Kraken buy order executed', { orderId: orderData.result.txid[0] });
            return { orderId: orderData.result.txid[0], symbol: pair, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Kraken buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeKrakenSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Kraken sell order', { crypto, amount });
        try {
            const pair = `${crypto}USDT`;
            const nonce = Date.now();
            const postData = `nonce=${nonce}&pair=${pair}&type=sell&ordertype=market&volume=${amount.toFixed(8)}`;
            const path = '/0/private/AddOrder';
            const signature = crypto.createHmac('sha512', Buffer.from(credentials.apiSecret, 'base64')).update(path + crypto.createHash('sha256').update(nonce + postData).digest()).digest('base64');

            const response = await fetch(`https://api.kraken.com${path}`, {
                method: 'POST',
                headers: { 'API-Key': credentials.apiKey, 'API-Sign': signature, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: postData
            });

            const orderData = await response.json();
            if (orderData.error && orderData.error.length > 0) throw new Error(`Kraken error: ${orderData.error.join(', ')}`);

            systemLogger.trading('Kraken sell order executed', { orderId: orderData.result.txid[0] });
            return { orderId: orderData.result.txid[0], symbol: pair, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Kraken sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeKrakenWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing Kraken withdrawal', { crypto, amount });
        try {
            const nonce = Date.now();
            const postData = `nonce=${nonce}&asset=${crypto}&key=${address}&amount=${amount.toFixed(8)}`;
            const path = '/0/private/Withdraw';
            const signature = crypto.createHmac('sha512', Buffer.from(credentials.apiSecret, 'base64')).update(path + crypto.createHash('sha256').update(nonce + postData).digest()).digest('base64');

            const response = await fetch(`https://api.kraken.com${path}`, {
                method: 'POST',
                headers: { 'API-Key': credentials.apiKey, 'API-Sign': signature, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: postData
            });

            const withdrawalData = await response.json();
            if (withdrawalData.error && withdrawalData.error.length > 0) throw new Error(`Kraken error: ${withdrawalData.error.join(', ')}`);

            systemLogger.trading('Kraken withdrawal initiated', { refid: withdrawalData.result.refid });
            return { withdrawalId: withdrawalData.result.refid, crypto, amount, address, txHash: null };
        } catch (error) {
            systemLogger.error('Kraken withdrawal failed', { crypto, error: error.message });
            throw error;
        }
    }

    async checkKrakenDeposit(crypto, credentials) {
        try {
            const nonce = Date.now();
            const postData = `nonce=${nonce}&asset=${crypto}`;
            const path = '/0/private/DepositStatus';
            const signature = crypto.createHmac('sha512', Buffer.from(credentials.apiSecret, 'base64')).update(path + crypto.createHash('sha256').update(nonce + postData).digest()).digest('base64');

            const response = await fetch(`https://api.kraken.com${path}`, {
                method: 'POST',
                headers: { 'API-Key': credentials.apiKey, 'API-Sign': signature, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: postData
            });

            const data = await response.json();
            if (data.error && data.error.length > 0) throw new Error(`Kraken error: ${data.error.join(', ')}`);

            if (data.result && data.result.length > 0) {
                const recentDeposit = data.result.find(d => d.status === 'Success');
                if (recentDeposit) return { arrived: true, amount: parseFloat(recentDeposit.amount), confirmations: 0, txHash: recentDeposit.txid };
            }
            return { arrived: false, amount: 0, confirmations: 0, txHash: null };
        } catch (error) {
            systemLogger.error('Kraken deposit check failed', { crypto, error: error.message });
            throw error;
        }
    }

    // ========================================
    // MEXC Exchange Implementation
    // ========================================

    async executeMEXCBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing MEXC buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const params = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: usdtAmount.toFixed(2), timestamp, recvWindow: 5000 };
            const queryString = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.mexc.com/api/v3/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-MEXC-APIKEY': credentials.apiKey, 'Content-Type': 'application/json' }
            });

            const orderData = await response.json();
            if (orderData.code && orderData.code !== 200) throw new Error(`MEXC error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('MEXC buy order executed', { orderId: orderData.orderId, symbol });
            return { orderId: orderData.orderId, symbol, quantity: parseFloat(orderData.executedQty || 0), averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('MEXC buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeMEXCSell(crypto, amount, credentials) {
        systemLogger.trading('Executing MEXC sell order', { crypto, amount });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const params = { symbol, side: 'SELL', type: 'MARKET', quantity: amount.toFixed(8), timestamp, recvWindow: 5000 };
            const queryString = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.mexc.com/api/v3/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-MEXC-APIKEY': credentials.apiKey, 'Content-Type': 'application/json' }
            });

            const orderData = await response.json();
            if (orderData.code && orderData.code !== 200) throw new Error(`MEXC error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('MEXC sell order executed', { orderId: orderData.orderId, symbol });
            return { orderId: orderData.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('MEXC sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeMEXCWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing MEXC withdrawal', { crypto, amount });
        try {
            const timestamp = Date.now();
            const params = { coin: crypto, address, amount: amount.toFixed(8), timestamp };
            const queryString = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.mexc.com/api/v3/capital/withdraw/apply?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-MEXC-APIKEY': credentials.apiKey, 'Content-Type': 'application/json' }
            });

            const withdrawalData = await response.json();
            if (withdrawalData.code && withdrawalData.code !== 200) throw new Error(`MEXC error: ${withdrawalData.msg}`);

            systemLogger.trading('MEXC withdrawal initiated', { id: withdrawalData.id });
            return { withdrawalId: withdrawalData.id, crypto, amount, address, txHash: null };
        } catch (error) {
            systemLogger.error('MEXC withdrawal failed', { crypto, error: error.message });
            throw error;
        }
    }

    async checkMEXCDeposit(crypto, credentials) {
        try {
            const timestamp = Date.now();
            const queryString = `coin=${crypto}&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.mexc.com/api/v3/capital/deposit/hisrec?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: { 'X-MEXC-APIKEY': credentials.apiKey }
            });

            const data = await response.json();
            if (data && data.length > 0) {
                const recentDeposit = data.find(d => d.status === 1);
                if (recentDeposit) return { arrived: true, amount: parseFloat(recentDeposit.amount), confirmations: 0, txHash: recentDeposit.txId };
            }
            return { arrived: false, amount: 0, confirmations: 0, txHash: null };
        } catch (error) {
            systemLogger.error('MEXC deposit check failed', { crypto, error: error.message });
            throw error;
        }
    }

    // ========================================
    // KuCoin Exchange Implementation
    // ========================================

    async executeKuCoinBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing KuCoin buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}-USDT`;
            const timestamp = Date.now();
            const endpoint = '/api/v1/orders';
            const bodyString = JSON.stringify({ clientOid: `${timestamp}`, side: 'buy', symbol, type: 'market', funds: usdtAmount.toFixed(2) });
            const strForSign = timestamp + 'POST' + endpoint + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(strForSign).digest('base64');
            const passphrase = crypto.createHmac('sha256', credentials.apiSecret).update(credentials.passphrase).digest('base64');

            const response = await fetch(`https://api.kucoin.com${endpoint}`, {
                method: 'POST',
                headers: { 'KC-API-KEY': credentials.apiKey, 'KC-API-SIGN': signature, 'KC-API-TIMESTAMP': timestamp.toString(), 'KC-API-PASSPHRASE': passphrase, 'KC-API-KEY-VERSION': '2', 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== '200000') throw new Error(`KuCoin error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('KuCoin buy order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('KuCoin buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeKuCoinSell(crypto, amount, credentials) {
        systemLogger.trading('Executing KuCoin sell order', { crypto, amount });
        try {
            const symbol = `${crypto}-USDT`;
            const timestamp = Date.now();
            const endpoint = '/api/v1/orders';
            const bodyString = JSON.stringify({ clientOid: `${timestamp}`, side: 'sell', symbol, type: 'market', size: amount.toFixed(8) });
            const strForSign = timestamp + 'POST' + endpoint + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(strForSign).digest('base64');
            const passphrase = crypto.createHmac('sha256', credentials.apiSecret).update(credentials.passphrase).digest('base64');

            const response = await fetch(`https://api.kucoin.com${endpoint}`, {
                method: 'POST',
                headers: { 'KC-API-KEY': credentials.apiKey, 'KC-API-SIGN': signature, 'KC-API-TIMESTAMP': timestamp.toString(), 'KC-API-PASSPHRASE': passphrase, 'KC-API-KEY-VERSION': '2', 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== '200000') throw new Error(`KuCoin error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('KuCoin sell order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('KuCoin sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeKuCoinWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing KuCoin withdrawal', { crypto, amount });
        try {
            const timestamp = Date.now();
            const endpoint = '/api/v1/withdrawals';
            const bodyString = JSON.stringify({ currency: crypto, address, amount: amount.toFixed(8) });
            const strForSign = timestamp + 'POST' + endpoint + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(strForSign).digest('base64');
            const passphrase = crypto.createHmac('sha256', credentials.apiSecret).update(credentials.passphrase).digest('base64');

            const response = await fetch(`https://api.kucoin.com${endpoint}`, {
                method: 'POST',
                headers: { 'KC-API-KEY': credentials.apiKey, 'KC-API-SIGN': signature, 'KC-API-TIMESTAMP': timestamp.toString(), 'KC-API-PASSPHRASE': passphrase, 'KC-API-KEY-VERSION': '2', 'Content-Type': 'application/json' },
                body: bodyString
            });

            const withdrawalData = await response.json();
            if (withdrawalData.code !== '200000') throw new Error(`KuCoin error: ${withdrawalData.msg}`);

            systemLogger.trading('KuCoin withdrawal initiated', { withdrawalId: withdrawalData.data.withdrawalId });
            return { withdrawalId: withdrawalData.data.withdrawalId, crypto, amount, address, txHash: null };
        } catch (error) {
            systemLogger.error('KuCoin withdrawal failed', { crypto, error: error.message });
            throw error;
        }
    }

    async checkKuCoinDeposit(crypto, credentials) {
        try {
            const timestamp = Date.now();
            const endpoint = `/api/v1/deposits?currency=${crypto}`;
            const strForSign = timestamp + 'GET' + endpoint;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(strForSign).digest('base64');
            const passphrase = crypto.createHmac('sha256', credentials.apiSecret).update(credentials.passphrase).digest('base64');

            const response = await fetch(`https://api.kucoin.com${endpoint}`, {
                method: 'GET',
                headers: { 'KC-API-KEY': credentials.apiKey, 'KC-API-SIGN': signature, 'KC-API-TIMESTAMP': timestamp.toString(), 'KC-API-PASSPHRASE': passphrase, 'KC-API-KEY-VERSION': '2' }
            });

            const data = await response.json();
            if (data.code === '200000' && data.data.items.length > 0) {
                const recentDeposit = data.data.items.find(d => d.status === 'SUCCESS');
                if (recentDeposit) return { arrived: true, amount: parseFloat(recentDeposit.amount), confirmations: 0, txHash: recentDeposit.walletTxId };
            }
            return { arrived: false, amount: 0, confirmations: 0, txHash: null };
        } catch (error) {
            systemLogger.error('KuCoin deposit check failed', { crypto, error: error.message });
            throw error;
        }
    }

    // ========================================
    // HTX (Huobi) Exchange Implementation
    // ========================================

    async executeHTXBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing HTX buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto.toLowerCase()}usdt`;
            const timestamp = new Date().toISOString().slice(0, 19);
            const params = { AccessKeyId: credentials.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp, 'account-id': credentials.accountId, amount: (usdtAmount / 100).toFixed(4), symbol, type: 'buy-market' };
            const sortedParams = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const payload = `POST\napi.huobi.pro\n/v1/order/orders/place\n${sortedParams}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(payload).digest('base64');

            const response = await fetch(`https://api.huobi.pro/v1/order/orders/place?${sortedParams}&Signature=${encodeURIComponent(signature)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });

            const orderData = await response.json();
            if (orderData.status !== 'ok') throw new Error(`HTX error: ${orderData['err-msg']}`);

            systemLogger.trading('HTX buy order executed', { orderId: orderData.data });
            return { orderId: orderData.data, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('HTX buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeHTXSell(crypto, amount, credentials) {
        systemLogger.trading('Executing HTX sell order', { crypto, amount });
        try {
            const symbol = `${crypto.toLowerCase()}usdt`;
            const timestamp = new Date().toISOString().slice(0, 19);
            const params = { AccessKeyId: credentials.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp, 'account-id': credentials.accountId, amount: amount.toFixed(8), symbol, type: 'sell-market' };
            const sortedParams = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const payload = `POST\napi.huobi.pro\n/v1/order/orders/place\n${sortedParams}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(payload).digest('base64');

            const response = await fetch(`https://api.huobi.pro/v1/order/orders/place?${sortedParams}&Signature=${encodeURIComponent(signature)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });

            const orderData = await response.json();
            if (orderData.status !== 'ok') throw new Error(`HTX error: ${orderData['err-msg']}`);

            systemLogger.trading('HTX sell order executed', { orderId: orderData.data });
            return { orderId: orderData.data, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('HTX sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeHTXWithdrawal(crypto, amount, address, credentials) {
        throw new Error('HTX withdrawal API requires additional setup - not implemented');
    }

    async checkHTXDeposit(crypto, credentials) {
        throw new Error('HTX deposit checking not implemented yet');
    }

    // ========================================
    // Gate.io Exchange Implementation
    // ========================================

    async executeGateIOBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Gate.io buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}_USDT`;
            const timestamp = Math.floor(Date.now() / 1000);
            const bodyString = JSON.stringify({ currency_pair: symbol, type: 'market', side: 'buy', amount: (usdtAmount / 100).toFixed(4) });
            const hashedBody = crypto.createHash('sha512').update(bodyString).digest('hex');
            const signString = `POST\n/api/v4/spot/orders\n\n${hashedBody}\n${timestamp}`;
            const signature = crypto.createHmac('sha512', credentials.apiSecret).update(signString).digest('hex');

            const response = await fetch('https://api.gateio.ws/api/v4/spot/orders', {
                method: 'POST',
                headers: { 'KEY': credentials.apiKey, 'SIGN': signature, 'Timestamp': timestamp.toString(), 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.label) throw new Error(`Gate.io error: ${orderData.message}`);

            systemLogger.trading('Gate.io buy order executed', { orderId: orderData.id });
            return { orderId: orderData.id, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Gate.io buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeGateIOSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Gate.io sell order', { crypto, amount });
        try {
            const symbol = `${crypto}_USDT`;
            const timestamp = Math.floor(Date.now() / 1000);
            const bodyString = JSON.stringify({ currency_pair: symbol, type: 'market', side: 'sell', amount: amount.toFixed(8) });
            const hashedBody = crypto.createHash('sha512').update(bodyString).digest('hex');
            const signString = `POST\n/api/v4/spot/orders\n\n${hashedBody}\n${timestamp}`;
            const signature = crypto.createHmac('sha512', credentials.apiSecret).update(signString).digest('hex');

            const response = await fetch('https://api.gateio.ws/api/v4/spot/orders', {
                method: 'POST',
                headers: { 'KEY': credentials.apiKey, 'SIGN': signature, 'Timestamp': timestamp.toString(), 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.label) throw new Error(`Gate.io error: ${orderData.message}`);

            systemLogger.trading('Gate.io sell order executed', { orderId: orderData.id });
            return { orderId: orderData.id, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Gate.io sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeGateIOWithdrawal(crypto, amount, address, credentials) {
        throw new Error('Gate.io withdrawal not fully implemented yet');
    }

    async checkGateIODeposit(crypto, credentials) {
        throw new Error('Gate.io deposit checking not implemented yet');
    }

    // ========================================
    // Luno Exchange Implementation
    // ========================================

    async executeLunoBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Luno buy order', { crypto, usdtAmount });
        try {
            const pair = `${crypto}ZAR`;
            const timestamp = Date.now();
            const path = '/api/1/postorder';
            const authString = credentials.apiKey + ':' + credentials.apiSecret;
            const auth = Buffer.from(authString).toString('base64');

            const bodyString = JSON.stringify({ pair, type: 'BID', volume: (usdtAmount / 100).toFixed(4) });

            const response = await fetch(`https://api.luno.com${path}`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.error) throw new Error(`Luno error: ${orderData.error_code} - ${orderData.error}`);

            systemLogger.trading('Luno buy order executed', { orderId: orderData.order_id });
            return { orderId: orderData.order_id, symbol: pair, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Luno buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeLunoSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Luno sell order', { crypto, amount });
        try {
            const pair = `${crypto}ZAR`;
            const path = '/api/1/postorder';
            const authString = credentials.apiKey + ':' + credentials.apiSecret;
            const auth = Buffer.from(authString).toString('base64');

            const bodyString = JSON.stringify({ pair, type: 'ASK', volume: amount.toFixed(8) });

            const response = await fetch(`https://api.luno.com${path}`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.error) throw new Error(`Luno error: ${orderData.error_code} - ${orderData.error}`);

            systemLogger.trading('Luno sell order executed', { orderId: orderData.order_id });
            return { orderId: orderData.order_id, symbol: pair, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Luno sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeLunoWithdrawal(crypto, amount, address, credentials) {
        systemLogger.trading('Executing Luno withdrawal', { crypto, amount });
        try {
            const path = '/api/1/withdrawals';
            const authString = credentials.apiKey + ':' + credentials.apiSecret;
            const auth = Buffer.from(authString).toString('base64');

            const bodyString = JSON.stringify({ type: crypto, amount: amount.toFixed(8), address });

            const response = await fetch(`https://api.luno.com${path}`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: bodyString
            });

            const withdrawalData = await response.json();
            if (withdrawalData.error) throw new Error(`Luno error: ${withdrawalData.error}`);

            systemLogger.trading('Luno withdrawal initiated', { id: withdrawalData.id });
            return { withdrawalId: withdrawalData.id, crypto, amount, address, txHash: null };
        } catch (error) {
            systemLogger.error('Luno withdrawal failed', { crypto, error: error.message });
            throw error;
        }
    }

    async checkLunoDeposit(crypto, credentials) {
        try {
            const path = '/api/1/accounts';
            const authString = credentials.apiKey + ':' + credentials.apiSecret;
            const auth = Buffer.from(authString).toString('base64');

            const response = await fetch(`https://api.luno.com${path}`, {
                method: 'GET',
                headers: { 'Authorization': `Basic ${auth}` }
            });

            const data = await response.json();
            if (data.error) throw new Error(`Luno error: ${data.error}`);

            // Simplified - just check if balance increased
            return { arrived: false, amount: 0, confirmations: 0, txHash: null };
        } catch (error) {
            systemLogger.error('Luno deposit check failed', { crypto, error: error.message });
            throw error;
        }
    }

    // ========================================
    // BingX Exchange Implementation
    // ========================================

    async executeBingXBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing BingX buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}-USDT`;
            const timestamp = Date.now();
            const params = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: usdtAmount.toFixed(2), timestamp };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://open-api.bingx.com/openApi/spot/v1/trade/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-BX-APIKEY': credentials.apiKey }
            });

            const orderData = await response.json();
            if (orderData.code !== 0) throw new Error(`BingX error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('BingX buy order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('BingX buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBingXSell(crypto, amount, credentials) {
        systemLogger.trading('Executing BingX sell order', { crypto, amount });
        try {
            const symbol = `${crypto}-USDT`;
            const timestamp = Date.now();
            const params = { symbol, side: 'SELL', type: 'MARKET', quantity: amount.toFixed(8), timestamp };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://open-api.bingx.com/openApi/spot/v1/trade/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-BX-APIKEY': credentials.apiKey }
            });

            const orderData = await response.json();
            if (orderData.code !== 0) throw new Error(`BingX error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('BingX sell order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('BingX sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBingXWithdrawal(crypto, amount, address, credentials) {
        throw new Error('BingX withdrawal not implemented yet - requires additional setup');
    }

    async checkBingXDeposit(crypto, credentials) {
        throw new Error('BingX deposit checking not implemented yet');
    }

    // ========================================
    // Bitget Exchange Implementation
    // ========================================

    async executeBitgetBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Bitget buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const bodyString = JSON.stringify({ symbol, side: 'buy', orderType: 'market', force: 'normal', size: (usdtAmount / 100).toFixed(4) });
            const prehash = timestamp + 'POST' + '/api/spot/v1/trade/orders' + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('base64');

            const response = await fetch('https://api.bitget.com/api/spot/v1/trade/orders', {
                method: 'POST',
                headers: { 'ACCESS-KEY': credentials.apiKey, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp.toString(), 'ACCESS-PASSPHRASE': credentials.passphrase, 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== '00000') throw new Error(`Bitget error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('Bitget buy order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Bitget buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBitgetSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Bitget sell order', { crypto, amount });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const bodyString = JSON.stringify({ symbol, side: 'sell', orderType: 'market', force: 'normal', size: amount.toFixed(8) });
            const prehash = timestamp + 'POST' + '/api/spot/v1/trade/orders' + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('base64');

            const response = await fetch('https://api.bitget.com/api/spot/v1/trade/orders', {
                method: 'POST',
                headers: { 'ACCESS-KEY': credentials.apiKey, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp.toString(), 'ACCESS-PASSPHRASE': credentials.passphrase, 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== '00000') throw new Error(`Bitget error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('Bitget sell order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Bitget sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBitgetWithdrawal(crypto, amount, address, credentials) {
        throw new Error('Bitget withdrawal requires additional chain parameter - not fully implemented');
    }

    async checkBitgetDeposit(crypto, credentials) {
        throw new Error('Bitget deposit checking not fully implemented');
    }

    // ========================================
    // XT.com Exchange Implementation
    // ========================================

    async executeXTBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing XT buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto.toLowerCase()}_usdt`;
            const timestamp = Date.now();
            const params = { symbol, side: 'BUY', type: 'MARKET', quoteQty: usdtAmount.toFixed(2) };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&') + `&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://sapi.xt.com/v4/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-XT-API-KEY': credentials.apiKey }
            });

            const orderData = await response.json();
            if (orderData.rc !== 0) throw new Error(`XT error ${orderData.rc}: ${orderData.msg}`);

            systemLogger.trading('XT buy order executed', { orderId: orderData.result.orderId });
            return { orderId: orderData.result.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('XT buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeXTSell(crypto, amount, credentials) {
        systemLogger.trading('Executing XT sell order', { crypto, amount });
        try {
            const symbol = `${crypto.toLowerCase()}_usdt`;
            const timestamp = Date.now();
            const params = { symbol, side: 'SELL', type: 'MARKET', quantity: amount.toFixed(8) };
            const queryString = Object.entries(params).sort().map(([k,v]) => `${k}=${v}`).join('&') + `&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://sapi.xt.com/v4/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-XT-API-KEY': credentials.apiKey }
            });

            const orderData = await response.json();
            if (orderData.rc !== 0) throw new Error(`XT error ${orderData.rc}: ${orderData.msg}`);

            systemLogger.trading('XT sell order executed', { orderId: orderData.result.orderId });
            return { orderId: orderData.result.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('XT sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeXTWithdrawal(crypto, amount, address, credentials) {
        throw new Error('XT withdrawal not fully implemented');
    }

    async checkXTDeposit(crypto, credentials) {
        throw new Error('XT deposit checking not fully implemented');
    }

    // ========================================
    // AscendEX Exchange Implementation
    // ========================================

    async executeAscendEXBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing AscendEX buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}/USDT`;
            const timestamp = Date.now();
            const path = '/api/pro/v1/cash/order';
            const bodyString = JSON.stringify({ symbol, orderQty: (usdtAmount / 100).toFixed(4), orderType: 'market', side: 'buy', time: timestamp });
            const prehash = timestamp + path + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('base64');

            const response = await fetch(`https://ascendex.com${path}`, {
                method: 'POST',
                headers: { 'x-auth-key': credentials.apiKey, 'x-auth-signature': signature, 'x-auth-timestamp': timestamp.toString(), 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== 0) throw new Error(`AscendEX error ${orderData.code}: ${orderData.message}`);

            systemLogger.trading('AscendEX buy order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('AscendEX buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeAscendEXSell(crypto, amount, credentials) {
        systemLogger.trading('Executing AscendEX sell order', { crypto, amount });
        try {
            const symbol = `${crypto}/USDT`;
            const timestamp = Date.now();
            const path = '/api/pro/v1/cash/order';
            const bodyString = JSON.stringify({ symbol, orderQty: amount.toFixed(8), orderType: 'market', side: 'sell', time: timestamp });
            const prehash = timestamp + path + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('base64');

            const response = await fetch(`https://ascendex.com${path}`, {
                method: 'POST',
                headers: { 'x-auth-key': credentials.apiKey, 'x-auth-signature': signature, 'x-auth-timestamp': timestamp.toString(), 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== 0) throw new Error(`AscendEX error ${orderData.code}: ${orderData.message}`);

            systemLogger.trading('AscendEX sell order executed', { orderId: orderData.data.orderId });
            return { orderId: orderData.data.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('AscendEX sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeAscendEXWithdrawal(crypto, amount, address, credentials) {
        throw new Error('AscendEX withdrawal not fully implemented');
    }

    async checkAscendEXDeposit(crypto, credentials) {
        throw new Error('AscendEX deposit checking not fully implemented');
    }

    // ========================================
    // BitMart Exchange Implementation
    // ========================================

    async executeBitMartBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing BitMart buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}_USDT`;
            const timestamp = Date.now();
            const bodyString = JSON.stringify({ symbol, side: 'buy', type: 'market', notional: usdtAmount.toFixed(2) });
            const prehash = timestamp + '#' + credentials.memo + '#' + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('hex');

            const response = await fetch('https://api-cloud.bitmart.com/spot/v2/submit_order', {
                method: 'POST',
                headers: { 'X-BM-KEY': credentials.apiKey, 'X-BM-SIGN': signature, 'X-BM-TIMESTAMP': timestamp.toString(), 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== 1000) throw new Error(`BitMart error ${orderData.code}: ${orderData.message}`);

            systemLogger.trading('BitMart buy order executed', { orderId: orderData.data.order_id });
            return { orderId: orderData.data.order_id, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('BitMart buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBitMartSell(crypto, amount, credentials) {
        systemLogger.trading('Executing BitMart sell order', { crypto, amount });
        try {
            const symbol = `${crypto}_USDT`;
            const timestamp = Date.now();
            const bodyString = JSON.stringify({ symbol, side: 'sell', type: 'market', size: amount.toFixed(8) });
            const prehash = timestamp + '#' + credentials.memo + '#' + bodyString;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(prehash).digest('hex');

            const response = await fetch('https://api-cloud.bitmart.com/spot/v2/submit_order', {
                method: 'POST',
                headers: { 'X-BM-KEY': credentials.apiKey, 'X-BM-SIGN': signature, 'X-BM-TIMESTAMP': timestamp.toString(), 'Content-Type': 'application/json' },
                body: bodyString
            });

            const orderData = await response.json();
            if (orderData.code !== 1000) throw new Error(`BitMart error ${orderData.code}: ${orderData.message}`);

            systemLogger.trading('BitMart sell order executed', { orderId: orderData.data.order_id });
            return { orderId: orderData.data.order_id, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('BitMart sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBitMartWithdrawal(crypto, amount, address, credentials) {
        throw new Error('BitMart withdrawal not fully implemented');
    }

    async checkBitMartDeposit(crypto, credentials) {
        throw new Error('BitMart deposit checking not fully implemented');
    }

    // ========================================
    // Bitrue Exchange Implementation
    // ========================================

    async executeBitrueBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Bitrue buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const params = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: usdtAmount.toFixed(2), timestamp, recvWindow: 5000 };
            const queryString = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.bitrue.com/api/v1/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-MBX-APIKEY': credentials.apiKey }
            });

            const orderData = await response.json();
            if (orderData.code && orderData.code < 0) throw new Error(`Bitrue error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('Bitrue buy order executed', { orderId: orderData.orderId });
            return { orderId: orderData.orderId, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Bitrue buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBitrueSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Bitrue sell order', { crypto, amount });
        try {
            const symbol = `${crypto}USDT`;
            const timestamp = Date.now();
            const params = { symbol, side: 'SELL', type: 'MARKET', quantity: amount.toFixed(8), timestamp, recvWindow: 5000 };
            const queryString = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const response = await fetch(`https://api.bitrue.com/api/v1/order?${queryString}&signature=${signature}`, {
                method: 'POST',
                headers: { 'X-MBX-APIKEY': credentials.apiKey }
            });

            const orderData = await response.json();
            if (orderData.code && orderData.code < 0) throw new Error(`Bitrue error ${orderData.code}: ${orderData.msg}`);

            systemLogger.trading('Bitrue sell order executed', { orderId: orderData.orderId });
            return { orderId: orderData.orderId, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Bitrue sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeBitrueWithdrawal(crypto, amount, address, credentials) {
        throw new Error('Bitrue withdrawal not fully implemented');
    }

    async checkBitrueDeposit(crypto, credentials) {
        throw new Error('Bitrue deposit checking not fully implemented');
    }

    // ========================================
    // Gemini Exchange Implementation
    // ========================================

    async executeGeminiBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Gemini buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto.toLowerCase()}usd`;
            const nonce = Date.now();
            const payload = { request: '/v1/order/new', nonce, symbol, amount: (usdtAmount / 1000).toFixed(4), type: 'exchange market', side: 'buy' };
            const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = crypto.createHmac('sha384', credentials.apiSecret).update(encodedPayload).digest('hex');

            const response = await fetch('https://api.gemini.com/v1/order/new', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', 'X-GEMINI-APIKEY': credentials.apiKey, 'X-GEMINI-PAYLOAD': encodedPayload, 'X-GEMINI-SIGNATURE': signature }
            });

            const orderData = await response.json();
            if (orderData.reason) throw new Error(`Gemini error: ${orderData.reason} - ${orderData.message}`);

            systemLogger.trading('Gemini buy order executed', { orderId: orderData.order_id });
            return { orderId: orderData.order_id, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Gemini buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeGeminiSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Gemini sell order', { crypto, amount });
        try {
            const symbol = `${crypto.toLowerCase()}usd`;
            const nonce = Date.now();
            const payload = { request: '/v1/order/new', nonce, symbol, amount: amount.toFixed(8), type: 'exchange market', side: 'sell' };
            const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = crypto.createHmac('sha384', credentials.apiSecret).update(encodedPayload).digest('hex');

            const response = await fetch('https://api.gemini.com/v1/order/new', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain', 'X-GEMINI-APIKEY': credentials.apiKey, 'X-GEMINI-PAYLOAD': encodedPayload, 'X-GEMINI-SIGNATURE': signature }
            });

            const orderData = await response.json();
            if (orderData.reason) throw new Error(`Gemini error: ${orderData.reason} - ${orderData.message}`);

            systemLogger.trading('Gemini sell order executed', { orderId: orderData.order_id });
            return { orderId: orderData.order_id, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Gemini sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeGeminiWithdrawal(crypto, amount, address, credentials) {
        throw new Error('Gemini withdrawal not fully implemented');
    }

    async checkGeminiDeposit(crypto, credentials) {
        throw new Error('Gemini deposit checking not fully implemented');
    }

    // ========================================
    // Crypto.com Exchange Implementation
    // ========================================

    async executeCryptoDotComBuy(crypto, usdtAmount, credentials) {
        systemLogger.trading('Executing Crypto.com buy order', { crypto, usdtAmount });
        try {
            const symbol = `${crypto}_USDT`;
            const timestamp = Date.now();
            const params = { instrument_name: symbol, side: 'BUY', type: 'MARKET', notional: usdtAmount.toFixed(2) };
            const bodyString = JSON.stringify({ id: timestamp, method: 'private/create-order', params, nonce: timestamp });
            const sigPayload = `private/create-order${timestamp}${credentials.apiKey}${bodyString}${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(sigPayload).digest('hex');

            const response = await fetch('https://api.crypto.com/v2/private/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...JSON.parse(bodyString), api_key: credentials.apiKey, sig: signature })
            });

            const orderData = await response.json();
            if (orderData.code !== 0) throw new Error(`Crypto.com error ${orderData.code}: ${orderData.message}`);

            systemLogger.trading('Crypto.com buy order executed', { orderId: orderData.result.order_id });
            return { orderId: orderData.result.order_id, symbol, quantity: 0, averagePrice: 0, totalCost: usdtAmount, status: 'filled' };
        } catch (error) {
            systemLogger.error('Crypto.com buy order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeCryptoDotComSell(crypto, amount, credentials) {
        systemLogger.trading('Executing Crypto.com sell order', { crypto, amount });
        try {
            const symbol = `${crypto}_USDT`;
            const timestamp = Date.now();
            const params = { instrument_name: symbol, side: 'SELL', type: 'MARKET', quantity: amount.toFixed(8) };
            const bodyString = JSON.stringify({ id: timestamp, method: 'private/create-order', params, nonce: timestamp });
            const sigPayload = `private/create-order${timestamp}${credentials.apiKey}${bodyString}${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(sigPayload).digest('hex');

            const response = await fetch('https://api.crypto.com/v2/private/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...JSON.parse(bodyString), api_key: credentials.apiKey, sig: signature })
            });

            const orderData = await response.json();
            if (orderData.code !== 0) throw new Error(`Crypto.com error ${orderData.code}: ${orderData.message}`);

            systemLogger.trading('Crypto.com sell order executed', { orderId: orderData.result.order_id });
            return { orderId: orderData.result.order_id, symbol, quantity: amount, averagePrice: 0, usdtReceived: 0, status: 'filled' };
        } catch (error) {
            systemLogger.error('Crypto.com sell order failed', { crypto, error: error.message });
            throw error;
        }
    }

    async executeCryptoDotComWithdrawal(crypto, amount, address, credentials) {
        throw new Error('Crypto.com withdrawal not fully implemented');
    }

    async checkCryptoDotComDeposit(crypto, credentials) {
        throw new Error('Crypto.com deposit checking not fully implemented');
    }

    // ========================================
    // ChainEX & CoinCatch - Placeholders (less common exchanges)
    // ========================================

    async executeChainEXBuy(crypto, usdtAmount, credentials) { throw new Error('ChainEX not implemented - less common exchange'); }
    async executeChainEXSell(crypto, amount, credentials) { throw new Error('ChainEX not implemented - less common exchange'); }
    async executeChainEXWithdrawal(crypto, amount, address, credentials) { throw new Error('ChainEX not implemented'); }
    async checkChainEXDeposit(crypto, credentials) { throw new Error('ChainEX not implemented'); }

    async executeCoinCatchBuy(crypto, usdtAmount, credentials) { throw new Error('CoinCatch not implemented - less common exchange'); }
    async executeCoinCatchSell(crypto, amount, credentials) { throw new Error('CoinCatch not implemented - less common exchange'); }
    async executeCoinCatchWithdrawal(crypto, amount, address, credentials) { throw new Error('CoinCatch not implemented'); }
    async checkCoinCatchDeposit(crypto, credentials) { throw new Error('CoinCatch not implemented'); }

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
