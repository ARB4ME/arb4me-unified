/**
 * Funding Rate Research Script
 * Investigates which of our 19 exchanges support perpetual futures
 * and fetches current funding rates
 *
 * Run with: node scripts/research-funding-rates.js
 */

const https = require('https');
const http = require('http');

// Our 19 exchanges
const ALL_EXCHANGES = [
    // South African
    'valr', 'luno', 'chainex',
    // International
    'binance', 'kraken', 'okx', 'bybit', 'gateio', 'mexc', 'kucoin',
    'xt', 'ascendex', 'bingx', 'gemini', 'htx', 'bitget', 'bitmart', 'bitrue', 'coincatch'
];

// Target cryptos for funding arb (same as transfer arb)
const TARGET_CRYPTOS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LTC'];

// Simple fetch wrapper
function fetchJSON(url, options = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? https : http;
        const timeout = options.timeout || 10000;

        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'ARB4ME-FundingResearch/1.0',
                'Accept': 'application/json',
                ...options.headers
            },
            timeout: timeout
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

// Exchange-specific funding rate fetchers
const fundingFetchers = {

    // BINANCE - Largest futures exchange
    async binance() {
        console.log('  📡 Binance Futures...');
        try {
            const { data } = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex');

            const rates = {};
            for (const item of data) {
                // Extract base asset (BTCUSDT -> BTC)
                const symbol = item.symbol;
                if (symbol.endsWith('USDT')) {
                    const crypto = symbol.replace('USDT', '');
                    if (TARGET_CRYPTOS.includes(crypto)) {
                        rates[crypto] = {
                            symbol: symbol,
                            fundingRate: parseFloat(item.lastFundingRate) * 100, // Convert to percentage
                            nextFundingTime: new Date(item.nextFundingTime).toISOString(),
                            markPrice: parseFloat(item.markPrice)
                        };
                    }
                }
            }
            return { supported: true, rates, exchange: 'binance', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // BYBIT - Major futures exchange
    async bybit() {
        console.log('  📡 Bybit Futures...');
        try {
            const { data } = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear');

            if (data.retCode !== 0) throw new Error(data.retMsg);

            const rates = {};
            for (const item of data.result.list) {
                if (item.symbol.endsWith('USDT')) {
                    const crypto = item.symbol.replace('USDT', '');
                    if (TARGET_CRYPTOS.includes(crypto)) {
                        rates[crypto] = {
                            symbol: item.symbol,
                            fundingRate: parseFloat(item.fundingRate) * 100,
                            nextFundingTime: new Date(parseInt(item.nextFundingTime)).toISOString(),
                            markPrice: parseFloat(item.markPrice)
                        };
                    }
                }
            }
            return { supported: true, rates, exchange: 'bybit', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // OKX - Major futures exchange
    async okx() {
        console.log('  📡 OKX Futures...');
        try {
            const { data } = await fetchJSON('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP');

            // OKX requires individual calls per instrument, let's get a few
            const rates = {};

            for (const crypto of TARGET_CRYPTOS.slice(0, 5)) { // Limit to avoid rate limits
                try {
                    const { data: rateData } = await fetchJSON(`https://www.okx.com/api/v5/public/funding-rate?instId=${crypto}-USDT-SWAP`);
                    if (rateData.code === '0' && rateData.data && rateData.data[0]) {
                        rates[crypto] = {
                            symbol: `${crypto}-USDT-SWAP`,
                            fundingRate: parseFloat(rateData.data[0].fundingRate) * 100,
                            nextFundingTime: new Date(parseInt(rateData.data[0].nextFundingTime)).toISOString(),
                            markPrice: null
                        };
                    }
                    await sleep(100);
                } catch (e) {
                    // Skip this crypto
                }
            }

            return { supported: true, rates, exchange: 'okx', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // GATE.IO - Has futures
    async gateio() {
        console.log('  📡 Gate.io Futures...');
        try {
            const { data } = await fetchJSON('https://api.gateio.ws/api/v4/futures/usdt/contracts');

            const rates = {};
            for (const item of data) {
                const crypto = item.name.replace('_USDT', '');
                if (TARGET_CRYPTOS.includes(crypto)) {
                    rates[crypto] = {
                        symbol: item.name,
                        fundingRate: parseFloat(item.funding_rate) * 100,
                        nextFundingTime: new Date(item.funding_next_apply * 1000).toISOString(),
                        markPrice: parseFloat(item.mark_price)
                    };
                }
            }
            return { supported: true, rates, exchange: 'gateio', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // MEXC - Has futures
    async mexc() {
        console.log('  📡 MEXC Futures...');
        try {
            const { data } = await fetchJSON('https://contract.mexc.com/api/v1/contract/funding_rate');

            if (!data.success) throw new Error('MEXC API error');

            const rates = {};
            for (const item of data.data) {
                const crypto = item.symbol.replace('_USDT', '');
                if (TARGET_CRYPTOS.includes(crypto)) {
                    rates[crypto] = {
                        symbol: item.symbol,
                        fundingRate: parseFloat(item.fundingRate) * 100,
                        nextFundingTime: new Date(item.nextSettleTime).toISOString(),
                        markPrice: null
                    };
                }
            }
            return { supported: true, rates, exchange: 'mexc', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // BITGET - Has futures
    async bitget() {
        console.log('  📡 Bitget Futures...');
        try {
            const { data } = await fetchJSON('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');

            if (data.code !== '00000') throw new Error(data.msg);

            const rates = {};
            for (const item of data.data) {
                const crypto = item.symbol.replace('USDT', '');
                if (TARGET_CRYPTOS.includes(crypto)) {
                    rates[crypto] = {
                        symbol: item.symbol,
                        fundingRate: parseFloat(item.fundingRate) * 100,
                        nextFundingTime: null,
                        markPrice: parseFloat(item.markPrice)
                    };
                }
            }
            return { supported: true, rates, exchange: 'bitget', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // BINGX - Has futures
    async bingx() {
        console.log('  📡 BingX Futures...');
        try {
            const { data } = await fetchJSON('https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex');

            if (data.code !== 0) throw new Error(data.msg);

            const rates = {};
            for (const item of data.data) {
                const crypto = item.symbol.replace('-USDT', '');
                if (TARGET_CRYPTOS.includes(crypto)) {
                    rates[crypto] = {
                        symbol: item.symbol,
                        fundingRate: parseFloat(item.lastFundingRate) * 100,
                        nextFundingTime: new Date(item.nextFundingTime).toISOString(),
                        markPrice: parseFloat(item.markPrice)
                    };
                }
            }
            return { supported: true, rates, exchange: 'bingx', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // HTX (Huobi) - Has futures
    async htx() {
        console.log('  📡 HTX Futures...');
        try {
            const { data } = await fetchJSON('https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate');

            if (data.status !== 'ok') throw new Error('HTX API error');

            const rates = {};
            for (const item of data.data) {
                const crypto = item.contract_code.replace('-USDT', '');
                if (TARGET_CRYPTOS.includes(crypto)) {
                    rates[crypto] = {
                        symbol: item.contract_code,
                        fundingRate: parseFloat(item.funding_rate) * 100,
                        nextFundingTime: new Date(item.next_funding_time).toISOString(),
                        markPrice: null
                    };
                }
            }
            return { supported: true, rates, exchange: 'htx', interval: '8h' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // KUCOIN - Has futures (separate API)
    async kucoin() {
        console.log('  📡 KuCoin Futures...');
        try {
            const { data } = await fetchJSON('https://api-futures.kucoin.com/api/v1/contracts/active');

            if (data.code !== '200000') throw new Error(data.msg);

            const rates = {};
            for (const item of data.data) {
                if (item.symbol.endsWith('USDTM')) {
                    const crypto = item.symbol.replace('USDTM', '');
                    if (TARGET_CRYPTOS.includes(crypto)) {
                        rates[crypto] = {
                            symbol: item.symbol,
                            fundingRate: parseFloat(item.fundingFeeRate) * 100,
                            nextFundingTime: new Date(item.nextFundingRateTime).toISOString(),
                            markPrice: parseFloat(item.markPrice)
                        };
                    }
                }
            }
            return { supported: true, rates, exchange: 'kucoin', interval: '8h', note: 'Separate futures API - may need different credentials' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },

    // Exchanges WITHOUT perpetual futures
    async valr() {
        return { supported: false, reason: 'South African exchange - spot only' };
    },
    async luno() {
        return { supported: false, reason: 'South African exchange - spot only' };
    },
    async chainex() {
        return { supported: false, reason: 'South African exchange - spot only' };
    },
    async gemini() {
        return { supported: false, reason: 'US exchange - no perpetual futures' };
    },
    async kraken() {
        return { supported: false, reason: 'Limited futures - not suitable for funding arb' };
    },
    async bitmart() {
        console.log('  📡 BitMart Futures...');
        try {
            const { data } = await fetchJSON('https://api-cloud.bitmart.com/contract/public/details');
            if (data.code === 1000 && data.data && data.data.symbols) {
                const rates = {};
                for (const item of data.data.symbols) {
                    const crypto = item.symbol.replace('USDT', '');
                    if (TARGET_CRYPTOS.includes(crypto) && item.funding_rate) {
                        rates[crypto] = {
                            symbol: item.symbol,
                            fundingRate: parseFloat(item.funding_rate) * 100,
                            nextFundingTime: null,
                            markPrice: null
                        };
                    }
                }
                return { supported: true, rates, exchange: 'bitmart', interval: '8h' };
            }
            return { supported: false, reason: 'No futures data available' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },
    async bitrue() {
        return { supported: false, reason: 'Limited futures support' };
    },
    async xt() {
        console.log('  📡 XT Futures...');
        try {
            const { data } = await fetchJSON('https://fapi.xt.com/future/market/v1/public/q/funding-rate');
            if (data.result) {
                const rates = {};
                for (const item of data.result) {
                    const crypto = item.symbol.replace('_usdt', '').toUpperCase();
                    if (TARGET_CRYPTOS.includes(crypto)) {
                        rates[crypto] = {
                            symbol: item.symbol,
                            fundingRate: parseFloat(item.fundingRate) * 100,
                            nextFundingTime: null,
                            markPrice: null
                        };
                    }
                }
                return { supported: true, rates, exchange: 'xt', interval: '8h' };
            }
            return { supported: false, reason: 'No futures data' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    },
    async ascendex() {
        return { supported: false, reason: 'Futures API requires authentication' };
    },
    async coincatch() {
        console.log('  📡 CoinCatch Futures...');
        try {
            const { data } = await fetchJSON('https://api.coincatch.com/api/mix/v1/market/tickers?productType=umcbl');
            if (data.code === '00000' && data.data) {
                const rates = {};
                for (const item of data.data) {
                    const crypto = item.symbol.replace('USDT_UMCBL', '');
                    if (TARGET_CRYPTOS.includes(crypto) && item.fundingRate) {
                        rates[crypto] = {
                            symbol: item.symbol,
                            fundingRate: parseFloat(item.fundingRate) * 100,
                            nextFundingTime: null,
                            markPrice: parseFloat(item.markPrice)
                        };
                    }
                }
                return { supported: true, rates, exchange: 'coincatch', interval: '8h' };
            }
            return { supported: false, reason: 'No futures data' };
        } catch (e) {
            return { supported: false, error: e.message };
        }
    }
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function research() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Funding Rate Arbitrage Research');
    console.log('  Investigating perpetual futures support across 19 exchanges');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const results = {
        supported: [],
        notSupported: [],
        fundingRates: {}
    };

    for (const exchange of ALL_EXCHANGES) {
        console.log(`\n🏦 ${exchange.toUpperCase()}`);

        if (fundingFetchers[exchange]) {
            const result = await fundingFetchers[exchange]();

            if (result.supported) {
                results.supported.push({
                    exchange,
                    interval: result.interval,
                    cryptoCount: Object.keys(result.rates).length,
                    note: result.note
                });
                results.fundingRates[exchange] = result.rates;
                console.log(`  ✅ SUPPORTED - ${Object.keys(result.rates).length} cryptos with funding rates`);
            } else {
                results.notSupported.push({
                    exchange,
                    reason: result.reason || result.error
                });
                console.log(`  ❌ Not supported: ${result.reason || result.error}`);
            }
        }

        await sleep(300); // Rate limiting
    }

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');

    console.log(`\n✅ EXCHANGES WITH PERPETUAL FUTURES (${results.supported.length}):`);
    results.supported.forEach(ex => {
        console.log(`   ${ex.exchange.padEnd(12)} - ${ex.cryptoCount} cryptos, ${ex.interval} funding interval${ex.note ? ' (' + ex.note + ')' : ''}`);
    });

    console.log(`\n❌ EXCHANGES WITHOUT FUTURES (${results.notSupported.length}):`);
    results.notSupported.forEach(ex => {
        console.log(`   ${ex.exchange.padEnd(12)} - ${ex.reason}`);
    });

    // Current funding rates comparison
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  CURRENT FUNDING RATES COMPARISON');
    console.log('═══════════════════════════════════════════════════════════════');

    for (const crypto of TARGET_CRYPTOS) {
        console.log(`\n📊 ${crypto}:`);
        const ratesByExchange = [];

        for (const [exchange, rates] of Object.entries(results.fundingRates)) {
            if (rates[crypto]) {
                ratesByExchange.push({
                    exchange,
                    rate: rates[crypto].fundingRate
                });
            }
        }

        // Sort by rate (highest first - best for collecting funding)
        ratesByExchange.sort((a, b) => b.rate - a.rate);

        ratesByExchange.forEach(item => {
            const rateStr = item.rate >= 0 ? `+${item.rate.toFixed(4)}%` : `${item.rate.toFixed(4)}%`;
            const indicator = item.rate > 0.01 ? '🔥' : (item.rate > 0 ? '✓' : '⚠️');
            console.log(`   ${indicator} ${item.exchange.padEnd(12)} ${rateStr} per 8h`);
        });

        // Calculate potential daily/monthly returns
        if (ratesByExchange.length > 0) {
            const bestRate = ratesByExchange[0];
            const dailyReturn = bestRate.rate * 3; // 3 funding periods per day
            const monthlyReturn = dailyReturn * 30;
            console.log(`   💰 Best: ${bestRate.exchange} → ${dailyReturn.toFixed(3)}%/day, ${monthlyReturn.toFixed(1)}%/month`);
        }
    }

    // Save results
    const fs = require('fs');
    const path = require('path');
    const outputPath = path.join(__dirname, 'funding-rates-research.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\n📄 Full results saved to: ${outputPath}`);

    // Recommendation
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  RECOMMENDATION');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n  Best exchanges for funding rate arbitrage:');
    console.log('  1. Binance  - Highest liquidity, reliable API');
    console.log('  2. Bybit    - Good rates, unified account (same API as spot)');
    console.log('  3. OKX      - Unified account, competitive rates');
    console.log('  4. Bitget   - Growing exchange, good funding rates');
    console.log('  5. Gate.io  - Wide crypto selection');
    console.log('\n  These 5 can reuse existing Transfer ARB API credentials!');

    return results;
}

research().catch(err => {
    console.error('Research failed:', err);
    process.exit(1);
});
