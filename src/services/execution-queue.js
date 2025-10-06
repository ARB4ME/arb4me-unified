/**
 * Sequential Execution Queue
 * Manages rate limiting across all exchanges to prevent API bans
 */

class ExecutionQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.lastExecutionTime = {};
        this.rateLimits = {
            global: 100, // ms between any operations
            perExchange: {
                binance: 50,    // 20 req/sec
                bybit: 100,     // 10 req/sec
                kraken: 200,    // 5 req/sec
                okx: 100,       // 10 req/sec
                mexc: 150,      // ~6 req/sec
                kucoin: 100,    // 10 req/sec
                htx: 100,       // 10 req/sec
                bitget: 100,    // 10 req/sec
                gateio: 100,    // 10 req/sec
                gemini: 200,    // 5 req/sec
                valr: 200,      // Conservative for local exchanges
                luno: 200,
                chainex: 200,
                altcointrader: 300
            }
        };
        this.activeTransfers = new Map(); // Track pending transfers
    }

    /**
     * Add task to queue
     * @param {Object} task - Task object with exchange, action, params
     * @param {Number} priority - Higher number = higher priority
     */
    async enqueue(task, priority = 5) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                task,
                priority,
                resolve,
                reject,
                timestamp: Date.now()
            });

            // Sort by priority (highest first)
            this.queue.sort((a, b) => b.priority - a.priority);

            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    /**
     * Process queue sequentially
     */
    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            const { task, resolve, reject } = item;

            try {
                // Check rate limit for this exchange
                await this.waitForRateLimit(task.exchange);

                // Execute the task
                const result = await this.executeTask(task);

                // Update last execution time
                this.lastExecutionTime[task.exchange] = Date.now();

                resolve(result);
            } catch (error) {
                console.error(`❌ Task failed:`, error.message);
                reject(error);
            }

            // Global delay between any operations
            await this.sleep(this.rateLimits.global);
        }

        this.processing = false;
    }

    /**
     * Wait for rate limit compliance
     */
    async waitForRateLimit(exchange) {
        const limit = this.rateLimits.perExchange[exchange] || 200;
        const lastTime = this.lastExecutionTime[exchange] || 0;
        const elapsed = Date.now() - lastTime;

        if (elapsed < limit) {
            const waitTime = limit - elapsed;
            console.log(`⏱️  Rate limit: waiting ${waitTime}ms for ${exchange}`);
            await this.sleep(waitTime);
        }
    }

    /**
     * Execute individual task
     */
    async executeTask(task) {
        const { exchange, action, params } = task;

        console.log(`🔄 Executing: ${action} on ${exchange}`);

        switch (action) {
            case 'GET_PRICE':
                return await this.getPrice(exchange, params.symbol);

            case 'BUY':
                return await this.executeBuy(exchange, params);

            case 'SELL':
                return await this.executeSell(exchange, params);

            case 'WITHDRAW':
                return await this.executeWithdraw(exchange, params);

            case 'CHECK_DEPOSIT':
                return await this.checkDeposit(exchange, params);

            case 'GET_BALANCE':
                return await this.getBalance(exchange, params.asset);

            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    /**
     * Execute Transfer Arbitrage - Full Flow
     */
    async executeTransferArb(opportunity, apiCredentials) {
        const transferId = `TRANSFER_${Date.now()}`;
        console.log(`🚀 Starting Transfer Arbitrage: ${transferId}`);
        console.log(`   Route: ${opportunity.fromExchange} → ${opportunity.toExchange}`);
        console.log(`   Crypto: ${opportunity.crypto}`);
        console.log(`   Expected Profit: $${opportunity.netProfit.toFixed(2)} (${opportunity.netProfitPercent.toFixed(2)}%)`);

        try {
            // Track this transfer
            this.activeTransfers.set(transferId, {
                opportunity,
                status: 'STARTED',
                startTime: Date.now(),
                steps: []
            });

            // STEP 1: Buy crypto on source exchange
            console.log(`\n📍 STEP 1: Buying ${opportunity.crypto} on ${opportunity.fromExchange}`);
            const buyResult = await this.enqueue({
                exchange: opportunity.fromExchange,
                action: 'BUY',
                params: {
                    symbol: `${opportunity.crypto}/USDT`,
                    amount: opportunity.usdtToSpend,
                    apiKey: apiCredentials[opportunity.fromExchange].apiKey,
                    apiSecret: apiCredentials[opportunity.fromExchange].apiSecret
                }
            }, 10); // High priority

            this.updateTransferStatus(transferId, 'BUY_COMPLETE', {
                buyPrice: buyResult.price,
                quantity: buyResult.quantity
            });

            // STEP 2: Withdraw crypto to destination exchange
            console.log(`\n📍 STEP 2: Withdrawing ${opportunity.crypto} to ${opportunity.toExchange}`);
            const withdrawResult = await this.enqueue({
                exchange: opportunity.fromExchange,
                action: 'WITHDRAW',
                params: {
                    crypto: opportunity.crypto,
                    amount: opportunity.cryptoQuantity,
                    destinationAddress: apiCredentials[opportunity.toExchange].depositAddress[opportunity.crypto],
                    apiKey: apiCredentials[opportunity.fromExchange].apiKey,
                    apiSecret: apiCredentials[opportunity.fromExchange].apiSecret
                }
            }, 10);

            this.updateTransferStatus(transferId, 'WITHDRAWAL_INITIATED', {
                txHash: withdrawResult.txHash,
                withdrawalId: withdrawResult.withdrawalId
            });

            // STEP 3: Monitor blockchain confirmation
            console.log(`\n📍 STEP 3: Monitoring blockchain confirmations...`);
            const depositConfirmed = await this.monitorDeposit(
                opportunity.toExchange,
                opportunity.crypto,
                withdrawResult.txHash,
                apiCredentials[opportunity.toExchange]
            );

            this.updateTransferStatus(transferId, 'DEPOSIT_CONFIRMED', {
                confirmedAmount: depositConfirmed.amount
            });

            // STEP 4: Sell crypto on destination exchange
            console.log(`\n📍 STEP 4: Selling ${opportunity.crypto} on ${opportunity.toExchange}`);
            const sellResult = await this.enqueue({
                exchange: opportunity.toExchange,
                action: 'SELL',
                params: {
                    symbol: `${opportunity.crypto}/USDT`,
                    amount: depositConfirmed.amount,
                    apiKey: apiCredentials[opportunity.toExchange].apiKey,
                    apiSecret: apiCredentials[opportunity.toExchange].apiSecret
                }
            }, 10);

            this.updateTransferStatus(transferId, 'SELL_COMPLETE', {
                sellPrice: sellResult.price,
                usdtReceived: sellResult.totalUsdt
            });

            // STEP 5: Calculate actual profit
            const actualProfit = sellResult.totalUsdt - opportunity.usdtToSpend;
            const actualProfitPercent = (actualProfit / opportunity.usdtToSpend) * 100;

            console.log(`\n✅ Transfer Arbitrage Complete!`);
            console.log(`   Expected Profit: $${opportunity.netProfit.toFixed(2)}`);
            console.log(`   Actual Profit: $${actualProfit.toFixed(2)} (${actualProfitPercent.toFixed(2)}%)`);
            console.log(`   Slippage: ${(actualProfit - opportunity.netProfit).toFixed(2)}`);

            this.updateTransferStatus(transferId, 'COMPLETED', {
                actualProfit,
                actualProfitPercent,
                completedAt: new Date()
            });

            return {
                success: true,
                transferId,
                actualProfit,
                actualProfitPercent,
                expectedProfit: opportunity.netProfit,
                slippage: actualProfit - opportunity.netProfit
            };

        } catch (error) {
            console.error(`❌ Transfer Arbitrage Failed: ${error.message}`);
            this.updateTransferStatus(transferId, 'FAILED', {
                error: error.message,
                failedAt: new Date()
            });

            throw error;
        }
    }

    /**
     * Monitor deposit confirmation
     */
    async monitorDeposit(exchange, crypto, txHash, apiCredentials, maxAttempts = 60) {
        console.log(`   Waiting for deposit confirmation on ${exchange}...`);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await this.sleep(5000); // Check every 5 seconds

            const depositStatus = await this.enqueue({
                exchange,
                action: 'CHECK_DEPOSIT',
                params: {
                    crypto,
                    txHash,
                    apiKey: apiCredentials.apiKey,
                    apiSecret: apiCredentials.apiSecret
                }
            }, 8); // Medium-high priority

            if (depositStatus.confirmed) {
                console.log(`   ✅ Deposit confirmed! Amount: ${depositStatus.amount} ${crypto}`);
                return depositStatus;
            }

            if (attempt % 6 === 0) { // Log every 30 seconds
                console.log(`   ⏳ Still waiting... (${attempt * 5}s elapsed)`);
            }
        }

        throw new Error(`Deposit confirmation timeout after ${maxAttempts * 5} seconds`);
    }

    /**
     * Update transfer status
     */
    updateTransferStatus(transferId, status, data = {}) {
        const transfer = this.activeTransfers.get(transferId);
        if (transfer) {
            transfer.status = status;
            transfer.steps.push({
                status,
                timestamp: Date.now(),
                ...data
            });
            this.activeTransfers.set(transferId, transfer);
        }
    }

    /**
     * Get active transfers
     */
    getActiveTransfers() {
        return Array.from(this.activeTransfers.values());
    }

    /**
     * Placeholder execution functions (to be implemented with actual exchange APIs)
     */
    async getPrice(exchange, symbol) {
        // TODO: Implement with actual exchange API
        console.log(`   Getting price for ${symbol} on ${exchange}`);
        return { bid: 0, ask: 0 };
    }

    async executeBuy(exchange, params) {
        // TODO: Implement with actual exchange API
        console.log(`   Buying ${params.symbol} on ${exchange}: $${params.amount}`);
        return { price: 0, quantity: 0, orderId: '123' };
    }

    async executeSell(exchange, params) {
        // TODO: Implement with actual exchange API
        console.log(`   Selling ${params.symbol} on ${exchange}: ${params.amount}`);
        return { price: 0, totalUsdt: 0, orderId: '456' };
    }

    async executeWithdraw(exchange, params) {
        // TODO: Implement with actual exchange API
        console.log(`   Withdrawing ${params.amount} ${params.crypto} from ${exchange}`);
        return { txHash: '0x123...', withdrawalId: 'abc' };
    }

    async checkDeposit(exchange, params) {
        // TODO: Implement with actual exchange API
        console.log(`   Checking deposit status on ${exchange}`);
        return { confirmed: false, amount: 0 };
    }

    async getBalance(exchange, asset) {
        // TODO: Implement with actual exchange API
        console.log(`   Getting ${asset} balance on ${exchange}`);
        return { available: 0, locked: 0 };
    }

    /**
     * Utility: Sleep function
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get queue statistics
     */
    getQueueStats() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            activeTransfers: this.activeTransfers.size,
            lastExecutionTimes: this.lastExecutionTime
        };
    }
}

module.exports = ExecutionQueue;
