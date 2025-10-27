// Order Execution Service
// Executes market buy/sell orders on exchanges for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');

class OrderExecutionService {
    constructor() {
        this.exchangeConfigs = {
            valr: {
                baseUrl: 'https://api.valr.com',
                endpoints: {
                    marketOrder: '/v1/orders/market',
                    orderStatus: '/v1/orders/:orderId',
                    balances: '/v1/account/balances'
                }
            }
        };

        // Rate limiting: Max 5 requests per second (200ms between requests)
        this.minRequestInterval = 200; // milliseconds
        this.lastRequestTime = 0;
    }

    /**
     * Rate limiter: Ensures minimum delay between API requests
     * Prevents hitting VALR's rate limits
     * @private
     */
    async _rateLimitDelay() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestInterval) {
            const delayNeeded = this.minRequestInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, delayNeeded));
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Execute market BUY order
     * @param {string} exchange - Exchange name ('valr')
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} amountUSDT - Amount in USDT to spend
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order result { orderId, executedPrice, executedQuantity, fee }
     */
    async executeBuyOrder(exchange, pair, amountUSDT, credentials) {
        try {
            const exchangeLower = exchange.toLowerCase();

            if (exchangeLower === 'valr') {
                return await this._executeValrBuy(pair, amountUSDT, credentials);
            }

            throw new Error(`Exchange not supported: ${exchange}`);

        } catch (error) {
            logger.error('Buy order execution failed', {
                exchange,
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute market SELL order
     * @param {string} exchange - Exchange name ('valr')
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} quantity - Quantity of asset to sell
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order result { orderId, executedPrice, executedValue, fee }
     */
    async executeSellOrder(exchange, pair, quantity, credentials) {
        try {
            const exchangeLower = exchange.toLowerCase();

            if (exchangeLower === 'valr') {
                return await this._executeValrSell(pair, quantity, credentials);
            }

            throw new Error(`Exchange not supported: ${exchange}`);

        } catch (error) {
            logger.error('Sell order execution failed', {
                exchange,
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get order status
     * @param {string} exchange - Exchange name
     * @param {string} orderId - Order ID
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order status
     */
    async getOrderStatus(exchange, orderId, credentials) {
        try {
            const exchangeLower = exchange.toLowerCase();

            if (exchangeLower === 'valr') {
                return await this._getValrOrderStatus(orderId, credentials);
            }

            throw new Error(`Exchange not supported: ${exchange}`);

        } catch (error) {
            logger.error('Get order status failed', {
                exchange,
                orderId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get account balances
     * @param {string} exchange - Exchange name
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<Array>} Balances array
     */
    async getBalances(exchange, credentials) {
        try {
            const exchangeLower = exchange.toLowerCase();

            if (exchangeLower === 'valr') {
                return await this._getValrBalances(credentials);
            }

            throw new Error(`Exchange not supported: ${exchange}`);

        } catch (error) {
            logger.error('Get balances failed', {
                exchange,
                error: error.message
            });
            throw error;
        }
    }

    // ===== VALR-SPECIFIC METHODS =====

    /**
     * Execute VALR market BUY order
     * @private
     */
    async _executeValrBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = this.exchangeConfigs.valr;
            const path = config.endpoints.marketOrder;

            // VALR market order payload
            const payload = {
                side: 'BUY',
                currencyPair: pair,
                quoteAmount: amountUSDT.toString() // Amount in USDT (quote currency)
            };

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'POST',
                path,
                payload
            );

            const url = `${config.baseUrl}${path}`;

            logger.info('Executing VALR market BUY order', {
                pair,
                amountUSDT,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform VALR response to standard format
            const result = {
                orderId: data.id || data.orderId,
                executedPrice: parseFloat(data.averagePrice || 0),
                executedQuantity: parseFloat(data.originalQuantity || data.quantity || 0),
                executedValue: parseFloat(data.total || amountUSDT),
                fee: parseFloat(data.totalFee || 0),
                status: data.orderStatus || data.status,
                timestamp: data.createdAt || Date.now(),
                rawResponse: data
            };

            logger.info('VALR BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity
            });

            return result;

        } catch (error) {
            logger.error('VALR BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute VALR market SELL order
     * @private
     */
    async _executeValrSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = this.exchangeConfigs.valr;
            const path = config.endpoints.marketOrder;

            // VALR market order payload
            const payload = {
                side: 'SELL',
                currencyPair: pair,
                baseAmount: quantity.toString() // Amount of base currency (BTC, ETH, etc.)
            };

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'POST',
                path,
                payload
            );

            const url = `${config.baseUrl}${path}`;

            logger.info('Executing VALR market SELL order', {
                pair,
                quantity,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform VALR response to standard format
            const result = {
                orderId: data.id || data.orderId,
                executedPrice: parseFloat(data.averagePrice || 0),
                executedQuantity: parseFloat(data.originalQuantity || data.quantity || 0),
                executedValue: parseFloat(data.total || 0),
                fee: parseFloat(data.totalFee || 0),
                status: data.orderStatus || data.status,
                timestamp: data.createdAt || Date.now(),
                rawResponse: data
            };

            logger.info('VALR SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedValue: result.executedValue
            });

            return result;

        } catch (error) {
            logger.error('VALR SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get VALR order status
     * @private
     */
    async _getValrOrderStatus(orderId, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = this.exchangeConfigs.valr;
            const path = `/v1/orders/${orderId}`;
            const url = `${config.baseUrl}${path}`;

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'GET',
                path,
                null
            );

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR order status failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            return {
                orderId: data.id || data.orderId,
                status: data.orderStatus || data.status,
                side: data.side,
                pair: data.currencyPair,
                executedQuantity: parseFloat(data.originalQuantity || 0),
                executedPrice: parseFloat(data.averagePrice || 0),
                fee: parseFloat(data.totalFee || 0),
                timestamp: data.createdAt,
                rawResponse: data
            };

        } catch (error) {
            logger.error('VALR order status check failed', {
                orderId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get VALR account balances
     * @private
     */
    async _getValrBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = this.exchangeConfigs.valr;
            const path = config.endpoints.balances;
            const url = `${config.baseUrl}${path}`;

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'GET',
                path,
                null
            );

            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR balances fetch failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform VALR balances to standard format
            return data.map(balance => ({
                currency: balance.currency,
                available: parseFloat(balance.available || 0),
                reserved: parseFloat(balance.reserved || 0),
                total: parseFloat(balance.total || 0)
            }));

        } catch (error) {
            logger.error('VALR balances fetch failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create VALR authentication headers
     * @private
     */
    _createValrAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now();
        const payload = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : '');

        const signature = crypto
            .createHmac('sha512', apiSecret)
            .update(payload)
            .digest('hex');

        return {
            'X-VALR-API-KEY': apiKey,
            'X-VALR-SIGNATURE': signature,
            'X-VALR-TIMESTAMP': timestamp.toString(),
            'Content-Type': 'application/json'
        };
    }
}

module.exports = OrderExecutionService;
