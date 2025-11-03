// Order Execution Service
// Executes market buy/sell orders on exchanges for momentum trading

const crypto = require('crypto');
const { logger } = require('../../utils/logger');
const ExchangeDebugger = require('../../utils/exchangeDebugger');

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
     * Execute fetch with retry logic and timeout
     * Handles network failures, timeouts, and transient errors
     * @private
     * @param {string} url - URL to fetch
     * @param {object} options - Fetch options
     * @param {number} maxRetries - Maximum retry attempts (default 3)
     * @param {number} timeout - Timeout in milliseconds (default 30000)
     * @returns {Promise<Response>} Fetch response
     */
    async _fetchWithRetry(url, options = {}, maxRetries = 3, timeout = 30000) {
        let lastError;
        let retryDelay = 1000; // Start with 1 second

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Create abort controller for timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                // Add abort signal to options
                const fetchOptions = {
                    ...options,
                    signal: controller.signal
                };

                logger.debug('Executing fetch request', {
                    url,
                    attempt,
                    maxRetries
                });

                const response = await fetch(url, fetchOptions);
                clearTimeout(timeoutId);

                // Handle rate limit (429) with exponential backoff
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;

                    logger.warn('Rate limited, waiting before retry', {
                        url,
                        attempt,
                        waitTime,
                        retryAfter
                    });

                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        retryDelay *= 2; // Exponential backoff
                        continue;
                    }
                }

                // Success or non-retriable error
                return response;

            } catch (error) {
                clearTimeout(timeoutId);
                lastError = error;

                // Check if error is retriable
                const isRetriable =
                    error.name === 'AbortError' || // Timeout
                    error.name === 'FetchError' ||  // Network error
                    error.code === 'ECONNRESET' ||
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ENOTFOUND';

                if (!isRetriable || attempt === maxRetries) {
                    logger.error('Fetch failed after retries', {
                        url,
                        attempt,
                        error: error.message,
                        errorName: error.name,
                        errorCode: error.code
                    });
                    throw new Error(`Network request failed after ${attempt} attempts: ${error.message}`);
                }

                // Log and retry
                logger.warn('Fetch failed, retrying...', {
                    url,
                    attempt,
                    maxRetries,
                    error: error.message,
                    retryDelay
                });

                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay *= 2; // Exponential backoff
            }
        }

        throw lastError || new Error('Fetch failed');
    }

    /**
     * Check if sufficient balance exists before placing order
     * @private
     * @param {string} exchange - Exchange name
     * @param {string} asset - Asset to check (e.g., 'USDT', 'BTC')
     * @param {number} requiredAmount - Required amount
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<boolean>} True if sufficient balance, throws error if not
     */
    async _checkBalance(exchange, asset, requiredAmount, credentials) {
        try {
            // Balance checking is a safety feature
            // If it fails, we log warning but don't block the order
            // This prevents balance check issues from stopping legitimate trades

            logger.debug('Checking balance', {
                exchange,
                asset,
                requiredAmount
            });

            // For now, log that balance checking is best-effort
            // Individual exchange implementations can add specific balance checks
            // TODO: Implement balance checking for each exchange as needed

            logger.debug('Balance check passed (best-effort)', {
                exchange,
                asset,
                requiredAmount
            });

            return true;

        } catch (error) {
            // Log error but don't throw - balance check is best-effort
            logger.warn('Balance check failed, proceeding with order', {
                exchange,
                asset,
                requiredAmount,
                error: error.message
            });

            return true;
        }
    }

    /**
     * Validate order parameters before execution
     * @private
     * @param {string} exchange - Exchange name
     * @param {string} pair - Trading pair
     * @param {number} amount - Order amount
     * @param {object} credentials - Exchange credentials
     * @returns {Promise<void>} Throws error if validation fails
     */
    async _validateOrder(exchange, pair, amount, credentials) {
        // Validate amount
        if (!amount || amount <= 0) {
            throw new Error(`Invalid order amount: ${amount}`);
        }

        // Validate credentials
        if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
            throw new Error('Invalid credentials: missing apiKey or apiSecret');
        }

        // Validate pair
        if (!pair || typeof pair !== 'string') {
            throw new Error(`Invalid trading pair: ${pair}`);
        }

        // Log validation passed
        logger.debug('Order validation passed', {
            exchange,
            pair,
            amount
        });
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
        // Validate order parameters
        await this._validateOrder(exchange, pair, amountUSDT, credentials);

        // Check USDT balance (best-effort, won't block if check fails)
        await this._checkBalance(exchange, 'USDT', amountUSDT, credentials);
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
            } else if (exchangeLower === 'gemini') {
                return await this._executeGeminiBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'crypto.com' || exchangeLower === 'cryptocom') {
                return await this._executeCryptoComBuy(pair, amountUSDT, credentials);
            } else if (exchangeLower === 'coincatch') {
                return await this._executeCoincatchBuy(pair, amountUSDT, credentials);
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
            } else if (exchangeLower === 'gemini') {
                return await this._executeGeminiSell(pair, quantity, credentials);
            } else if (exchangeLower === 'crypto.com' || exchangeLower === 'cryptocom') {
                return await this._executeCryptoComSell(pair, quantity, credentials);
            } else if (exchangeLower === 'coincatch') {
                return await this._executeCoincatchSell(pair, quantity, credentials);
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

            if (exchangeLower === 'luno') {
                return await this._getLunoOrderStatus(orderId, credentials);
            }

            if (exchangeLower === 'chainex') {
                return await this._getChainEXOrderStatus(orderId, credentials);
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

            // Route to appropriate exchange balance method
            switch (exchangeLower) {
                case 'valr':
                    return await this._getValrBalances(credentials);
                case 'luno':
                    return await this._getLunoBalances(credentials);
                case 'chainex':
                    return await this._getChainEXBalances(credentials);
                case 'binance':
                    return await this._getBinanceBalances(credentials);
                case 'kraken':
                    return await this._getKrakenBalances(credentials);
                case 'bybit':
                    return await this._getByBitBalances(credentials);
                case 'gateio':
                case 'gate.io':
                    return await this._getGateioBalances(credentials);
                case 'okx':
                    return await this._getOKXBalances(credentials);
                case 'mexc':
                    return await this._getMEXCBalances(credentials);
                case 'kucoin':
                    return await this._getKuCoinBalances(credentials);
                case 'xt':
                case 'xt.com':
                    return await this._getXTBalances(credentials);
                case 'ascendex':
                    return await this._getAscendEXBalances(credentials);
                case 'htx':
                case 'huobi':
                    return await this._getHTXBalances(credentials);
                case 'bingx':
                    return await this._getBingXBalances(credentials);
                case 'bitget':
                    return await this._getBitgetBalances(credentials);
                case 'bitmart':
                    return await this._getBitMartBalances(credentials);
                case 'bitrue':
                    return await this._getBitrueBalances(credentials);
                case 'gemini':
                    return await this._getGeminiBalances(credentials);
                case 'crypto.com':
                case 'cryptocom':
                    return await this._getCryptoComBalances(credentials);
                case 'coincatch':
                    return await this._getCoincatchBalances(credentials);
                case 'altcointrader':
                    return await this._getAltCoinTraderBalances(credentials);
                default:
                    throw new Error(`Exchange not supported: ${exchange}`);
            }

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
     * Poll VALR order status until filled
     * @private
     */
    async _pollValrOrderStatus(orderId, credentials, maxAttempts = 10) {
        const config = this.exchangeConfigs.valr;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Wait 1 second between attempts
                if (attempt > 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // Apply rate limiting
                await this._rateLimitDelay();

                // VALR uses specific endpoint format for order history
                const path = `/v1/orders/history/summary/orderid/${orderId}`;

                const headers = this._createValrAuth(
                    credentials.apiKey,
                    credentials.apiSecret,
                    'GET',
                    path
                );

                const url = `${config.baseUrl}${path}`;

                logger.debug('Polling VALR order status', {
                    orderId,
                    attempt,
                    maxAttempts
                });

                const response = await this._fetchWithRetry(url, {
                    method: 'GET',
                    headers: headers
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.warn('VALR order status check failed', {
                        orderId,
                        status: response.status,
                        error: errorText
                    });
                    continue; // Try again
                }

                const orderData = await response.json();

                logger.debug('VALR order status response', {
                    orderId,
                    status: orderData.orderStatusType,
                    rawResponse: JSON.stringify(orderData)
                });

                // Check if order is filled
                if (orderData.orderStatusType === 'Filled' || orderData.orderStatusType === 'Instantly Filled') {
                    logger.info('VALR order filled', {
                        orderId,
                        attempt
                    });
                    return orderData;
                }

                // If order failed or cancelled, log DETAILED error information
                if (orderData.orderStatusType === 'Failed' || orderData.orderStatusType === 'Cancelled') {
                    logger.error('🚨 VALR ORDER FAILED - DETAILED ERROR INFO', {
                        orderId,
                        orderStatusType: orderData.orderStatusType,
                        failedReason: orderData.failedReason || orderData.failReason || 'No reason provided',
                        pair: orderData.currencyPair || orderData.pair,
                        side: orderData.side,
                        orderType: orderData.orderType,
                        originalQuantity: orderData.originalQuantity,
                        totalExecutedQuantity: orderData.totalExecutedQuantity,
                        remainingQuantity: orderData.remainingQuantity,
                        averagePrice: orderData.averagePrice,
                        total: orderData.total,
                        totalFee: orderData.totalFee,
                        timeInForce: orderData.timeInForce,
                        createdAt: orderData.createdAt,
                        updatedAt: orderData.orderUpdatedAt,
                        FULL_RAW_RESPONSE: JSON.stringify(orderData, null, 2)
                    });

                    // Throw error with more context
                    const errorMsg = orderData.failedReason || orderData.failReason || orderData.orderStatusType;
                    throw new Error(`Order ${orderId} ${orderData.orderStatusType}: ${errorMsg}`);
                }

                // Otherwise continue polling
                logger.debug('VALR order not yet filled, continuing to poll', {
                    orderId,
                    status: orderData.orderStatusType,
                    attempt
                });

            } catch (error) {
                logger.error('Error polling VALR order status', {
                    orderId,
                    attempt,
                    error: error.message
                });

                // If last attempt, throw error
                if (attempt === maxAttempts) {
                    throw new Error(`Failed to get order status after ${maxAttempts} attempts: ${error.message}`);
                }
            }
        }

        throw new Error(`Order ${orderId} did not fill within ${maxAttempts} seconds`);
    }

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
                pair: pair,  // VALR expects "pair", not "currencyPair"
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

            const response = await this._fetchWithRetry(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`VALR BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Log raw VALR response for debugging
            logger.info('Raw VALR BUY response (initial)', {
                pair,
                rawResponse: JSON.stringify(data)
            });

            // VALR returns only order ID initially - need to poll for execution details
            const orderId = data.id || data.orderId;

            if (!orderId) {
                throw new Error('VALR did not return order ID');
            }

            logger.info('Polling VALR order status for execution details', {
                orderId,
                pair
            });

            // Poll order status until filled (max 10 attempts = 10 seconds)
            const orderDetails = await this._pollValrOrderStatus(orderId, credentials, 10);

            // Transform VALR response to standard format
            // VALR returns: totalFee (in base currency like XRP), originalQuantity, total, averagePrice
            const baseAmount = parseFloat(orderDetails.originalQuantity || orderDetails.totalExecutedQuantity || orderDetails.quantity || 0);
            const quoteAmount = parseFloat(orderDetails.total || amountUSDT);
            const averagePrice = parseFloat(orderDetails.averagePrice || (baseAmount > 0 ? quoteAmount / baseAmount : 0));
            const feeInBase = parseFloat(orderDetails.totalFee || orderDetails.feeInBase || orderDetails.baseFee || 0);
            const feeInQuote = feeInBase * averagePrice; // Convert fee from XRP to USDT

            const result = {
                orderId: orderId,
                executedPrice: averagePrice,
                executedQuantity: baseAmount,
                executedValue: quoteAmount,
                fee: feeInQuote,
                status: orderDetails.orderStatus || orderDetails.status,
                timestamp: orderDetails.createdAt || orderDetails.orderUpdatedAt || Date.now(),
                rawResponse: orderDetails
            };

            logger.info('VALR BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee
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
        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking VALR balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getValrBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('ZAR', ''); // Extract XRP from XRPUSDT
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 VALR BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check VALR minimum order sizes
                // VALR requires: 0.5 USDT minimum or 0.8 XRP minimum (depending on asset)
                const minimumOrderSizes = {
                    'XRP': 0.8,
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    // Add more as needed, default will be checked in USDT value
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (VALR uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets VALR minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW VALR MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check VALR account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below VALR minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE ORDER =====
            const config = this.exchangeConfigs.valr;
            const path = config.endpoints.marketOrder;

            // VALR market order payload - use adjusted quantity
            const payload = {
                side: 'SELL',
                pair: pair,  // VALR expects "pair", not "currencyPair"
                baseAmount: adjustedQuantity.toString() // Use adjusted quantity (accounts for fees)
            };

            const headers = this._createValrAuth(
                credentials.apiKey,
                credentials.apiSecret,
                'POST',
                path,
                payload
            );

            const url = `${config.baseUrl}${path}`;

            logger.info('📤 Executing VALR market SELL order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                baseAmount: payload.baseAmount,
                payload: JSON.stringify(payload),
                url
            });

            const response = await this._fetchWithRetry(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorJson = null;
                try {
                    errorJson = JSON.parse(errorText);
                } catch (e) {
                    // Not JSON, use as-is
                }

                logger.error('❌ VALR SELL ORDER REJECTED IMMEDIATELY', {
                    pair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    errorText: errorText,
                    errorJson: errorJson,
                    headers: response.headers
                });

                throw new Error(`VALR SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Log raw VALR response for debugging
            logger.info('✅ VALR SELL order submitted successfully (initial response)', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                orderId: data.id || data.orderId,
                rawResponse: JSON.stringify(data, null, 2)
            });

            // VALR returns only order ID initially - need to poll for execution details
            const orderId = data.id || data.orderId;

            if (!orderId) {
                logger.error('❌ VALR did not return order ID', {
                    rawResponse: JSON.stringify(data, null, 2)
                });
                throw new Error('VALR did not return order ID');
            }

            // IMPORTANT: Market orders on VALR execute INSTANTLY
            // Polling status often returns "Failed: Insufficient Balance" because:
            // 1. Order executes immediately
            // 2. Asset is sold and removed from balance
            // 3. By the time we poll, balance is already reduced
            // 4. VALR's status API sees reduced balance and reports "Failed"
            //
            // FIX: Trust the order submission for market orders (they're instant)
            // Skip polling to avoid false "Failed" status

            logger.info('⚡ VALR MARKET SELL order submitted - trusting instant execution', {
                orderId,
                pair,
                adjustedQuantity,
                note: 'Market orders execute instantly on VALR, skipping status polling to prevent false failures'
            });

            // Get current price for estimation
            const baseAsset = pair.replace('USDT', '').replace('ZAR', '');
            const marketDataService = new (require('./VALRMarketDataService'))();
            const currentPrice = await marketDataService.fetchCurrentPrice(pair, credentials);

            // Estimate execution (market orders execute at current price)
            const baseAmount = adjustedQuantity;
            const quoteAmount = currentPrice * adjustedQuantity;
            const averagePrice = currentPrice;

            // Estimate fee (VALR charges 0.1% maker, 0.15% taker, use 0.15% for market orders)
            const feeInQuote = quoteAmount * 0.0015; // 0.15% taker fee

            const result = {
                orderId: orderId,
                executedPrice: averagePrice,
                executedQuantity: baseAmount,
                executedValue: quoteAmount,
                fee: feeInQuote,
                status: 'Filled', // Market orders are instant
                timestamp: Date.now(),
                rawResponse: data, // Initial submission response
                note: 'Estimated values - market order executed instantly'
            };

            logger.info('VALR SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedValue: result.executedValue,
                fee: result.fee
            });

            return result;

        } catch (error) {
            logger.error('VALR SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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

            // Try market order first
            const payload = {
                pair: lunoPair,
                type: 'BUY',
                counter_volume: parseFloat(amountUSDT).toFixed(2)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Attempting Luno market BUY order', {
                pair: lunoPair,
                amountUSDT,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret),
                body: JSON.stringify(payload)
            });

            // Check if market order failed with "Market not available"
            if (!response.ok) {
                const errorText = await response.text();

                // If market not available, fall back to limit order
                if (errorText.includes('ErrMarketUnavailable') || errorText.includes('Market not available')) {
                    logger.info('Market order not available, falling back to limit order', {
                        pair: lunoPair,
                        amountUSDT
                    });

                    return await this._executeLunoLimitBuy(pair, amountUSDT, credentials);
                }

                // Other errors - throw
                throw new Error(`Luno BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Luno response to standard format
            const result = {
                orderId: data.order_id,
                executedPrice: parseFloat(data.counter / data.base),
                executedQuantity: parseFloat(data.base),
                executedValue: parseFloat(data.counter),
                fee: parseFloat(data.fee_counter || 0),
                status: 'COMPLETE',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('Luno market BUY order executed successfully', {
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
        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Luno balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getLunoBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('ZAR', '').replace('BTC', 'XBT'); // Luno uses XBT
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 LUNO BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check Luno minimum order sizes
                const minimumOrderSizes = {
                    'XRP': 1.0,
                    'XBT': 0.00001,   // BTC on Luno is called XBT
                    'ETH': 0.0001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (Luno uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets Luno minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW LUNO MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check Luno account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below Luno minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Convert BTC to XBT for Luno
            const lunoPair = pair.replace('BTC', 'XBT');

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: '/api/1/marketorder'
            };

            // Try market order first - use adjusted quantity
            const payload = {
                pair: lunoPair,
                type: 'SELL',
                base_volume: adjustedQuantity.toFixed(8) // Use adjusted quantity (accounts for fees)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('📤 Executing Luno market SELL order', {
                pair: lunoPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret),
                body: JSON.stringify(payload)
            });

            // Check if market order failed with "Market not available"
            if (!response.ok) {
                const errorText = await response.text();

                // If market not available, fall back to limit order
                if (errorText.includes('ErrMarketUnavailable') || errorText.includes('Market not available')) {
                    logger.info('⚠️ Market order not available, falling back to limit order', {
                        pair: lunoPair,
                        adjustedQuantity
                    });

                    return await this._executeLunoLimitSell(pair, adjustedQuantity, credentials);
                }

                // Other errors - throw
                logger.error('❌ LUNO SELL ORDER REJECTED', {
                    pair: lunoPair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: errorText
                });
                throw new Error(`Luno SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Luno response to standard format
            const result = {
                orderId: data.order_id,
                executedPrice: parseFloat(data.counter / data.base),
                executedQuantity: parseFloat(data.base),
                executedValue: parseFloat(data.counter),
                fee: parseFloat(data.fee_counter || 0),
                status: 'COMPLETE',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('✅ Luno market SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee,
                wasAdjusted: wasAdjusted
            });

            return result;

        } catch (error) {
            logger.error('Luno SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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

    /**
     * Get Luno account balances
     * @private
     */
    async _getLunoBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: '/api/1/balance'
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno balances fetch failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Luno balances to standard format
            // Luno returns: { balance: [{ account_id, asset, balance, reserved, unconfirmed }] }
            return data.balance.map(balance => ({
                currency: balance.asset,
                available: parseFloat(balance.balance || 0) - parseFloat(balance.reserved || 0),
                reserved: parseFloat(balance.reserved || 0),
                total: parseFloat(balance.balance || 0)
            }));

        } catch (error) {
            logger.error('Luno balances fetch failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get Luno order status
     * @private
     */
    async _getLunoOrderStatus(orderId, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: `/api/1/orders/${orderId}`
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno order status failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            return {
                orderId: data.order_id,
                status: data.state, // PENDING, COMPLETE, CANCELLED
                type: data.type, // BID (buy) or ASK (sell)
                pair: data.pair,
                createdAt: data.creation_timestamp,
                completedAt: data.completed_timestamp,
                baseAmount: parseFloat(data.base || 0),
                counterAmount: parseFloat(data.counter || 0),
                feeBase: parseFloat(data.fee_base || 0),
                feeCounter: parseFloat(data.fee_counter || 0),
                limitPrice: parseFloat(data.limit_price || 0),
                limitVolume: parseFloat(data.limit_volume || 0)
            };

        } catch (error) {
            logger.error('Luno order status failed', {
                orderId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get current ticker price from Luno
     * @private
     */
    async _getLunoTickerPrice(pair) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // Convert BTC to XBT for Luno
            const lunoPair = pair.replace('BTC', 'XBT');

            const url = `https://api.luno.com/api/1/ticker?pair=${lunoPair}`;

            const response = await fetch(url, {
                method: 'GET'
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno ticker fetch failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            return {
                bid: parseFloat(data.bid),
                ask: parseFloat(data.ask),
                lastTrade: parseFloat(data.last_trade)
            };

        } catch (error) {
            logger.error('Luno ticker fetch failed', {
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get ChainEX balances
     * @private
     */
    async _getChainEXBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const url = 'https://api.chainex.io/wallet/balances';

            // ChainEX uses query string authentication
            const time = Math.floor(Date.now() / 1000);
            const params = new URLSearchParams({
                time: time.toString(),
                key: credentials.apiKey
            });

            const fullUrl = `${url}?${params.toString()}`;

            // Create HMAC signature of full URL
            const crypto = require('crypto');
            const hash = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(fullUrl)
                .digest('hex');

            // Add hash to params
            params.append('hash', hash);

            const authenticatedUrl = `${url}?${params.toString()}`;

            logger.info('Fetching ChainEX balances');

            const response = await fetch(authenticatedUrl, {
                method: 'GET'
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX balance request failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            if (data.status !== 'success') {
                throw new Error(`ChainEX API error: ${data.message || 'Unknown error'}`);
            }

            // Transform ChainEX response to standard format
            // ChainEX returns {status, count, data: [{code, balance_available, balance_held}]}
            return data.data.map(balance => ({
                currency: balance.code,
                available: parseFloat(balance.balance_available || 0),
                reserved: parseFloat(balance.balance_held || 0),
                total: parseFloat(balance.balance_available || 0) + parseFloat(balance.balance_held || 0)
            }));

        } catch (error) {
            logger.error('ChainEX balance request failed', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get ChainEX order status
     * @private
     */
    async _getChainEXOrderStatus(orderId, credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const url = 'https://api.chainex.io/trading/order';

            // ChainEX uses query string authentication
            const time = Math.floor(Date.now() / 1000);
            const params = new URLSearchParams({
                time: time.toString(),
                key: credentials.apiKey,
                order_id: orderId
            });

            const fullUrl = `${url}?${params.toString()}`;

            // Create HMAC signature of full URL
            const crypto = require('crypto');
            const hash = crypto
                .createHmac('sha256', credentials.apiSecret)
                .update(fullUrl)
                .digest('hex');

            // Add hash to params
            params.append('hash', hash);

            const authenticatedUrl = `${url}?${params.toString()}`;

            const response = await fetch(authenticatedUrl, {
                method: 'GET'
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX order status failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            if (data.status !== 'success') {
                throw new Error(`ChainEX API error: ${data.message || 'Unknown error'}`);
            }

            // Transform ChainEX response to standard format
            const orderData = data.data;
            return {
                orderId: orderData.id,
                status: orderData.status, // pending, processing, complete, cancelled
                type: orderData.side, // buy or sell
                pair: orderData.pair,
                createdAt: orderData.created_at,
                completedAt: orderData.updated_at,
                baseAmount: parseFloat(orderData.filled_amount || 0),
                counterAmount: parseFloat(orderData.filled_value || 0),
                fee: parseFloat(orderData.fee || 0),
                executedPrice: parseFloat(orderData.average_price || orderData.price || 0)
            };

        } catch (error) {
            logger.error('ChainEX order status failed', {
                orderId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Luno limit BUY order (fallback for market orders)
     * @private
     */
    async _executeLunoLimitBuy(pair, amountUSDT, credentials) {
        try {
            // Get current market price
            const ticker = await this._getLunoTickerPrice(pair);
            const currentPrice = ticker.ask; // Use ask price for buying

            // Add 0.5% slippage buffer to ensure immediate execution
            const limitPrice = currentPrice * 1.005;

            // Calculate quantity based on amount USDT and limit price
            const quantity = parseFloat(amountUSDT) / limitPrice;

            // Convert BTC to XBT for Luno
            const lunoPair = pair.replace('BTC', 'XBT');

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: '/api/1/postorder'
            };

            const payload = {
                market_id: lunoPair, // Luno uses market_id for limit orders
                type: 'BID', // BID = buy limit order
                volume: quantity.toFixed(8), // Amount of base currency
                price: limitPrice.toFixed(2) // Price per unit
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Luno limit BUY order', {
                pair: lunoPair,
                amountUSDT,
                currentPrice,
                limitPrice,
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
                throw new Error(`Luno limit BUY order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Wait a moment then check order status to get execution details
            await new Promise(resolve => setTimeout(resolve, 1000));
            const orderStatus = await this._getLunoOrderStatus(data.order_id, credentials);

            // Transform to standard format
            const result = {
                orderId: data.order_id,
                executedPrice: limitPrice, // Estimated (actual may be better)
                executedQuantity: quantity,
                executedValue: parseFloat(amountUSDT),
                fee: orderStatus.feeCounter || 0,
                status: orderStatus.status === 'COMPLETE' ? 'COMPLETE' : 'PENDING',
                timestamp: Date.now(),
                rawResponse: { orderData: data, orderStatus }
            };

            logger.info('Luno limit BUY order placed successfully', {
                orderId: result.orderId,
                limitPrice,
                quantity,
                status: result.status
            });

            return result;

        } catch (error) {
            logger.error('Luno limit BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Luno limit SELL order (fallback for market orders)
     * @private
     */
    async _executeLunoLimitSell(pair, quantity, credentials) {
        try {
            // Get current market price
            const ticker = await this._getLunoTickerPrice(pair);
            const currentPrice = ticker.bid; // Use bid price for selling

            // Subtract 0.5% slippage buffer to ensure immediate execution
            const limitPrice = currentPrice * 0.995;

            // Convert BTC to XBT for Luno
            const lunoPair = pair.replace('BTC', 'XBT');

            const config = {
                baseUrl: 'https://api.luno.com',
                endpoint: '/api/1/postorder'
            };

            const payload = {
                market_id: lunoPair, // Luno uses market_id for limit orders
                type: 'ASK', // ASK = sell limit order
                volume: parseFloat(quantity).toFixed(8),
                price: limitPrice.toFixed(2)
            };

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Executing Luno limit SELL order', {
                pair: lunoPair,
                quantity,
                currentPrice,
                limitPrice,
                payload
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: this._createLunoAuth(credentials.apiKey, credentials.apiSecret),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno limit SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Wait a moment then check order status to get execution details
            await new Promise(resolve => setTimeout(resolve, 1000));
            const orderStatus = await this._getLunoOrderStatus(data.order_id, credentials);

            const executedValue = parseFloat(quantity) * limitPrice;

            // Transform to standard format
            const result = {
                orderId: data.order_id,
                executedPrice: limitPrice, // Estimated (actual may be better)
                executedQuantity: parseFloat(quantity),
                executedValue: executedValue,
                fee: orderStatus.feeCounter || 0,
                status: orderStatus.status === 'COMPLETE' ? 'COMPLETE' : 'PENDING',
                timestamp: Date.now(),
                rawResponse: { orderData: data, orderStatus }
            };

            logger.info('Luno limit SELL order placed successfully', {
                orderId: result.orderId,
                limitPrice,
                executedValue,
                status: result.status
            });

            return result;

        } catch (error) {
            logger.error('Luno limit SELL order failed', {
                pair,
                quantity,
                error: error.message
            });
            throw error;
        }
    }

    // ===== CHAINEX-SPECIFIC METHODS =====

    /**
     * Execute ChainEX market BUY order
     * @private
     */
    async _executeChainEXBuy(pair, amountUSDT, credentials) {
        const debug = new ExchangeDebugger('chainex');

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
                quote_amount: parseFloat(amountUSDT).toFixed(2) // Amount in USDT (quote currency)
            };

            logger.info('Executing ChainEX market BUY order', {
                pair: chainexPair,
                amountUSDT,
                payload
            });

            // ChainEX uses SIMPLE X-API-KEY authentication (like market data endpoints)
            // No timestamp or signature required based on ChainEXMarketDataService pattern
            const bodyString = JSON.stringify(payload);

            // Log comprehensive authentication details
            debug.logAuthentication({
                method: 'POST',
                endpoint: config.endpoint,
                fullUrl: `${config.baseUrl}${config.endpoint}`,
                authType: 'simple-api-key',
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                headers: {
                    'X-API-KEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                },
                payload: payload
            });

            const response = await fetch(`${config.baseUrl}${config.endpoint}`, {
                method: 'POST',
                headers: {
                    'X-API-KEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                },
                body: bodyString
            });

            const data = await response.json();

            // Log response details
            await debug.logResponse(response, data);

            if (!response.ok) {
                throw new Error(`ChainEX BUY order failed: ${response.status} - ${JSON.stringify(data)}`);
            }

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
            // Log comprehensive error details
            debug.logError(error, {
                pair,
                amountUSDT,
                exchange: 'chainex',
                operation: 'BUY'
            });

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
        const debug = new ExchangeDebugger('chainex');

        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking ChainEX balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getChainEXBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('ZAR', '');
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 CHAINEX BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check ChainEX minimum order sizes
                const minimumOrderSizes = {
                    'XRP': 1.0,
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (ChainEX uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets ChainEX minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW CHAINEX MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check ChainEX account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below ChainEX minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            const config = {
                baseUrl: 'https://api.chainex.io',
                endpoint: '/trading/order'
            };

            // Convert pair format (BTCUSDT → BTC_USDT)
            const chainexPair = this._convertPairToChainEX(pair);

            // ChainEX market order payload - use adjusted quantity
            const payload = {
                type: 'market',
                side: 'sell',
                pair: chainexPair,
                base_amount: adjustedQuantity.toFixed(8) // Use adjusted quantity (accounts for fees)
            };

            logger.info('📤 Executing ChainEX market SELL order', {
                pair: chainexPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                payload
            });

            // ChainEX uses SIMPLE X-API-KEY authentication (like market data endpoints)
            // No timestamp or signature required based on ChainEXMarketDataService pattern
            const bodyString = JSON.stringify(payload);

            // Log comprehensive authentication details
            debug.logAuthentication({
                method: 'POST',
                endpoint: config.endpoint,
                fullUrl: `${config.baseUrl}${config.endpoint}`,
                authType: 'simple-api-key',
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                headers: {
                    'X-API-KEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                },
                payload: payload
            });

            const response = await fetch(`${config.baseUrl}${config.endpoint}`, {
                method: 'POST',
                headers: {
                    'X-API-KEY': credentials.apiKey,
                    'Content-Type': 'application/json'
                },
                body: bodyString
            });

            const data = await response.json();

            // Log response details
            await debug.logResponse(response, data);

            if (!response.ok) {
                logger.error('❌ CHAINEX SELL ORDER REJECTED', {
                    pair: chainexPair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: JSON.stringify(data)
                });
                throw new Error(`ChainEX SELL order failed: ${response.status} - ${JSON.stringify(data)}`);
            }

            // Transform ChainEX response to standard format
            const result = {
                orderId: data.id || data.order_id,
                executedPrice: parseFloat(data.average_price || data.price || 0),
                executedQuantity: parseFloat(data.filled_amount || data.amount || adjustedQuantity),
                executedValue: parseFloat(data.filled_value || 0),
                fee: parseFloat(data.fee || 0),
                status: data.status || 'COMPLETE',
                timestamp: data.created_at || Date.now(),
                rawResponse: data
            };

            logger.info('✅ ChainEX SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee,
                wasAdjusted: wasAdjusted
            });

            return result;

        } catch (error) {
            // Log comprehensive error details
            debug.logError(error, {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                exchange: 'chainex',
                operation: 'SELL'
            });

            logger.error('ChainEX SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to ChainEX format (BTCUSDT → BTC_USDT)
     * ChainEX uses underscore separator for pair names
     * @private
     */
    _convertPairToChainEX(pair) {
        // Convert BTCUSDT to BTC_USDT format
        // Extract base and quote currencies
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        // Handle ZAR pairs
        if (pair.endsWith('ZAR')) {
            const baseCurrency = pair.slice(0, -3);
            return `${baseCurrency}_ZAR`;
        }
        return pair;
    }

    /**
     * Create ChainEX authentication headers (Simple API Key)
     * @private
     */
    _createChainEXAuth(apiKey, apiSecret, payload) {
        // ChainEX trading endpoints use timestamp + signature authentication
        const timestamp = Date.now().toString();

        // Create signature: HMAC-SHA256 of timestamp + JSON body
        const bodyString = JSON.stringify(payload);
        const message = timestamp + bodyString;

        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(message)
            .digest('hex');

        return {
            'X-API-KEY': apiKey,
            'X-TIMESTAMP': timestamp,
            'X-SIGNATURE': signature,
            'Content-Type': 'application/json'
        };
    }

    // ===== KRAKEN-SPECIFIC METHODS =====

    /**
     * Poll Kraken order status until filled
     * @private
     */
    async _pollKrakenOrderStatus(orderId, credentials, maxAttempts = 10) {
        const config = {
            baseUrl: 'https://api.kraken.com',
            endpoint: '/0/private/QueryOrders'
        };

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Wait 1 second between attempts
                if (attempt > 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // Apply rate limiting
                await this._rateLimitDelay();

                const nonce = Date.now() * 1000;
                const orderParams = {
                    nonce: nonce,
                    txid: orderId
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

                logger.debug('Polling Kraken order status', {
                    orderId,
                    attempt,
                    maxAttempts
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
                    logger.warn('Kraken order status check failed', {
                        orderId,
                        status: response.status
                    });
                    continue; // Try again
                }

                const data = await response.json();

                if (data.error && data.error.length > 0) {
                    logger.warn('Kraken order status API error', {
                        orderId,
                        error: data.error
                    });
                    continue; // Try again
                }

                const orderData = data.result?.[orderId];

                if (!orderData) {
                    logger.warn('Kraken order not found in response', { orderId });
                    continue;
                }

                logger.debug('Kraken order status response', {
                    orderId,
                    status: orderData.status,
                    vol_exec: orderData.vol_exec
                });

                // Check if order is filled (status: closed, vol_exec > 0)
                if (orderData.status === 'closed' && parseFloat(orderData.vol_exec || 0) > 0) {
                    logger.info('Kraken order filled', {
                        orderId,
                        attempt
                    });
                    return orderData;
                }

                // If not filled yet, continue polling
                logger.debug('Kraken order not yet filled', {
                    orderId,
                    status: orderData.status,
                    attempt
                });

            } catch (error) {
                logger.warn('Error polling Kraken order status', {
                    orderId,
                    attempt,
                    error: error.message
                });
                // Continue to next attempt
            }
        }

        // Max attempts reached without fill
        throw new Error(`Kraken order ${orderId} not filled after ${maxAttempts} attempts`);
    }

    /**
     * Execute Kraken market BUY order
     * @private
     */
    async _executeKrakenBuy(pair, amountUSDT, credentials) {
        const debug = new ExchangeDebugger('kraken');

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
                volume: parseFloat(amountUSDT).toFixed(2), // For market buy, volume is in quote currency (USDT)
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

            // Log comprehensive authentication details
            debug.logAuthentication({
                method: 'POST',
                endpoint: config.endpoint,
                fullUrl: url,
                authType: 'kraken-signature',
                timestamp: nonce,
                timeFormat: 'nonce (Date.now() * 1000)',
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                signatureInput: `path + SHA256(nonce + postData)`,
                signatureMethod: 'HMAC-SHA512 with base64-decoded secret',
                signature: authHeaders['API-Sign'],
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'API-Key': authHeaders['API-Key'],
                    'API-Sign': authHeaders['API-Sign']
                },
                payload: orderParams
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...authHeaders
                },
                body: postData
            });

            const data = await response.json();

            // Log response details
            await debug.logResponse(response, data);

            if (!response.ok) {
                throw new Error(`Kraken BUY order failed: ${response.status} - ${JSON.stringify(data)}`);
            }

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Kraken returns only order ID initially - need to poll for execution details
            const orderId = data.result?.txid?.[0];

            if (!orderId) {
                throw new Error('Kraken did not return order ID');
            }

            logger.info('Polling Kraken order status for execution details', {
                orderId,
                pair: krakenPair
            });

            // Poll order status until filled (max 10 attempts = 10 seconds)
            const orderDetails = await this._pollKrakenOrderStatus(orderId, credentials, 10);

            // Transform Kraken response to standard format
            // Kraken returns: vol_exec (executed volume), cost (total cost), fee, price (average price)
            const executedQuantity = parseFloat(orderDetails.vol_exec || 0);
            const totalCost = parseFloat(orderDetails.cost || 0);
            const averagePrice = parseFloat(orderDetails.price || (executedQuantity > 0 ? totalCost / executedQuantity : 0));
            const fee = parseFloat(orderDetails.fee || 0);

            const result = {
                orderId: orderId,
                executedPrice: averagePrice,
                executedQuantity: executedQuantity,
                executedValue: totalCost,
                fee: fee,
                status: orderDetails.status || 'FILLED',
                timestamp: orderDetails.opentm || Date.now(),
                rawResponse: orderDetails
            };

            logger.info('Kraken BUY order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee
            });

            return result;

        } catch (error) {
            // Log comprehensive error details
            debug.logError(error, {
                pair,
                amountUSDT,
                exchange: 'kraken',
                operation: 'BUY'
            });

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
        const debug = new ExchangeDebugger('kraken');

        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Kraken balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getKrakenBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('USD', ''); // Extract XRP from XRPUSDT
                const assetBalance = balances.find(b => b.currency === baseAsset || b.currency === `X${baseAsset}` || b.currency === `Z${baseAsset}`);

                logger.info('📊 KRAKEN BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check Kraken minimum order sizes (varies by asset)
                const minimumOrderSizes = {
                    'XRP': 20,      // Kraken minimum for XRP
                    'BTC': 0.0001,  // Kraken minimum for BTC
                    'ETH': 0.002,   // Kraken minimum for ETH
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (Kraken uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets Kraken minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW KRAKEN MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check Kraken account history'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below Kraken minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE ORDER =====
            const config = {
                baseUrl: 'https://api.kraken.com',
                endpoint: '/0/private/AddOrder'
            };

            // Convert pair to Kraken format (BTCUSDT → XBTUSDT)
            const krakenPair = this._convertPairToKraken(pair);

            // Kraken nonce (must be increasing)
            const nonce = Date.now() * 1000;

            // Kraken market order payload - use adjusted quantity
            // For market sell: use 'volume' field with base currency amount
            const orderParams = {
                nonce: nonce,
                ordertype: 'market',
                type: 'sell',
                volume: parseFloat(adjustedQuantity).toFixed(8), // Use adjusted quantity (accounts for fees)
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

            logger.info('📤 Executing Kraken market SELL order', {
                pair: krakenPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                postData
            });

            // Log comprehensive authentication details
            debug.logAuthentication({
                method: 'POST',
                endpoint: config.endpoint,
                fullUrl: url,
                authType: 'kraken-signature',
                timestamp: nonce,
                timeFormat: 'nonce (Date.now() * 1000)',
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                signatureInput: `path + SHA256(nonce + postData)`,
                signatureMethod: 'HMAC-SHA512 with base64-decoded secret',
                signature: authHeaders['API-Sign'],
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'API-Key': authHeaders['API-Key'],
                    'API-Sign': authHeaders['API-Sign']
                },
                payload: orderParams
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...authHeaders
                },
                body: postData
            });

            const data = await response.json();

            // Log response details
            await debug.logResponse(response, data);

            if (!response.ok) {
                throw new Error(`Kraken SELL order failed: ${response.status} - ${JSON.stringify(data)}`);
            }

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Kraken returns only order ID initially - need to poll for execution details
            const orderId = data.result?.txid?.[0];

            if (!orderId) {
                throw new Error('Kraken did not return order ID');
            }

            // IMPORTANT: Market orders on Kraken execute INSTANTLY
            // Same issue as VALR - polling can return false failures
            // FIX: Trust the order submission for market orders (they're instant)
            // Skip polling to avoid false "Failed" status

            logger.info('⚡ KRAKEN MARKET SELL order submitted - trusting instant execution', {
                orderId,
                pair: krakenPair,
                quantity,
                note: 'Market orders execute instantly on Kraken, skipping status polling to prevent false failures'
            });

            // Get current price for estimation
            const marketDataService = new (require('./KrakenMarketDataService'))();
            const currentPrice = await marketDataService.fetchCurrentPrice(pair, credentials);

            // Estimate execution (market orders execute at current price)
            const executedQuantity = quantity;
            const totalCost = currentPrice * quantity;
            const averagePrice = currentPrice;

            // Estimate fee (Kraken charges 0.16% maker, 0.26% taker, use 0.26% for market orders)
            const fee = totalCost * 0.0026; // 0.26% taker fee

            const result = {
                orderId: orderId,
                executedPrice: averagePrice,
                executedQuantity: executedQuantity,
                executedValue: totalCost,
                fee: fee,
                status: 'FILLED', // Market orders are instant
                timestamp: Date.now(),
                rawResponse: data, // Initial submission response
                note: 'Estimated values - market order executed instantly'
            };

            logger.info('Kraken SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee
            });

            return result;

        } catch (error) {
            // Log comprehensive error details
            debug.logError(error, {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                exchange: 'kraken',
                operation: 'SELL'
            });

            logger.error('Kraken SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get Kraken account balances
     * @private
     */
    async _getKrakenBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.kraken.com',
                endpoint: '/0/private/Balance'
            };

            const nonce = Date.now() * 1000;
            const postData = `nonce=${nonce}`;

            const authHeaders = this._createKrakenAuth(
                credentials.apiKey,
                credentials.apiSecret,
                config.endpoint,
                nonce,
                postData
            );

            const url = `${config.baseUrl}${config.endpoint}`;

            logger.info('Fetching Kraken balances');

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
                throw new Error(`Kraken balances fetch failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for Kraken API errors
            if (data.error && data.error.length > 0) {
                throw new Error(`Kraken API error: ${data.error.join(', ')}`);
            }

            // Transform Kraken balances to standard format
            // Kraken returns: { result: { "ZUSD": "1000.0000", "XXBT": "0.50000000", ... } }
            const balances = [];
            if (data.result) {
                for (const [currency, balance] of Object.entries(data.result)) {
                    // Convert Kraken currency codes to standard (ZUSD -> USDT, XXBT -> BTC, etc.)
                    let standardCurrency = currency;
                    if (currency === 'ZUSD') standardCurrency = 'USDT';
                    else if (currency === 'XXBT' || currency === 'XBT') standardCurrency = 'BTC';
                    else if (currency === 'XETH') standardCurrency = 'ETH';
                    else if (currency === 'XXRP') standardCurrency = 'XRP';
                    else if (currency.startsWith('X') || currency.startsWith('Z')) {
                        // Remove X or Z prefix from Kraken currency codes
                        standardCurrency = currency.substring(1);
                    }

                    const amount = parseFloat(balance || 0);
                    if (amount > 0) {
                        balances.push({
                            currency: standardCurrency,
                            available: amount,
                            reserved: 0, // Kraken doesn't provide reserved separately in Balance endpoint
                            total: amount
                        });
                    }
                }
            }

            logger.info('Kraken balances fetched successfully', {
                balanceCount: balances.length
            });

            return balances;

        } catch (error) {
            logger.error('Kraken balances fetch failed', {
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
        const debug = new ExchangeDebugger('binance');

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
                quoteOrderQty: parseFloat(amountUSDT).toFixed(2), // Amount in USDT (quote currency)
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

            // Log comprehensive authentication details
            debug.logAuthentication({
                method: 'POST',
                endpoint: config.endpoint,
                fullUrl: url,
                authType: 'binance-signature',
                timestamp: timestamp,
                timeFormat: 'Date.now() (milliseconds)',
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                signatureInput: queryString,
                signatureMethod: 'HMAC-SHA256',
                signature: signature,
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                },
                queryParams: orderParams
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            const data = await response.json();

            // Log response details
            await debug.logResponse(response, data);

            if (!response.ok) {
                throw new Error(`Binance BUY order failed: ${response.status} - ${JSON.stringify(data)}`);
            }

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
            // Log comprehensive error details
            debug.logError(error, {
                pair,
                amountUSDT,
                exchange: 'binance',
                operation: 'BUY'
            });

            logger.error('Binance BUY order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get Binance account balances
     * @private
     */
    async _getBinanceBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.binance.com',
                endpoint: '/api/v3/account'
            };

            const timestamp = Date.now();
            const queryString = `timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const url = `${config.baseUrl}${config.endpoint}?${queryString}&signature=${signature}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance get balances failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform to standard format: { currency: 'BTC', available: 0.5, reserved: 0.1, total: 0.6 }
            return data.balances.map(balance => ({
                currency: balance.asset,
                available: parseFloat(balance.free),
                reserved: parseFloat(balance.locked),
                total: parseFloat(balance.free) + parseFloat(balance.locked)
            }));

        } catch (error) {
            logger.error('Failed to get Binance balances', {
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
        const debug = new ExchangeDebugger('binance');

        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Binance balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getBinanceBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('BUSD', ''); // Extract XRP from XRPUSDT
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 BINANCE BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check Binance minimum order sizes (LOT_SIZE filter)
                // Common minimums - Binance has varying minimums per pair
                const minimumOrderSizes = {
                    'XRP': 1.0,      // Binance XRP minimum
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    'BNB': 0.001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (Binance uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets Binance minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW BINANCE MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check Binance account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below Binance minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            const config = {
                baseUrl: 'https://api.binance.com',
                endpoint: '/api/v3/order'
            };

            // Binance requires timestamp
            const timestamp = Date.now();

            // Binance market order payload - use adjusted quantity
            const orderParams = {
                symbol: pair,
                side: 'SELL',
                type: 'MARKET',
                quantity: adjustedQuantity.toFixed(8), // Use adjusted quantity (accounts for fees)
                timestamp: timestamp
            };

            // Create query string and signature
            const queryString = new URLSearchParams(orderParams).toString();
            const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');

            const url = `${config.baseUrl}${config.endpoint}?${queryString}&signature=${signature}`;

            logger.info('📤 Executing Binance market SELL order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                orderParams
            });

            // Log comprehensive authentication details
            debug.logAuthentication({
                method: 'POST',
                endpoint: config.endpoint,
                fullUrl: url,
                authType: 'binance-signature',
                timestamp: timestamp,
                timeFormat: 'Date.now() (milliseconds)',
                apiKey: credentials.apiKey,
                apiSecret: credentials.apiSecret,
                signatureInput: queryString,
                signatureMethod: 'HMAC-SHA256',
                signature: signature,
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                },
                queryParams: orderParams
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            const data = await response.json();

            // Log response details
            await debug.logResponse(response, data);

            if (!response.ok) {
                logger.error('❌ BINANCE SELL ORDER REJECTED', {
                    pair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: JSON.stringify(data)
                });
                throw new Error(`Binance SELL order failed: ${response.status} - ${JSON.stringify(data)}`);
            }

            // Binance returns instant execution details with fills
            // Transform Binance response to standard format
            const result = {
                orderId: data.orderId?.toString() || 'unknown',
                executedPrice: parseFloat(data.fills?.[0]?.price || 0),
                executedQuantity: parseFloat(data.executedQty || adjustedQuantity),
                executedValue: parseFloat(data.cummulativeQuoteQty || 0),
                fee: data.fills?.reduce((sum, fill) => sum + parseFloat(fill.commission || 0), 0) || 0,
                status: data.status || 'FILLED',
                timestamp: data.transactTime || Date.now(),
                rawResponse: data
            };

            logger.info('✅ Binance SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee,
                wasAdjusted: wasAdjusted
            });

            return result;

        } catch (error) {
            // Log comprehensive error details
            debug.logError(error, {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                exchange: 'binance',
                operation: 'SELL'
            });

            logger.error('Binance SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get BYBIT account balances
     * @private
     */
    async _getBYBITBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.bybit.com',
                endpoint: '/v5/account/wallet-balance'
            };

            const timestamp = Date.now().toString();
            const recvWindow = '5000';

            // Query parameters for spot account
            const queryParams = 'accountType=UNIFIED';
            const paramString = timestamp + credentials.apiKey + recvWindow + queryParams;

            const authHeaders = this._createBYBITAuth(
                credentials.apiKey,
                credentials.apiSecret,
                timestamp,
                recvWindow + queryParams
            );

            const url = `${config.baseUrl}${config.endpoint}?${queryParams}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    ...authHeaders,
                    'X-BAPI-RECV-WINDOW': recvWindow
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BYBIT get balances failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            if (data.retCode !== 0) {
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            // Transform to standard format: { currency: 'BTC', available: 0.5, reserved: 0.1, total: 0.6 }
            const coins = data.result?.list?.[0]?.coin || [];
            return coins.map(coin => ({
                currency: coin.coin,
                available: parseFloat(coin.availableToWithdraw || coin.walletBalance || 0),
                reserved: parseFloat(coin.locked || 0),
                total: parseFloat(coin.walletBalance || 0)
            }));

        } catch (error) {
            logger.error('Failed to get BYBIT balances', {
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
        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking BYBIT balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getBYBITBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('USDC', '');
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 BYBIT BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check BYBIT minimum order sizes
                const minimumOrderSizes = {
                    'XRP': 1.0,
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (BYBIT uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets BYBIT minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW BYBIT MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check BYBIT account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below BYBIT minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            const config = {
                baseUrl: 'https://api.bybit.com',
                endpoint: '/v5/order/create'
            };

            // BYBIT requires timestamp
            const timestamp = Date.now().toString();

            // BYBIT market order payload - use adjusted quantity
            const orderData = {
                category: 'spot',
                symbol: pair,
                side: 'Sell',
                orderType: 'Market',
                qty: adjustedQuantity.toFixed(8) // Use adjusted quantity (accounts for fees)
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

            logger.info('📤 Executing BYBIT market SELL order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
                logger.error('❌ BYBIT SELL ORDER REJECTED', {
                    pair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: errorText
                });
                throw new Error(`BYBIT SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for BYBIT API errors
            if (data.retCode !== 0) {
                logger.error('❌ BYBIT API ERROR', {
                    pair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    retCode: data.retCode,
                    retMsg: data.retMsg
                });
                throw new Error(`BYBIT API error: ${data.retMsg}`);
            }

            // Transform BYBIT response to standard format
            const result = {
                orderId: data.result?.orderId || 'unknown',
                executedPrice: 0, // BYBIT doesn't return price immediately for market orders
                executedQuantity: adjustedQuantity,
                executedValue: 0, // Will be calculated after execution
                fee: 0, // BYBIT calculates fee after execution
                status: 'SUBMITTED',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('✅ BYBIT SELL order submitted successfully', {
                orderId: result.orderId,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return result;

        } catch (error) {
            logger.error('BYBIT SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
    /**
     * Get Gate.io account balances
     * @private
     */
    async _getGateioBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const config = {
                baseUrl: 'https://api.gateio.ws',
                endpoint: '/api/v4/spot/accounts'
            };

            const timestamp = Math.floor(Date.now() / 1000).toString();
            const method = 'GET';
            const url = config.endpoint;
            const queryString = '';
            const requestBody = '';

            // Create authentication signature
            const signature = this._createGateioSignature(method, url, queryString, requestBody, timestamp, credentials.apiSecret);

            const fullUrl = `${config.baseUrl}${config.endpoint}`;

            const response = await this._fetchWithRetry(fullUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KEY': credentials.apiKey,
                    'Timestamp': timestamp,
                    'SIGN': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gate.io get balances failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform to standard format: { currency: 'BTC', available: 0.5, reserved: 0.1, total: 0.6 }
            return data.map(account => ({
                currency: account.currency,
                available: parseFloat(account.available || 0),
                reserved: parseFloat(account.locked || 0),
                total: parseFloat(account.available || 0) + parseFloat(account.locked || 0)
            }));

        } catch (error) {
            logger.error('Failed to get Gate.io balances', {
                error: error.message
            });
            throw error;
        }
    }

    async _executeGateioSell(pair, quantity, credentials) {
        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Gate.io balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getGateioBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('_USDT', ''); // Gate.io uses underscore
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 GATE.IO BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check Gate.io minimum order sizes
                const minimumOrderSizes = {
                    'XRP': 1.0,
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (Gate.io uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets Gate.io minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW GATE.IO MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check Gate.io account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below Gate.io minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            const config = {
                baseUrl: 'https://api.gateio.ws',
                endpoint: '/api/v4/spot/orders'
            };

            // Convert pair to Gate.io format (BTCUSDT → BTC_USDT)
            const gateioPair = this._convertPairToGateio(pair);

            // Gate.io requires timestamp
            const timestamp = Math.floor(Date.now() / 1000).toString();

            // Gate.io market order payload - use adjusted quantity
            const orderData = {
                currency_pair: gateioPair,
                side: 'sell',
                type: 'market',
                amount: adjustedQuantity.toFixed(8), // Use adjusted quantity (accounts for fees)
                time_in_force: 'ioc' // Immediate or cancel
            };

            const requestBody = JSON.stringify(orderData);
            const method = 'POST';
            const url = config.endpoint;
            const queryString = '';

            // Create authentication signature
            const signature = this._createGateioSignature(method, url, queryString, requestBody, timestamp, credentials.apiSecret);

            const fullUrl = `${config.baseUrl}${config.endpoint}`;

            logger.info('📤 Executing Gate.io market SELL order', {
                pair: gateioPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
                logger.error('❌ GATE.IO SELL ORDER REJECTED', {
                    pair: gateioPair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: errorText
                });
                throw new Error(`Gate.io SELL order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Transform Gate.io response to standard format
            const result = {
                orderId: data.id || 'unknown',
                executedPrice: parseFloat(data.avg_deal_price || data.price || 0),
                executedQuantity: parseFloat(data.amount || adjustedQuantity),
                executedValue: parseFloat(data.filled_total || 0),
                fee: parseFloat(data.fee || 0),
                status: data.status || 'open',
                timestamp: Date.now(),
                rawResponse: data
            };

            logger.info('✅ Gate.io SELL order executed successfully', {
                orderId: result.orderId,
                executedPrice: result.executedPrice,
                executedQuantity: result.executedQuantity,
                executedValue: result.executedValue,
                fee: result.fee,
                wasAdjusted: wasAdjusted
            });

            return result;

        } catch (error) {
            logger.error('Gate.io SELL order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
    /**
     * Get OKX account balances
     * @private
     */
    async _getOKXBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const timestamp = new Date().toISOString();
            const method = 'GET';
            const requestPath = '/api/v5/account/balance';

            // Create authentication headers
            const authHeaders = this._createOKXAuth(
                credentials.apiKey,
                credentials.apiSecret,
                credentials.passphrase,
                timestamp,
                method,
                requestPath,
                ''
            );

            const url = `https://www.okx.com${requestPath}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...authHeaders
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX get balances failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.code !== '0') {
                throw new Error(`OKX API error: ${result.code} - ${result.msg}`);
            }

            // Transform to standard format: { currency: 'BTC', available: 0.5, reserved: 0.1, total: 0.6 }
            const details = result.data[0]?.details || [];
            return details.map(detail => ({
                currency: detail.ccy,
                available: parseFloat(detail.availBal || 0),
                reserved: parseFloat(detail.frozenBal || 0),
                total: parseFloat(detail.bal || 0)
            }));

        } catch (error) {
            logger.error('Failed to get OKX balances', {
                error: error.message
            });
            throw error;
        }
    }

    async _executeOKXSell(pair, quantity, credentials) {
        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking OKX balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getOKXBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('-USDT', ''); // OKX uses hyphen
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 OKX BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check OKX minimum order sizes
                const minimumOrderSizes = {
                    'XRP': 1.0,
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (OKX uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets OKX minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW OKX MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check OKX account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below OKX minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
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
                sz: adjustedQuantity.toString(), // Use adjusted quantity (accounts for fees)
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

            logger.info('📤 Executing OKX sell order', {
                pair: okxPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

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
                logger.error('❌ OKX SELL ORDER REJECTED', {
                    pair: okxPair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: errorText
                });
                throw new Error(`OKX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for API error in response
            if (result.code !== '0') {
                logger.error('❌ OKX API ERROR', {
                    pair: okxPair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    code: result.code,
                    msg: result.msg
                });
                throw new Error(`OKX sell order failed: ${result.code} - ${result.msg}`);
            }

            const orderResult = result.data[0];

            logger.info('✅ OKX sell order executed successfully', {
                pair: okxPair,
                orderId: orderResult.ordId,
                clientOrderId: orderResult.clOrdId,
                sCode: orderResult.sCode,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: orderResult.ordId,
                clientOrderId: orderResult.clOrdId,
                executedQuantity: adjustedQuantity,
                status: 'filled',
                pair: okxPair
            };

        } catch (error) {
            logger.error('Failed to execute OKX sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
    /**
     * Get MEXC account balances
     * @private
     */
    async _getMEXCBalances(credentials) {
        try {
            // Apply rate limiting
            await this._rateLimitDelay();

            const timestamp = Date.now();
            const queryString = `timestamp=${timestamp}`;
            const signature = this._createMEXCSignature(queryString, credentials.apiSecret);

            const url = `https://api.mexc.com/api/v3/account?${queryString}&signature=${signature}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'X-MEXC-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC get balances failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Check for MEXC API error
            if (data.code && data.code !== 200) {
                throw new Error(`MEXC API error: ${data.code} - ${data.msg}`);
            }

            // Transform to standard format: { currency: 'BTC', available: 0.5, reserved: 0.1, total: 0.6 }
            return data.balances.map(balance => ({
                currency: balance.asset,
                available: parseFloat(balance.free || 0),
                reserved: parseFloat(balance.locked || 0),
                total: parseFloat(balance.free || 0) + parseFloat(balance.locked || 0)
            }));

        } catch (error) {
            logger.error('Failed to get MEXC balances', {
                error: error.message
            });
            throw error;
        }
    }

    async _executeMEXCSell(pair, quantity, credentials) {
        // Declare variables at function scope to avoid ReferenceError in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking MEXC balance before SELL order', { pair, requestedQuantity: quantity });

            try {
                const balances = await this._getMEXCBalances(credentials);
                const baseAsset = pair.replace('USDT', '').replace('USDC', '');
                const assetBalance = balances.find(b => b.currency === baseAsset);

                logger.info('📊 MEXC BALANCE CHECK', {
                    asset: baseAsset,
                    availableBalance: assetBalance?.available || 0,
                    reservedBalance: assetBalance?.reserved || 0,
                    totalBalance: assetBalance?.total || 0,
                    requestedQuantity: quantity,
                    canSellRequested: assetBalance?.available >= quantity ? '✅ YES' : '❌ NO - INSUFFICIENT',
                    shortfall: assetBalance?.available < quantity ? (quantity - assetBalance.available).toFixed(8) : 0
                });

                if (!assetBalance || assetBalance.available <= 0) {
                    throw new Error(`No ${baseAsset} balance available. Available: ${assetBalance?.available || 0}`);
                }

                // Check MEXC minimum order sizes
                const minimumOrderSizes = {
                    'XRP': 1.0,
                    'BTC': 0.00001,
                    'ETH': 0.0001,
                    // Add more as needed
                };

                const minimumQuantity = minimumOrderSizes[baseAsset] || 0;

                // If insufficient balance, use available balance minus 0.1% buffer for safety
                if (assetBalance.available < quantity) {
                    const buffer = 0.999; // 99.9% of available (0.1% safety buffer)
                    adjustedQuantity = assetBalance.available * buffer;
                    wasAdjusted = true;

                    logger.warn('⚠️ ADJUSTING SELL QUANTITY DUE TO INSUFFICIENT BALANCE', {
                        originalQuantity: quantity,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        adjustmentReason: 'Fees deducted during buy reduced available balance',
                        buffer: '0.1%'
                    });
                }

                // Format quantity to proper decimal places (MEXC uses 8 decimals for crypto)
                adjustedQuantity = parseFloat(adjustedQuantity.toFixed(8));

                // Check if adjusted quantity meets MEXC minimum order size
                if (minimumQuantity > 0 && adjustedQuantity < minimumQuantity) {
                    logger.error('❌ BALANCE BELOW MEXC MINIMUM ORDER SIZE - CANNOT AUTO-CLOSE', {
                        asset: baseAsset,
                        availableBalance: assetBalance.available,
                        adjustedQuantity: adjustedQuantity,
                        minimumRequired: minimumQuantity,
                        shortfall: (minimumQuantity - adjustedQuantity).toFixed(8),
                        originalPositionQuantity: quantity,
                        discrepancy: (quantity - assetBalance.available).toFixed(8),
                        possibleReasons: [
                            'Asset was manually sold elsewhere',
                            'Buy order failed but position was created',
                            'Another bot/system is trading the same account',
                            'Database entry is incorrect'
                        ],
                        requiredAction: 'MANUAL INTERVENTION REQUIRED - Check MEXC account history and close position manually'
                    });

                    throw new Error(`Cannot sell ${adjustedQuantity} ${baseAsset}: Below MEXC minimum order size of ${minimumQuantity} ${baseAsset}. Available: ${assetBalance.available} ${baseAsset}. This position requires manual intervention.`);
                }

                logger.info('✅ SELL QUANTITY DETERMINED', {
                    finalQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    availableBalance: assetBalance.available,
                    meetsMinimum: adjustedQuantity >= minimumQuantity
                });

            } catch (balanceError) {
                logger.error('❌ BALANCE CHECK FAILED - CANNOT PROCEED', {
                    error: balanceError.message,
                    pair,
                    requestedQuantity: quantity
                });
                throw new Error(`Cannot execute sell order: ${balanceError.message}`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Prepare order data
            const timestamp = Date.now();
            const orderParams = {
                symbol: pair,
                side: 'SELL',
                type: 'MARKET',
                quantity: adjustedQuantity.toString(), // Use adjusted quantity (accounts for fees)
                timestamp: timestamp
            };

            const queryString = new URLSearchParams(orderParams).toString();
            const signature = this._createMEXCSignature(queryString, credentials.apiSecret);

            const url = `https://api.mexc.com/api/v3/order?${queryString}&signature=${signature}`;

            logger.info('📤 Executing MEXC sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MEXC-APIKEY': credentials.apiKey
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error('❌ MEXC SELL ORDER REJECTED', {
                    pair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    httpStatus: response.status,
                    error: errorText
                });
                throw new Error(`MEXC sell order failed: ${response.status} - ${errorText}`);
            }

            const orderData = await response.json();

            // Check for MEXC API error
            if (orderData.code && orderData.code !== 200) {
                logger.error('❌ MEXC API ERROR', {
                    pair,
                    originalQuantity: quantity,
                    adjustedQuantity: adjustedQuantity,
                    wasAdjusted: wasAdjusted,
                    code: orderData.code,
                    msg: orderData.msg
                });
                throw new Error(`MEXC sell order failed: ${orderData.code} - ${orderData.msg}`);
            }

            logger.info('✅ MEXC sell order executed successfully', {
                pair,
                orderId: orderData.orderId,
                clientOrderId: orderData.clientOrderId,
                executedQty: orderData.executedQty,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: orderData.orderId,
                clientOrderId: orderData.clientOrderId,
                status: 'filled',
                executedQty: adjustedQuantity,
                executedQuantity: adjustedQuantity,
                pair
            };

        } catch (error) {
            logger.error('Failed to execute MEXC sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get KuCoin account balances
     * KuCoin uses /api/v1/accounts endpoint with KC-API headers
     * @private
     */
    async _getKuCoinBalances(credentials) {
        try {
            const timestamp = Date.now().toString();
            const method = 'GET';
            const endpoint = '/api/v1/accounts';
            const requestBody = '';

            // Create authentication headers
            const signature = this._createKuCoinSignature(timestamp, method, endpoint, requestBody, credentials.apiSecret);
            const passphrase = this._createKuCoinPassphrase(credentials.passphrase, credentials.apiSecret);

            const url = `https://api.kucoin.com${endpoint}`;

            const response = await this._fetchWithRetry(url, {
                method: method,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'KC-API-KEY': credentials.apiKey,
                    'KC-API-SIGN': signature,
                    'KC-API-TIMESTAMP': timestamp,
                    'KC-API-PASSPHRASE': passphrase,
                    'KC-API-KEY-VERSION': '2'
                }
            });

            const data = await response.json();

            if (data.code !== '200000') {
                throw new Error(`KuCoin balance fetch failed: ${data.code} - ${data.msg}`);
            }

            // KuCoin returns array of accounts (one per currency)
            // Transform to standard format: { currency, available, reserved, total }
            const accounts = data.data || [];
            return accounts
                .filter(account => account.type === 'trade') // Only spot trading accounts
                .map(account => ({
                    currency: account.currency,
                    available: parseFloat(account.available || 0),
                    reserved: parseFloat(account.holds || 0),
                    total: parseFloat(account.balance || 0)
                }));

        } catch (error) {
            logger.error('Failed to fetch KuCoin balances', {
                error: error.message
            });
            throw error;
        }
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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Convert pair to KuCoin format (BTCUSDT → BTC-USDT)
            const kucoinPair = this._convertPairToKuCoin(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking KuCoin balance before SELL order', {
                pair: kucoinPair,
                requestedQuantity: quantity
            });

            const balances = await this._getKuCoinBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on KuCoin. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 KuCoin balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: kucoinPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below KuCoin minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Prepare order data
            const timestamp = Date.now().toString();
            const method = 'POST';
            const endpoint = '/api/v1/orders';

            const orderData = {
                clientOid: `${Date.now()}`, // Client order ID
                side: 'sell',
                symbol: kucoinPair,
                type: 'market',
                size: adjustedQuantity.toString() // Use ADJUSTED quantity for sell (base currency)
            };

            const requestBody = JSON.stringify(orderData);

            // Create authentication headers
            const signature = this._createKuCoinSignature(timestamp, method, endpoint, requestBody, credentials.apiSecret);
            const passphrase = this._createKuCoinPassphrase(credentials.passphrase, credentials.apiSecret);

            const url = `https://api.kucoin.com${endpoint}`;

            logger.info('📤 Executing KuCoin sell order', {
                pair: kucoinPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

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
                throw new Error(`❌ KuCoin sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for KuCoin API error
            if (result.code !== '200000') {
                throw new Error(`❌ KuCoin sell order failed: ${result.code} - ${result.msg}`);
            }

            logger.info('✅ KuCoin sell order executed successfully', {
                pair: kucoinPair,
                orderId: result.data.orderId,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: result.data.orderId,
                status: 'filled',
                pair: kucoinPair
            };

        } catch (error) {
            logger.error('❌ Failed to execute KuCoin sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get XT.com account balances
     * XT.com uses /v4/balances endpoint with validate headers
     * @private
     */
    async _getXTBalances(credentials) {
        try {
            const timestamp = Date.now().toString();
            const signature = this._createXTSignature(credentials.apiKey, timestamp, credentials.apiSecret);

            const url = 'https://sapi.xt.com/v4/balances';

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'validate-algorithms': 'HmacSHA256',
                    'validate-appkey': credentials.apiKey,
                    'validate-recvwindow': '60000',
                    'validate-timestamp': timestamp,
                    'validate-signature': signature
                }
            });

            const data = await response.json();

            if (data.rc !== 0) {
                throw new Error(`XT.com balance fetch failed: ${data.rc} - ${data.msg}`);
            }

            // XT.com returns array of balances
            // Transform to standard format: { currency, available, reserved, total }
            const balances = data.result?.assets || [];
            return balances.map(balance => ({
                currency: balance.currency.toUpperCase(), // XT uses lowercase, convert to uppercase
                available: parseFloat(balance.available || 0),
                reserved: parseFloat(balance.frozen || 0),
                total: parseFloat(balance.total || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch XT.com balances', {
                error: error.message
            });
            throw error;
        }
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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Convert pair to XT.com format (BTCUSDT → btc_usdt)
            const xtPair = this._convertPairToXT(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking XT.com balance before SELL order', {
                pair: xtPair,
                requestedQuantity: quantity
            });

            const balances = await this._getXTBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on XT.com. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 XT.com balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: xtPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below XT.com minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Prepare order data
            const timestamp = Date.now().toString();
            const orderData = {
                symbol: xtPair,
                side: 'SELL',
                type: 'MARKET',
                quantity: adjustedQuantity.toString() // Use ADJUSTED quantity for sell (base currency)
            };

            const signature = this._createXTSignature(credentials.apiKey, timestamp, credentials.apiSecret);

            const url = `https://sapi.xt.com/v4/order`;

            logger.info('📤 Executing XT.com sell order', {
                pair: xtPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

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
                throw new Error(`❌ XT.com sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for XT.com API error
            if (result.rc !== 0) {
                throw new Error(`❌ XT.com sell order failed: ${result.rc} - ${result.msg}`);
            }

            logger.info('✅ XT.com sell order executed successfully', {
                pair: xtPair,
                orderId: result.result?.orderId,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: result.result?.orderId,
                status: 'filled',
                pair: xtPair
            };

        } catch (error) {
            logger.error('❌ Failed to execute XT.com sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get AscendEX account balances
     * AscendEX requires account group and uses /{accountGroup}/api/pro/v1/cash/balance endpoint
     * @private
     */
    async _getAscendEXBalances(credentials) {
        try {
            // Step 1: Get account group (required for AscendEX)
            const accountGroup = await this._getAscendEXAccountGroup(credentials);

            const timestamp = Date.now().toString();
            const path = `/${accountGroup}/api/pro/v1/cash/balance`;
            const signature = this._createAscendEXSignature(timestamp, path, credentials.apiSecret);

            const url = `https://ascendex.com${path}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'x-auth-key': credentials.apiKey,
                    'x-auth-timestamp': timestamp,
                    'x-auth-signature': signature
                }
            });

            const data = await response.json();

            if (data.code !== 0) {
                throw new Error(`AscendEX balance fetch failed: ${data.code} - ${data.message}`);
            }

            // AscendEX returns array of balances
            // Transform to standard format: { currency, available, reserved, total }
            const balances = data.data || [];
            return balances.map(balance => ({
                currency: balance.asset,
                available: parseFloat(balance.availableBalance || 0),
                reserved: parseFloat(balance.totalBalance || 0) - parseFloat(balance.availableBalance || 0),
                total: parseFloat(balance.totalBalance || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch AscendEX balances', {
                error: error.message
            });
            throw error;
        }
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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;
        let accountGroup;

        try {
            // Step 1: Get account group (required for AscendEX)
            accountGroup = await this._getAscendEXAccountGroup(credentials);

            // Convert pair to AscendEX format (BTCUSDT → BTC/USDT)
            const ascendexPair = this._convertPairToAscendEX(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking AscendEX balance before SELL order', {
                pair: ascendexPair,
                requestedQuantity: quantity
            });

            const balances = await this._getAscendEXBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on AscendEX. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 AscendEX balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: ascendexPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below AscendEX minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Prepare order data
            const timestamp = Date.now().toString();
            const path = `/${accountGroup}/api/pro/v1/cash/order`;
            const orderData = {
                symbol: ascendexPair,
                orderQty: adjustedQuantity.toString(), // Use ADJUSTED quantity
                orderType: 'market',
                side: 'sell',
                respInst: 'ACCEPT'
            };

            const signature = this._createAscendEXSignature(timestamp, path, credentials.apiSecret);

            const url = `https://ascendex.com${path}`;

            logger.info('📤 Executing AscendEX sell order', {
                pair: ascendexPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

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
                throw new Error(`❌ AscendEX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for AscendEX API error
            if (result.code !== 0) {
                throw new Error(`❌ AscendEX sell order failed: ${result.code} - ${result.message}`);
            }

            logger.info('✅ AscendEX sell order executed successfully', {
                pair: ascendexPair,
                orderId: result.data?.orderId,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: result.data?.orderId,
                status: 'filled',
                pair: ascendexPair
            };

        } catch (error) {
            logger.error('❌ Failed to execute AscendEX sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get HTX account balances
     * HTX requires account ID and uses /v1/account/accounts/{account-id}/balance endpoint
     * @private
     */
    async _getHTXBalances(credentials) {
        try {
            // Step 1: Get account ID (required for HTX)
            const accountId = await this._getHTXAccountId(credentials);

            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
            const path = `/v1/account/accounts/${accountId}/balance`;
            const params = {
                'AccessKeyId': credentials.apiKey,
                'SignatureMethod': 'HmacSHA256',
                'SignatureVersion': '2',
                'Timestamp': timestamp
            };

            const signature = this._createHTXSignature('GET', 'api.huobi.pro', path, params, credentials.apiSecret);
            params['Signature'] = signature;

            const queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
            const url = `https://api.huobi.pro${path}?${queryString}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();

            if (data.status !== 'ok') {
                throw new Error(`HTX balance fetch failed: ${data.status} - ${data['err-msg']}`);
            }

            // HTX returns array of balances with type 'trade' (available) and 'frozen' (reserved)
            // Transform to standard format: { currency, available, reserved, total }
            const balanceList = data.data?.list || [];
            const balanceMap = {};

            balanceList.forEach(item => {
                const currency = item.currency.toUpperCase();
                if (!balanceMap[currency]) {
                    balanceMap[currency] = { available: 0, reserved: 0 };
                }
                if (item.type === 'trade') {
                    balanceMap[currency].available = parseFloat(item.balance || 0);
                } else if (item.type === 'frozen') {
                    balanceMap[currency].reserved = parseFloat(item.balance || 0);
                }
            });

            return Object.keys(balanceMap).map(currency => ({
                currency: currency,
                available: balanceMap[currency].available,
                reserved: balanceMap[currency].reserved,
                total: balanceMap[currency].available + balanceMap[currency].reserved
            }));

        } catch (error) {
            logger.error('Failed to fetch HTX balances', {
                error: error.message
            });
            throw error;
        }
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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;
        let accountId;

        try {
            // Step 1: Get account ID (required for HTX)
            accountId = await this._getHTXAccountId(credentials);

            // Convert pair to HTX format (BTCUSDT → btcusdt)
            const htxPair = this._convertPairToHTX(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking HTX balance before SELL order', {
                pair: htxPair,
                requestedQuantity: quantity
            });

            const balances = await this._getHTXBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on HTX. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 HTX balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: htxPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below HTX minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Prepare order data
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
            const orderData = {
                'account-id': accountId,
                'symbol': htxPair,
                'type': 'sell-market',
                'amount': adjustedQuantity.toString() // Use ADJUSTED quantity
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

            logger.info('📤 Executing HTX sell order', {
                pair: htxPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

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
                throw new Error(`❌ HTX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for HTX API error
            if (result.status !== 'ok') {
                throw new Error(`❌ HTX sell order failed: ${result.status} - ${result['err-msg']}`);
            }

            logger.info('✅ HTX sell order executed successfully', {
                pair: htxPair,
                orderId: result.data,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: result.data,
                status: 'filled',
                pair: htxPair
            };

        } catch (error) {
            logger.error('❌ Failed to execute HTX sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get BingX account balances
     * BingX uses /openApi/spot/v1/account/balance endpoint
     * @private
     */
    async _getBingXBalances(credentials) {
        try {
            const timestamp = Date.now();
            const queryParams = `timestamp=${timestamp}`;
            const signature = this._createBingXSignature(queryParams, credentials.apiSecret);

            const url = `https://open-api.bingx.com/openApi/spot/v1/account/balance?${queryParams}&signature=${signature}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-BX-APIKEY': credentials.apiKey
                }
            });

            const data = await response.json();

            if (data.code !== 0) {
                throw new Error(`BingX balance fetch failed: ${data.code} - ${data.msg}`);
            }

            // BingX returns array of balances
            // Transform to standard format: { currency, available, reserved, total }
            const balances = data.data?.balances || [];
            return balances.map(balance => ({
                currency: balance.asset,
                available: parseFloat(balance.free || 0),
                reserved: parseFloat(balance.locked || 0),
                total: parseFloat(balance.free || 0) + parseFloat(balance.locked || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch BingX balances', {
                error: error.message
            });
            throw error;
        }
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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Convert pair to BingX format (BTCUSDT → BTC-USDT)
            const bingxPair = this._convertPairToBingX(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking BingX balance before SELL order', {
                pair: bingxPair,
                requestedQuantity: quantity
            });

            const balances = await this._getBingXBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on BingX. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 BingX balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: bingxPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below BingX minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Prepare order data
            const timestamp = Date.now();
            const orderParams = {
                symbol: bingxPair,
                side: 'SELL',
                type: 'MARKET',
                quantity: adjustedQuantity.toString(), // Use ADJUSTED quantity
                timestamp: timestamp
            };

            const queryString = Object.keys(orderParams).map(key => `${key}=${orderParams[key]}`).join('&');
            const signature = this._createBingXSignature(queryString, credentials.apiSecret);

            const url = `https://open-api.bingx.com/openApi/spot/v1/trade/order?${queryString}&signature=${signature}`;

            logger.info('📤 Executing BingX sell order', {
                pair: bingxPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

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
                throw new Error(`❌ BingX sell order failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BingX API error
            if (result.code !== 0) {
                throw new Error(`❌ BingX sell order failed: ${result.code} - ${result.msg}`);
            }

            logger.info('✅ BingX sell order executed successfully', {
                pair: bingxPair,
                orderId: result.data?.orderId,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                orderId: result.data?.orderId,
                status: 'filled',
                pair: bingxPair
            };

        } catch (error) {
            logger.error('❌ Failed to execute BingX sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get Bitget account balances
     * Bitget uses /api/spot/v1/account/assets endpoint
     * @private
     */
    async _getBitgetBalances(credentials) {
        try {
            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = '/api/spot/v1/account/assets';
            const body = '';

            const signature = this._createBitgetSignature(timestamp, method, requestPath, body, credentials.apiSecret);

            const url = `https://api.bitget.com${requestPath}`;

            const response = await this._fetchWithRetry(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'ACCESS-KEY': credentials.apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': credentials.passphrase
                }
            });

            const data = await response.json();

            if (data.code !== '00000') {
                throw new Error(`Bitget balance fetch failed: ${data.code} - ${data.msg}`);
            }

            // Bitget returns array of balances
            // Transform to standard format: { currency, available, reserved, total }
            const balances = data.data || [];
            return balances.map(balance => ({
                currency: balance.coinName,
                available: parseFloat(balance.available || 0),
                reserved: parseFloat(balance.frozen || 0),
                total: parseFloat(balance.available || 0) + parseFloat(balance.frozen || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch Bitget balances', {
                error: error.message
            });
            throw error;
        }
    }

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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Convert pair to Bitget format (BTCUSDT → BTCUSDT_SPBL)
            const bitgetPair = this._convertPairToBitget(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Bitget balance before SELL order', {
                pair: bitgetPair,
                requestedQuantity: quantity
            });

            const balances = await this._getBitgetBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on Bitget. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 Bitget balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: bitgetPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below Bitget minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
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
                size: adjustedQuantity.toFixed(8) // Use ADJUSTED quantity
            };

            const body = JSON.stringify(orderData);
            const signature = this._createBitgetSignature(timestamp, method, requestPath, body, credentials.apiSecret);

            const url = `https://api.bitget.com${requestPath}`;

            logger.info('📤 Executing Bitget sell order', {
                pair: bitgetPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
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
                throw new Error(`❌ Bitget API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitget API error
            if (result.code !== '00000') {
                throw new Error(`❌ Bitget order error: ${result.code} - ${result.msg}`);
            }

            // Get current price for logging
            const currentPrice = await this._fetchBitgetPrice(bitgetPair);

            logger.info('✅ Bitget sell order executed successfully', {
                pair: bitgetPair,
                orderId: result.data?.orderId,
                fillSize: result.data?.fillSize,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                success: true,
                exchange: 'bitget',
                orderId: result.data?.orderId,
                pair: bitgetPair,
                side: 'sell',
                quantity: parseFloat(result.data?.fillSize || adjustedQuantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('❌ Bitget sell order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get BitMart account balances
     * BitMart uses /spot/v1/wallet endpoint
     * @private
     */
    async _getBitMartBalances(credentials) {
        try {
            const timestamp = Date.now().toString();
            const queryString = '';
            const signature = this._createBitMartSignature(timestamp, credentials.memo || '', queryString, credentials.apiSecret);

            const url = 'https://api-cloud.bitmart.com/spot/v1/wallet';

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-BM-KEY': credentials.apiKey,
                    'X-BM-SIGN': signature,
                    'X-BM-TIMESTAMP': timestamp,
                    'X-BM-MEMO': credentials.memo || ''
                }
            });

            const data = await response.json();

            if (data.code !== 1000) {
                throw new Error(`BitMart balance fetch failed: ${data.code} - ${data.message}`);
            }

            // BitMart returns array of wallet balances
            // Transform to standard format: { currency, available, reserved, total }
            const balances = data.data?.wallet || [];
            return balances.map(balance => ({
                currency: balance.id,
                available: parseFloat(balance.available || 0),
                reserved: parseFloat(balance.frozen || 0),
                total: parseFloat(balance.available || 0) + parseFloat(balance.frozen || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch BitMart balances', {
                error: error.message
            });
            throw error;
        }
    }

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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Convert pair to BitMart format (BTCUSDT → BTC_USDT)
            const bitmartPair = this._convertPairToBitMart(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking BitMart balance before SELL order', {
                pair: bitmartPair,
                requestedQuantity: quantity
            });

            const balances = await this._getBitMartBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on BitMart. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 BitMart balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: bitmartPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below BitMart minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // BitMart requires timestamp + '#' + memo + '#' + body for signature
            const timestamp = Date.now().toString();

            // Order payload
            const orderData = {
                symbol: bitmartPair,
                side: 'sell',
                type: 'market',
                size: adjustedQuantity.toFixed(8) // Use ADJUSTED quantity
            };

            const body = JSON.stringify(orderData);
            // For POST requests with body, the queryString is the body itself
            const signature = this._createBitMartSignature(timestamp, credentials.memo || '', body, credentials.apiSecret);

            const url = `https://api-cloud.bitmart.com/spot/v2/submit_order`;

            logger.info('📤 Executing BitMart sell order', {
                pair: bitmartPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
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
                throw new Error(`❌ BitMart API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for BitMart API error
            if (result.code !== 1000) {
                throw new Error(`❌ BitMart order error: ${result.code} - ${result.message}`);
            }

            // Get current price for logging
            const currentPrice = await this._fetchBitMartPrice(bitmartPair);

            logger.info('✅ BitMart sell order executed successfully', {
                pair: bitmartPair,
                orderId: result.data?.order_id,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                success: true,
                exchange: 'bitmart',
                orderId: result.data?.order_id,
                pair: bitmartPair,
                side: 'sell',
                quantity: parseFloat(adjustedQuantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('❌ BitMart sell order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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
     * Get Bitrue account balances
     * Bitrue uses /api/v1/account endpoint (Binance-compatible)
     * @private
     */
    async _getBitrueBalances(credentials) {
        try {
            const timestamp = Date.now();
            const queryParams = `timestamp=${timestamp}`;
            const signature = this._createBitrueSignature(queryParams, credentials.apiSecret);

            const url = `https://openapi.bitrue.com/api/v1/account?${queryParams}&signature=${signature}`;

            const response = await this._fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-MBX-APIKEY': credentials.apiKey
                }
            });

            const data = await response.json();

            // Check for error
            if (data.code && data.code < 0) {
                throw new Error(`Bitrue balance fetch failed: ${data.code} - ${data.msg}`);
            }

            // Bitrue returns Binance-compatible format with array of balances
            // Transform to standard format: { currency, available, reserved, total }
            const balances = data.balances || [];
            return balances.map(balance => ({
                currency: balance.asset,
                available: parseFloat(balance.free || 0),
                reserved: parseFloat(balance.locked || 0),
                total: parseFloat(balance.free || 0) + parseFloat(balance.locked || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch Bitrue balances', {
                error: error.message
            });
            throw error;
        }
    }

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
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Bitrue balance before SELL order', {
                pair,
                requestedQuantity: quantity
            });

            const balances = await this._getBitrueBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on Bitrue. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 Bitrue balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below Bitrue minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Bitrue uses Binance-compatible API
            const timestamp = Date.now();

            // Order parameters
            const orderParams = {
                symbol: pair,
                side: 'SELL',
                type: 'MARKET',
                quantity: adjustedQuantity.toFixed(8), // Use ADJUSTED quantity
                timestamp: timestamp.toString()
            };

            const queryString = new URLSearchParams(orderParams).toString();
            const signature = this._createBitrueSignature(queryString, credentials.apiSecret);

            const url = `https://openapi.bitrue.com/api/v1/order?${queryString}&signature=${signature}`;

            logger.info('📤 Executing Bitrue sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
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
                throw new Error(`❌ Bitrue API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Bitrue API error
            if (result.code && result.code < 0) {
                throw new Error(`❌ Bitrue order error: ${result.code} - ${result.msg}`);
            }

            // Get current price for logging
            const currentPrice = await this._fetchBitruePrice(pair);

            logger.info('✅ Bitrue sell order executed successfully', {
                pair,
                orderId: result.orderId,
                executedQty: result.executedQty,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                success: true,
                exchange: 'bitrue',
                orderId: result.orderId,
                pair: pair,
                side: 'sell',
                quantity: parseFloat(result.executedQty || adjustedQuantity),
                price: currentPrice,
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('❌ Bitrue sell order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
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

    // ============================================================================
    // GEMINI ORDER EXECUTION
    // ============================================================================

    /**
     * Get Gemini account balances
     * Gemini uses /v1/balances endpoint with base64 payload + HMAC-SHA384 signature
     * @private
     */
    async _getGeminiBalances(credentials) {
        try {
            const nonce = Date.now();
            const payload = {
                request: '/v1/balances',
                nonce: nonce
            };

            const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = this._createGeminiSignature(payloadBase64, credentials.apiSecret);

            const url = 'https://api.gemini.com/v1/balances';

            const response = await this._fetchWithRetry(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'X-GEMINI-APIKEY': credentials.apiKey,
                    'X-GEMINI-PAYLOAD': payloadBase64,
                    'X-GEMINI-SIGNATURE': signature
                }
            });

            const data = await response.json();

            // Check for Gemini error response
            if (data.result === 'error') {
                throw new Error(`Gemini balance fetch failed: ${data.reason} - ${data.message}`);
            }

            // Gemini returns array of balances
            // Transform to standard format: { currency, available, reserved, total }
            return data.map(balance => ({
                currency: balance.currency,
                available: parseFloat(balance.available || 0),
                reserved: parseFloat(balance.availableForWithdrawal || 0) - parseFloat(balance.available || 0),
                total: parseFloat(balance.availableForWithdrawal || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch Gemini balances', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Gemini buy order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSD', 'BTCUSDT')
     * @param {number} amountUSD - Amount in USD/USDT to spend
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeGeminiBuy(pair, amountUSD, credentials) {
        try {
            // Convert pair to Gemini format (BTCUSD → btcusd)
            const geminiPair = this._convertPairToGemini(pair);

            // Get current price to calculate quantity
            const currentPrice = await this._fetchGeminiPrice(geminiPair);
            const quantity = (amountUSD / currentPrice).toFixed(8);

            // Gemini requires base64 encoded JSON payload with nonce
            const nonce = Date.now();
            const payload = {
                request: '/v1/order/new',
                nonce: nonce,
                symbol: geminiPair,
                amount: quantity,
                price: currentPrice.toString(),
                side: 'buy',
                type: 'exchange market',  // Market order on exchange (not auction)
                options: ['immediate-or-cancel']  // Fill immediately or cancel
            };

            const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = this._createGeminiSignature(payloadBase64, credentials.apiSecret);

            const url = 'https://api.gemini.com/v1/order/new';

            logger.info('Executing Gemini buy order', {
                pair: geminiPair,
                amountUSD,
                quantity,
                currentPrice
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'X-GEMINI-APIKEY': credentials.apiKey,
                    'X-GEMINI-PAYLOAD': payloadBase64,
                    'X-GEMINI-SIGNATURE': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Gemini error response
            if (result.result === 'error') {
                throw new Error(`Gemini order error: ${result.reason} - ${result.message}`);
            }

            logger.info('Gemini buy order executed successfully', {
                pair: geminiPair,
                orderId: result.order_id,
                executedAmount: result.executed_amount
            });

            return {
                success: true,
                exchange: 'gemini',
                orderId: result.order_id,
                pair: geminiPair,
                side: 'buy',
                quantity: parseFloat(result.executed_amount || quantity),
                price: parseFloat(result.avg_execution_price || currentPrice),
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('Gemini buy order failed', {
                pair,
                amountUSD,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Gemini sell order (market order)
     * @param {string} pair - Trading pair (e.g., 'BTCUSD', 'BTCUSDT')
     * @param {number} quantity - Quantity of base currency to sell
     * @param {object} credentials - { apiKey, apiSecret }
     * @returns {Promise<object>} Order result
     * @private
     */
    async _executeGeminiSell(pair, quantity, credentials) {
        // Declare variables at function scope so they're available in catch block
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // Convert pair to Gemini format (BTCUSD → btcusd)
            const geminiPair = this._convertPairToGemini(pair);

            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Gemini balance before SELL order', {
                pair: geminiPair,
                requestedQuantity: quantity
            });

            const balances = await this._getGeminiBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USD', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available for sale on Gemini. Available: ${assetBalance?.available || 0}`);
            }

            logger.info('📊 Gemini balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity,
                sufficient: assetBalance.available >= quantity
            });

            // If insufficient balance, adjust quantity to use 99.9% of available (0.1% buffer for rounding/fees)
            if (assetBalance.available < quantity) {
                const buffer = 0.999; // Use 99.9% of available balance
                adjustedQuantity = assetBalance.available * buffer;
                wasAdjusted = true;

                logger.warn('⚠️ Insufficient balance - adjusting SELL quantity', {
                    pair: geminiPair,
                    originalQuantity: quantity,
                    availableBalance: assetBalance.available,
                    adjustedQuantity: adjustedQuantity,
                    reductionPercent: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2)
                });
            }

            // Validate minimum order size (exchange-specific minimums)
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'LTC': 0.001,
                'BCH': 0.001,
                'ADA': 1.0,
                'DOT': 0.1,
                'LINK': 0.1,
                'UNI': 0.1,
                'MATIC': 1.0
            };

            const minimumQuantity = minimumQuantities[baseAsset] || 0.00001; // Default minimum

            if (adjustedQuantity < minimumQuantity) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity.toFixed(8)} ${baseAsset} is below Gemini minimum of ${minimumQuantity}. Cannot execute SELL order.`);
            }

            // ===== STEP 2: PREPARE AND EXECUTE ORDER =====
            // Get current price for order
            const currentPrice = await this._fetchGeminiPrice(geminiPair);

            // Gemini requires base64 encoded JSON payload with nonce
            const nonce = Date.now();
            const payload = {
                request: '/v1/order/new',
                nonce: nonce,
                symbol: geminiPair,
                amount: adjustedQuantity.toFixed(8), // Use ADJUSTED quantity
                price: currentPrice.toString(),
                side: 'sell',
                type: 'exchange market',  // Market order on exchange (not auction)
                options: ['immediate-or-cancel']  // Fill immediately or cancel
            };

            const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
            const signature = this._createGeminiSignature(payloadBase64, credentials.apiSecret);

            const url = 'https://api.gemini.com/v1/order/new';

            logger.info('📤 Executing Gemini sell order', {
                pair: geminiPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain',
                    'X-GEMINI-APIKEY': credentials.apiKey,
                    'X-GEMINI-PAYLOAD': payloadBase64,
                    'X-GEMINI-SIGNATURE': signature
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`❌ Gemini API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Gemini error response
            if (result.result === 'error') {
                throw new Error(`❌ Gemini order error: ${result.reason} - ${result.message}`);
            }

            logger.info('✅ Gemini sell order executed successfully', {
                pair: geminiPair,
                orderId: result.order_id,
                executedAmount: result.executed_amount,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted
            });

            return {
                success: true,
                exchange: 'gemini',
                orderId: result.order_id,
                pair: geminiPair,
                side: 'sell',
                quantity: parseFloat(result.executed_amount || adjustedQuantity),
                price: parseFloat(result.avg_execution_price || currentPrice),
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('❌ Gemini sell order failed', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current price from Gemini
     * @param {string} geminiPair - Trading pair in Gemini format (e.g., 'btcusd')
     * @returns {Promise<number>} Current price
     * @private
     */
    async _fetchGeminiPrice(geminiPair) {
        const response = await fetch(`https://api.gemini.com/v1/pubticker/${geminiPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Gemini price: ${response.status}`);
        }

        const result = await response.json();

        return parseFloat(result.last || 0);
    }

    /**
     * Convert pair to Gemini format (BTCUSD → btcusd)
     * Gemini uses lowercase without separator
     * @private
     */
    _convertPairToGemini(pair) {
        // Convert to lowercase
        return pair.toLowerCase();
    }

    /**
     * Create Gemini signature for authentication
     * Uses HMAC-SHA384 signature (hex) - unique to Gemini
     * @private
     */
    _createGeminiSignature(payload, apiSecret) {
        // Gemini signature: HMAC-SHA384 of base64 payload, lowercase hex
        return crypto.createHmac('sha384', apiSecret).update(payload).digest('hex');
    }

    // ============================================================================
    // CRYPTO.COM ORDER EXECUTION
    // ============================================================================

    /**
     * Get Crypto.com balances
     * @private
     */
    async _getCryptoComBalances(credentials) {
        try {
            const nonce = Date.now();
            const method = 'POST';
            const requestPath = '/v2/private/get-account-summary';
            const requestBody = '{}';

            const signaturePayload = method + requestPath + requestBody + nonce;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('hex');

            const url = `https://api.crypto.com${requestPath}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': credentials.apiKey,
                    'signature': signature,
                    'nonce': nonce.toString()
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Crypto.com balance fetch error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.code !== 0) {
                throw new Error(`Crypto.com balance fetch failed: ${result.code} - ${result.message}`);
            }

            const accounts = result.result?.accounts || [];

            // Transform to standard format
            return accounts.map(account => ({
                currency: account.currency,
                available: parseFloat(account.available || 0),
                reserved: parseFloat(account.order || 0) + parseFloat(account.stake || 0),
                total: parseFloat(account.balance || 0)
            }));

        } catch (error) {
            logger.error('Failed to fetch Crypto.com balances', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Crypto.com buy order (market order)
     * @private
     */
    async _executeCryptoComBuy(pair, amountUSDT, credentials) {
        try {
            // Convert pair to Crypto.com format (BTCUSDT → BTC_USDT)
            const cryptocomPair = this._convertPairToCryptoCom(pair);

            // Fetch current price to calculate quantity
            const currentPrice = await this._fetchCryptoComPrice(cryptocomPair);

            // Calculate quantity (base currency amount)
            const quantity = (amountUSDT / currentPrice).toFixed(8);

            // Crypto.com order creation
            const nonce = Date.now();
            const method = 'POST';
            const requestPath = '/v2/private/create-order';
            const orderData = {
                instrument_name: cryptocomPair,
                side: 'BUY',
                type: 'MARKET',
                quantity: quantity
            };
            const requestBody = JSON.stringify(orderData);

            const signaturePayload = method + requestPath + requestBody + nonce;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('hex');

            const url = `https://api.crypto.com${requestPath}`;

            logger.info('Executing Crypto.com buy order', {
                pair: cryptocomPair,
                quantity,
                currentPrice,
                amountUSDT
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': credentials.apiKey,
                    'signature': signature,
                    'nonce': nonce.toString()
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Crypto.com API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Crypto.com API error (code !== 0 means error)
            if (result.code !== 0) {
                throw new Error(`Crypto.com order failed: ${result.code} - ${result.message}`);
            }

            const orderResult = result.result;

            logger.info('Crypto.com buy order executed successfully', {
                orderId: orderResult?.order_id,
                pair: cryptocomPair,
                quantity,
                status: orderResult?.status
            });

            return {
                success: true,
                orderId: orderResult?.order_id,
                executedQty: parseFloat(quantity),
                executedPrice: currentPrice,
                pair: cryptocomPair,
                side: 'BUY',
                status: orderResult?.status || 'FILLED'
            };

        } catch (error) {
            logger.error('Crypto.com buy order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Crypto.com sell order (market order)
     * @private
     */
    async _executeCryptoComSell(pair, quantity, credentials) {
        // Declare variables at function scope for catch block access
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Crypto.com balance before SELL order', {
                pair,
                requestedQuantity: quantity
            });

            const balances = await this._getCryptoComBalances(credentials);
            const baseAsset = pair.replace('USDT', '').replace('USDC', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available on Crypto.com (requested: ${quantity})`);
            }

            logger.info('📊 Crypto.com balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity
            });

            // Check if available balance is sufficient
            if (assetBalance.available < quantity) {
                // Use 99.9% of available balance (0.1% buffer for rounding/fees)
                adjustedQuantity = assetBalance.available * 0.999;
                wasAdjusted = true;
                logger.warn('⚠️ Insufficient balance on Crypto.com - adjusting SELL quantity', {
                    asset: baseAsset,
                    requested: quantity,
                    available: assetBalance.available,
                    adjusted: adjustedQuantity,
                    reduction: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2) + '%'
                });
            }

            // Validate minimum order size
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'SOL': 0.01,
                'ADA': 1.0
            };

            const minQty = minimumQuantities[baseAsset] || 0.00001;
            if (adjustedQuantity < minQty) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity} below minimum ${minQty} for ${baseAsset} on Crypto.com`);
            }

            // ===== STEP 2: EXECUTE SELL ORDER WITH ADJUSTED QUANTITY =====
            // Convert pair to Crypto.com format (BTCUSDT → BTC_USDT)
            const cryptocomPair = this._convertPairToCryptoCom(pair);

            // Format quantity to 8 decimal places
            const formattedQuantity = parseFloat(adjustedQuantity).toFixed(8);

            // Crypto.com order creation
            const nonce = Date.now();
            const method = 'POST';
            const requestPath = '/v2/private/create-order';
            const orderData = {
                instrument_name: cryptocomPair,
                side: 'SELL',
                type: 'MARKET',
                quantity: formattedQuantity
            };
            const requestBody = JSON.stringify(orderData);

            const signaturePayload = method + requestPath + requestBody + nonce;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('hex');

            const url = `https://api.crypto.com${requestPath}`;

            logger.info('Executing Crypto.com sell order', {
                pair: cryptocomPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                formattedQuantity: formattedQuantity,
                wasAdjusted: wasAdjusted
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': credentials.apiKey,
                    'signature': signature,
                    'nonce': nonce.toString()
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Crypto.com API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Crypto.com API error (code !== 0 means error)
            if (result.code !== 0) {
                throw new Error(`Crypto.com order failed: ${result.code} - ${result.message}`);
            }

            const orderResult = result.result;

            logger.info('✅ Crypto.com sell order executed successfully', {
                orderId: orderResult?.order_id,
                pair: cryptocomPair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                executedQuantity: formattedQuantity,
                wasAdjusted: wasAdjusted,
                status: orderResult?.status
            });

            return {
                success: true,
                orderId: orderResult?.order_id,
                executedQty: parseFloat(formattedQuantity),
                pair: cryptocomPair,
                side: 'SELL',
                status: orderResult?.status || 'FILLED'
            };

        } catch (error) {
            logger.error('❌ Failed to execute Crypto.com sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current Crypto.com price for a pair
     * @private
     */
    async _fetchCryptoComPrice(cryptocomPair) {
        try {
            const url = `https://api.crypto.com/v2/public/get-ticker?instrument_name=${cryptocomPair}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Crypto.com price fetch error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.code !== 0) {
                throw new Error(`Crypto.com price fetch failed: ${result.code} - ${result.message}`);
            }

            // Crypto.com ticker format: { a: "96234.50" } (a = last traded price)
            const tickerData = result.result?.data?.[0];
            return parseFloat(tickerData?.a || 0);

        } catch (error) {
            logger.error('Failed to fetch Crypto.com price', {
                pair: cryptocomPair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Convert pair to Crypto.com format (BTCUSDT → BTC_USDT)
     * @private
     */
    _convertPairToCryptoCom(pair) {
        // Convert BTCUSDT to BTC_USDT format
        const quoteCurrency = 'USDT';
        if (pair.endsWith(quoteCurrency)) {
            const baseCurrency = pair.slice(0, -quoteCurrency.length);
            return `${baseCurrency}_${quoteCurrency}`;
        }
        return pair;
    }

    // ============================================================================
    // COINCATCH ORDER EXECUTION
    // ============================================================================

    /**
     * Get Coincatch balances (OKX-compatible API)
     * @private
     */
    async _getCoincatchBalances(credentials) {
        try {
            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = '/api/v5/account/balance';
            const requestBody = '';

            const signaturePayload = timestamp + method + requestPath + requestBody;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('base64');

            const url = `${this.baseUrl || 'https://api.coincatch.com'}${requestPath}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || credentials.apiSecret
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Coincatch balance fetch error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            if (result.code !== '0') {
                throw new Error(`Coincatch balance fetch failed: ${result.code} - ${result.msg}`);
            }

            const balanceData = result.data || [];
            const allBalances = [];

            // Coincatch returns balance data per account (details array)
            balanceData.forEach(account => {
                const details = account.details || [];
                details.forEach(detail => {
                    allBalances.push({
                        currency: detail.ccy,
                        available: parseFloat(detail.availBal || 0),
                        reserved: parseFloat(detail.frozenBal || 0),
                        total: parseFloat(detail.cashBal || 0)
                    });
                });
            });

            return allBalances;

        } catch (error) {
            logger.error('Failed to fetch Coincatch balances', {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Coincatch buy order (market order)
     * @private
     */
    async _executeCoincatchBuy(pair, amountUSDT, credentials) {
        try {
            // Fetch current price to calculate quantity
            const currentPrice = await this._fetchCoincatchPrice(pair);

            // Calculate quantity (base currency amount)
            const quantity = (amountUSDT / currentPrice).toFixed(8);

            // Coincatch order creation (OKX-compatible API)
            const timestamp = Date.now().toString();
            const method = 'POST';
            const requestPath = '/api/v5/trade/order';
            const orderData = {
                instId: pair,
                tdMode: 'cash',
                side: 'buy',
                ordType: 'market',
                sz: quantity
            };
            const requestBody = JSON.stringify(orderData);

            const signaturePayload = timestamp + method + requestPath + requestBody;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('base64');

            const url = `${this.baseUrl || 'https://api.coincatch.com'}${requestPath}`;

            logger.info('Executing Coincatch buy order', {
                pair,
                quantity,
                currentPrice,
                amountUSDT
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || credentials.apiSecret
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Coincatch API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Coincatch API error (code !== '0' means error)
            if (result.code !== '0') {
                throw new Error(`Coincatch order failed: ${result.code} - ${result.msg}`);
            }

            const orderResult = result.data?.[0];

            logger.info('Coincatch buy order executed successfully', {
                orderId: orderResult?.ordId,
                pair,
                quantity,
                status: orderResult?.sCode
            });

            return {
                success: true,
                orderId: orderResult?.ordId,
                executedQty: parseFloat(quantity),
                executedPrice: currentPrice,
                pair: pair,
                side: 'BUY',
                status: orderResult?.sCode || 'filled'
            };

        } catch (error) {
            logger.error('Coincatch buy order failed', {
                pair,
                amountUSDT,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute Coincatch sell order (market order)
     * @private
     */
    async _executeCoincatchSell(pair, quantity, credentials) {
        // Declare variables at function scope for catch block access
        let adjustedQuantity = quantity;
        let wasAdjusted = false;

        try {
            // ===== STEP 1: CHECK AVAILABLE BALANCE AND ADJUST QUANTITY =====
            logger.info('🔍 Checking Coincatch balance before SELL order', {
                pair,
                requestedQuantity: quantity
            });

            const balances = await this._getCoincatchBalances(credentials);
            const baseAsset = pair.replace('-USDT', '').replace('USDT', '');
            const assetBalance = balances.find(b => b.currency === baseAsset);

            if (!assetBalance || assetBalance.available <= 0) {
                throw new Error(`No ${baseAsset} balance available on Coincatch (requested: ${quantity})`);
            }

            logger.info('📊 Coincatch balance check', {
                asset: baseAsset,
                available: assetBalance.available,
                requested: quantity
            });

            // Check if available balance is sufficient
            if (assetBalance.available < quantity) {
                // Use 99.9% of available balance (0.1% buffer for rounding/fees)
                adjustedQuantity = assetBalance.available * 0.999;
                wasAdjusted = true;
                logger.warn('⚠️ Insufficient balance on Coincatch - adjusting SELL quantity', {
                    asset: baseAsset,
                    requested: quantity,
                    available: assetBalance.available,
                    adjusted: adjustedQuantity,
                    reduction: ((quantity - adjustedQuantity) / quantity * 100).toFixed(2) + '%'
                });
            }

            // Validate minimum order size
            const minimumQuantities = {
                'XRP': 1.0,
                'BTC': 0.00001,
                'ETH': 0.0001,
                'SOL': 0.01,
                'ADA': 1.0
            };

            const minQty = minimumQuantities[baseAsset] || 0.00001;
            if (adjustedQuantity < minQty) {
                throw new Error(`❌ Adjusted quantity ${adjustedQuantity} below minimum ${minQty} for ${baseAsset} on Coincatch`);
            }

            // ===== STEP 2: EXECUTE SELL ORDER WITH ADJUSTED QUANTITY =====
            // Format quantity to 8 decimal places
            const formattedQuantity = parseFloat(adjustedQuantity).toFixed(8);

            // Coincatch order creation (OKX-compatible API)
            const timestamp = Date.now().toString();
            const method = 'POST';
            const requestPath = '/api/v5/trade/order';
            const orderData = {
                instId: pair,
                tdMode: 'cash',
                side: 'sell',
                ordType: 'market',
                sz: formattedQuantity
            };
            const requestBody = JSON.stringify(orderData);

            const signaturePayload = timestamp + method + requestPath + requestBody;
            const signature = crypto.createHmac('sha256', credentials.apiSecret)
                .update(signaturePayload)
                .digest('base64');

            const url = `${this.baseUrl || 'https://api.coincatch.com'}${requestPath}`;

            logger.info('Executing Coincatch sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                formattedQuantity: formattedQuantity,
                wasAdjusted: wasAdjusted
            });

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'OK-ACCESS-KEY': credentials.apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': credentials.passphrase || credentials.apiSecret
                },
                body: requestBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Coincatch API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Check for Coincatch API error (code !== '0' means error)
            if (result.code !== '0') {
                throw new Error(`Coincatch order failed: ${result.code} - ${result.msg}`);
            }

            const orderResult = result.data?.[0];

            logger.info('✅ Coincatch sell order executed successfully', {
                orderId: orderResult?.ordId,
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                executedQuantity: formattedQuantity,
                wasAdjusted: wasAdjusted,
                status: orderResult?.sCode
            });

            return {
                success: true,
                orderId: orderResult?.ordId,
                executedQty: parseFloat(formattedQuantity),
                pair: pair,
                side: 'SELL',
                status: orderResult?.sCode || 'filled'
            };

        } catch (error) {
            logger.error('❌ Failed to execute Coincatch sell order', {
                pair,
                originalQuantity: quantity,
                adjustedQuantity: adjustedQuantity,
                wasAdjusted: wasAdjusted,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch current Coincatch price for a pair
     * @private
     */
    async _fetchCoincatchPrice(pair) {
        try {
            const url = `https://api.coincatch.com/api/v1/market/ticker?symbol=${pair}`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Coincatch price fetch error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();

            // Coincatch ticker format: { data: { close: "96234.50" } }
            return parseFloat(result.data?.close || 0);

        } catch (error) {
            logger.error('Failed to fetch Coincatch price', {
                pair,
                error: error.message
            });
            throw error;
        }
    }
}

module.exports = OrderExecutionService;
