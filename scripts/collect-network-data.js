/**
 * Network Data Collection Script
 * Phase 1: Fetches network/chain information from all exchange public APIs
 *
 * Run with: node scripts/collect-network-data.js
 * Output: scripts/network-data-report.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Target cryptocurrencies for Transfer ARB
const TARGET_CRYPTOS = [
    'XRP', 'XLM', 'TRX',           // Tier 1: Fast & Cheap
    'LTC', 'BCH', 'DOGE', 'SOL',   // Tier 2: Medium
    'ALGO', 'ATOM', 'MATIC', 'AVAX', 'ADA', 'DOT',
    'USDT', 'USDC',                // Tier 3: Stablecoins
    'BTC', 'ETH'                   // Tier 4: Slow but common
];

// Network name normalization map
const NETWORK_ALIASES = {
    // TRC20 variants
    'TRC20': 'TRC20', 'TRON': 'TRC20', 'TRX': 'TRC20', 'TRON(TRC20)': 'TRC20',
    // ERC20 variants
    'ERC20': 'ERC20', 'ETH': 'ERC20', 'ETHEREUM': 'ERC20', 'ETH(ERC20)': 'ERC20',
    // BEP20 variants
    'BEP20': 'BEP20', 'BSC': 'BEP20', 'BNB': 'BEP20', 'BINANCE SMART CHAIN': 'BEP20', 'BSC(BEP20)': 'BEP20',
    // Polygon variants
    'POLYGON': 'POLYGON', 'MATIC': 'POLYGON', 'MATIC(POLYGON)': 'POLYGON',
    // Solana variants
    'SOL': 'SOL', 'SOLANA': 'SOL', 'SPL': 'SOL',
    // Avalanche variants
    'AVAX': 'AVAX-C', 'AVALANCHE': 'AVAX-C', 'AVAX-C': 'AVAX-C', 'AVAXC': 'AVAX-C', 'C-CHAIN': 'AVAX-C',
    // Arbitrum variants
    'ARBITRUM': 'ARBITRUM', 'ARB': 'ARBITRUM', 'ARBITRUM ONE': 'ARBITRUM',
    // Optimism variants
    'OPTIMISM': 'OPTIMISM', 'OP': 'OPTIMISM',
    // Native chains
    'BTC': 'BTC', 'BITCOIN': 'BTC',
    'LTC': 'LTC', 'LITECOIN': 'LTC',
    'XRP': 'XRP', 'RIPPLE': 'XRP', 'XRP LEDGER': 'XRP',
    'XLM': 'XLM', 'STELLAR': 'XLM',
    'ADA': 'ADA', 'CARDANO': 'ADA',
    'DOT': 'DOT', 'POLKADOT': 'DOT',
    'ATOM': 'ATOM', 'COSMOS': 'ATOM',
    'ALGO': 'ALGO', 'ALGORAND': 'ALGO',
    'DOGE': 'DOGE', 'DOGECOIN': 'DOGE',
    'BCH': 'BCH', 'BITCOIN CASH': 'BCH'
};

// Normalize network name
function normalizeNetwork(rawName) {
    if (!rawName) return 'UNKNOWN';
    const upper = rawName.toUpperCase().trim();
    return NETWORK_ALIASES[upper] || upper;
}

// Simple fetch wrapper
function fetchJSON(url, options = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? https : http;

        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'ARB4ME-NetworkScanner/1.0',
                'Accept': 'application/json',
                ...options.headers
            },
            timeout: 15000
        };

        const req = lib.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

// Exchange-specific fetchers
const exchangeFetchers = {

    // BINANCE - Public endpoint for coin info (limited without auth)
    async binance() {
        console.log('  📡 Binance: Fetching from exchangeInfo...');
        // Binance requires auth for /sapi/v1/capital/config/getall
        // We'll use a workaround - check their public documentation
        // For now, return commonly known networks
        return {
            source: 'hardcoded (API requires auth)',
            networks: {
                'USDT': ['ERC20', 'TRC20', 'BEP20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'SOL', 'AVAX-C'],
                'USDC': ['ERC20', 'TRC20', 'BEP20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'SOL', 'AVAX-C'],
                'BTC': ['BTC'],
                'ETH': ['ERC20', 'ARBITRUM', 'OPTIMISM', 'BEP20'],
                'XRP': ['XRP'],
                'XLM': ['XLM'],
                'TRX': ['TRC20'],
                'LTC': ['LTC'],
                'BCH': ['BCH'],
                'DOGE': ['DOGE', 'BEP20'],
                'SOL': ['SOL'],
                'ADA': ['ADA', 'BEP20'],
                'DOT': ['DOT'],
                'MATIC': ['POLYGON', 'ERC20', 'BEP20'],
                'AVAX': ['AVAX-C'],
                'ATOM': ['ATOM'],
                'ALGO': ['ALGO']
            }
        };
    },

    // BYBIT - Public coin info endpoint
    async bybit() {
        console.log('  📡 Bybit: Fetching coin info...');
        try {
            const networks = {};

            for (const crypto of TARGET_CRYPTOS) {
                try {
                    const { data } = await fetchJSON(`https://api.bybit.com/v5/asset/coin/query-info?coin=${crypto}`);

                    if (data.retCode === 0 && data.result?.rows?.[0]?.chains) {
                        networks[crypto] = data.result.rows[0].chains
                            .filter(c => c.chainDeposit === '1' || c.chainWithdraw === '1')
                            .map(c => ({
                                network: normalizeNetwork(c.chain),
                                rawName: c.chain,
                                withdrawEnabled: c.chainWithdraw === '1',
                                depositEnabled: c.chainDeposit === '1',
                                withdrawFee: parseFloat(c.withdrawFee) || 0,
                                minWithdraw: parseFloat(c.minWithdrawAmount) || 0
                            }));
                    }
                    await sleep(100); // Rate limit
                } catch (e) {
                    console.log(`    ⚠️ ${crypto}: ${e.message}`);
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // KUCOIN - Public currencies endpoint
    async kucoin() {
        console.log('  📡 KuCoin: Fetching currencies...');
        try {
            const { data } = await fetchJSON('https://api.kucoin.com/api/v1/currencies');

            if (data.code !== '200000') {
                return { source: 'error', error: data.msg, networks: {} };
            }

            const networks = {};
            for (const currency of data.data) {
                if (TARGET_CRYPTOS.includes(currency.currency)) {
                    if (currency.chains && currency.chains.length > 0) {
                        networks[currency.currency] = currency.chains.map(c => ({
                            network: normalizeNetwork(c.chainName),
                            rawName: c.chainName,
                            withdrawEnabled: !c.isWithdrawEnabled, // Note: KuCoin uses inverted logic
                            depositEnabled: !c.isDepositEnabled,
                            withdrawFee: parseFloat(c.withdrawalMinFee) || 0,
                            minWithdraw: parseFloat(c.withdrawalMinSize) || 0
                        }));
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // GATEIO - Public currency chains endpoint
    async gateio() {
        console.log('  📡 Gate.io: Fetching currency chains...');
        try {
            const networks = {};

            for (const crypto of TARGET_CRYPTOS) {
                try {
                    const { data } = await fetchJSON(`https://api.gateio.ws/api/v4/wallet/currency_chains/${crypto}`);

                    if (Array.isArray(data)) {
                        networks[crypto] = data.map(c => ({
                            network: normalizeNetwork(c.chain),
                            rawName: c.chain,
                            withdrawEnabled: c.is_withdraw_disabled === 0,
                            depositEnabled: c.is_deposit_disabled === 0,
                            withdrawFee: parseFloat(c.withdraw_fee) || 0,
                            minWithdraw: parseFloat(c.withdraw_min) || 0
                        }));
                    }
                    await sleep(200); // Rate limit
                } catch (e) {
                    // 404 means crypto not supported
                    if (!e.message.includes('404')) {
                        console.log(`    ⚠️ ${crypto}: ${e.message}`);
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // OKX - Requires auth, use known data
    async okx() {
        console.log('  📡 OKX: Using known network data (API requires auth)...');
        return {
            source: 'hardcoded (API requires auth)',
            networks: {
                'USDT': ['ERC20', 'TRC20', 'BEP20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'SOL', 'AVAX-C'],
                'USDC': ['ERC20', 'TRC20', 'BEP20', 'POLYGON', 'ARBITRUM', 'SOL'],
                'BTC': ['BTC'],
                'ETH': ['ERC20', 'ARBITRUM', 'OPTIMISM'],
                'XRP': ['XRP'],
                'XLM': ['XLM'],
                'TRX': ['TRC20'],
                'LTC': ['LTC'],
                'BCH': ['BCH'],
                'DOGE': ['DOGE'],
                'SOL': ['SOL'],
                'ADA': ['ADA'],
                'DOT': ['DOT'],
                'MATIC': ['POLYGON', 'ERC20'],
                'AVAX': ['AVAX-C'],
                'ATOM': ['ATOM'],
                'ALGO': ['ALGO']
            }
        };
    },

    // MEXC - Public coin list
    async mexc() {
        console.log('  📡 MEXC: Fetching coin list...');
        try {
            const { data } = await fetchJSON('https://api.mexc.com/api/v3/capital/config/getall');

            const networks = {};
            if (Array.isArray(data)) {
                for (const coin of data) {
                    if (TARGET_CRYPTOS.includes(coin.coin)) {
                        if (coin.networkList && coin.networkList.length > 0) {
                            networks[coin.coin] = coin.networkList.map(n => ({
                                network: normalizeNetwork(n.network),
                                rawName: n.network,
                                withdrawEnabled: n.withdrawEnable,
                                depositEnabled: n.depositEnable,
                                withdrawFee: parseFloat(n.withdrawFee) || 0,
                                minWithdraw: parseFloat(n.withdrawMin) || 0
                            }));
                        }
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // HTX (Huobi) - Public reference currencies
    async htx() {
        console.log('  📡 HTX: Fetching reference currencies...');
        try {
            const { data } = await fetchJSON('https://api.huobi.pro/v2/reference/currencies');

            if (data.status !== 'ok') {
                return { source: 'error', error: data.message, networks: {} };
            }

            const networks = {};
            for (const currency of data.data) {
                const symbol = currency.currency.toUpperCase();
                if (TARGET_CRYPTOS.includes(symbol)) {
                    if (currency.chains && currency.chains.length > 0) {
                        networks[symbol] = currency.chains.map(c => ({
                            network: normalizeNetwork(c.chain || c.displayName),
                            rawName: c.chain || c.displayName,
                            withdrawEnabled: c.withdrawStatus === 'allowed',
                            depositEnabled: c.depositStatus === 'allowed',
                            withdrawFee: parseFloat(c.transactFeeWithdraw) || 0,
                            minWithdraw: parseFloat(c.minWithdrawAmt) || 0
                        }));
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // KRAKEN - Public asset info
    async kraken() {
        console.log('  📡 Kraken: Fetching asset info...');
        // Kraken primarily uses native networks, limited multi-chain support
        return {
            source: 'hardcoded (limited multi-chain)',
            networks: {
                'USDT': ['ERC20', 'TRC20'],
                'USDC': ['ERC20'],
                'BTC': ['BTC'],
                'ETH': ['ERC20'],
                'XRP': ['XRP'],
                'XLM': ['XLM'],
                'TRX': ['TRC20'],
                'LTC': ['LTC'],
                'BCH': ['BCH'],
                'DOGE': ['DOGE'],
                'SOL': ['SOL'],
                'ADA': ['ADA'],
                'DOT': ['DOT'],
                'MATIC': ['POLYGON'],
                'AVAX': ['AVAX-C'],
                'ATOM': ['ATOM'],
                'ALGO': ['ALGO']
            }
        };
    },

    // BITGET - Public coin info
    async bitget() {
        console.log('  📡 Bitget: Fetching coin info...');
        try {
            const { data } = await fetchJSON('https://api.bitget.com/api/v2/spot/public/coins');

            if (data.code !== '00000') {
                return { source: 'error', error: data.msg, networks: {} };
            }

            const networks = {};
            for (const coin of data.data) {
                if (TARGET_CRYPTOS.includes(coin.coin)) {
                    if (coin.chains && coin.chains.length > 0) {
                        networks[coin.coin] = coin.chains.map(c => ({
                            network: normalizeNetwork(c.chain),
                            rawName: c.chain,
                            withdrawEnabled: c.withdrawable === 'true',
                            depositEnabled: c.rechargeable === 'true',
                            withdrawFee: parseFloat(c.withdrawFee) || 0,
                            minWithdraw: parseFloat(c.minWithdrawAmount) || 0
                        }));
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // BINGX - Requires auth
    async bingx() {
        console.log('  📡 BingX: Using known network data (API requires auth)...');
        return {
            source: 'hardcoded (API requires auth)',
            networks: {
                'USDT': ['ERC20', 'TRC20', 'BEP20', 'ARBITRUM', 'OPTIMISM'],
                'USDC': ['ERC20', 'BEP20'],
                'BTC': ['BTC'],
                'ETH': ['ERC20', 'ARBITRUM'],
                'XRP': ['XRP'],
                'XLM': ['XLM'],
                'TRX': ['TRC20'],
                'LTC': ['LTC'],
                'DOGE': ['DOGE'],
                'SOL': ['SOL'],
                'MATIC': ['POLYGON', 'ERC20']
            }
        };
    },

    // BITMART - Public currencies
    async bitmart() {
        console.log('  📡 BitMart: Fetching currencies...');
        try {
            const { data } = await fetchJSON('https://api-cloud.bitmart.com/spot/v1/currencies');

            if (data.code !== 1000) {
                return { source: 'error', error: data.message, networks: {} };
            }

            const networks = {};
            for (const currency of data.data.currencies) {
                if (TARGET_CRYPTOS.includes(currency.id)) {
                    // BitMart returns network info differently
                    networks[currency.id] = [{
                        network: normalizeNetwork(currency.network || currency.id),
                        rawName: currency.network || currency.id,
                        withdrawEnabled: currency.withdraw_enabled,
                        depositEnabled: currency.deposit_enabled
                    }];
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // BITRUE - Limited public API
    async bitrue() {
        console.log('  📡 Bitrue: Using known network data...');
        return {
            source: 'hardcoded',
            networks: {
                'USDT': ['ERC20', 'TRC20', 'BEP20'],
                'USDC': ['ERC20'],
                'BTC': ['BTC'],
                'ETH': ['ERC20'],
                'XRP': ['XRP'],
                'XLM': ['XLM'],
                'TRX': ['TRC20'],
                'LTC': ['LTC'],
                'DOGE': ['DOGE'],
                'SOL': ['SOL'],
                'ADA': ['ADA']
            }
        };
    },

    // ASCENDEX - Public assets
    async ascendex() {
        console.log('  📡 AscendEX: Fetching assets...');
        try {
            const { data } = await fetchJSON('https://ascendex.com/api/pro/v2/assets');

            if (data.code !== 0) {
                return { source: 'error', error: data.message, networks: {} };
            }

            const networks = {};
            for (const asset of data.data) {
                if (TARGET_CRYPTOS.includes(asset.assetCode)) {
                    if (asset.blockChain && asset.blockChain.length > 0) {
                        networks[asset.assetCode] = asset.blockChain.map(b => ({
                            network: normalizeNetwork(b.chainName),
                            rawName: b.chainName,
                            withdrawEnabled: b.withdrawAllowed,
                            depositEnabled: b.depositAllowed,
                            withdrawFee: parseFloat(b.withdrawFee) || 0,
                            minWithdraw: parseFloat(b.minWithdrawal) || 0
                        }));
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // XT - Public coins info
    async xt() {
        console.log('  📡 XT: Fetching coins info...');
        try {
            const { data } = await fetchJSON('https://sapi.xt.com/v4/public/wallet/support/currency');

            const networks = {};
            if (data.result) {
                for (const coin of data.result) {
                    const symbol = coin.currency?.toUpperCase();
                    if (TARGET_CRYPTOS.includes(symbol)) {
                        if (coin.supportChains && coin.supportChains.length > 0) {
                            networks[symbol] = coin.supportChains.map(c => ({
                                network: normalizeNetwork(c.chain),
                                rawName: c.chain,
                                withdrawEnabled: c.withdrawEnabled,
                                depositEnabled: c.depositEnabled,
                                withdrawFee: parseFloat(c.withdrawFeeAmount) || 0,
                                minWithdraw: parseFloat(c.minWithdrawAmount) || 0
                            }));
                        }
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // COINCATCH - Similar to Bitget
    async coincatch() {
        console.log('  📡 CoinCatch: Fetching coin info...');
        try {
            const { data } = await fetchJSON('https://api.coincatch.com/api/spot/v1/public/currencies');

            if (data.code !== '00000') {
                return { source: 'error', error: data.msg, networks: {} };
            }

            const networks = {};
            for (const coin of data.data) {
                if (TARGET_CRYPTOS.includes(coin.coinName)) {
                    if (coin.chains && coin.chains.length > 0) {
                        networks[coin.coinName] = coin.chains.map(c => ({
                            network: normalizeNetwork(c.chain),
                            rawName: c.chain,
                            withdrawEnabled: c.withdrawable === 'true',
                            depositEnabled: c.rechargeable === 'true',
                            withdrawFee: parseFloat(c.withdrawFee) || 0,
                            minWithdraw: parseFloat(c.minWithdrawAmount) || 0
                        }));
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // VALR - South African exchange
    async valr() {
        console.log('  📡 VALR: Fetching currencies...');
        try {
            const { data } = await fetchJSON('https://api.valr.com/v1/public/currencies');

            const networks = {};
            for (const currency of data) {
                if (TARGET_CRYPTOS.includes(currency.symbol)) {
                    // VALR typically uses native networks
                    networks[currency.symbol] = [{
                        network: normalizeNetwork(currency.symbol),
                        rawName: currency.symbol,
                        withdrawEnabled: currency.isActive,
                        depositEnabled: currency.isActive,
                        withdrawFee: parseFloat(currency.withdrawFee) || 0
                    }];
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // LUNO - South African exchange
    async luno() {
        console.log('  📡 Luno: Using known network data...');
        // Luno has limited crypto support
        return {
            source: 'hardcoded',
            networks: {
                'BTC': ['BTC'],
                'ETH': ['ERC20'],
                'XRP': ['XRP'],
                'LTC': ['LTC'],
                'BCH': ['BCH'],
                'USDC': ['ERC20']
            }
        };
    },

    // CHAINEX - South African exchange
    async chainex() {
        console.log('  📡 ChainEX: Fetching currencies...');
        try {
            const { data } = await fetchJSON('https://api.chainex.io/currencies');

            const networks = {};
            if (Array.isArray(data)) {
                for (const currency of data) {
                    const symbol = currency.code?.toUpperCase();
                    if (TARGET_CRYPTOS.includes(symbol)) {
                        networks[symbol] = [{
                            network: normalizeNetwork(currency.network || symbol),
                            rawName: currency.network || symbol,
                            withdrawEnabled: currency.can_withdraw !== false,
                            depositEnabled: currency.can_deposit !== false
                        }];
                    }
                }
            }

            return { source: 'api', networks };
        } catch (e) {
            return { source: 'error', error: e.message, networks: {} };
        }
    },

    // GEMINI - US exchange
    async gemini() {
        console.log('  📡 Gemini: Using known network data...');
        return {
            source: 'hardcoded',
            networks: {
                'BTC': ['BTC'],
                'ETH': ['ERC20'],
                'LTC': ['LTC'],
                'BCH': ['BCH'],
                'USDT': ['ERC20'],
                'USDC': ['ERC20'],
                'SOL': ['SOL'],
                'MATIC': ['POLYGON'],
                'DOT': ['DOT']
            }
        };
    }
};

// Sleep helper
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main collection function
async function collectNetworkData() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ARB4ME Network Data Collection - Phase 1');
    console.log('  Target: ' + TARGET_CRYPTOS.length + ' cryptocurrencies across ' + Object.keys(exchangeFetchers).length + ' exchanges');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const results = {
        collectedAt: new Date().toISOString(),
        targetCryptos: TARGET_CRYPTOS,
        exchanges: {},
        summary: {
            totalExchanges: 0,
            apiSuccess: 0,
            hardcoded: 0,
            errors: 0
        }
    };

    // Collect from each exchange
    for (const [exchangeId, fetcher] of Object.entries(exchangeFetchers)) {
        console.log(`\n🏦 ${exchangeId.toUpperCase()}`);
        results.summary.totalExchanges++;

        try {
            const data = await fetcher();
            results.exchanges[exchangeId] = data;

            if (data.source === 'api') {
                results.summary.apiSuccess++;
                console.log(`  ✅ API success - ${Object.keys(data.networks).length} cryptos found`);
            } else if (data.source.includes('hardcoded')) {
                results.summary.hardcoded++;
                console.log(`  📋 Using hardcoded data - ${Object.keys(data.networks).length} cryptos`);
            } else if (data.source === 'error') {
                results.summary.errors++;
                console.log(`  ❌ Error: ${data.error}`);
            }

            // Small delay between exchanges
            await sleep(500);

        } catch (e) {
            results.summary.errors++;
            results.exchanges[exchangeId] = { source: 'error', error: e.message, networks: {} };
            console.log(`  ❌ Failed: ${e.message}`);
        }
    }

    // Save results
    const outputPath = path.join(__dirname, 'network-data-report.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\n\n✅ Results saved to: ${outputPath}`);

    // Generate summary
    generateSummary(results);

    return results;
}

// Generate readable summary
function generateSummary(results) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');

    console.log(`\n📊 Data Sources:`);
    console.log(`   API Success: ${results.summary.apiSuccess}/${results.summary.totalExchanges}`);
    console.log(`   Hardcoded:   ${results.summary.hardcoded}/${results.summary.totalExchanges}`);
    console.log(`   Errors:      ${results.summary.errors}/${results.summary.totalExchanges}`);

    // Build network compatibility matrix
    console.log(`\n📋 Network Support by Crypto:`);
    console.log('─'.repeat(70));

    for (const crypto of TARGET_CRYPTOS) {
        const supportingExchanges = [];
        const networksByExchange = {};

        for (const [exchangeId, data] of Object.entries(results.exchanges)) {
            const cryptoData = data.networks[crypto];
            if (cryptoData) {
                supportingExchanges.push(exchangeId);

                // Get network names
                let networks;
                if (Array.isArray(cryptoData)) {
                    if (typeof cryptoData[0] === 'string') {
                        networks = cryptoData;
                    } else {
                        networks = cryptoData.map(n => n.network);
                    }
                } else {
                    networks = [cryptoData];
                }
                networksByExchange[exchangeId] = networks;
            }
        }

        // Find common networks
        const allNetworks = Object.values(networksByExchange).flat();
        const networkCounts = {};
        allNetworks.forEach(n => networkCounts[n] = (networkCounts[n] || 0) + 1);

        const commonNetworks = Object.entries(networkCounts)
            .filter(([_, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([network, count]) => `${network}(${count})`);

        console.log(`\n${crypto}:`);
        console.log(`   Exchanges: ${supportingExchanges.length} (${supportingExchanges.join(', ')})`);
        console.log(`   Common Networks: ${commonNetworks.join(', ') || 'None'}`);
    }

    // Save summary as text file too
    const summaryPath = path.join(__dirname, 'network-data-summary.txt');
    const summaryText = generateTextSummary(results);
    fs.writeFileSync(summaryPath, summaryText);
    console.log(`\n📄 Text summary saved to: ${summaryPath}`);
}

function generateTextSummary(results) {
    let text = 'ARB4ME Network Data Collection Report\n';
    text += `Generated: ${results.collectedAt}\n`;
    text += '='.repeat(70) + '\n\n';

    text += 'DATA SOURCES\n';
    text += '-'.repeat(70) + '\n';
    text += `API Success: ${results.summary.apiSuccess}/${results.summary.totalExchanges}\n`;
    text += `Hardcoded:   ${results.summary.hardcoded}/${results.summary.totalExchanges}\n`;
    text += `Errors:      ${results.summary.errors}/${results.summary.totalExchanges}\n\n`;

    text += 'NETWORK COMPATIBILITY MATRIX\n';
    text += '-'.repeat(70) + '\n\n';

    for (const crypto of TARGET_CRYPTOS) {
        text += `${crypto}\n`;

        for (const [exchangeId, data] of Object.entries(results.exchanges)) {
            const cryptoData = data.networks[crypto];
            if (cryptoData) {
                let networks;
                if (Array.isArray(cryptoData)) {
                    if (typeof cryptoData[0] === 'string') {
                        networks = cryptoData;
                    } else {
                        networks = cryptoData.map(n => n.network);
                    }
                } else {
                    networks = [cryptoData];
                }
                text += `  ${exchangeId.padEnd(12)}: ${networks.join(', ')}\n`;
            }
        }
        text += '\n';
    }

    return text;
}

// Run
collectNetworkData()
    .then(() => {
        console.log('\n🎉 Data collection complete!\n');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Fatal error:', err);
        process.exit(1);
    });
