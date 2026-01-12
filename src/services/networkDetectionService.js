/**
 * Network Detection Service
 * Fetches available deposit/withdrawal networks and fees for crypto assets across exchanges
 *
 * Purpose: Help TEST scan identify which transfer routes are actually executable
 * by showing which blockchain networks are supported on each exchange
 *
 * Updated: 2026-01-12 - Expanded normalization based on real exchange data collection
 */

const { systemLogger } = require('../utils/logger');

class NetworkDetectionService {
    constructor() {
        this.networkCache = new Map(); // Cache network data (rarely changes)
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
        this.lastUpdate = new Map();

        // Comprehensive network name mappings (based on actual exchange API responses)
        // Format: NORMALIZED_NAME: [all known variations]
        this.networkAliases = {
            // Ethereum & ERC20
            'ERC20': ['ERC20', 'ETHEREUM', 'ETH', 'ETHEREUM (ERC20)', 'ETH-ERC20'],

            // Tron & TRC20
            'TRC20': ['TRC20', 'TRON', 'TRX', 'TRON (TRC20)', 'TRX-TRC20'],

            // BSC/BNB
            'BEP20': ['BEP20', 'BSC', 'BNB', 'BNB SMART CHAIN', 'BINANCE SMART CHAIN', 'BSC (BEP20)', 'BEP20 (BSC)'],

            // Polygon/MATIC
            'POLYGON': ['POLYGON', 'MATIC', 'POLYGON POS', 'MATIC (POLYGON)', 'POLYGON-POS'],

            // Arbitrum
            'ARBITRUM': ['ARBITRUM', 'ARB', 'ARBITRUM ONE', 'ARBITRUMONE', 'ARB-ONE'],

            // Optimism
            'OPTIMISM': ['OPTIMISM', 'OP', 'OPTIMISM (OP)'],

            // Avalanche
            'AVAX-C': ['AVAX', 'AVALANCHE', 'AVAX-C', 'AVAXC', 'C-CHAIN', 'AVALANCHE C CHAIN', 'AVAX C-CHAIN',
                       'AVAXX-CHAIN', 'AVAXC-CHAIN', 'AVALANCHE C-CHAIN'],

            // Solana
            'SOL': ['SOL', 'SOLANA', 'SPL'],

            // Native chains - single network cryptos
            'XRP': ['XRP', 'RIPPLE', 'XRP LEDGER', 'XRPL'],
            'XLM': ['XLM', 'STELLAR', 'STELLAR NETWORK', 'STELLARLUMENS', 'STELLAR LUMENS'],
            'LTC': ['LTC', 'LITECOIN'],
            'BCH': ['BCH', 'BITCOIN CASH', 'BITCOIN ABC', 'BITCOINCASH'],
            'DOGE': ['DOGE', 'DOGECOIN', 'DOGECHAIN'],
            'ADA': ['ADA', 'CARDANO'],
            'DOT': ['DOT', 'POLKADOT', 'POLKADOTASSETHUB', 'ASSETHUB-POLKADOT', 'ASSETHUB POLKADOT'],
            'ATOM': ['ATOM', 'COSMOS', 'COSMOS HUB'],
            'ALGO': ['ALGO', 'ALGORAND'],
            'BTC': ['BTC', 'BITCOIN'],

            // Layer 2s and others
            'BASE': ['BASE'],
            'ZKSYNC': ['ZKSYNC', 'ZKSYNCERA', 'ZKSYNC ERA'],
            'APTOS': ['APTOS', 'APT'],
            'TON': ['TON', 'THE OPEN NETWORK', 'TONCOIN']
        };

        // Network priority for smart selection (lower = better)
        // Based on: speed, cost, reliability
        this.networkPriority = {
            // Fast & cheap - priority 1
            'XRP': 1, 'XLM': 1, 'TRC20': 1, 'SOL': 1, 'ALGO': 1,
            // Medium - priority 2
            'LTC': 2, 'POLYGON': 2, 'ARBITRUM': 2, 'OPTIMISM': 2, 'BEP20': 2, 'AVAX-C': 2, 'BASE': 2,
            // Native chains - priority 3
            'ATOM': 3, 'ADA': 3, 'DOT': 3, 'DOGE': 3, 'BCH': 3,
            // Slow/expensive - priority 4
            'ERC20': 4, 'BTC': 4
        };

        // Estimated fees in USD for smart selection
        this.estimatedFees = {
            'TRC20': 1, 'SOL': 0.01, 'XRP': 0.01, 'XLM': 0.01, 'ALGO': 0.01,
            'POLYGON': 0.1, 'ARBITRUM': 0.1, 'OPTIMISM': 0.1, 'BEP20': 0.5, 'BASE': 0.1,
            'LTC': 0.1, 'AVAX-C': 0.2, 'ATOM': 0.02, 'ADA': 0.5, 'DOT': 0.1,
            'DOGE': 2, 'BCH': 0.05, 'BTC': 5, 'ERC20': 15
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
     * Updated with verified data from exchange API collection (2026-01-12)
     */
    getCommonNetworks(asset) {
        // Comprehensive network support based on real exchange data
        const networkData = {
            // Tier 1: Fast & Cheap (single network)
            'XRP': [
                { network: 'XRP', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.25, minWithdraw: 10, priority: 1 }
            ],
            'XLM': [
                { network: 'XLM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01, minWithdraw: 1, priority: 1 }
            ],
            'TRX': [
                { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10, priority: 1 }
            ],

            // Tier 2: Medium speed (single network)
            'LTC': [
                { network: 'LTC', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.001, minWithdraw: 0.01, priority: 2 }
            ],
            'BCH': [
                { network: 'BCH', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.0005, minWithdraw: 0.001, priority: 2 }
            ],
            'DOGE': [
                { network: 'DOGE', withdrawEnabled: true, depositEnabled: true, withdrawFee: 2, minWithdraw: 10, priority: 2 }
            ],
            'SOL': [
                { network: 'SOL', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01, minWithdraw: 0.1, priority: 1 }
            ],
            'ALGO': [
                { network: 'ALGO', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.001, minWithdraw: 0.1, priority: 1 }
            ],
            'ATOM': [
                { network: 'ATOM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01, minWithdraw: 0.1, priority: 2 }
            ],
            'ADA': [
                { network: 'ADA', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 2, priority: 2 }
            ],
            'DOT': [
                { network: 'DOT', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 }
            ],
            'AVAX': [
                { network: 'AVAX-C', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01, minWithdraw: 0.1, priority: 2 }
            ],

            // Multi-network assets (ordered by priority - best first)
            'MATIC': [
                { network: 'POLYGON', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 1 },
                { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 5, minWithdraw: 10, priority: 3 },
                { network: 'BEP20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 1, priority: 2 }
            ],

            // Stablecoins (multiple networks - ordered by cost/speed)
            'USDT': [
                { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10, priority: 1 },
                { network: 'SOL', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01, minWithdraw: 1, priority: 1 },
                { network: 'POLYGON', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'ARBITRUM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'OPTIMISM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'BEP20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 10, priority: 2 },
                { network: 'AVAX-C', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 1, priority: 2 },
                { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 15, minWithdraw: 20, priority: 4 }
            ],
            'USDC': [
                { network: 'SOL', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01, minWithdraw: 1, priority: 1 },
                { network: 'POLYGON', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'ARBITRUM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'OPTIMISM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'BASE', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1, minWithdraw: 1, priority: 2 },
                { network: 'BEP20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5, minWithdraw: 10, priority: 2 },
                { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 10, priority: 2 },
                { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 15, minWithdraw: 20, priority: 4 }
            ],

            // Major cryptos
            'BTC': [
                { network: 'BTC', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.0005, minWithdraw: 0.001, priority: 3 }
            ],
            'ETH': [
                { network: 'ARBITRUM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.0001, minWithdraw: 0.001, priority: 2 },
                { network: 'OPTIMISM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.0001, minWithdraw: 0.001, priority: 2 },
                { network: 'BASE', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.0001, minWithdraw: 0.001, priority: 2 },
                { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.005, minWithdraw: 0.01, priority: 4 }
            ]
        };

        const assetUpper = asset.toUpperCase();
        return networkData[assetUpper] || [
            { network: assetUpper, withdrawEnabled: true, depositEnabled: true, withdrawFee: 1, minWithdraw: 1, priority: 3 }
        ];
    }

    /**
     * Normalize network names to standard format
     * Handles all known exchange naming variations
     */
    normalizeNetworkName(rawName) {
        if (!rawName) return 'UNKNOWN';

        const upperName = rawName.toUpperCase().trim();

        // Direct match first (most common case)
        for (const [standard, aliases] of Object.entries(this.networkAliases)) {
            // Exact match
            if (aliases.includes(upperName)) {
                return standard;
            }
        }

        // Partial match (for variations like "AVALANCHE C CHAIN" containing "AVALANCHE")
        for (const [standard, aliases] of Object.entries(this.networkAliases)) {
            for (const alias of aliases) {
                if (upperName.includes(alias) || alias.includes(upperName)) {
                    return standard;
                }
            }
        }

        // Clean and return as-is if no match found
        const cleaned = rawName.replace(/[^A-Z0-9\-]/gi, '').toUpperCase();
        systemLogger.debug(`Network name not mapped: "${rawName}" -> "${cleaned}"`);
        return cleaned;
    }

    /**
     * Find matching networks between two exchanges
     * Returns matches sorted by priority (best first)
     */
    findMatchingNetworks(fromNetworks, toNetworks) {
        const matches = [];

        for (const fromNet of fromNetworks) {
            // Normalize the from network name
            const fromNormalized = this.normalizeNetworkName(fromNet.network);

            for (const toNet of toNetworks) {
                // Normalize the to network name
                const toNormalized = this.normalizeNetworkName(toNet.network);

                // Check if networks match (using normalized names)
                if (fromNormalized === toNormalized &&
                    fromNet.withdrawEnabled &&
                    toNet.depositEnabled) {

                    // Calculate priority (lower is better)
                    const priority = this.networkPriority[fromNormalized] || 5;
                    const estimatedFee = this.estimatedFees[fromNormalized] || fromNet.withdrawFee || 1;

                    matches.push({
                        network: fromNormalized,
                        rawFromNetwork: fromNet.network,
                        rawToNetwork: toNet.network,
                        withdrawFee: fromNet.withdrawFee || estimatedFee,
                        minWithdraw: fromNet.minWithdraw || 0,
                        priority: priority,
                        estimatedFeeUSD: estimatedFee,
                        viable: true
                    });
                }
            }
        }

        // Sort by priority (lower is better), then by fee
        matches.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.estimatedFeeUSD - b.estimatedFeeUSD;
        });

        return matches;
    }

    /**
     * SMART SELECTION: Automatically select the best network for a transfer
     * @param {string} fromExchange - Source exchange
     * @param {string} toExchange - Destination exchange
     * @param {string} asset - Crypto asset
     * @returns {object} Best network selection with reasoning
     */
    async selectBestNetwork(fromExchange, toExchange, asset) {
        systemLogger.info(`Smart network selection: ${asset} from ${fromExchange} to ${toExchange}`);

        try {
            // Get networks from both exchanges
            const fromNetworks = await this.getNetworks(fromExchange, asset);
            const toNetworks = await this.getNetworks(toExchange, asset);

            if (!fromNetworks || fromNetworks.length === 0) {
                return {
                    success: false,
                    error: `No networks found for ${asset} on ${fromExchange}`,
                    recommendation: null
                };
            }

            if (!toNetworks || toNetworks.length === 0) {
                return {
                    success: false,
                    error: `No networks found for ${asset} on ${toExchange}`,
                    recommendation: null
                };
            }

            // Find matching networks
            const matches = this.findMatchingNetworks(fromNetworks, toNetworks);

            if (matches.length === 0) {
                return {
                    success: false,
                    error: `No compatible networks between ${fromExchange} and ${toExchange} for ${asset}`,
                    fromNetworks: fromNetworks.map(n => n.network),
                    toNetworks: toNetworks.map(n => n.network),
                    recommendation: null
                };
            }

            // Best match is first (already sorted by priority and fee)
            const best = matches[0];

            // Generate reasoning
            let reasoning = '';
            if (matches.length === 1) {
                reasoning = `Only compatible network: ${best.network}`;
            } else {
                const alternatives = matches.slice(1, 4).map(m => m.network).join(', ');
                reasoning = `${best.network} selected (lowest cost/fastest). Alternatives: ${alternatives}`;
            }

            return {
                success: true,
                recommendation: {
                    network: best.network,
                    withdrawFee: best.withdrawFee,
                    estimatedFeeUSD: best.estimatedFeeUSD,
                    priority: best.priority,
                    reasoning: reasoning
                },
                allMatches: matches,
                matchCount: matches.length
            };

        } catch (error) {
            systemLogger.error(`Smart network selection failed: ${error.message}`);
            return {
                success: false,
                error: error.message,
                recommendation: null
            };
        }
    }

    /**
     * Get the recommended network for a crypto (general recommendation, not route-specific)
     * Useful for default selection in UI
     */
    getRecommendedNetwork(asset) {
        const networks = this.getCommonNetworks(asset);
        if (networks.length === 0) return null;

        // Already sorted by priority in getCommonNetworks
        return networks[0].network;
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
