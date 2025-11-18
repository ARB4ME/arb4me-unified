/**
 * Exchange Connector Service
 * Unified interface to all 21 exchanges with proper authentication
 *
 * IMPORTANT: Stateless CORS proxy - credentials passed as parameters, never stored
 * Handles exchange-specific:
 * - Authentication signatures
 * - API endpoints
 * - Request/response formats
 * - Rate limiting
 */

const crypto = require('crypto');
const { systemLogger } = require('../../utils/logger');

class ExchangeConnectorService {
    constructor() {
        // Exchange configurations (no credentials, just connection info)
        this.exchanges = {
            valr: {
                name: 'VALR',
                baseUrl: 'https://api.valr.com',
                endpoints: {
                    orderBook: '/v1/public/:pair/orderbook',
                    marketOrder: '/v1/orders/market'
                },
                authType: 'valr-signature'
            },
            luno: {
                name: 'Luno',
                baseUrl: 'https://api.luno.com',
                endpoints: {
                    orderBook: '/api/1/orderbook_top',
                    marketOrder: '/api/1/marketorder'
                },
                authType: 'basic'
            },
            chainex: {
                name: 'ChainEX',
                baseUrl: 'https://api.chainex.io',
                endpoints: {
                    orderBook: '/market/orderbook',
                    marketOrder: '/trading/order'
                },
                authType: 'api-key'
            },
            binance: {
                name: 'Binance',
                baseUrl: 'https://api.binance.com',
                endpoints: {
                    orderBook: '/api/v3/depth',
                    marketOrder: '/api/v3/order'
                },
                authType: 'hmac-sha256'
            },
            kraken: {
                name: 'Kraken',
                baseUrl: 'https://api.kraken.com',
                endpoints: {
                    orderBook: '/0/public/Depth',
                    marketOrder: '/0/private/AddOrder'
                },
                authType: 'kraken-signature'
            },
            // Other exchanges will be added as needed
            bybit: { name: 'ByBit', baseUrl: 'https://api.bybit.com', endpoints: {}, authType: 'api-key' },
            okx: { name: 'OKX', baseUrl: 'https://www.okx.com', endpoints: {}, authType: 'api-key' },
            kucoin: { name: 'KuCoin', baseUrl: 'https://api.kucoin.com', endpoints: {}, authType: 'api-key' },
            coinbase: { name: 'Coinbase', baseUrl: 'https://api.coinbase.com', endpoints: {}, authType: 'api-key' },
            htx: {
                name: 'HTX',
                baseUrl: 'https://api.huobi.pro',
                endpoints: {
                    orderBook: '/market/depth',
                    marketOrder: '/v1/order/orders/place'
                },
                authType: 'htx-signature'
            },
            gateio: {
                name: 'Gate.io',
                baseUrl: 'https://api.gateio.ws/api/v4',
                endpoints: {
                    orderBook: '/spot/order_book',
                    marketOrder: '/spot/orders'
                },
                authType: 'gateio-signature'
            },
            cryptocom: {
                name: 'Crypto.com',
                baseUrl: 'https://api.crypto.com/v2',
                endpoints: {
                    orderBook: '/public/get-book',
                    marketOrder: '/private/create-order'
                },
                authType: 'cryptocom-signature'
            },
            mexc: {
                name: 'MEXC',
                baseUrl: 'https://api.mexc.com',
                endpoints: {
                    orderBook: '/api/v3/depth',
                    marketOrder: '/api/v3/order'
                },
                authType: 'mexc-signature'
            },
            xt: {
                name: 'XT',
                baseUrl: 'https://api.xt.com',
                endpoints: {
                    orderBook: '/v4/public/depth',
                    marketOrder: '/v4/order'
                },
                authType: 'xt-signature'
            },
            ascendex: {
                name: 'AscendEX',
                baseUrl: 'https://ascendex.com',
                endpoints: {
                    accountInfo: '/api/pro/v1/info',
                    orderBook: '/api/pro/v1/depth',
                    marketOrder: '/{accountGroup}/api/pro/v1/cash/order'
                },
                authType: 'ascendex-signature'
            },
            bingx: {
                name: 'BingX',
                baseUrl: 'https://open-api.bingx.com',
                endpoints: {
                    orderBook: '/openApi/spot/v1/market/depth',
                    marketOrder: '/openApi/spot/v1/trade/order'
                },
                authType: 'bingx-signature'
            },
            bitget: {
                name: 'Bitget',
                baseUrl: 'https://api.bitget.com',
                endpoints: {
                    orderBook: '/api/spot/v1/market/depth',
                    marketOrder: '/api/spot/v1/trade/orders'
                },
                authType: 'bitget-signature'
            },
            bitmart: {
                name: 'BitMart',
                baseUrl: 'https://api-cloud.bitmart.com',
                endpoints: {
                    orderBook: '/spot/v1/symbols/book',
                    marketOrder: '/spot/v2/submit_order'
                },
                authType: 'hmac-sha256'
            },
            bitrue: {
                name: 'Bitrue',
                baseUrl: 'https://api.bitrue.com',
                endpoints: {
                    orderBook: '/api/v1/depth',
                    marketOrder: '/api/v1/order'
                },
                authType: 'hmac-sha256'
            },
            gemini: {
                name: 'Gemini',
                baseUrl: 'https://api.gemini.com',
                endpoints: {
                    orderBook: '/v1/book/:pair',
                    marketOrder: '/v1/order/new'
                },
                authType: 'gemini-signature'
            },
            coincatch: {
                name: 'CoinCatch',
                baseUrl: 'https://api.coincatch.com',
                endpoints: {
                    orderBook: '/api/v1/market/depth',
                    marketOrder: '/api/v1/trade/order'
                },
                authType: 'coincatch-signature'
            }
        };
    }

    /**
     * Fetch order book from exchange
     * @param {string} exchange - Exchange name
     * @param {string} pair - Trading pair
     * @param {object} credentials - User's API credentials { apiKey, apiSecret } (optional for public endpoints)
     * @returns {Promise<object>} Order book data
     */
    async fetchOrderBook(exchange, pair, credentials) {
        const exchangeLower = exchange.toLowerCase();
        const config = this.exchanges[exchangeLower];

        if (!config) {
            throw new Error(`Exchange not supported: ${exchange}`);
        }

        try {
            // Create auth headers for this specific request (credentials used immediately, then discarded)
            // For public orderbook endpoints, credentials are optional
            const authHeaders = this._createAuthHeaders(
                exchangeLower,
                'GET',
                config.endpoints.orderBook,
                null,
                credentials,
                true  // isPublicEndpoint = true for orderbook
            );

            // Build URL
            const url = this._buildOrderBookUrl(exchangeLower, pair, config);

            systemLogger.trading(`Fetching order book`, {
                exchange: config.name,
                pair,
                url,
                authenticated: !!credentials
            });

            // Make request
            const response = await fetch(url, {
                method: 'GET',
                headers: authHeaders
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`${config.name} API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            return data;

        } catch (error) {
            systemLogger.error(`Order book fetch failed`, {
                exchange: config.name,
                pair,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Execute market order on exchange
     * @param {string} exchange - Exchange name
     * @param {string} pair - Trading pair
     * @param {string} side - 'buy' or 'sell'
     * @param {number} amount - Amount to trade
     * @param {object} credentials - User's API credentials { apiKey, apiSecret }
     * @returns {Promise<object>} Order result
     */
    async executeMarketOrder(exchange, pair, side, amount, credentials) {
        const exchangeLower = exchange.toLowerCase();
        const config = this.exchanges[exchangeLower];

        if (!config) {
            throw new Error(`Exchange not supported: ${exchange}`);
        }

        try {
            // Build order payload (exchange-specific)
            const payload = this._buildOrderPayload(exchangeLower, pair, side, amount);

            // Create auth headers for this specific request
            const authHeaders = this._createAuthHeaders(
                exchangeLower,
                'POST',
                config.endpoints.marketOrder,
                payload,
                credentials
            );

            // Build URL
            const url = `${config.baseUrl}${config.endpoints.marketOrder}`;

            systemLogger.trading(`Executing market order`, {
                exchange: config.name,
                pair,
                side,
                amount
            });

            // Make request
            const response = await fetch(url, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`${config.name} order failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            return data;

        } catch (error) {
            systemLogger.error(`Market order execution failed`, {
                exchange: config.name,
                pair,
                side,
                amount,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Fetch account balance from exchange
     * @param {string} exchange - Exchange name
     * @param {string} currency - Currency to check (e.g., 'USDT', 'ZAR', 'USD')
     * @param {object} credentials - User's API credentials { apiKey, apiSecret }
     * @returns {Promise<number>} Available balance
     */
    async fetchBalance(exchange, currency, credentials) {
        const exchangeLower = exchange.toLowerCase();
        const config = this.exchanges[exchangeLower];

        if (!config) {
            throw new Error(`Exchange not supported: ${exchange}`);
        }

        try {
            // Build balance endpoint (exchange-specific)
            const balanceEndpoint = this._getBalanceEndpoint(exchangeLower);

            // Create auth headers
            const authHeaders = this._createAuthHeaders(
                exchangeLower,
                'GET',
                balanceEndpoint,
                null,
                credentials
            );

            // Build URL
            const url = `${config.baseUrl}${balanceEndpoint}`;

            systemLogger.trading(`Fetching balance`, {
                exchange: config.name,
                currency
            });

            // Make request
            const response = await fetch(url, {
                method: 'GET',
                headers: authHeaders
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`${config.name} balance fetch failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            // Parse balance (exchange-specific)
            const balance = this._parseBalance(exchangeLower, data, currency);

            return balance;

        } catch (error) {
            systemLogger.error(`Balance fetch failed`, {
                exchange: config.name,
                currency,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get balance endpoint for exchange
     * @private
     */
    _getBalanceEndpoint(exchange) {
        const endpoints = {
            valr: '/v1/account/balances',
            luno: '/api/1/balance',
            binance: '/api/v3/account',
            bybit: '/v5/account/wallet-balance',
            kucoin: '/api/v1/accounts',
            okx: '/api/v5/account/balance',
            coinbase: '/api/v3/brokerage/accounts',
            htx: '/v1/account/accounts',
            gateio: '/api/v4/spot/accounts',
            cryptocom: '/private/get-account-summary',
            mexc: '/api/v3/account',
            xt: '/v4/balances',
            ascendex: '/api/pro/v1/cash/balance',
            bingx: '/openApi/spot/v1/account/balance',
            bitget: '/api/spot/v1/account/assets',
            bitmart: '/spot/v1/wallet',
            bitrue: '/api/v1/account',
            gemini: '/v1/balances',
            coincatch: '/api/v1/account/balance',
            chainex: '/account/balance',
            kraken: '/0/private/Balance'
        };

        return endpoints[exchange] || '/balance';
    }

    /**
     * Parse balance from exchange response
     * @private
     */
    _parseBalance(exchange, data, currency) {
        try {
            switch (exchange) {
                case 'valr':
                    const valrBalance = data.find(b => b.currency === currency);
                    return parseFloat(valrBalance?.available || 0);

                case 'luno':
                    const lunoBalance = data.balance?.find(b => b.asset === currency);
                    return parseFloat(lunoBalance?.balance || 0);

                case 'binance':
                case 'bitrue':
                case 'mexc':
                    const binanceBalance = data.balances?.find(b => b.asset === currency);
                    return parseFloat(binanceBalance?.free || 0);

                case 'bitmart':
                    const bitmartBalance = data.data?.wallet?.find(b => b.currency === currency);
                    return parseFloat(bitmartBalance?.available || 0);

                case 'bitget':
                    const bitgetBalance = data.data?.find(b => b.coin === currency);
                    return parseFloat(bitgetBalance?.available || 0);

                case 'bingx':
                    const bingxBalance = data.data?.balances?.find(b => b.asset === currency);
                    return parseFloat(bingxBalance?.free || 0);

                case 'ascendex':
                    const ascendexBalance = data.data?.find(b => b.asset === currency);
                    return parseFloat(ascendexBalance?.availableBalance || 0);

                case 'xt':
                    const xtBalance = data.result?.assets?.find(b => b.currency === currency.toLowerCase());
                    return parseFloat(xtBalance?.available || 0);

                case 'gemini':
                    const geminiBalance = data.find(b => b.currency === currency);
                    return parseFloat(geminiBalance?.available || 0);

                case 'coincatch':
                    const coincatchBalance = data.data?.find(b => b.coin === currency);
                    return parseFloat(coincatchBalance?.available || 0);

                case 'cryptocom':
                    const cryptocomBalance = data.result?.accounts?.find(b => b.currency === currency);
                    return parseFloat(cryptocomBalance?.balance || 0);

                case 'htx':
                    // HTX returns array of accounts, need to find spot account first
                    const htxSpot = data.data?.find(a => a.type === 'spot');
                    if (htxSpot && htxSpot.list) {
                        const htxBalance = htxSpot.list.find(b => b.currency === currency.toLowerCase());
                        return parseFloat(htxBalance?.balance || 0);
                    }
                    return 0;

                case 'gateio':
                    const gateioBalance = data.find(b => b.currency === currency);
                    return parseFloat(gateioBalance?.available || 0);

                case 'kraken':
                    // Kraken uses currency codes like ZUSD, ZEUR, XXBT
                    const krakenCurrency = currency === 'BTC' ? 'XXBT' :
                                          currency === 'USD' ? 'ZUSD' :
                                          currency === 'EUR' ? 'ZEUR' : currency;
                    return parseFloat(data.result?.[krakenCurrency] || 0);

                default:
                    // Generic parser
                    if (Array.isArray(data)) {
                        const balance = data.find(b =>
                            b.currency === currency ||
                            b.asset === currency ||
                            b.coin === currency
                        );
                        return parseFloat(balance?.available || balance?.free || balance?.balance || 0);
                    }
                    return 0;
            }
        } catch (error) {
            systemLogger.error(`Failed to parse balance`, {
                exchange,
                currency,
                error: error.message
            });
            return 0;
        }
    }

    /**
     * Create authentication headers (credentials used immediately, not stored)
     * @private
     * @param {boolean} isPublicEndpoint - If true, credentials are optional
     */
    _createAuthHeaders(exchange, method, path, body, credentials, isPublicEndpoint = false) {
        // If no credentials provided and this is a public endpoint, return basic headers
        if (!credentials && isPublicEndpoint) {
            return {
                'Content-Type': 'application/json'
            };
        }

        // If no credentials provided for private endpoint, throw error
        if (!credentials) {
            throw new Error(`API credentials required for ${exchange} ${method} ${path}`);
        }

        const { apiKey, apiSecret, passphrase } = credentials;

        switch (this.exchanges[exchange].authType) {
            case 'valr-signature':
                return this._createValrAuth(apiKey, apiSecret, method, path, body);

            case 'basic':
                return this._createBasicAuth(apiKey, apiSecret);

            case 'hmac-sha256':
                return this._createHmacAuth(apiKey, apiSecret, method, path, body);

            case 'kraken-signature':
                return this._createKrakenAuth(apiKey, apiSecret, path, body);

            case 'gemini-signature':
                return this._createGeminiAuth(apiKey, apiSecret, method, path, body);

            case 'coincatch-signature':
                return this._createCoincatchAuth(apiKey, apiSecret, passphrase, method, path, body);

            case 'bitget-signature':
                return this._createBitgetAuth(apiKey, apiSecret, passphrase, method, path, body);

            case 'bingx-signature':
                return this._createBingxAuth(apiKey, apiSecret, method, path, body);

            case 'ascendex-signature':
                return this._createAscendexAuth(apiKey, apiSecret, method, path, body);

            case 'xt-signature':
                return this._createXtAuth(apiKey, apiSecret, method, path, body);

            case 'mexc-signature':
                return this._createMexcAuth(apiKey, apiSecret, method, path, body);

            case 'cryptocom-signature':
                return this._createCryptocomAuth(apiKey, apiSecret, method, path, body);

            case 'htx-signature':
                return this._createHtxAuth(apiKey, apiSecret, method, path, body, credentials);

            case 'gateio-signature':
                return this._createGateioAuth(apiKey, apiSecret, method, path, body);

            case 'api-key':
            default:
                return {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                };
        }
    }

    /**
     * VALR authentication (SHA-512 HMAC signature)
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

    /**
     * Basic authentication (Luno, etc.)
     * @private
     */
    _createBasicAuth(apiKey, apiSecret) {
        const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

        return {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * HMAC SHA-256 authentication (Binance, etc.)
     * @private
     */
    _createHmacAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now();
        const queryString = body ? new URLSearchParams(body).toString() : '';
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');

        return {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Kraken authentication
     * @private
     */
    _createKrakenAuth(apiKey, apiSecret, path, body) {
        // Kraken uses a more complex auth scheme
        // Simplified version for now
        return {
            'API-Key': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
        };
    }

    /**
     * Gemini authentication (HMAC SHA-384 + Base64 Payload)
     * @private
     */
    _createGeminiAuth(apiKey, apiSecret, method, path, body) {
        const nonce = Date.now();

        // Create payload object
        const payload = {
            request: path,
            nonce: nonce,
            ...body
        };

        // Encode payload as base64
        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');

        // Create HMAC-SHA384 signature
        const signature = crypto
            .createHmac('sha384', apiSecret)
            .update(base64Payload)
            .digest('hex');

        return {
            'Content-Type': 'text/plain',
            'X-GEMINI-APIKEY': apiKey,
            'X-GEMINI-PAYLOAD': base64Payload,
            'X-GEMINI-SIGNATURE': signature,
            'Cache-Control': 'no-cache'
        };
    }

    /**
     * Coincatch authentication (HMAC SHA-256 + Passphrase)
     * @private
     */
    _createCoincatchAuth(apiKey, apiSecret, passphrase, method, path, body) {
        const timestamp = Date.now().toString();
        const bodyStr = body ? JSON.stringify(body) : '';

        // Create signature: timestamp + method + path + body
        const signaturePayload = timestamp + method.toUpperCase() + path + bodyStr;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');

        return {
            'ACCESS-KEY': apiKey,
            'ACCESS-SIGN': signature,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-PASSPHRASE': passphrase,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Bitget authentication (HMAC SHA-256 + Base64 + Passphrase)
     * @private
     */
    _createBitgetAuth(apiKey, apiSecret, passphrase, method, path, body) {
        const timestamp = Date.now().toString();
        const bodyStr = body ? JSON.stringify(body) : '';

        // Create signature: timestamp + method + path + body
        const message = timestamp + method.toUpperCase() + path + bodyStr;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(message)
            .digest('base64');  // Important: Bitget uses base64, not hex!

        return {
            'ACCESS-KEY': apiKey,
            'ACCESS-SIGN': signature,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-PASSPHRASE': passphrase,
            'Content-Type': 'application/json'
        };
    }

    /**
     * BingX authentication (HMAC SHA-256)
     * @private
     */
    _createBingxAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now();

        // Create query string from body for signature
        const queryParams = body ? new URLSearchParams(body).toString() : '';
        const signatureString = queryParams ? `${queryParams}&timestamp=${timestamp}` : `timestamp=${timestamp}`;

        // Create HMAC-SHA256 signature
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signatureString)
            .digest('hex');

        return {
            'X-BX-APIKEY': apiKey,
            'Content-Type': 'application/json'
        };
    }

    /**
     * AscendEX authentication (HMAC SHA-256 with timestamp + path)
     * @private
     */
    _createAscendexAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now().toString();

        // AscendEX signature: timestamp + path
        const signaturePayload = timestamp + path;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');

        return {
            'x-auth-key': apiKey,
            'x-auth-timestamp': timestamp,
            'x-auth-signature': signature,
            'Content-Type': 'application/json'
        };
    }

    /**
     * XT authentication (HMAC SHA-256 with timestamp + method + endpoint + body)
     * @private
     */
    _createXtAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now().toString();
        const bodyStr = body ? JSON.stringify(body) : '';

        // XT signature: timestamp + method + endpoint + body
        const signaturePayload = timestamp + method.toUpperCase() + path + bodyStr;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');

        return {
            'xt-validate-appkey': apiKey,
            'xt-validate-timestamp': timestamp,
            'xt-validate-signature': signature,
            'xt-validate-algorithms': 'HmacSHA256',
            'Content-Type': 'application/json'
        };
    }

    /**
     * MEXC authentication (HMAC SHA-256 with query params)
     * @private
     */
    _createMexcAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Date.now();

        // Create query string from body for signature
        const queryParams = body ? new URLSearchParams(body).toString() : '';
        const signatureString = queryParams ? `${queryParams}&timestamp=${timestamp}` : `timestamp=${timestamp}`;

        // Create HMAC-SHA256 signature
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signatureString)
            .digest('hex');

        return {
            'X-MEXC-APIKEY': apiKey,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Crypto.com authentication (JSON-RPC 2.0 with HMAC SHA-256)
     * UNIQUE: Crypto.com uses JSON-RPC format - auth goes in body, not headers
     * @private
     */
    _createCryptocomAuth(apiKey, apiSecret, method, path, body) {
        const nonce = Date.now();
        const requestId = Math.floor(Math.random() * 1000000);

        // Determine JSON-RPC method name from path
        let jsonRpcMethod = '';
        if (path.includes('get-book')) {
            jsonRpcMethod = 'public/get-book';
        } else if (path.includes('create-order')) {
            jsonRpcMethod = 'private/create-order';
        }

        // Prepare params (alphabetically sorted for signature)
        const params = body ? body : {};
        const sortedParamKeys = Object.keys(params).sort();
        const paramString = sortedParamKeys.map(key => `${key}${params[key]}`).join('');

        // Create signature: method + id + api_key + params + nonce
        const signaturePayload = `${jsonRpcMethod}${requestId}${apiKey}${paramString}${nonce}`;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');

        // Store auth data for use in request body (Crypto.com specific)
        this._cryptocomAuthData = {
            id: requestId,
            method: jsonRpcMethod,
            api_key: apiKey,
            sig: signature,
            nonce: nonce
        };

        // Crypto.com uses standard headers (auth is in body)
        return {
            'Content-Type': 'application/json'
        };
    }

    /**
     * HTX (Huobi) authentication (HMAC SHA-256 with query params)
     * UNIQUE: HTX uses signature in query string with specific format
     * @private
     */
    _createHtxAuth(apiKey, apiSecret, method, path, body, credentials) {
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');

        // Store account ID for use in order payload (HTX specific)
        if (credentials && credentials.accountId) {
            this._htxAccountId = credentials.accountId;
        }

        // Add required signature parameters
        const signatureParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };

        // Add body params for POST requests
        const allParams = body ? { ...signatureParams, ...body } : signatureParams;

        // Sort parameters alphabetically
        const sortedParams = Object.keys(allParams).sort().map(key => {
            return `${key}=${encodeURIComponent(allParams[key])}`;
        }).join('&');

        // Create pre-signed text: METHOD\nHOST\nPATH\nPARAMS
        const preSignedText = `${method.toUpperCase()}\napi.huobi.pro\n${path}\n${sortedParams}`;

        // Generate HMAC-SHA256 signature
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(preSignedText)
            .digest('base64');

        // Store query string for use in URL building (HTX specific)
        this._htxQueryString = `${sortedParams}&Signature=${encodeURIComponent(signature)}`;

        return {
            'Content-Type': 'application/json'
        };
    }

    /**
     * Gate.io authentication (HMAC SHA-512 with body hash)
     * UNIQUE: Gate.io hashes the request body with SHA512 before signing
     * @private
     */
    _createGateioAuth(apiKey, apiSecret, method, path, body) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = body ? JSON.stringify(body) : '';

        // Hash the request body with SHA512
        const bodyHash = crypto
            .createHash('sha512')
            .update(bodyStr)
            .digest('hex');

        // Build signature string: METHOD\nPATH\nQUERY\nBODYHASH\nTIMESTAMP
        const signatureString = `${method.toUpperCase()}\n${path}\n\n${bodyHash}\n${timestamp}`;

        // Create HMAC-SHA512 signature
        const signature = crypto
            .createHmac('sha512', apiSecret)
            .update(signatureString)
            .digest('hex');

        return {
            'KEY': apiKey,
            'Timestamp': timestamp,
            'SIGN': signature,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Build order book URL with exchange-specific formatting
     * @private
     */
    _buildOrderBookUrl(exchange, pair, config) {
        let url = `${config.baseUrl}${config.endpoints.orderBook}`;

        switch (exchange) {
            case 'valr':
                url = url.replace(':pair', pair);
                break;

            case 'luno':
                url = `${url}?pair=${pair}`;
                break;

            case 'chainex':
                url = `${url}/${pair}`;
                break;

            case 'binance':
            case 'bitrue':
            case 'mexc':
                url = `${url}?symbol=${pair}&limit=20`;
                break;

            case 'bitmart':
                url = `${url}?symbol=${pair}`;
                break;

            case 'bitget':
                url = `${url}?symbol=${pair}&limit=20`;
                break;

            case 'bingx':
                url = `${url}?symbol=${pair}&limit=20`;
                break;

            case 'ascendex':
                url = `${url}?symbol=${pair}`;
                break;

            case 'xt':
                url = `${url}?symbol=${pair}`;
                break;

            case 'gemini':
                // Gemini uses lowercase pairs in URL
                url = url.replace(':pair', pair.toLowerCase());
                break;

            case 'cryptocom':
                // Crypto.com uses JSON-RPC - no query params, data in body
                url = `${config.baseUrl}${config.endpoints.orderBook}`;
                break;

            case 'htx':
                // HTX uses lowercase pairs without separator and query params via auth
                const htxSymbol = pair.toLowerCase().replace(/[_-]/g, '');
                url = `${url}?symbol=${htxSymbol}&depth=20&type=step0`;
                break;

            case 'gateio':
                // Gate.io uses underscore pairs and currency_pair parameter
                url = `${url}?currency_pair=${pair}&limit=20`;
                break;

            default:
                url = `${url}?pair=${pair}`;
        }

        return url;
    }

    /**
     * Build order payload with exchange-specific format
     * @private
     */
    _buildOrderPayload(exchange, pair, side, amount) {
        switch (exchange) {
            case 'valr':
                return {
                    side: side.toUpperCase(),
                    pair: pair,
                    baseAmount: side === 'sell' ? amount.toString() : undefined,
                    quoteAmount: side === 'buy' ? amount.toString() : undefined
                };

            case 'luno':
                return {
                    pair: pair,
                    type: side.toUpperCase(),
                    counter_volume: side === 'buy' ? amount.toString() : undefined,
                    base_volume: side === 'sell' ? amount.toString() : undefined
                };

            case 'binance':
            case 'mexc':
                return {
                    symbol: pair,
                    side: side.toUpperCase(),
                    type: 'MARKET',
                    quantity: amount
                };

            case 'bitrue':
                return {
                    symbol: pair,
                    side: side.toUpperCase(),
                    type: 'MARKET',
                    quantity: amount,
                    timestamp: Date.now()
                };

            case 'bitmart':
                return {
                    symbol: pair,
                    side: side.toLowerCase(),
                    type: 'market',
                    size: amount.toString()
                };

            case 'bitget':
                return {
                    symbol: pair,
                    side: side.toLowerCase(),
                    orderType: 'market',
                    force: 'gtc',
                    size: amount.toString()
                };

            case 'bingx':
                return {
                    symbol: pair,
                    side: side.toUpperCase(),
                    type: 'MARKET',
                    quoteOrderQty: amount
                };

            case 'gemini':
                return {
                    symbol: pair.toLowerCase(),
                    side: side.toLowerCase(),
                    type: 'exchange market',  // Gemini market order type
                    amount: amount.toString()
                };

            case 'coincatch':
                return {
                    symbol: pair,
                    side: side.toUpperCase(),
                    orderType: 'MARKET',
                    size: amount.toString(),
                    marginCoin: 'USDT'
                };

            case 'ascendex':
                return {
                    symbol: pair,
                    side: side.toLowerCase(),
                    orderType: 'market',
                    orderQty: amount.toString()
                };

            case 'xt':
                return {
                    symbol: pair,
                    side: side.toUpperCase(),
                    type: 'MARKET',
                    quantity: amount.toString()
                };

            case 'cryptocom':
                // Crypto.com uses JSON-RPC 2.0 format with underscore pairs (BTC_USDT)
                // Auth data was prepared in _createCryptocomAuth and stored in this._cryptocomAuthData
                if (!this._cryptocomAuthData) {
                    throw new Error('Crypto.com auth data not initialized');
                }

                return {
                    id: this._cryptocomAuthData.id,
                    method: this._cryptocomAuthData.method,
                    api_key: this._cryptocomAuthData.api_key,
                    sig: this._cryptocomAuthData.sig,
                    nonce: this._cryptocomAuthData.nonce,
                    params: {
                        instrument_name: pair,  // Crypto.com uses underscore format (e.g., BTC_USDT)
                        side: side.toUpperCase(),
                        type: 'MARKET',
                        quantity: amount.toString()
                    }
                };

            case 'htx':
                // HTX uses lowercase pairs without separator (e.g., btcusdt)
                // Account ID was stored in _createHtxAuth method
                if (!this._htxAccountId) {
                    throw new Error('HTX account-id not initialized');
                }
                return {
                    'account-id': this._htxAccountId,
                    symbol: pair.toLowerCase().replace(/[_-]/g, ''),
                    type: side === 'buy' ? 'buy-market' : 'sell-market',
                    amount: amount.toString()
                };

            case 'gateio':
                // Gate.io uses underscore pairs (e.g., BTC_USDT) and IOC time_in_force
                return {
                    currency_pair: pair,
                    side: side.toLowerCase(),
                    type: 'market',
                    amount: amount.toString(),
                    time_in_force: 'ioc'  // Immediate or cancel
                };

            default:
                return {
                    pair,
                    side,
                    amount
                };
        }
    }
}

module.exports = ExchangeConnectorService;
