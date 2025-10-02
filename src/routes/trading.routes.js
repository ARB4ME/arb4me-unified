const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin, requireAdmin, optionalAuth } = require('../middleware/auth');
const { tradingRateLimit, tickerRateLimit, authenticatedRateLimit, adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { broadcastToAdmins } = require('../websocket/socketManager');

// Additional dependencies for exchange API integration
const crypto = require('crypto');
const https = require('https');

const router = express.Router();

// VALR API Helper Function
async function makeVALRRequest(endpoint, method = 'GET', data = null, apiKey, apiSecret) {
    const timestamp = new Date().getTime().toString();
    const path = endpoint;
    const verb = method.toUpperCase();
    
    // Create signature
    let bodyString = '';
    if (data && method !== 'GET') {
        bodyString = JSON.stringify(data);
    }
    
    const signaturePayload = timestamp + verb + path + bodyString;
    const signature = crypto.createHmac('sha512', apiSecret).update(signaturePayload).digest('hex');
    
    const options = {
        hostname: 'api.valr.com',
        path: path,
        method: verb,
        headers: {
            'X-VALR-API-KEY': apiKey,
            'X-VALR-SIGNATURE': signature,
            'X-VALR-TIMESTAMP': timestamp,
            'Content-Type': 'application/json'
        }
    };
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else {
                        reject(new Error(`VALR API Error: ${res.statusCode} - ${parsedData.message || responseData}`));
                    }
                } catch (parseError) {
                    reject(new Error(`Failed to parse VALR response: ${responseData}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(new Error(`VALR API Request Error: ${error.message}`));
        });
        
        if (bodyString) {
            req.write(bodyString);
        }
        
        req.end();
    });
}

// Note: We'll apply authentication selectively per route, not globally
// This allows balance endpoints to work without JWT when API keys are provided

// Connect Exchange with Strategy Support
router.post('/connect-exchange', tradingRateLimit, optionalAuth, [
    body('exchange').notEmpty().withMessage('Exchange is required'),
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('secretKey').notEmpty().withMessage('Secret key is required'),
    body('strategy').optional().isString().withMessage('Strategy must be a string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { exchange, apiKey, secretKey, strategy } = req.body;

    try {
        systemLogger.trading('Exchange connection request', {
            userId: req.user?.id || 'anonymous',
            exchange: exchange,
            strategy: strategy || 'main'
        });

        // For now, just test the connection by fetching balance
        let balances = {};

        if (exchange.toLowerCase() === 'chainex') {
            const auth = createChainEXAuth(apiKey, secretKey, CHAINEX_CONFIG.endpoints.balance);
            const response = await fetch(auth.fullUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'ARB4ME/1.0'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ChainEX API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            if (balanceData.status !== 'success') {
                throw new Error(`ChainEX API error: ${balanceData.message || 'Unknown error'}`);
            }

            // Transform ChainEX response
            if (balanceData.data && Array.isArray(balanceData.data)) {
                balanceData.data.forEach(balance => {
                    balances[balance.code] = parseFloat(balance.balance_available || 0) + parseFloat(balance.balance_held || 0);
                });
            }
        } else if (exchange.toLowerCase() === 'valr') {
            // Test VALR connection by fetching balance using existing VALR function
            const result = await makeValrRequest('/v1/account/balances', 'GET', apiKey, secretKey);

            // Transform VALR response
            if (result && Array.isArray(result)) {
                result.forEach(balance => {
                    if (balance.currency && balance.available) {
                        balances[balance.currency] = parseFloat(balance.available) + parseFloat(balance.reserved || 0);
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'luno') {
            // Test Luno connection by fetching balance
            const encodedAuth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
            const response = await fetch('https://api.luno.com/api/1/balance', {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${encodedAuth}`,
                    'User-Agent': 'ARB4ME/1.0'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Luno API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform Luno response
            if (balanceData.balance && Array.isArray(balanceData.balance)) {
                balanceData.balance.forEach(balance => {
                    if (balance.asset && balance.balance) {
                        balances[balance.asset] = parseFloat(balance.balance);
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'kraken') {
            // Test Kraken connection by fetching balance
            const nonce = Date.now().toString();
            const postdata = `nonce=${nonce}`;
            const path = KRAKEN_CONFIG.endpoints.balance;
            const signature = createKrakenSignature(path, postdata, secretKey, nonce);

            const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    'API-Key': apiKey,
                    'API-Sign': signature,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: postdata
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Kraken API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform Kraken response
            if (balanceData.error && balanceData.error.length > 0) {
                throw new Error(`Kraken API error: ${balanceData.error.join(', ')}`);
            }

            if (balanceData.result) {
                Object.keys(balanceData.result).forEach(asset => {
                    const balance = parseFloat(balanceData.result[asset]);
                    if (balance > 0) {
                        balances[asset] = balance;
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'binance') {
            // Test Binance connection by fetching balance
            const timestamp = Date.now();
            // Try without recvWindow for maximum API key compatibility
            const queryString = `timestamp=${timestamp}`;
            const signature = createBinanceSignature(queryString, secretKey);

            const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: {
                    'X-MBX-APIKEY': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Binance API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform Binance response
            if (balanceData.balances && Array.isArray(balanceData.balances)) {
                balanceData.balances.forEach(balance => {
                    const free = parseFloat(balance.free);
                    const locked = parseFloat(balance.locked);
                    const total = free + locked;
                    if (total > 0) {
                        balances[balance.asset] = total;
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'okx') {
            // Test OKX connection by fetching balance
            const { passphrase } = req.body; // OKX requires passphrase
            if (!passphrase) {
                throw new Error('OKX requires passphrase');
            }

            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = OKX_CONFIG.endpoints.balance;
            const signature = createOKXSignature(timestamp, method, requestPath, '', secretKey);

            const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
                method: 'GET',
                headers: {
                    'OK-ACCESS-KEY': apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': passphrase,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OKX API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform OKX response
            if (balanceData.code !== '0') {
                throw new Error(`OKX API error: ${balanceData.msg || 'Unknown error'}`);
            }

            if (balanceData.data && Array.isArray(balanceData.data)) {
                balanceData.data.forEach(account => {
                    if (account.details && Array.isArray(account.details)) {
                        account.details.forEach(balance => {
                            const available = parseFloat(balance.availBal || 0);
                            const frozen = parseFloat(balance.frozenBal || 0);
                            const total = available + frozen;
                            if (total > 0) {
                                balances[balance.ccy] = total;
                            }
                        });
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'mexc') {
            // Test MEXC connection by fetching balance
            const timestamp = Date.now().toString();
            const queryString = `timestamp=${timestamp}`;
            const signature = createMEXCSignature(queryString, secretKey);

            const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: {
                    'X-MEXC-APIKEY': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`MEXC API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform MEXC response
            if (balanceData.code && balanceData.code !== 0 && balanceData.code !== '0') {
                throw new Error(`MEXC API error: ${balanceData.msg || 'Unknown error'}`);
            }

            if (balanceData.balances && Array.isArray(balanceData.balances)) {
                balanceData.balances.forEach(balance => {
                    const free = parseFloat(balance.free || 0);
                    const locked = parseFloat(balance.locked || 0);
                    const total = free + locked;
                    if (total > 0) {
                        balances[balance.asset] = total;
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'kucoin') {
            // Test KuCoin connection by fetching balance
            const { passphrase } = req.body; // KuCoin requires passphrase
            if (!passphrase) {
                throw new Error('KuCoin requires passphrase');
            }

            const timestamp = Date.now().toString();
            const method = 'GET';
            const endpoint = KUCOIN_CONFIG.endpoints.balance;
            const signature = createKuCoinSignature(timestamp, method, endpoint, '', secretKey);
            const passphraseEncrypted = crypto.createHmac('sha256', secretKey).update(passphrase).digest('base64');

            const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
                method: 'GET',
                headers: {
                    'KC-API-KEY': apiKey,
                    'KC-API-SIGN': signature,
                    'KC-API-TIMESTAMP': timestamp,
                    'KC-API-PASSPHRASE': passphraseEncrypted,
                    'KC-API-KEY-VERSION': '2',
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`KuCoin API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform KuCoin response
            if (balanceData.code !== '200000') {
                throw new Error(`KuCoin API error: ${balanceData.msg || 'Unknown error'}`);
            }

            if (balanceData.data && Array.isArray(balanceData.data)) {
                balanceData.data.forEach(account => {
                    const balance = parseFloat(account.balance || 0);
                    if (balance > 0) {
                        balances[account.currency] = balance;
                    }
                });
            }
        } else if (exchange.toLowerCase() === 'htx') {
            // Test HTX connection by fetching balance
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
            const params = {
                AccessKeyId: apiKey,
                SignatureMethod: 'HmacSHA256',
                SignatureVersion: '2',
                Timestamp: timestamp
            };

            // Sort parameters alphabetically for signature
            const sortedParams = Object.keys(params).sort().reduce((acc, key) => {
                acc[key] = params[key];
                return acc;
            }, {});
            const sortedParamsString = Object.keys(sortedParams).map(key => `${key}=${encodeURIComponent(sortedParams[key])}`).join('&');

            // Create signature string
            const signatureString = `GET\napi.huobi.pro\n${HTX_CONFIG.endpoints.accounts}\n${sortedParamsString}`;
            const signature = createHTXSignature('GET', 'api.huobi.pro', HTX_CONFIG.endpoints.accounts, params, secretKey);
            params.Signature = signature;

            const accountsUrl = `${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.accounts}?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;
            const accountsResponse = await fetch(accountsUrl);

            if (!accountsResponse.ok) {
                const errorText = await accountsResponse.text();
                throw new Error(`HTX API error: ${accountsResponse.status} - ${errorText}`);
            }

            const accountsData = await accountsResponse.json();

            if (accountsData.status !== 'ok') {
                throw new Error(`HTX API error: ${accountsData['err-msg'] || 'Authentication failed'}`);
            }

            // Get first spot account ID
            const spotAccount = accountsData.data.find(acc => acc.type === 'spot');
            if (spotAccount) {
                // Fetch actual balances
                const balanceParams = {
                    AccessKeyId: apiKey,
                    SignatureMethod: 'HmacSHA256',
                    SignatureVersion: '2',
                    Timestamp: timestamp,
                    'account-id': spotAccount.id
                };

                const balanceSortedParams = Object.keys(balanceParams).sort().reduce((acc, key) => {
                    acc[key] = balanceParams[key];
                    return acc;
                }, {});
                const balanceSortedParamsString = Object.keys(balanceSortedParams).map(key => `${key}=${encodeURIComponent(balanceSortedParams[key])}`).join('&');

                const balanceEndpoint = HTX_CONFIG.endpoints.balance.replace('{account-id}', spotAccount.id);
                const balanceSignatureString = `GET\napi.huobi.pro\n${balanceEndpoint}\n${balanceSortedParamsString}`;
                const balanceSignature = createHTXSignature('GET', 'api.huobi.pro', balanceEndpoint, balanceParams, secretKey);
                balanceParams.Signature = balanceSignature;

                const balanceUrl = `${HTX_CONFIG.baseUrl}${balanceEndpoint}?${Object.keys(balanceParams).map(key => `${key}=${encodeURIComponent(balanceParams[key])}`).join('&')}`;
                const balanceResponse = await fetch(balanceUrl);

                if (balanceResponse.ok) {
                    const balanceData = await balanceResponse.json();
                    if (balanceData.status === 'ok' && balanceData.data && balanceData.data.list) {
                        balanceData.data.list.forEach(balance => {
                            const total = parseFloat(balance.balance || 0);
                            if (total > 0) {
                                balances[balance.currency.toUpperCase()] = total;
                            }
                        });
                    }
                }
            }
        } else if (exchange.toLowerCase() === 'bitget') {
            // Test Bitget connection by fetching balance
            const { passphrase } = req.body; // Bitget requires passphrase
            if (!passphrase) {
                throw new Error('Bitget requires passphrase');
            }

            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = BITGET_CONFIG.endpoints.balance;
            const signature = createBitgetSignature(timestamp, method, requestPath, '', secretKey);

            const response = await fetch(`${BITGET_CONFIG.baseUrl}${requestPath}`, {
                method: 'GET',
                headers: {
                    'ACCESS-KEY': apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': passphrase,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Bitget API error: ${response.status} - ${errorText}`);
            }

            const balanceData = await response.json();

            // Transform Bitget response
            if (balanceData.code !== '00000') {
                throw new Error(`Bitget API error: ${balanceData.msg || 'Unknown error'}`);
            }

            if (balanceData.data && Array.isArray(balanceData.data)) {
                balanceData.data.forEach(balance => {
                    const available = parseFloat(balance.available || 0);
                    const frozen = parseFloat(balance.frozen || 0);
                    const total = available + frozen;
                    if (total > 0) {
                        balances[balance.coin] = total;
                    }
                });
            }
        } else {
            throw new APIError(`Exchange ${exchange} not supported`, 400, 'UNSUPPORTED_EXCHANGE');
        }

        systemLogger.trading('Exchange connected successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: exchange,
            strategy: strategy || 'main',
            balanceCount: Object.keys(balances).length
        });

        res.json({
            success: true,
            message: `${exchange} connected successfully`,
            balance: balances
        });

    } catch (error) {
        systemLogger.error('Exchange connection failed', {
            userId: req.user?.id || 'anonymous',
            exchange: exchange,
            strategy: strategy || 'main',
            error: error.message
        });

        throw new APIError(`Connection failed: ${error.message}`, 500, 'EXCHANGE_CONNECTION_ERROR');
    }
}));

// Test Strategy Connection
router.post('/test-connection', tradingRateLimit, optionalAuth, [
    body('exchange').notEmpty().withMessage('Exchange is required'),
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('secretKey').notEmpty().withMessage('Secret key is required'),
    body('strategy').optional().isString().withMessage('Strategy must be a string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { exchange, apiKey, secretKey, strategy } = req.body;

    try {
        systemLogger.trading('Connection test request', {
            userId: req.user?.id || 'anonymous',
            exchange: exchange,
            strategy: strategy || 'main'
        });

        // Test the connection
        if (exchange.toLowerCase() === 'chainex') {
            const auth = createChainEXAuth(apiKey, secretKey, CHAINEX_CONFIG.endpoints.balance);
            const response = await fetch(auth.fullUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'ARB4ME/1.0'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.status === 'success') {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'valr') {
            // Test VALR connection using existing VALR function
            const result = await makeValrRequest('/v1/account/balances', 'GET', apiKey, secretKey);

            if (result && Array.isArray(result)) {
                res.json({
                    success: true,
                    message: 'Connection test successful'
                });
                return;
            }

            throw new Error('Connection test failed - invalid credentials or API error');
        } else if (exchange.toLowerCase() === 'luno') {
            // Test Luno connection
            const encodedAuth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
            const response = await fetch('https://api.luno.com/api/1/balance', {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${encodedAuth}`,
                    'User-Agent': 'ARB4ME/1.0'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.balance && Array.isArray(data.balance)) {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'kraken') {
            // Test Kraken connection
            const nonce = Date.now().toString();
            const postdata = `nonce=${nonce}`;
            const path = KRAKEN_CONFIG.endpoints.balance;
            const signature = createKrakenSignature(path, postdata, secretKey, nonce);

            const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    'API-Key': apiKey,
                    'API-Sign': signature,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: postdata
            });

            if (response.ok) {
                const data = await response.json();
                if (data.result && !data.error?.length) {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'binance') {
            // Test Binance connection
            const timestamp = Date.now();
            // Try without recvWindow for maximum API key compatibility
            const queryString = `timestamp=${timestamp}`;
            const signature = createBinanceSignature(queryString, secretKey);

            const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: {
                    'X-MBX-APIKEY': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.balances && Array.isArray(data.balances)) {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'okx') {
            // Test OKX connection
            const { passphrase } = req.body; // OKX requires passphrase
            if (!passphrase) {
                throw new Error('OKX requires passphrase');
            }

            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = OKX_CONFIG.endpoints.balance;
            const signature = createOKXSignature(timestamp, method, requestPath, '', secretKey);

            const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
                method: 'GET',
                headers: {
                    'OK-ACCESS-KEY': apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': passphrase,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.code === '0') {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'mexc') {
            // Test MEXC connection
            const timestamp = Date.now().toString();
            const queryString = `timestamp=${timestamp}`;
            const signature = createMEXCSignature(queryString, secretKey);

            const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
                method: 'GET',
                headers: {
                    'X-MEXC-APIKEY': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (!data.code || data.code === 0 || data.code === '0') {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'kucoin') {
            // Test KuCoin connection
            const { passphrase } = req.body; // KuCoin requires passphrase
            if (!passphrase) {
                throw new Error('KuCoin requires passphrase');
            }

            const timestamp = Date.now().toString();
            const method = 'GET';
            const endpoint = KUCOIN_CONFIG.endpoints.balance;
            const signature = createKuCoinSignature(timestamp, method, endpoint, '', secretKey);
            const passphraseEncrypted = crypto.createHmac('sha256', secretKey).update(passphrase).digest('base64');

            const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
                method: 'GET',
                headers: {
                    'KC-API-KEY': apiKey,
                    'KC-API-SIGN': signature,
                    'KC-API-TIMESTAMP': timestamp,
                    'KC-API-PASSPHRASE': passphraseEncrypted,
                    'KC-API-KEY-VERSION': '2',
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.code === '200000') {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'htx') {
            // Test HTX connection
            const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
            const params = {
                AccessKeyId: apiKey,
                SignatureMethod: 'HmacSHA256',
                SignatureVersion: '2',
                Timestamp: timestamp
            };

            // Sort parameters alphabetically for signature
            const sortedParams = Object.keys(params).sort().reduce((acc, key) => {
                acc[key] = params[key];
                return acc;
            }, {});
            const sortedParamsString = Object.keys(sortedParams).map(key => `${key}=${encodeURIComponent(sortedParams[key])}`).join('&');

            // Create signature string
            const signatureString = `GET\napi.huobi.pro\n${HTX_CONFIG.endpoints.accounts}\n${sortedParamsString}`;
            const signature = createHTXSignature('GET', 'api.huobi.pro', HTX_CONFIG.endpoints.accounts, params, secretKey);
            params.Signature = signature;

            const accountsUrl = `${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.accounts}?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;
            const accountsResponse = await fetch(accountsUrl);

            if (accountsResponse.ok) {
                const accountsData = await accountsResponse.json();
                if (accountsData.status === 'ok') {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else if (exchange.toLowerCase() === 'bitget') {
            // Test Bitget connection
            const { passphrase } = req.body; // Bitget requires passphrase
            if (!passphrase) {
                throw new Error('Bitget requires passphrase');
            }

            const timestamp = Date.now().toString();
            const method = 'GET';
            const requestPath = BITGET_CONFIG.endpoints.balance;
            const signature = createBitgetSignature(timestamp, method, requestPath, '', secretKey);

            const response = await fetch(`${BITGET_CONFIG.baseUrl}${requestPath}`, {
                method: 'GET',
                headers: {
                    'ACCESS-KEY': apiKey,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': passphrase,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.code === '00000') {
                    res.json({
                        success: true,
                        message: 'Connection test successful'
                    });
                    return;
                }
            }

            throw new Error('Connection test failed - invalid credentials');
        } else {
            throw new APIError(`Exchange ${exchange} not supported`, 400, 'UNSUPPORTED_EXCHANGE');
        }

    } catch (error) {
        systemLogger.error('Connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: exchange,
            strategy: strategy || 'main',
            error: error.message
        });

        throw new APIError(`Test failed: ${error.message}`, 500, 'CONNECTION_TEST_ERROR');
    }
}));

// GET /api/v1/trading/activity - Get user's trading activity
router.get('/activity', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const activityResult = await query(`
        SELECT 
            exchanges_connected, exchanges_connected_count, selected_crypto_assets,
            trading_active, auto_trading_enabled, total_trades_count,
            successful_trades_count, failed_trades_count, profit_loss_total,
            api_keys_configured, usdt_balance_detected, safety_controls_completed,
            auto_trading_readiness_percent, last_trading_activity, created_at, updated_at
        FROM trading_activity
        WHERE user_id = $1
    `, [req.user.id]);
    
    if (activityResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const activity = activityResult.rows[0];
    
    res.json({
        success: true,
        data: {
            tradingActivity: {
                exchangesConnected: JSON.parse(activity.exchanges_connected || '[]'),
                exchangesConnectedCount: activity.exchanges_connected_count,
                selectedCryptoAssets: JSON.parse(activity.selected_crypto_assets || '[]'),
                tradingActive: activity.trading_active,
                autoTradingEnabled: activity.auto_trading_enabled,
                totalTrades: activity.total_trades_count,
                successfulTrades: activity.successful_trades_count,
                failedTrades: activity.failed_trades_count,
                profitLoss: parseFloat(activity.profit_loss_total),
                apiKeysConfigured: activity.api_keys_configured,
                usdtBalanceDetected: activity.usdt_balance_detected,
                safetyControlsCompleted: activity.safety_controls_completed,
                autoTradingReadinessPercent: activity.auto_trading_readiness_percent,
                lastTradingActivity: activity.last_trading_activity,
                createdAt: activity.created_at,
                updatedAt: activity.updated_at
            }
        }
    });
}));

// PUT /api/v1/trading/activity - Update trading activity (bulk update)
router.put('/activity', authenticatedRateLimit, authenticateUser, tradingRateLimit, [
    body('exchangesConnected').optional().isArray().withMessage('Exchanges connected must be an array'),
    body('selectedCryptoAssets').optional().isArray().withMessage('Selected crypto assets must be an array'),
    body('tradingActive').optional().isBoolean().withMessage('Trading active must be boolean'),
    body('autoTradingEnabled').optional().isBoolean().withMessage('Auto trading enabled must be boolean'),
    body('apiKeysConfigured').optional().isBoolean().withMessage('API keys configured must be boolean'),
    body('usdtBalanceDetected').optional().isBoolean().withMessage('USDT balance detected must be boolean'),
    body('safetyControlsCompleted').optional().isBoolean().withMessage('Safety controls completed must be boolean')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const {
        exchangesConnected,
        selectedCryptoAssets,
        tradingActive,
        autoTradingEnabled,
        apiKeysConfigured,
        usdtBalanceDetected,
        safetyControlsCompleted
    } = req.body;
    
    const updates = [];
    const values = [];
    let valueIndex = 1;
    
    // Build dynamic update query
    if (exchangesConnected !== undefined) {
        updates.push(`exchanges_connected = $${valueIndex++}`);
        values.push(JSON.stringify(exchangesConnected));
    }
    if (selectedCryptoAssets !== undefined) {
        updates.push(`selected_crypto_assets = $${valueIndex++}`);
        values.push(JSON.stringify(selectedCryptoAssets));
    }
    if (tradingActive !== undefined) {
        updates.push(`trading_active = $${valueIndex++}`);
        values.push(tradingActive);
    }
    if (autoTradingEnabled !== undefined) {
        updates.push(`auto_trading_enabled = $${valueIndex++}`);
        values.push(autoTradingEnabled);
    }
    if (apiKeysConfigured !== undefined) {
        updates.push(`api_keys_configured = $${valueIndex++}`);
        values.push(apiKeysConfigured);
    }
    if (usdtBalanceDetected !== undefined) {
        updates.push(`usdt_balance_detected = $${valueIndex++}`);
        values.push(usdtBalanceDetected);
    }
    if (safetyControlsCompleted !== undefined) {
        updates.push(`safety_controls_completed = $${valueIndex++}`);
        values.push(safetyControlsCompleted);
    }
    
    if (updates.length === 0) {
        throw new APIError('No valid fields to update', 400, 'NO_UPDATES');
    }
    
    // Add automatic fields
    updates.push('last_trading_activity = CURRENT_TIMESTAMP');
    updates.push('updated_at = CURRENT_TIMESTAMP');
    
    // Calculate readiness percentage
    let readinessScore = 0;
    if (apiKeysConfigured !== undefined ? apiKeysConfigured : false) readinessScore += 25;
    if (usdtBalanceDetected !== undefined ? usdtBalanceDetected : false) readinessScore += 25;
    if (safetyControlsCompleted !== undefined ? safetyControlsCompleted : false) readinessScore += 25;
    if (selectedCryptoAssets && selectedCryptoAssets.length > 0) readinessScore += 25;
    
    updates.push(`auto_trading_readiness_percent = $${valueIndex++}`);
    values.push(readinessScore);
    
    values.push(req.user.id);
    
    const updateResult = await query(
        `UPDATE trading_activity SET ${updates.join(', ')} WHERE user_id = $${valueIndex}
         RETURNING exchanges_connected, selected_crypto_assets, trading_active, auto_trading_enabled,
                   api_keys_configured, usdt_balance_detected, safety_controls_completed,
                   auto_trading_readiness_percent, last_trading_activity`,
        values
    );
    
    if (updateResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const updatedActivity = updateResult.rows[0];
    
    // Log user activity
    await query(
        'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [req.user.id, 'trading_activity_updated', {
            readinessPercent: readinessScore,
            tradingActive: tradingActive,
            autoTradingEnabled: autoTradingEnabled,
            assetsSelected: selectedCryptoAssets?.length || 0,
            exchangesConnected: exchangesConnected?.length || 0
        }, req.ip, req.get('User-Agent')]
    );
    
    // Notify admins if significant changes
    if (tradingActive !== undefined || autoTradingEnabled !== undefined) {
        broadcastToAdmins('user_trading_status_changed', {
            userId: req.user?.id || 'anonymous',
            userName: `${req.user.first_name} ${req.user.last_name}`,
            tradingActive: updatedActivity.trading_active,
            autoTradingEnabled: updatedActivity.auto_trading_enabled,
            readinessPercent: readinessScore,
            timestamp: new Date()
        });
    }
    
    systemLogger.trading('Trading activity updated', {
        userId: req.user.id,
        readinessPercent: readinessScore,
        tradingActive: updatedActivity.trading_active,
        autoTradingEnabled: updatedActivity.auto_trading_enabled
    });
    
    res.json({
        success: true,
        data: {
            tradingActivity: {
                exchangesConnected: JSON.parse(updatedActivity.exchanges_connected || '[]'),
                selectedCryptoAssets: JSON.parse(updatedActivity.selected_crypto_assets || '[]'),
                tradingActive: updatedActivity.trading_active,
                autoTradingEnabled: updatedActivity.auto_trading_enabled,
                apiKeysConfigured: updatedActivity.api_keys_configured,
                usdtBalanceDetected: updatedActivity.usdt_balance_detected,
                safetyControlsCompleted: updatedActivity.safety_controls_completed,
                autoTradingReadinessPercent: updatedActivity.auto_trading_readiness_percent,
                lastTradingActivity: updatedActivity.last_trading_activity
            }
        },
        message: 'Trading activity updated successfully'
    });
}));

// POST /api/v1/trading/trades - Record a completed trade
router.post('/trades', authenticatedRateLimit, authenticateUser, tradingRateLimit, [
    body('exchangePair').notEmpty().withMessage('Exchange pair is required'),
    body('asset').notEmpty().withMessage('Asset is required'),
    body('buyExchange').notEmpty().withMessage('Buy exchange is required'),
    body('sellExchange').notEmpty().withMessage('Sell exchange is required'),
    body('buyPrice').isFloat({ min: 0 }).withMessage('Buy price must be a positive number'),
    body('sellPrice').isFloat({ min: 0 }).withMessage('Sell price must be a positive number'),
    body('amount').isFloat({ min: 0 }).withMessage('Amount must be a positive number'),
    body('profit').isFloat().withMessage('Profit must be a number'),
    body('fees').optional().isFloat({ min: 0 }).withMessage('Fees must be a positive number'),
    body('successful').isBoolean().withMessage('Successful must be boolean'),
    body('errorMessage').optional().isString().withMessage('Error message must be string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const {
        exchangePair,
        asset,
        buyExchange,
        sellExchange,
        buyPrice,
        sellPrice,
        amount,
        profit,
        fees = 0,
        successful,
        errorMessage
    } = req.body;
    
    await transaction(async (client) => {
        // Update trading activity statistics
        const updateQuery = `
            UPDATE trading_activity 
            SET total_trades_count = total_trades_count + 1,
                successful_trades_count = successful_trades_count + ${successful ? 1 : 0},
                failed_trades_count = failed_trades_count + ${successful ? 0 : 1},
                profit_loss_total = profit_loss_total + $2,
                last_trading_activity = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
            RETURNING total_trades_count, successful_trades_count, failed_trades_count, profit_loss_total
        `;
        
        const updateResult = await client.query(updateQuery, [req.user.id, profit]);
        
        if (updateResult.rows.length === 0) {
            throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
        }
        
        const stats = updateResult.rows[0];
        
        // Log detailed trade information
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'trade_completed', {
                exchangePair,
                asset,
                buyExchange,
                sellExchange,
                buyPrice,
                sellPrice,
                amount,
                profit,
                fees,
                successful,
                errorMessage,
                netProfit: profit - fees,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of significant trades or failures
        if (!successful || Math.abs(profit) > 100) { // Failed trades or large profits
            broadcastToAdmins('significant_trade_event', {
                userId: req.user?.id || 'anonymous',
                userName: `${req.user.first_name} ${req.user.last_name}`,
                asset,
                profit,
                successful,
                errorMessage,
                exchangePair: `${buyExchange} → ${sellExchange}`,
                timestamp: new Date()
            });
        }
        
        systemLogger.trading('Trade recorded', {
            userId: req.user?.id || 'anonymous',
            asset,
            profit,
            successful,
            totalTrades: stats.total_trades_count,
            totalProfit: parseFloat(stats.profit_loss_total)
        });
        
        res.status(201).json({
            success: true,
            data: {
                trade: {
                    exchangePair,
                    asset,
                    buyExchange,
                    sellExchange,
                    buyPrice,
                    sellPrice,
                    amount,
                    profit,
                    fees,
                    netProfit: profit - fees,
                    successful,
                    timestamp: new Date()
                },
                updatedStats: {
                    totalTrades: stats.total_trades_count,
                    successfulTrades: stats.successful_trades_count,
                    failedTrades: stats.failed_trades_count,
                    totalProfitLoss: parseFloat(stats.profit_loss_total)
                }
            },
            message: 'Trade recorded successfully'
        });
    });
}));

// GET /api/v1/trading/trades/history - Get user's trade history
router.get('/trades/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const successful = req.query.successful; // true, false, or undefined for all
    const asset = req.query.asset; // filter by specific asset
    
    let whereClause = 'WHERE ua.user_id = $1 AND ua.activity_type = $2';
    const queryParams = [req.user.id, 'trade_completed'];
    let paramIndex = 3;
    
    if (successful !== undefined) {
        whereClause += ` AND (ua.activity_details->>'successful')::boolean = $${paramIndex++}`;
        queryParams.push(successful === 'true');
    }
    
    if (asset) {
        whereClause += ` AND ua.activity_details->>'asset' = $${paramIndex++}`;
        queryParams.push(asset);
    }
    
    queryParams.push(limit, offset);
    
    const tradesResult = await query(`
        SELECT ua.activity_details, ua.created_at
        FROM user_activity ua
        ${whereClause}
        ORDER BY ua.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, queryParams);
    
    // Get total count
    const countParams = queryParams.slice(0, -2);
    const countResult = await query(`
        SELECT COUNT(*) as total
        FROM user_activity ua
        ${whereClause.replace(/\$(\d+)/g, (match, num) => {
            const newNum = parseInt(num);
            return newNum <= countParams.length ? match : '';
        })}
    `, countParams);
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    const trades = tradesResult.rows.map(row => ({
        ...row.activity_details,
        timestamp: row.created_at
    }));
    
    res.json({
        success: true,
        data: {
            trades,
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// GET /api/v1/trading/stats - Get trading statistics and analytics
router.get('/stats', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    const timeRange = req.query.range || '30d'; // 7d, 30d, 90d, all
    
    let interval = '30 days';
    if (timeRange === '7d') interval = '7 days';
    else if (timeRange === '90d') interval = '90 days';
    
    // Get basic trading stats
    const basicStatsResult = await query(`
        SELECT 
            total_trades_count, successful_trades_count, failed_trades_count,
            profit_loss_total, auto_trading_readiness_percent,
            trading_active, auto_trading_enabled, last_trading_activity
        FROM trading_activity
        WHERE user_id = $1
    `, [req.user.id]);
    
    if (basicStatsResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const basicStats = basicStatsResult.rows[0];
    
    // Get trade history within time range (if not 'all')
    let timeCondition = '';
    const params = [req.user.id, 'trade_completed'];
    
    if (timeRange !== 'all') {
        timeCondition = 'AND ua.created_at > NOW() - INTERVAL $3';
        params.push(interval);
    }
    
    const tradeHistoryResult = await query(`
        SELECT 
            (ua.activity_details->>'successful')::boolean as successful,
            (ua.activity_details->>'profit')::decimal as profit,
            ua.activity_details->>'asset' as asset,
            ua.activity_details->>'buyExchange' as buy_exchange,
            ua.activity_details->>'sellExchange' as sell_exchange,
            DATE_TRUNC('day', ua.created_at) as trade_date
        FROM user_activity ua
        WHERE ua.user_id = $1 AND ua.activity_type = $2 ${timeCondition}
        ORDER BY ua.created_at DESC
    `, params);
    
    // Calculate statistics
    const trades = tradeHistoryResult.rows;
    const successfulTrades = trades.filter(t => t.successful);
    const failedTrades = trades.filter(t => !t.successful);
    
    // Profit by day
    const profitByDay = {};
    trades.forEach(trade => {
        const day = trade.trade_date.toISOString().split('T')[0];
        if (!profitByDay[day]) profitByDay[day] = 0;
        profitByDay[day] += parseFloat(trade.profit || 0);
    });
    
    // Most profitable assets
    const assetProfits = {};
    trades.forEach(trade => {
        const asset = trade.asset;
        if (!assetProfits[asset]) assetProfits[asset] = { profit: 0, count: 0 };
        assetProfits[asset].profit += parseFloat(trade.profit || 0);
        assetProfits[asset].count += 1;
    });
    
    // Exchange pair performance
    const exchangePairStats = {};
    trades.forEach(trade => {
        const pair = `${trade.buy_exchange} → ${trade.sell_exchange}`;
        if (!exchangePairStats[pair]) {
            exchangePairStats[pair] = { trades: 0, profit: 0, successful: 0 };
        }
        exchangePairStats[pair].trades += 1;
        exchangePairStats[pair].profit += parseFloat(trade.profit || 0);
        if (trade.successful) exchangePairStats[pair].successful += 1;
    });
    
    const stats = {
        overview: {
            totalTrades: basicStats.total_trades_count,
            successfulTrades: basicStats.successful_trades_count,
            failedTrades: basicStats.failed_trades_count,
            successRate: basicStats.total_trades_count > 0 
                ? (basicStats.successful_trades_count / basicStats.total_trades_count * 100).toFixed(2)
                : 0,
            totalProfitLoss: parseFloat(basicStats.profit_loss_total),
            avgProfitPerTrade: trades.length > 0 
                ? (trades.reduce((sum, t) => sum + parseFloat(t.profit || 0), 0) / trades.length).toFixed(4)
                : 0,
            autoTradingReadiness: basicStats.auto_trading_readiness_percent,
            tradingActive: basicStats.trading_active,
            autoTradingEnabled: basicStats.auto_trading_enabled,
            lastActivity: basicStats.last_trading_activity
        },
        timeRange: {
            period: timeRange,
            tradesInPeriod: trades.length,
            profitInPeriod: trades.reduce((sum, t) => sum + parseFloat(t.profit || 0), 0).toFixed(4),
            successfulInPeriod: successfulTrades.length,
            failedInPeriod: failedTrades.length
        },
        profitByDay: Object.entries(profitByDay)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, profit]) => ({
                date,
                profit: parseFloat(profit.toFixed(4))
            })),
        topAssets: Object.entries(assetProfits)
            .sort(([,a], [,b]) => b.profit - a.profit)
            .slice(0, 10)
            .map(([asset, data]) => ({
                asset,
                profit: parseFloat(data.profit.toFixed(4)),
                trades: data.count,
                avgProfitPerTrade: parseFloat((data.profit / data.count).toFixed(4))
            })),
        exchangePairPerformance: Object.entries(exchangePairStats)
            .sort(([,a], [,b]) => b.profit - a.profit)
            .slice(0, 10)
            .map(([pair, data]) => ({
                pair,
                trades: data.trades,
                profit: parseFloat(data.profit.toFixed(4)),
                successfulTrades: data.successful,
                successRate: ((data.successful / data.trades) * 100).toFixed(2)
            }))
    };
    
    res.json({
        success: true,
        data: stats
    });
}));

// Admin-only routes for trading oversight
// GET /api/v1/trading/admin/overview - Get platform-wide trading overview
router.get('/admin/overview', adminRateLimit, requireAdmin, asyncHandler(async (req, res) => {
    // Get platform-wide trading statistics
    const platformStatsResult = await query(`
        SELECT 
            COUNT(DISTINCT user_id) as total_active_traders,
            COUNT(DISTINCT CASE WHEN trading_active = true THEN user_id END) as currently_trading,
            COUNT(DISTINCT CASE WHEN auto_trading_enabled = true THEN user_id END) as auto_trading_users,
            SUM(total_trades_count) as platform_total_trades,
            SUM(successful_trades_count) as platform_successful_trades,
            SUM(failed_trades_count) as platform_failed_trades,
            SUM(profit_loss_total) as platform_total_profit,
            AVG(auto_trading_readiness_percent) as avg_readiness_percent
        FROM trading_activity
    `);
    
    // Get recent trading activity (last 24 hours)
    const recentActivityResult = await query(`
        SELECT 
            u.id, u.first_name, u.last_name,
            ua.activity_details, ua.created_at
        FROM user_activity ua
        JOIN users u ON ua.user_id = u.id
        WHERE ua.activity_type = 'trade_completed' 
          AND ua.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY ua.created_at DESC
        LIMIT 50
    `);
    
    // Get top performers (last 30 days)
    const topPerformersResult = await query(`
        SELECT 
            u.id, u.first_name, u.last_name,
            ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
            COUNT(ua.id) as recent_trades,
            SUM((ua.activity_details->>'profit')::decimal) as recent_profit
        FROM trading_activity ta
        JOIN users u ON ta.user_id = u.id
        LEFT JOIN user_activity ua ON (
            ua.user_id = u.id 
            AND ua.activity_type = 'trade_completed'
            AND ua.created_at > NOW() - INTERVAL '30 days'
        )
        WHERE ta.total_trades_count > 0
        GROUP BY u.id, u.first_name, u.last_name, ta.total_trades_count, 
                 ta.successful_trades_count, ta.profit_loss_total
        ORDER BY recent_profit DESC NULLS LAST
        LIMIT 20
    `);
    
    const platformOverview = {
        statistics: {
            totalActiveTraders: parseInt(platformStatsResult.rows[0].total_active_traders),
            currentlyTrading: parseInt(platformStatsResult.rows[0].currently_trading),
            autoTradingUsers: parseInt(platformStatsResult.rows[0].auto_trading_users),
            platformTotalTrades: parseInt(platformStatsResult.rows[0].platform_total_trades),
            platformSuccessfulTrades: parseInt(platformStatsResult.rows[0].platform_successful_trades),
            platformFailedTrades: parseInt(platformStatsResult.rows[0].platform_failed_trades),
            platformTotalProfit: parseFloat(platformStatsResult.rows[0].platform_total_profit || 0),
            avgReadinessPercent: parseFloat(platformStatsResult.rows[0].avg_readiness_percent || 0),
            platformSuccessRate: platformStatsResult.rows[0].platform_total_trades > 0
                ? ((platformStatsResult.rows[0].platform_successful_trades / platformStatsResult.rows[0].platform_total_trades) * 100).toFixed(2)
                : 0
        },
        recentActivity: recentActivityResult.rows.map(row => ({
            userId: row.id,
            userName: `${row.first_name} ${row.last_name}`,
            tradeDetails: row.activity_details,
            timestamp: row.created_at
        })),
        topPerformers: topPerformersResult.rows.map(row => ({
            userId: row.id,
            userName: `${row.first_name} ${row.last_name}`,
            totalTrades: row.total_trades_count,
            successfulTrades: row.successful_trades_count,
            allTimeProfit: parseFloat(row.profit_loss_total || 0),
            recentTrades: parseInt(row.recent_trades || 0),
            recentProfit: parseFloat(row.recent_profit || 0)
        })),
        timestamp: new Date()
    };
    
    systemLogger.admin('Trading platform overview accessed', {
        adminId: req.user.id
    });
    
    res.json({
        success: true,
        data: platformOverview
    });
}));

// GET /api/v1/trading/admin/user/:userId/activity - Get specific user's trading activity (admin view)
router.get('/admin/user/:userId/activity', requireAdmin, asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    
    // Get user's complete trading activity
    const userActivityResult = await query(`
        SELECT 
            ta.*, 
            u.first_name, u.last_name, u.email
        FROM trading_activity ta
        JOIN users u ON ta.user_id = u.id
        WHERE ta.user_id = $1
    `, [userId]);
    
    if (userActivityResult.rows.length === 0) {
        throw new APIError('User trading activity not found', 404, 'USER_TRADING_NOT_FOUND');
    }
    
    const activity = userActivityResult.rows[0];
    
    // Get recent trades
    const recentTradesResult = await query(`
        SELECT activity_details, created_at
        FROM user_activity
        WHERE user_id = $1 AND activity_type = 'trade_completed'
        ORDER BY created_at DESC
        LIMIT 50
    `, [userId]);
    
    const userTradingActivity = {
        userInfo: {
            id: userId,
            name: `${activity.first_name} ${activity.last_name}`,
            email: activity.email
        },
        tradingActivity: {
            exchangesConnected: JSON.parse(activity.exchanges_connected || '[]'),
            exchangesConnectedCount: activity.exchanges_connected_count,
            selectedCryptoAssets: JSON.parse(activity.selected_crypto_assets || '[]'),
            tradingActive: activity.trading_active,
            autoTradingEnabled: activity.auto_trading_enabled,
            totalTrades: activity.total_trades_count,
            successfulTrades: activity.successful_trades_count,
            failedTrades: activity.failed_trades_count,
            profitLoss: parseFloat(activity.profit_loss_total),
            apiKeysConfigured: activity.api_keys_configured,
            usdtBalanceDetected: activity.usdt_balance_detected,
            safetyControlsCompleted: activity.safety_controls_completed,
            autoTradingReadinessPercent: activity.auto_trading_readiness_percent,
            lastTradingActivity: activity.last_trading_activity,
            createdAt: activity.created_at,
            updatedAt: activity.updated_at
        },
        recentTrades: recentTradesResult.rows.map(row => ({
            ...row.activity_details,
            timestamp: row.created_at
        }))
    };
    
    systemLogger.admin('User trading activity accessed', {
        adminId: req.user.id,
        targetUserId: userId
    });
    
    res.json({
        success: true,
        data: userTradingActivity
    });
}));

// ============================================================================
// LUNO EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// LUNO API Configuration
const LUNO_CONFIG = {
    baseUrl: 'https://api.luno.com',
    endpoints: {
        balance: '/api/1/balance',
        ticker: '/api/1/ticker',
        tickers: '/api/1/tickers',
        order: '/api/1/marketorder'
    }
};

// LUNO Trading Pairs Endpoint
router.get('/luno/pairs', tickerRateLimit, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('LUNO pairs request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'pairs'
        });

        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.tickers}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const tickersData = await response.json();
        
        // Extract pairs from tickers response
        const pairs = tickersData.tickers.map(ticker => ({
            pair: ticker.pair,
            status: ticker.status,
            last_trade: ticker.last_trade,
            rolling_24_hour_volume: ticker.rolling_24_hour_volume
        }));
        
        systemLogger.trading('LUNO pairs retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            pairCount: pairs.length
        });

        res.json({
            success: true,
            pairs: pairs,
            exchange: 'LUNO'
        });

    } catch (error) {
        systemLogger.error('LUNO pairs request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message
        });

        throw new APIError(`LUNO pairs request failed: ${error.message}`, 500, 'LUNO_PAIRS_ERROR');
    }
}));

// LUNO Authentication Helper - Simple Basic Auth
function createLunoAuth(apiKey, apiSecret) {
    return Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
}

// LUNO Balance Endpoint
router.post('/luno/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('LUNO balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'balance'
        });
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform LUNO response to expected format
        const balances = {};
        if (balanceData.balance) {
            balanceData.balance.forEach(balance => {
                balances[balance.asset] = parseFloat(balance.balance);
            });
        }
        
        systemLogger.trading('LUNO balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('LUNO balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message
        });
        
        throw new APIError(`LUNO balance request failed: ${error.message}`, 500, 'LUNO_BALANCE_ERROR');
    }
}));

// LUNO Ticker Endpoint
router.post('/luno/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('LUNO ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle Luno's pair naming: convert USDT pairs to ZAR pairs
        let lunoPair = pair.replace('USDT', 'ZAR'); // Convert BTCUSDT -> BTCZAR
        if (lunoPair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.ticker}?pair=${lunoPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        systemLogger.trading('LUNO ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            pair: lunoPair
        });
        
        res.json({
            success: true,
            data: {
                ticker: {
                    bid: parseFloat(tickerData.bid || 0),
                    ask: parseFloat(tickerData.ask || 0),
                    lastPrice: parseFloat(tickerData.last_trade || 0),
                    volume: parseFloat(tickerData.rolling_24_hour_volume || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('LUNO ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`LUNO ticker request failed: ${error.message}`, 500, 'LUNO_TICKER_ERROR');
    }
}));

// LUNO Test Endpoint
router.post('/luno/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('LUNO connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'test'
        });
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        // Test connection by getting balance (minimal data)
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        systemLogger.trading('LUNO connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno'
        });
        
        res.json({
            success: true,
            message: 'LUNO connection successful',
            data: {
                connected: true,
                balanceCount: balanceData.balance ? balanceData.balance.length : 0
            }
        });
        
    } catch (error) {
        systemLogger.error('LUNO connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message
        });
        
        throw new APIError(`LUNO connection test failed: ${error.message}`, 500, 'LUNO_CONNECTION_ERROR');
    }
}));

// LUNO Buy Order Endpoint
router.post('/luno/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume } = req.body;
    
    try {
        systemLogger.trading('LUNO buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'buy-order',
            pair,
            volume
        });
        
        // Handle Luno's different pair naming for Bitcoin
        let lunoPair = pair;
        if (pair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        const orderData = {
            pair: lunoPair,
            type: 'BUY',
            volume: volume.toString()
        };
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('LUNO buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            orderId: orderResult.order_id,
            pair: lunoPair,
            volume
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_buy_order_placed', {
                orderId: orderResult.order_id,
                pair: lunoPair,
                volume,
                orderStatus: orderResult.state || 'PENDING',
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user?.id || 'anonymous',
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'LUNO',
            orderType: 'BUY',
            pair: lunoPair,
            volume,
            orderId: orderResult.order_id,
            status: orderResult.state || 'PENDING',
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderResult.order_id,
                    pair: lunoPair,
                    type: 'BUY',
                    volume,
                    status: orderResult.state || 'PENDING',
                    createdAt: orderResult.creation_timestamp || new Date()
                }
            },
            message: 'LUNO buy order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('LUNO buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message,
            pair,
            volume
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_buy_order_failed', {
                pair,
                volume,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`LUNO buy order failed: ${error.message}`, 500, 'LUNO_BUY_ORDER_ERROR');
    }
}));

// LUNO Sell Order Endpoint
router.post('/luno/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume } = req.body;
    
    try {
        systemLogger.trading('LUNO sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'sell-order',
            pair,
            volume
        });
        
        // Handle Luno's different pair naming for Bitcoin
        let lunoPair = pair;
        if (pair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        const orderData = {
            pair: lunoPair,
            type: 'SELL',
            volume: volume.toString()
        };
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('LUNO sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            orderId: orderResult.order_id,
            pair: lunoPair,
            volume
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_sell_order_placed', {
                orderId: orderResult.order_id,
                pair: lunoPair,
                volume,
                orderStatus: orderResult.state || 'PENDING',
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user?.id || 'anonymous',
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'LUNO',
            orderType: 'SELL',
            pair: lunoPair,
            volume,
            orderId: orderResult.order_id,
            status: orderResult.state || 'PENDING',
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderResult.order_id,
                    pair: lunoPair,
                    type: 'SELL',
                    volume,
                    status: orderResult.state || 'PENDING',
                    createdAt: orderResult.creation_timestamp || new Date()
                }
            },
            message: 'LUNO sell order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('LUNO sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message,
            pair,
            volume
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_sell_order_failed', {
                pair,
                volume,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`LUNO sell order failed: ${error.message}`, 500, 'LUNO_SELL_ORDER_ERROR');
    }
}));

// LUNO Triangular Arbitrage Endpoint - Execute single triangular trade step
router.post('/luno/triangular', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('side').isIn(['buy', 'sell']).withMessage('Side must be buy or sell'),
    body('amount').isFloat({ min: 0.0001 }).withMessage('Amount must be a positive number'),
    body('expectedPrice').isFloat({ min: 0 }).withMessage('Expected price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, side, amount, expectedPrice, type = 'market' } = req.body;
    
    try {
        systemLogger.trading('LUNO triangular trade initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'triangular',
            pair,
            side,
            amount,
            type
        });
        
        // Handle Luno's different pair naming for Bitcoin
        let lunoPair = pair;
        if (pair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        // Back to market orders with correct parameters from our earlier fix
        let orderData;
        
        if (side.toUpperCase() === 'BUY') {
            // For BUY market orders, use counter_volume (amount in ZAR/quote currency)
            orderData = {
                pair: lunoPair,
                type: 'BUY',
                counter_volume: amount.toString() // Amount in ZAR
            };
        } else {
            // For SELL market orders, use base_volume (amount in crypto/base currency)
            const baseVolume = (amount / expectedPrice).toString();
            orderData = {
                pair: lunoPair,
                type: 'SELL',
                base_volume: baseVolume // Amount in crypto (e.g., BTC, ETH, etc.)
            };
        }
        
        // Log the exact request being sent for debugging
        systemLogger.trading('LUNO triangular order request', {
            endpoint: `${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`,
            orderData: orderData,
            side: side.toUpperCase()
        });
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorData = await response.text();
            systemLogger.error('LUNO triangular order failed - API response', {
                status: response.status,
                error: errorData,
                sentData: orderData,
                endpoint: `${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`
            });
            throw new Error(`HTTP ${response.status}: ${errorData}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('LUNO triangular trade successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            orderId: orderResult.order_id,
            pair: lunoPair,
            side,
            executedAmount: orderResult.volume,
            executedPrice: orderResult.price
        });
        
        res.json({
            success: true,
            data: {
                orderId: orderResult.order_id,
                pair: lunoPair,
                side: side.toUpperCase(),
                executedAmount: parseFloat(orderResult.volume),
                executedPrice: parseFloat(orderResult.price),
                fee: parseFloat(orderResult.fee || '0'),
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        systemLogger.error('LUNO triangular trade failed', {
            userId: req.user?.id || 'anonymous',
            error: error.message,
            pair,
            side,
            amount
        });
        throw new APIError(`LUNO triangular trade failed: ${error.message}`, 500, 'LUNO_TRIANGULAR_ERROR');
    }
}));

// ============================================================================
// VALR EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// VALR API Configuration
const VALR_CONFIG = {
    baseUrl: 'https://api.valr.com',
    endpoints: {
        balance: '/v1/account/balances',
        ticker: '/v1/public/marketsummary', 
        simpleBuyOrder: '/v1/orders/market',  // Use working market order endpoint
        simpleSellOrder: '/v1/orders/market', // Same endpoint for both buy and sell
        pairs: '/v1/public/pairs',
        orderStatus: '/v1/orders/:orderId',
        orderBook: '/v1/public/:pair/orderbook'
    }
};

// VALR Trading Pairs Endpoint
router.get('/valr/pairs', tickerRateLimit, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('VALR pairs request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'pairs'
        });

        const response = await fetch(`${VALR_CONFIG.baseUrl}${VALR_CONFIG.endpoints.pairs}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const pairsData = await response.json();
        
        systemLogger.trading('VALR pairs retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            pairCount: pairsData.length
        });

        res.json({
            success: true,
            pairs: pairsData,
            exchange: 'VALR'
        });

    } catch (error) {
        systemLogger.error('VALR pairs request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });

        throw new APIError(`VALR pairs request failed: ${error.message}`, 500, 'VALR_PAIRS_ERROR');
    }
}));

// VALR Authentication Helper - FIXED TO MATCH FRONTEND BASE64 ENCODING
function createValrSignature(apiSecret, timestamp, verb, path, body = '') {
    const payload = timestamp + verb.toUpperCase() + path + (body || '');
    
    systemLogger.trading('VALR signature payload', {
        timestamp,
        method: verb.toUpperCase(),
        path,
        body: body || '',
        payload: payload
    });
    
    // Localhost server.js uses hex - match exactly
    const signature = crypto
        .createHmac('sha512', apiSecret)  // UTF-8 string
        .update(payload)
        .digest('hex');  // Use hex like working localhost server.js
    
    systemLogger.trading('VALR signature generated (hex)', { 
        signature: signature.substring(0, 20) + '...',
        encoding: 'hex',
        payloadLength: payload.length
    });
    
    return signature;
}

// VALR HTTP Request Helper
async function makeValrRequest(endpoint, method, apiKey, apiSecret, body = null) {
    const maxRetries = 3;
    const retryDelays = [1000, 2000, 3000]; // Exponential backoff: 1s, 2s, 3s
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            systemLogger.trading(`VALR API request attempt ${attempt + 1}/${maxRetries + 1}`, {
                endpoint,
                method,
                attempt: attempt + 1
            });
            
            const result = await makeValrRequestSingle(endpoint, method, apiKey, apiSecret, body);
            
            // Success on first try or after retries
            if (attempt > 0) {
                systemLogger.trading(`VALR API request succeeded after ${attempt + 1} attempts`, {
                    endpoint,
                    method,
                    totalAttempts: attempt + 1
                });
            }
            
            return result;
            
        } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            const isRetriableError = error.message.includes('Empty response') || 
                                   error.message.includes('timeout') ||
                                   error.message.includes('ECONNRESET') ||
                                   error.message.includes('ENOTFOUND');
            
            systemLogger.trading(`VALR API request failed - attempt ${attempt + 1}`, {
                endpoint,
                method,
                error: error.message,
                isRetriable: isRetriableError,
                isLastAttempt,
                willRetry: !isLastAttempt && isRetriableError
            });
            
            if (isLastAttempt || !isRetriableError) {
                throw error;
            }
            
            // Wait before retry with exponential backoff
            const delayMs = retryDelays[attempt] || 3000;
            systemLogger.trading(`VALR API retrying in ${delayMs}ms`, {
                endpoint,
                method,
                attempt: attempt + 1,
                delayMs
            });
            
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

function makeValrRequestSingle(endpoint, method, apiKey, apiSecret, body = null) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const path = endpoint;
        const bodyString = body ? JSON.stringify(body) : '';
        
        const options = {
            hostname: 'api.valr.com',
            path: path,
            method: method.toUpperCase(),
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'ARB4ME/1.0'
            }
        };
        
        // Add Content-Length if we have a body
        if (bodyString) {
            options.headers['Content-Length'] = Buffer.byteLength(bodyString);
        }
        
        // Only add authentication headers if API key is provided (for private endpoints)
        if (apiKey && apiSecret) {
            const signature = createValrSignature(apiSecret, timestamp.toString(), method, path, bodyString);
            // Use correct VALR header names (from working localhost version)
            options.headers['X-VALR-API-KEY'] = apiKey;
            options.headers['X-VALR-SIGNATURE'] = signature;
            options.headers['X-VALR-TIMESTAMP'] = timestamp.toString();
        }
        
        systemLogger.trading('VALR API request details', {
            method: method.toUpperCase(),
            path: path,
            hostname: options.hostname,
            headers: options.headers,
            bodyString: bodyString,
            hasAuth: !!(apiKey && apiSecret)
        });
        
        const req = https.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                systemLogger.trading('VALR API raw response', {
                    statusCode: res.statusCode,
                    data: data.substring(0, 500),
                    headers: res.headers
                });
                
                try {
                    if (!data || data.trim() === '') {
                        reject(new Error('Empty response from VALR API'));
                        return;
                    }
                    
                    const jsonData = JSON.parse(data);
                    
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(jsonData);
                    } else {
                        reject(new Error(jsonData.message || jsonData.error || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                } catch (parseError) {
                    reject(new Error(`Invalid JSON response from VALR: ${data.substring(0, 200)}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        // Set timeout to detect hanging requests
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('VALR API request timeout (10s)'));
        });
        
        if (bodyString) {
            req.write(bodyString);
        }
        
        req.end();
    });
}

// VALR Balance Endpoint
router.post('/valr/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('VALR balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'balance'
        });
        
        // Call VALR API
        const balanceData = await makeValrRequest(
            VALR_CONFIG.endpoints.balance,
            'GET',
            apiKey,
            apiSecret
        );
        
        // Transform VALR response to expected format
        const balances = {};
        balanceData.forEach(balance => {
            balances[balance.currency] = parseFloat(balance.available) + parseFloat(balance.reserved);
        });
        
        systemLogger.trading('VALR balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('VALR balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR balance request failed: ${error.message}`, 500, 'VALR_BALANCE_ERROR');
    }
}));

// VALR Ticker Endpoint  
router.post('/valr/ticker', tickerRateLimit, optionalAuth, asyncHandler(async (req, res) => {
    const { pair } = req.body;
    
    try {
        systemLogger.trading('VALR ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'ticker',
            pair: pair
        });
        
        // VALR ticker is public endpoint, no authentication required
        const tickerData = await makeValrRequest(
            VALR_CONFIG.endpoints.ticker,
            'GET',
            null, // No API key needed for public endpoint
            null  // No secret needed for public endpoint
        );
        
        // Find the specific pair from all market summaries
        // VALR uses format like "BTCZAR", "ETHZAR", "USDTZAR", "BTCUSDT", "LINKUSDT" etc.
        // Direct mapping - use the pair as provided since VALR supports many pairs
        const valrPair = pair;

        // Try to find the pair directly
        let pairData = tickerData.find(ticker => ticker.currencyPair === valrPair);

        // If not found and it's a USDT pair, try the ZAR equivalent as fallback
        if (!pairData && pair.endsWith('USDT') && pair !== 'USDTZAR') {
            const zarPair = pair.replace('USDT', 'ZAR');
            pairData = tickerData.find(ticker => ticker.currencyPair === zarPair);
            console.log(`Pair ${pair} not found, trying ${zarPair} as fallback`);
        }
        
        if (!pairData) {
            // Log available pairs for debugging
            console.error(`Pair ${valrPair} not found. Available VALR pairs:`,
                tickerData.map(t => t.currencyPair).filter(p =>
                    p.includes(pair.replace('ZAR', '').replace('USDT', ''))
                ).slice(0, 10)
            );
            throw new APIError(`Trading pair ${valrPair} not found on VALR`, 404, 'PAIR_NOT_FOUND');
        }
        
        // Format ticker response for consistency
        const formattedTicker = {
            lastPrice: parseFloat(pairData.lastTradedPrice),
            bid: parseFloat(pairData.bidPrice),
            ask: parseFloat(pairData.askPrice),
            volume: parseFloat(pairData.baseVolume),
            high: parseFloat(pairData.highPrice),
            low: parseFloat(pairData.lowPrice),
            change: parseFloat(pairData.changeFromPrevious)
        };
        
        systemLogger.trading('VALR ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            pair: valrPair,
            lastPrice: formattedTicker.lastPrice
        });
        
        res.json({
            success: true,
            data: {
                ticker: formattedTicker
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR ticker request failed: ${error.message}`, 500, 'VALR_TICKER_ERROR');
    }
}));

// VALR Test Endpoint
router.post('/valr/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('VALR connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'test'
        });
        
        // Test connection by getting balance (minimal data)
        const balanceData = await makeValrRequest(
            VALR_CONFIG.endpoints.balance,
            'GET',
            apiKey,
            apiSecret
        );
        
        systemLogger.trading('VALR connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr'
        });
        
        res.json({
            success: true,
            message: 'VALR connection successful',
            data: {
                connected: true,
                balanceCount: balanceData.length
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR connection test failed: ${error.message}`, 500, 'VALR_CONNECTION_ERROR');
    }
}));

// VALR Buy Order Endpoint
router.post('/valr/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('payInCurrency').notEmpty().withMessage('Pay-in currency is required'),
    body('payAmount').isFloat({ min: 0.01 }).withMessage('Pay amount must be a positive number'),
    body('customerOrderId').optional().isString().withMessage('Customer order ID must be string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, payInCurrency, payAmount, customerOrderId } = req.body;
    
    try {
        systemLogger.trading('VALR buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'buy-order',
            pair,
            payInCurrency,
            payAmount,
            customerOrderId
        });
        
        // Prepare order payload
        const orderPayload = {
            pair,
            payInCurrency,
            payAmount: parseFloat(payAmount).toString(),
            ...(customerOrderId && { customerOrderId })
        };
        
        // Call VALR API
        const orderData = await makeValrRequest(
            VALR_CONFIG.endpoints.simpleBuyOrder,
            'POST',
            apiKey,
            apiSecret,
            orderPayload
        );
        
        // Log successful order
        systemLogger.trading('VALR buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            orderId: orderData.id,
            pair,
            payAmount,
            status: orderData.status
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_buy_order_placed', {
                orderId: orderData.id,
                pair,
                payInCurrency,
                payAmount,
                orderStatus: orderData.status,
                customerOrderId,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user?.id || 'anonymous',
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'VALR',
            orderType: 'BUY',
            pair,
            amount: payAmount,
            currency: payInCurrency,
            orderId: orderData.id,
            status: orderData.status,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderData.id,
                    pair,
                    payInCurrency,
                    payAmount,
                    status: orderData.status,
                    createdAt: orderData.createdAt || new Date(),
                    customerOrderId: orderData.customerOrderId
                }
            },
            message: 'VALR buy order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('VALR buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message,
            pair,
            payAmount
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_buy_order_failed', {
                pair,
                payInCurrency,
                payAmount,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`VALR buy order failed: ${error.message}`, 500, 'VALR_BUY_ORDER_ERROR');
    }
}));

// VALR Sell Order Endpoint
router.post('/valr/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('payAmount').isFloat({ min: 0.01 }).withMessage('Pay amount must be a positive number'),
    body('customerOrderId').optional().isString().withMessage('Customer order ID must be string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, payAmount, customerOrderId } = req.body;
    
    try {
        systemLogger.trading('VALR sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'sell-order',
            pair,
            payAmount,
            customerOrderId
        });
        
        // Prepare order payload
        const orderPayload = {
            pair,
            payAmount: parseFloat(payAmount).toString(),
            ...(customerOrderId && { customerOrderId })
        };
        
        // Call VALR API
        const orderData = await makeValrRequest(
            VALR_CONFIG.endpoints.simpleSellOrder,
            'POST',
            apiKey,
            apiSecret,
            orderPayload
        );
        
        // Log successful order
        systemLogger.trading('VALR sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            orderId: orderData.id,
            pair,
            payAmount,
            status: orderData.status
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_sell_order_placed', {
                orderId: orderData.id,
                pair,
                payAmount,
                orderStatus: orderData.status,
                customerOrderId,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user?.id || 'anonymous',
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'VALR',
            orderType: 'SELL',
            pair,
            amount: payAmount,
            orderId: orderData.id,
            status: orderData.status,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderData.id,
                    pair,
                    payAmount,
                    status: orderData.status,
                    createdAt: orderData.createdAt || new Date(),
                    customerOrderId: orderData.customerOrderId
                }
            },
            message: 'VALR sell order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('VALR sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message,
            pair,
            payAmount
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_sell_order_failed', {
                pair,
                payAmount,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`VALR sell order failed: ${error.message}`, 500, 'VALR_SELL_ORDER_ERROR');
    }
}));

// VALR Order Status Endpoint
router.post('/valr/order-status', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('orderId').notEmpty().withMessage('Order ID is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, orderId } = req.body;
    
    try {
        systemLogger.trading('VALR order status check initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'order-status',
            orderId
        });
        
        // Call VALR API
        const orderData = await makeValrRequest(
            VALR_CONFIG.endpoints.orderStatus.replace(':orderId', orderId),
            'GET',
            apiKey,
            apiSecret
        );
        
        systemLogger.trading('VALR order status retrieved', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            orderId,
            status: orderData.status
        });
        
        res.json({
            success: true,
            data: {
                order: orderData
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR order status check failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message,
            orderId
        });
        
        throw new APIError(`VALR order status check failed: ${error.message}`, 500, 'VALR_ORDER_STATUS_ERROR');
    }
}));

// VALR Triangular Arbitrage Endpoint - Execute single triangular trade step
router.post('/valr/triangular', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('side').isIn(['buy', 'sell']).withMessage('Side must be buy or sell'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('expectedPrice').isFloat({ min: 0 }).withMessage('Expected price must be a positive number')
], asyncHandler(async (req, res) => {
    // DEBUG: Log exactly what we're receiving for VALR triangular
    console.log('🔍 VALR Triangular Request Debug:', {
        body: req.body,
        bodyKeys: Object.keys(req.body || {}),
        bodyTypes: Object.keys(req.body || {}).map(key => `${key}: ${typeof req.body[key]}`),
        timestamp: new Date().toISOString()
    });
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.log('❌ VALR Triangular Validation Errors:', errors.array());
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, side, amount, expectedPrice, type = 'market' } = req.body;
    
    try {
        // DEPLOYMENT VERSION 3 - FORCE UPDATE
        systemLogger.trading('VALR triangular trade initiated - VERSION 3 DEPLOYED', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'triangular',
            pair,
            side,
            amount,
            expectedPrice,
            type,
            deploymentVersion: 'V3-FORCE-UPDATE'
        });
        
        // Use exact same simple format as working cross-exchange buy-order
        let payInCurrency, payAmount;
        
        if (side.toLowerCase() === 'buy') {
            // For BUY: determine what currency we're paying with (same as working cross-exchange)
            if (pair.includes('ZAR')) {
                payInCurrency = 'ZAR';
                payAmount = parseFloat(amount).toString(); // ← Same format as working endpoint
            } else if (pair.includes('USDT')) {
                payInCurrency = 'USDT';
                payAmount = parseFloat(amount).toString();
            } else if (pair.includes('USDC')) {
                payInCurrency = 'USDC';
                payAmount = parseFloat(amount).toString();
            } else if (pair.includes('BTC')) {
                // For BTC pairs like ETHBTC, we pay in BTC
                payInCurrency = 'BTC';
                // Use the amount directly as BTC amount to spend (not calculated)
                payAmount = parseFloat(amount).toString();
            } else {
                throw new Error(`Unsupported pair format for BUY: ${pair}`);
            }
        } else {
            // For SELL: we're selling the base currency
            const baseCurrency = pair.replace(/ZAR|USDT|USDC|BTC$/, ''); // Remove quote currency
            payInCurrency = baseCurrency;
            payAmount = parseFloat(amount / expectedPrice).toString();
        }
        
        // Use correct VALR market order payload format (from working backup file)
        // For market orders, amount should be base currency quantity
        let orderAmount;
        
        // Debug logging to see what we're receiving
        console.log('DEBUG VALR CALCULATION INPUT:', { amount, expectedPrice, side, pair });
        
        if (side.toLowerCase() === 'buy') {
            // BUY: amount = quote currency amount / price = base currency quantity
            const calculatedAmount = amount / expectedPrice;
            orderAmount = calculatedAmount.toString();
            console.log(`DEBUG VALR BUY: ${amount} / ${expectedPrice} = ${calculatedAmount} -> ${orderAmount}`);
            systemLogger.trading(`VALR BUY calculation: ${amount} / ${expectedPrice} = ${orderAmount}`);
        } else {
            // SELL: amount = base currency quantity directly
            orderAmount = parseFloat(amount).toString();
            console.log(`DEBUG VALR SELL: amount = ${orderAmount}`);
            systemLogger.trading(`VALR SELL calculation: amount = ${orderAmount}`);
        }
        
        console.log('DEBUG VALR ORDER AMOUNT:', orderAmount);
        
        // Log the calculation details
        systemLogger.trading('VALR triangular amount calculation', {
            side: side,
            pair: pair,
            inputAmount: amount,
            expectedPrice: expectedPrice,
            calculatedAmount: orderAmount,
            calculation: side.toLowerCase() === 'buy' ? 
                `${amount} / ${expectedPrice} = ${orderAmount}` : 
                `direct amount = ${orderAmount}`
        });
        
        // VALR orders - use LIMIT orders with competitive pricing
        const orderPayload = side.toLowerCase() === 'buy' ? {
            side: 'BUY',
            pair: pair,
            type: 'LIMIT',
            quantity: orderAmount,  // Base currency amount to receive
            price: expectedPrice    // Price willing to pay
        } : {
            side: 'SELL',
            pair: pair,
            type: 'LIMIT',
            quantity: orderAmount,  // Base currency amount to sell
            price: expectedPrice    // Price to sell at
        };
        
        console.log('DEBUG VALR FINAL PAYLOAD:', JSON.stringify(orderPayload));
        console.log('DEBUG VALR CALCULATION DETAILS:', {
            pair: pair,
            side: side,
            inputAmount: amount,
            expectedPrice: expectedPrice,
            payInCurrency: payInCurrency,
            payAmount: payAmount,
            orderAmount: orderAmount,
            finalPayload: orderPayload
        });
        
        // Validate payload values before sending to VALR
        if (orderPayload.quantity <= 0) {
            throw new Error(`Invalid quantity: ${orderPayload.quantity} - must be > 0`);
        }
        if (orderPayload.price <= 0) {
            throw new Error(`Invalid price: ${orderPayload.price} - must be > 0`);
        }
        
        // Use proper VALR order endpoint for LIMIT orders
        const endpoint = '/v1/orders/limit';
        
        systemLogger.trading('VALR triangular order request - UPDATED CODE v2', {
            endpoint: `${VALR_CONFIG.baseUrl}${endpoint}`,
            orderPayload: orderPayload,
            calculatedAmount: orderAmount,
            originalAmount: amount,
            side: side.toUpperCase()
        });
        
        // Call appropriate VALR endpoint based on order side
        const orderResult = await makeValrRequest(
            endpoint,
            'POST',
            apiKey,
            apiSecret,
            orderPayload
        );
        
        systemLogger.trading('VALR triangular trade successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            orderId: orderResult.id,
            pair: pair,
            side,
            payInCurrency,
            payAmount,
            status: orderResult.status
        });
        
        res.json({
            success: true,
            data: {
                orderId: orderResult.id,
                pair: pair,
                side: side.toUpperCase(),
                payInCurrency: payInCurrency,
                payAmount: parseFloat(payAmount),
                executedAmount: parseFloat(orderResult.baseAmount || orderResult.counterAmount || payAmount),
                executedPrice: parseFloat(orderResult.price || expectedPrice),
                fee: parseFloat(orderResult.feeAmount || '0'),
                timestamp: new Date().toISOString(),
                status: orderResult.status
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR triangular trade failed', {
            userId: req.user?.id || 'anonymous',
            error: error.message,
            pair,
            side,
            amount
        });
        throw new APIError(`VALR triangular trade failed: ${error.message}`, 500, 'VALR_TRIANGULAR_ERROR');
    }
}));

// ============================================================================
// ALTCOINTRADER EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// AltCoinTrader API Configuration
const ALTCOINTRADER_CONFIG = {
    baseUrl: 'https://www.altcointrader.co.za/api',
    endpoints: {
        balance: '/balance',
        ticker: '/live_stats', 
        login: '/login',
        buy: '/order',
        sell: '/order'
    }
};

// AltCoinTrader Authentication Helper
async function createAltCoinTraderAuth(username, password) {
    // AltCoinTrader requires login to get auth token
    try {
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}${ALTCOINTRADER_CONFIG.endpoints.login}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                username: username,
                password: password
            })
        });

        if (!response.ok) {
            throw new Error(`Login failed: ${response.status}`);
        }

        const loginData = await response.json();
        return loginData.token; // Return the auth token
    } catch (error) {
        throw new Error(`AltCoinTrader authentication failed: ${error.message}`);
    }
}

// AltCoinTrader Balance Endpoint
router.post('/altcointrader/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('Username is required'),
    body('apiSecret').notEmpty().withMessage('Password is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey: username, apiSecret: password } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'balance'
        });
        
        // Get auth token
        const authToken = await createAltCoinTraderAuth(username, password);
        
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}${ALTCOINTRADER_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform AltCoinTrader response to expected format
        const balances = {};
        if (balanceData && typeof balanceData === 'object') {
            Object.keys(balanceData).forEach(currency => {
                balances[currency] = parseFloat(balanceData[currency] || 0);
            });
        }
        
        systemLogger.trading('AltCoinTrader balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message
        });
        
        throw new APIError(`AltCoinTrader balance request failed: ${error.message}`, 500, 'ALTCOINTRADER_BALANCE_ERROR');
    }
}));

// AltCoinTrader Ticker Endpoint
router.post('/altcointrader/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'ticker',
            pair: pair
        });
        
        // AltCoinTrader ticker is public endpoint
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}${ALTCOINTRADER_CONFIG.endpoints.ticker}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        // Handle AltCoinTrader's pair naming: convert USDT pairs to ZAR pairs
        let altcoinPair = pair.replace('USDT', 'ZAR'); // Convert BTCUSDT -> BTCZAR
        let currency = altcoinPair.replace('ZAR', ''); // Extract currency (BTC, ETH, etc.)
        
        // Find the specific currency data
        const pairData = tickerData[currency];
        
        if (!pairData) {
            throw new APIError(`Trading pair ${currency} not found on AltCoinTrader`, 404, 'PAIR_NOT_FOUND');
        }
        
        systemLogger.trading('AltCoinTrader ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            pair: currency
        });
        
        res.json({
            success: true,
            data: {
                pair: altcoinPair,
                ticker: {
                    lastPrice: parseFloat(pairData.Price || 0),
                    bid: parseFloat(pairData.Buy || 0),
                    ask: parseFloat(pairData.Sell || 0),
                    volume: parseFloat(pairData.Volume || 0),
                    high: parseFloat(pairData.High || 0),
                    low: parseFloat(pairData.Low || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`AltCoinTrader ticker request failed: ${error.message}`, 500, 'ALTCOINTRADER_TICKER_ERROR');
    }
}));

// AltCoinTrader Test Endpoint
router.post('/altcointrader/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('Username is required'),
    body('apiSecret').notEmpty().withMessage('Password is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey: username, apiSecret: password } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'test'
        });
        
        // Test connection by attempting to get auth token
        const authToken = await createAltCoinTraderAuth(username, password);
        
        systemLogger.trading('AltCoinTrader connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader'
        });
        
        res.json({
            success: true,
            message: 'AltCoinTrader connection successful',
            data: {
                connected: true,
                tokenReceived: !!authToken
            }
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message
        });
        
        throw new APIError(`AltCoinTrader connection test failed: ${error.message}`, 500, 'ALTCOINTRADER_CONNECTION_ERROR');
    }
}));

// ============================================================================
// XAGO EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// XAGO API Configuration
const XAGO_CONFIG = {
    baseUrl: 'https://api.xago.io',
    endpoints: {
        balance: '/v1/account/balance',
        ticker: '/v1/market/ticker',
        login: '/v1/auth/login',
        order: '/v1/trading/order'
    }
};

// XAGO Authentication Helper
async function createXagoAuth(apiKey, apiSecret) {
    // XAGO uses API key/secret authentication
    try {
        const timestamp = Date.now().toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + apiKey)
            .digest('hex');
        
        return {
            apiKey,
            timestamp,
            signature
        };
    } catch (error) {
        throw new Error(`XAGO authentication failed: ${error.message}`);
    }
}

// AltCoinTrader Buy Order Endpoint
router.post('/altcointrader/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'buy-order',
            pair,
            amount,
            price
        });
        
        // Format pair for AltCoinTrader (remove ZAR suffix if present)
        const altCoinTraderPair = pair.replace('ZAR', '').replace('USDT', '');
        
        const orderData = {
            coin: altCoinTraderPair,
            amount: amount.toString(),
            price: (price || 0).toString()
        };
        
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}/v3/simple-buy-order`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'X-API-SECRET': apiSecret,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('AltCoinTrader buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            orderId: orderResult.uuid,
            pair: altCoinTraderPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.uuid,
                price: parseFloat(orderResult.price),
                amount: parseFloat(orderResult.amount),
                fee: parseFloat(orderResult.fee || 0),
                status: orderResult.status,
                timestamp: orderResult.created_at
            }
        });
        
    } catch (error) {
        systemLogger.trading('AltCoinTrader buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`AltCoinTrader buy order failed: ${error.message}`, 500, 'ALTCOINTRADER_BUY_ORDER_ERROR');
    }
}));

// AltCoinTrader Sell Order Endpoint
router.post('/altcointrader/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'sell-order',
            pair,
            amount,
            price
        });
        
        // Format pair for AltCoinTrader (remove ZAR suffix if present)
        const altCoinTraderPair = pair.replace('ZAR', '').replace('USDT', '');
        
        const orderData = {
            coin: altCoinTraderPair,
            amount: amount.toString(),
            price: (price || 0).toString()
        };
        
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}/v3/simple-sell-order`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'X-API-SECRET': apiSecret,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('AltCoinTrader sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            orderId: orderResult.uuid,
            pair: altCoinTraderPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.uuid,
                price: parseFloat(orderResult.price),
                amount: parseFloat(orderResult.amount),
                fee: parseFloat(orderResult.fee || 0),
                status: orderResult.status,
                timestamp: orderResult.created_at
            }
        });
        
    } catch (error) {
        systemLogger.trading('AltCoinTrader sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`AltCoinTrader sell order failed: ${error.message}`, 500, 'ALTCOINTRADER_SELL_ORDER_ERROR');
    }
}));

// XAGO Balance Endpoint
router.post('/xago/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('XAGO balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'balance'
        });
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform XAGO response to expected format
        const balances = {};
        if (balanceData && balanceData.data) {
            balanceData.data.forEach(balance => {
                balances[balance.currency] = parseFloat(balance.available || 0);
            });
        }
        
        systemLogger.trading('XAGO balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('XAGO balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message
        });
        
        throw new APIError(`XAGO balance request failed: ${error.message}`, 500, 'XAGO_BALANCE_ERROR');
    }
}));

// XAGO Ticker Endpoint
router.post('/xago/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('XAGO ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle XAGO's pair naming: convert USDT pairs to ZAR pairs for SA market
        let xagoPair = pair.replace('USDT', 'ZAR');
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.ticker}?symbol=${xagoPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        if (!tickerData || !tickerData.data) {
            throw new APIError(`Trading pair ${xagoPair} not found on XAGO`, 404, 'PAIR_NOT_FOUND');
        }
        
        const pairData = tickerData.data;
        
        systemLogger.trading('XAGO ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            pair: xagoPair
        });
        
        res.json({
            success: true,
            data: {
                pair: xagoPair,
                ticker: {
                    lastPrice: parseFloat(pairData.lastPrice || 0),
                    bid: parseFloat(pairData.bidPrice || 0),
                    ask: parseFloat(pairData.askPrice || 0),
                    volume: parseFloat(pairData.volume || 0),
                    high: parseFloat(pairData.highPrice || 0),
                    low: parseFloat(pairData.lowPrice || 0),
                    change: parseFloat(pairData.priceChange || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('XAGO ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`XAGO ticker request failed: ${error.message}`, 500, 'XAGO_TICKER_ERROR');
    }
}));

// XAGO Test Endpoint
router.post('/xago/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('XAGO connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'test'
        });
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        // Test connection by getting balance
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        systemLogger.trading('XAGO connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago'
        });
        
        res.json({
            success: true,
            message: 'XAGO connection successful',
            data: {
                connected: true,
                balanceCount: balanceData?.data?.length || 0
            }
        });
        
    } catch (error) {
        systemLogger.error('XAGO connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message
        });
        
        throw new APIError(`XAGO connection test failed: ${error.message}`, 500, 'XAGO_CONNECTION_ERROR');
    }
}));

// XAGO Buy Order Endpoint
router.post('/xago/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('XAGO buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'buy-order',
            pair,
            amount,
            price
        });
        
        // Format pair for XAGO (convert USDT pairs to ZAR)
        let xagoPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        const orderData = {
            symbol: xagoPair,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('XAGO buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            orderId: orderResult.orderId,
            pair: xagoPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: xagoPair,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XAGO buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`XAGO buy order failed: ${error.message}`, 500, 'XAGO_BUY_ORDER_ERROR');
    }
}));

// XAGO Sell Order Endpoint
router.post('/xago/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('XAGO sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'sell-order',
            pair,
            amount,
            price
        });
        
        // Format pair for XAGO (convert USDT pairs to ZAR)
        let xagoPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        const orderData = {
            symbol: xagoPair,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('XAGO sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            orderId: orderResult.orderId,
            pair: xagoPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: xagoPair,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XAGO sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`XAGO sell order failed: ${error.message}`, 500, 'XAGO_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// CHAINEX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// ChainEX API Configuration
const CHAINEX_CONFIG = {
    baseUrl: 'https://api.chainex.io',
    endpoints: {
        balance: '/wallet/balances',
        ticker: '/market/summary',
        markets: '/market/summary',
        order: '/trading/order'
    }
};

// ChainEX Trading Pairs Endpoint
router.get('/chainex/pairs', tickerRateLimit, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('ChainEX pairs request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'pairs'
        });

        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.markets}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const marketsData = await response.json();
        
        // Log the structure for debugging
        systemLogger.trading('ChainEX raw response structure', {
            hasStatus: !!marketsData.status,
            hasCount: !!marketsData.count,
            hasData: !!marketsData.data,
            dataType: marketsData.data ? typeof marketsData.data : 'no data field',
            dataIsArray: Array.isArray(marketsData.data),
            topLevelKeys: Object.keys(marketsData).slice(0, 10),
            sampleData: marketsData.data ? JSON.stringify(marketsData.data).slice(0, 200) : 'none'
        });
        
        let pairs = [];
        
        // ChainEX returns {status: "success", count: X, data: [...]}
        if (marketsData.status === 'success' && marketsData.data && Array.isArray(marketsData.data)) {
            pairs = marketsData.data.map(market => ({
                pair: market.market,  // ChainEX uses "market" field for pair name
                last: market.last_price || market.last || '0',
                high: market.high_price || market.high || '0',
                low: market.low_price || market.low || '0',
                volume: market.volume || market.baseVolume || '0',
                yesterday_price: market.yesterday_price,
                change_24h: market.change_24h
            }));
        } else if (typeof marketsData === 'object') {
            // Fallback: direct object with pairs as keys
            const marketPairs = Object.keys(marketsData).filter(key => {
                return key !== 'status' && key !== 'count' && key !== 'data' && 
                       key !== 'message' && marketsData[key] && 
                       typeof marketsData[key] === 'object';
            });
            
            pairs = marketPairs.map(pair => ({
                pair: pair,
                last: marketsData[pair].last || '0',
                high: marketsData[pair].high || '0',
                low: marketsData[pair].low || '0',
                volume: marketsData[pair].volume || '0'
            }));
        }
        
        systemLogger.trading('ChainEX pairs retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            pairCount: pairs.length
        });

        res.json({
            success: true,
            pairs: pairs,
            exchange: 'CHAINEX'
        });

    } catch (error) {
        systemLogger.error('ChainEX pairs request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message
        });

        throw new APIError(`ChainEX pairs request failed: ${error.message}`, 500, 'CHAINEX_PAIRS_ERROR');
    }
}));

// ChainEX Authentication Helper
function createChainEXAuth(apiKey, apiSecret, endpoint, queryParams = {}) {
    // ChainEX uses query string authentication with HMAC-SHA-256
    try {
        const time = Math.floor(Date.now() / 1000); // Unix timestamp
        
        // Build query string
        const params = new URLSearchParams({
            time: time.toString(),
            key: apiKey,
            ...queryParams
        });
        
        // Create full URL for hashing
        const fullUrl = `${CHAINEX_CONFIG.baseUrl}${endpoint}?${params.toString()}`;
        
        // Create hash of full URL
        const hash = crypto
            .createHmac('sha256', apiSecret)
            .update(fullUrl)
            .digest('hex');
        
        // Add hash to params
        params.append('hash', hash);
        
        return {
            queryString: params.toString(),
            fullUrl: `${CHAINEX_CONFIG.baseUrl}${endpoint}?${params.toString()}`
        };
    } catch (error) {
        throw new Error(`ChainEX authentication failed: ${error.message}`);
    }
}

// Test ChainEX Connection Endpoint
router.post('/chainex/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;

    try {
        systemLogger.trading('ChainEX connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex'
        });

        // Try to fetch balance as a connection test
        const auth = createChainEXAuth(apiKey, apiSecret, CHAINEX_CONFIG.endpoints.balance);

        const response = await fetch(auth.fullUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'ARB4ME/1.0'
            }
        });

        const responseText = await response.text();
        let responseData;
        try {
            responseData = JSON.parse(responseText);
        } catch (e) {
            responseData = { raw: responseText };
        }

        if (!response.ok) {
            systemLogger.error('ChainEX test failed - HTTP error', {
                status: response.status,
                statusText: response.statusText,
                response: responseData
            });

            throw new APIError(`ChainEX API returned ${response.status}: ${JSON.stringify(responseData)}`,
                response.status === 401 ? 401 : 500,
                'CHAINEX_AUTH_ERROR');
        }

        // Check if response indicates success
        if (responseData.status === 'success') {
            systemLogger.trading('ChainEX connection test successful', {
                userId: req.user?.id || 'anonymous',
                exchange: 'chainex'
            });

            res.json({
                success: true,
                message: 'ChainEX connection successful',
                authenticated: true
            });
        } else {
            throw new APIError(`ChainEX API error: ${responseData.message || JSON.stringify(responseData)}`, 500, 'CHAINEX_API_ERROR');
        }

    } catch (error) {
        systemLogger.error('ChainEX connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            details: error
        });

        // Return more detailed error for debugging
        res.status(error.statusCode || 500).json({
            success: false,
            error: {
                code: error.code || 'CHAINEX_TEST_ERROR',
                message: error.message,
                details: error.details || {}
            }
        });
    }
}));

// ChainEX Balance Endpoint
router.post('/chainex/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('ChainEX balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'balance'
        });
        
        const auth = createChainEXAuth(apiKey, apiSecret, CHAINEX_CONFIG.endpoints.balance);
        
        const response = await fetch(auth.fullUrl, {
            method: 'GET'
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // ChainEX returns {status, count, data: [{code, balance_available, balance_held, ...}]}
        if (balanceData.status !== 'success') {
            throw new Error(`ChainEX API error: ${balanceData.message || 'Unknown error'}`);
        }
        
        // Transform ChainEX response to expected format
        const balances = {};
        if (balanceData.data && Array.isArray(balanceData.data)) {
            balanceData.data.forEach(balance => {
                balances[balance.code] = parseFloat(balance.balance_available || 0) + parseFloat(balance.balance_held || 0);
            });
        }
        
        systemLogger.trading('ChainEX balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('ChainEX balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message
        });
        
        throw new APIError(`ChainEX balance request failed: ${error.message}`, 500, 'CHAINEX_BALANCE_ERROR');
    }
}));

// ChainEX Ticker Endpoint
router.post('/chainex/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('ChainEX ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle ChainEX's pair naming: convert USDT pairs to ZAR pairs for SA market
        let chainexPair;
        if (pair === 'USDTZAR') {
            // Don't change USDTZAR - it's already correct
            chainexPair = 'USDTZAR';
        } else if (pair.endsWith('USDT')) {
            // Convert crypto/USDT pairs to crypto/ZAR (e.g., BTCUSDT → BTCZAR)
            chainexPair = pair.replace('USDT', 'ZAR');
        } else {
            // Keep other pairs as is (BTCZAR, ETHZAR, etc.)
            chainexPair = pair;
        }
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.ticker}/${chainexPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        if (!tickerData) {
            throw new APIError(`Trading pair ${chainexPair} not found on ChainEX`, 404, 'PAIR_NOT_FOUND');
        }
        
        systemLogger.trading('ChainEX ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            pair: chainexPair
        });
        
        res.json({
            success: true,
            data: {
                pair: chainexPair,
                ticker: {
                    lastPrice: parseFloat(tickerData.last || 0),
                    bid: parseFloat(tickerData.bid || 0),
                    ask: parseFloat(tickerData.ask || 0),
                    volume: parseFloat(tickerData.volume || 0),
                    high: parseFloat(tickerData.high || 0),
                    low: parseFloat(tickerData.low || 0),
                    change: parseFloat(tickerData.change || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('ChainEX ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`ChainEX ticker request failed: ${error.message}`, 500, 'CHAINEX_TICKER_ERROR');
    }
}));

// ChainEX Test Endpoint
router.post('/chainex/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('ChainEX connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'test'
        });
        
        const auth = createChainEXAuth(apiKey, apiSecret, CHAINEX_CONFIG.endpoints.balance);
        
        // Test connection by getting balance
        const response = await fetch(auth.fullUrl, {
            method: 'GET'
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Check ChainEX response status
        if (balanceData.status !== 'success') {
            throw new Error(`ChainEX API error: ${balanceData.message || 'Unknown error'}`);
        }
        
        systemLogger.trading('ChainEX connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex'
        });
        
        res.json({
            success: true,
            message: 'ChainEX connection successful',
            data: {
                connected: true,
                balanceCount: balanceData.data ? balanceData.data.length : 0
            }
        });
        
    } catch (error) {
        systemLogger.error('ChainEX connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message
        });
        
        throw new APIError(`ChainEX connection test failed: ${error.message}`, 500, 'CHAINEX_CONNECTION_ERROR');
    }
}));

// ChainEX Buy Order Endpoint
router.post('/chainex/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('ChainEX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'buy-order',
            pair,
            amount,
            price
        });
        
        // Format pair for ChainEX (convert USDT pairs to ZAR if needed)
        let chainexPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createChainEXAuth(apiKey, apiSecret);
        
        const orderData = {
            market: chainexPair,
            side: 'buy',
            amount: amount.toString(),
            type: price ? 'limit' : 'market',
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('ChainEX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            orderId: orderResult.id,
            pair: chainexPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                market: chainexPair,
                side: 'buy',
                type: orderResult.type,
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.state,
                timestamp: orderResult.created_at || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ChainEX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`ChainEX buy order failed: ${error.message}`, 500, 'CHAINEX_BUY_ORDER_ERROR');
    }
}));

// ChainEX Sell Order Endpoint
router.post('/chainex/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('ChainEX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'sell-order',
            pair,
            amount,
            price
        });
        
        // Format pair for ChainEX (convert USDT pairs to ZAR if needed)
        let chainexPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createChainEXAuth(apiKey, apiSecret);
        
        const orderData = {
            market: chainexPair,
            side: 'sell',
            amount: amount.toString(),
            type: price ? 'limit' : 'market',
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('ChainEX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            orderId: orderResult.id,
            pair: chainexPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                market: chainexPair,
                side: 'sell',
                type: orderResult.type,
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.state,
                timestamp: orderResult.created_at || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ChainEX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`ChainEX sell order failed: ${error.message}`, 500, 'CHAINEX_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BINANCE EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Get server IP endpoint
router.get('/server-ip', asyncHandler(async (req, res) => {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        res.json({ ip: data.ip, source: 'Railway Server' });
    } catch (error) {
        res.json({ error: 'Could not determine server IP' });
    }
}));

// Binance API Configuration
const BINANCE_CONFIG = {
    baseUrl: 'https://api.binance.com',
    endpoints: {
        balance: '/api/v3/account',
        ticker: '/api/v3/ticker/price',
        ticker24hr: '/api/v3/ticker/24hr',
        order: '/api/v3/order',
        time: '/api/v3/time'
    }
};

// Binance Authentication Helper
function createBinanceSignature(queryString, apiSecret) {
    return crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');
}

// Binance Balance Endpoint
router.post('/binance/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('Binance balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'balance'
        });
        
        const timestamp = Date.now();
        // Try without recvWindow for maximum API key compatibility
        const queryString = `timestamp=${timestamp}`;
        const signature = createBinanceSignature(queryString, apiSecret);
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.error('Binance balance API error', {
                userId: req.user?.id || 'anonymous',
                status: response.status,
                error: errorText
            });
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const accountData = await response.json();
        
        // Check for Binance-specific errors
        if (accountData.code && accountData.msg) {
            systemLogger.error('Binance API returned error', {
                userId: req.user?.id || 'anonymous',
                code: accountData.code,
                message: accountData.msg
            });
            throw new APIError(`Binance error ${accountData.code}: ${accountData.msg}`, 400, 'BINANCE_API_ERROR');
        }
        
        // Transform Binance response to expected format
        const balances = {};
        if (accountData && accountData.balances) {
            accountData.balances.forEach(balance => {
                const total = parseFloat(balance.free) + parseFloat(balance.locked);
                if (total > 0) {
                    balances[balance.asset] = total;
                }
            });
        }
        
        systemLogger.trading('Binance balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            data: {
                exchange: 'binance',
                balances: balances
            }
        });
        
    } catch (error) {
        systemLogger.error('Binance balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message
        });
        
        // Return error details to frontend for debugging (like MEXC does)
        res.json({
            success: false,
            data: {
                exchange: 'binance',
                error: error.message || 'Failed to fetch Binance balance'
            }
        });
    }
}));

// Binance Ticker Endpoint
router.post('/binance/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('Binance ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Binance uses direct USDT pairs (BTCUSDT, ETHUSDT, etc.)
        const binancePair = pair.toUpperCase();
        
        // Get both price and 24hr stats
        const [priceResponse, statsResponse] = await Promise.all([
            fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.ticker}?symbol=${binancePair}`),
            fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.ticker24hr}?symbol=${binancePair}`)
        ]);

        if (!priceResponse.ok || !statsResponse.ok) {
            const errorText = !priceResponse.ok ? await priceResponse.text() : await statsResponse.text();
            throw new Error(`HTTP ${!priceResponse.ok ? priceResponse.status : statsResponse.status}: ${errorText}`);
        }
        
        const priceData = await priceResponse.json();
        const statsData = await statsResponse.json();
        
        systemLogger.trading('Binance ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            pair: binancePair
        });
        
        res.json({
            success: true,
            data: {
                pair: binancePair,
                ticker: {
                    lastPrice: parseFloat(priceData.price || statsData.lastPrice || 0),
                    bid: parseFloat(statsData.bidPrice || 0),
                    ask: parseFloat(statsData.askPrice || 0),
                    volume: parseFloat(statsData.volume || 0),
                    high: parseFloat(statsData.highPrice || 0),
                    low: parseFloat(statsData.lowPrice || 0),
                    change: parseFloat(statsData.priceChangePercent || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('Binance ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`Binance ticker request failed: ${error.message}`, 500, 'BINANCE_TICKER_ERROR');
    }
}));

// Binance Test Endpoint
router.post('/binance/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('Binance connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'test'
        });
        
        // Test connection by getting server time and account info
        const timestamp = Date.now();
        const recvWindow = 60000; // 60 second window for better reliability
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createBinanceSignature(queryString, apiSecret);
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const accountData = await response.json();
        
        systemLogger.trading('Binance connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance'
        });
        
        res.json({
            success: true,
            message: 'Binance connection successful',
            data: {
                connected: true,
                balanceCount: accountData.balances ? accountData.balances.length : 0,
                accountType: accountData.accountType || 'SPOT'
            }
        });
        
    } catch (error) {
        systemLogger.error('Binance connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message
        });
        
        throw new APIError(`Binance connection test failed: ${error.message}`, 500, 'BINANCE_CONNECTION_ERROR');
    }
}));

// Binance Buy Order Endpoint
router.post('/binance/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Binance buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'buy-order',
            pair,
            quantity,
            price
        });
        
        const auth = createBinanceAuth(apiKey, apiSecret);
        const timestamp = Date.now();
        
        const orderData = {
            symbol: pair,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Binance buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            orderId: orderResult.orderId,
            pair,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Binance buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message,
            pair,
            quantity
        });
        
        throw new APIError(`Binance buy order failed: ${error.message}`, 500, 'BINANCE_BUY_ORDER_ERROR');
    }
}));

// Binance Sell Order Endpoint
router.post('/binance/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Binance sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'sell-order',
            pair,
            quantity,
            price
        });
        
        const auth = createBinanceAuth(apiKey, apiSecret);
        const timestamp = Date.now();
        
        const orderData = {
            symbol: pair,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Binance sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            orderId: orderResult.orderId,
            pair,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Binance sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message,
            pair,
            quantity
        });
        
        throw new APIError(`Binance sell order failed: ${error.message}`, 500, 'BINANCE_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// KRAKEN EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Kraken API Configuration
const KRAKEN_CONFIG = {
    baseUrl: 'https://api.kraken.com',
    endpoints: {
        balance: '/0/private/Balance',
        ticker: '/0/public/Ticker',
        test: '/0/private/Balance'
    }
};

// Kraken Authentication Helper
function createKrakenSignature(path, postdata, apiSecret, nonce) {
    const message = postdata;
    const secret_buffer = Buffer.from(apiSecret, 'base64');
    const hash = crypto.createHash('sha256');
    const hmac = crypto.createHmac('sha512', secret_buffer);
    const hash_digest = hash.update(nonce + message).digest('binary');
    const hmac_digest = hmac.update(path + hash_digest, 'binary').digest('base64');
    return hmac_digest;
}

// POST /api/v1/trading/kraken/balance - Get Kraken account balance
router.post('/kraken/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now().toString();
        const postdata = `nonce=${nonce}`;
        const path = KRAKEN_CONFIG.endpoints.balance;
        const signature = createKrakenSignature(path, postdata, apiSecret, nonce);

        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postdata
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Kraken balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Kraken API error: ${response.status}`, 502, 'KRAKEN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new APIError(`Kraken error: ${data.error.join(', ')}`, 400, 'KRAKEN_ERROR');
        }

        const balances = {};
        if (data.result) {
            for (const [currency, balance] of Object.entries(data.result)) {
                const amount = parseFloat(balance);
                if (amount > 0) {
                    balances[currency] = amount;
                }
            }
        }

        systemLogger.trading('Kraken balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'kraken',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('Kraken balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Kraken balance', 500, 'KRAKEN_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/kraken/ticker - Get Kraken ticker data
router.post('/kraken/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (e.g., BTCUSDT -> XBTUSDT for Kraken)
        let krakenPair = pair;
        if (pair === 'BTCUSDT') krakenPair = 'XBTUSDT';
        if (pair === 'ETHUSDT') krakenPair = 'ETHUSDT';
        
        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${KRAKEN_CONFIG.endpoints.ticker}?pair=${krakenPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Kraken ticker API error', {
                userId: req.user?.id,
                pair: krakenPair,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Kraken API error: ${response.status}`, 502, 'KRAKEN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new APIError(`Kraken error: ${data.error.join(', ')}`, 400, 'KRAKEN_ERROR');
        }

        let ticker = null;
        if (data.result) {
            const pairData = Object.values(data.result)[0];
            if (pairData) {
                ticker = {
                    symbol: krakenPair,
                    lastPrice: parseFloat(pairData.c[0]),
                    bidPrice: parseFloat(pairData.b[0]),
                    askPrice: parseFloat(pairData.a[0]),
                    volume: parseFloat(pairData.v[1]),
                    high: parseFloat(pairData.h[1]),
                    low: parseFloat(pairData.l[1])
                };
            }
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('Kraken ticker retrieved', {
            userId: req.user?.id,
            pair: krakenPair,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'kraken',
                pair: krakenPair,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('Kraken ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Kraken ticker', 500, 'KRAKEN_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/kraken/test - Test Kraken API connection
router.post('/kraken/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now().toString();
        const postdata = `nonce=${nonce}`;
        const path = KRAKEN_CONFIG.endpoints.test;
        const signature = createKrakenSignature(path, postdata, apiSecret, nonce);

        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postdata
        });

        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            systemLogger.trading('Kraken API test failed', {
                userId: req.user?.id,
                error: data.error.join(', ')
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'kraken',
                    connected: false,
                    error: data.error.join(', ')
                }
            });
            return;
        }

        systemLogger.trading('Kraken API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'kraken',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('Kraken test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'kraken',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Kraken Buy Order Endpoint
router.post('/kraken/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume, price } = req.body;
    
    try {
        systemLogger.trading('Kraken buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            endpoint: 'buy-order',
            pair,
            volume,
            price
        });
        
        const auth = createKrakenAuth(apiKey, apiSecret);
        const nonce = Date.now() * 1000;
        
        const orderData = {
            nonce: nonce.toString(),
            ordertype: price ? 'limit' : 'market',
            type: 'buy',
            volume: volume.toString(),
            pair,
            ...(price && { price: price.toString() })
        };
        
        const postData = new URLSearchParams(orderData).toString();
        const path = KRAKEN_CONFIG.endpoints.order;
        const signature = crypto
            .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
            .update(path + crypto.createHash('sha256').update(nonce + postData).digest())
            .digest('base64');
        
        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postData
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new Error(data.error.join(', '));
        }
        
        systemLogger.trading('Kraken buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            txId: data.result?.txid?.[0],
            pair,
            volume,
            price
        });
        
        res.json({
            success: true,
            order: {
                txId: data.result?.txid?.[0],
                pair,
                type: 'buy',
                ordertype: price ? 'limit' : 'market',
                volume: parseFloat(volume),
                price: parseFloat(price || 0),
                status: 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Kraken buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            error: error.message,
            pair,
            volume
        });
        
        throw new APIError(`Kraken buy order failed: ${error.message}`, 500, 'KRAKEN_BUY_ORDER_ERROR');
    }
}));

// Kraken Sell Order Endpoint
router.post('/kraken/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume, price } = req.body;
    
    try {
        systemLogger.trading('Kraken sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            endpoint: 'sell-order',
            pair,
            volume,
            price
        });
        
        const auth = createKrakenAuth(apiKey, apiSecret);
        const nonce = Date.now() * 1000;
        
        const orderData = {
            nonce: nonce.toString(),
            ordertype: price ? 'limit' : 'market',
            type: 'sell',
            volume: volume.toString(),
            pair,
            ...(price && { price: price.toString() })
        };
        
        const postData = new URLSearchParams(orderData).toString();
        const path = KRAKEN_CONFIG.endpoints.order;
        const signature = crypto
            .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
            .update(path + crypto.createHash('sha256').update(nonce + postData).digest())
            .digest('base64');
        
        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postData
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new Error(data.error.join(', '));
        }
        
        systemLogger.trading('Kraken sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            txId: data.result?.txid?.[0],
            pair,
            volume,
            price
        });
        
        res.json({
            success: true,
            order: {
                txId: data.result?.txid?.[0],
                pair,
                type: 'sell',
                ordertype: price ? 'limit' : 'market',
                volume: parseFloat(volume),
                price: parseFloat(price || 0),
                status: 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Kraken sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            error: error.message,
            pair,
            volume
        });
        
        throw new APIError(`Kraken sell order failed: ${error.message}`, 500, 'KRAKEN_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BYBIT EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// ByBit API Configuration
const BYBIT_CONFIG = {
    baseUrl: 'https://api.bybit.com',
    endpoints: {
        balance: '/v5/account/wallet-balance',
        ticker: '/v5/market/tickers',
        test: '/v5/account/wallet-balance'
    }
};

// ByBit Authentication Helper
function createByBitSignature(timestamp, apiKey, apiSecret, recv_window, queryString) {
    const param_str = timestamp + apiKey + recv_window + queryString;
    return crypto.createHmac('sha256', apiSecret).update(param_str).digest('hex');
}

// POST /api/v1/trading/bybit/balance - Get ByBit account balance
router.post('/bybit/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const recv_window = '5000';
        const queryString = 'accountType=UNIFIED';
        const signature = createByBitSignature(timestamp, apiKey, apiSecret, recv_window, queryString);

        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.balance}?${queryString}`, {
            method: 'GET',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-SIGN-TYPE': '2',
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recv_window,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('ByBit balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`ByBit API error: ${response.status}`, 502, 'BYBIT_API_ERROR');
        }

        const data = await response.json();
        
        if (data.retCode !== 0) {
            throw new APIError(`ByBit error: ${data.retMsg}`, 400, 'BYBIT_ERROR');
        }

        const balances = {};
        if (data.result && data.result.list && data.result.list.length > 0) {
            const account = data.result.list[0];
            if (account.coin) {
                account.coin.forEach(coin => {
                    const balance = parseFloat(coin.walletBalance);
                    if (balance > 0) {
                        balances[coin.coin] = balance;
                    }
                });
            }
        }

        systemLogger.trading('ByBit balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'bybit',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('ByBit balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch ByBit balance', 500, 'BYBIT_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bybit/ticker - Get ByBit ticker data
router.post('/bybit/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.ticker}?category=spot&symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('ByBit ticker API error', {
                userId: req.user?.id,
                pair,
                status: response.status,
                error: errorText
            });
            throw new APIError(`ByBit API error: ${response.status}`, 502, 'BYBIT_API_ERROR');
        }

        const data = await response.json();
        
        if (data.retCode !== 0) {
            throw new APIError(`ByBit error: ${data.retMsg}`, 400, 'BYBIT_ERROR');
        }

        let ticker = null;
        if (data.result && data.result.list && data.result.list.length > 0) {
            const tickerData = data.result.list[0];
            ticker = {
                symbol: tickerData.symbol,
                lastPrice: parseFloat(tickerData.lastPrice),
                bidPrice: parseFloat(tickerData.bid1Price),
                askPrice: parseFloat(tickerData.ask1Price),
                volume: parseFloat(tickerData.volume24h),
                high: parseFloat(tickerData.highPrice24h),
                low: parseFloat(tickerData.lowPrice24h),
                change: parseFloat(tickerData.price24hPcnt)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('ByBit ticker retrieved', {
            userId: req.user?.id,
            pair,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'bybit',
                pair,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('ByBit ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch ByBit ticker', 500, 'BYBIT_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bybit/test - Test ByBit API connection
router.post('/bybit/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const recv_window = '5000';
        const queryString = 'accountType=UNIFIED';
        const signature = createByBitSignature(timestamp, apiKey, apiSecret, recv_window, queryString);

        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.test}?${queryString}`, {
            method: 'GET',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-SIGN-TYPE': '2',
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recv_window,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.retCode !== 0) {
            systemLogger.trading('ByBit API test failed', {
                userId: req.user?.id,
                error: data.retMsg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'bybit',
                    connected: false,
                    error: data.retMsg
                }
            });
            return;
        }

        systemLogger.trading('ByBit API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'bybit',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('ByBit test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'bybit',
                connected: false,
                error: error.message
            }
        });
    }
}));

// ByBit Buy Order Endpoint
router.post('/bybit/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('qty').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, qty, price } = req.body;
    
    try {
        systemLogger.trading('ByBit buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            endpoint: 'buy-order',
            symbol,
            qty,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            category: 'spot',
            symbol,
            side: 'Buy',
            orderType: price ? 'Limit' : 'Market',
            qty: qty.toString(),
            ...(price && { price: price.toString() })
        };
        
        const queryString = Object.keys(orderData)
            .sort()
            .map(key => `${key}=${orderData[key]}`)
            .join('&');
            
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + apiKey + queryString)
            .digest('hex');
        
        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp.toString(),
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.retCode !== 0) {
            throw new Error(orderResult.retMsg);
        }
        
        systemLogger.trading('ByBit buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            orderId: orderResult.result?.orderId,
            symbol,
            qty,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol,
                side: 'Buy',
                orderType: price ? 'Limit' : 'Market',
                qty: parseFloat(qty),
                price: parseFloat(price || 0),
                status: orderResult.result?.orderStatus || 'New',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ByBit buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            error: error.message,
            symbol,
            qty
        });
        
        throw new APIError(`ByBit buy order failed: ${error.message}`, 500, 'BYBIT_BUY_ORDER_ERROR');
    }
}));

// ByBit Sell Order Endpoint
router.post('/bybit/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('qty').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, qty, price } = req.body;
    
    try {
        systemLogger.trading('ByBit sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            endpoint: 'sell-order',
            symbol,
            qty,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            category: 'spot',
            symbol,
            side: 'Sell',
            orderType: price ? 'Limit' : 'Market',
            qty: qty.toString(),
            ...(price && { price: price.toString() })
        };
        
        const queryString = Object.keys(orderData)
            .sort()
            .map(key => `${key}=${orderData[key]}`)
            .join('&');
            
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + apiKey + queryString)
            .digest('hex');
        
        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp.toString(),
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.retCode !== 0) {
            throw new Error(orderResult.retMsg);
        }
        
        systemLogger.trading('ByBit sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            orderId: orderResult.result?.orderId,
            symbol,
            qty,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol,
                side: 'Sell',
                orderType: price ? 'Limit' : 'Market',
                qty: parseFloat(qty),
                price: parseFloat(price || 0),
                status: orderResult.result?.orderStatus || 'New',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ByBit sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            error: error.message,
            symbol,
            qty
        });
        
        throw new APIError(`ByBit sell order failed: ${error.message}`, 500, 'BYBIT_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// GATE.IO EXCHANGE API PROXY ENDPOINTS  
// ============================================================================

// Gate.io API Configuration
const GATEIO_CONFIG = {
    baseUrl: 'https://api.gateio.ws',
    endpoints: {
        balance: '/api/v4/spot/accounts',
        ticker: '/api/v4/spot/tickers',
        test: '/api/v4/spot/accounts'
    }
};

// Gate.io Authentication Helper
function createGateioSignature(method, url, queryString, body, timestamp, apiSecret) {
    const hashedPayload = crypto.createHash('sha512').update(body || '').digest('hex');
    const signingString = `${method}\n${url}\n${queryString}\n${hashedPayload}\n${timestamp}`;
    return crypto.createHmac('sha512', apiSecret).update(signingString).digest('hex');
}

// POST /api/v1/trading/gateio/balance - Get Gate.io account balance
router.post('/gateio/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const method = 'GET';
        const url = GATEIO_CONFIG.endpoints.balance;
        const queryString = '';
        const signature = createGateioSignature(method, url, queryString, '', timestamp, apiSecret);

        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${url}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'KEY': apiKey,
                'Timestamp': timestamp,
                'SIGN': signature
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Gate.io balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Gate.io API error: ${response.status}`, 502, 'GATEIO_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (Array.isArray(data)) {
            data.forEach(account => {
                const available = parseFloat(account.available);
                if (available > 0) {
                    balances[account.currency] = available;
                }
            });
        }

        systemLogger.trading('Gate.io balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'gateio',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('Gate.io balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gate.io balance', 500, 'GATEIO_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/gateio/ticker - Get Gate.io ticker data
router.post('/gateio/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC_USDT for Gate.io)
        const gateioSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${GATEIO_CONFIG.endpoints.ticker}?currency_pair=${gateioSymbol}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Gate.io ticker API error', {
                userId: req.user?.id,
                pair: gateioSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Gate.io API error: ${response.status}`, 502, 'GATEIO_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (Array.isArray(data) && data.length > 0) {
            const tickerData = data[0];
            ticker = {
                symbol: tickerData.currency_pair,
                lastPrice: parseFloat(tickerData.last),
                bidPrice: parseFloat(tickerData.highest_bid),
                askPrice: parseFloat(tickerData.lowest_ask),
                volume: parseFloat(tickerData.base_volume),
                high: parseFloat(tickerData.high_24h),
                low: parseFloat(tickerData.low_24h),
                change: parseFloat(tickerData.change_percentage)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('Gate.io ticker retrieved', {
            userId: req.user?.id,
            pair: gateioSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'gateio',
                pair: gateioSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('Gate.io ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gate.io ticker', 500, 'GATEIO_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/gateio/test - Test Gate.io API connection
router.post('/gateio/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const method = 'GET';
        const url = GATEIO_CONFIG.endpoints.test;
        const queryString = '';
        const signature = createGateioSignature(method, url, queryString, '', timestamp, apiSecret);

        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${url}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'KEY': apiKey,
                'Timestamp': timestamp,
                'SIGN': signature
            }
        });

        const data = await response.json();
        
        if (!response.ok || (data.message && data.message !== 'Success')) {
            systemLogger.trading('Gate.io API test failed', {
                userId: req.user?.id,
                error: data.message || `HTTP ${response.status}`
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'gateio',
                    connected: false,
                    error: data.message || `HTTP ${response.status}`
                }
            });
            return;
        }

        systemLogger.trading('Gate.io API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'gateio',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('Gate.io test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'gateio',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Gate.io Buy Order Endpoint
router.post('/gateio/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('currencyPair').notEmpty().withMessage('Currency pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, currencyPair, amount, price } = req.body;
    
    try {
        systemLogger.trading('Gate.io buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            endpoint: 'buy-order',
            currencyPair,
            amount,
            price
        });
        
        // Format pair for Gate.io (ensure underscore format like BTC_USDT)
        const gateioSymbol = currencyPair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const timestamp = Math.floor(Date.now() / 1000);
        const orderData = {
            currency_pair: gateioSymbol,
            type: price ? 'limit' : 'market',
            account: 'spot',
            side: 'buy',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const payloadHash = crypto.createHash('sha512').update(body).digest('hex');
        const signString = `POST\n/api/v4/spot/orders\n\n${payloadHash}\n${timestamp}`;
        const signature = crypto.createHmac('sha512', apiSecret).update(signString).digest('hex');
        
        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${GATEIO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'KEY': apiKey,
                'SIGN': signature,
                'Timestamp': timestamp.toString(),
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Gate.io buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            orderId: orderResult.id,
            currencyPair: gateioSymbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                currencyPair: gateioSymbol,
                type: price ? 'limit' : 'market',
                side: 'buy',
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: new Date(orderResult.create_time * 1000)
            }
        });
        
    } catch (error) {
        systemLogger.trading('Gate.io buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            error: error.message,
            currencyPair,
            amount
        });
        
        throw new APIError(`Gate.io buy order failed: ${error.message}`, 500, 'GATEIO_BUY_ORDER_ERROR');
    }
}));

// Gate.io Sell Order Endpoint
router.post('/gateio/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('currencyPair').notEmpty().withMessage('Currency pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, currencyPair, amount, price } = req.body;
    
    try {
        systemLogger.trading('Gate.io sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            endpoint: 'sell-order',
            currencyPair,
            amount,
            price
        });
        
        // Format pair for Gate.io (ensure underscore format like BTC_USDT)
        const gateioSymbol = currencyPair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const timestamp = Math.floor(Date.now() / 1000);
        const orderData = {
            currency_pair: gateioSymbol,
            type: price ? 'limit' : 'market',
            account: 'spot',
            side: 'sell',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const payloadHash = crypto.createHash('sha512').update(body).digest('hex');
        const signString = `POST\n/api/v4/spot/orders\n\n${payloadHash}\n${timestamp}`;
        const signature = crypto.createHmac('sha512', apiSecret).update(signString).digest('hex');
        
        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${GATEIO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'KEY': apiKey,
                'SIGN': signature,
                'Timestamp': timestamp.toString(),
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Gate.io sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            orderId: orderResult.id,
            currencyPair: gateioSymbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                currencyPair: gateioSymbol,
                type: price ? 'limit' : 'market',
                side: 'sell',
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: new Date(orderResult.create_time * 1000)
            }
        });
        
    } catch (error) {
        systemLogger.trading('Gate.io sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            error: error.message,
            currencyPair,
            amount
        });
        
        throw new APIError(`Gate.io sell order failed: ${error.message}`, 500, 'GATEIO_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// OKX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// OKX API Configuration
const OKX_CONFIG = {
    baseUrl: 'https://www.okx.com',
    endpoints: {
        balance: '/api/v5/account/balance',
        ticker: '/api/v5/market/ticker',
        test: '/api/v5/account/balance'
    }
};

// OKX Authentication Helper
function createOKXSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = timestamp + method + requestPath + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// POST /api/v1/trading/okx/balance - Get OKX account balance
router.post('/okx/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = new Date().toISOString();
        const method = 'GET';
        const requestPath = OKX_CONFIG.endpoints.balance;
        const signature = createOKXSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('OKX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`OKX API error: ${response.status}`, 502, 'OKX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '0') {
            throw new APIError(`OKX error: ${data.msg}`, 400, 'OKX_ERROR');
        }

        const balances = {};
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            const account = data.data[0];
            if (account.details && Array.isArray(account.details)) {
                account.details.forEach(detail => {
                    const available = parseFloat(detail.availBal);
                    if (available > 0) {
                        balances[detail.ccy] = available;
                    }
                });
            }
        }

        systemLogger.trading('OKX balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'okx',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('OKX balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch OKX balance', 500, 'OKX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/okx/ticker - Get OKX ticker data
router.post('/okx/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format for OKX (BTCUSDT -> BTC-USDT)
        let okxSymbol;
        if (pair.includes('USDT')) {
            // Handle USDT pairs: BTCUSDT -> BTC-USDT
            okxSymbol = pair.replace('USDT', '-USDT');
        } else if (pair.includes('USDC')) {
            // Handle USDC pairs: BTCUSDC -> BTC-USDC
            okxSymbol = pair.replace('USDC', '-USDC');
        } else if (pair.includes('BTC') && !pair.startsWith('BTC')) {
            // Handle pairs with BTC as quote: ETHBTC -> ETH-BTC
            okxSymbol = pair.replace('BTC', '-BTC');
        } else if (pair.includes('ETH') && !pair.startsWith('ETH')) {
            // Handle pairs with ETH as quote: XRPETH -> XRP-ETH
            okxSymbol = pair.replace('ETH', '-ETH');
        } else {
            // Fallback - try to add hyphen before last 3-4 characters
            okxSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1-$2');
        }
        
        const response = await fetch(`${OKX_CONFIG.baseUrl}${OKX_CONFIG.endpoints.ticker}?instId=${okxSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('OKX ticker API error', {
                userId: req.user?.id,
                pair: okxSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`OKX API error: ${response.status}`, 502, 'OKX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '0') {
            throw new APIError(`OKX error: ${data.msg}`, 400, 'OKX_ERROR');
        }

        let ticker = null;
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            const tickerData = data.data[0];
            ticker = {
                symbol: tickerData.instId,
                lastPrice: parseFloat(tickerData.last),
                bidPrice: parseFloat(tickerData.bidPx),
                askPrice: parseFloat(tickerData.askPx),
                volume: parseFloat(tickerData.vol24h),
                high: parseFloat(tickerData.high24h),
                low: parseFloat(tickerData.low24h),
                change: parseFloat(tickerData.chgUtc8)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('OKX ticker retrieved', {
            userId: req.user?.id,
            pair: okxSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'okx',
                pair: okxSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('OKX ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch OKX ticker', 500, 'OKX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/okx/test - Test OKX API connection
router.post('/okx/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = new Date().toISOString();
        const method = 'GET';
        const requestPath = OKX_CONFIG.endpoints.test;
        const signature = createOKXSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== '0') {
            systemLogger.trading('OKX API test failed', {
                userId: req.user?.id,
                error: data.msg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'okx',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        systemLogger.trading('OKX API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'okx',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('OKX test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'okx',
                connected: false,
                error: error.message
            }
        });
    }
}));

// OKX Buy Order Endpoint
router.post('/okx/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('instId').notEmpty().withMessage('Instrument ID is required'),
    body('sz').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('px').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, instId, sz, px } = req.body;
    
    try {
        systemLogger.trading('OKX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            endpoint: 'buy-order',
            instId,
            sz,
            px
        });
        
        const timestamp = new Date().toISOString();
        const orderData = {
            instId,
            tdMode: 'cash',
            side: 'buy',
            ordType: px ? 'limit' : 'market',
            sz: sz.toString(),
            ...(px && { px: px.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const method = 'POST';
        const requestPath = '/api/v5/trade/order';
        const signature = createOKXSignature(timestamp, method, requestPath, body, apiSecret);
        
        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('OKX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            ordId: orderResult.data?.[0]?.ordId,
            instId,
            sz,
            px
        });
        
        res.json({
            success: true,
            order: {
                ordId: orderResult.data?.[0]?.ordId,
                instId,
                tdMode: 'cash',
                side: 'buy',
                ordType: px ? 'limit' : 'market',
                sz: parseFloat(sz),
                px: parseFloat(px || 0),
                state: orderResult.data?.[0]?.sCode || 'live',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('OKX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            error: error.message,
            instId,
            sz
        });
        
        throw new APIError(`OKX buy order failed: ${error.message}`, 500, 'OKX_BUY_ORDER_ERROR');
    }
}));

// OKX Sell Order Endpoint
router.post('/okx/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('instId').notEmpty().withMessage('Instrument ID is required'),
    body('sz').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('px').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, instId, sz, px } = req.body;
    
    try {
        systemLogger.trading('OKX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            endpoint: 'sell-order',
            instId,
            sz,
            px
        });
        
        const timestamp = new Date().toISOString();
        const orderData = {
            instId,
            tdMode: 'cash',
            side: 'sell',
            ordType: px ? 'limit' : 'market',
            sz: sz.toString(),
            ...(px && { px: px.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const method = 'POST';
        const requestPath = '/api/v5/trade/order';
        const signature = createOKXSignature(timestamp, method, requestPath, body, apiSecret);
        
        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('OKX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            ordId: orderResult.data?.[0]?.ordId,
            instId,
            sz,
            px
        });
        
        res.json({
            success: true,
            order: {
                ordId: orderResult.data?.[0]?.ordId,
                instId,
                tdMode: 'cash',
                side: 'sell',
                ordType: px ? 'limit' : 'market',
                sz: parseFloat(sz),
                px: parseFloat(px || 0),
                state: orderResult.data?.[0]?.sCode || 'live',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('OKX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            error: error.message,
            instId,
            sz
        });
        
        throw new APIError(`OKX sell order failed: ${error.message}`, 500, 'OKX_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// MEXC EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// MEXC API Configuration
const MEXC_CONFIG = {
    baseUrl: 'https://api.mexc.com',
    endpoints: {
        balance: '/api/v3/account',
        ticker: '/api/v3/ticker/24hr',
        test: '/api/v3/account',
        order: '/api/v3/order'
    }
};

// MEXC Authentication Helper
function createMEXCSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/mexc/balance - Get MEXC account balance
router.post('/mexc/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const recvWindow = 5000; // 5 second window for timing security
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createMEXCSignature(queryString, apiSecret);

        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('MEXC balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`MEXC API error: ${response.status}`, 502, 'MEXC_API_ERROR');
        }

        const data = await response.json();
        
        // Log the raw MEXC response for debugging
        systemLogger.trading('MEXC raw response', {
            userId: req.user?.id,
            hasBalances: !!data.balances,
            balanceCount: data.balances ? data.balances.length : 0,
            sampleBalance: data.balances && data.balances.length > 0 ? data.balances[0] : null
        });
        
        // MEXC uses code field for errors (code 0 or undefined means success)
        if (data.code && data.code !== 0 && data.code !== '0') {
            systemLogger.trading('MEXC API returned error code', {
                userId: req.user?.id,
                code: data.code,
                msg: data.msg
            });
            
            // Return detailed error to frontend for debugging
            res.json({
                success: false,
                data: {
                    exchange: 'mexc',
                    error: data.msg || 'Unknown MEXC error',
                    code: data.code
                }
            });
            return;
        }

        const balances = {};
        // MEXC returns balances array directly in the response
        if (data.balances && Array.isArray(data.balances)) {
            data.balances.forEach(balance => {
                const free = parseFloat(balance.free);
                // Include all balances, even 0, for debugging
                balances[balance.asset] = free;
            });
        } else if (Array.isArray(data)) {
            // Sometimes MEXC returns the array directly
            data.forEach(balance => {
                const free = parseFloat(balance.free);
                balances[balance.asset] = free;
            });
        }

        systemLogger.trading('MEXC balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'mexc',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('MEXC balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        // Return error details to frontend
        res.json({
            success: false,
            data: {
                exchange: 'mexc',
                error: error.message || 'Failed to fetch MEXC balance'
            }
        });
    }
}));

// POST /api/v1/trading/mexc/ticker - Get MEXC ticker data
router.post('/mexc/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('MEXC ticker API error', {
                userId: req.user?.id,
                pair,
                status: response.status,
                error: errorText
            });
            throw new APIError(`MEXC API error: ${response.status}`, 502, 'MEXC_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code && data.code !== 200) {
            throw new APIError(`MEXC error: ${data.msg}`, 400, 'MEXC_ERROR');
        }

        let ticker = null;
        if (data.symbol) {
            ticker = {
                symbol: data.symbol,
                lastPrice: parseFloat(data.lastPrice),
                bidPrice: parseFloat(data.bidPrice),
                askPrice: parseFloat(data.askPrice),
                volume: parseFloat(data.volume),
                high: parseFloat(data.highPrice),
                low: parseFloat(data.lowPrice),
                change: parseFloat(data.priceChangePercent)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('MEXC ticker retrieved', {
            userId: req.user?.id,
            pair,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'mexc',
                pair,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('MEXC ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch MEXC ticker', 500, 'MEXC_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/mexc/test - Test MEXC API connection
router.post('/mexc/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const recvWindow = 5000; // 5 second window for timing security
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createMEXCSignature(queryString, apiSecret);

        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.test}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code && data.code !== 200) {
            systemLogger.trading('MEXC API test failed', {
                userId: req.user?.id,
                error: data.msg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'mexc',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        systemLogger.trading('MEXC API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'mexc',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('MEXC test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'mexc',
                connected: false,
                error: error.message
            }
        });
    }
}));

// MEXC Buy Order Endpoint
router.post('/mexc/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('MEXC buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('MEXC buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('MEXC buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`MEXC buy order failed: ${error.message}`, 500, 'MEXC_BUY_ORDER_ERROR');
    }
}));

// MEXC Sell Order Endpoint
router.post('/mexc/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('MEXC sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('MEXC sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('MEXC sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`MEXC sell order failed: ${error.message}`, 500, 'MEXC_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// KUCOIN EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// KuCoin API Configuration
const KUCOIN_CONFIG = {
    baseUrl: 'https://api.kucoin.com',
    endpoints: {
        balance: '/api/v1/accounts',
        ticker: '/api/v1/market/orderbook/level1',
        test: '/api/v1/accounts'
    }
};

// KuCoin Authentication Helper
function createKuCoinSignature(timestamp, method, endpoint, body, apiSecret) {
    const strForSign = timestamp + method + endpoint + (body || '');
    const signatureResult = crypto.createHmac('sha256', apiSecret).update(strForSign).digest('base64');
    return signatureResult;
}

// POST /api/v1/trading/kucoin/balance - Get KuCoin account balance
router.post('/kucoin/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now();
        const method = 'GET';
        const endpoint = KUCOIN_CONFIG.endpoints.balance;
        const signature = createKuCoinSignature(timestamp, method, endpoint, '', apiSecret);
        const passphraseHash = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');

        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': passphraseHash,
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('KuCoin balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`KuCoin API error: ${response.status}`, 502, 'KUCOIN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '200000') {
            throw new APIError(`KuCoin error: ${data.msg}`, 400, 'KUCOIN_ERROR');
        }

        const balances = {};
        if (data.data && Array.isArray(data.data)) {
            data.data.forEach(account => {
                const available = parseFloat(account.available);
                if (available > 0) {
                    balances[account.currency] = available;
                }
            });
        }

        systemLogger.trading('KuCoin balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'kucoin',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('KuCoin balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch KuCoin balance', 500, 'KUCOIN_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/kucoin/ticker - Get KuCoin ticker data
router.post('/kucoin/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC-USDT for KuCoin)
        const kucoinSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1-$2');
        
        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${KUCOIN_CONFIG.endpoints.ticker}?symbol=${kucoinSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('KuCoin ticker API error', {
                userId: req.user?.id,
                pair: kucoinSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`KuCoin API error: ${response.status}`, 502, 'KUCOIN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '200000') {
            throw new APIError(`KuCoin error: ${data.msg}`, 400, 'KUCOIN_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: kucoinSymbol,
                lastPrice: parseFloat(data.data.price),
                bidPrice: parseFloat(data.data.bestBid),
                askPrice: parseFloat(data.data.bestAsk),
                volume: parseFloat(data.data.size),
                high: parseFloat(data.data.price), // KuCoin level1 doesn't provide 24h high/low
                low: parseFloat(data.data.price),
                change: 0
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('KuCoin ticker retrieved', {
            userId: req.user?.id,
            pair: kucoinSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'kucoin',
                pair: kucoinSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('KuCoin ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch KuCoin ticker', 500, 'KUCOIN_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/kucoin/test - Test KuCoin API connection
router.post('/kucoin/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now();
        const method = 'GET';
        const endpoint = KUCOIN_CONFIG.endpoints.test;
        const signature = createKuCoinSignature(timestamp, method, endpoint, '', apiSecret);
        const passphraseHash = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');

        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': passphraseHash,
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== '200000') {
            systemLogger.trading('KuCoin API test failed', {
                userId: req.user?.id,
                error: data.msg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'kucoin',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        systemLogger.trading('KuCoin API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'kucoin',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('KuCoin test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'kucoin',
                connected: false,
                error: error.message
            }
        });
    }
}));

// ============================================================================
// XT.COM EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// XT.com API Configuration
const XT_CONFIG = {
    baseUrl: 'https://sapi.xt.com',  // Back to v4 base URL
    endpoints: {
        balance: '/v4/balances',  // v4 endpoint with v1 auth
        ticker: '/v4/public/ticker',
        test: '/v4/balances'
    }
};

// XT.com Authentication Helper
function createXTSignature(apiKey, timestamp, path, queryParams, body, apiSecret) {
    // Build signature string: headers + path + query + body
    const headersString = `xt-validate-appkey=${apiKey}&xt-validate-timestamp=${timestamp}`;

    // Sort and concatenate query params
    const sortedQuery = Object.keys(queryParams)
        .sort()
        .map(key => `${key}=${queryParams[key]}`)
        .join('&');

    const signatureString = headersString + path + sortedQuery + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(signatureString).digest('hex');
}

// POST /api/v1/trading/xt/balance - Get XT.com account balance
router.post('/xt/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const path = XT_CONFIG.endpoints.balance;
        const queryParams = {};
        const body = '';
        const signature = createXTSignature(apiKey, timestamp, path, queryParams, body, apiSecret);

        const response = await fetch(`${XT_CONFIG.baseUrl}${path}`, {
            method: 'GET',
            headers: {
                'xt-validate-appkey': apiKey,
                'xt-validate-timestamp': timestamp.toString(),
                'xt-validate-signature': signature,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        // XT.com may return 400 status with valid response body (like BitMart/Bitget/Coincatch)
        // Check both HTTP status and response structure
        if (!response.ok && response.status !== 400) {
            systemLogger.trading('XT.com balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: data
            });
            throw new APIError(`XT.com API error: ${response.status}`, 502, 'XT_API_ERROR');
        }
        
        // Log the actual response for debugging
        systemLogger.trading('XT.com balance response', {
            userId: req.user?.id,
            responseData: JSON.stringify(data)
        });
        
        if (data.rc && data.rc !== '0' && data.rc !== 'OK' && data.code !== 200) {
            throw new APIError(`XT.com error: ${data.rc} - ${data.msg || data.message || JSON.stringify(data)}`, 400, 'XT_ERROR');
        }

        const balances = {};
        if (data.result && Array.isArray(data.result)) {
            data.result.forEach(balance => {
                const available = parseFloat(balance.availableAmount || balance.available);
                if (available > 0) {
                    balances[balance.currency || balance.coin] = available;
                }
            });
        }

        systemLogger.trading('XT.com balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'xt',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('XT.com balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch XT.com balance', 500, 'XT_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/xt/ticker - Get XT.com ticker data
router.post('/xt/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> btc_usdt for XT.com)
        const xtSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2').toLowerCase();
        
        const response = await fetch(`${XT_CONFIG.baseUrl}${XT_CONFIG.endpoints.ticker}?symbol=${xtSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('XT.com ticker API error', {
                userId: req.user?.id,
                pair: xtSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`XT.com API error: ${response.status}`, 502, 'XT_API_ERROR');
        }

        const data = await response.json();
        
        if (data.rc !== 0 && data.code !== 200) {
            throw new APIError(`XT.com error: ${data.msg || data.message}`, 400, 'XT_ERROR');
        }

        let ticker = null;
        if (data.result) {
            const tickerData = Array.isArray(data.result) ? data.result[0] : data.result;
            ticker = {
                symbol: xtSymbol,
                lastPrice: parseFloat(tickerData.c || tickerData.last),
                bidPrice: parseFloat(tickerData.b || tickerData.bid),
                askPrice: parseFloat(tickerData.a || tickerData.ask),
                volume: parseFloat(tickerData.v || tickerData.volume),
                high: parseFloat(tickerData.h || tickerData.high),
                low: parseFloat(tickerData.l || tickerData.low),
                change: parseFloat(tickerData.cr || tickerData.changeRate || 0)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('XT.com ticker retrieved', {
            userId: req.user?.id,
            pair: xtSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'xt',
                pair: xtSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('XT.com ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch XT.com ticker', 500, 'XT_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/xt/test - Test XT.com API connection
router.post('/xt/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const endpoint = XT_CONFIG.endpoints.test;
        const signature = createXTSignature(timestamp, method, endpoint, null, apiKey, apiSecret);

        const response = await fetch(`${XT_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'validate-algorithms': 'HmacSHA256',
                'validate-appkey': apiKey,
                'validate-timestamp': timestamp,
                'validate-signature': signature,
                'validate-recvwindow': '60000',
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.rc && data.rc !== '0' && data.rc !== 'OK' && data.code !== 200) {
            systemLogger.trading('XT.com API test failed', {
                userId: req.user?.id,
                error: data.msg || data.message
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'xt',
                    connected: false,
                    error: data.msg || data.message
                }
            });
            return;
        }

        systemLogger.trading('XT.com API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'xt',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('XT.com test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'xt',
                connected: false,
                error: error.message
            }
        });
    }
}));

// XT.com Buy Order Endpoint
router.post('/xt/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('XT.com buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const method = 'POST';
        const endpoint = '/v4/order';
        
        const orderData = {
            symbol: symbol.toLowerCase().replace(/([a-z]+)([a-z]{3,4})$/, '$1_$2'), // Convert btcusdt -> btc_usdt
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const signature = createXTSignature(timestamp, method, endpoint, orderData, apiKey, apiSecret);
        
        const response = await fetch(`${XT_CONFIG.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'xt-validate-algorithms': 'HmacSHA256',
                'xt-validate-appkey': apiKey,
                'xt-validate-recvwindow': '5000',
                'xt-validate-timestamp': timestamp.toString(),
                'xt-validate-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.rc !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('XT.com buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            orderId: orderResult.result?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol: orderData.symbol,
                side: 'buy',
                type: price ? 'limit' : 'market',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XT.com buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            symbol,
            quantity,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// XT.com Sell Order Endpoint
router.post('/xt/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('XT.com sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const method = 'POST';
        const endpoint = '/v4/order';
        
        const orderData = {
            symbol: symbol.toLowerCase().replace(/([a-z]+)([a-z]{3,4})$/, '$1_$2'), // Convert btcusdt -> btc_usdt
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const signature = createXTSignature(timestamp, method, endpoint, orderData, apiKey, apiSecret);
        
        const response = await fetch(`${XT_CONFIG.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'xt-validate-algorithms': 'HmacSHA256',
                'xt-validate-appkey': apiKey,
                'xt-validate-recvwindow': '5000',
                'xt-validate-timestamp': timestamp.toString(),
                'xt-validate-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.rc !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('XT.com sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            orderId: orderResult.result?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol: orderData.symbol,
                side: 'sell',
                type: price ? 'limit' : 'market',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XT.com sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            symbol,
            quantity,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// ============================================================================
// ASCENDEX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// AscendEX API Configuration
const ASCENDEX_CONFIG = {
    baseUrl: 'https://ascendex.com',
    endpoints: {
        balance: '/api/pro/data/v1/cash/balance/snapshot',  // Updated to current API format
        ticker: '/api/pro/v1/ticker',
        test: '/api/pro/v1/info'
    }
};

// AscendEX Authentication Helper
function createAscendEXSignature(timestamp, path, apiSecret) {
    // AscendEX format: timestamp + "+" + api_path
    const prehashString = timestamp + '+' + path;
    return crypto.createHmac('sha256', apiSecret).update(prehashString).digest('base64');
}

// POST /api/v1/trading/ascendex/balance - Get AscendEX account balance
router.post('/ascendex/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;

    try {
        // Step 1: Get account info to retrieve account group
        const infoTimestamp = Date.now().toString();
        const infoPath = ASCENDEX_CONFIG.endpoints.test; // /api/pro/v1/info
        // For info endpoint, prehash is timestamp+info (not full path)
        const infoSignature = createAscendEXSignature(infoTimestamp, 'info', apiSecret);

        const infoResponse = await fetch(`${ASCENDEX_CONFIG.baseUrl}${infoPath}`, {
            method: 'GET',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': infoTimestamp,
                'x-auth-signature': infoSignature,
                'Content-Type': 'application/json'
            }
        });

        const infoData = await infoResponse.json();

        // Check if API returned error code
        if (infoData.code !== 0) {
            throw new APIError(`AscendEX account info error: ${infoData.message || 'Unknown error'}`, 502, 'ASCENDEX_INFO_ERROR');
        }

        const accountGroup = infoData.data?.accountGroup;

        if (accountGroup === undefined || accountGroup === null) {
            systemLogger.trading('AscendEX account group missing', {
                userId: req.user?.id,
                infoData: infoData
            });
            throw new APIError('Could not retrieve account group from AscendEX', 502, 'ASCENDEX_ACCOUNT_GROUP_ERROR');
        }

        // Step 2: Get balance using account group
        const balanceTimestamp = Date.now().toString();
        const balancePath = `/api/pro/v1/cash/balance`;
        // For balance endpoint, prehash is timestamp+balance (not full path)
        const balanceSignature = createAscendEXSignature(balanceTimestamp, 'balance', apiSecret);

        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}/${accountGroup}${balancePath}`, {
            method: 'GET',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': balanceTimestamp,
                'x-auth-signature': balanceSignature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = errorText;
            }
            
            systemLogger.trading('AscendEX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorData,
                requestDetails: {
                    url: `${ASCENDEX_CONFIG.baseUrl}${path}`,
                    headers: {
                        'x-bitmax-apikey': apiKey.substring(0, 8) + '...',
                        'x-bitmax-timestamp': timestamp,
                        'x-bitmax-signature': signature.substring(0, 16) + '...'
                    }
                }
            });
            
            // Return debug info to frontend like HTX
            const errorMessage = errorData?.message || errorData?.msg || `AscendEX API error: ${response.status}`;
            res.json({
                success: false,
                error: {
                    code: 'ASCENDEX_AUTH_ERROR',
                    message: `AscendEX error: ${errorMessage}`,
                    debug: {
                        timestamp: timestamp,
                        path: path,
                        prehashString: prehashString,
                        signature: signature.substring(0, 16) + '...',
                        errorData: errorData
                    }
                }
            });
            return;
        }

        const data = await response.json();
        
        // Log successful response to see AscendEX structure
        systemLogger.trading('AscendEX balance response', {
            userId: req.user?.id,
            code: data.code,
            message: data.message,
            hasData: !!data.data,
            fullResponse: JSON.stringify(data)
        });
        
        if (data.code !== 0) {
            // Return debug info to frontend for AscendEX errors too
            res.json({
                success: false,
                error: {
                    code: 'ASCENDEX_API_ERROR',
                    message: `AscendEX error: ${data.message || 'Unknown error'}`,
                    debug: {
                        responseCode: data.code,
                        responseMessage: data.message,
                        fullResponse: data,
                        timestamp: timestamp,
                        path: path,
                        prehashString: prehashString
                    }
                }
            });
            return;
        }

        const balances = {};
        if (data.data && Array.isArray(data.data)) {
            data.data.forEach(balance => {
                const available = parseFloat(balance.availableBalance);
                if (available > 0) {
                    balances[balance.asset] = available;
                }
            });
        }

        systemLogger.trading('AscendEX balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'ascendex',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('AscendEX balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch AscendEX balance', 500, 'ASCENDEX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/ascendex/ticker - Get AscendEX ticker data
router.post('/ascendex/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC/USDT for AscendEX)
        const ascendexSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1/$2');
        
        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${ASCENDEX_CONFIG.endpoints.ticker}?symbol=${ascendexSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('AscendEX ticker API error', {
                userId: req.user?.id,
                pair: ascendexSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`AscendEX API error: ${response.status}`, 502, 'ASCENDEX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 0) {
            throw new APIError(`AscendEX error: ${data.message}`, 400, 'ASCENDEX_ERROR');
        }

        let ticker = null;
        if (data.data) {
            const tickerData = Array.isArray(data.data) ? data.data[0] : data.data;
            ticker = {
                symbol: ascendexSymbol,
                lastPrice: parseFloat(tickerData.close),
                bidPrice: parseFloat(tickerData.bid?.[0] || tickerData.close),
                askPrice: parseFloat(tickerData.ask?.[0] || tickerData.close),
                volume: parseFloat(tickerData.volume),
                high: parseFloat(tickerData.high),
                low: parseFloat(tickerData.low),
                change: parseFloat(tickerData.changeRate || 0)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('AscendEX ticker retrieved', {
            userId: req.user?.id,
            pair: ascendexSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'ascendex',
                pair: ascendexSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('AscendEX ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch AscendEX ticker', 500, 'ASCENDEX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/ascendex/test - Test AscendEX API connection
router.post('/ascendex/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const path = ASCENDEX_CONFIG.endpoints.test;
        const signature = createAscendEXSignature(timestamp, path, apiSecret);

        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'GET',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': timestamp,
                'x-auth-signature': signature,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== 0) {
            systemLogger.trading('AscendEX API test failed', {
                userId: req.user?.id,
                error: data.message
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'ascendex',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        systemLogger.trading('AscendEX API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'ascendex',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('AscendEX test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'ascendex',
                connected: false,
                error: error.message
            }
        });
    }
}));

// AscendEX Buy Order Endpoint
router.post('/ascendex/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('orderQty').isFloat({ min: 0.01 }).withMessage('Order quantity must be a positive number'),
    body('orderPrice').optional().isFloat({ min: 0.01 }).withMessage('Order price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, orderQty, orderPrice } = req.body;
    
    try {
        systemLogger.trading('AscendEX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            endpoint: 'buy-order',
            symbol,
            orderQty,
            orderPrice
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol: symbol.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1/$2'), // Convert BTCUSDT -> BTC/USDT
            orderQty: orderQty.toString(),
            side: 'Buy',
            orderType: orderPrice ? 'Limit' : 'Market',
            ...(orderPrice && { orderPrice: orderPrice.toString() })
        };
        
        const path = '/api/pro/v1/order';
        const signature = createAscendEXSignature(timestamp, path, apiSecret);
        
        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': timestamp.toString(),
                'x-auth-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('AscendEX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            orderId: orderResult.data?.orderId,
            symbol,
            orderQty,
            orderPrice
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderData.symbol,
                side: 'buy',
                type: orderPrice ? 'limit' : 'market',
                quantity: parseFloat(orderQty),
                price: parseFloat(orderPrice || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('AscendEX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            symbol,
            orderQty,
            orderPrice,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// AscendEX Sell Order Endpoint
router.post('/ascendex/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('orderQty').isFloat({ min: 0.01 }).withMessage('Order quantity must be a positive number'),
    body('orderPrice').optional().isFloat({ min: 0.01 }).withMessage('Order price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, orderQty, orderPrice } = req.body;
    
    try {
        systemLogger.trading('AscendEX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            endpoint: 'sell-order',
            symbol,
            orderQty,
            orderPrice
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol: symbol.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1/$2'), // Convert BTCUSDT -> BTC/USDT
            orderQty: orderQty.toString(),
            side: 'Sell',
            orderType: orderPrice ? 'Limit' : 'Market',
            ...(orderPrice && { orderPrice: orderPrice.toString() })
        };
        
        const path = '/api/pro/v1/order';
        const signature = createAscendEXSignature(timestamp, path, apiSecret);
        
        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': timestamp.toString(),
                'x-auth-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('AscendEX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            orderId: orderResult.data?.orderId,
            symbol,
            orderQty,
            orderPrice
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderData.symbol,
                side: 'sell',
                type: orderPrice ? 'limit' : 'market',
                quantity: parseFloat(orderQty),
                price: parseFloat(orderPrice || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('AscendEX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            symbol,
            orderQty,
            orderPrice,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// ============================================================================
// HTX (HUOBI) EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// HTX API Configuration
const HTX_CONFIG = {
    baseUrl: 'https://api.huobi.pro',
    endpoints: {
        balance: '/v1/account/accounts/{account-id}/balance',
        accounts: '/v1/account/accounts',
        ticker: '/market/detail/merged',
        test: '/v1/account/accounts'
    }
};

// HTX Authentication Helper
function createHTXSignature(method, host, path, params, apiSecret) {
    const sortedParams = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    const meta = [method, host, path, sortedParams].join('\n');
    return crypto.createHmac('sha256', apiSecret).update(meta).digest('base64');
}

// POST /api/v1/trading/htx/balance - Get HTX account balance
router.post('/htx/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        // First get account ID
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const params = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        // Add detailed logging for debugging
        const sortedParamsString = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
        const signatureString = `GET\napi.huobi.pro\n${HTX_CONFIG.endpoints.accounts}\n${sortedParamsString}`;
        
        systemLogger.trading('HTX signature debug', {
            userId: req.user?.id,
            timestamp: timestamp,
            params: JSON.stringify(params),
            sortedParams: sortedParamsString,
            signatureString: signatureString,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        });
        
        // Try both standard host and host with port (common issue from Stack Overflow)
        let signature = createHTXSignature('GET', 'api.huobi.pro', HTX_CONFIG.endpoints.accounts, params, apiSecret);
        
        systemLogger.trading('HTX trying standard host signature', {
            userId: req.user?.id,
            signature: signature.substring(0, 16) + '...'
        });
        params.Signature = signature;
        
        const accountsUrl = `${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.accounts}?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;
        
        systemLogger.trading('HTX request URL debug', {
            userId: req.user?.id,
            url: accountsUrl
        });
        
        const accountsResponse = await fetch(accountsUrl);
        
        if (!accountsResponse.ok) {
            const errorText = await accountsResponse.text();
            systemLogger.trading('HTX accounts HTTP error', {
                userId: req.user?.id,
                status: accountsResponse.status,
                error: errorText,
                url: accountsUrl
            });
            throw new APIError(`HTX API error: ${accountsResponse.status} - ${errorText}`, 502, 'HTX_API_ERROR');
        }
        
        const accountsData = await accountsResponse.json();
        
        // Add debugging to see what HTX returns
        systemLogger.trading('HTX accounts response', {
            userId: req.user?.id,
            status: accountsData.status,
            errCode: accountsData['err-code'],
            errMsg: accountsData['err-msg'],
            hasData: !!accountsData.data,
            response: JSON.stringify(accountsData)
        });
        
        if (accountsData.status !== 'ok') {
            systemLogger.trading('HTX authentication failed', {
                userId: req.user?.id,
                errCode: accountsData['err-code'],
                errMsg: accountsData['err-msg'],
                timestamp: timestamp,
                signatureUsed: signature.substring(0, 16) + '...'
            });
            
            // Return debug info to frontend for troubleshooting
            res.json({
                success: false,
                error: {
                    code: 'HTX_AUTH_ERROR',
                    message: `HTX error: ${accountsData['err-code']} - ${accountsData['err-msg']}`,
                    debug: {
                        timestamp: timestamp,
                        sortedParams: sortedParamsString,
                        signatureString: signatureString,
                        errCode: accountsData['err-code'],
                        errMsg: accountsData['err-msg'],
                        apiKeyPrefix: apiKey.substring(0, 8) + '...'
                    }
                }
            });
            return;
        }
        
        if (!accountsData.data || accountsData.data.length === 0) {
            throw new APIError('HTX error: No accounts found - API key may need account permissions', 400, 'HTX_ERROR');
        }
        
        const accountId = accountsData.data[0].id;
        
        // Now get balance
        const balanceParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '')
        };
        
        const balancePath = HTX_CONFIG.endpoints.balance.replace('{account-id}', accountId);
        signature = createHTXSignature('GET', 'api.huobi.pro', balancePath, balanceParams, apiSecret);
        balanceParams.Signature = signature;
        
        const balanceUrl = `${HTX_CONFIG.baseUrl}${balancePath}?${Object.keys(balanceParams).map(key => `${key}=${encodeURIComponent(balanceParams[key])}`).join('&')}`;
        const response = await fetch(balanceUrl);

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('HTX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`HTX API error: ${response.status}`, 502, 'HTX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.status !== 'ok') {
            throw new APIError(`HTX error: ${data['err-msg']}`, 400, 'HTX_ERROR');
        }

        const balances = {};
        if (data.data && data.data.list) {
            data.data.list.forEach(balance => {
                if (balance.type === 'trade') {
                    const amount = parseFloat(balance.balance);
                    if (amount > 0) {
                        balances[balance.currency.toUpperCase()] = amount;
                    }
                }
            });
        }

        systemLogger.trading('HTX balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'htx',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('HTX balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch HTX balance', 500, 'HTX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/htx/ticker - Get HTX ticker data
router.post('/htx/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> btcusdt for HTX)
        const htxSymbol = pair.toLowerCase();
        
        const response = await fetch(`${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.ticker}?symbol=${htxSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('HTX ticker API error', {
                userId: req.user?.id,
                pair: htxSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`HTX API error: ${response.status}`, 502, 'HTX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.status !== 'ok') {
            throw new APIError(`HTX error: ${data['err-msg']}`, 400, 'HTX_ERROR');
        }

        let ticker = null;
        if (data.tick) {
            ticker = {
                symbol: htxSymbol,
                lastPrice: parseFloat(data.tick.close),
                bidPrice: parseFloat(data.tick.bid[0]),
                askPrice: parseFloat(data.tick.ask[0]),
                volume: parseFloat(data.tick.vol),
                high: parseFloat(data.tick.high),
                low: parseFloat(data.tick.low),
                change: ((parseFloat(data.tick.close) - parseFloat(data.tick.open)) / parseFloat(data.tick.open) * 100)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('HTX ticker retrieved', {
            userId: req.user?.id,
            pair: htxSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'htx',
                pair: htxSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('HTX ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch HTX ticker', 500, 'HTX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/htx/test - Test HTX API connection
router.post('/htx/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const params = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        const signature = createHTXSignature('GET', 'api.huobi.pro', HTX_CONFIG.endpoints.test, params, apiSecret);
        params.Signature = signature;
        
        const url = `${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.test}?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;
        const response = await fetch(url);

        const data = await response.json();
        
        if (data.status !== 'ok') {
            systemLogger.trading('HTX API test failed', {
                userId: req.user?.id,
                error: data['err-msg']
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'htx',
                    connected: false,
                    error: data['err-msg']
                }
            });
            return;
        }

        systemLogger.trading('HTX API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'htx',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('HTX test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'htx',
                connected: false,
                error: error.message
            }
        });
    }
}));

// HTX Buy Order Endpoint
router.post('/htx/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, amount, price } = req.body;
    
    try {
        systemLogger.trading('HTX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            endpoint: 'buy-order',
            symbol,
            amount,
            price
        });
        
        // First get account ID
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const accountParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        const accountSignature = createHTXSignature('GET', 'api.huobi.pro', '/v1/account/accounts', accountParams, apiSecret);
        accountParams.Signature = accountSignature;
        
        const accountQuery = Object.keys(accountParams).sort().map(key => `${key}=${encodeURIComponent(accountParams[key])}`).join('&');
        
        const accountResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/account/accounts?${accountQuery}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!accountResponse.ok) {
            const errorText = await accountResponse.text();
            throw new Error(`Account fetch failed: ${errorText}`);
        }
        
        const accountData = await accountResponse.json();
        
        if (accountData.status !== 'ok' || !accountData.data || accountData.data.length === 0) {
            throw new Error(accountData['err-msg'] || 'No trading accounts found');
        }
        
        const spotAccount = accountData.data.find(acc => acc.type === 'spot');
        if (!spotAccount) {
            throw new Error('Spot trading account not found');
        }
        
        // Now place order
        const orderTimestamp = new Date().toISOString().replace(/\.\d{3}/, '');
        const orderData = {
            'account-id': spotAccount.id.toString(),
            symbol: symbol.toLowerCase(),
            type: price ? 'buy-limit' : 'buy-market',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const orderBody = JSON.stringify(orderData);
        const orderParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: orderTimestamp
        };
        
        const orderSignature = createHTXSignature('POST', 'api.huobi.pro', '/v1/order/orders/place', orderParams, apiSecret);
        orderParams.Signature = orderSignature;
        
        const orderQuery = Object.keys(orderParams).sort().map(key => `${key}=${encodeURIComponent(orderParams[key])}`).join('&');
        
        const orderResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/order/orders/place?${orderQuery}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: orderBody
        });
        
        if (!orderResponse.ok) {
            const errorText = await orderResponse.text();
            throw new Error(`HTTP ${orderResponse.status}: ${errorText}`);
        }
        
        const orderResult = await orderResponse.json();
        
        if (orderResult.status !== 'ok') {
            throw new Error(orderResult['err-msg'] || 'Order placement failed');
        }
        
        systemLogger.trading('HTX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            orderId: orderResult.data,
            symbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data,
                symbol: symbol.toLowerCase(),
                side: 'buy',
                type: price ? 'limit' : 'market',
                amount: parseFloat(amount),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('HTX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            symbol,
            amount,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// HTX Sell Order Endpoint
router.post('/htx/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, amount, price } = req.body;
    
    try {
        systemLogger.trading('HTX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            endpoint: 'sell-order',
            symbol,
            amount,
            price
        });
        
        // First get account ID
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const accountParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        const accountSignature = createHTXSignature('GET', 'api.huobi.pro', '/v1/account/accounts', accountParams, apiSecret);
        accountParams.Signature = accountSignature;
        
        const accountQuery = Object.keys(accountParams).sort().map(key => `${key}=${encodeURIComponent(accountParams[key])}`).join('&');
        
        const accountResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/account/accounts?${accountQuery}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!accountResponse.ok) {
            const errorText = await accountResponse.text();
            throw new Error(`Account fetch failed: ${errorText}`);
        }
        
        const accountData = await accountResponse.json();
        
        if (accountData.status !== 'ok' || !accountData.data || accountData.data.length === 0) {
            throw new Error(accountData['err-msg'] || 'No trading accounts found');
        }
        
        const spotAccount = accountData.data.find(acc => acc.type === 'spot');
        if (!spotAccount) {
            throw new Error('Spot trading account not found');
        }
        
        // Now place order
        const orderTimestamp = new Date().toISOString().replace(/\.\d{3}/, '');
        const orderData = {
            'account-id': spotAccount.id.toString(),
            symbol: symbol.toLowerCase(),
            type: price ? 'sell-limit' : 'sell-market',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const orderBody = JSON.stringify(orderData);
        const orderParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: orderTimestamp
        };
        
        const orderSignature = createHTXSignature('POST', 'api.huobi.pro', '/v1/order/orders/place', orderParams, apiSecret);
        orderParams.Signature = orderSignature;
        
        const orderQuery = Object.keys(orderParams).sort().map(key => `${key}=${encodeURIComponent(orderParams[key])}`).join('&');
        
        const orderResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/order/orders/place?${orderQuery}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: orderBody
        });
        
        if (!orderResponse.ok) {
            const errorText = await orderResponse.text();
            throw new Error(`HTTP ${orderResponse.status}: ${errorText}`);
        }
        
        const orderResult = await orderResponse.json();
        
        if (orderResult.status !== 'ok') {
            throw new Error(orderResult['err-msg'] || 'Order placement failed');
        }
        
        systemLogger.trading('HTX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            orderId: orderResult.data,
            symbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data,
                symbol: symbol.toLowerCase(),
                side: 'sell',
                type: price ? 'limit' : 'market',
                amount: parseFloat(amount),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('HTX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            symbol,
            amount,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// KuCoin Buy Order Endpoint
router.post('/kucoin/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('KuCoin buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            clientOid: `${timestamp}`,
            side: 'buy',
            symbol,
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const str_to_sign = timestamp + 'POST' + '/api/v1/orders' + body;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(str_to_sign)
            .digest('base64');
        
        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}/api/v1/orders`, {
            method: 'POST',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': crypto
                    .createHmac('sha256', apiSecret)
                    .update(passphrase)
                    .digest('base64'),
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '200000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('KuCoin buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                clientOid: `${timestamp}`,
                symbol,
                side: 'buy',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'active',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('KuCoin buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`KuCoin buy order failed: ${error.message}`, 500, 'KUCOIN_BUY_ORDER_ERROR');
    }
}));

// KuCoin Sell Order Endpoint
router.post('/kucoin/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('KuCoin sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            clientOid: `${timestamp}`,
            side: 'sell',
            symbol,
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const str_to_sign = timestamp + 'POST' + '/api/v1/orders' + body;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(str_to_sign)
            .digest('base64');
        
        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}/api/v1/orders`, {
            method: 'POST',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': crypto
                    .createHmac('sha256', apiSecret)
                    .update(passphrase)
                    .digest('base64'),
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '200000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('KuCoin sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                clientOid: `${timestamp}`,
                symbol,
                side: 'sell',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'active',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('KuCoin sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`KuCoin sell order failed: ${error.message}`, 500, 'KUCOIN_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BINGX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// BingX API Configuration
const BINGX_CONFIG = {
    baseUrl: 'https://open-api.bingx.com',
    endpoints: {
        balance: '/openApi/spot/v1/account/balance',
        ticker: '/openApi/spot/v1/ticker/24hr',
        test: '/openApi/spot/v1/account/balance'
    }
};

// BingX Authentication Helper
function createBingXSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/bingx/balance - Get BingX account balance
router.post('/bingx/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBingXSignature(queryString, apiSecret);

        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = errorText;
            }
            
            systemLogger.trading('BingX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorData,
                requestDetails: {
                    url: `${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.balance}`,
                    queryString: queryString,
                    signature: signature.substring(0, 16) + '...',
                    apiKey: apiKey.substring(0, 8) + '...'
                }
            });
            
            // Pass the actual error message to the frontend
            const errorMessage = errorData?.msg || errorData?.message || `BingX API error: ${response.status}`;
            throw new APIError(errorMessage, 502, 'BINGX_API_ERROR');
        }

        const data = await response.json();
        
        // Log successful response for debugging
        systemLogger.trading('BingX balance response', {
            userId: req.user?.id,
            code: data.code,
            msg: data.msg,
            hasData: !!data.data
        });
        
        if (data.code !== 0) {
            systemLogger.trading('BingX API returned error code', {
                userId: req.user?.id,
                code: data.code,
                message: data.msg,
                fullResponse: JSON.stringify(data)
            });
            throw new APIError(`BingX error: ${data.msg || 'Unknown error'}`, 400, 'BINGX_ERROR');
        }

        const balances = {};
        if (data.data && data.data.balances) {
            data.data.balances.forEach(balance => {
                const free = parseFloat(balance.free);
                if (free > 0) {
                    balances[balance.asset] = free;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bingx',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BingX balance', 500, 'BINGX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bingx/ticker - Get BingX ticker data
router.post('/bingx/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`BingX API error: ${response.status}`, 502, 'BINGX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 0) {
            throw new APIError(`BingX error: ${data.msg}`, 400, 'BINGX_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: data.data.symbol,
                lastPrice: parseFloat(data.data.lastPrice),
                bidPrice: parseFloat(data.data.bidPrice),
                askPrice: parseFloat(data.data.askPrice),
                volume: parseFloat(data.data.volume),
                high: parseFloat(data.data.highPrice),
                low: parseFloat(data.data.lowPrice),
                change: parseFloat(data.data.priceChangePercent)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bingx',
                pair,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BingX ticker', 500, 'BINGX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bingx/test - Test BingX API connection
router.post('/bingx/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBingXSignature(queryString, apiSecret);

        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.test}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== 0) {
            res.json({
                success: false,
                data: {
                    exchange: 'bingx',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bingx',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bingx',
                connected: false,
                error: error.message
            }
        });
    }
}));

// BingX Buy Order Endpoint
router.post('/bingx/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('BingX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('BingX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            orderId: orderResult.data?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderResult.data?.symbol,
                side: 'BUY',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'NEW',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BingX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`BingX buy order failed: ${error.message}`, 500, 'BINGX_BUY_ORDER_ERROR');
    }
}));

// BingX Sell Order Endpoint
router.post('/bingx/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('BingX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('BingX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            orderId: orderResult.data?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderResult.data?.symbol,
                side: 'SELL',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'NEW',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BingX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`BingX sell order failed: ${error.message}`, 500, 'BINGX_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BITGET EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Bitget API Configuration
const BITGET_CONFIG = {
    baseUrl: 'https://api.bitget.com',
    endpoints: {
        balance: '/api/spot/v1/account/assets',
        ticker: '/api/spot/v1/market/ticker',
        test: '/api/spot/v1/account/assets'
    }
};

// Bitget Authentication Helper
function createBitgetSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = timestamp + method + requestPath + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// POST /api/v1/trading/bitget/balance - Get Bitget account balance
router.post('/bitget/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = BITGET_CONFIG.endpoints.balance;
        const signature = createBitgetSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${BITGET_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitget API error: ${response.status}`, 502, 'BITGET_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '00000') {
            throw new APIError(`Bitget error: ${data.msg}`, 400, 'BITGET_ERROR');
        }

        const balances = {};
        if (data.data) {
            data.data.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.coinName] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitget',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitget balance', 500, 'BITGET_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bitget/ticker - Get Bitget ticker data
router.post('/bitget/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTCUSDT_SPBL for Bitget)
        const bitgetSymbol = `${pair}_SPBL`;
        
        const response = await fetch(`${BITGET_CONFIG.baseUrl}${BITGET_CONFIG.endpoints.ticker}?symbol=${bitgetSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitget API error: ${response.status}`, 502, 'BITGET_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '00000') {
            throw new APIError(`Bitget error: ${data.msg}`, 400, 'BITGET_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: bitgetSymbol,
                lastPrice: parseFloat(data.data.close),
                bidPrice: parseFloat(data.data.bidPr),
                askPrice: parseFloat(data.data.askPr),
                volume: parseFloat(data.data.baseVol),
                high: parseFloat(data.data.high24h),
                low: parseFloat(data.data.low24h),
                change: parseFloat(data.data.change)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitget',
                pair: bitgetSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitget ticker', 500, 'BITGET_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bitget/test - Test Bitget API connection
router.post('/bitget/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = BITGET_CONFIG.endpoints.test;
        const signature = createBitgetSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${BITGET_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== '00000') {
            res.json({
                success: false,
                data: {
                    exchange: 'bitget',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitget',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bitget',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Bitget Buy Order Endpoint
router.post('/bitget/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('Bitget buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'buy',
            orderType: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = createBitgetSignature(timestamp, 'POST', '/api/spot/v1/trade/orders', body, apiSecret);
        
        const response = await fetch(`${BITGET_CONFIG.baseUrl}/api/spot/v1/trade/orders`, {
            method: 'POST',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '00000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('Bitget buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol,
                side: 'buy',
                orderType: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'new',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitget buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`Bitget buy order failed: ${error.message}`, 500, 'BITGET_BUY_ORDER_ERROR');
    }
}));

// Bitget Sell Order Endpoint
router.post('/bitget/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('Bitget sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'sell',
            orderType: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = createBitgetSignature(timestamp, 'POST', '/api/spot/v1/trade/orders', body, apiSecret);
        
        const response = await fetch(`${BITGET_CONFIG.baseUrl}/api/spot/v1/trade/orders`, {
            method: 'POST',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '00000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('Bitget sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol,
                side: 'sell',
                orderType: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'new',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitget sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`Bitget sell order failed: ${error.message}`, 500, 'BITGET_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BITMART EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// BitMart API Configuration
const BITMART_CONFIG = {
    baseUrl: 'https://api-cloud.bitmart.com',
    endpoints: {
        balance: '/spot/v1/wallet',
        ticker: '/spot/v1/ticker',
        test: '/spot/v1/wallet'
    }
};

// BitMart Authentication Helper
function createBitMartSignature(timestamp, memo, queryString, apiSecret) {
    // BitMart signature format: timestamp + '#' + memo + '#' + queryString
    const message = timestamp + '#' + (memo || '') + '#' + (queryString || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

// POST /api/v1/trading/bitmart/balance - Get BitMart account balance
router.post('/bitmart/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').optional() // Made memo optional
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, memo } = req.body;

    try {
        const timestamp = Date.now().toString();
        // For GET requests, queryString is empty
        const signature = createBitMartSignature(timestamp, memo || '', '', apiSecret);
        const requestPath = BITMART_CONFIG.endpoints.balance;

        const headers = {
            'X-BM-KEY': apiKey,
            'X-BM-SIGN': signature,
            'X-BM-TIMESTAMP': timestamp,
            'Content-Type': 'application/json'
        };

        const response = await fetch(`${BITMART_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new APIError(`BitMart API error: ${response.status}`, 502, 'BITMART_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 1000) {
            throw new APIError(`BitMart error: ${data.message}`, 400, 'BITMART_ERROR');
        }

        const balances = {};
        if (data.data && data.data.wallet) {
            data.data.wallet.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.id] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitmart',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BitMart balance', 500, 'BITMART_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bitmart/ticker - Get BitMart ticker data
router.post('/bitmart/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC_USDT for BitMart)
        const bitmartSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const response = await fetch(`${BITMART_CONFIG.baseUrl}${BITMART_CONFIG.endpoints.ticker}?symbol=${bitmartSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`BitMart API error: ${response.status}`, 502, 'BITMART_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 1000) {
            throw new APIError(`BitMart error: ${data.message}`, 400, 'BITMART_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: bitmartSymbol,
                lastPrice: parseFloat(data.data.last_price),
                bidPrice: parseFloat(data.data.best_bid),
                askPrice: parseFloat(data.data.best_ask),
                volume: parseFloat(data.data.base_volume_24h),
                high: parseFloat(data.data.high_24h),
                low: parseFloat(data.data.low_24h),
                change: parseFloat(data.data.fluctuation)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitmart',
                pair: bitmartSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BitMart ticker', 500, 'BITMART_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bitmart/test - Test BitMart API connection
router.post('/bitmart/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').optional() // Made memo optional
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, memo } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        // For GET requests, queryString is empty
        const signature = createBitMartSignature(timestamp, memo || '', '', apiSecret);
        const requestPath = BITMART_CONFIG.endpoints.test;

        const headers = {
            'X-BM-KEY': apiKey,
            'X-BM-SIGN': signature,
            'X-BM-TIMESTAMP': timestamp,
            'Content-Type': 'application/json'
        };

        const response = await fetch(`${BITMART_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('BitMart API error', {
                status: response.status,
                error: errorText,
                headers: headers
            });
            throw new APIError(`BitMart API error: ${response.status}`, 502, 'BITMART_API_ERROR');
        }

        const data = await response.json().catch(() => ({}));
        
        if (!data || data.code !== 1000) {
            res.json({
                success: false,
                data: {
                    exchange: 'bitmart',
                    connected: false,
                    error: data.message || 'Failed to connect to BitMart'
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitmart',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bitmart',
                connected: false,
                error: error.message
            }
        });
    }
}));

// BitMart Buy Order Endpoint
router.post('/bitmart/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').notEmpty().withMessage('Memo is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, memo, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('BitMart buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'buy',
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        // For POST requests with body, the queryString is the body itself
        const signature = createBitMartSignature(timestamp, memo || '', body, apiSecret);
        
        const response = await fetch(`${BITMART_CONFIG.baseUrl}/spot/v2/submit_order`, {
            method: 'POST',
            headers: {
                'X-BM-KEY': apiKey,
                'X-BM-SIGN': signature,
                'X-BM-TIMESTAMP': timestamp,
                'X-BM-MEMO': memo,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 1000) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('BitMart buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            orderId: orderResult.data?.order_id,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.order_id,
                symbol,
                side: 'buy',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BitMart buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`BitMart buy order failed: ${error.message}`, 500, 'BITMART_BUY_ORDER_ERROR');
    }
}));

// BitMart Sell Order Endpoint
router.post('/bitmart/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').notEmpty().withMessage('Memo is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, memo, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('BitMart sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'sell',
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        // For POST requests with body, the queryString is the body itself
        const signature = createBitMartSignature(timestamp, memo || '', body, apiSecret);
        
        const response = await fetch(`${BITMART_CONFIG.baseUrl}/spot/v2/submit_order`, {
            method: 'POST',
            headers: {
                'X-BM-KEY': apiKey,
                'X-BM-SIGN': signature,
                'X-BM-TIMESTAMP': timestamp,
                'X-BM-MEMO': memo,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 1000) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('BitMart sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            orderId: orderResult.data?.order_id,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.order_id,
                symbol,
                side: 'sell',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BitMart sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`BitMart sell order failed: ${error.message}`, 500, 'BITMART_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BITRUE EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Bitrue API Configuration
const BITRUE_CONFIG = {
    baseUrl: 'https://openapi.bitrue.com',
    endpoints: {
        balance: '/api/v1/account',
        ticker: '/api/v1/ticker/24hr',
        test: '/api/v1/account'
    }
};

// Bitrue Authentication Helper (similar to Binance)
function createBitrueSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/bitrue/balance - Get Bitrue account balance
router.post('/bitrue/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBitrueSignature(queryString, apiSecret);

        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitrue API error: ${response.status}`, 502, 'BITRUE_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (data.balances) {
            data.balances.forEach(balance => {
                const free = parseFloat(balance.free);
                if (free > 0) {
                    balances[balance.asset] = free;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitrue',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitrue balance', 500, 'BITRUE_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bitrue/ticker - Get Bitrue ticker data
router.post('/bitrue/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitrue API error: ${response.status}`, 502, 'BITRUE_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.symbol) {
            ticker = {
                symbol: data.symbol,
                lastPrice: parseFloat(data.lastPrice),
                bidPrice: parseFloat(data.bidPrice),
                askPrice: parseFloat(data.askPrice),
                volume: parseFloat(data.volume),
                high: parseFloat(data.highPrice),
                low: parseFloat(data.lowPrice),
                change: parseFloat(data.priceChangePercent)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitrue',
                pair,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitrue ticker', 500, 'BITRUE_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bitrue/test - Test Bitrue API connection
router.post('/bitrue/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBitrueSignature(queryString, apiSecret);

        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.test}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code && data.code < 0) {
            res.json({
                success: false,
                data: {
                    exchange: 'bitrue',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitrue',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bitrue',
                connected: false,
                error: error.message
            }
        });
    }
}));

// ============================================================================
// GEMINI EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Gemini API Configuration
const GEMINI_CONFIG = {
    baseUrl: 'https://api.gemini.com',
    endpoints: {
        balance: '/v1/balances',
        ticker: '/v1/pubticker',
        test: '/v1/heartbeat'
    }
};

// Gemini Authentication Helper
function createGeminiSignature(payload, apiSecret) {
    return crypto.createHmac('sha384', apiSecret).update(payload).digest('hex');
}

// POST /api/v1/trading/gemini/balance - Get Gemini account balance
router.post('/gemini/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now();
        const payload = {
            request: GEMINI_CONFIG.endpoints.balance,
            nonce: nonce,
            account: 'primary'  // Gemini expects account specification
        };
        const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
        const signature = createGeminiSignature(payloadBase64, apiSecret);

        systemLogger.trading('Gemini request debug', {
            userId: req.user?.id,
            url: `${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.balance}`,
            payload: JSON.stringify(payload),
            payloadBase64: payloadBase64
        });

        const response = await fetch(`${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.balance}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'X-GEMINI-APIKEY': apiKey,
                'X-GEMINI-PAYLOAD': payloadBase64,
                'X-GEMINI-SIGNATURE': signature
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Gemini API error', {
                userId: req.user?.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers),
                error: errorText,
                requestDetails: {
                    url: `${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.balance}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain',
                        'X-GEMINI-APIKEY': apiKey.substring(0, 8) + '...',
                        'X-GEMINI-PAYLOAD': payloadBase64.substring(0, 50) + '...',
                        'X-GEMINI-SIGNATURE': signature.substring(0, 16) + '...'
                    }
                }
            });
            throw new APIError(`Gemini API error: ${response.status} - ${errorText}`, 502, 'GEMINI_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (Array.isArray(data)) {
            data.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.currency] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'gemini',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gemini balance', 500, 'GEMINI_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/gemini/ticker - Get Gemini ticker data
router.post('/gemini/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> btcusd for Gemini)
        const geminiSymbol = pair.replace('USDT', 'USD').toLowerCase();
        
        const response = await fetch(`${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.ticker}/${geminiSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Gemini API error: ${response.status}`, 502, 'GEMINI_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.last) {
            ticker = {
                symbol: geminiSymbol,
                lastPrice: parseFloat(data.last),
                bidPrice: parseFloat(data.bid),
                askPrice: parseFloat(data.ask),
                volume: parseFloat(data.volume[Object.keys(data.volume)[0]] || 0),
                high: parseFloat(data.last),
                low: parseFloat(data.last),
                change: 0
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'gemini',
                pair: geminiSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gemini ticker', 500, 'GEMINI_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/gemini/test - Test Gemini API connection
router.post('/gemini/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now();
        const payload = {
            request: GEMINI_CONFIG.endpoints.test,
            nonce: nonce
        };
        const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
        const signature = createGeminiSignature(payloadBase64, apiSecret);

        const response = await fetch(`${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.test}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'X-GEMINI-APIKEY': apiKey,
                'X-GEMINI-PAYLOAD': payloadBase64,
                'X-GEMINI-SIGNATURE': signature
            }
        });

        const data = await response.json();
        
        if (data.result === 'error') {
            res.json({
                success: false,
                data: {
                    exchange: 'gemini',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'gemini',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'gemini',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Bitrue Buy Order Endpoint
router.post('/bitrue/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Bitrue buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Bitrue buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitrue buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`Bitrue buy order failed: ${error.message}`, 500, 'BITRUE_BUY_ORDER_ERROR');
    }
}));

// Bitrue Sell Order Endpoint
router.post('/bitrue/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Bitrue sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Bitrue sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitrue sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`Bitrue sell order failed: ${error.message}`, 500, 'BITRUE_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// CRYPTO.COM EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Crypto.com API Configuration
const CRYPTOCOM_CONFIG = {
    baseUrl: 'https://api.crypto.com',
    endpoints: {
        balance: '/v2/private/get-account-summary',
        ticker: '/v2/public/get-ticker',
        test: '/v2/private/get-account-summary'
    }
};

// Crypto.com Authentication Helper
function createCryptoComSignature(method, requestPath, body, apiSecret, timestamp, nonce) {
    const paramString = method + requestPath + body + timestamp + nonce;
    return crypto.createHmac('sha256', apiSecret).update(paramString).digest('hex');
}

// POST /api/v1/trading/cryptocom/balance - Get Crypto.com account balance
router.post('/cryptocom/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const nonce = Date.now();
        const method = 'POST';
        const requestPath = CRYPTOCOM_CONFIG.endpoints.balance;
        const requestBody = JSON.stringify({
            id: 11,
            method: 'private/get-account-summary',
            api_key: apiKey,
            nonce: nonce
        });
        
        const signature = createCryptoComSignature(method, requestPath, requestBody, apiSecret, timestamp, nonce);

        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `${apiKey}:${signature}:${nonce}`
            },
            body: requestBody
        });

        if (!response.ok) {
            throw new APIError(`Crypto.com API error: ${response.status}`, 502, 'CRYPTOCOM_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (data.result && data.result.accounts) {
            data.result.accounts.forEach(account => {
                const available = parseFloat(account.available);
                if (available > 0) {
                    balances[account.currency] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'cryptocom',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Crypto.com balance', 500, 'CRYPTOCOM_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/cryptocom/ticker - Get Crypto.com ticker data
router.post('/cryptocom/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC_USDT for Crypto.com)
        const cryptocomSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${CRYPTOCOM_CONFIG.endpoints.ticker}?instrument_name=${cryptocomSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Crypto.com API error: ${response.status}`, 502, 'CRYPTOCOM_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.result && data.result.data && data.result.data.length > 0) {
            const tickerData = data.result.data[0];
            ticker = {
                symbol: cryptocomSymbol,
                lastPrice: parseFloat(tickerData.a),
                bidPrice: parseFloat(tickerData.b),
                askPrice: parseFloat(tickerData.k),
                volume: parseFloat(tickerData.v),
                high: parseFloat(tickerData.h),
                low: parseFloat(tickerData.l),
                change: parseFloat(tickerData.c || 0)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'cryptocom',
                pair: cryptocomSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Crypto.com ticker', 500, 'CRYPTOCOM_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/cryptocom/test - Test Crypto.com API connection
router.post('/cryptocom/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const nonce = Date.now();
        const method = 'POST';
        const requestPath = CRYPTOCOM_CONFIG.endpoints.test;
        const requestBody = JSON.stringify({
            id: 11,
            method: 'private/get-account-summary',
            api_key: apiKey,
            nonce: nonce
        });
        
        const signature = createCryptoComSignature(method, requestPath, requestBody, apiSecret, timestamp, nonce);

        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `${apiKey}:${signature}:${nonce}`
            },
            body: requestBody
        });

        const data = await response.json();
        
        if (data.code && data.code !== 0) {
            res.json({
                success: false,
                data: {
                    exchange: 'cryptocom',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'cryptocom',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'cryptocom',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Crypto.com Buy Order Endpoint
router.post('/cryptocom/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('instrument_name').notEmpty().withMessage('Instrument name is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, instrument_name, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Crypto.com buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            endpoint: 'buy-order',
            instrument_name,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            instrument_name,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const nonce = timestamp;
        const method = 'POST';
        const requestPath = '/v2/private/create-order';
        const body = JSON.stringify(orderData);
        
        const signaturePayload = method + requestPath + body + nonce;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');
        
        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
                'signature': signature,
                'nonce': nonce.toString()
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('Crypto.com buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            orderId: orderResult.result?.order_id,
            instrument_name,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.order_id,
                instrument_name,
                side: 'BUY',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.result?.status || 'PENDING',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Crypto.com buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            error: error.message,
            instrument_name,
            quantity
        });
        
        throw new APIError(`Crypto.com buy order failed: ${error.message}`, 500, 'CRYPTOCOM_BUY_ORDER_ERROR');
    }
}));

// Crypto.com Sell Order Endpoint
router.post('/cryptocom/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('instrument_name').notEmpty().withMessage('Instrument name is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, instrument_name, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Crypto.com sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            endpoint: 'sell-order',
            instrument_name,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            instrument_name,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const nonce = timestamp;
        const method = 'POST';
        const requestPath = '/v2/private/create-order';
        const body = JSON.stringify(orderData);
        
        const signaturePayload = method + requestPath + body + nonce;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');
        
        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
                'signature': signature,
                'nonce': nonce.toString()
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('Crypto.com sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            orderId: orderResult.result?.order_id,
            instrument_name,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.order_id,
                instrument_name,
                side: 'SELL',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.result?.status || 'PENDING',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Crypto.com sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            error: error.message,
            instrument_name,
            quantity
        });
        
        throw new APIError(`Crypto.com sell order failed: ${error.message}`, 500, 'CRYPTOCOM_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// COINCATCH EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// CoinCatch API Configuration
const COINCATCH_CONFIG = {
    baseUrl: 'https://api.coincatch.com',
    endpoints: {
        balance: '/api/spot/v1/account/assets',
        ticker: '/api/v1/market/ticker',
        test: '/api/spot/v1/account/assets'
    }
};

// CoinCatch Authentication Helper
function createCoinCatchSignature(timestamp, method, requestPath, queryString, body, apiSecret) {
    // Format: timestamp + method + requestPath + "?" + queryString + body
    // Note: Only include "?" + queryString if queryString exists
    let message = timestamp + method + requestPath;
    if (queryString) {
        message += '?' + queryString;
    }
    message += (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// POST /api/v1/trading/coincatch/balance - Get CoinCatch account balance
router.post('/coincatch/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = COINCATCH_CONFIG.endpoints.balance;
        const signature = createCoinCatchSignature(timestamp, method, requestPath, '', '', apiSecret);

        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        // CoinCatch may return success: false with 200 status (like BitMart/Bitget)
        // Check both HTTP status and response structure
        if (!response.ok && response.status !== 400) {
            throw new APIError(`CoinCatch API error: ${response.status}`, 502, 'COINCATCH_API_ERROR');
        }
        
        const balances = {};
        if (data.data && Array.isArray(data.data)) {
            data.data.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.coinName] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'coincatch',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch CoinCatch balance', 500, 'COINCATCH_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/coincatch/ticker - Get CoinCatch ticker data
router.post('/coincatch/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}${COINCATCH_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        // CoinCatch may return success: false with 200 status (like BitMart/Bitget)
        // Check both HTTP status and response structure
        if (!response.ok && response.status !== 400) {
            throw new APIError(`CoinCatch API error: ${response.status}`, 502, 'COINCATCH_API_ERROR');
        }
        
        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: data.data.symbol,
                lastPrice: parseFloat(data.data.close),
                bidPrice: parseFloat(data.data.bid),
                askPrice: parseFloat(data.data.ask),
                volume: parseFloat(data.data.volume),
                high: parseFloat(data.data.high),
                low: parseFloat(data.data.low),
                change: parseFloat(data.data.change)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'coincatch',
                pair,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch CoinCatch ticker', 500, 'COINCATCH_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/coincatch/test - Test CoinCatch API connection
router.post('/coincatch/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = COINCATCH_CONFIG.endpoints.test;
        const signature = createCoinCatchSignature(timestamp, method, requestPath, '', '', apiSecret);

        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code && data.code !== '0') {
            res.json({
                success: false,
                data: {
                    exchange: 'coincatch',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'coincatch',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'coincatch',
                connected: false,
                error: error.message
            }
        });
    }
}));

// CoinCatch Buy Order Endpoint
router.post('/coincatch/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('CoinCatch buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            instId: symbol,
            tdMode: 'cash',
            side: 'buy',
            ordType: price ? 'limit' : 'market',
            sz: size.toString(),
            ...(price && { px: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + 'POST' + '/api/v5/trade/order' + body)
            .digest('base64');
        
        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}/api/v5/trade/order`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': apiSecret,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('CoinCatch buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            orderId: orderResult.data?.[0]?.ordId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.[0]?.ordId,
                instId: symbol,
                side: 'buy',
                ordType: price ? 'limit' : 'market',
                sz: parseFloat(size),
                px: parseFloat(price || 0),
                state: orderResult.data?.[0]?.sCode || 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('CoinCatch buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`CoinCatch buy order failed: ${error.message}`, 500, 'COINCATCH_BUY_ORDER_ERROR');
    }
}));

// CoinCatch Sell Order Endpoint
router.post('/coincatch/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('CoinCatch sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            instId: symbol,
            tdMode: 'cash',
            side: 'sell',
            ordType: price ? 'limit' : 'market',
            sz: size.toString(),
            ...(price && { px: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + 'POST' + '/api/v5/trade/order' + body)
            .digest('base64');
        
        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}/api/v5/trade/order`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': apiSecret,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('CoinCatch sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            orderId: orderResult.data?.[0]?.ordId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.[0]?.ordId,
                instId: symbol,
                side: 'sell',
                ordType: price ? 'limit' : 'market',
                sz: parseFloat(size),
                px: parseFloat(price || 0),
                state: orderResult.data?.[0]?.sCode || 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('CoinCatch sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`CoinCatch sell order failed: ${error.message}`, 500, 'COINCATCH_SELL_ORDER_ERROR');
    }
}));

// VALR Direct API Testing Endpoint
router.post('/valr/test-direct', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('endpoint').notEmpty().withMessage('Endpoint is required'),
    body('payload').isObject().withMessage('Payload must be an object')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, endpoint, payload } = req.body;
    
    try {
        systemLogger.trading('VALR direct API test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: endpoint,
            payload: payload
        });
        
        // Test the specific endpoint with the given payload
        const result = await makeValrRequest(
            endpoint,
            'POST',
            apiKey,
            apiSecret,
            payload
        );
        
        systemLogger.trading('VALR direct API test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: endpoint,
            result: result
        });
        
        res.json({
            success: true,
            data: {
                endpoint: endpoint,
                payload: payload,
                result: result
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR direct API test failed', {
            userId: req.user?.id || 'anonymous',
            error: error.message,
            endpoint: endpoint,
            payload: payload
        });
        
        res.status(500).json({
            success: false,
            error: {
                code: 'VALR_DIRECT_TEST_ERROR',
                message: `VALR direct test failed: ${error.message}`,
                endpoint: endpoint,
                payload: payload
            }
        });
    }
}));

// ============================================
// TRIANGULAR TRADE DATABASE LOGGING
// ============================================

// Log triangular trade to database
async function logTriangularTrade(userId, tradeData) {
    try {
        const {
            opportunity,
            executionResult,
            dryRun = false,
            userAgent = null,
            ipAddress = null
        } = tradeData;

        // Generate unique trade ID
        const tradeId = 'TRI_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6).toUpperCase();

        // Prepare trade record
        const tradeRecord = {
            user_id: userId,
            trade_id: tradeId,
            exchange: 'VALR',
            path_id: opportunity.path.id,
            path_sequence: opportunity.path.sequence,
            opportunity_data: JSON.stringify(opportunity),
            initial_amount: opportunity.amount || 1000,
            currency_start: opportunity.path.baseCurrency || 'ZAR',
            execution_status: executionResult.success ? 'completed' : 'failed',
            execution_type: 'atomic',
            dry_run: dryRun,
            expected_profit_zar: opportunity.expectedProfitZAR || null,
            expected_profit_percent: opportunity.netProfitPercent || null,
            actual_profit_zar: executionResult.success ? (executionResult.summary?.totalProfitZAR || 0) : 0,
            actual_profit_percent: executionResult.success ? (executionResult.summary?.totalProfitPercent || 0) : 0,
            total_fees_paid: executionResult.success ? (executionResult.summary?.totalFeesZAR || 0) : 0,
            risk_assessment: opportunity.recommendation || 'EXECUTE',
            max_slippage_allowed: tradeData.maxSlippage || 0.5,
            scan_started_at: tradeData.scanStartedAt || new Date(),
            execution_started_at: tradeData.executionStartedAt || new Date(),
            execution_completed_at: executionResult.success ? new Date() : null,
            total_execution_time_ms: tradeData.executionTimeMs || null,
            error_message: executionResult.success ? null : executionResult.error,
            user_agent: userAgent,
            ip_address: ipAddress
        };

        // Add individual leg details if available
        if (executionResult.success && executionResult.trades) {
            const trades = executionResult.trades;
            
            if (trades[0]) {
                tradeRecord.leg1_order_id = trades[0].orderId;
                tradeRecord.leg1_pair = trades[0].pair;
                tradeRecord.leg1_side = trades[0].side;
                tradeRecord.leg1_amount = trades[0].baseAmount || trades[0].quoteAmount;
                tradeRecord.leg1_price = trades[0].price;
                tradeRecord.leg1_fee = trades[0].feeAmount;
                tradeRecord.leg1_status = 'completed';
                tradeRecord.leg1_executed_at = new Date(trades[0].executedAt || Date.now());
            }
            
            if (trades[1]) {
                tradeRecord.leg2_order_id = trades[1].orderId;
                tradeRecord.leg2_pair = trades[1].pair;
                tradeRecord.leg2_side = trades[1].side;
                tradeRecord.leg2_amount = trades[1].baseAmount || trades[1].quoteAmount;
                tradeRecord.leg2_price = trades[1].price;
                tradeRecord.leg2_fee = trades[1].feeAmount;
                tradeRecord.leg2_status = 'completed';
                tradeRecord.leg2_executed_at = new Date(trades[1].executedAt || Date.now());
            }
            
            if (trades[2]) {
                tradeRecord.leg3_order_id = trades[2].orderId;
                tradeRecord.leg3_pair = trades[2].pair;
                tradeRecord.leg3_side = trades[2].side;
                tradeRecord.leg3_amount = trades[2].baseAmount || trades[2].quoteAmount;
                tradeRecord.leg3_price = trades[2].price;
                tradeRecord.leg3_fee = trades[2].feeAmount;
                tradeRecord.leg3_status = 'completed';
                tradeRecord.leg3_executed_at = new Date(trades[2].executedAt || Date.now());
            }
        }

        // Insert trade record into database
        const insertQuery = `
            INSERT INTO triangular_trades (
                user_id, trade_id, exchange, path_id, path_sequence, opportunity_data,
                initial_amount, currency_start, execution_status, execution_type, dry_run,
                expected_profit_zar, expected_profit_percent, actual_profit_zar, actual_profit_percent,
                total_fees_paid, risk_assessment, max_slippage_allowed,
                scan_started_at, execution_started_at, execution_completed_at, total_execution_time_ms,
                error_message, user_agent, ip_address,
                leg1_order_id, leg1_pair, leg1_side, leg1_amount, leg1_price, leg1_fee, leg1_status, leg1_executed_at,
                leg2_order_id, leg2_pair, leg2_side, leg2_amount, leg2_price, leg2_fee, leg2_status, leg2_executed_at,
                leg3_order_id, leg3_pair, leg3_side, leg3_amount, leg3_price, leg3_fee, leg3_status, leg3_executed_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 
                $19, $20, $21, $22, $23, $24, $25,
                $26, $27, $28, $29, $30, $31, $32, $33,
                $34, $35, $36, $37, $38, $39, $40, $41,
                $42, $43, $44, $45, $46, $47, $48, $49
            ) RETURNING id, trade_id
        `;

        const values = [
            tradeRecord.user_id, tradeRecord.trade_id, tradeRecord.exchange, tradeRecord.path_id, 
            tradeRecord.path_sequence, tradeRecord.opportunity_data, tradeRecord.initial_amount, 
            tradeRecord.currency_start, tradeRecord.execution_status, tradeRecord.execution_type, 
            tradeRecord.dry_run, tradeRecord.expected_profit_zar, tradeRecord.expected_profit_percent,
            tradeRecord.actual_profit_zar, tradeRecord.actual_profit_percent, tradeRecord.total_fees_paid,
            tradeRecord.risk_assessment, tradeRecord.max_slippage_allowed, tradeRecord.scan_started_at,
            tradeRecord.execution_started_at, tradeRecord.execution_completed_at, tradeRecord.total_execution_time_ms,
            tradeRecord.error_message, tradeRecord.user_agent, tradeRecord.ip_address,
            tradeRecord.leg1_order_id, tradeRecord.leg1_pair, tradeRecord.leg1_side, tradeRecord.leg1_amount,
            tradeRecord.leg1_price, tradeRecord.leg1_fee, tradeRecord.leg1_status, tradeRecord.leg1_executed_at,
            tradeRecord.leg2_order_id, tradeRecord.leg2_pair, tradeRecord.leg2_side, tradeRecord.leg2_amount,
            tradeRecord.leg2_price, tradeRecord.leg2_fee, tradeRecord.leg2_status, tradeRecord.leg2_executed_at,
            tradeRecord.leg3_order_id, tradeRecord.leg3_pair, tradeRecord.leg3_side, tradeRecord.leg3_amount,
            tradeRecord.leg3_price, tradeRecord.leg3_fee, tradeRecord.leg3_status, tradeRecord.leg3_executed_at
        ];

        const result = await query(insertQuery, values);
        
        systemLogger.trading('Triangular trade logged to database', {
            userId: userId,
            tradeId: tradeRecord.trade_id,
            dbId: result.rows[0].id,
            status: tradeRecord.execution_status,
            profitZAR: tradeRecord.actual_profit_zar
        });

        return {
            success: true,
            tradeId: tradeRecord.trade_id,
            dbId: result.rows[0].id
        };

    } catch (error) {
        systemLogger.error('Failed to log triangular trade to database', {
            userId: userId,
            error: error.message,
            stack: error.stack
        });
        
        // Don't throw - logging failure shouldn't break trade execution
        return {
            success: false,
            error: error.message
        };
    }
}

// Get recent triangular trades for user
async function getRecentTriangularTrades(userId, limit = 50) {
    try {
        const tradesQuery = `
            SELECT 
                id, trade_id, exchange, path_id, path_sequence,
                execution_status, actual_profit_zar, actual_profit_percent,
                total_execution_time_ms, created_at, execution_completed_at,
                error_message, dry_run
            FROM triangular_trades 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT $2
        `;

        const result = await query(tradesQuery, [userId, limit]);
        return result.rows;

    } catch (error) {
        systemLogger.error('Failed to fetch recent triangular trades', {
            userId: userId,
            error: error.message
        });
        return [];
    }
}

// ============================================
// VALR TRIANGULAR ARBITRAGE ENDPOINTS
// ============================================
// Specific endpoints for triangular arbitrage functionality

// POST /api/v1/trading/valr/triangular/test-connection
// Test VALR API connection for triangular trading
router.post('/valr/triangular/test-connection', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;

        systemLogger.trading('VALR triangular connection test initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Validate VALR API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('VALR API credentials required', 400, 'VALR_CREDENTIALS_REQUIRED');
        }

        const exchange_api_key = apiKey;
        const exchange_api_secret = apiSecret;

        // Test API connection by fetching balance
        const balanceData = await makeVALRRequest(
            VALR_CONFIG.endpoints.balance,
            'GET',
            null,
            exchange_api_key,
            exchange_api_secret
        );

        // Check if we have access to triangular pairs
        const requiredPairs = ['LINKZAR', 'LINKUSDT', 'USDTZAR', 'ETHZAR', 'ETHUSDT'];
        const pairsData = await makeVALRRequest(
            VALR_CONFIG.endpoints.pairs,
            'GET',
            null,
            exchange_api_key,
            exchange_api_secret
        );

        const availablePairs = pairsData.map(p => p.currencyPair);
        const triangularPairsAvailable = requiredPairs.every(pair => availablePairs.includes(pair));

        systemLogger.trading('VALR triangular connection test successful', {
            userId: req.user.id,
            balanceCount: balanceData.length,
            triangularPairsAvailable
        });

        res.json({
            success: true,
            data: {
                connected: true,
                balanceAccess: true,
                triangularPairsAvailable,
                totalPairs: availablePairs.length,
                requiredPairsFound: requiredPairs.filter(p => availablePairs.includes(p)),
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        systemLogger.error('VALR triangular connection test failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================
// ENHANCED TRIANGULAR PROFIT CALCULATION ENGINE
// ============================================
// Sophisticated profit calculation with VALR fees, slippage, and order book depth analysis

/**
 * Calculate triangular arbitrage profit with comprehensive analysis
 * @param {Object} path - Triangular path configuration 
 * @param {Object} orderBooks - Order book data for all pairs
 * @param {number} amount - Starting amount in ZAR
 * @param {Object} options - Calculation options
 * @returns {Object} Detailed profit analysis
 */
function calculateTriangularProfitAdvanced(path, orderBooks, amount = 1000, options = {}) {
    const {
        slippageBuffer = 0.1, // 0.1% slippage buffer
        minOrderSize = 50,    // Minimum R50 order size
        maxOrderSize = 10000, // Maximum R10,000 order size
        depthAnalysis = true   // Whether to analyze order book depth
    } = options;

    try {
        // VALR fee structure
        const MAKER_FEE = 0.001;  // 0.1% maker fee
        const TAKER_FEE = 0.001;  // 0.1% taker fee (we'll use taker for immediate execution)
        
        // Validate input amount
        if (amount < minOrderSize || amount > maxOrderSize) {
            return {
                success: false,
                error: `Amount must be between R${minOrderSize} and R${maxOrderSize}`,
                pathId: path.id
            };
        }

        const result = {
            pathId: path.id,
            sequence: path.sequence,
            startAmount: amount,
            steps: [],
            fees: {
                total: 0,
                breakdown: []
            },
            slippage: {
                estimated: 0,
                breakdown: []
            },
            orderBookDepth: [],
            success: true
        };

        let currentAmount = amount;
        let totalFees = 0;
        let totalSlippage = 0;

        // Execute each step of the triangular path
        for (let i = 0; i < path.steps.length; i++) {
            const step = path.steps[i];
            const orderBook = orderBooks[step.pair];
            
            if (!orderBook || !orderBook.Asks || !orderBook.Bids) {
                return {
                    success: false,
                    error: `Missing order book data for ${step.pair}`,
                    pathId: path.id
                };
            }

            const stepResult = {
                step: i + 1,
                pair: step.pair,
                side: step.side,
                inputAmount: currentAmount
            };

            if (step.side === 'buy') {
                // Buying: use ask prices (we pay the ask)
                const asks = orderBook.Asks;
                if (!asks || asks.length === 0) {
                    return {
                        success: false,
                        error: `No ask orders available for ${step.pair}`,
                        pathId: path.id
                    };
                }

                const bestAsk = parseFloat(asks[0].price);
                const askSize = parseFloat(asks[0].quantity);
                
                // Calculate how much we can buy with current amount
                const grossQuantity = currentAmount / bestAsk;
                
                // Apply trading fee
                const fee = currentAmount * TAKER_FEE;
                const netAmountAfterFee = currentAmount - fee;
                const netQuantity = netAmountAfterFee / bestAsk;
                
                // Estimate slippage based on order book depth
                let slippagePercent = 0;
                if (depthAnalysis && askSize < netQuantity) {
                    // Need to eat into deeper order book levels
                    slippagePercent = slippageBuffer;
                    const slippageAmount = netQuantity * (slippagePercent / 100);
                    stepResult.slippageWarning = `Insufficient liquidity: need ${netQuantity.toFixed(4)}, available ${askSize.toFixed(4)}`;
                    totalSlippage += slippageAmount;
                }
                
                const finalQuantity = netQuantity * (1 - slippagePercent / 100);
                
                stepResult.price = bestAsk;
                stepResult.grossQuantity = grossQuantity;
                stepResult.fee = fee;
                stepResult.netQuantity = finalQuantity;
                stepResult.slippage = slippagePercent;
                stepResult.availableLiquidity = askSize;
                stepResult.outputAmount = finalQuantity;
                
                currentAmount = finalQuantity;
                totalFees += fee;
                
                // Order book depth analysis
                if (depthAnalysis) {
                    const depthInfo = analyzeOrderBookDepth(asks, netAmountAfterFee, 'ask');
                    result.orderBookDepth.push({
                        pair: step.pair,
                        side: 'ask',
                        ...depthInfo
                    });
                }

            } else {
                // Selling: use bid prices (we receive the bid)
                const bids = orderBook.Bids;
                if (!bids || bids.length === 0) {
                    return {
                        success: false,
                        error: `No bid orders available for ${step.pair}`,
                        pathId: path.id
                    };
                }

                const bestBid = parseFloat(bids[0].price);
                const bidSize = parseFloat(bids[0].quantity);
                
                // Calculate ZAR amount we'll receive
                const grossAmount = currentAmount * bestBid;
                
                // Apply trading fee
                const fee = grossAmount * TAKER_FEE;
                const netAmount = grossAmount - fee;
                
                // Estimate slippage based on order book depth
                let slippagePercent = 0;
                if (depthAnalysis && bidSize < currentAmount) {
                    // Need to sell into deeper order book levels
                    slippagePercent = slippageBuffer;
                    const slippageAmount = netAmount * (slippagePercent / 100);
                    stepResult.slippageWarning = `Insufficient liquidity: selling ${currentAmount.toFixed(4)}, available ${bidSize.toFixed(4)}`;
                    totalSlippage += slippageAmount;
                }
                
                const finalAmount = netAmount * (1 - slippagePercent / 100);
                
                stepResult.price = bestBid;
                stepResult.grossAmount = grossAmount;
                stepResult.fee = fee;
                stepResult.netAmount = finalAmount;
                stepResult.slippage = slippagePercent;
                stepResult.availableLiquidity = bidSize;
                stepResult.outputAmount = finalAmount;
                
                currentAmount = finalAmount;
                totalFees += fee;
                
                // Order book depth analysis
                if (depthAnalysis) {
                    const depthInfo = analyzeOrderBookDepth(bids, currentAmount, 'bid');
                    result.orderBookDepth.push({
                        pair: step.pair,
                        side: 'bid',
                        ...depthInfo
                    });
                }
            }

            result.steps.push(stepResult);
            result.fees.breakdown.push({
                step: i + 1,
                pair: step.pair,
                fee: stepResult.fee,
                feePercent: TAKER_FEE * 100
            });
        }

        // Final profit calculation
        const grossProfit = currentAmount - amount;
        const netProfit = grossProfit; // Fees already deducted in steps
        const profitPercent = (netProfit / amount) * 100;
        
        // Risk assessment
        const riskFactors = [];
        if (totalSlippage > 0) riskFactors.push('slippage_risk');
        if (totalFees > amount * 0.005) riskFactors.push('high_fees');
        if (result.orderBookDepth.some(d => d.liquidityRisk)) riskFactors.push('liquidity_risk');
        
        // Minimum profit threshold (must exceed total costs by meaningful margin)
        const minProfitThreshold = amount * 0.008; // 0.8% minimum for VALR
        const profitable = netProfit > minProfitThreshold;
        
        // Update result with final calculations
        result.endAmount = currentAmount;
        result.grossProfit = grossProfit;
        result.netProfit = netProfit;
        result.netProfitPercent = profitPercent;
        result.profitable = profitable;
        result.fees.total = totalFees;
        result.fees.percentage = (totalFees / amount) * 100;
        result.slippage.estimated = totalSlippage;
        result.slippage.percentage = (totalSlippage / amount) * 100;
        result.riskFactors = riskFactors;
        result.riskLevel = getRiskLevel(riskFactors);
        result.minProfitThreshold = minProfitThreshold;
        result.timestamp = new Date().toISOString();
        
        // Execution recommendation
        if (profitable && riskFactors.length === 0) {
            result.recommendation = 'EXECUTE';
        } else if (profitable && riskFactors.length <= 1) {
            result.recommendation = 'CAUTIOUS';
        } else {
            result.recommendation = 'AVOID';
        }

        return result;

    } catch (error) {
        return {
            success: false,
            error: error.message,
            pathId: path.id
        };
    }
}

/**
 * Analyze order book depth for liquidity assessment
 */
function analyzeOrderBookDepth(orders, requiredAmount, side) {
    let cumulativeAmount = 0;
    let cumulativeQuantity = 0;
    let levelsNeeded = 0;
    let averagePrice = 0;
    let priceImpact = 0;
    
    if (!orders || orders.length === 0) {
        return {
            liquidityRisk: true,
            levelsNeeded: 0,
            priceImpact: 100,
            message: 'No orders available'
        };
    }
    
    const firstPrice = parseFloat(orders[0].price);
    
    for (let i = 0; i < orders.length && cumulativeAmount < requiredAmount; i++) {
        const order = orders[i];
        const price = parseFloat(order.price);
        const quantity = parseFloat(order.quantity);
        const orderAmount = side === 'ask' ? quantity * price : quantity;
        
        cumulativeAmount += orderAmount;
        cumulativeQuantity += quantity;
        levelsNeeded++;
        
        // Calculate weighted average price
        averagePrice = cumulativeAmount / cumulativeQuantity;
        
        // Calculate price impact
        priceImpact = Math.abs((price - firstPrice) / firstPrice) * 100;
    }
    
    const liquidityRisk = levelsNeeded > 3 || priceImpact > 1.0; // Risk if need >3 levels or >1% impact
    
    return {
        liquidityRisk,
        levelsNeeded,
        priceImpact: priceImpact.toFixed(4),
        averagePrice: averagePrice.toFixed(8),
        cumulativeAmount: cumulativeAmount.toFixed(2),
        message: liquidityRisk ? 'Liquidity constraints detected' : 'Sufficient liquidity'
    };
}

/**
 * Determine risk level based on risk factors
 */
function getRiskLevel(riskFactors) {
    if (riskFactors.length === 0) return 'LOW';
    if (riskFactors.length <= 1) return 'MEDIUM';
    return 'HIGH';
}

// ============================================
// 3-LEG ATOMIC TRADE EXECUTION ENGINE
// ============================================
// Execute triangular arbitrage with atomic rollback on failure

/**
 * Execute a 3-leg triangular arbitrage trade atomically
 * @param {Object} opportunity - Triangular opportunity with execution details
 * @param {string} apiKey - VALR API key
 * @param {string} apiSecret - VALR API secret
 * @param {Object} options - Execution options
 * @returns {Object} Execution result with trade details
 */
async function executeTriangularTradeAtomic(opportunity, apiKey, apiSecret, options = {}) {
    const {
        maxSlippage = 0.5,      // Maximum allowed slippage %
        timeoutMs = 30000,      // 30 second timeout per trade
        dryRun = false          // Dry run mode for testing
    } = options;
    
    const executionId = Math.random().toString(36).substring(7);
    const startTime = Date.now();
    
    console.log(`🚀 Starting atomic triangular execution: ${executionId}`);
    console.log(`📊 Path: ${opportunity.pathId} | Amount: R${opportunity.startAmount}`);
    
    const result = {
        executionId,
        pathId: opportunity.pathId,
        sequence: opportunity.sequence,
        startAmount: opportunity.startAmount,
        startTime: new Date(startTime).toISOString(),
        success: false,
        legs: [],
        rollbacks: [],
        error: null,
        performance: {
            totalTime: 0,
            legTimes: []
        }
    };
    
    try {
        // Pre-execution validation
        if (!opportunity.steps || opportunity.steps.length !== 3) {
            throw new Error('Invalid triangular path: must have exactly 3 steps');
        }
        
        if (!opportunity.profitable || opportunity.recommendation === 'AVOID') {
            throw new Error(`Opportunity not suitable for execution: ${opportunity.recommendation}`);
        }
        
        // Validate balances before execution
        const balanceCheck = await validateBalancesForExecution(opportunity, apiKey, apiSecret);
        if (!balanceCheck.sufficient) {
            throw new Error(`Insufficient balance: ${balanceCheck.message}`);
        }
        
        console.log(`✅ Pre-execution validation passed`);
        
        let currentAmount = opportunity.startAmount;
        let currentCurrency = 'ZAR'; // Assuming ZAR-based arbitrage
        
        // Execute each leg sequentially with rollback capability
        for (let i = 0; i < opportunity.steps.length; i++) {
            const step = opportunity.steps[i];
            const legStartTime = Date.now();
            
            console.log(`🔄 Executing leg ${i + 1}/3: ${step.pair} (${step.side})`);
            
            try {
                // Execute the trade leg
                const legResult = await executeTradeLeg(
                    step, 
                    currentAmount, 
                    currentCurrency,
                    apiKey, 
                    apiSecret,
                    { 
                        maxSlippage, 
                        timeoutMs, 
                        dryRun,
                        executionId 
                    }
                );
                
                const legTime = Date.now() - legStartTime;
                result.performance.legTimes.push(legTime);
                
                // Update current state
                currentAmount = legResult.outputAmount;
                currentCurrency = legResult.outputCurrency;
                
                // Store leg details
                result.legs.push({
                    legNumber: i + 1,
                    step: step,
                    inputAmount: legResult.inputAmount,
                    outputAmount: legResult.outputAmount,
                    price: legResult.price,
                    fee: legResult.fee,
                    orderId: legResult.orderId,
                    slippage: legResult.slippage,
                    executionTime: legTime,
                    success: true
                });
                
                console.log(`✅ Leg ${i + 1} completed: ${currentAmount.toFixed(4)} ${currentCurrency}`);
                
            } catch (legError) {
                console.error(`❌ Leg ${i + 1} failed:`, legError.message);
                
                // Record failed leg
                result.legs.push({
                    legNumber: i + 1,
                    step: step,
                    error: legError.message,
                    executionTime: Date.now() - legStartTime,
                    success: false
                });
                
                // Initiate rollback for all completed legs
                if (i > 0 && !dryRun) {
                    console.log(`🔄 Initiating rollback for ${i} completed legs...`);
                    await rollbackCompletedLegs(result.legs.slice(0, i), apiKey, apiSecret);
                }
                
                throw new Error(`Leg ${i + 1} execution failed: ${legError.message}`);
            }
        }
        
        // Calculate final results
        const finalAmount = currentAmount;
        const grossProfit = finalAmount - opportunity.startAmount;
        const netProfit = grossProfit; // Fees already deducted in legs
        const netProfitPercent = (netProfit / opportunity.startAmount) * 100;
        const totalTime = Date.now() - startTime;
        
        result.success = true;
        result.endAmount = finalAmount;
        result.grossProfit = grossProfit;
        result.netProfit = netProfit;
        result.netProfitPercent = netProfitPercent;
        result.performance.totalTime = totalTime;
        result.endTime = new Date().toISOString();
        
        console.log(`🎉 Triangular execution completed successfully!`);
        console.log(`💰 Net profit: R${netProfit.toFixed(2)} (${netProfitPercent.toFixed(2)}%)`);
        console.log(`⏱️ Total execution time: ${totalTime}ms`);
        
        return result;
        
    } catch (error) {
        const totalTime = Date.now() - startTime;
        result.error = error.message;
        result.performance.totalTime = totalTime;
        result.endTime = new Date().toISOString();
        
        console.error(`❌ Triangular execution failed: ${error.message}`);
        
        return result;
    }
}

/**
 * Execute a single trade leg
 */
async function executeTradeLeg(step, inputAmount, inputCurrency, apiKey, apiSecret, options) {
    const { maxSlippage, timeoutMs, dryRun, executionId } = options;
    
    if (dryRun) {
        // Simulate trade execution for testing
        const simulatedPrice = step.price * (1 + (Math.random() - 0.5) * 0.001); // ±0.05% price variance
        const simulatedFee = inputAmount * 0.001; // 0.1% fee
        const simulatedSlippage = Math.random() * 0.1; // Up to 0.1% slippage
        
        let outputAmount, outputCurrency;
        
        if (step.side === 'buy') {
            outputAmount = (inputAmount - simulatedFee) / simulatedPrice;
            outputCurrency = step.pair.replace('ZAR', '').replace('USDT', ''); // Extract base currency
        } else {
            outputAmount = inputAmount * simulatedPrice - simulatedFee;
            outputCurrency = step.pair.includes('ZAR') ? 'ZAR' : 'USDT';
        }
        
        return {
            inputAmount,
            outputAmount,
            outputCurrency,
            price: simulatedPrice,
            fee: simulatedFee,
            slippage: simulatedSlippage,
            orderId: `SIM_${executionId}_${step.pair}_${Date.now()}`,
            simulation: true
        };
    }
    
    // Real trade execution
    try {
        // Get fresh order book to check for slippage
        const orderBook = await makeVALRRequest(
            `/v1/marketdata/${step.pair}/orderbook`,
            'GET',
            null,
            apiKey,
            apiSecret
        );
        
        // Check for excessive slippage
        const currentPrice = step.side === 'buy' 
            ? parseFloat(orderBook.Asks[0]?.price || 0)
            : parseFloat(orderBook.Bids[0]?.price || 0);
            
        const priceChange = Math.abs((currentPrice - step.price) / step.price * 100);
        
        if (priceChange > maxSlippage) {
            throw new Error(`Excessive slippage: ${priceChange.toFixed(2)}% > ${maxSlippage}%`);
        }
        
        // Prepare order parameters
        let orderParams;
        
        if (step.side === 'buy') {
            // Market buy order
            orderParams = {
                side: 'BUY',
                quantity: (inputAmount / currentPrice).toFixed(8), // Quantity in base currency
                pair: step.pair,
                type: 'MARKET'
            };
        } else {
            // Market sell order  
            orderParams = {
                side: 'SELL',
                quantity: inputAmount.toFixed(8), // Quantity in base currency
                pair: step.pair,
                type: 'MARKET'
            };
        }
        
        console.log(`📝 Placing ${step.side} order:`, orderParams);
        
        // Place the order
        const orderResponse = await makeVALRRequest(
            '/v1/orders/market',
            'POST',
            orderParams,
            apiKey,
            apiSecret
        );
        
        // Wait for order to be filled (with timeout)
        const orderResult = await waitForOrderCompletion(
            orderResponse.id, 
            apiKey, 
            apiSecret, 
            timeoutMs
        );
        
        return {
            inputAmount,
            outputAmount: parseFloat(orderResult.executedQuantity),
            outputCurrency: orderResult.outputCurrency,
            price: parseFloat(orderResult.averagePrice),
            fee: parseFloat(orderResult.feeAmount),
            slippage: priceChange,
            orderId: orderResult.id
        };
        
    } catch (error) {
        throw new Error(`Trade leg execution failed: ${error.message}`);
    }
}

/**
 * Validate account balances before execution
 */
async function validateBalancesForExecution(opportunity, apiKey, apiSecret) {
    try {
        const balances = await makeVALRRequest('/v1/account/balances', 'GET', null, apiKey, apiSecret);
        
        // Check ZAR balance for starting amount
        const zarBalance = balances.find(b => b.currency === 'ZAR');
        const availableZAR = parseFloat(zarBalance?.available || 0);
        
        if (availableZAR < opportunity.startAmount) {
            return {
                sufficient: false,
                message: `Insufficient ZAR balance: need R${opportunity.startAmount}, have R${availableZAR.toFixed(2)}`
            };
        }
        
        // Add buffer for fees (5% extra)
        const requiredAmount = opportunity.startAmount * 1.05;
        if (availableZAR < requiredAmount) {
            return {
                sufficient: false,
                message: `Insufficient ZAR balance with fee buffer: need R${requiredAmount.toFixed(2)}, have R${availableZAR.toFixed(2)}`
            };
        }
        
        return {
            sufficient: true,
            availableZAR: availableZAR,
            message: 'Balance validation passed'
        };
        
    } catch (error) {
        return {
            sufficient: false,
            message: `Balance check failed: ${error.message}`
        };
    }
}

/**
 * Wait for order completion with timeout
 */
async function waitForOrderCompletion(orderId, apiKey, apiSecret, timeoutMs) {
    const startTime = Date.now();
    const pollInterval = 1000; // Poll every 1 second
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const orderStatus = await makeVALRRequest(
                `/v1/orders/${orderId}`,
                'GET',
                null,
                apiKey,
                apiSecret
            );
            
            if (orderStatus.orderStatusType === 'Filled') {
                return orderStatus;
            }
            
            if (orderStatus.orderStatusType === 'Failed' || orderStatus.orderStatusType === 'Cancelled') {
                throw new Error(`Order ${orderId} ${orderStatus.orderStatusType.toLowerCase()}`);
            }
            
            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            
        } catch (error) {
            throw new Error(`Order status check failed: ${error.message}`);
        }
    }
    
    throw new Error(`Order ${orderId} timeout after ${timeoutMs}ms`);
}

/**
 * Rollback completed legs by placing reverse orders
 */
async function rollbackCompletedLegs(completedLegs, apiKey, apiSecret) {
    console.log(`🔄 Starting rollback for ${completedLegs.length} completed legs...`);
    
    const rollbackResults = [];
    
    // Rollback in reverse order
    for (let i = completedLegs.length - 1; i >= 0; i--) {
        const leg = completedLegs[i];
        
        try {
            console.log(`🔄 Rolling back leg ${leg.legNumber}: ${leg.step.pair}`);
            
            // Create reverse order
            const reverseOrderParams = {
                side: leg.step.side === 'buy' ? 'SELL' : 'BUY',
                quantity: leg.outputAmount.toFixed(8),
                pair: leg.step.pair,
                type: 'MARKET'
            };
            
            const rollbackOrder = await makeVALRRequest(
                '/v1/orders/market',
                'POST',
                reverseOrderParams,
                apiKey,
                apiSecret
            );
            
            rollbackResults.push({
                legNumber: leg.legNumber,
                rollbackOrderId: rollbackOrder.id,
                success: true
            });
            
            console.log(`✅ Rollback order placed for leg ${leg.legNumber}: ${rollbackOrder.id}`);
            
        } catch (rollbackError) {
            console.error(`❌ Rollback failed for leg ${leg.legNumber}:`, rollbackError.message);
            rollbackResults.push({
                legNumber: leg.legNumber,
                error: rollbackError.message,
                success: false
            });
        }
    }
    
    return rollbackResults;
}

// POST /api/v1/trading/valr/triangular/scan
// Scan for triangular arbitrage opportunities with live prices
router.post('/valr/triangular/scan', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { paths = 'all', apiKey, apiSecret } = req.body; // Can specify which path sets to scan
        
        systemLogger.trading('VALR triangular scan initiated', {
            userId: req.user.id,
            paths,
            timestamp: new Date().toISOString()
        });

        // Validate VALR API credentials
        if (!apiKey || !apiSecret) {
            throw new APIError('VALR API credentials required', 400, 'VALR_CREDENTIALS_REQUIRED');
        }

        // Define all triangular path sets (80 PATHS - 20 sets of 4 paths each, excludes BTC)
        const allPathSets = {
            SET_1_ETH_FOCUS: [
                { id: 'ZAR_ETH_USDT_ZAR', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], sequence: 'ZAR → ETH → USDT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'USDT_ETH_ZAR_USDT', pairs: ['ETHUSDT', 'ETHZAR', 'USDTZAR'], sequence: 'USDT → ETH → ZAR → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETHUSDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_2_XRP_FOCUS: [
                { id: 'ZAR_XRP_USDT_ZAR', pairs: ['XRPZAR', 'XRPUSDT', 'USDTZAR'], sequence: 'ZAR → XRP → USDT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'USDT_XRP_ZAR_USDT', pairs: ['XRPUSDT', 'XRPZAR', 'USDTZAR'], sequence: 'USDT → XRP → ZAR → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRPUSDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_3_SOL_FOCUS: [
                { id: 'ZAR_SOL_USDT_ZAR', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], sequence: 'ZAR → SOL → USDT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'USDT_SOL_ZAR_USDT', pairs: ['SOLUSDT', 'SOLZAR', 'USDTZAR'], sequence: 'USDT → SOL → ZAR → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SOL_USDT', pairs: ['USDTZAR', 'SOLZAR', 'SOLUSDT'], sequence: 'USDT → ZAR → SOL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] }
            ],
            SET_4_BNB_FOCUS: [
                { id: 'ZAR_BNB_USDT_ZAR', pairs: ['BNBZAR', 'BNBUSDT', 'USDTZAR'], sequence: 'ZAR → BNB → USDT → ZAR', steps: [{ pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BNB_ZAR', pairs: ['USDTZAR', 'BNBUSDT', 'BNBZAR'], sequence: 'ZAR → USDT → BNB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }] },
                { id: 'USDT_BNB_ZAR_USDT', pairs: ['BNBUSDT', 'BNBZAR', 'USDTZAR'], sequence: 'USDT → BNB → ZAR → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BNB_USDT', pairs: ['USDTZAR', 'BNBZAR', 'BNBUSDT'], sequence: 'USDT → ZAR → BNB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_5_SHIB_FOCUS: [
                { id: 'ZAR_SHIB_USDT_ZAR', pairs: ['SHIBZAR', 'SHIBUSDT', 'USDTZAR'], sequence: 'ZAR → SHIB → USDT → ZAR', steps: [{ pair: 'SHIBZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SHIB_ZAR', pairs: ['USDTZAR', 'SHIBUSDT', 'SHIBZAR'], sequence: 'ZAR → USDT → SHIB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBZAR', side: 'sell' }] },
                { id: 'USDT_SHIB_ZAR_USDT', pairs: ['SHIBUSDT', 'SHIBZAR', 'USDTZAR'], sequence: 'USDT → SHIB → ZAR → USDT', steps: [{ pair: 'SHIBUSDT', side: 'buy' }, { pair: 'SHIBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SHIB_USDT', pairs: ['USDTZAR', 'SHIBZAR', 'SHIBUSDT'], sequence: 'USDT → ZAR → SHIB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SHIBZAR', side: 'buy' }, { pair: 'SHIBUSDT', side: 'sell' }] }
            ],
            SET_6_AVAX_FOCUS: [
                { id: 'ZAR_AVAX_USDT_ZAR', pairs: ['AVAXZAR', 'AVAXUSDT', 'USDTZAR'], sequence: 'ZAR → AVAX → USDT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AVAX_ZAR', pairs: ['USDTZAR', 'AVAXUSDT', 'AVAXZAR'], sequence: 'ZAR → USDT → AVAX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'USDT_AVAX_ZAR_USDT', pairs: ['AVAXUSDT', 'AVAXZAR', 'USDTZAR'], sequence: 'USDT → AVAX → ZAR → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AVAX_USDT', pairs: ['USDTZAR', 'AVAXZAR', 'AVAXUSDT'], sequence: 'USDT → ZAR → AVAX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_7_DOGE_FOCUS: [
                { id: 'ZAR_DOGE_USDT_ZAR', pairs: ['DOGEZAR', 'DOGEUSDT', 'USDTZAR'], sequence: 'ZAR → DOGE → USDT → ZAR', steps: [{ pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DOGE_ZAR', pairs: ['USDTZAR', 'DOGEUSDT', 'DOGEZAR'], sequence: 'ZAR → USDT → DOGE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }] },
                { id: 'USDT_DOGE_ZAR_USDT', pairs: ['DOGEUSDT', 'DOGEZAR', 'USDTZAR'], sequence: 'USDT → DOGE → ZAR → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DOGE_USDT', pairs: ['USDTZAR', 'DOGEZAR', 'DOGEUSDT'], sequence: 'USDT → ZAR → DOGE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }] }
            ],
            SET_8_TRX_FOCUS: [
                { id: 'ZAR_TRX_USDT_ZAR', pairs: ['TRXZAR', 'TRXUSDT', 'USDTZAR'], sequence: 'ZAR → TRX → USDT → ZAR', steps: [{ pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_TRX_ZAR', pairs: ['USDTZAR', 'TRXUSDT', 'TRXZAR'], sequence: 'ZAR → USDT → TRX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }] },
                { id: 'USDT_TRX_ZAR_USDT', pairs: ['TRXUSDT', 'TRXZAR', 'USDTZAR'], sequence: 'USDT → TRX → ZAR → USDT', steps: [{ pair: 'TRXUSDT', side: 'buy' }, { pair: 'TRXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_TRX_USDT', pairs: ['USDTZAR', 'TRXZAR', 'TRXUSDT'], sequence: 'USDT → ZAR → TRX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'TRXZAR', side: 'buy' }, { pair: 'TRXUSDT', side: 'sell' }] }
            ],
            SET_9_LTC_FOCUS: [
                { id: 'ZAR_LTC_USDT_ZAR', pairs: ['LTCZAR', 'LTCUSDT', 'USDTZAR'], sequence: 'ZAR → LTC → USDT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LTC_ZAR', pairs: ['USDTZAR', 'LTCUSDT', 'LTCZAR'], sequence: 'ZAR → USDT → LTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'USDT_LTC_ZAR_USDT', pairs: ['LTCUSDT', 'LTCZAR', 'USDTZAR'], sequence: 'USDT → LTC → ZAR → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LTC_USDT', pairs: ['USDTZAR', 'LTCZAR', 'LTCUSDT'], sequence: 'USDT → ZAR → LTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            SET_10_RLUSD_FOCUS: [
                { id: 'ZAR_RLUSD_USDT_ZAR', pairs: ['RLUSDZAR', 'RLUSDUSDT', 'USDTZAR'], sequence: 'ZAR → RLUSD → USDT → ZAR', steps: [{ pair: 'RLUSDZAR', side: 'buy' }, { pair: 'RLUSDUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_RLUSD_ZAR', pairs: ['USDTZAR', 'RLUSDUSDT', 'RLUSDZAR'], sequence: 'ZAR → USDT → RLUSD → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'RLUSDUSDT', side: 'buy' }, { pair: 'RLUSDZAR', side: 'sell' }] },
                { id: 'USDT_RLUSD_ZAR_USDT', pairs: ['RLUSDUSDT', 'RLUSDZAR', 'USDTZAR'], sequence: 'USDT → RLUSD → ZAR → USDT', steps: [{ pair: 'RLUSDUSDT', side: 'buy' }, { pair: 'RLUSDZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_RLUSD_USDT', pairs: ['USDTZAR', 'RLUSDZAR', 'RLUSDUSDT'], sequence: 'USDT → ZAR → RLUSD → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'RLUSDZAR', side: 'buy' }, { pair: 'RLUSDUSDT', side: 'sell' }] }
            ],
            SET_11_LINK_FOCUS: [
                { id: 'ZAR_LINK_USDT_ZAR', pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'], sequence: 'ZAR → LINK → USDT → ZAR', steps: [{ pair: 'LINKZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LINK_ZAR', pairs: ['USDTZAR', 'LINKUSDT', 'LINKZAR'], sequence: 'ZAR → USDT → LINK → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }] },
                { id: 'USDT_LINK_ZAR_USDT', pairs: ['LINKUSDT', 'LINKZAR', 'USDTZAR'], sequence: 'USDT → LINK → ZAR → USDT', steps: [{ pair: 'LINKUSDT', side: 'buy' }, { pair: 'LINKZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LINK_USDT', pairs: ['USDTZAR', 'LINKZAR', 'LINKUSDT'], sequence: 'USDT → ZAR → LINK → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LINKZAR', side: 'buy' }, { pair: 'LINKUSDT', side: 'sell' }] }
            ],
            SET_12_XLM_FOCUS: [
                { id: 'ZAR_XLM_USDT_ZAR', pairs: ['XLMZAR', 'XLMUSDT', 'USDTZAR'], sequence: 'ZAR → XLM → USDT → ZAR', steps: [{ pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XLM_ZAR', pairs: ['USDTZAR', 'XLMUSDT', 'XLMZAR'], sequence: 'ZAR → USDT → XLM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }] },
                { id: 'USDT_XLM_ZAR_USDT', pairs: ['XLMUSDT', 'XLMZAR', 'USDTZAR'], sequence: 'USDT → XLM → ZAR → USDT', steps: [{ pair: 'XLMUSDT', side: 'buy' }, { pair: 'XLMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XLM_USDT', pairs: ['USDTZAR', 'XLMZAR', 'XLMUSDT'], sequence: 'USDT → ZAR → XLM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XLMZAR', side: 'buy' }, { pair: 'XLMUSDT', side: 'sell' }] }
            ],
            SET_13_MATIC_FOCUS: [
                { id: 'ZAR_MATIC_USDT_ZAR', pairs: ['MATICZAR', 'MATICUSDT', 'USDTZAR'], sequence: 'ZAR → MATIC → USDT → ZAR', steps: [{ pair: 'MATICZAR', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_MATIC_ZAR', pairs: ['USDTZAR', 'MATICUSDT', 'MATICZAR'], sequence: 'ZAR → USDT → MATIC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICZAR', side: 'sell' }] },
                { id: 'USDT_MATIC_ZAR_USDT', pairs: ['MATICUSDT', 'MATICZAR', 'USDTZAR'], sequence: 'USDT → MATIC → ZAR → USDT', steps: [{ pair: 'MATICUSDT', side: 'buy' }, { pair: 'MATICZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_MATIC_USDT', pairs: ['USDTZAR', 'MATICZAR', 'MATICUSDT'], sequence: 'USDT → ZAR → MATIC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'MATICZAR', side: 'buy' }, { pair: 'MATICUSDT', side: 'sell' }] }
            ],
            SET_14_LTC_FOCUS: [
                { id: 'ZAR_LTC_USDT_ZAR', pairs: ['LTCZAR', 'LTCUSDT', 'USDTZAR'], sequence: 'ZAR → LTC → USDT → ZAR', steps: [{ pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_LTC_ZAR', pairs: ['USDTZAR', 'LTCUSDT', 'LTCZAR'], sequence: 'ZAR → USDT → LTC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }] },
                { id: 'USDT_LTC_ZAR_USDT', pairs: ['LTCUSDT', 'LTCZAR', 'USDTZAR'], sequence: 'USDT → LTC → ZAR → USDT', steps: [{ pair: 'LTCUSDT', side: 'buy' }, { pair: 'LTCZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_LTC_USDT', pairs: ['USDTZAR', 'LTCZAR', 'LTCUSDT'], sequence: 'USDT → ZAR → LTC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'LTCZAR', side: 'buy' }, { pair: 'LTCUSDT', side: 'sell' }] }
            ],
            SET_15_ZAR_EXTENDED: [
                { id: 'ZAR_DOGE_USDT_ZAR', pairs: ['DOGEZAR', 'DOGEUSDT', 'USDTZAR'], sequence: 'ZAR → DOGE → USDT → ZAR', steps: [{ pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DOGE_ZAR', pairs: ['USDTZAR', 'DOGEUSDT', 'DOGEZAR'], sequence: 'ZAR → USDT → DOGE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }] },
                { id: 'USDT_DOGE_ZAR_USDT', pairs: ['DOGEUSDT', 'DOGEZAR', 'USDTZAR'], sequence: 'USDT → DOGE → ZAR → USDT', steps: [{ pair: 'DOGEUSDT', side: 'buy' }, { pair: 'DOGEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DOGE_USDT', pairs: ['USDTZAR', 'DOGEZAR', 'DOGEUSDT'], sequence: 'USDT → ZAR → DOGE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DOGEZAR', side: 'buy' }, { pair: 'DOGEUSDT', side: 'sell' }] }
            ],
            SET_16_USDT_EXTENDED: [
                { id: 'ZAR_ETH_USDT_ZAR', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], sequence: 'ZAR → ETH → USDT → ZAR', steps: [{ pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ETH_ZAR', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], sequence: 'ZAR → USDT → ETH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }] },
                { id: 'USDT_ETH_ZAR_USDT', pairs: ['ETHUSDT', 'ETHZAR', 'USDTZAR'], sequence: 'USDT → ETH → ZAR → USDT', steps: [{ pair: 'ETHUSDT', side: 'buy' }, { pair: 'ETHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ETH_USDT', pairs: ['USDTZAR', 'ETHZAR', 'ETHUSDT'], sequence: 'USDT → ZAR → ETH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ETHZAR', side: 'buy' }, { pair: 'ETHUSDT', side: 'sell' }] }
            ],
            SET_17_CROSS_BRIDGE: [
                { id: 'ZAR_AVAX_USDT_ZAR', pairs: ['AVAXZAR', 'AVAXUSDT', 'USDTZAR'], sequence: 'ZAR → AVAX → USDT → ZAR', steps: [{ pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AVAX_ZAR', pairs: ['USDTZAR', 'AVAXUSDT', 'AVAXZAR'], sequence: 'ZAR → USDT → AVAX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }] },
                { id: 'USDT_AVAX_ZAR_USDT', pairs: ['AVAXUSDT', 'AVAXZAR', 'USDTZAR'], sequence: 'USDT → AVAX → ZAR → USDT', steps: [{ pair: 'AVAXUSDT', side: 'buy' }, { pair: 'AVAXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AVAX_USDT', pairs: ['USDTZAR', 'AVAXZAR', 'AVAXUSDT'], sequence: 'USDT → ZAR → AVAX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AVAXZAR', side: 'buy' }, { pair: 'AVAXUSDT', side: 'sell' }] }
            ],
            SET_18_VOLUME_LEADERS: [
                { id: 'ZAR_XRP_USDT_ZAR', pairs: ['XRPZAR', 'XRPUSDT', 'USDTZAR'], sequence: 'ZAR → XRP → USDT → ZAR', steps: [{ pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_XRP_ZAR', pairs: ['USDTZAR', 'XRPUSDT', 'XRPZAR'], sequence: 'ZAR → USDT → XRP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }] },
                { id: 'USDT_XRP_ZAR_USDT', pairs: ['XRPUSDT', 'XRPZAR', 'USDTZAR'], sequence: 'USDT → XRP → ZAR → USDT', steps: [{ pair: 'XRPUSDT', side: 'buy' }, { pair: 'XRPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_XRP_USDT', pairs: ['USDTZAR', 'XRPZAR', 'XRPUSDT'], sequence: 'USDT → ZAR → XRP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'XRPZAR', side: 'buy' }, { pair: 'XRPUSDT', side: 'sell' }] }
            ],
            SET_19_DEFI_TOKENS: [
                { id: 'ZAR_SOL_USDT_ZAR', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], sequence: 'ZAR → SOL → USDT → ZAR', steps: [{ pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SOL_ZAR', pairs: ['USDTZAR', 'SOLUSDT', 'SOLZAR'], sequence: 'ZAR → USDT → SOL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }] },
                { id: 'USDT_SOL_ZAR_USDT', pairs: ['SOLUSDT', 'SOLZAR', 'USDTZAR'], sequence: 'USDT → SOL → ZAR → USDT', steps: [{ pair: 'SOLUSDT', side: 'buy' }, { pair: 'SOLZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SOL_USDT', pairs: ['USDTZAR', 'SOLZAR', 'SOLUSDT'], sequence: 'USDT → ZAR → SOL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SOLZAR', side: 'buy' }, { pair: 'SOLUSDT', side: 'sell' }] }
            ],
            SET_20_ALT_COINS: [
                { id: 'ZAR_BNB_USDT_ZAR', pairs: ['BNBZAR', 'BNBUSDT', 'USDTZAR'], sequence: 'ZAR → BNB → USDT → ZAR', steps: [{ pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BNB_ZAR', pairs: ['USDTZAR', 'BNBUSDT', 'BNBZAR'], sequence: 'ZAR → USDT → BNB → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }] },
                { id: 'USDT_BNB_ZAR_USDT', pairs: ['BNBUSDT', 'BNBZAR', 'USDTZAR'], sequence: 'USDT → BNB → ZAR → USDT', steps: [{ pair: 'BNBUSDT', side: 'buy' }, { pair: 'BNBZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BNB_USDT', pairs: ['USDTZAR', 'BNBZAR', 'BNBUSDT'], sequence: 'USDT → ZAR → BNB → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BNBZAR', side: 'buy' }, { pair: 'BNBUSDT', side: 'sell' }] }
            ],
            SET_21_DEFI_MAJORS: [
                { id: 'ZAR_ALGO_USDT_ZAR', pairs: ['ALGOZAR', 'ALGOUSDT', 'USDTZAR'], sequence: 'ZAR → ALGO → USDT → ZAR', steps: [{ pair: 'ALGOZAR', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ALGO_ZAR', pairs: ['USDTZAR', 'ALGOUSDT', 'ALGOZAR'], sequence: 'ZAR → USDT → ALGO → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ALGOUSDT', side: 'buy' }, { pair: 'ALGOZAR', side: 'sell' }] },
                { id: 'USDT_ALGO_ZAR_USDT', pairs: ['ALGOUSDT', 'ALGOZAR', 'USDTZAR'], sequence: 'USDT → ALGO → ZAR → USDT', steps: [{ pair: 'ALGOUSDT', side: 'buy' }, { pair: 'ALGOZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ALGO_USDT', pairs: ['USDTZAR', 'ALGOZAR', 'ALGOUSDT'], sequence: 'USDT → ZAR → ALGO → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ALGOZAR', side: 'buy' }, { pair: 'ALGOUSDT', side: 'sell' }] }
            ],
            SET_22_GAMING_METAVERSE: [
                { id: 'ZAR_SAND_USDT_ZAR', pairs: ['SANDZAR', 'SANDUSDT', 'USDTZAR'], sequence: 'ZAR → SAND → USDT → ZAR', steps: [{ pair: 'SANDZAR', side: 'buy' }, { pair: 'SANDUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SAND_ZAR', pairs: ['USDTZAR', 'SANDUSDT', 'SANDZAR'], sequence: 'ZAR → USDT → SAND → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SANDUSDT', side: 'buy' }, { pair: 'SANDZAR', side: 'sell' }] },
                { id: 'USDT_SAND_ZAR_USDT', pairs: ['SANDUSDT', 'SANDZAR', 'USDTZAR'], sequence: 'USDT → SAND → ZAR → USDT', steps: [{ pair: 'SANDUSDT', side: 'buy' }, { pair: 'SANDZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SAND_USDT', pairs: ['USDTZAR', 'SANDZAR', 'SANDUSDT'], sequence: 'USDT → ZAR → SAND → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SANDZAR', side: 'buy' }, { pair: 'SANDUSDT', side: 'sell' }] }
            ],
            SET_23_LAYER1_ALTS: [
                { id: 'ZAR_NEAR_USDT_ZAR', pairs: ['NEARZAR', 'NEARUSDT', 'USDTZAR'], sequence: 'ZAR → NEAR → USDT → ZAR', steps: [{ pair: 'NEARZAR', side: 'buy' }, { pair: 'NEARUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_NEAR_ZAR', pairs: ['USDTZAR', 'NEARUSDT', 'NEARZAR'], sequence: 'ZAR → USDT → NEAR → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'NEARUSDT', side: 'buy' }, { pair: 'NEARZAR', side: 'sell' }] },
                { id: 'USDT_NEAR_ZAR_USDT', pairs: ['NEARUSDT', 'NEARZAR', 'USDTZAR'], sequence: 'USDT → NEAR → ZAR → USDT', steps: [{ pair: 'NEARUSDT', side: 'buy' }, { pair: 'NEARZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_NEAR_USDT', pairs: ['USDTZAR', 'NEARZAR', 'NEARUSDT'], sequence: 'USDT → ZAR → NEAR → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'NEARZAR', side: 'buy' }, { pair: 'NEARUSDT', side: 'sell' }] }
            ],
            SET_24_DEFI_PROTOCOLS: [
                { id: 'ZAR_ATOM_USDT_ZAR', pairs: ['ATOMZAR', 'ATOMUSDT', 'USDTZAR'], sequence: 'ZAR → ATOM → USDT → ZAR', steps: [{ pair: 'ATOMZAR', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ATOM_ZAR', pairs: ['USDTZAR', 'ATOMUSDT', 'ATOMZAR'], sequence: 'ZAR → USDT → ATOM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMZAR', side: 'sell' }] },
                { id: 'USDT_ATOM_ZAR_USDT', pairs: ['ATOMUSDT', 'ATOMZAR', 'USDTZAR'], sequence: 'USDT → ATOM → ZAR → USDT', steps: [{ pair: 'ATOMUSDT', side: 'buy' }, { pair: 'ATOMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ATOM_USDT', pairs: ['USDTZAR', 'ATOMZAR', 'ATOMUSDT'], sequence: 'USDT → ZAR → ATOM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ATOMZAR', side: 'buy' }, { pair: 'ATOMUSDT', side: 'sell' }] }
            ],
            SET_25_FANTOM_ECOSYSTEM: [
                { id: 'ZAR_FTM_USDT_ZAR', pairs: ['FTMZAR', 'FTMUSDT', 'USDTZAR'], sequence: 'ZAR → FTM → USDT → ZAR', steps: [{ pair: 'FTMZAR', side: 'buy' }, { pair: 'FTMUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_FTM_ZAR', pairs: ['USDTZAR', 'FTMUSDT', 'FTMZAR'], sequence: 'ZAR → USDT → FTM → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'FTMUSDT', side: 'buy' }, { pair: 'FTMZAR', side: 'sell' }] },
                { id: 'USDT_FTM_ZAR_USDT', pairs: ['FTMUSDT', 'FTMZAR', 'USDTZAR'], sequence: 'USDT → FTM → ZAR → USDT', steps: [{ pair: 'FTMUSDT', side: 'buy' }, { pair: 'FTMZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_FTM_USDT', pairs: ['USDTZAR', 'FTMZAR', 'FTMUSDT'], sequence: 'USDT → ZAR → FTM → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'FTMZAR', side: 'buy' }, { pair: 'FTMUSDT', side: 'sell' }] }
            ],
            SET_26_DEFI_LENDING: [
                { id: 'ZAR_AAVE_USDT_ZAR', pairs: ['AAVEZAR', 'AAVEUSDT', 'USDTZAR'], sequence: 'ZAR → AAVE → USDT → ZAR', steps: [{ pair: 'AAVEZAR', side: 'buy' }, { pair: 'AAVEUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_AAVE_ZAR', pairs: ['USDTZAR', 'AAVEUSDT', 'AAVEZAR'], sequence: 'ZAR → USDT → AAVE → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'AAVEUSDT', side: 'buy' }, { pair: 'AAVEZAR', side: 'sell' }] },
                { id: 'USDT_AAVE_ZAR_USDT', pairs: ['AAVEUSDT', 'AAVEZAR', 'USDTZAR'], sequence: 'USDT → AAVE → ZAR → USDT', steps: [{ pair: 'AAVEUSDT', side: 'buy' }, { pair: 'AAVEZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_AAVE_USDT', pairs: ['USDTZAR', 'AAVEZAR', 'AAVEUSDT'], sequence: 'USDT → ZAR → AAVE → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'AAVEZAR', side: 'buy' }, { pair: 'AAVEUSDT', side: 'sell' }] }
            ],
            SET_27_DEX_AGGREGATOR: [
                { id: 'ZAR_1INCH_USDT_ZAR', pairs: ['1INCHZAR', '1INCHUSDT', 'USDTZAR'], sequence: 'ZAR → 1INCH → USDT → ZAR', steps: [{ pair: '1INCHZAR', side: 'buy' }, { pair: '1INCHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_1INCH_ZAR', pairs: ['USDTZAR', '1INCHUSDT', '1INCHZAR'], sequence: 'ZAR → USDT → 1INCH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: '1INCHUSDT', side: 'buy' }, { pair: '1INCHZAR', side: 'sell' }] },
                { id: 'USDT_1INCH_ZAR_USDT', pairs: ['1INCHUSDT', '1INCHZAR', 'USDTZAR'], sequence: 'USDT → 1INCH → ZAR → USDT', steps: [{ pair: '1INCHUSDT', side: 'buy' }, { pair: '1INCHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_1INCH_USDT', pairs: ['USDTZAR', '1INCHZAR', '1INCHUSDT'], sequence: 'USDT → ZAR → 1INCH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: '1INCHZAR', side: 'buy' }, { pair: '1INCHUSDT', side: 'sell' }] }
            ],
            SET_28_CURVE_FINANCE: [
                { id: 'ZAR_CRV_USDT_ZAR', pairs: ['CRVZAR', 'CRVUSDT', 'USDTZAR'], sequence: 'ZAR → CRV → USDT → ZAR', steps: [{ pair: 'CRVZAR', side: 'buy' }, { pair: 'CRVUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_CRV_ZAR', pairs: ['USDTZAR', 'CRVUSDT', 'CRVZAR'], sequence: 'ZAR → USDT → CRV → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'CRVUSDT', side: 'buy' }, { pair: 'CRVZAR', side: 'sell' }] },
                { id: 'USDT_CRV_ZAR_USDT', pairs: ['CRVUSDT', 'CRVZAR', 'USDTZAR'], sequence: 'USDT → CRV → ZAR → USDT', steps: [{ pair: 'CRVUSDT', side: 'buy' }, { pair: 'CRVZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_CRV_USDT', pairs: ['USDTZAR', 'CRVZAR', 'CRVUSDT'], sequence: 'USDT → ZAR → CRV → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'CRVZAR', side: 'buy' }, { pair: 'CRVUSDT', side: 'sell' }] }
            ],
            SET_29_COMPOUND_PROTOCOL: [
                { id: 'ZAR_COMP_USDT_ZAR', pairs: ['COMPZAR', 'COMPUSDT', 'USDTZAR'], sequence: 'ZAR → COMP → USDT → ZAR', steps: [{ pair: 'COMPZAR', side: 'buy' }, { pair: 'COMPUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_COMP_ZAR', pairs: ['USDTZAR', 'COMPUSDT', 'COMPZAR'], sequence: 'ZAR → USDT → COMP → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'COMPUSDT', side: 'buy' }, { pair: 'COMPZAR', side: 'sell' }] },
                { id: 'USDT_COMP_ZAR_USDT', pairs: ['COMPUSDT', 'COMPZAR', 'USDTZAR'], sequence: 'USDT → COMP → ZAR → USDT', steps: [{ pair: 'COMPUSDT', side: 'buy' }, { pair: 'COMPZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_COMP_USDT', pairs: ['USDTZAR', 'COMPZAR', 'COMPUSDT'], sequence: 'USDT → ZAR → COMP → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'COMPZAR', side: 'buy' }, { pair: 'COMPUSDT', side: 'sell' }] }
            ],
            SET_30_SYNTHETIX_NETWORK: [
                { id: 'ZAR_SNX_USDT_ZAR', pairs: ['SNXZAR', 'SNXUSDT', 'USDTZAR'], sequence: 'ZAR → SNX → USDT → ZAR', steps: [{ pair: 'SNXZAR', side: 'buy' }, { pair: 'SNXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_SNX_ZAR', pairs: ['USDTZAR', 'SNXUSDT', 'SNXZAR'], sequence: 'ZAR → USDT → SNX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'SNXUSDT', side: 'buy' }, { pair: 'SNXZAR', side: 'sell' }] },
                { id: 'USDT_SNX_ZAR_USDT', pairs: ['SNXUSDT', 'SNXZAR', 'USDTZAR'], sequence: 'USDT → SNX → ZAR → USDT', steps: [{ pair: 'SNXUSDT', side: 'buy' }, { pair: 'SNXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_SNX_USDT', pairs: ['USDTZAR', 'SNXZAR', 'SNXUSDT'], sequence: 'USDT → ZAR → SNX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'SNXZAR', side: 'buy' }, { pair: 'SNXUSDT', side: 'sell' }] }
            ],
            SET_31_MAKERDAO: [
                { id: 'ZAR_MKR_USDT_ZAR', pairs: ['MKRZAR', 'MKRUSDT', 'USDTZAR'], sequence: 'ZAR → MKR → USDT → ZAR', steps: [{ pair: 'MKRZAR', side: 'buy' }, { pair: 'MKRUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_MKR_ZAR', pairs: ['USDTZAR', 'MKRUSDT', 'MKRZAR'], sequence: 'ZAR → USDT → MKR → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'MKRUSDT', side: 'buy' }, { pair: 'MKRZAR', side: 'sell' }] },
                { id: 'USDT_MKR_ZAR_USDT', pairs: ['MKRUSDT', 'MKRZAR', 'USDTZAR'], sequence: 'USDT → MKR → ZAR → USDT', steps: [{ pair: 'MKRUSDT', side: 'buy' }, { pair: 'MKRZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_MKR_USDT', pairs: ['USDTZAR', 'MKRZAR', 'MKRUSDT'], sequence: 'USDT → ZAR → MKR → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'MKRZAR', side: 'buy' }, { pair: 'MKRUSDT', side: 'sell' }] }
            ],
            SET_32_BALANCER_PROTOCOL: [
                { id: 'ZAR_BAL_USDT_ZAR', pairs: ['BALZAR', 'BALUSDT', 'USDTZAR'], sequence: 'ZAR → BAL → USDT → ZAR', steps: [{ pair: 'BALZAR', side: 'buy' }, { pair: 'BALUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BAL_ZAR', pairs: ['USDTZAR', 'BALUSDT', 'BALZAR'], sequence: 'ZAR → USDT → BAL → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BALUSDT', side: 'buy' }, { pair: 'BALZAR', side: 'sell' }] },
                { id: 'USDT_BAL_ZAR_USDT', pairs: ['BALUSDT', 'BALZAR', 'USDTZAR'], sequence: 'USDT → BAL → ZAR → USDT', steps: [{ pair: 'BALUSDT', side: 'buy' }, { pair: 'BALZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BAL_USDT', pairs: ['USDTZAR', 'BALZAR', 'BALUSDT'], sequence: 'USDT → ZAR → BAL → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BALZAR', side: 'buy' }, { pair: 'BALUSDT', side: 'sell' }] }
            ],
            SET_33_ZRX_PROTOCOL: [
                { id: 'ZAR_ZRX_USDT_ZAR', pairs: ['ZRXZAR', 'ZRXUSDT', 'USDTZAR'], sequence: 'ZAR → ZRX → USDT → ZAR', steps: [{ pair: 'ZRXZAR', side: 'buy' }, { pair: 'ZRXUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ZRX_ZAR', pairs: ['USDTZAR', 'ZRXUSDT', 'ZRXZAR'], sequence: 'ZAR → USDT → ZRX → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ZRXUSDT', side: 'buy' }, { pair: 'ZRXZAR', side: 'sell' }] },
                { id: 'USDT_ZRX_ZAR_USDT', pairs: ['ZRXUSDT', 'ZRXZAR', 'USDTZAR'], sequence: 'USDT → ZRX → ZAR → USDT', steps: [{ pair: 'ZRXUSDT', side: 'buy' }, { pair: 'ZRXZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ZRX_USDT', pairs: ['USDTZAR', 'ZRXZAR', 'ZRXUSDT'], sequence: 'USDT → ZAR → ZRX → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ZRXZAR', side: 'buy' }, { pair: 'ZRXUSDT', side: 'sell' }] }
            ],
            SET_34_STORAGE_NETWORK: [
                { id: 'ZAR_STORJ_USDT_ZAR', pairs: ['STORJZAR', 'STORJUSDT', 'USDTZAR'], sequence: 'ZAR → STORJ → USDT → ZAR', steps: [{ pair: 'STORJZAR', side: 'buy' }, { pair: 'STORJUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_STORJ_ZAR', pairs: ['USDTZAR', 'STORJUSDT', 'STORJZAR'], sequence: 'ZAR → USDT → STORJ → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'STORJUSDT', side: 'buy' }, { pair: 'STORJZAR', side: 'sell' }] },
                { id: 'USDT_STORJ_ZAR_USDT', pairs: ['STORJUSDT', 'STORJZAR', 'USDTZAR'], sequence: 'USDT → STORJ → ZAR → USDT', steps: [{ pair: 'STORJUSDT', side: 'buy' }, { pair: 'STORJZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_STORJ_USDT', pairs: ['USDTZAR', 'STORJZAR', 'STORJUSDT'], sequence: 'USDT → ZAR → STORJ → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'STORJZAR', side: 'buy' }, { pair: 'STORJUSDT', side: 'sell' }] }
            ],
            SET_35_THE_GRAPH: [
                { id: 'ZAR_GRT_USDT_ZAR', pairs: ['GRTZAR', 'GRTUSDT', 'USDTZAR'], sequence: 'ZAR → GRT → USDT → ZAR', steps: [{ pair: 'GRTZAR', side: 'buy' }, { pair: 'GRTUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_GRT_ZAR', pairs: ['USDTZAR', 'GRTUSDT', 'GRTZAR'], sequence: 'ZAR → USDT → GRT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'GRTUSDT', side: 'buy' }, { pair: 'GRTZAR', side: 'sell' }] },
                { id: 'USDT_GRT_ZAR_USDT', pairs: ['GRTUSDT', 'GRTZAR', 'USDTZAR'], sequence: 'USDT → GRT → ZAR → USDT', steps: [{ pair: 'GRTUSDT', side: 'buy' }, { pair: 'GRTZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_GRT_USDT', pairs: ['USDTZAR', 'GRTZAR', 'GRTUSDT'], sequence: 'USDT → ZAR → GRT → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'GRTZAR', side: 'buy' }, { pair: 'GRTUSDT', side: 'sell' }] }
            ],
            SET_36_GAMING_TOKEN: [
                { id: 'ZAR_ENJ_USDT_ZAR', pairs: ['ENJZAR', 'ENJUSDT', 'USDTZAR'], sequence: 'ZAR → ENJ → USDT → ZAR', steps: [{ pair: 'ENJZAR', side: 'buy' }, { pair: 'ENJUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ENJ_ZAR', pairs: ['USDTZAR', 'ENJUSDT', 'ENJZAR'], sequence: 'ZAR → USDT → ENJ → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ENJUSDT', side: 'buy' }, { pair: 'ENJZAR', side: 'sell' }] },
                { id: 'USDT_ENJ_ZAR_USDT', pairs: ['ENJUSDT', 'ENJZAR', 'USDTZAR'], sequence: 'USDT → ENJ → ZAR → USDT', steps: [{ pair: 'ENJUSDT', side: 'buy' }, { pair: 'ENJZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ENJ_USDT', pairs: ['USDTZAR', 'ENJZAR', 'ENJUSDT'], sequence: 'USDT → ZAR → ENJ → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ENJZAR', side: 'buy' }, { pair: 'ENJUSDT', side: 'sell' }] }
            ],
            SET_37_ATTENTION_TOKEN: [
                { id: 'ZAR_BAT_USDT_ZAR', pairs: ['BATZAR', 'BATUSDT', 'USDTZAR'], sequence: 'ZAR → BAT → USDT → ZAR', steps: [{ pair: 'BATZAR', side: 'buy' }, { pair: 'BATUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_BAT_ZAR', pairs: ['USDTZAR', 'BATUSDT', 'BATZAR'], sequence: 'ZAR → USDT → BAT → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'BATUSDT', side: 'buy' }, { pair: 'BATZAR', side: 'sell' }] },
                { id: 'USDT_BAT_ZAR_USDT', pairs: ['BATUSDT', 'BATZAR', 'USDTZAR'], sequence: 'USDT → BAT → ZAR → USDT', steps: [{ pair: 'BATUSDT', side: 'buy' }, { pair: 'BATZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_BAT_USDT', pairs: ['USDTZAR', 'BATZAR', 'BATUSDT'], sequence: 'USDT → ZAR → BAT → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'BATZAR', side: 'buy' }, { pair: 'BATUSDT', side: 'sell' }] }
            ],
            SET_38_PRIVACY_COIN: [
                { id: 'ZAR_ZEC_USDT_ZAR', pairs: ['ZECZAR', 'ZECUSDT', 'USDTZAR'], sequence: 'ZAR → ZEC → USDT → ZAR', steps: [{ pair: 'ZECZAR', side: 'buy' }, { pair: 'ZECUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_ZEC_ZAR', pairs: ['USDTZAR', 'ZECUSDT', 'ZECZAR'], sequence: 'ZAR → USDT → ZEC → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'ZECUSDT', side: 'buy' }, { pair: 'ZECZAR', side: 'sell' }] },
                { id: 'USDT_ZEC_ZAR_USDT', pairs: ['ZECUSDT', 'ZECZAR', 'USDTZAR'], sequence: 'USDT → ZEC → ZAR → USDT', steps: [{ pair: 'ZECUSDT', side: 'buy' }, { pair: 'ZECZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_ZEC_USDT', pairs: ['USDTZAR', 'ZECZAR', 'ZECUSDT'], sequence: 'USDT → ZAR → ZEC → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'ZECZAR', side: 'buy' }, { pair: 'ZECUSDT', side: 'sell' }] }
            ],
            SET_39_DIGITAL_CASH: [
                { id: 'ZAR_DASH_USDT_ZAR', pairs: ['DASHZAR', 'DASHUSDT', 'USDTZAR'], sequence: 'ZAR → DASH → USDT → ZAR', steps: [{ pair: 'DASHZAR', side: 'buy' }, { pair: 'DASHUSDT', side: 'sell' }, { pair: 'USDTZAR', side: 'sell' }] },
                { id: 'ZAR_USDT_DASH_ZAR', pairs: ['USDTZAR', 'DASHUSDT', 'DASHZAR'], sequence: 'ZAR → USDT → DASH → ZAR', steps: [{ pair: 'USDTZAR', side: 'buy' }, { pair: 'DASHUSDT', side: 'buy' }, { pair: 'DASHZAR', side: 'sell' }] },
                { id: 'USDT_DASH_ZAR_USDT', pairs: ['DASHUSDT', 'DASHZAR', 'USDTZAR'], sequence: 'USDT → DASH → ZAR → USDT', steps: [{ pair: 'DASHUSDT', side: 'buy' }, { pair: 'DASHZAR', side: 'sell' }, { pair: 'USDTZAR', side: 'buy' }] },
                { id: 'USDT_ZAR_DASH_USDT', pairs: ['USDTZAR', 'DASHZAR', 'DASHUSDT'], sequence: 'USDT → ZAR → DASH → USDT', steps: [{ pair: 'USDTZAR', side: 'sell' }, { pair: 'DASHZAR', side: 'buy' }, { pair: 'DASHUSDT', side: 'sell' }] }
            ]
        };

        // Select paths based on scanSet parameter (supports all 39 sets)
        const { scanSet = 'SET_1_ETH_FOCUS' } = req.body;
        let triangularPaths;

        if (scanSet === 'ALL' || scanSet === 'all') {
            // Combine all 20 path sets for comprehensive scanning (80 total paths)
            triangularPaths = Object.values(allPathSets).flat();
            console.log(`🔺 Scanning ALL 20 SETS with ${triangularPaths.length} total paths (excludes BTC)`);
        } else {
            triangularPaths = allPathSets[scanSet] || allPathSets.SET_1_ETH_FOCUS;
            console.log(`🔺 Scanning ${scanSet} with ${triangularPaths.length} paths (4 paths per focused set)`);
        }

        // Fetch current market prices for all pairs
        const orderBooks = {};
        const uniquePairs = [...new Set(triangularPaths.flatMap(p => p.pairs))];
        
        for (const pair of uniquePairs) {
            const orderBook = await makeVALRRequest(
                `/v1/marketdata/${pair}/orderbook`,
                'GET',
                null,
                apiKey,
                apiSecret
            );
            orderBooks[pair] = orderBook;
        }

        // Calculate profit for each path using advanced calculation engine
        const opportunities = [];
        const { amount = 1000 } = req.body; // Allow custom amount, default R1000
        
        console.log(`🔺 Calculating profits for ${triangularPaths.length} paths with R${amount} starting amount`);
        
        for (const path of triangularPaths) {
            console.log(`📊 Analyzing path: ${path.id} - ${path.sequence}`);
            
            // Use advanced profit calculation with comprehensive analysis
            const result = calculateTriangularProfitAdvanced(path, orderBooks, amount, {
                slippageBuffer: 0.1,
                minOrderSize: 50,
                maxOrderSize: 10000,
                depthAnalysis: true
            });
            
            if (result.success) {
                // Transform advanced result to match expected format while preserving all data
                const opportunity = {
                    pathId: result.pathId,
                    sequence: result.sequence,
                    startAmount: result.startAmount,
                    endAmount: parseFloat(result.endAmount.toFixed(2)),
                    grossProfit: parseFloat(result.grossProfit.toFixed(2)),
                    netProfit: parseFloat(result.netProfit.toFixed(2)),
                    netProfitPercent: parseFloat(result.netProfitPercent.toFixed(3)),
                    profitable: result.profitable,
                    recommendation: result.recommendation,
                    riskLevel: result.riskLevel,
                    riskFactors: result.riskFactors,
                    
                    // Fee breakdown
                    fees: {
                        total: parseFloat(result.fees.total.toFixed(2)),
                        percentage: parseFloat(result.fees.percentage.toFixed(3)),
                        breakdown: result.fees.breakdown
                    },
                    
                    // Slippage analysis
                    slippage: {
                        estimated: parseFloat(result.slippage.estimated.toFixed(2)),
                        percentage: parseFloat(result.slippage.percentage.toFixed(3))
                    },
                    
                    // Order book depth analysis
                    orderBookDepth: result.orderBookDepth,
                    
                    // Step-by-step execution details
                    steps: result.steps,
                    
                    // Backward compatibility fields
                    profit: parseFloat(result.netProfit.toFixed(2)), // For legacy compatibility
                    profitPercent: parseFloat(result.netProfitPercent.toFixed(3)), // For legacy compatibility
                    prices: result.steps.map(step => ({
                        pair: step.pair,
                        side: step.side,
                        price: step.price
                    })),
                    
                    minProfitThreshold: result.minProfitThreshold,
                    timestamp: result.timestamp
                };
                
                opportunities.push(opportunity);
                
                // Log significant opportunities
                if (result.profitable) {
                    console.log(`💰 PROFITABLE: ${path.id} - ${result.netProfitPercent.toFixed(2)}% (${result.recommendation}) [${result.riskLevel} risk]`);
                    if (result.riskFactors.length > 0) {
                        console.log(`⚠️ Risk factors: ${result.riskFactors.join(', ')}`);
                    }
                } else {
                    console.log(`📉 NOT PROFITABLE: ${path.id} - ${result.netProfitPercent.toFixed(2)}%`);
                }
                
            } else {
                // Handle calculation errors
                console.error(`❌ Calculation failed for ${path.id}: ${result.error}`);
                
                opportunities.push({
                    pathId: result.pathId,
                    sequence: path.sequence,
                    error: result.error,
                    profitable: false,
                    netProfitPercent: 0,
                    recommendation: 'ERROR',
                    riskLevel: 'HIGH',
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        console.log(`🔺 Analysis complete: ${opportunities.filter(o => o.profitable).length} profitable opportunities found`);
        
        // Enhanced sorting: prioritize by profit percentage, then by risk level
        opportunities.sort((a, b) => {
            // First sort by profitability
            if (a.profitable !== b.profitable) {
                return b.profitable - a.profitable; // Profitable first
            }
            
            // Then by profit percentage
            if (a.netProfitPercent !== b.netProfitPercent) {
                return b.netProfitPercent - a.netProfitPercent; // Higher profit first
            }
            
            // Finally by risk level (LOW < MEDIUM < HIGH)
            const riskOrder = { 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'ERROR': 4 };
            return (riskOrder[a.riskLevel] || 4) - (riskOrder[b.riskLevel] || 4);
        });

        // Calculate enhanced statistics
        const profitableOpportunities = opportunities.filter(o => o.profitable);
        const executeRecommendations = opportunities.filter(o => o.recommendation === 'EXECUTE');
        const cautionsRecommendations = opportunities.filter(o => o.recommendation === 'CAUTIOUS');
        
        // Risk distribution
        const riskDistribution = {
            LOW: opportunities.filter(o => o.riskLevel === 'LOW').length,
            MEDIUM: opportunities.filter(o => o.riskLevel === 'MEDIUM').length,
            HIGH: opportunities.filter(o => o.riskLevel === 'HIGH').length
        };
        
        const avgProfit = profitableOpportunities.length > 0 
            ? profitableOpportunities.reduce((sum, o) => sum + o.netProfitPercent, 0) / profitableOpportunities.length
            : 0;

        systemLogger.trading('VALR triangular scan completed', {
            userId: req.user.id,
            opportunitiesFound: opportunities.length,
            profitableCount: profitableOpportunities.length,
            executeRecommendations: executeRecommendations.length,
            avgProfitPercent: avgProfit.toFixed(3),
            startAmount: amount
        });

        res.json({
            success: true,
            data: {
                opportunities,
                pathsScanned: triangularPaths.length,
                scanSet: scanSet,
                scanTime: new Date().toISOString(),
                analysis: {
                    totalOpportunities: opportunities.length,
                    profitableCount: profitableOpportunities.length,
                    executeRecommendations: executeRecommendations.length,
                    cautiousRecommendations: cautionsRecommendations.length,
                    avgProfitPercent: parseFloat(avgProfit.toFixed(3)),
                    riskDistribution,
                    startAmount: amount
                },
                bestOpportunity: opportunities[0] || null,
                topProfitable: profitableOpportunities.slice(0, 3), // Top 3 profitable
                readyToExecute: executeRecommendations.slice(0, 2) // Top 2 ready to execute
            }
        });
    } catch (error) {
        systemLogger.error('VALR triangular scan failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// GET /api/v1/trading/valr/triangular/paths
// Get all configured triangular arbitrage paths
router.get('/valr/triangular/paths', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        // Return all 32 configured paths with current status
        const allPaths = {
            SET_1_MAJORS: {
                name: 'High Volume Majors',
                paths: [
                    { id: 'ZAR_LINK_USDT', pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'], proven: true },
                    { id: 'ZAR_ETH_USDT', pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_USDT_LINK', pairs: ['USDTZAR', 'LINKUSDT', 'LINKZAR'], proven: true },
                    { id: 'ZAR_USDT_ETH', pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'], proven: false }
                ]
            },
            SET_2_ALTS: {
                name: 'Popular Altcoins',
                paths: [
                    { id: 'ZAR_ADA_USDT', pairs: ['ADAZAR', 'ADAUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_DOT_USDT', pairs: ['DOTZAR', 'DOTUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_MATIC_USDT', pairs: ['MATICZAR', 'MATICUSDT', 'USDTZAR'], proven: false },
                    { id: 'ZAR_SOL_USDT', pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'], proven: false }
                ]
            }
            // Add remaining sets as needed
        };

        res.json({
            success: true,
            data: {
                pathSets: allPaths,
                totalPaths: Object.values(allPaths).reduce((sum, set) => sum + set.paths.length, 0),
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        systemLogger.error('VALR triangular paths fetch failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// POST /api/v1/trading/valr/triangular/execute
// Execute a triangular arbitrage trade (3-leg atomic transaction)
router.post('/valr/triangular/execute', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const { pathId, amount, simulate = true } = req.body;
        
        if (!pathId || !amount) {
            throw new APIError('Path ID and amount are required', 400, 'MISSING_PARAMETERS');
        }

        systemLogger.trading('VALR triangular execution initiated', {
            userId: req.user.id,
            pathId,
            amount,
            simulate,
            timestamp: new Date().toISOString()
        });

        // Get user's VALR API credentials
        const keysResult = await query(`
            SELECT exchange_api_key, exchange_api_secret 
            FROM user_api_keys 
            WHERE user_id = $1 AND exchange = 'VALR'
        `, [req.user.id]);

        if (keysResult.rows.length === 0) {
            throw new APIError('VALR API keys not found', 404, 'VALR_KEYS_NOT_FOUND');
        }

        const { exchange_api_key, exchange_api_secret } = keysResult.rows[0];

        // Find the triangular path configuration
        const triangularPaths = [
            {
                id: 'ZAR_LINK_USDT',
                pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'],
                sequence: 'ZAR → LINK → USDT → ZAR',
                steps: [
                    { pair: 'LINKZAR', side: 'buy' },
                    { pair: 'LINKUSDT', side: 'sell' },
                    { pair: 'USDTZAR', side: 'sell' }
                ]
            },
            {
                id: 'ZAR_ETH_USDT',
                pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'],
                sequence: 'ZAR → ETH → USDT → ZAR',
                steps: [
                    { pair: 'ETHZAR', side: 'buy' },
                    { pair: 'ETHUSDT', side: 'sell' },
                    { pair: 'USDTZAR', side: 'sell' }
                ]
            }
            // Add more paths as needed
        ];

        const selectedPath = triangularPaths.find(p => p.id === pathId);
        if (!selectedPath) {
            throw new APIError(`Invalid path ID: ${pathId}`, 400, 'INVALID_PATH_ID');
        }

        // Get current market prices for the path to create opportunity object
        const orderBooks = {};
        for (const pair of selectedPath.pairs) {
            const orderBook = await makeVALRRequest(
                `/v1/marketdata/${pair}/orderbook`,
                'GET',
                null,
                exchange_api_key,
                exchange_api_secret
            );
            orderBooks[pair] = orderBook;
        }

        // Calculate current opportunity
        const currentOpportunity = calculateTriangularProfitAdvanced(selectedPath, orderBooks, amount);
        
        if (!currentOpportunity.success) {
            throw new APIError(`Opportunity calculation failed: ${currentOpportunity.error}`, 400, 'CALCULATION_FAILED');
        }

        console.log(`🎯 Executing triangular arbitrage: ${pathId} with R${amount}`);
        console.log(`📊 Expected profit: ${currentOpportunity.netProfitPercent.toFixed(2)}% (${currentOpportunity.recommendation})`);

        // Execute the triangular trade atomically
        const executionResult = await executeTriangularTradeAtomic(
            currentOpportunity,
            exchange_api_key,
            exchange_api_secret,
            {
                maxSlippage: 0.5,      // 0.5% max slippage
                timeoutMs: 30000,      // 30 second timeout per leg
                dryRun: simulate       // Use simulate parameter for dry run
            }
        );

        // Prepare response based on execution result
        if (executionResult.success) {
            systemLogger.trading('VALR triangular execution completed', {
                userId: req.user.id,
                executionId: executionResult.executionId,
                pathId: executionResult.pathId,
                startAmount: executionResult.startAmount,
                endAmount: executionResult.endAmount,
                netProfit: executionResult.netProfit,
                netProfitPercent: executionResult.netProfitPercent,
                totalTime: executionResult.performance.totalTime,
                simulate
            });

            // Log trade to database
            const logResult = await logTriangularTrade(req.user.id, {
                opportunity: currentOpportunity,
                executionResult: executionResult,
                dryRun: simulate,
                maxSlippage: maxSlippage,
                scanStartedAt: req.body.scanStartedAt ? new Date(req.body.scanStartedAt) : new Date(),
                executionStartedAt: new Date(),
                executionTimeMs: executionResult.performance?.totalTime,
                userAgent: req.headers['user-agent'],
                ipAddress: req.ip
            });

            if (logResult.success) {
                systemLogger.info('Trade logged to database', {
                    userId: req.user.id,
                    tradeId: logResult.tradeId,
                    dbId: logResult.dbId
                });
            }

            res.json({
                success: true,
                data: {
                    execution: {
                        executionId: executionResult.executionId,
                        pathId: executionResult.pathId,
                        sequence: executionResult.sequence,
                        simulate: simulate,
                        startAmount: executionResult.startAmount,
                        endAmount: executionResult.endAmount,
                        grossProfit: executionResult.grossProfit,
                        netProfit: executionResult.netProfit,
                        netProfitPercent: executionResult.netProfitPercent,
                        performance: executionResult.performance,
                        legs: executionResult.legs,
                        startTime: executionResult.startTime,
                        endTime: executionResult.endTime
                    },
                    message: simulate 
                        ? `Simulation completed successfully. Estimated profit: R${executionResult.netProfit.toFixed(2)} (${executionResult.netProfitPercent.toFixed(2)}%)`
                        : `Triangular execution completed successfully! Net profit: R${executionResult.netProfit.toFixed(2)} (${executionResult.netProfitPercent.toFixed(2)}%)`,
                    timestamp: new Date().toISOString()
                }
            });

        } else {
            // Execution failed
            systemLogger.error('VALR triangular execution failed', {
                userId: req.user.id,
                executionId: executionResult.executionId,
                pathId: executionResult.pathId,
                error: executionResult.error,
                legs: executionResult.legs,
                rollbacks: executionResult.rollbacks,
                simulate
            });

            // Log failed trade to database
            const logResult = await logTriangularTrade(req.user.id, {
                opportunity: currentOpportunity,
                executionResult: executionResult,
                dryRun: simulate,
                maxSlippage: maxSlippage,
                scanStartedAt: req.body.scanStartedAt ? new Date(req.body.scanStartedAt) : new Date(),
                executionStartedAt: new Date(),
                executionTimeMs: executionResult.performance?.totalTime,
                userAgent: req.headers['user-agent'],
                ipAddress: req.ip
            });

            if (logResult.success) {
                systemLogger.info('Failed trade logged to database', {
                    userId: req.user.id,
                    tradeId: logResult.tradeId,
                    dbId: logResult.dbId
                });
            }

            res.json({
                success: false,
                data: {
                    execution: {
                        executionId: executionResult.executionId,
                        pathId: executionResult.pathId,
                        simulate: simulate,
                        error: executionResult.error,
                        legs: executionResult.legs,
                        rollbacks: executionResult.rollbacks,
                        performance: executionResult.performance,
                        startTime: executionResult.startTime,
                        endTime: executionResult.endTime
                    },
                    message: `Execution failed: ${executionResult.error}`,
                    timestamp: new Date().toISOString()
                }
            });
        }
    } catch (error) {
        systemLogger.error('VALR triangular execution failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// DELETE /api/v1/trading/valr/triangular/history
// Clear triangular arbitrage trade history
router.delete('/valr/triangular/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('VALR triangular history clear initiated', {
            userId: req.user.id,
            timestamp: new Date().toISOString()
        });

        // Clear triangular trade history for this user
        await query(`
            DELETE FROM triangular_trades 
            WHERE user_id = $1
        `, [req.user.id]);

        // Reset stats
        await query(`
            UPDATE trading_activity 
            SET triangular_trades_count = 0,
                triangular_profit_total = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
        `, [req.user.id]);

        systemLogger.trading('VALR triangular history cleared', {
            userId: req.user.id
        });

        res.json({
            success: true,
            message: 'Triangular trade history cleared successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        systemLogger.error('VALR triangular history clear failed', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

// ============================================
// WEBSOCKET PRICE SUBSCRIBER FOR TRIANGULAR PAIRS
// ============================================
// Real-time price streaming for triangular arbitrage opportunities

const WebSocket = require('ws');

// Track active WebSocket connections for triangular price updates
const triangularPriceSubscriptions = new Map();

// WebSocket endpoint for triangular price updates
router.ws = function(server) {
    const wss = new WebSocket.Server({ 
        server,
        path: '/ws/triangular-prices'
    });

    console.log('🔺 WebSocket server initialized for triangular prices on /ws/triangular-prices');

    wss.on('connection', function connection(ws, req) {
        const connectionId = Math.random().toString(36).substring(7);
        console.log(`📡 New triangular price WebSocket connection: ${connectionId}`);
        
        // Store connection
        triangularPriceSubscriptions.set(connectionId, {
            ws: ws,
            subscriptions: new Set(),
            lastPing: Date.now()
        });

        // Handle incoming messages
        ws.on('message', function incoming(message) {
            try {
                const data = JSON.parse(message);
                
                switch (data.type) {
                    case 'subscribe':
                        handleTriangularSubscription(connectionId, data.pairs);
                        break;
                    case 'unsubscribe':
                        handleTriangularUnsubscription(connectionId, data.pairs);
                        break;
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                        triangularPriceSubscriptions.get(connectionId).lastPing = Date.now();
                        break;
                    default:
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: 'Unknown message type',
                            received: data.type 
                        }));
                }
            } catch (error) {
                console.error('❌ WebSocket message parsing error:', error);
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'Invalid JSON message' 
                }));
            }
        });

        // Handle connection close
        ws.on('close', function close() {
            console.log(`📡 Triangular WebSocket connection closed: ${connectionId}`);
            triangularPriceSubscriptions.delete(connectionId);
        });

        // Send welcome message
        ws.send(JSON.stringify({
            type: 'connected',
            connectionId: connectionId,
            message: 'Connected to triangular price feed',
            availablePairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR', 'ETHZAR', 'ETHUSDT', 'ADAZAR', 'ADAUSDT']
        }));
    });

    return wss;
};

// Handle triangular pair subscription
function handleTriangularSubscription(connectionId, pairs) {
    const connection = triangularPriceSubscriptions.get(connectionId);
    if (!connection) return;

    if (Array.isArray(pairs)) {
        pairs.forEach(pair => {
            connection.subscriptions.add(pair);
            console.log(`📊 ${connectionId} subscribed to ${pair}`);
        });
    } else {
        connection.subscriptions.add(pairs);
        console.log(`📊 ${connectionId} subscribed to ${pairs}`);
    }

    connection.ws.send(JSON.stringify({
        type: 'subscribed',
        pairs: Array.from(connection.subscriptions),
        message: `Subscribed to ${Array.isArray(pairs) ? pairs.length : 1} pairs`
    }));

    // Start sending price updates for subscribed pairs
    startPriceUpdatesForConnection(connectionId);
}

// Handle triangular pair unsubscription
function handleTriangularUnsubscription(connectionId, pairs) {
    const connection = triangularPriceSubscriptions.get(connectionId);
    if (!connection) return;

    if (Array.isArray(pairs)) {
        pairs.forEach(pair => {
            connection.subscriptions.delete(pair);
            console.log(`📊 ${connectionId} unsubscribed from ${pair}`);
        });
    } else {
        connection.subscriptions.delete(pairs);
        console.log(`📊 ${connectionId} unsubscribed from ${pairs}`);
    }

    connection.ws.send(JSON.stringify({
        type: 'unsubscribed',
        pairs: Array.isArray(pairs) ? pairs : [pairs],
        remaining: Array.from(connection.subscriptions)
    }));
}

// Start sending price updates for a connection
async function startPriceUpdatesForConnection(connectionId) {
    const connection = triangularPriceSubscriptions.get(connectionId);
    if (!connection || connection.subscriptions.size === 0) return;

    try {
        const subscribedPairs = Array.from(connection.subscriptions);
        const priceUpdates = {};

        // Fetch latest prices for all subscribed pairs
        for (const pair of subscribedPairs) {
            try {
                const orderBook = await makeVALRRequest(
                    `/v1/marketdata/${pair}/orderbook`,
                    'GET',
                    null,
                    process.env.VALR_API_KEY,
                    process.env.VALR_API_SECRET
                );

                if (orderBook && orderBook.Asks && orderBook.Bids && 
                    orderBook.Asks.length > 0 && orderBook.Bids.length > 0) {
                    
                    const bestAsk = parseFloat(orderBook.Asks[0].price);
                    const bestBid = parseFloat(orderBook.Bids[0].price);
                    const spread = ((bestAsk - bestBid) / bestBid * 100);
                    
                    priceUpdates[pair] = {
                        pair: pair,
                        bestBid: bestBid,
                        bestAsk: bestAsk,
                        spread: spread.toFixed(4),
                        bidSize: parseFloat(orderBook.Bids[0].quantity),
                        askSize: parseFloat(orderBook.Asks[0].quantity),
                        timestamp: Date.now()
                    };
                }
            } catch (pairError) {
                console.error(`❌ Failed to fetch ${pair} prices:`, pairError.message);
                priceUpdates[pair] = {
                    pair: pair,
                    error: pairError.message,
                    timestamp: Date.now()
                };
            }
        }

        // Send price updates to client
        if (Object.keys(priceUpdates).length > 0) {
            connection.ws.send(JSON.stringify({
                type: 'priceUpdate',
                data: priceUpdates,
                timestamp: Date.now()
            }));
        }

    } catch (error) {
        console.error(`❌ Error sending price updates to ${connectionId}:`, error);
        connection.ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to fetch price updates',
            error: error.message
        }));
    }
}

// Broadcast price updates to all connected clients
async function broadcastTriangularPriceUpdates() {
    if (triangularPriceSubscriptions.size === 0) return;

    const allSubscribedPairs = new Set();
    triangularPriceSubscriptions.forEach(connection => {
        connection.subscriptions.forEach(pair => allSubscribedPairs.add(pair));
    });

    if (allSubscribedPairs.size === 0) return;

    console.log(`📡 Broadcasting prices for ${allSubscribedPairs.size} pairs to ${triangularPriceSubscriptions.size} clients`);

    // Fetch prices for all subscribed pairs
    const priceData = {};
    for (const pair of allSubscribedPairs) {
        try {
            const orderBook = await makeVALRRequest(
                `/v1/marketdata/${pair}/orderbook`,
                'GET',
                null,
                process.env.VALR_API_KEY,
                process.env.VALR_API_SECRET
            );

            if (orderBook && orderBook.Asks && orderBook.Bids && 
                orderBook.Asks.length > 0 && orderBook.Bids.length > 0) {
                
                const bestAsk = parseFloat(orderBook.Asks[0].price);
                const bestBid = parseFloat(orderBook.Bids[0].price);
                const spread = ((bestAsk - bestBid) / bestBid * 100);
                
                priceData[pair] = {
                    pair: pair,
                    bestBid: bestBid,
                    bestAsk: bestAsk,
                    spread: spread.toFixed(4),
                    bidSize: parseFloat(orderBook.Bids[0].quantity),
                    askSize: parseFloat(orderBook.Asks[0].quantity),
                    timestamp: Date.now()
                };
            }
        } catch (error) {
            console.error(`❌ Failed to fetch ${pair} for broadcast:`, error.message);
        }
    }

    // Send updates to each connected client
    triangularPriceSubscriptions.forEach((connection, connectionId) => {
        if (connection.ws.readyState === WebSocket.OPEN) {
            const clientPriceData = {};
            connection.subscriptions.forEach(pair => {
                if (priceData[pair]) {
                    clientPriceData[pair] = priceData[pair];
                }
            });

            if (Object.keys(clientPriceData).length > 0) {
                connection.ws.send(JSON.stringify({
                    type: 'priceUpdate',
                    data: clientPriceData,
                    timestamp: Date.now()
                }));
            }
        } else {
            console.log(`📡 Removing dead connection: ${connectionId}`);
            triangularPriceSubscriptions.delete(connectionId);
        }
    });
}

// Start periodic price broadcasting (every 10 seconds)
setInterval(broadcastTriangularPriceUpdates, 10000);

// Cleanup stale connections (every 60 seconds)
setInterval(() => {
    const now = Date.now();
    triangularPriceSubscriptions.forEach((connection, connectionId) => {
        if (now - connection.lastPing > 120000) { // 2 minutes timeout
            console.log(`📡 Cleaning up stale connection: ${connectionId}`);
            connection.ws.terminate();
            triangularPriceSubscriptions.delete(connectionId);
        }
    });
}, 60000);

// GET /api/v1/trading/valr/triangular/recent-trades
// Get recent triangular trades for feed
router.get('/valr/triangular/recent-trades', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const trades = await getRecentTriangularTrades(req.user.id, limit);
        
        systemLogger.info('Recent triangular trades fetched', {
            userId: req.user.id,
            tradesCount: trades.length
        });

        res.json({
            success: true,
            data: {
                trades: trades,
                count: trades.length,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        systemLogger.error('Failed to fetch recent triangular trades', {
            userId: req.user.id,
            error: error.message
        });
        throw error;
    }
}));

module.exports = router;// VERSION 6 DEPLOYMENT MARKER - Tue, Sep 16, 2025  2:05:16 PM
