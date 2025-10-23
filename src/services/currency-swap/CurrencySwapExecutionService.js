// Currency Swap Execution Service
// Executes 3-leg arbitrage: Buy XRP → Transfer → Sell XRP

const CurrencySwapCredentials = require('../../models/CurrencySwapCredentials');
const Balance = require('../../models/Balance');
const { logger } = require('../../utils/logger');
const fetch = require('node-fetch');

class CurrencySwapExecutionService {
    /**
     * Execute a currency swap path (3 legs)
     * @param {number} userId - User ID
     * @param {object} path - Path object from scanner
     * @param {number} amount - Trade amount in source currency
     * @returns {object} Execution result
     */
    static async executePath(userId, path, amount) {
        const executionLog = {
            userId,
            pathId: path.id,
            startTime: Date.now(),
            legs: []
        };

        try {
            logger.info(`Executing Currency Swap path: ${path.id}`, {
                userId,
                amount,
                sourceExchange: path.sourceExchange,
                destExchange: path.destExchange
            });

            // Get credentials for both exchanges
            const sourceCredentials = await CurrencySwapCredentials.getCredentials(
                userId,
                path.sourceExchange
            );

            const destCredentials = await CurrencySwapCredentials.getCredentials(
                userId,
                path.destExchange
            );

            if (!sourceCredentials || !destCredentials) {
                throw new Error('Missing credentials for exchanges');
            }

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

            if (!destCredentials.xrpDepositAddress) {
                throw new Error(`No XRP deposit address configured for ${path.destExchange}`);
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

            // Wait for XRP to arrive (basic wait - can be enhanced with balance polling)
            logger.info('Waiting for XRP transfer to complete...');
            await this._waitForTransfer(10000); // 10 second wait

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

        return {
            xrpReceived: parseFloat(data.data.executedQty || data.data.quantity || amount / 0.61), // Approximate
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

        return {
            currencyReceived: parseFloat(data.data.cummulativeQuoteQty || data.data.total || xrpAmount * 0.61), // Approximate
            orderId: data.data.orderId || data.data.id
        };
    }

    /**
     * Wait for XRP transfer to complete
     * @private
     */
    static async _waitForTransfer(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }
}

module.exports = CurrencySwapExecutionService;
