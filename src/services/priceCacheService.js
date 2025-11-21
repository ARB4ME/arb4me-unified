/**
 * Price Cache Service
 * Fetches and caches live prices from all exchanges
 * Updates every 5 seconds to provide fresh data for Transfer ARB scanner
 */

const { systemLogger } = require('../utils/logger');
const fetch = require('node-fetch');

class PriceCacheService {
    constructor() {
        this.cache = new Map();
        this.updateInterval = 5000; // 5 seconds
        this.isRunning = false;
        this.intervalId = null;

        // Target currencies for Currency Swap (XRP pairs)
        this.currencySwapTargets = [
            'USDT', 'USDC', 'USD', 'EUR', 'GBP', 'AUD', 'ZAR', 'BTC', 'ETH',
            'BRL', 'TRY', 'UAH', 'NGN', 'RUB', 'JPY', 'CAD', 'CHF', 'AED',
            'DAI', 'TUSD', 'PAX', 'BUSD'
        ];

        // Exchange configurations
        this.exchanges = {
            binance: {
                name: 'Binance',
                baseUrl: 'https://api.binance.com',
                fetchAllPrices: this.fetchBinancePrices.bind(this)
            },
            kraken: {
                name: 'Kraken',
                baseUrl: 'https://api.kraken.com',
                fetchAllPrices: this.fetchKrakenPrices.bind(this)
            },
            okx: {
                name: 'OKX',
                baseUrl: 'https://www.okx.com',
                fetchAllPrices: this.fetchOKXPrices.bind(this)
            },
            bybit: {
                name: 'Bybit',
                baseUrl: 'https://api.bybit.com',
                fetchAllPrices: this.fetchBybitPrices.bind(this)
            },
            mexc: {
                name: 'MEXC',
                baseUrl: 'https://api.mexc.com',
                fetchAllPrices: this.fetchMEXCPrices.bind(this)
            },
            kucoin: {
                name: 'KuCoin',
                baseUrl: 'https://api.kucoin.com',
                fetchAllPrices: this.fetchKuCoinPrices.bind(this)
            },
            htx: {
                name: 'HTX',
                baseUrl: 'https://api.huobi.pro',
                fetchAllPrices: this.fetchHTXPrices.bind(this)
            },
            gateio: {
                name: 'Gate.io',
                baseUrl: 'https://api.gateio.ws',
                fetchAllPrices: this.fetchGateIOPrices.bind(this)
            },
            bitget: {
                name: 'Bitget',
                baseUrl: 'https://api.bitget.com',
                fetchAllPrices: this.fetchBitgetPrices.bind(this)
            },
            gemini: {
                name: 'Gemini',
                baseUrl: 'https://api.gemini.com',
                fetchAllPrices: this.fetchGeminiPrices.bind(this)
            },
            bingx: {
                name: 'BingX',
                baseUrl: 'https://open-api.bingx.com',
                fetchAllPrices: this.fetchBingXPrices.bind(this)
            },
            bitmart: {
                name: 'BitMart',
                baseUrl: 'https://api-cloud.bitmart.com',
                fetchAllPrices: this.fetchBitMartPrices.bind(this)
            },
            bitrue: {
                name: 'Bitrue',
                baseUrl: 'https://www.bitrue.com',
                fetchAllPrices: this.fetchBitruePrices.bind(this)
            },
            ascendex: {
                name: 'AscendEX',
                baseUrl: 'https://ascendex.com',
                fetchAllPrices: this.fetchAscendEXPrices.bind(this)
            },
            xt: {
                name: 'XT',
                baseUrl: 'https://sapi.xt.com',
                fetchAllPrices: this.fetchXTPrices.bind(this)
            },
            coincatch: {
                name: 'CoinCatch',
                baseUrl: 'https://api.coincatch.com',
                fetchAllPrices: this.fetchCoinCatchPrices.bind(this)
            },
            valr: {
                name: 'VALR',
                baseUrl: 'https://api.valr.com',
                fetchAllPrices: this.fetchVALRPrices.bind(this)
            },
            luno: {
                name: 'Luno',
                baseUrl: 'https://api.luno.com',
                fetchAllPrices: this.fetchLunoPrices.bind(this)
            },
            chainex: {
                name: 'ChainEX',
                baseUrl: 'https://api.chainex.io',
                fetchAllPrices: this.fetchChainEXPrices.bind(this)
            }
        };
    }

    /**
     * Start the price cache service
     */
    start() {
        if (this.isRunning) {
            systemLogger.trading('Price cache service already running');
            return;
        }

        this.isRunning = true;
        systemLogger.trading('🚀 Starting price cache service...');

        // Check if fetch is available
        if (typeof fetch === 'undefined') {
            systemLogger.error('❌ CRITICAL: fetch is not available! Trying to require node-fetch...');
            try {
                global.fetch = require('node-fetch');
                systemLogger.trading('✅ node-fetch loaded successfully');
            } catch (err) {
                systemLogger.error('❌ CRITICAL: node-fetch not installed!', { error: err.message });
                return;
            }
        }

        // Initial fetch
        this.updateAllPrices().catch(err => {
            systemLogger.error('Initial price fetch failed', { error: err.message });
        });

        // Schedule recurring updates
        this.intervalId = setInterval(() => {
            this.updateAllPrices().catch(err => {
                systemLogger.error('Scheduled price fetch failed', { error: err.message });
            });
        }, this.updateInterval);

        systemLogger.trading(`✅ Price cache service started (updating every ${this.updateInterval}ms from ${Object.keys(this.exchanges).length} exchanges)`);
    }

    /**
     * Stop the price cache service
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        systemLogger.info('Price cache service stopped');
    }

    /**
     * Update prices for all exchanges
     */
    async updateAllPrices() {
        const startTime = Date.now();
        const results = [];

        // Fetch all exchange prices in parallel
        for (const [exchangeId, config] of Object.entries(this.exchanges)) {
            results.push(
                this.updateExchangePrices(exchangeId, config)
                    .catch(error => {
                        systemLogger.error(`Failed to update ${config.name} prices`, {
                            exchange: exchangeId,
                            error: error.message
                        });
                    })
            );
        }

        await Promise.allSettled(results);

        const duration = Date.now() - startTime;
        systemLogger.trading('Price cache updated', {
            duration: `${duration}ms`,
            exchanges: Object.keys(this.exchanges).length,
            cacheSize: this.cache.size
        });
    }

    /**
     * Update prices for a specific exchange
     */
    async updateExchangePrices(exchangeId, config) {
        try {
            const prices = await config.fetchAllPrices();

            this.cache.set(exchangeId, {
                exchange: exchangeId,
                name: config.name,
                prices: prices,
                lastUpdated: Date.now(),
                ttl: this.updateInterval
            });

            systemLogger.trading(`${config.name} prices cached`, {
                exchange: exchangeId,
                pairCount: Object.keys(prices).length
            });

        } catch (error) {
            throw new Error(`${config.name} price fetch failed: ${error.message}`);
        }
    }

    /**
     * Get cached prices for specific exchange and cryptos
     */
    getPrices(exchangeId, cryptos = null) {
        const cached = this.cache.get(exchangeId);

        if (!cached) {
            return null;
        }

        // Check if cache is stale
        const age = Date.now() - cached.lastUpdated;
        if (age > cached.ttl * 2) {
            systemLogger.warn(`Stale cache for ${exchangeId}`, {
                age: `${age}ms`,
                ttl: `${cached.ttl}ms`
            });
        }

        // Return all prices or filter by cryptos
        if (!cryptos || cryptos.length === 0) {
            return cached.prices;
        }

        const filtered = {};
        for (const crypto of cryptos) {
            const symbol = `${crypto}USDT`;
            if (cached.prices[symbol]) {
                filtered[symbol] = cached.prices[symbol];
            }
        }

        return filtered;
    }

    /**
     * Get all cached data
     */
    getAllCachedData() {
        const data = {};
        for (const [exchangeId, cached] of this.cache.entries()) {
            data[exchangeId] = {
                name: cached.name,
                priceCount: Object.keys(cached.prices).length,
                lastUpdated: cached.lastUpdated,
                age: Date.now() - cached.lastUpdated
            };
        }
        return data;
    }

    /**
     * Check if a trading pair should be cached for Currency Swap
     * Returns true if it's either a USDT pair (for Transfer Arb) or an XRP pair with target currency
     */
    shouldCachePair(symbol) {
        // Cache all USDT pairs for Transfer Arb (backward compatibility)
        if (symbol.endsWith('USDT')) {
            return true;
        }

        // Cache XRP pairs with target currencies for Currency Swap
        if (symbol.startsWith('XRP')) {
            for (const currency of this.currencySwapTargets) {
                if (symbol === `XRP${currency}`) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Get fiat-crypto pair price from specific exchange
     * Returns null if pair not available
     */
    async getFiatCryptoPrice(exchange, crypto, fiat) {
        const pair = `${crypto}${fiat}`;
        const pairAlt = `${crypto}/${fiat}`;

        try {
            let price = null;

            switch (exchange.toLowerCase()) {
                case 'valr':
                    price = await this.fetchVALRPrice(pair);
                    break;
                case 'luno':
                    price = await this.fetchLunoPrice(crypto, fiat);
                    break;
                case 'chainex':
                    price = await this.fetchChainEXPrice(crypto, fiat);
                    break;
                case 'kraken':
                    price = await this.fetchKrakenFiatPrice(crypto, fiat);
                    break;
                case 'bybit':
                case 'okx':
                case 'kucoin':
                case 'gate':
                case 'mexc':
                case 'htx':
                case 'binance':
                    // These exchanges support fiat via their standard APIs
                    price = await this.fetchGenericFiatPrice(exchange, crypto, fiat);
                    break;
                default:
                    systemLogger.warn(`Exchange ${exchange} fiat price fetching not implemented`);
                    return null;
            }

            return price;

        } catch (error) {
            systemLogger.error(`Failed to fetch ${crypto}/${fiat} from ${exchange}`, {
                error: error.message
            });
            return null;
        }
    }

    /**
     * Fetch VALR fiat-crypto price
     */
    async fetchVALRPrice(pair) {
        // VALR uses pairs like XRPZAR, USDTZAR
        const response = await fetch(`https://api.valr.com/v1/public/${pair}/markprice`);

        if (!response.ok) {
            throw new Error(`VALR API error: ${response.status}`);
        }

        const data = await response.json();
        return parseFloat(data.markPrice);
    }

    /**
     * Fetch Luno fiat-crypto price
     */
    async fetchLunoPrice(crypto, fiat) {
        // Luno uses pairs like XRPZAR
        const pair = `${crypto}${fiat}`;
        const response = await fetch(`https://api.luno.com/api/1/ticker?pair=${pair}`);

        if (!response.ok) {
            throw new Error(`Luno API error: ${response.status}`);
        }

        const data = await response.json();
        return parseFloat(data.last_trade);
    }

    /**
     * Fetch ChainEX fiat-crypto price
     */
    async fetchChainEXPrice(crypto, fiat) {
        // ChainEX public API endpoint (if available)
        // Note: May need to check ChainEX docs for public ticker endpoint
        const pair = `${crypto}_${fiat}`;
        const response = await fetch(`https://api.chainex.io/v1/ticker/${pair}`);

        if (!response.ok) {
            throw new Error(`ChainEX API error: ${response.status}`);
        }

        const data = await response.json();
        return parseFloat(data.last);
    }

    /**
     * Fetch Kraken fiat-crypto price
     */
    async fetchKrakenFiatPrice(crypto, fiat) {
        // Kraken supports various fiat pairs
        // Map standard names to Kraken format
        const krakenPair = this.toKrakenFiatPair(crypto, fiat);

        const response = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`);

        if (!response.ok) {
            throw new Error(`Kraken API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.error && data.error.length > 0) {
            throw new Error(`Kraken API error: ${data.error.join(', ')}`);
        }

        // Get first (and only) result
        const result = Object.values(data.result)[0];
        return parseFloat(result.c[0]); // last trade closed
    }

    /**
     * Convert standard pair to Kraken format
     */
    toKrakenFiatPair(crypto, fiat) {
        // Kraken uses X prefix for crypto, Z prefix for fiat
        const cryptoMap = {
            'XRP': 'XRP',
            'BTC': 'XBT',
            'ETH': 'ETH',
            'USDT': 'USDT',
            'USDC': 'USDC'
        };

        const fiatMap = {
            'USD': 'USD',
            'EUR': 'EUR',
            'GBP': 'GBP',
            'ZAR': 'ZAR',
            'AUD': 'AUD',
            'CAD': 'CAD'
        };

        return `${cryptoMap[crypto] || crypto}${fiatMap[fiat] || fiat}`;
    }

    /**
     * Fetch generic fiat price from exchanges that support standard APIs
     */
    async fetchGenericFiatPrice(exchange, crypto, fiat) {
        let url, parseFunc;

        switch (exchange.toLowerCase()) {
            case 'bybit':
                url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${crypto}${fiat}`;
                parseFunc = (data) => parseFloat(data.result.list[0].lastPrice);
                break;

            case 'okx':
                url = `https://www.okx.com/api/v5/market/ticker?instId=${crypto}-${fiat}`;
                parseFunc = (data) => parseFloat(data.data[0].last);
                break;

            case 'kucoin':
                url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${crypto}-${fiat}`;
                parseFunc = (data) => parseFloat(data.data.price);
                break;

            case 'gate':
                url = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${crypto}_${fiat}`;
                parseFunc = (data) => parseFloat(data[0].last);
                break;

            case 'mexc':
                url = `https://api.mexc.com/api/v3/ticker/price?symbol=${crypto}${fiat}`;
                parseFunc = (data) => parseFloat(data.price);
                break;

            case 'binance':
                url = `https://api.binance.com/api/v3/ticker/price?symbol=${crypto}${fiat}`;
                parseFunc = (data) => parseFloat(data.price);
                break;

            default:
                throw new Error(`Exchange ${exchange} not supported for generic fiat prices`);
        }

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`${exchange} API error: ${response.status}`);
        }

        const data = await response.json();
        return parseFunc(data);
    }

    // ============================================
    // Exchange-specific price fetchers
    // ============================================

    /**
     * Fetch all prices from Binance
     */
    async fetchBinancePrices() {
        // Fetch BOTH price ticker AND book ticker for liquidity validation
        const [priceResponse, bookResponse] = await Promise.all([
            fetch('https://api.binance.com/api/v3/ticker/price'),
            fetch('https://api.binance.com/api/v3/ticker/bookTicker')
        ]);

        if (!priceResponse.ok) {
            throw new Error(`Binance API error: ${priceResponse.status}`);
        }

        const data = await priceResponse.json();
        const bookData = await (bookResponse.ok ? bookResponse.json() : Promise.resolve([]));

        // Convert array to object { symbol: price }
        // Cache USDT pairs (Transfer Arb) and XRP pairs (Currency Swap)
        const prices = {};
        let xrpPairCount = 0;
        let rejectedCount = 0;

        // Create book ticker lookup for liquidity validation
        const bookTickers = {};
        for (const book of bookData) {
            bookTickers[book.symbol] = {
                bid: parseFloat(book.bidPrice || 0),
                ask: parseFloat(book.askPrice || 0)
            };
        }

        // First pass: Cache all prices WITH liquidity validation
        for (const item of data) {
            if (this.shouldCachePair(item.symbol)) {
                const price = parseFloat(item.price);
                const book = bookTickers[item.symbol];

                // REJECT pairs with zero bid/ask (no liquidity)
                if (book && (book.bid === 0 || book.ask === 0)) {
                    systemLogger.warn(`[PRICE CACHE] ⚠️ Binance ${item.symbol} REJECTED - no liquidity (bid=${book.bid}, ask=${book.ask})`);
                    rejectedCount++;
                    continue;
                }

                // Store price with bid/ask spread for cross-exchange arbitrage
                prices[item.symbol] = {
                    price: price,
                    bid: book ? book.bid : price,
                    ask: book ? book.ask : price
                };
            }
        }

        // Get XRPUSDT reference price for validation
        const xrpUsdtData = prices['XRPUSDT'];
        const xrpUsdtPrice = xrpUsdtData ? xrpUsdtData.price : null;

        if (!xrpUsdtPrice || xrpUsdtPrice <= 0) {
            systemLogger.error('[PRICE CACHE] Binance XRPUSDT price missing - cannot validate other XRP pairs');
            return prices;
        }

        // Second pass: Validate non-USDT XRP pairs against USDT cross rates
        for (const symbol of Object.keys(prices)) {
            if (symbol.startsWith('XRP') && !symbol.endsWith('USDT') && !symbol.endsWith('USDC')) {
                const currency = symbol.replace('XRP', ''); // Extract currency (AUD, GBP, EUR, etc.)
                const currencyUsdtPair = `${currency}USDT`; // e.g., AUDUSDT, GBPUSDT
                const currencyUsdtData = prices[currencyUsdtPair];
                const currencyUsdtPrice = currencyUsdtData ? currencyUsdtData.price : null;

                // Calculate expected XRP price in this currency
                let expectedPrice = null;
                let isInverted = false;

                if (currencyUsdtPrice && currencyUsdtPrice > 0) {
                    const actualPrice = prices[symbol].price;

                    // Calculate both standard and inverted expected prices
                    const standardExpected = xrpUsdtPrice / currencyUsdtPrice; // XRP/CURRENCY
                    const invertedExpected = currencyUsdtPrice / xrpUsdtPrice; // CURRENCY/XRP

                    // Calculate deviations for both
                    const standardDeviation = Math.abs((actualPrice - standardExpected) / standardExpected * 100);
                    const invertedDeviation = Math.abs((actualPrice - invertedExpected) / invertedExpected * 100);

                    // Use whichever calculation has lower deviation (handles inverted pairs like GBP)
                    if (invertedDeviation < standardDeviation) {
                        expectedPrice = invertedExpected;
                        isInverted = true;
                    } else {
                        expectedPrice = standardExpected;
                        isInverted = false;
                    }
                }

                if (expectedPrice) {
                    const actualPrice = prices[symbol].price;
                    const percentDiff = Math.abs((actualPrice - expectedPrice) / expectedPrice * 100);

                    // Reject if price differs by more than 30% from expected (indicates stale/fake price)
                    if (percentDiff > 30) {
                        systemLogger.warn(`[PRICE CACHE] ⚠️ Binance ${symbol} REJECTED - price deviation ${percentDiff.toFixed(1)}%`, {
                            actual: actualPrice.toFixed(6),
                            expected: expectedPrice.toFixed(6),
                            inverted: isInverted,
                            xrpUsdt: xrpUsdtPrice,
                            currencyUsdt: currencyUsdtPrice
                        });
                        delete prices[symbol]; // Remove invalid price
                        rejectedCount++;
                    } else {
                        // NORMALIZE inverted pairs to standard XRP/CURRENCY format
                        if (isInverted) {
                            const originalPrice = actualPrice;
                            const normalizedPrice = 1 / actualPrice;
                            prices[symbol] = normalizedPrice;
                            systemLogger.trading(`[PRICE CACHE] ✅ Binance ${symbol}: ${originalPrice.toFixed(6)} → ${normalizedPrice.toFixed(6)} (normalized from inverted, deviation: ${percentDiff.toFixed(1)}%)`);
                        } else {
                            systemLogger.trading(`[PRICE CACHE] ✅ Binance ${symbol}: ${actualPrice.toFixed(6)} (deviation: ${percentDiff.toFixed(1)}%)`);
                        }
                        xrpPairCount++;
                    }
                } else {
                    // Cannot validate without currency USDT pair - log and keep the price
                    xrpPairCount++;
                    systemLogger.trading(`[PRICE CACHE] Binance cached ${symbol}: ${prices[symbol]} (no validation - missing ${currencyUsdtPair})`);
                }
            }
        }

        if (xrpPairCount > 0 || rejectedCount > 0) {
            systemLogger.trading(`[PRICE CACHE] Binance XRP pairs: ${xrpPairCount} cached, ${rejectedCount} rejected (no liquidity or >30% deviation)`);
        }

        return prices;
    }

    /**
     * Fetch all prices from Kraken
     */
    async fetchKrakenPrices() {
        const response = await fetch('https://api.kraken.com/0/public/Ticker');

        if (!response.ok) {
            throw new Error(`Kraken API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.error && data.error.length > 0) {
            throw new Error(`Kraken API error: ${data.error.join(', ')}`);
        }

        // Convert Kraken format to standard
        const prices = {};
        for (const [pair, info] of Object.entries(data.result)) {
            // Kraken uses different naming (XXBTZUSD, XETHZUSD, etc.)
            // Map to standard format (BTCUSDT, ETHUSDT, etc.)
            const standardPair = this.krakenPairToStandard(pair);
            if (standardPair) {
                const price = parseFloat(info.c[0]); // c[0] is last price
                const bid = parseFloat(info.b[0]); // b[0] is best bid
                const ask = parseFloat(info.a[0]); // a[0] is best ask

                // Store with bid/ask spread for cross-exchange arbitrage
                prices[standardPair] = {
                    price: price,
                    bid: bid || price * 0.999,  // Fallback to -0.1% if no bid
                    ask: ask || price * 1.001   // Fallback to +0.1% if no ask
                };
            }
        }

        return prices;
    }

    /**
     * Convert Kraken pair format to standard format
     * Now includes XRP pairs with multiple currencies for Currency Swap
     */
    krakenPairToStandard(krakenPair) {
        const mapping = {
            // Standard USDT pairs for Transfer Arb
            'XXBTZUSD': 'BTCUSDT',
            'XETHZUSD': 'ETHUSDT',
            'XRPUSD': 'XRPUSDT',
            'XXLMZUSD': 'XLMUSDT',
            'XLTCZUSD': 'LTCUSDT',
            'TRXUSD': 'TRXUSDT',
            'ADAUSD': 'ADAUSDT',
            'DOTUSD': 'DOTUSDT',
            'USDTZUSD': 'USDTUSDT',

            // XRP pairs with multiple currencies for Currency Swap
            'XXRPZUSD': 'XRPUSD',      // XRP/USD
            'XRPUSDT': 'XRPUSDT',      // XRP/USDT
            'XXRPZEUR': 'XRPEUR',      // XRP/EUR
            'XRPEUR': 'XRPEUR',        // XRP/EUR alternative
            'XXRPZGBP': 'XRPGBP',      // XRP/GBP
            'XRPGBP': 'XRPGBP',        // XRP/GBP alternative
            'XXRPZAUD': 'XRPAUD',      // XRP/AUD
            'XRPAUD': 'XRPAUD',        // XRP/AUD alternative
            'XXRPZJPY': 'XRPJPY',      // XRP/JPY
            'XXRPZCAD': 'XRPCAD',      // XRP/CAD
            'XXRPXXBT': 'XRPBTC',      // XRP/BTC
            'XXRPXETH': 'XRPETH'       // XRP/ETH
        };

        return mapping[krakenPair] || null;
    }

    /**
     * Fetch all prices from OKX
     */
    async fetchOKXPrices() {
        const response = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT');

        if (!response.ok) {
            throw new Error(`OKX API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== '0') {
            throw new Error(`OKX API error: ${data.msg}`);
        }

        const prices = {};
        for (const ticker of data.data) {
            // OKX uses format like XRP-USDT, convert to XRPUSDT
            const symbol = ticker.instId.replace('-', '');
            if (this.shouldCachePair(symbol)) {
                const price = parseFloat(ticker.last);
                const bid = parseFloat(ticker.bidPx || 0);
                const ask = parseFloat(ticker.askPx || 0);

                // Store with bid/ask spread for cross-exchange arbitrage
                prices[symbol] = {
                    price: price,
                    bid: (bid > 0) ? bid : price * 0.999,  // Use real bid or estimate -0.1%
                    ask: (ask > 0) ? ask : price * 1.001   // Use real ask or estimate +0.1%
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from Bybit
     */
    async fetchBybitPrices() {
        const response = await fetch('https://api.bybit.com/v5/market/tickers?category=spot');

        if (!response.ok) {
            throw new Error(`Bybit API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.retCode !== 0) {
            throw new Error(`Bybit API error: ${data.retMsg}`);
        }

        const prices = {};
        for (const ticker of data.result.list) {
            if (this.shouldCachePair(ticker.symbol)) {
                const price = parseFloat(ticker.lastPrice);
                const bid = parseFloat(ticker.bid1Price || 0);
                const ask = parseFloat(ticker.ask1Price || 0);

                // Store with bid/ask spread for cross-exchange arbitrage
                prices[ticker.symbol] = {
                    price: price,
                    bid: (bid > 0) ? bid : price * 0.999,  // Use real bid or estimate -0.1%
                    ask: (ask > 0) ? ask : price * 1.001   // Use real ask or estimate +0.1%
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from MEXC
     */
    async fetchMEXCPrices() {
        const response = await fetch('https://api.mexc.com/api/v3/ticker/price');

        if (!response.ok) {
            throw new Error(`MEXC API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const item of data) {
            if (this.shouldCachePair(item.symbol)) {
                const price = parseFloat(item.price);

                // MEXC /ticker/price doesn't provide bid/ask, estimate spread
                // Store with bid/ask spread for cross-exchange arbitrage
                prices[item.symbol] = {
                    price: price,
                    bid: price * 0.999,  // Estimate -0.1% for bid
                    ask: price * 1.001   // Estimate +0.1% for ask
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from KuCoin
     */
    async fetchKuCoinPrices() {
        const response = await fetch('https://api.kucoin.com/api/v1/market/allTickers');

        if (!response.ok) {
            throw new Error(`KuCoin API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== '200000') {
            throw new Error(`KuCoin API error: ${data.msg}`);
        }

        const prices = {};
        for (const ticker of data.data.ticker) {
            // KuCoin uses format like XRP-USDT, convert to XRPUSDT
            const symbol = ticker.symbol.replace('-', '');
            if (this.shouldCachePair(symbol)) {
                const price = parseFloat(ticker.last);
                const bid = parseFloat(ticker.buy || 0);
                const ask = parseFloat(ticker.sell || 0);

                // Store with bid/ask spread for cross-exchange arbitrage
                prices[symbol] = {
                    price: price,
                    bid: (bid > 0) ? bid : price * 0.999,  // Use real bid or estimate -0.1%
                    ask: (ask > 0) ? ask : price * 1.001   // Use real ask or estimate +0.1%
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from HTX (Huobi)
     */
    async fetchHTXPrices() {
        const response = await fetch('https://api.huobi.pro/market/tickers');

        if (!response.ok) {
            throw new Error(`HTX API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.status !== 'ok') {
            throw new Error(`HTX API error: ${data['err-msg']}`);
        }

        const prices = {};
        for (const ticker of data.data) {
            // HTX uses lowercase like xrpusdt, convert to XRPUSDT
            const symbol = ticker.symbol.toUpperCase();
            if (this.shouldCachePair(symbol)) {
                const price = parseFloat(ticker.close);
                prices[symbol] = {
                    price: price,
                    bid: price * 0.999,
                    ask: price * 1.001
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from Gate.io
     */
    async fetchGateIOPrices() {
        const response = await fetch('https://api.gateio.ws/api/v4/spot/tickers');

        if (!response.ok) {
            throw new Error(`Gate.io API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const ticker of data) {
            // Gate.io uses format like XRP_USDT, convert to XRPUSDT
            const symbol = ticker.currency_pair.replace('_', '');
            if (this.shouldCachePair(symbol)) {
                const price = parseFloat(ticker.last);
                prices[symbol] = {
                    price: price,
                    bid: price * 0.999,
                    ask: price * 1.001
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from Bitget
     */
    async fetchBitgetPrices() {
        const response = await fetch('https://api.bitget.com/api/spot/v1/market/tickers');

        if (!response.ok) {
            throw new Error(`Bitget API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== '00000') {
            throw new Error(`Bitget API error: ${data.msg}`);
        }

        const prices = {};
        for (const ticker of data.data) {
            if (ticker.symbol && this.shouldCachePair(ticker.symbol)) {
                const price = parseFloat(ticker.close);
                prices[ticker.symbol] = {
                    price: price,
                    bid: price * 0.999,
                    ask: price * 1.001
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from Gemini
     */
    async fetchGeminiPrices() {
        const response = await fetch('https://api.gemini.com/v1/pricefeed');

        if (!response.ok) {
            throw new Error(`Gemini API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const ticker of data) {
            if (ticker.pair) {
                // Gemini format: XRPUSD, BTCUSD - check all target currencies
                const pairUpper = ticker.pair.toUpperCase();
                if (this.shouldCachePair(pairUpper)) {
                    const price = parseFloat(ticker.price);
                    prices[pairUpper] = {
                        price: price,
                        bid: price * 0.999,
                        ask: price * 1.001
                    };
                }
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from BingX
     */
    async fetchBingXPrices() {
        // Using perpetual futures endpoint (has bid/ask and no auth required)
        const response = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker');

        if (!response.ok) {
            throw new Error(`BingX API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== 0) {
            throw new Error(`BingX API error: ${data.msg || 'Unknown error'}`);
        }

        const prices = {};
        for (const ticker of data.data) {
            if (ticker.symbol) {
                // BingX uses format like XRP-USDT, convert to XRPUSDT
                const symbol = ticker.symbol.replace('-', '');
                if (this.shouldCachePair(symbol)) {
                    const price = parseFloat(ticker.lastPrice);
                    const bid = parseFloat(ticker.bidPrice || 0);
                    const ask = parseFloat(ticker.askPrice || 0);

                    prices[symbol] = {
                        price: price,
                        bid: (bid > 0) ? bid : price * 0.999,  // Use real bid or estimate
                        ask: (ask > 0) ? ask : price * 1.001   // Use real ask or estimate
                    };
                }
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from BitMart
     */
    async fetchBitMartPrices() {
        const response = await fetch('https://api-cloud.bitmart.com/spot/v1/ticker');

        if (!response.ok) {
            throw new Error(`BitMart API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== 1000) {
            throw new Error(`BitMart API error: ${data.message}`);
        }

        const prices = {};
        for (const ticker of data.data.tickers) {
            if (ticker.symbol) {
                // BitMart uses format like XRP_USDT, convert to XRPUSDT
                const symbol = ticker.symbol.replace('_', '');
                if (this.shouldCachePair(symbol)) {
                    const price = parseFloat(ticker.last_price);
                    prices[symbol] = {
                        price: price,
                        bid: price * 0.999,
                        ask: price * 1.001
                    };
                }
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from Bitrue
     */
    async fetchBitruePrices() {
        const response = await fetch('https://api.bitrue.com/api/v1/ticker/24hr');

        if (!response.ok) {
            throw new Error(`Bitrue API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const ticker of data) {
            if (ticker.symbol && this.shouldCachePair(ticker.symbol)) {
                const price = parseFloat(ticker.lastPrice);
                prices[ticker.symbol] = {
                    price: price,
                    bid: price * 0.999,
                    ask: price * 1.001
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from AscendEX
     */
    async fetchAscendEXPrices() {
        const response = await fetch('https://ascendex.com/api/pro/v1/ticker');

        if (!response.ok) {
            throw new Error(`AscendEX API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== 0) {
            throw new Error(`AscendEX API error: ${data.message}`);
        }

        const prices = {};
        for (const ticker of data.data) {
            if (ticker.symbol) {
                // AscendEX uses format like XRP/USDT, convert to XRPUSDT
                const symbol = ticker.symbol.replace('/', '');
                if (this.shouldCachePair(symbol)) {
                    const price = parseFloat(ticker.close);
                    prices[symbol] = {
                        price: price,
                        bid: price * 0.999,
                        ask: price * 1.001
                    };
                }
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from XT
     */
    async fetchXTPrices() {
        const response = await fetch('https://sapi.xt.com/v4/public/ticker/24h');

        if (!response.ok) {
            throw new Error(`XT API error: ${response.status}`);
        }

        const data = await response.json();

        if (!data.result) {
            throw new Error(`XT API error: Invalid response`);
        }

        const prices = {};
        for (const ticker of data.result) {
            if (ticker.s) {
                // XT uses format like xrp_usdt (lowercase), convert to XRPUSDT (uppercase)
                const symbol = ticker.s.replace('_', '').toUpperCase();
                if (this.shouldCachePair(symbol)) {
                    const price = parseFloat(ticker.c);
                    prices[symbol] = {
                        price: price,
                        bid: price * 0.999,
                        ask: price * 1.001
                    };
                }
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from CoinCatch (SPOT market)
     */
    async fetchCoinCatchPrices() {
        const response = await fetch('https://api.coincatch.com/api/spot/v1/market/tickers');

        if (!response.ok) {
            throw new Error(`CoinCatch API error: ${response.status}`);
        }

        const data = await response.json();

        if (data.code !== '00000') {
            throw new Error(`CoinCatch API error: ${data.msg || 'Unknown error'}`);
        }

        const prices = {};
        for (const ticker of data.data) {
            if (ticker.symbol && this.shouldCachePair(ticker.symbol)) {
                const price = parseFloat(ticker.close);
                const bid = parseFloat(ticker.buyOne || 0);
                const ask = parseFloat(ticker.sellOne || 0);

                prices[ticker.symbol] = {
                    price: price,
                    bid: (bid > 0) ? bid : price * 0.999,
                    ask: (ask > 0) ? ask : price * 1.001
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from VALR (South African Exchange)
     * Important for ZAR pairs!
     */
    async fetchVALRPrices() {
        const response = await fetch('https://api.valr.com/v1/public/marketsummary');

        if (!response.ok) {
            throw new Error(`VALR API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const ticker of data) {
            if (ticker.currencyPair) {
                // VALR uses format like XRP-ZAR, XRP-USDT, convert to XRPZAR, XRPUSDT
                const symbol = ticker.currencyPair.replace('-', '');
                if (this.shouldCachePair(symbol)) {
                    const price = parseFloat(ticker.lastTradedPrice);
                    prices[symbol] = {
                        price: price,
                        bid: price * 0.999,
                        ask: price * 1.001
                    };
                }
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from Luno (South African Exchange)
     * Important for ZAR pairs!
     */
    async fetchLunoPrices() {
        const response = await fetch('https://api.luno.com/api/1/tickers');

        if (!response.ok) {
            throw new Error(`Luno API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const ticker of data.tickers) {
            if (ticker.pair && this.shouldCachePair(ticker.pair)) {
                const price = parseFloat(ticker.last_trade);
                prices[ticker.pair] = {
                    price: price,
                    bid: price * 0.999,
                    ask: price * 1.001
                };
            }
        }

        return prices;
    }

    /**
     * Fetch all prices from ChainEX (South African Exchange)
     * Important for ZAR pairs!
     */
    async fetchChainEXPrices() {
        const response = await fetch('https://api.chainex.io/v1/tickers');

        if (!response.ok) {
            throw new Error(`ChainEX API error: ${response.status}`);
        }

        const data = await response.json();

        const prices = {};
        for (const ticker of data) {
            if (ticker.symbol) {
                // ChainEX uses format like XRP/ZAR, XRP/USDT, convert to XRPZAR, XRPUSDT
                const symbol = ticker.symbol.replace('/', '');
                if (this.shouldCachePair(symbol)) {
                    const price = parseFloat(ticker.last);
                    prices[symbol] = {
                        price: price,
                        bid: price * 0.999,
                        ask: price * 1.001
                    };
                }
            }
        }

        return prices;
    }
}

// Create singleton instance
const priceCacheService = new PriceCacheService();

module.exports = priceCacheService;
