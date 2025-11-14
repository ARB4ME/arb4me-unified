/**
 * Network Detection Service
 * Fetches available deposit/withdrawal networks and fees for crypto assets across exchanges
 *
 * Purpose: Help TEST scan identify which transfer routes are actually executable
 * by showing which blockchain networks are supported on each exchange
 */

const { systemLogger } = require('../utils/logger');

class NetworkDetectionService {
    constructor() {
        this.networkCache = new Map(); // Cache network data (rarely changes)
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
        this.lastUpdate = new Map();

        // Common network mappings
        this.networkAliases = {
            'ETH': ['ERC20', 'ETHEREUM', 'ETH'],
            'TRC20': ['TRC20', 'TRON', 'TRX'],
            'BEP20': ['BEP20', 'BSC', 'BNB'],
            'POLYGON': ['POLYGON', 'MATIC'],
            'ARBITRUM': ['ARBITRUM', 'ARB'],
            'OPTIMISM': ['OPTIMISM', 'OP'],
            'AVAX': ['AVAX', 'AVALANCHE'],
            'SOL': ['SOL', 'SOLANA']
        };
    }

    /**
     * Get networks for a specific asset on a specific exchange
     */
    async getNetworks(exchange, asset) {
        const cacheKey = `${exchange}_${asset}`;

        // Check cache first
        if (this.isCacheValid(cacheKey)) {
            return this.networkCache.get(cacheKey);
        }

        try {
            let networks = null;

            switch (exchange.toLowerCase()) {
                case 'binance':
                    networks = await this.fetchBinanceNetworks(asset);
                    break;
                case 'kucoin':
                    networks = await this.fetchKuCoinNetworks(asset);
                    break;
                case 'bybit':
                    networks = await this.fetchBybitNetworks(asset);
                    break;
                case 'gateio':
                    networks = await this.fetchGateioNetworks(asset);
                    break;
                case 'okx':
                    networks = await this.fetchOKXNetworks(asset);
                    break;
                case 'kraken':
                    networks = await this.fetchKrakenNetworks(asset);
                    break;
                case 'mexc':
                    networks = await this.fetchMEXCNetworks(asset);
                    break;
                // Add more exchanges as needed
                default:
                    // Fallback to common networks for unknown exchanges
                    networks = this.getCommonNetworks(asset);
            }

            // Cache the result
            this.networkCache.set(cacheKey, networks);
            this.lastUpdate.set(cacheKey, Date.now());

            return networks;
        } catch (error) {
            systemLogger.warn(`Failed to fetch networks for ${asset} on ${exchange}:`, error.message);
            return this.getCommonNetworks(asset);
        }
    }

    /**
     * Binance network detection (public endpoint)
     */
    async fetchBinanceNetworks(asset) {
        // Binance doesn't have a public endpoint for network info
        // Would need authenticated /sapi/v1/capital/config/getall
        // Return common networks as fallback
        return this.getCommonNetworks(asset);
    }

    /**
     * KuCoin network detection (public)
     */
    async fetchKuCoinNetworks(asset) {
        try {
            const response = await fetch('https://api.kucoin.com/api/v1/currencies');
            if (!response.ok) throw new Error(`KuCoin API error: ${response.status}`);

            const data = await response.json();
            if (data.code !== '200000') throw new Error(`KuCoin error: ${data.msg}`);

            const currency = data.data.find(c => c.currency === asset.toUpperCase());
            if (!currency || !currency.chains) return this.getCommonNetworks(asset);

            return currency.chains.map(chain => ({
                network: this.normalizeNetworkName(chain.chainName),
                withdrawEnabled: !chain.isWithdrawEnabled,
                depositEnabled: !chain.isDepositEnabled,
                withdrawFee: parseFloat(chain.withdrawalMinFee) || 0,
                minWithdraw: parseFloat(chain.withdrawalMinSize) || 0
            }));
        } catch (error) {
            systemLogger.warn(`KuCoin network fetch failed for ${asset}:`, error.message);
            return this.getCommonNetworks(asset);
        }
    }

    /**
     * Bybit network detection (public)
     */
    async fetchBybitNetworks(asset) {
        try {
            const response = await fetch(`https://api.bybit.com/v5/asset/coin/query-info?coin=${asset.toUpperCase()}`);
            if (!response.ok) throw new Error(`Bybit API error: ${response.status}`);

            const data = await response.json();
            if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

            if (!data.result || !data.result.rows || data.result.rows.length === 0) {
                return this.getCommonNetworks(asset);
            }

            const coinInfo = data.result.rows[0];
            if (!coinInfo.chains) return this.getCommonNetworks(asset);

            return coinInfo.chains.map(chain => ({
                network: this.normalizeNetworkName(chain.chain),
                withdrawEnabled: chain.chainWithdraw === '1',
                depositEnabled: chain.chainDeposit === '1',
                withdrawFee: parseFloat(chain.withdrawFee) || 0,
                minWithdraw: parseFloat(chain.minWithdrawAmount) || 0
            }));
        } catch (error) {
            systemLogger.warn(`Bybit network fetch failed for ${asset}:`, error.message);
            return this.getCommonNetworks(asset);
        }
    }

    /**
     * Gate.io network detection (public)
     */
    async fetchGateioNetworks(asset) {
        try {
            const response = await fetch(`https://api.gateio.ws/api/v4/wallet/currency_chains/${asset.toUpperCase()}`);
            if (!response.ok) throw new Error(`Gate.io API error: ${response.status}`);

            const chains = await response.json();

            return chains.map(chain => ({
                network: this.normalizeNetworkName(chain.chain),
                withdrawEnabled: chain.is_withdraw_disabled === 0,
                depositEnabled: chain.is_deposit_disabled === 0,
                withdrawFee: parseFloat(chain.withdraw_fee) || 0,
                minWithdraw: parseFloat(chain.withdraw_min) || 0
            }));
        } catch (error) {
            systemLogger.warn(`Gate.io network fetch failed for ${asset}:`, error.message);
            return this.getCommonNetworks(asset);
        }
    }

    /**
     * OKX network detection
     */
    async fetchOKXNetworks(asset) {
        // OKX requires authentication for /api/v5/asset/currencies
        // Return common networks as fallback
        return this.getCommonNetworks(asset);
    }

    /**
     * Kraken network detection
     */
    async fetchKrakenNetworks(asset) {
        // Kraken has limited network options, mostly native chains
        // Return common networks as fallback
        return this.getCommonNetworks(asset);
    }

    /**
     * MEXC network detection
     */
    async fetchMEXCNetworks(asset) {
        // MEXC requires authentication for network info
        // Return common networks as fallback
        return this.getCommonNetworks(asset);
    }

    /**
     * Fallback: Return common networks based on asset type
     */
    getCommonNetworks(asset) {
        const networks = [];

        switch (asset.toUpperCase()) {
            case 'USDT':
                networks.push(
                    { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10 },
                    { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10 },
                    { network: 'BEP20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 10 },
                    { network: 'POLYGON', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 10 }
                );
                break;
            case 'USDC':
                networks.push(
                    { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10 },
                    { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10 },
                    { network: 'POLYGON', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 10 }
                );
                break;
            case 'BTC':
                networks.push(
                    { network: 'BTC', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.0005, minWithdraw: 0.001 }
                );
                break;
            case 'ETH':
                networks.push(
                    { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.005, minWithdraw: 0.01 }
                );
                break;
            case 'LTC':
                networks.push(
                    { network: 'LTC', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.001, minWithdraw: 0.01 }
                );
                break;
            default:
                // Generic ERC20 token
                networks.push(
                    { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10 }
                );
        }

        return networks;
    }

    /**
     * Normalize network names to standard format
     */
    normalizeNetworkName(rawName) {
        const upperName = rawName.toUpperCase();

        // Check aliases
        for (const [standard, aliases] of Object.entries(this.networkAliases)) {
            if (aliases.some(alias => upperName.includes(alias))) {
                return standard;
            }
        }

        // Return cleaned name
        return rawName.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    }

    /**
     * Find matching networks between two exchanges
     */
    findMatchingNetworks(fromNetworks, toNetworks) {
        const matches = [];

        for (const fromNet of fromNetworks) {
            for (const toNet of toNetworks) {
                if (fromNet.network === toNet.network &&
                    fromNet.withdrawEnabled &&
                    toNet.depositEnabled) {
                    matches.push({
                        network: fromNet.network,
                        withdrawFee: fromNet.withdrawFee,
                        minWithdraw: fromNet.minWithdraw,
                        viable: true
                    });
                }
            }
        }

        return matches;
    }

    /**
     * Check if cache is still valid
     */
    isCacheValid(key) {
        if (!this.networkCache.has(key)) return false;

        const lastUpdate = this.lastUpdate.get(key);
        if (!lastUpdate) return false;

        return (Date.now() - lastUpdate) < this.cacheExpiry;
    }

    /**
     * Clear cache (for testing or manual refresh)
     */
    clearCache() {
        this.networkCache.clear();
        this.lastUpdate.clear();
    }
}

// Singleton instance
const networkDetectionService = new NetworkDetectionService();

module.exports = networkDetectionService;
