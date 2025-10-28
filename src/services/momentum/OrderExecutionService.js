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
            } else if (exchangeLower === 'gate.io' || exchangeLower === 'gateio') {
                return await this._executeGateioBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'okx') {
                return await this._executeOKXBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'mexc') {
                return await this._executeMEXCBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'kucoin') {
                return await this._executeKuCoinBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'xt.com' || exchangeLower === 'xt') {
                return await this._executeXTBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'ascendex') {
                return await this._executeAscendEXBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'htx' || exchangeLower === 'huobi') {
                return await this._executeHTXBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'bingx') {
                return await this._executeBingXBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'bitget') {
                return await this._executeBitgetBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'bitmart') {
                return await this._executeBitMartBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'bitrue') {
                return await this._executeBitrueBuy(pair, amountUSDT, credentials);
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
            } else if (exchangeLower === 'gate.io' || exchangeLower === 'gateio') {
                return await this._executeGateioSell(pair, quantity, credentials);
            } else if (exchangeLower === 'okx') {
                return await this._executeOKXSell(pair, quantity, credentials);
            } else if (exchangeLower === 'mexc') {
                return await this._executeMEXCSell(pair, quantity, credentials);
            } else if (exchangeLower === 'kucoin') {
                return await this._executeKuCoinSell(pair, quantity, credentials);
            } else if (exchangeLower === 'xt.com' || exchangeLower === 'xt') {
                return await this._executeXTSell(pair, quantity, credentials);
            } else if (exchangeLower === 'ascendex') {
                return await this._executeAscendEXSell(pair, quantity, credentials);
            } else if (exchangeLower === 'htx' || exchangeLower === 'huobi') {
                return await this._executeHTXSell(pair, quantity, credentials);
            } else if (exchangeLower === 'bingx') {
                return await this._executeBingXSell(pair, quantity, credentials);
            } else if (exchangeLower === 'bitget') {
                return await this._executeBitgetSell(pair, quantity, credentials);
            } else if (exchangeLower === 'bitmart') {
                return await this._executeBitMartSell(pair, quantity, credentials);
            } else if (exchangeLower === 'bitrue') {
                return await this._executeBitrueSell(pair, quantity, credentials);
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

    // ===== GATE.IO-SPECIFIC METHODS =====

    /**
     * Execute Gate.io market BUY order
     * @private
     */
    async _executeGateioBuy(pair, amountUSDT, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.gateio.ws',
                endpoint: '/api/v4/spot/orders'
            };

            // Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
            const gateioPair = this._convertPairToGateio(pair);

            // Gate.io requires timestamp
            const timestamp = Math.floor(Date.now() / 1000).toString();

            // Gate.io market order payload
            const orderData = {
                currency_pair: gateioPair,
                side: 'buy',
                type: 'market',
                amount: amountUSDT.toFixed(2), // Amount in quote currency (USDT) for market buy
                time_in_force: 'ioc' // Immediate or cancel
            };

            const requestBody = JSON.stringify(orderData);
            const method = 'POST';
            const url = config.endpoint;
            const queryString = '';

            // Create authentication signature
            const signature = this._createGateioSignature(method, url, queryString, requestBody, timestamp, credentials.apiSecret);

            const fullUrl = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Gate.io market BUY order', {
                pair: gateioPair,
                amountUSDT,
                orderData
            });

            const response = await fetch(fullUrl, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KEY': credentials.apiKey,
                    'Timestamp': timestamp,
                    'SIGN': signature
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gate.io BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Gate.io response to standard format
            const result = {
                orderId: data.id || 'unknown',
                executedPrice: parseFloat(data.avg_deal_price || data.price || 0),
                executedQuantity: parseFloat(data.filled_total || 0),
                executedValue: parseFloat(data.amount || amountUSDT),
                fee: parseFloat(data.fee || 0),
                status: data.status || 'open',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Gate.io BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity
            });

            return result;

        } catch (error) {
            logger.error('Gate.io BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Gate.io market SELL order
     * @private
     */
    async _executeGateioSell(pair, quantity, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.gateio.ws',
                endpoint: '/api/v4/spot/orders'
            };

            // Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
            const gateioPair = this._convertPairToGateio(pair);

            // Gate.io requires timestamp
            const timestamp = Math.floor(Date.now() / 1000).toString();

            // Gate.io market order payload
            const orderData = {
                currency_pair: gateioPair,
                side: 'sell',
                type: 'market',
                amount: quantity.toFixed(8), // Amount of base currency (crypto)
                time_in_force: 'ioc' // Immediate or cancel
            };

            const requestBody = JSON.stringify(orderData);
            const method = 'POST';
            const url = config.endpoint;
            const queryString = '';

            // Create authentication signature
            const signature = this._createGateioSignature(method, url, queryString, requestBody, timestamp, credentials.apiSecret);

            const fullUrl = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Gate.io market SELL order', {
                pair: gateioPair,
                quantity,
                orderData
            });

            const response = await fetch(fullUrl, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KEY': credentials.apiKey,
                    'Timestamp': timestamp,
                    'SIGN': signature
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gate.io SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Gate.io response to standard format
            const result = {
                orderId: data.id || 'unknown',
                executedPrice: parseFloat(data.avg_deal_price || data.price || 0),
                executedQuantity: parseFloat(data.amount || quantity),
                executedValue: parseFloat(data.filled_total || 0),
                fee: parseFloat(data.fee || 0),
                status: data.status || 'open',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Gate.io SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedValue: result.executedValue
            });

            return result;

        } catch (error) {
            logger.error('Gate.io SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
     * @private
     */
    _convertPairToGateio(pair) {
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create Gate.io signature for authentication
     * Uses HMAC-SHA512 signature
     * @private
     */
    _createGateioSignature(method, url, queryString, body, timestamp, apiSecret) {
        // Gate.io signature: HMAC-SHA512 of signing string
        // Signing string format: METHOD\nURL\nQUERY_STRING\nHASHED_PAYLOAD\nTIMESTAMP
        const hashedPayload = crypto.createHash('sha512').update(body || '').digest('hex');
        const signingString = `${method}\n${url}\n${queryString}\n${hashedPayload}\n${timestamp}`;
        return crypto.createHmac('sha512', apiSecret).update(signingString).digest('hex');
    }

    /**
     * Execute a buy order on OKX
     * OKX uses REST API v5 with spot trading
     * @private
     */
    async _executeOKXBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to OKX format (BTCUSDT → BTC-USDT)
            const okxPair = this._convertPairToOKX(pair);

            // Prepare order data
            const timestamp = new Date().toISOString();
            const method = 'POST';
            const requestPath = '/api/v5/trade/order';

            const orderData = {
                instId: okxPair,
                tdMode: 'cash', // Cash trading mode (spot)
                side: 'buy',
                ordType: 'market',
                sz: amountUSDT.toFixed(2), // Order quantity (in USDT for market buy)
                tgtCcy: 'quote_ccy' // Target currency is quote currency (USDT)
            };

            const requestBody = JSON.stringify(orderData);

            // Create authentication headers
            const authHeaders = this._createOKXAuth(
                credentials.apiKey,
                credentials.apiSecret,
                credentials.passphrase,
                timestamp,
                method,
                requestPath,
                requestBody
            );

            const url = `https://www.okx.com${requestPath}`;

            logger.info('Executing OKX buy order', { pair: okxPair, amountUSDT });

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...authHeaders
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX buy order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for API error in response
            if (result.code !== '0') {
                throw new Error(`OKX buy order failed: ${result.code} - ${result.msg}`);
            }

            const orderResult = result.data[0];

            logger.info('OKX buy order executed successfully', {
                pair: okxPair,
                orderId: orderResult.ordId,
                clientOrderId: orderResult.clOrdId,
                sCode: orderResult.sCode
            });

            return {
                orderId: orderResult.ordId,
                clientOrderId: orderResult.clOrdId,
                status: 'filled',
                pair: okxPair
            };

        } catch (error) {
            logger.error('Failed to execute OKX buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on OKX
     * @private
     */
    async _executeOKXSell(pair, quantity, credentials) {
        try {
            // Convert pair to OKX format (BTCUSDT → BTC-USDT)
            const okxPair = this._convertPairToOKX(pair);

            // Prepare order data
            const timestamp = new Date().toISOString();
            const method = 'POST';
            const requestPath = '/api/v5/trade/order';

            const orderData = {
                instId: okxPair,
                tdMode: 'cash', // Cash trading mode (spot)
                side: 'sell',
                ordType: 'market',
                sz: quantity.toString(), // Order quantity (in base currency for sell)
                tgtCcy: 'base_ccy' // Target currency is base currency
            };

            const requestBody = JSON.stringify(orderData);

            // Create authentication headers
            const authHeaders = this._createOKXAuth(
                credentials.apiKey,
                credentials.apiSecret,
                credentials.passphrase,
                timestamp,
                method,
                requestPath,
                requestBody
            );

            const url = `https://www.okx.com${requestPath}`;

            logger.info('Executing OKX sell order', { pair: okxPair, quantity });

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...authHeaders
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for API error in response
            if (result.code !== '0') {
                throw new Error(`OKX sell order failed: ${result.code} - ${result.msg}`);
            }

            const orderResult = result.data[0];

            logger.info('OKX sell order executed successfully', {
                pair: okxPair,
                orderId: orderResult.ordId,
                clientOrderId: orderResult.clOrdId,
                sCode: orderResult.sCode
            });

            return {
                orderId: orderResult.ordId,
                clientOrderId: orderResult.clOrdId,
                status: 'filled',
                pair: okxPair
            };

        } catch (error) {
            logger.error('Failed to execute OKX sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to OKX format (BTCUSDT → BTC-USDT)
     * OKX uses hyphen separator
     * @private
     */
    _convertPairToOKX(pair) {
        // Convert BTCUSDT to BTC-USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}-${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create OKX authentication headers
     * OKX requires passphrase in addition to API key and secret
     * Uses HMAC-SHA256 signature with base64 encoding
     * @private
     */
    _createOKXAuth(apiKey, apiSecret, passphrase, timestamp, method, requestPath, body = '') {
        // OKX signature: HMAC-SHA256 of signing string, base64 encoded
        // Signing string format: timestamp + method + requestPath + body
        const signingString = timestamp + method + requestPath + body;
        const signature = crypto.createHmac('sha256', apiSecret).update(signingString).digest('base64');

        return {
            'OK-ACCESS-KEY': apiKey,
            'OK-ACCESS-SIGN': signature,
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': passphrase
        };
    }

    /**
     * Execute a buy order on MEXC
     * MEXC uses Binance-compatible v3 API
     * @private
     */
    async _executeMEXCBuy(pair, amountUSDT, credentials) {
        try {
            // Prepare order data
            const timestamp = Date.now();
            const orderParams = {
                symbol: pair,
                side: 'BUY',
                type: 'MARKET',
                quoteOrderQty: amountUSDT.toFixed(2), // Buy with USDT amount
                timestamp: timestamp
            };

            const queryString = new URLSearchParams(orderParams).toString();
            const signature = this._createMEXCSignature(queryString, credentials.apiSecret);

            const url = `https://api.mexc.com/api/v3/order?${queryString}&signature=${signature}`;

            logger.info('Executing MEXC buy order', { pair, amountUSDT });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MEXC-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC buy order failed: ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Check for MEXC API error
            if (orderData.code && orderData.code !== 200) {
                throw new Error(`MEXC buy order failed: ${orderData.code} - ${orderData.msg}`);
            }

            logger.info('MEXC buy order executed successfully', {
                pair,
                orderId: orderData.orderId,
                clientOrderId: orderData.clientOrderId,
                executedQty: orderData.executedQty
            });

            return {
                orderId: orderData.orderId,
                clientOrderId: orderData.clientOrderId,
                status: 'filled',
                executedQty: orderData.executedQty,
                pair
            };

        } catch (error) {
            logger.error('Failed to execute MEXC buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on MEXC
     * @private
     */
    async _executeMEXCSell(pair, quantity, credentials) {
        try {
            // Prepare order data
            const timestamp = Date.now();
            const orderParams = {
                symbol: pair,
                side: 'SELL',
                type: 'MARKET',
                quantity: quantity.toString(), // Sell base currency quantity
                timestamp: timestamp
            };

            const queryString = new URLSearchParams(orderParams).toString();
            const signature = this._createMEXCSignature(queryString, credentials.apiSecret);

            const url = `https://api.mexc.com/api/v3/order?${queryString}&signature=${signature}`;

            logger.info('Executing MEXC sell order', { pair, quantity });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MEXC-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC sell order failed: ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Check for MEXC API error
            if (orderData.code && orderData.code !== 200) {
                throw new Error(`MEXC sell order failed: ${orderData.code} - ${orderData.msg}`);
            }

            logger.info('MEXC sell order executed successfully', {
                pair,
                orderId: orderData.orderId,
                clientOrderId: orderData.clientOrderId,
                executedQty: orderData.executedQty
            });

            return {
                orderId: orderData.orderId,
                clientOrderId: orderData.clientOrderId,
                status: 'filled',
                executedQty: orderData.executedQty,
                pair
            };

        } catch (error) {
            logger.error('Failed to execute MEXC sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Create MEXC signature for authentication
     * Uses HMAC-SHA256 signature (lowercase hex)
     * @private
     */
    _createMEXCSignature(queryString, apiSecret) {
        // MEXC signature: HMAC-SHA256 of query string, lowercase hex
        return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    }

    /**
     * Execute a buy order on KuCoin
     * KuCoin requires passphrase and uses hyphen pair format
     * @private
     */
    async _executeKuCoinBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
            const kucoinPair = this._convertPairToKuCoin(pair);

            // Prepare order data
            const timestamp = Date.now().toString();
            const method = 'POST';
            const endpoint = '/api/v1/orders';

            const orderData = {
                clientOid: `${Date.now()}`, // Client order ID
                side: 'buy',
                symbol: kucoinPair,
                type: 'market',
                funds: amountUSDT.toFixed(2) // Use funds for market buy (quote currency)
            };

            const requestBody = JSON.stringify(orderData);

            // Create authentication headers
            const signature = this._createKuCoinSignature(timestamp, method, endpoint, requestBody, credentials.apiSecret);
            const passphrase = this._createKuCoinPassphrase(credentials.passphrase, credentials.apiSecret);

            const url = `https://api.kucoin.com${endpoint}`;

            logger.info('Executing KuCoin buy order', { pair: kucoinPair, amountUSDT });

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KC-API-KEY': credentials.apiKey,
                    'KC-API-SIGN': signature,
                    'KC-API-TIMESTAMP': timestamp,
                    'KC-API-PASSPHRASE': passphrase,
                    'KC-API-KEY-VERSION': '2'
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`KuCoin buy order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for KuCoin API error
            if (result.code !== '200000') {
                throw new Error(`KuCoin buy order failed: ${result.code} - ${result.msg}`);
            }

            logger.info('KuCoin buy order executed successfully', {
                pair: kucoinPair,
                orderId: result.data.orderId
            });

            return {
                orderId: result.data.orderId,
                status: 'filled',
                pair: kucoinPair
            };

        } catch (error) {
            logger.error('Failed to execute KuCoin buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on KuCoin
     * @private
     */
    async _executeKuCoinSell(pair, quantity, credentials) {
        try {
            // Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
            const kucoinPair = this._convertPairToKuCoin(pair);

            // Prepare order data
            const timestamp = Date.now().toString();
            const method = 'POST';
            const endpoint = '/api/v1/orders';

            const orderData = {
                clientOid: `${Date.now()}`, // Client order ID
                side: 'sell',
                symbol: kucoinPair,
                type: 'market',
                size: quantity.toString() // Use size for sell (base currency)
            };

            const requestBody = JSON.stringify(orderData);

            // Create authentication headers
            const signature = this._createKuCoinSignature(timestamp, method, endpoint, requestBody, credentials.apiSecret);
            const passphrase = this._createKuCoinPassphrase(credentials.passphrase, credentials.apiSecret);

            const url = `https://api.kucoin.com${endpoint}`;

            logger.info('Executing KuCoin sell order', { pair: kucoinPair, quantity });

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KC-API-KEY': credentials.apiKey,
                    'KC-API-SIGN': signature,
                    'KC-API-TIMESTAMP': timestamp,
                    'KC-API-PASSPHRASE': passphrase,
                    'KC-API-KEY-VERSION': '2'
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`KuCoin sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for KuCoin API error
            if (result.code !== '200000') {
                throw new Error(`KuCoin sell order failed: ${result.code} - ${result.msg}`);
            }

            logger.info('KuCoin sell order executed successfully', {
                pair: kucoinPair,
                orderId: result.data.orderId
            });

            return {
                orderId: result.data.orderId,
                status: 'filled',
                pair: kucoinPair
            };

        } catch (error) {
            logger.error('Failed to execute KuCoin sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
     * KuCoin uses hyphen separator
     * @private
     */
    _convertPairToKuCoin(pair) {
        // Convert BTCUSDT to BTC-USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}-${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create KuCoin signature for authentication
     * Uses HMAC-SHA256 with base64 encoding
     * @private
     */
    _createKuCoinSignature(timestamp, method, endpoint, body, apiSecret) {
        // KuCoin signature: base64(HMAC-SHA256(timestamp + method + endpoint + body, apiSecret))
        const strForSign = timestamp + method + endpoint + (body || '');
        return crypto.createHmac('sha256', apiSecret).update(strForSign).digest('base64');
    }

    /**
     * Create KuCoin passphrase
     * KuCoin v2 requires passphrase to be encrypted with apiSecret
     * @private
     */
    _createKuCoinPassphrase(passphrase, apiSecret) {
        // KuCoin API v2: passphrase = base64(HMAC-SHA256(passphrase, apiSecret))
        return crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');
    }

    /**
     * Execute a buy order on XT.com
     * XT.com uses unique signature format with lowercase underscore pairs
     * @private
     */
    async _executeXTBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to XT.com format (BTCUSDT → btc_usdt)
            const xtPair = this._convertPairToXT(pair);

            // Prepare order data
            const timestamp = Date.now().toString();
            const orderData = {
                symbol: xtPair,
                side: 'BUY',
                type: 'MARKET',
                quoteQty: amountUSDT.toFixed(2) // Use quoteQty for market buy (USDT amount)
            };

            const signature = this._createXTSignature(credentials.apiKey, timestamp, credentials.apiSecret);

            const url = `https://sapi.xt.com/v4/order`;

            logger.info('Executing XT.com buy order', { pair: xtPair, amountUSDT });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'validate-algorithms': 'HmacSHA256',
                    'validate-appkey': credentials.apiKey,
                    'validate-recvwindow': '60000',
                    'validate-timestamp': timestamp,
                    'validate-signature': signature
                },
                body: JSON.stringify(orderData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`XT.com buy order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for XT.com API error
            if (result.rc !== 0) {
                throw new Error(`XT.com buy order failed: ${result.rc} - ${result.msg}`);
            }

            logger.info('XT.com buy order executed successfully', {
                pair: xtPair,
                orderId: result.result?.orderId
            });

            return {
                orderId: result.result?.orderId,
                status: 'filled',
                pair: xtPair
            };

        } catch (error) {
            logger.error('Failed to execute XT.com buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on XT.com
     * @private
     */
    async _executeXTSell(pair, quantity, credentials) {
        try {
            // Convert pair to XT.com format (BTCUSDT → btc_usdt)
            const xtPair = this._convertPairToXT(pair);

            // Prepare order data
            const timestamp = Date.now().toString();
            const orderData = {
                symbol: xtPair,
                side: 'SELL',
                type: 'MARKET',
                quantity: quantity.toString() // Use quantity for sell (base currency)
            };

            const signature = this._createXTSignature(credentials.apiKey, timestamp, credentials.apiSecret);

            const url = `https://sapi.xt.com/v4/order`;

            logger.info('Executing XT.com sell order', { pair: xtPair, quantity });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'validate-algorithms': 'HmacSHA256',
                    'validate-appkey': credentials.apiKey,
                    'validate-recvwindow': '60000',
                    'validate-timestamp': timestamp,
                    'validate-signature': signature
                },
                body: JSON.stringify(orderData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`XT.com sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for XT.com API error
            if (result.rc !== 0) {
                throw new Error(`XT.com sell order failed: ${result.rc} - ${result.msg}`);
            }

            logger.info('XT.com sell order executed successfully', {
                pair: xtPair,
                orderId: result.result?.orderId
            });

            return {
                orderId: result.result?.orderId,
                status: 'filled',
                pair: xtPair
            };

        } catch (error) {
            logger.error('Failed to execute XT.com sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to XT.com format (BTCUSDT → btc_usdt)
     * XT.com uses lowercase with underscore separator
     * @private
     */
    _convertPairToXT(pair) {
        // Convert BTCUSDT to btc_usdt format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency.toLowerCase()}_${quoteCurrency.toLowerCase()}`;
        }
        return pair.toLowerCase();
    }

    /**
     * Create XT.com signature for authentication
     * Unique signature format: apiKey + "#" + apiSecret + "#" + timestamp
     * @private
     */
    _createXTSignature(apiKey, timestamp, apiSecret) {
        // XT signature: HMAC-SHA256(apiKey + "#" + apiSecret + "#" + timestamp, apiSecret)
        const signString = apiKey + "#" + apiSecret + "#" + timestamp;
        return crypto.createHmac('sha256', apiSecret).update(signString).digest('hex');
    }

    /**
     * Execute a buy order on AscendEX
     * AscendEX requires account group and uses slash pair format
     * @private
     */
    async _executeAscendEXBuy(pair, amountUSDT, credentials) {
        try {
            // Step 1: Get account group
            const accountGroup = await this._getAscendEXAccountGroup(credentials);

            // Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
            const ascendexPair = this._convertPairToAscendEX(pair);

            // Prepare order data
            const timestamp = Date.now().toString();
            const path = `/${accountGroup}/api/pro/v1/cash/order`;
            const orderData = {
                symbol: ascendexPair,
                orderQty: amountUSDT.toFixed(2),
                orderType: 'market',
                side: 'buy',
                respInst: 'ACCEPT'
            };

            const signature = this._createAscendEXSignature(timestamp, path, credentials.apiSecret);

            const url = `https://ascendex.com${path}`;

            logger.info('Executing AscendEX buy order', { pair: ascendexPair, amountUSDT });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'x-auth-key': credentials.apiKey,
                    'x-auth-timestamp': timestamp,
                    'x-auth-signature': signature
                },
                body: JSON.stringify(orderData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AscendEX buy order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for AscendEX API error
            if (result.code !== 0) {
                throw new Error(`AscendEX buy order failed: ${result.code} - ${result.message}`);
            }

            logger.info('AscendEX buy order executed successfully', {
                pair: ascendexPair,
                orderId: result.data?.orderId
            });

            return {
                orderId: result.data?.orderId,
                status: 'filled',
                pair: ascendexPair
            };

        } catch (error) {
            logger.error('Failed to execute AscendEX buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on AscendEX
     * @private
     */
    async _executeAscendEXSell(pair, quantity, credentials) {
        try {
            // Step 1: Get account group
            const accountGroup = await this._getAscendEXAccountGroup(credentials);

            // Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
            const ascendexPair = this._convertPairToAscendEX(pair);

            // Prepare order data
            const timestamp = Date.now().toString();
            const path = `/${accountGroup}/api/pro/v1/cash/order`;
            const orderData = {
                symbol: ascendexPair,
                orderQty: quantity.toString(),
                orderType: 'market',
                side: 'sell',
                respInst: 'ACCEPT'
            };

            const signature = this._createAscendEXSignature(timestamp, path, credentials.apiSecret);

            const url = `https://ascendex.com${path}`;

            logger.info('Executing AscendEX sell order', { pair: ascendexPair, quantity });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'x-auth-key': credentials.apiKey,
                    'x-auth-timestamp': timestamp,
                    'x-auth-signature': signature
                },
                body: JSON.stringify(orderData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AscendEX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for AscendEX API error
            if (result.code !== 0) {
                throw new Error(`AscendEX sell order failed: ${result.code} - ${result.message}`);
            }

            logger.info('AscendEX sell order executed successfully', {
                pair: ascendexPair,
                orderId: result.data?.orderId
            });

            return {
                orderId: result.data?.orderId,
                status: 'filled',
                pair: ascendexPair
            };

        } catch (error) {
            logger.error('Failed to execute AscendEX sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get AscendEX account group
     * Required before making authenticated requests
     * @private
     */
    async _getAscendEXAccountGroup(credentials) {
        try {
            const timestamp = Date.now().toString();
            const path = '/api/pro/v1/info';
            const signature = this._createAscendEXSignature(timestamp, path, credentials.apiSecret);

            const url = `https://ascendex.com${path}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'x-auth-key': credentials.apiKey,
                    'x-auth-timestamp': timestamp,
                    'x-auth-signature': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to get AscendEX account group: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.code !== 0) {
                throw new Error(`Failed to get AscendEX account group: ${result.code} - ${result.message}`);
            }

            return result.data.accountGroup;

        } catch (error) {
            logger.error('Failed to get AscendEX account group', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
     * AscendEX uses slash separator
     * @private
     */
    _convertPairToAscendEX(pair) {
        // Convert BTCUSDT to BTC/USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}/${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create AscendEX signature for authentication
     * Format: timestamp + "+" + api_path
     * @private
     */
    _createAscendEXSignature(timestamp, path, apiSecret) {
        // AscendEX signature: base64(HMAC-SHA256(timestamp + "+" + path, apiSecret))
        const prehashString = timestamp + '+' + path;
        return crypto.createHmac('sha256', apiSecret).update(prehashString).digest('base64');
    }

    /**
     * Execute a buy order on HTX (Huobi)
     * HTX requires account ID and uses unique signature format with hostname
     * @private
     */
    async _executeHTXBuy(pair, amountUSDT, credentials) {
        try {
            // Step 1: Get account ID
            const accountId = await this._getHTXAccountId(credentials);

            // Convert pair to HTX format (BTCUSDT → btcusdt)
            const htxPair = this._convertPairToHTX(pair);

            // Prepare order data
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
            const orderData = {
                'account-id': accountId,
                'symbol': htxPair,
                'type': 'buy-market',
                'amount': amountUSDT.toFixed(2)
            };

            const params = {
                'AccessKeyId': credentials.apiKey,
                'SignatureMethod': 'HmacSHA256',
                'SignatureVersion': '2',
                'Timestamp': timestamp
            };

            const signature = this._createHTXSignature('POST', 'api.huobi.pro', '/v1/order/orders/place', params, credentials.apiSecret);
            params['Signature'] = signature;

            const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
            const url = `https://api.huobi.pro/v1/order/orders/place?${queryString}`;

            logger.info('Executing HTX buy order', { pair: htxPair, amountUSDT });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(orderData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTX buy order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for HTX API error
            if (result.status !== 'ok') {
                throw new Error(`HTX buy order failed: ${result.status} - ${result['err-msg']}`);
            }

            logger.info('HTX buy order executed successfully', {
                pair: htxPair,
                orderId: result.data
            });

            return {
                orderId: result.data,
                status: 'filled',
                pair: htxPair
            };

        } catch (error) {
            logger.error('Failed to execute HTX buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on HTX (Huobi)
     * @private
     */
    async _executeHTXSell(pair, quantity, credentials) {
        try {
            // Step 1: Get account ID
            const accountId = await this._getHTXAccountId(credentials);

            // Convert pair to HTX format (BTCUSDT → btcusdt)
            const htxPair = this._convertPairToHTX(pair);

            // Prepare order data
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
            const orderData = {
                'account-id': accountId,
                'symbol': htxPair,
                'type': 'sell-market',
                'amount': quantity.toString()
            };

            const params = {
                'AccessKeyId': credentials.apiKey,
                'SignatureMethod': 'HmacSHA256',
                'SignatureVersion': '2',
                'Timestamp': timestamp
            };

            const signature = this._createHTXSignature('POST', 'api.huobi.pro', '/v1/order/orders/place', params, credentials.apiSecret);
            params['Signature'] = signature;

            const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
            const url = `https://api.huobi.pro/v1/order/orders/place?${queryString}`;

            logger.info('Executing HTX sell order', { pair: htxPair, quantity });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(orderData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for HTX API error
            if (result.status !== 'ok') {
                throw new Error(`HTX sell order failed: ${result.status} - ${result['err-msg']}`);
            }

            logger.info('HTX sell order executed successfully', {
                pair: htxPair,
                orderId: result.data
            });

            return {
                orderId: result.data,
                status: 'filled',
                pair: htxPair
            };

        } catch (error) {
            logger.error('Failed to execute HTX sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get HTX account ID
     * Required before placing orders
     * @private
     */
    async _getHTXAccountId(credentials) {
        try {
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
            const params = {
                'AccessKeyId': credentials.apiKey,
                'SignatureMethod': 'HmacSHA256',
                'SignatureVersion': '2',
                'Timestamp': timestamp
            };

            const signature = this._createHTXSignature('GET', 'api.huobi.pro', '/v1/account/accounts', params, credentials.apiSecret);
            params['Signature'] = signature;

            const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
            const url = `https://api.huobi.pro/v1/account/accounts?${queryString}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to get HTX account ID: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.status !== 'ok') {
                throw new Error(`Failed to get HTX account ID: ${result.status} - ${result['err-msg']}`);
            }

            // Find spot account
            const spotAccount = result.data.find(account => account.type === 'spot');
            if (!spotAccount) {
                throw new Error('HTX spot account not found');
            }

            return spotAccount.id;

        } catch (error) {
            logger.error('Failed to get HTX account ID', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to HTX format (BTCUSDT → btcusdt)
     * HTX uses lowercase without separator
     * @private
     */
    _convertPairToHTX(pair) {
        // Convert to lowercase
        return pair.toLowerCase();
    }

    /**
     * Create HTX signature for authentication
     * Format: method\nhost\npath\nsorted_params
     * @private
     */
    _createHTXSignature(method, host, path, params, apiSecret) {
        // HTX signature: base64(HMAC-SHA256(method\nhost\npath\nsorted_params, apiSecret))
        const sortedParams = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
        const meta = [method, host, path, sortedParams].join('\n');
        return crypto.createHmac('sha256', apiSecret).update(meta).digest('base64');
    }

    /**
     * Execute a buy order on BingX
     * BingX uses simple HMAC-SHA256 signature with hyphen pair format
     * @private
     */
    async _executeBingXBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to BingX format (BTCUSDT → BTC-USDT)
            const bingxPair = this._convertPairToBingX(pair);

            // Prepare order data
            const timestamp = Date.now();
            const orderParams = {
                symbol: bingxPair,
                side: 'BUY',
                type: 'MARKET',
                quoteOrderQty: amountUSDT.toFixed(2),
                timestamp: timestamp
            };

            const queryString = Object.keys(orderParams).map(key => `${key}=${orderParams[key]}`).join('&');
            const signature = this._createBingXSignature(queryString, credentials.apiSecret);

            const url = `https://open-api.bingx.com/openApi/spot/v1/trade/order?${queryString}&signature=${signature}`;

            logger.info('Executing BingX buy order', { pair: bingxPair, amountUSDT });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-BX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BingX buy order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BingX API error
            if (result.code !== 0) {
                throw new Error(`BingX buy order failed: ${result.code} - ${result.msg}`);
            }

            logger.info('BingX buy order executed successfully', {
                pair: bingxPair,
                orderId: result.data?.orderId
            });

            return {
                orderId: result.data?.orderId,
                status: 'filled',
                pair: bingxPair
            };

        } catch (error) {
            logger.error('Failed to execute BingX buy order', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute a sell order on BingX
     * @private
     */
    async _executeBingXSell(pair, quantity, credentials) {
        try {
            // Convert pair to BingX format (BTCUSDT → BTC-USDT)
            const bingxPair = this._convertPairToBingX(pair);

            // Prepare order data
            const timestamp = Date.now();
            const orderParams = {
                symbol: bingxPair,
                side: 'SELL',
                type: 'MARKET',
                quantity: quantity.toString(),
                timestamp: timestamp
            };

            const queryString = Object.keys(orderParams).map(key => `${key}=${orderParams[key]}`).join('&');
            const signature = this._createBingXSignature(queryString, credentials.apiSecret);

            const url = `https://open-api.bingx.com/openApi/spot/v1/trade/order?${queryString}&signature=${signature}`;

            logger.info('Executing BingX sell order', { pair: bingxPair, quantity });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-BX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BingX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BingX API error
            if (result.code !== 0) {
                throw new Error(`BingX sell order failed: ${result.code} - ${result.msg}`);
            }

            logger.info('BingX sell order executed successfully', {
                pair: bingxPair,
                orderId: result.data?.orderId
            });

            return {
                orderId: result.data?.orderId,
                status: 'filled',
                pair: bingxPair
            };

        } catch (error) {
            logger.error('Failed to execute BingX sell order', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to BingX format (BTCUSDT → BTC-USDT)
     * BingX uses hyphen separator
     * @private
     */
    _convertPairToBingX(pair) {
        // Convert BTCUSDT to BTC-USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}-${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create BingX signature for authentication
     * Uses HMAC-SHA256 signature (lowercase hex)
     * @private
     */
    _createBingXSignature(queryString, apiSecret) {
        // BingX signature: HMAC-SHA256 of query string, lowercase hex
        return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    }

    // ============================================================================
    // BITGET ORDER EXECUTION
    // ============================================================================

    /**
     * Execute Bitget buy order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} amountUSDT - Amount in USDT to spend
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeBitgetBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
            const bitgetPair = this._convertPairToBitget(pair);

            // Get current price to calculate quantity
            const currentPrice = await this._fetchBitgetPrice(bitgetPair);
            const quantity = (amountUSDT / currentPrice).toFixed(8);

            // Bitget requires timestamp + method + requestPath + body for signature
            const timestamp = Date.now().toString();
            const method = 'POST';
            const requestPath = '/api/spot/v1/trade/orders';

            // Order payload
            const orderData = {
                symbol: bitgetPair,
                side: 'buy',
                orderType: 'market',
                force: 'gtc',
                size: quantity
            };

            const body = JSON.stringify(orderData);
            const signature = this._createBitgetSignature(timestamp, method, requestPath, body, credentials.apiSecret);

            const url = `https://api.bitget.com${requestPath}`;

            logger.info('Executing Bitget buy order', {
                pair: bitgetPair,
                amountUSDT,
                quantity,
                currentPrice
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ACCESS-KEY': credentials.apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': credentials.passphrase
                },
                body: body
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitget API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitget API error
            if (result.code !== '00000') {
                throw new Error(`Bitget order error: ${result.code} - ${result.msg}`);
            }

            logger.info('Bitget buy order executed successfully', {
                pair: bitgetPair,
                orderId: result.data?.orderId,
                fillSize: result.data?.fillSize
            });

            return {
                success: true,
                exchange: 'bitget',
                orderId: result.data?.orderId,
                pair: bitgetPair,
                side: 'buy',
                quantity: parseFloat(result.data?.fillSize || quantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('Bitget buy order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Bitget sell order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} quantity - Quantity of base currency to sell
     * @param {object} credentials - { apiKey, apiSecret, passphrase }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeBitgetSell(pair, quantity, credentials) {
        try {
            // Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
            const bitgetPair = this._convertPairToBitget(pair);

            // Bitget requires timestamp + method + requestPath + body for signature
            const timestamp = Date.now().toString();
            const method = 'POST';
            const requestPath = '/api/spot/v1/trade/orders';

            // Order payload
            const orderData = {
                symbol: bitgetPair,
                side: 'sell',
                orderType: 'market',
                force: 'gtc',
                size: quantity.toFixed(8)
            };

            const body = JSON.stringify(orderData);
            const signature = this._createBitgetSignature(timestamp, method, requestPath, body, credentials.apiSecret);

            const url = `https://api.bitget.com${requestPath}`;

            logger.info('Executing Bitget sell order', {
                pair: bitgetPair,
                quantity
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'ACCESS-KEY': credentials.apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': credentials.passphrase
                },
                body: body
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitget API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitget API error
            if (result.code !== '00000') {
                throw new Error(`Bitget order error: ${result.code} - ${result.msg}`);
            }

            // Get current price for logging
            const currentPrice = await this._fetchBitgetPrice(bitgetPair);

            logger.info('Bitget sell order executed successfully', {
                pair: bitgetPair,
                orderId: result.data?.orderId,
                fillSize: result.data?.fillSize
            });

            return {
                success: true,
                exchange: 'bitget',
                orderId: result.data?.orderId,
                pair: bitgetPair,
                side: 'sell',
                quantity: parseFloat(result.data?.fillSize || quantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('Bitget sell order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current price from Bitget
     * @param {string} bitgetPair - Trading pair in Bitget format (e.g., 'BTCUSDT_SPBL')
     * @returns {Promise<number>} Current price
     * @private
     */
    async _fetchBitgetPrice(bitgetPair) {
        const response = await fetch(`https://api.bitget.com/api/spot/v1/market/ticker?symbol=${bitgetPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Bitget price: ${response.status}`);
        }

        const result = await response.json();

        if (result.code !== '00000') {
            throw new Error(`Bitget price error: ${result.code} - ${result.msg}`);
        }

        return parseFloat(result.data?.close || 0);
    }

    /**
     * Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
     * Bitget uses _SPBL suffix for spot balance pairs
     * @private
     */
    _convertPairToBitget(pair) {
        // Add _SPBL suffix for Bitget spot trading
        return `${pair}_SPBL`;
    }

    /**
     * Create Bitget signature for authentication
     * Format: timestamp + method + requestPath + body
     * Uses HMAC-SHA256 signature (base64)
     * @private
     */
    _createBitgetSignature(timestamp, method, requestPath, body, apiSecret) {
        // Bitget signature: base64(HMAC-SHA256(timestamp + method + requestPath + body, apiSecret))
        const message = timestamp + method.toUpperCase() + requestPath + (body || '');
        return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
    }

    // ============================================================================
    // BITMART ORDER EXECUTION
    // ============================================================================

    /**
     * Execute BitMart buy order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} amountUSDT - Amount in USDT to spend
     * @param {object} credentials - { apiKey, apiSecret, memo }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeBitMartBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to BitMart format (BTCUSDT → BTC_USDT)
            const bitmartPair = this._convertPairToBitMart(pair);

            // Get current price to calculate quantity
            const currentPrice = await this._fetchBitMartPrice(bitmartPair);
            const quantity = (amountUSDT / currentPrice).toFixed(8);

            // BitMart requires timestamp + '#' + memo + '#' + body for signature
            const timestamp = Date.now().toString();

            // Order payload
            const orderData = {
                symbol: bitmartPair,
                side: 'buy',
                type: 'market',
                size: quantity
            };

            const body = JSON.stringify(orderData);
            // For POST requests with body, the queryString is the body itself
            const signature = this._createBitMartSignature(timestamp, credentials.memo || '', body, credentials.apiSecret);

            const url = `${this.baseUrl}/spot/v2/submit_order`;

            logger.info('Executing BitMart buy order', {
                pair: bitmartPair,
                amountUSDT,
                quantity,
                currentPrice
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BM-KEY': credentials.apiKey,
                    'X-BM-SIGN': signature,
                    'X-BM-TIMESTAMP': timestamp,
                    'X-BM-MEMO': credentials.memo || ''
                },
                body: body
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BitMart API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BitMart API error
            if (result.code !== 1000) {
                throw new Error(`BitMart order error: ${result.code} - ${result.message}`);
            }

            logger.info('BitMart buy order executed successfully', {
                pair: bitmartPair,
                orderId: result.data?.order_id
            });

            return {
                success: true,
                exchange: 'bitmart',
                orderId: result.data?.order_id,
                pair: bitmartPair,
                side: 'buy',
                quantity: parseFloat(quantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('BitMart buy order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute BitMart sell order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} quantity - Quantity of base currency to sell
     * @param {object} credentials - { apiKey, apiSecret, memo }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeBitMartSell(pair, quantity, credentials) {
        try {
            // Convert pair to BitMart format (BTCUSDT → BTC_USDT)
            const bitmartPair = this._convertPairToBitMart(pair);

            // BitMart requires timestamp + '#' + memo + '#' + body for signature
            const timestamp = Date.now().toString();

            // Order payload
            const orderData = {
                symbol: bitmartPair,
                side: 'sell',
                type: 'market',
                size: quantity.toFixed(8)
            };

            const body = JSON.stringify(orderData);
            // For POST requests with body, the queryString is the body itself
            const signature = this._createBitMartSignature(timestamp, credentials.memo || '', body, credentials.apiSecret);

            const url = `https://api-cloud.bitmart.com/spot/v2/submit_order`;

            logger.info('Executing BitMart sell order', {
                pair: bitmartPair,
                quantity
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BM-KEY': credentials.apiKey,
                    'X-BM-SIGN': signature,
                    'X-BM-TIMESTAMP': timestamp,
                    'X-BM-MEMO': credentials.memo || ''
                },
                body: body
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BitMart API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BitMart API error
            if (result.code !== 1000) {
                throw new Error(`BitMart order error: ${result.code} - ${result.message}`);
            }

            // Get current price for logging
            const currentPrice = await this._fetchBitMartPrice(bitmartPair);

            logger.info('BitMart sell order executed successfully', {
                pair: bitmartPair,
                orderId: result.data?.order_id
            });

            return {
                success: true,
                exchange: 'bitmart',
                orderId: result.data?.order_id,
                pair: bitmartPair,
                side: 'sell',
                quantity: parseFloat(quantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('BitMart sell order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current price from BitMart
     * @param {string} bitmartPair - Trading pair in BitMart format (e.g., 'BTC_USDT')
     * @returns {Promise<number>} Current price
     * @private
     */
    async _fetchBitMartPrice(bitmartPair) {
        const response = await fetch(`https://api-cloud.bitmart.com/spot/v1/ticker?symbol=${bitmartPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch BitMart price: ${response.status}`);
        }

        const result = await response.json();

        if (result.code !== 1000) {
            throw new Error(`BitMart price error: ${result.code} - ${result.message}`);
        }

        return parseFloat(result.data?.last_price || 0);
    }

    /**
     * Convert pair to BitMart format (BTCUSDT → BTC_USDT)
     * BitMart uses underscore separator
     * @private
     */
    _convertPairToBitMart(pair) {
        // Convert BTCUSDT to BTC_USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    /**
     * Create BitMart signature for authentication
     * Format: timestamp + '#' + memo + '#' + queryString
     * Uses HMAC-SHA256 signature (hex)
     * @private
     */
    _createBitMartSignature(timestamp, memo, queryString, apiSecret) {
        // BitMart signature: hex(HMAC-SHA256(timestamp + '#' + memo + '#' + queryString, apiSecret))
        const message = timestamp + '#' + (memo || '') + '#' + (queryString || '');
        return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
    }

    // ============================================================================
    // BITRUE ORDER EXECUTION
    // ============================================================================

    /**
     * Execute Bitrue buy order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} amountUSDT - Amount in USDT to spend
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeBitrueBuy(pair, amountUSDT, credentials) {
        try {
            // Get current price to calculate quantity
            const currentPrice = await this._fetchBitruePrice(pair);
            const quantity = (amountUSDT / currentPrice).toFixed(8);

            // Bitrue uses Binance-compatible API
            const timestamp = Date.now();

            // Order parameters
            const orderParams = {
                symbol: pair,
                side: 'BUY',
                type: 'MARKET',
                quantity: quantity,
                timestamp: timestamp.toString()
            };

            const queryString = new URLSearchParams(orderParams).toString();
            const signature = this._createBitrueSignature(queryString, credentials.apiSecret);

            const url = `https://openapi.bitrue.com/api/v1/order?${queryString}&signature=${signature}`;

            logger.info('Executing Bitrue buy order', {
                pair,
                amountUSDT,
                quantity,
                currentPrice
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitrue API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitrue API error
            if (result.code && result.code < 0) {
                throw new Error(`Bitrue order error: ${result.code} - ${result.msg}`);
            }

            logger.info('Bitrue buy order executed successfully', {
                pair,
                orderId: result.orderId,
                executedQty: result.executedQty
            });

            return {
                success: true,
                exchange: 'bitrue',
                orderId: result.orderId,
                pair: pair,
                side: 'buy',
                quantity: parseFloat(result.executedQty || quantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('Bitrue buy order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Bitrue sell order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @param {number} quantity - Quantity of base currency to sell
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeBitrueSell(pair, quantity, credentials) {
        try {
            // Bitrue uses Binance-compatible API
            const timestamp = Date.now();

            // Order parameters
            const orderParams = {
                symbol: pair,
                side: 'SELL',
                type: 'MARKET',
                quantity: quantity.toFixed(8),
                timestamp: timestamp.toString()
            };

            const queryString = new URLSearchParams(orderParams).toString();
            const signature = this._createBitrueSignature(queryString, credentials.apiSecret);

            const url = `https://openapi.bitrue.com/api/v1/order?${queryString}&signature=${signature}`;

            logger.info('Executing Bitrue sell order', {
                pair,
                quantity
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitrue API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitrue API error
            if (result.code && result.code < 0) {
                throw new Error(`Bitrue order error: ${result.code} - ${result.msg}`);
            }

            // Get current price for logging
            const currentPrice = await this._fetchBitruePrice(pair);

            logger.info('Bitrue sell order executed successfully', {
                pair,
                orderId: result.orderId,
                executedQty: result.executedQty
            });

            return {
                success: true,
                exchange: 'bitrue',
                orderId: result.orderId,
                pair: pair,
                side: 'sell',
                quantity: parseFloat(result.executedQty || quantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('Bitrue sell order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current price from Bitrue
     * @param {string} pair - Trading pair (e.g., 'BTCUSDT')
     * @returns {Promise<number>} Current price
     * @private
     */
    async _fetchBitruePrice(pair) {
        const response = await fetch(`https://openapi.bitrue.com/api/v1/ticker/24hr?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Bitrue price: ${response.status}`);
        }

        const result = await response.json();

        // Check for error
        if (result.code && result.code < 0) {
            throw new Error(`Bitrue price error: ${result.code} - ${result.msg}`);
        }

        return parseFloat(result.lastPrice || 0);
    }

    /**
     * Create Bitrue signature for authentication
     * Uses HMAC-SHA256 signature (hex) - Binance-compatible
     * @private
     */
    _createBitrueSignature(queryString, apiSecret) {
        // Bitrue signature: HMAC-SHA256 of query string, lowercase hex (Binance-compatible)
        return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    }
}

module.exports = OrderExecutionService;
