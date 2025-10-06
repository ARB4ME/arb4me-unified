/**
 * Price Cache Service
 * Fetches and caches live prices from all exchanges
 * Updates every 5 seconds to provide fresh data for Transfer ARB scanner
 */

const { systemLogger } = require('../utils/logger');

class PriceCacheService {
    constructor() {
        this.cache = new Map();
        this.updateInterval = 5000; // 5 seconds
        this.isRunning = false;
        this.intervalId = null;

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
            }
            // Add more exchanges as needed
        };
    }

    /**
     * Start the price cache service
     */
    start() {
        if (this.isRunning) {
            systemLogger.info('Price cache service already running');
            return;
        }

        this.isRunning = true;
        systemLogger.info('Starting price cache service...');

        // Initial fetch
        this.updateAllPrices();

        // Schedule recurring updates
        this.intervalId = setInterval(() => {
            this.updateAllPrices();
        }, this.updateInterval);

        systemLogger.info(`Price cache service started (updating every ${this.updateInterval}ms)`);
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

    // ============================================
    // Exchange-specific price fetchers
    // ============================================

    /**
     * Fetch all prices from Binance
     */
    async fetchBinancePrices() {
        const response = await fetch('https://api.binance.com/api/v3/ticker/price');

        if (!response.ok) {
            throw new Error(`Binance API error: ${response.status}`);
        }

        const data = await response.json();

        // Convert array to object { symbol: price }
        const prices = {};
        for (const item of data) {
            if (item.symbol.endsWith('USDT')) {
                prices[item.symbol] = parseFloat(item.price);
            }
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
                prices[standardPair] = parseFloat(info.c[0]); // c[0] is last price
            }
        }

        return prices;
    }

    /**
     * Convert Kraken pair format to standard USDT pairs
     */
    krakenPairToStandard(krakenPair) {
        const mapping = {
            'XXBTZUSD': 'BTCUSDT',
            'XETHZUSD': 'ETHUSDT',
            'XRPUSD': 'XRPUSDT',
            'XXLMZUSD': 'XLMUSDT',
            'XLTCZUSD': 'LTCUSDT',
            'TRXUSD': 'TRXUSDT',
            'ADAUSD': 'ADAUSDT',
            'DOTUSD': 'DOTUSDT',
            'USDTZUSD': 'USDTUSDT'
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
            if (ticker.instId.endsWith('-USDT')) {
                const symbol = ticker.instId.replace('-', '');
                prices[symbol] = parseFloat(ticker.last);
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
            if (ticker.symbol.endsWith('USDT')) {
                prices[ticker.symbol] = parseFloat(ticker.lastPrice);
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
            if (item.symbol.endsWith('USDT')) {
                prices[item.symbol] = parseFloat(item.price);
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
            if (ticker.symbol.endsWith('-USDT')) {
                const symbol = ticker.symbol.replace('-', '');
                prices[symbol] = parseFloat(ticker.last);
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
            if (ticker.symbol.endsWith('usdt')) {
                const symbol = ticker.symbol.replace('usdt', 'USDT').toUpperCase();
                prices[symbol] = parseFloat(ticker.close);
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
            if (ticker.currency_pair.endsWith('_USDT')) {
                const symbol = ticker.currency_pair.replace('_', '');
                prices[symbol] = parseFloat(ticker.last);
            }
        }

        return prices;
    }
}

// Create singleton instance
const priceCacheService = new PriceCacheService();

module.exports = priceCacheService;
