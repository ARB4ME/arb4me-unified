// Currency Swap Execution Service
// Executes 3-leg arbitrage: Buy XRP → Transfer → Sell XRP

// REMOVED: CurrencySwapCredentials - credentials now passed from request
const Balance = require('../../models/Balance');
const { logger } = require('../../utils/logger');
const fetch = require('node-fetch');
const PreFlightValidationService = require('./PreFlightValidationService');
const executionRateLimiter = require('../triangular-arb/ExecutionRateLimiter');

class CurrencySwapExecutionService {
    constructor() {
        this.preFlightValidator = new PreFlightValidationService();
    }
    /**
     * Execute a currency swap path (3 legs)
     * @param {number} userId - User ID
     * @param {object} path - Path object from scanner
     * @param {number} amount - Trade amount in source currency
     * @param {object} credentials - { sourceCredentials, destCredentials } from request
     * @returns {object} Execution result
     */
    static async executePath(userId, path, amount, credentials) {
        const executionLog = {
            userId,
            pathId: path.id,
            startTime: Date.now(),
            legs: []
        };

        // Declare executionId outside try block so it's accessible in finally
        let executionId = null;

        try {
            logger.info(`Executing Currency Swap path: ${path.id}`, {
                userId,
                amount,
                sourceExchange: path.sourceExchange,
                destExchange: path.destExchange
            });

            // Credentials now passed as parameters from request body (stored in localStorage only)
            const { sourceCredentials, destCredentials } = credentials;

            if (!sourceCredentials || !destCredentials) {
                throw new Error('Missing credentials for exchanges - both source and destination credentials required');
            }

            // STEP 0: PRE-FLIGHT VALIDATION
            logger.info('[STEP 0] Running pre-flight validation checks...');
            const preFlightValidator = new PreFlightValidationService();
            const validationResult = await preFlightValidator.validateSwap(
                path,
                amount,
                credentials,
                {
                    minProfitThreshold: 0.5,        // 0.5% minimum for currency swap
                    maxTradeAmount: 5000,           // $5k max per trade
                    portfolioPercent: null,
                    requireConfirmation: false,      // Will be enabled in Step 6
                    confirmed: true
                }
            );

            if (!validationResult.passed) {
                logger.warn('[SAFETY] Pre-flight validation FAILED', {
                    pathId: path.id,
                    checks: validationResult.checks,
                    warnings: validationResult.warnings
                });

                executionLog.status = 'VALIDATION_FAILED';
                executionLog.error = 'Pre-flight validation failed';
                executionLog.validationResult = validationResult;

                const failedChecks = Object.entries(validationResult.checks)
                    .filter(([_, check]) => !check.passed)
                    .map(([name, check]) => `${name}: ${check.error || check.message}`)
                    .join('\n');

                throw new Error(`Pre-flight validation failed:\n\n${failedChecks}`);
            }

            logger.info('[SAFETY] ✅ Pre-flight validation PASSED - all checks successful');

            // RATE LIMITING: Check both source and destination exchanges
            logger.info('[RATE LIMIT] Checking rate limits for both exchanges...');

            const sourceRateCheck = await executionRateLimiter.checkExecutionAllowed(
                path.sourceExchange,
                userId.toString()
            );

            if (!sourceRateCheck.allowed) {
                logger.warn(`[RATE LIMIT] Source exchange ${path.sourceExchange} rate limit active`, {
                    reason: sourceRateCheck.reason,
                    waitTime: sourceRateCheck.waitTime,
                    message: sourceRateCheck.message
                });
                throw new Error(
                    `⏳ Rate Limit - Source Exchange\n\n` +
                    `${sourceRateCheck.message}\n\n` +
                    `Please wait ${Math.ceil(sourceRateCheck.waitTime / 1000)} seconds before executing another trade.`
                );
            }

            const destRateCheck = await executionRateLimiter.checkExecutionAllowed(
                path.destExchange,
                userId.toString()
            );

            if (!destRateCheck.allowed) {
                logger.warn(`[RATE LIMIT] Destination exchange ${path.destExchange} rate limit active`, {
                    reason: destRateCheck.reason,
                    waitTime: destRateCheck.waitTime,
                    message: destRateCheck.message
                });
                throw new Error(
                    `⏳ Rate Limit - Destination Exchange\n\n` +
                    `${destRateCheck.message}\n\n` +
                    `Please wait ${Math.ceil(destRateCheck.waitTime / 1000)} seconds before executing another trade.`
                );
            }

            logger.info('[RATE LIMIT] ✅ Both exchanges available for execution');

            // Mark execution started for BOTH exchanges
            executionId = `currency-swap-${Date.now()}-${userId}`;
            executionRateLimiter.markExecutionStarted(path.sourceExchange, executionId, userId.toString());
            executionRateLimiter.markExecutionStarted(path.destExchange, executionId, userId.toString());

            logger.info('[RATE LIMIT] Execution marked as started for both exchanges', {
                executionId,
                sourceExchange: path.sourceExchange,
                destExchange: path.destExchange
            });

            // PRE-FLIGHT: Verify source currency balance before executing (redundant but logged separately)
            logger.info(`Pre-flight: Checking ${path.sourceCurrency} balance on ${path.sourceExchange}`);
            const sourceBalanceCheck = await this._checkBalance(
                path.sourceExchange,
                path.sourceCurrency,
                amount,
                sourceCredentials
            );

            if (!sourceBalanceCheck.sufficient) {
                throw new Error(
                    `Insufficient ${path.sourceCurrency} balance on ${path.sourceExchange}.\n` +
                    `Required: ${amount.toFixed(2)} ${path.sourceCurrency} (including fees)\n` +
                    `Available: ${sourceBalanceCheck.available.toFixed(2)} ${path.sourceCurrency}\n` +
                    `Shortage: ${(amount - sourceBalanceCheck.available).toFixed(2)} ${path.sourceCurrency}`
                );
            }

            logger.info(`✅ Balance check passed: ${sourceBalanceCheck.available.toFixed(2)} ${path.sourceCurrency} available on ${path.sourceExchange}`);

            // Leg 1: Buy XRP on source exchange
            logger.info('Leg 1: Buying XRP on source exchange');
            const leg1Result = await this._executeBuyOrder(
                path.sourceExchange,
                path.sourceCurrency,
                amount,
                sourceCredentials
            );

            executionLog.legs.push({
                leg: 1,
                action: 'buy_xrp',
                exchange: path.sourceExchange,
                pair: `XRP/${path.sourceCurrency}`,
                inputAmount: amount,
                outputAmount: leg1Result.xrpReceived,
                status: 'completed',
                orderId: leg1Result.orderId
            });

            logger.info(`Leg 1 complete: Received ${leg1Result.xrpReceived} XRP`);

            // Leg 2: Withdraw XRP to destination exchange
            logger.info('Leg 2: Withdrawing XRP to destination');

            // CRITICAL: Validate XRP deposit address
            if (!destCredentials.xrpDepositAddress || destCredentials.xrpDepositAddress.trim() === '') {
                throw new Error(`🚨 CRITICAL: No XRP deposit address configured for ${path.destExchange}. Cannot proceed with withdrawal.`);
            }

            // CRITICAL: Validate XRP destination tag for exchanges that require it
            const exchangesRequiringTag = [
                'VALR', 'valr',
                'Binance', 'binance',
                'Kraken', 'kraken',
                'OKX', 'okx',
                'Bybit', 'bybit',
                'KuCoin', 'kucoin',
                'Coinbase', 'coinbase',
                'Gate.io', 'gateio',
                'HTX', 'htx',
                'Bitget', 'bitget'
            ];

            const requiresTag = exchangesRequiringTag.some(ex =>
                path.destExchange.toLowerCase() === ex.toLowerCase()
            );

            if (requiresTag) {
                if (!destCredentials.xrpDepositTag || destCredentials.xrpDepositTag.trim() === '') {
                    throw new Error(
                        `🚨 CRITICAL - PERMANENT FUND LOSS RISK!\n\n` +
                        `${path.destExchange} REQUIRES an XRP destination tag/memo.\n` +
                        `Sending XRP without a tag will result in PERMANENT FUND LOSS!\n\n` +
                        `Please configure the XRP destination tag for ${path.destExchange} before executing.\n\n` +
                        `To find your destination tag:\n` +
                        `1. Go to ${path.destExchange}\n` +
                        `2. Navigate to Deposit → XRP\n` +
                        `3. Copy both the deposit address AND the destination tag/memo\n` +
                        `4. Configure both in Currency Swap settings`
                    );
                }

                logger.info(`✅ XRP destination tag validated for ${path.destExchange}: ${destCredentials.xrpDepositTag}`);
            } else {
                logger.info(`ℹ️ ${path.destExchange} does not require XRP destination tag (or not in known list)`);
            }

            const leg2Result = await this._executeWithdrawal(
                path.sourceExchange,
                leg1Result.xrpReceived,
                destCredentials.xrpDepositAddress,
                destCredentials.xrpDepositTag,
                sourceCredentials
            );

            executionLog.legs.push({
                leg: 2,
                action: 'withdraw_xrp',
                fromExchange: path.sourceExchange,
                toExchange: path.destExchange,
                amount: leg2Result.amountSent,
                withdrawalId: leg2Result.withdrawalId,
                status: 'completed'
            });

            logger.info(`Leg 2 complete: Withdrew ${leg2Result.amountSent} XRP`);

            // Wait for XRP to arrive on destination exchange (with balance polling)
            logger.info('⏳ Waiting for XRP deposit to arrive on destination exchange...');
            const depositArrived = await this._waitForDepositArrival(
                path.destExchange,
                leg2Result.amountSent,
                destCredentials,
                600000 // 10 minute timeout for XRP transfers
            );

            if (!depositArrived.success) {
                throw new Error(
                    `XRP deposit timeout: Waited 10 minutes but XRP did not arrive on ${path.destExchange}. ` +
                    `Withdrawal ID: ${leg2Result.withdrawalId}. ` +
                    `Please check ${path.sourceExchange} withdrawal status and ${path.destExchange} deposit history manually. ` +
                    `XRP may still be in transit on the blockchain.`
                );
            }

            logger.info(`✅ XRP deposit confirmed on ${path.destExchange}: ${depositArrived.confirmedAmount} XRP arrived after ${depositArrived.waitTime}ms`);

            // Leg 3: Sell XRP on destination exchange
            logger.info('Leg 3: Selling XRP on destination exchange');
            const leg3Result = await this._executeSellOrder(
                path.destExchange,
                path.destCurrency,
                leg2Result.amountSent,
                destCredentials
            );

            executionLog.legs.push({
                leg: 3,
                action: 'sell_xrp',
                exchange: path.destExchange,
                pair: `XRP/${path.destCurrency}`,
                inputAmount: leg2Result.amountSent,
                outputAmount: leg3Result.currencyReceived,
                status: 'completed',
                orderId: leg3Result.orderId
            });

            logger.info(`Leg 3 complete: Received ${leg3Result.currencyReceived} ${path.destCurrency}`);

            // Calculate final profit
            const profit = leg3Result.currencyReceived - amount;
            const profitPercent = (profit / amount) * 100;

            executionLog.endTime = Date.now();
            executionLog.duration = executionLog.endTime - executionLog.startTime;
            executionLog.profit = profit;
            executionLog.profitPercent = profitPercent;
            executionLog.status = 'success';

            logger.info(`Currency Swap execution complete!`, {
                userId,
                pathId: path.id,
                profit,
                profitPercent: profitPercent.toFixed(2) + '%',
                duration: executionLog.duration + 'ms'
            });

            return {
                success: true,
                execution: executionLog
            };

        } catch (error) {
            logger.error('Currency Swap execution failed', {
                userId,
                pathId: path.id,
                error: error.message,
                executionLog
            });

            executionLog.status = 'failed';
            executionLog.error = error.message;
            executionLog.endTime = Date.now();

            return {
                success: false,
                error: error.message,
                execution: executionLog
            };
        } finally {
            // ALWAYS mark execution as completed for BOTH exchanges (success or failure)
            if (executionId) {
                executionRateLimiter.markExecutionCompleted(path.sourceExchange, executionId, userId.toString());
                executionRateLimiter.markExecutionCompleted(path.destExchange, executionId, userId.toString());

                logger.info('[RATE LIMIT] Execution marked as completed for both exchanges', {
                    executionId,
                    sourceExchange: path.sourceExchange,
                    destExchange: path.destExchange,
                    status: executionLog.status
                });
            }
        }
    }

    /**
     * Execute buy order (Leg 1: Buy XRP)
     * @private
     */
    static async _executeBuyOrder(exchange, sourceCurrency, amount, credentials) {
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        const exchangeLower = exchange.toLowerCase();
        const pair = `XRP${sourceCurrency}`; // Most exchanges use XRPUSDT format

        // Call existing buy-order endpoint
        const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/buy-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                apiPassphrase: credentials.apiPassphrase,
                pair: pair,
                symbol: pair,
                currencyPair: `XRP_${sourceCurrency}`,
                amount: amount,
                quoteOrderQty: amount
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(`Buy order failed: ${data.error || 'Unknown error'}`);
        }

        // Extract executed quantity from response (different exchanges use different fields)
        const executedQty = data.data.executedQty ||
                           data.data.quantity ||
                           data.data.filled ||
                           data.data.filledQty ||
                           data.data.executedQuantity ||
                           data.data.base_amount ||
                           data.data.amount;

        if (!executedQty) {
            logger.error('Buy order response missing executed quantity', {
                exchange,
                response: JSON.stringify(data.data)
            });
            throw new Error(
                `Buy order succeeded but cannot determine XRP amount received. ` +
                `Exchange: ${exchange}, Response missing executedQty field. ` +
                `This is required for accurate execution. Please check exchange API response format.`
            );
        }

        const xrpReceived = parseFloat(executedQty);

        if (isNaN(xrpReceived) || xrpReceived <= 0) {
            throw new Error(`Invalid XRP amount received: ${executedQty}. Expected positive number.`);
        }

        logger.info(`✅ Leg 1 Buy Order: Received ${xrpReceived} XRP`, {
            exchange,
            orderId: data.data.orderId || data.data.id
        });

        return {
            xrpReceived,
            orderId: data.data.orderId || data.data.id
        };
    }

    /**
     * Execute withdrawal (Leg 2: Withdraw XRP)
     * @private
     */
    static async _executeWithdrawal(exchange, amount, address, tag, credentials) {
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        const exchangeLower = exchange.toLowerCase();

        // Call withdraw endpoint (we'll create this)
        const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                apiPassphrase: credentials.apiPassphrase,
                currency: 'XRP',
                amount: amount,
                address: address,
                tag: tag
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(`Withdrawal failed: ${data.error || 'Unknown error'}`);
        }

        return {
            amountSent: amount,
            withdrawalId: data.data.id || data.data.withdrawalId
        };
    }

    /**
     * Execute sell order (Leg 3: Sell XRP)
     * @private
     */
    static async _executeSellOrder(exchange, destCurrency, xrpAmount, credentials) {
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        const exchangeLower = exchange.toLowerCase();
        const pair = `XRP${destCurrency}`;

        // Call existing sell-order endpoint
        const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/sell-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                apiPassphrase: credentials.apiPassphrase,
                pair: pair,
                symbol: pair,
                currencyPair: `XRP_${destCurrency}`,
                amount: xrpAmount,
                quantity: xrpAmount
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(`Sell order failed: ${data.error || 'Unknown error'}`);
        }

        // Extract currency received from response (different exchanges use different fields)
        const currencyReceived = data.data.cummulativeQuoteQty ||
                                data.data.total ||
                                data.data.quote_amount ||
                                data.data.turnover ||
                                data.data.totalValue ||
                                data.data.quoteQty ||
                                data.data.funds;

        if (!currencyReceived) {
            logger.error('Sell order response missing currency amount', {
                exchange,
                response: JSON.stringify(data.data)
            });
            throw new Error(
                `Sell order succeeded but cannot determine ${destCurrency} amount received. ` +
                `Exchange: ${exchange}, Response missing cummulativeQuoteQty field. ` +
                `This is required for accurate profit calculation. Please check exchange API response format.`
            );
        }

        const finalAmount = parseFloat(currencyReceived);

        if (isNaN(finalAmount) || finalAmount <= 0) {
            throw new Error(`Invalid ${destCurrency} amount received: ${currencyReceived}. Expected positive number.`);
        }

        logger.info(`✅ Leg 3 Sell Order: Received ${finalAmount} ${destCurrency}`, {
            exchange,
            orderId: data.data.orderId || data.data.id
        });

        return {
            currencyReceived: finalAmount,
            orderId: data.data.orderId || data.data.id
        };
    }

    /**
     * Wait for XRP deposit to arrive on destination exchange (with balance polling)
     * @private
     * @param {string} exchange - Destination exchange
     * @param {number} expectedAmount - Expected XRP amount
     * @param {object} credentials - Exchange credentials
     * @param {number} timeoutMs - Timeout in milliseconds (default 10 minutes)
     * @returns {Promise<object>} { success: boolean, confirmedAmount: number, waitTime: number }
     */
    static async _waitForDepositArrival(exchange, expectedAmount, credentials, timeoutMs = 600000) {
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        const exchangeLower = exchange.toLowerCase();
        const startTime = Date.now();
        const pollInterval = 5000; // Check every 5 seconds
        let initialBalance = null;

        try {
            // Get initial XRP balance
            const initialResponse = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/balance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: credentials.apiKey,
                    apiSecret: credentials.apiSecret,
                    apiPassphrase: credentials.apiPassphrase,
                    currency: 'XRP'
                })
            });

            const initialData = await initialResponse.json();
            if (initialData.success && initialData.data) {
                initialBalance = parseFloat(initialData.data.free || initialData.data.available || 0);
                logger.info(`Initial XRP balance on ${exchange}: ${initialBalance} XRP`);
            } else {
                logger.warn(`Could not fetch initial balance from ${exchange}, will poll without comparison`);
            }

            // Poll until deposit arrives or timeout
            let attempt = 0;
            while (true) {
                attempt++;
                const elapsed = Date.now() - startTime;

                if (elapsed >= timeoutMs) {
                    logger.error(`Deposit timeout after ${elapsed}ms`, {
                        exchange,
                        expectedAmount,
                        attempts: attempt
                    });
                    return { success: false, waitTime: elapsed };
                }

                // Wait before checking (except first attempt)
                if (attempt > 1) {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }

                // Check current balance
                try {
                    const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/balance`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            apiKey: credentials.apiKey,
                            apiSecret: credentials.apiSecret,
                            apiPassphrase: credentials.apiPassphrase,
                            currency: 'XRP'
                        })
                    });

                    const data = await response.json();

                    if (data.success && data.data) {
                        const currentBalance = parseFloat(data.data.free || data.data.available || 0);

                        logger.info(`[Attempt ${attempt}] Current XRP balance on ${exchange}: ${currentBalance} XRP (elapsed: ${Math.floor(elapsed / 1000)}s)`);

                        // Check if deposit arrived
                        if (initialBalance !== null) {
                            // We have initial balance - check for increase
                            const balanceIncrease = currentBalance - initialBalance;

                            if (balanceIncrease >= expectedAmount * 0.95) { // 95% threshold to account for fees
                                const waitTime = Date.now() - startTime;
                                logger.info(`✅ XRP deposit detected! Balance increased by ${balanceIncrease} XRP`, {
                                    exchange,
                                    initialBalance,
                                    currentBalance,
                                    expectedAmount,
                                    waitTime: `${Math.floor(waitTime / 1000)}s`
                                });

                                return {
                                    success: true,
                                    confirmedAmount: balanceIncrease,
                                    waitTime
                                };
                            }
                        } else {
                            // No initial balance - just check if we have enough XRP now
                            if (currentBalance >= expectedAmount * 0.95) {
                                const waitTime = Date.now() - startTime;
                                logger.info(`✅ Sufficient XRP balance detected: ${currentBalance} XRP`, {
                                    exchange,
                                    expectedAmount,
                                    waitTime: `${Math.floor(waitTime / 1000)}s`
                                });

                                return {
                                    success: true,
                                    confirmedAmount: currentBalance,
                                    waitTime
                                };
                            }
                        }
                    }

                } catch (balanceError) {
                    logger.warn(`Balance check failed on attempt ${attempt}`, {
                        exchange,
                        error: balanceError.message
                    });
                    // Continue polling even if one check fails
                }
            }

        } catch (error) {
            logger.error('Deposit polling failed with error', {
                exchange,
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if exchange has sufficient balance for trade
     * @private
     * @param {string} exchange - Exchange name
     * @param {string} currency - Currency to check
     * @param {number} requiredAmount - Required amount (will add fee buffer)
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<object>} { sufficient: boolean, available: number, required: number }
     */
    static async _checkBalance(exchange, currency, requiredAmount, credentials) {
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://arb4me-unified-production.up.railway.app'
            : 'http://localhost:3000';

        const exchangeLower = exchange.toLowerCase();

        try {
            const response = await fetch(`${baseURL}/api/v1/trading/${exchangeLower}/balance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    apiKey: credentials.apiKey,
                    apiSecret: credentials.apiSecret,
                    apiPassphrase: credentials.apiPassphrase,
                    currency: currency
                })
            });

            const data = await response.json();

            if (!data.success || !data.data) {
                logger.warn(`Failed to fetch balance from ${exchange}`, {
                    currency,
                    error: data.error
                });
                throw new Error(`Could not fetch ${currency} balance from ${exchange}: ${data.error || 'Unknown error'}`);
            }

            const available = parseFloat(data.data.free || data.data.available || 0);

            // Add 0.2% buffer for trading fees
            const totalRequired = requiredAmount * 1.002;

            return {
                sufficient: available >= totalRequired,
                available,
                required: totalRequired
            };

        } catch (error) {
            logger.error('Balance check failed', {
                exchange,
                currency,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = CurrencySwapExecutionService;
