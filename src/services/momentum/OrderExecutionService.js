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
            } else if (exchangeLower === 'luno') {
                return await this._executeLunoBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'chainex') {
                return await this._executeChainEXBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'kraken') {
                return await this._executeKrakenBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'binance') {
                return await this._executeBinanceBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'bybit') {
                return await this._executeBYBITBuy(pair, amountUSDT, credentials);
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
            } else if (exchangeLower === 'luno') {
                return await this._executeLunoSell(pair, quantity, credentials);
            } else if (exchangeLower === 'chainex') {
                return await this._executeChainEXSell(pair, quantity, credentials);
            } else if (exchangeLower === 'kraken') {
                return await this._executeKrakenSell(pair, quantity, credentials);
            } else if (exchangeLower === 'binance') {
                return await this._executeBinanceSell(pair, quantity, credentials);
            } else if (exchangeLower === 'bybit') {
                return await this._executeBYBITSell(pair, quantity, credentials);
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

    // ===== LUNO-SPECIFIC METHODS =====

    /**
     * Execute Luno market BUY order
     * @private
     */
    async _executeLunoBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert BTC to XBT for Luno
            const lunoPair = pair.replace('BTC', 'XBT');

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: '/api/1/marketorder'
            };

            // Luno market order payload
            const payload = {
                pair: lunoPair,
                type: 'BUY',
                counter_volume: amountUSDT.toFixed(2) // Amount in USDT (counter currency)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Luno market BUY order', {
                pair: lunoPair,
                amountUSDT,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Luno response to standard format
            const result = {
                orderId: data.order_id,
                executedPrice: parseFloat(data.counter / data.base), // Calculate average price
                executedQuantity: parseFloat(data.base),
                executedValue: parseFloat(data.counter),
                fee: parseFloat(data.fee_counter || 0),
                status: 'COMPLETE',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Luno BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity
            });

            return result;

        } catch (error) {
            logger.error('Luno BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Luno market SELL order
     * @private
     */
    async _executeLunoSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert BTC to XBT for Luno
            const lunoPair = pair.replace('BTC', 'XBT');

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: '/api/1/marketorder'
            };

            // Luno market order payload
            const payload = {
                pair: lunoPair,
                type: 'SELL',
                base_volume: quantity.toFixed(8) // Amount of base currency (crypto)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Luno market SELL order', {
                pair: lunoPair,
                quantity,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Luno response to standard format
            const result = {
                orderId: data.order_id,
                executedPrice: parseFloat(data.counter / data.base), // Calculate average price
                executedQuantity: parseFloat(data.base),
                executedValue: parseFloat(data.counter),
                fee: parseFloat(data.fee_counter || 0),
                status: 'COMPLETE',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Luno SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedValue: result.executedValue
            });

            return result;

        } catch (error) {
            logger.error('Luno SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create Luno authentication headers (HTTP Basic Auth)
     * @private
     */
    _createLunoAuth(apiKey, apiSecret) {
        // Luno uses HTTP Basic Authentication
        // Username: API Key ID
        // Password: API Secret
        const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

        return {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json'
        };
    }

    // ===== CHAINEX-SPECIFIC METHODS =====

    /**
     * Execute ChainEX market BUY order
     * @private
     */
    async _executeChainEXBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.chainex.io',
                endpoint: '/trading/order'
            };

            // Convert pair format (BTCUSDT → BTC_USDT)
            const chainexPair = this._convertPairToChainEX(pair);

            // ChainEX market order payload
            const payload = {
                type: 'market',
                side: 'buy',
                pair: chainexPair,
                quote_amount: amountUSDT.toFixed(2) // Amount in USDT (quote currency)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing ChainEX market BUY order', {
                pair: chainexPair,
                amountUSDT,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createChainEXAuth(credentials.apiKey),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform ChainEX response to standard format
            const result = {
                orderId: data.id || data.order_id,
                executedPrice: parseFloat(data.average_price || data.price || 0),
                executedQuantity: parseFloat(data.filled_amount || data.amount || 0),
                executedValue: parseFloat(data.filled_value || amountUSDT),
                fee: parseFloat(data.fee || 0),
                status: data.status || 'COMPLETE',
                timestamp: data.created_at || Date.now(),
                rawResponse: data
            };

            logger.info('ChainEX BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity
            });

            return result;

        } catch (error) {
            logger.error('ChainEX BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute ChainEX market SELL order
     * @private
     */
    async _executeChainEXSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.chainex.io',
                endpoint: '/trading/order'
            };

            // Convert pair format (BTCUSDT → BTC_USDT)
            const chainexPair = this._convertPairToChainEX(pair);

            // ChainEX market order payload
            const payload = {
                type: 'market',
                side: 'sell',
                pair: chainexPair,
                base_amount: quantity.toFixed(8) // Amount of base currency (crypto)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing ChainEX market SELL order', {
                pair: chainexPair,
                quantity,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createChainEXAuth(credentials.apiKey),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform ChainEX response to standard format
            const result = {
                orderId: data.id || data.order_id,
                executedPrice: parseFloat(data.average_price || data.price || 0),
                executedQuantity: parseFloat(data.filled_amount || data.amount || 0),
                executedValue: parseFloat(data.filled_value || 0),
                fee: parseFloat(data.fee || 0),
                status: data.status || 'COMPLETE',
                timestamp: data.created_at || Date.now(),
                rawResponse: data
            };

            logger.info('ChainEX SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedValue: result.executedValue
            });

            return result;

        } catch (error) {
            logger.error('ChainEX SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to ChainEX format (BTCUSDT → BTC_USDT)
     * @private
     */
    _convertPairToChainEX(pair) {
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create ChainEX authentication headers (Simple API Key)
     * @private
     */
    _createChainEXAuth(apiKey) {
        // ChainEX uses simple X-API-KEY header authentication
        return {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
        };
    }

    // ===== KRAKEN-SPECIFIC METHODS =====

    /**
     * Execute Kraken market BUY order
     * @private
     */
    async _executeKrakenBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.kraken.com',
                endpoint: '/0/private/AddOrder'
            };

            // Convert pair to Kraken format (BTCUSDT → XBTUSDT)
            const krakenPair = this._convertPairToKraken(pair);

            // Kraken nonce (must be increasing)
            const nonce = Date.now() * 1000;

            // Kraken market order payload
            // For market buy: use 'volume' field with quote currency amount
            const orderParams = {
                nonce: nonce,
                ordertype: 'market',
                type: 'buy',
                volume: amountUSDT.toFixed(2), // For market buy, volume is in quote currency (USDT)
                pair: krakenPair,
                oflags: 'viqc' // viqc = volume in quote currency
            };

            const postData = new URLSearchParams(orderParams).toString();

            const authHeaders = this._createKrakenAuth(
                credentials.apiKey,
                credentials.apiSecret,
                config.endpoint,
                nonce,
                postData
            );

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Kraken market BUY order', {
                pair: krakenPair,
                amountUSDT,
                postData
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...authHeaders
                },
                body: postData
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Kraken BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Transform Kraken response to standard format
            const result = {
                orderId: data.result?.txid?.[0] || 'unknown',
                executedPrice: 0, // Kraken doesn't return price immediately for market orders
                executedQuantity: 0, // Will be filled after order executes
                executedValue: amountUSDT,
                fee: 0, // Kraken calculates fee after execution
                status: 'SUBMITTED',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Kraken BUY order submitted successfully', {
                orderId: result.orderId,
                amountUSDT: amountUSDT
            });

            return result;

        } catch (error) {
            logger.error('Kraken BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Kraken market SELL order
     * @private
     */
    async _executeKrakenSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.kraken.com',
                endpoint: '/0/private/AddOrder'
            };

            // Convert pair to Kraken format (BTCUSDT → XBTUSDT)
            const krakenPair = this._convertPairToKraken(pair);

            // Kraken nonce (must be increasing)
            const nonce = Date.now() * 1000;

            // Kraken market order payload
            // For market sell: use 'volume' field with base currency amount
            const orderParams = {
                nonce: nonce,
                ordertype: 'market',
                type: 'sell',
                volume: quantity.toFixed(8), // Amount of base currency (crypto)
                pair: krakenPair
            };

            const postData = new URLSearchParams(orderParams).toString();

            const authHeaders = this._createKrakenAuth(
                credentials.apiKey,
                credentials.apiSecret,
                config.endpoint,
                nonce,
                postData
            );

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Kraken market SELL order', {
                pair: krakenPair,
                quantity,
                postData
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...authHeaders
                },
                body: postData
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Kraken SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Transform Kraken response to standard format
            const result = {
                orderId: data.result?.txid?.[0] || 'unknown',
                executedPrice: 0, // Kraken doesn't return price immediately for market orders
                executedQuantity: quantity,
                executedValue: 0, // Will be calculated after execution
                fee: 0, // Kraken calculates fee after execution
                status: 'SUBMITTED',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Kraken SELL order submitted successfully', {
                orderId: result.orderId,
                quantity: quantity
            });

            return result;

        } catch (error) {
            logger.error('Kraken SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to Kraken format (BTCUSDT → XBTUSDT)
     * @private
     */
    _convertPairToKraken(pair) {
        // Kraken uses XBT instead of BTC
        if (pair.startsWith('BTC')) {
            return pair.replace('BTC', 'XBT');
        }
        return pair;
    }

    /**
     * Create Kraken authentication headers (API-Key + API-Sign)
     * Uses HMAC-SHA512 signature
     * @private
     */
    _createKrakenAuth(apiKey, apiSecret, path, nonce, postData) {
        // Kraken signature: HMAC-SHA512 of (URI path + SHA256(nonce + POST data))
        // using base64-decoded API secret as the key
        const message = nonce + postData;
        const secret = Buffer.from(apiSecret, 'base64');
        const hash = crypto.createHash('sha256').update(message).digest();
        const hmac = crypto.createHmac('sha512', secret)
            .update(Buffer.concat([Buffer.from(path, 'utf8'), hash]))
            .digest('base64');

        return {
            'API-Key': apiKey,
            'API-Sign': hmac
        };
    }

    // ===== BINANCE-SPECIFIC METHODS =====

    /**
     * Execute Binance market BUY order
     * @private
     */
    async _executeBinanceBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.binance.com',
                endpoint: '/api/v3/order'
            };

            // Binance requires timestamp
            const timestamp = Date.now();

            // Binance market order payload
            // For market buy with USDT amount, use quoteOrderQty
            const orderParams = {
                symbol: pair,
                side: 'BUY',
                type: 'MARKET',
                quoteOrderQty: amountUSDT.toFixed(2), // Amount in USDT (quote currency)
                timestamp: timestamp
            };

            // Create query string and signature
            const queryString = new URLSearchParams(orderParams).toString();
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const url = `${config.baseUrl}${config.endpoint}?${queryString}&signature=${signature}`;

            logger.info('Executing Binance market BUY order', {
                pair,
                amountUSDT,
                orderParams
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Binance response to standard format
            // Binance response: { orderId, symbol, status, executedQty, cummulativeQuoteQty, fills: [...] }
            const result = {
                orderId: data.orderId?.toString() || 'unknown',
                executedPrice: parseFloat(data.fills?.[0]?.price || 0),
                executedQuantity: parseFloat(data.executedQty || 0),
                executedValue: parseFloat(data.cummulativeQuoteQty || amountUSDT),
                fee: data.fills?.reduce((sum, fill) => sum + parseFloat(fill.commission || 0), 0) || 0,
                status: data.status || 'FILLED',
                timestamp: data.transactTime || Date.now(),
                rawResponse: data
            };

            logger.info('Binance BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity
            });

            return result;

        } catch (error) {
            logger.error('Binance BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Binance market SELL order
     * @private
     */
    async _executeBinanceSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.binance.com',
                endpoint: '/api/v3/order'
            };

            // Binance requires timestamp
            const timestamp = Date.now();

            // Binance market order payload
            // For market sell, use quantity (base currency amount)
            const orderParams = {
                symbol: pair,
                side: 'SELL',
                type: 'MARKET',
                quantity: quantity.toFixed(8), // Amount of base currency (crypto)
                timestamp: timestamp
            };

            // Create query string and signature
            const queryString = new URLSearchParams(orderParams).toString();
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const url = `${config.baseUrl}${config.endpoint}?${queryString}&signature=${signature}`;

            logger.info('Executing Binance market SELL order', {
                pair,
                quantity,
                orderParams
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Binance response to standard format
            const result = {
                orderId: data.orderId?.toString() || 'unknown',
                executedPrice: parseFloat(data.fills?.[0]?.price || 0),
                executedQuantity: parseFloat(data.executedQty || quantity),
                executedValue: parseFloat(data.cummulativeQuoteQty || 0),
                fee: data.fills?.reduce((sum, fill) => sum + parseFloat(fill.commission || 0), 0) || 0,
                status: data.status || 'FILLED',
                timestamp: data.transactTime || Date.now(),
                rawResponse: data
            };

            logger.info('Binance SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedValue: result.executedValue
            });

            return result;

        } catch (error) {
            logger.error('Binance SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    // ===== BYBIT-SPECIFIC METHODS =====

    /**
     * Execute BYBIT market BUY order
     * @private
     */
    async _executeBYBITBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.bybit.com',
                endpoint: '/v5/order/create'
            };

            // BYBIT requires timestamp
            const timestamp = Date.now().toString();

            // BYBIT market order payload
            const orderData = {
                category: 'spot',
                symbol: pair,
                side: 'Buy',
                orderType: 'Market',
                marketUnit: 'quoteCoin', // Use quote currency (USDT) for market buy
                qty: amountUSDT.toFixed(2) // Amount in USDT
            };

            const requestBody = JSON.stringify(orderData);
            const recvWindow = '5000';

            // Create authentication headers
            const authHeaders = this._createBYBITAuth(
                credentials.apiKey,
                credentials.apiSecret,
                timestamp,
                recvWindow + requestBody
            );

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing BYBIT market BUY order', {
                pair,
                amountUSDT,
                orderData
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                    'X-BAPI-RECV-WINDOW': recvWindow
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BYBIT BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for BYBIT API errors
            if (data.retCode !== 0) {
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            // Transform BYBIT response to standard format
            const result = {
                orderId: data.result?.orderId || 'unknown',
                executedPrice: 0, // BYBIT doesn't return price immediately for market orders
                executedQuantity: 0, // Will be filled after order executes
                executedValue: amountUSDT,
                fee: 0, // BYBIT calculates fee after execution
                status: 'SUBMITTED',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('BYBIT BUY order submitted successfully', {
                orderId: result.orderId,
                amountUSDT: amountUSDT
            });

            return result;

        } catch (error) {
            logger.error('BYBIT BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute BYBIT market SELL order
     * @private
     */
    async _executeBYBITSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.bybit.com',
                endpoint: '/v5/order/create'
            };

            // BYBIT requires timestamp
            const timestamp = Date.now().toString();

            // BYBIT market order payload
            const orderData = {
                category: 'spot',
                symbol: pair,
                side: 'Sell',
                orderType: 'Market',
                qty: quantity.toFixed(8) // Amount of base currency (crypto)
            };

            const requestBody = JSON.stringify(orderData);
            const recvWindow = '5000';

            // Create authentication headers
            const authHeaders = this._createBYBITAuth(
                credentials.apiKey,
                credentials.apiSecret,
                timestamp,
                recvWindow + requestBody
            );

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing BYBIT market SELL order', {
                pair,
                quantity,
                orderData
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                    'X-BAPI-RECV-WINDOW': recvWindow
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BYBIT SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for BYBIT API errors
            if (data.retCode !== 0) {
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            // Transform BYBIT response to standard format
            const result = {
                orderId: data.result?.orderId || 'unknown',
                executedPrice: 0, // BYBIT doesn't return price immediately for market orders
                executedQuantity: quantity,
                executedValue: 0, // Will be calculated after execution
                fee: 0, // BYBIT calculates fee after execution
                status: 'SUBMITTED',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('BYBIT SELL order submitted successfully', {
                orderId: result.orderId,
                quantity: quantity
            });

            return result;

        } catch (error) {
            logger.error('BYBIT SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create BYBIT authentication headers
     * Uses HMAC-SHA256 signature
     * @private
     */
    _createBYBITAuth(apiKey, apiSecret, timestamp, params) {
        // BYBIT signature: HMAC-SHA256 of (timestamp + apiKey + recv_window + params)
        const paramString = timestamp + apiKey + params;
        const signature = crypto.createHmac('sha256', apiSecret).update(paramString).digest('hex');

        return {
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-SIGN': signature,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-SIGN-TYPE': '2'
        };
    }
}

module.exports = OrderExecutionService;
