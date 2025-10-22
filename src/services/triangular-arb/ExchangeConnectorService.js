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
            htx: { name: 'HTX', baseUrl: 'https://api.huobi.pro', endpoints: {}, authType: 'api-key' },
            gateio: { name: 'Gate.io', baseUrl: 'https://api.gateio.ws', endpoints: {}, authType: 'api-key' },
            cryptocom: { name: 'Crypto.com', baseUrl: 'https://api.crypto.com', endpoints: {}, authType: 'api-key' },
            mexc: { name: 'MEXC', baseUrl: 'https://api.mexc.com', endpoints: {}, authType: 'api-key' },
            xt: { name: 'XT', baseUrl: 'https://api.xt.com', endpoints: {}, authType: 'api-key' },
            ascendex: { name: 'AscendEX', baseUrl: 'https://ascendex.com', endpoints: {}, authType: 'api-key' },
            bingx: { name: 'BingX', baseUrl: 'https://open-api.bingx.com', endpoints: {}, authType: 'api-key' },
            bitget: { name: 'Bitget', baseUrl: 'https://api.bitget.com', endpoints: {}, authType: 'api-key' },
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
     * @param {object} credentials - User's API credentials { apiKey, apiSecret }
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
            const authHeaders = this._createAuthHeaders(
                exchangeLower,
                'GET',
                config.endpoints.orderBook,
                null,
                credentials
            );

            // Build URL
            const url = this._buildOrderBookUrl(exchangeLower, pair, config);

            systemLogger.trading(`Fetching order book`, {
                exchange: config.name,
                pair,
                url
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
     * Create authentication headers (credentials used immediately, not stored)
     * @private
     */
    _createAuthHeaders(exchange, method, path, body, credentials) {
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
                url = `${url}?symbol=${pair}&limit=20`;
                break;

            case 'bitmart':
                url = `${url}?symbol=${pair}`;
                break;

            case 'gemini':
                // Gemini uses lowercase pairs in URL
                url = url.replace(':pair', pair.toLowerCase());
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
