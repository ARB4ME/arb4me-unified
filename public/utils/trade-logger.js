/**
 * ARB4ME Trade Logger Service
 * Unified backend trade logging for all strategies and exchanges
 *
 * Supports:
 * - 4 Strategies: Cross Exchange, Triangular, Transfer, Currency Swap, Momentum
 * - 20 Exchanges: VALR, MEXC, Gate.io, Crypto.com, XT, AscendEX, BingX, Bitget,
 *                 BitMart, Bitrue, Gemini, Coincatch, Luno, ChainEX, Kraken,
 *                 Binance, Bybit, OKX, KuCoin, HTX
 *
 * Usage:
 *   <script src="/utils/trade-logger.js"></script>
 *
 *   logTradeToBackend({
 *       strategy: 'triangular',
 *       exchange: 'VALR',
 *       asset: 'BTC→ETH→USDT',
 *       amount: 1000,
 *       profit: 15.50,
 *       fees: 2.00
 *   });
 */

(function(window) {
    'use strict';

    /**
     * Exchange name normalization map
     * Ensures consistent naming regardless of how exchange is referenced
     */
    const EXCHANGE_MAP = {
        'valr': 'VALR',
        'VALR': 'VALR',
        'mexc': 'MEXC',
        'MEXC': 'MEXC',
        'gateio': 'Gate.io',
        'gate.io': 'Gate.io',
        'Gate.io': 'Gate.io',
        'cryptocom': 'Crypto.com',
        'crypto.com': 'Crypto.com',
        'Crypto.com': 'Crypto.com',
        'xt': 'XT',
        'XT': 'XT',
        'ascendex': 'AscendEX',
        'AscendEX': 'AscendEX',
        'bingx': 'BingX',
        'BingX': 'BingX',
        'bitget': 'Bitget',
        'Bitget': 'Bitget',
        'bitmart': 'BitMart',
        'BitMart': 'BitMart',
        'bitrue': 'Bitrue',
        'Bitrue': 'Bitrue',
        'gemini': 'Gemini',
        'Gemini': 'Gemini',
        'coincatch': 'Coincatch',
        'Coincatch': 'Coincatch',
        'luno': 'Luno',
        'Luno': 'Luno',
        'chainex': 'ChainEX',
        'ChainEX': 'ChainEX',
        'kraken': 'Kraken',
        'Kraken': 'Kraken',
        'binance': 'Binance',
        'Binance': 'Binance',
        'bybit': 'Bybit',
        'Bybit': 'Bybit',
        'okx': 'OKX',
        'OKX': 'OKX',
        'kucoin': 'KuCoin',
        'KuCoin': 'KuCoin',
        'htx': 'HTX',
        'HTX': 'HTX'
    };

    /**
     * Strategy name normalization
     */
    const STRATEGY_MAP = {
        'cross_exchange': 'cross_exchange',
        'cross-exchange': 'cross_exchange',
        'crossexchange': 'cross_exchange',
        'triangular': 'triangular',
        'transfer': 'transfer',
        'currency_swap': 'currency_swap',
        'currency-swap': 'currency_swap',
        'currencyswap': 'currency_swap',
        'momentum': 'momentum'
    };

    /**
     * Log trade to backend for multi-user profit tracking and billing
     *
     * @param {Object} tradeData - Trade information
     * @param {string} tradeData.strategy - Strategy name (cross_exchange, triangular, transfer, currency_swap, momentum)
     * @param {string} tradeData.exchange - Exchange name (VALR, Binance, etc.)
     * @param {string} tradeData.asset - Asset/path identifier (e.g., 'BTC', 'BTC→ETH→USDT')
     * @param {number} tradeData.amount - Trade amount in USDT
     * @param {number} tradeData.profit - Profit/loss in USDT
     * @param {number} [tradeData.fees=0] - Trading fees in USDT
     * @param {number} [tradeData.buyPrice=0] - Buy price (for cross-exchange)
     * @param {number} [tradeData.sellPrice=0] - Sell price (for cross-exchange)
     * @param {string} [tradeData.buyExchange] - Buy exchange (defaults to exchange param)
     * @param {string} [tradeData.sellExchange] - Sell exchange (defaults to exchange param)
     * @param {boolean} [tradeData.successful=true] - Whether trade succeeded
     * @param {Object} [tradeData.metadata] - Additional metadata to store
     *
     * @returns {Promise<Object>} Result object { success, data/error }
     */
    async function logTradeToBackend(tradeData) {
        try {
            // Validate required parameters
            if (!tradeData.strategy) {
                console.error('❌ Trade logging failed: strategy is required');
                return { success: false, reason: 'missing_strategy' };
            }

            if (!tradeData.exchange) {
                console.error('❌ Trade logging failed: exchange is required');
                return { success: false, reason: 'missing_exchange' };
            }

            // Check JWT token
            const token = localStorage.getItem('arb4me_jwt_token');
            if (!token) {
                console.warn('⚠️ No JWT token - trade logged locally only');
                return { success: false, reason: 'no_token' };
            }

            // Normalize exchange and strategy names
            const normalizedExchange = EXCHANGE_MAP[tradeData.exchange] || tradeData.exchange;
            const normalizedStrategy = STRATEGY_MAP[tradeData.strategy.toLowerCase()] || tradeData.strategy;

            // Build unified trade payload
            const payload = {
                strategy: normalizedStrategy,
                exchangePair: `${normalizedExchange}/${normalizedStrategy}`,
                asset: tradeData.asset || 'UNKNOWN',
                buyExchange: tradeData.buyExchange || normalizedExchange,
                sellExchange: tradeData.sellExchange || normalizedExchange,
                buyPrice: tradeData.buyPrice || 0,
                sellPrice: tradeData.sellPrice || 0,
                amount: tradeData.amount || 0,
                profit: tradeData.profit || 0,
                fees: tradeData.fees || 0,
                successful: tradeData.successful !== undefined ? tradeData.successful : true,
                metadata: tradeData.metadata || {}
            };

            // Send to backend
            const response = await fetch('/api/v1/trading/trades', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const result = await response.json();
                console.log(`✅ Trade logged: ${normalizedStrategy} on ${normalizedExchange}`, result.data.trade);
                return { success: true, data: result.data };
            } else {
                const error = await response.json();
                console.error('❌ Failed to log trade:', error);
                return { success: false, error };
            }

        } catch (error) {
            console.error('❌ Error logging trade:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Convenience wrapper for triangular arbitrage trades
     * Simplifies logging for 3-leg triangular trades
     *
     * @param {string} exchange - Exchange name
     * @param {string} pathId - Path identifier (e.g., 'BTC→ETH→USDT')
     * @param {number} profit - Profit in USDT
     * @param {number} amount - Investment amount
     * @param {number} [fees=0] - Total fees
     * @param {Object} [metadata] - Additional data
     */
    async function logTriangularTrade(exchange, pathId, profit, amount, fees = 0, metadata = {}) {
        return logTradeToBackend({
            strategy: 'triangular',
            exchange: exchange,
            asset: pathId,
            amount: amount,
            profit: profit,
            fees: fees,
            metadata: metadata
        });
    }

    /**
     * Convenience wrapper for cross-exchange arbitrage trades
     *
     * @param {string} buyExchange - Exchange where asset was bought
     * @param {string} sellExchange - Exchange where asset was sold
     * @param {string} asset - Asset symbol (e.g., 'BTC')
     * @param {number} buyPrice - Buy price
     * @param {number} sellPrice - Sell price
     * @param {number} amount - Trade amount
     * @param {number} profit - Profit in USDT
     * @param {number} [fees=0] - Total fees
     */
    async function logCrossExchangeTrade(buyExchange, sellExchange, asset, buyPrice, sellPrice, amount, profit, fees = 0) {
        return logTradeToBackend({
            strategy: 'cross_exchange',
            exchange: buyExchange, // Primary exchange
            asset: asset,
            buyExchange: buyExchange,
            sellExchange: sellExchange,
            buyPrice: buyPrice,
            sellPrice: sellPrice,
            amount: amount,
            profit: profit,
            fees: fees
        });
    }

    // Expose to global scope
    window.logTradeToBackend = logTradeToBackend;
    window.logTriangularTrade = logTriangularTrade;
    window.logCrossExchangeTrade = logCrossExchangeTrade;

    console.log('📊 Trade Logger Service loaded - Ready for all 20 exchanges and 4 strategies');

})(window);
