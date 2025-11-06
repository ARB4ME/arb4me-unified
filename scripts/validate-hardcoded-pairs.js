/**
 * Validation Script: Verify Hardcoded USDT Pairs Per Exchange
 *
 * Purpose: Check if our hardcoded pairs actually exist on each exchange
 * Run this once to validate, then surgically fix any mismatches
 *
 * Usage: node scripts/validate-hardcoded-pairs.js
 */

const crypto = require('crypto');

// These are the HARDCODED pairs we're currently using for each exchange
const HARDCODED_PAIRS = {
    binance: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'],
    xt: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'],
    ascendex: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'],
    gemini: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'],
    coincatch: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'],
    okx: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'],
    valr: ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX'],
};

/**
 * Fetch available USDT pairs from Binance (public API, no auth needed)
 */
async function fetchBinancePairs() {
    try {
        const response = await fetch('https://api.binance.com/api/v3/exchangeInfo');
        const data = await response.json();

        const usdtPairs = data.symbols
            .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING')
            .map(s => s.symbol.replace('USDT', ''));

        return usdtPairs;
    } catch (error) {
        console.error('Binance fetch failed:', error.message);
        return null;
    }
}

/**
 * Fetch available USDT pairs from XT.com (public API)
 */
async function fetchXTPairs() {
    try {
        const response = await fetch('https://sapi.xt.com/v4/public/symbol');
        const data = await response.json();

        if (data.rc !== 0) {
            throw new Error(`XT API error: ${data.msg}`);
        }

        const usdtPairs = data.result.symbols
            .filter(s => s.symbol.endsWith('_usdt') && s.state === 'ONLINE')
            .map(s => s.symbol.replace('_usdt', '').toUpperCase());

        return usdtPairs;
    } catch (error) {
        console.error('XT.com fetch failed:', error.message);
        return null;
    }
}

/**
 * Fetch available pairs from Gemini (public API)
 */
async function fetchGeminiPairs() {
    try {
        const response = await fetch('https://api.gemini.com/v1/symbols');
        const symbols = await response.json();

        // Gemini uses format like "btcusd", convert to base asset
        const usdtPairs = symbols
            .filter(s => s.endsWith('usd'))
            .map(s => s.replace('usd', '').toUpperCase());

        return usdtPairs;
    } catch (error) {
        console.error('Gemini fetch failed:', error.message);
        return null;
    }
}

/**
 * Fetch available USDT pairs from Coincatch (public API)
 */
async function fetchCoincatchPairs() {
    try {
        const response = await fetch('https://api.coincatch.com/api/spot/v1/public/products');
        const data = await response.json();

        if (data.code !== '00000') {
            throw new Error(`Coincatch API error: ${data.msg}`);
        }

        const usdtPairs = data.data
            .filter(p => p.quoteCoin === 'USDT' && p.status === 'online')  // FIXED: status === 'online'
            .map(p => p.baseCoin);

        return usdtPairs;
    } catch (error) {
        console.error('Coincatch fetch failed:', error.message);
        return null;
    }
}

/**
 * Fetch available USDT pairs from OKX (public API)
 */
async function fetchOKXPairs() {
    try {
        const response = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
        const data = await response.json();

        if (data.code !== '0') {
            throw new Error(`OKX API error: ${data.msg}`);
        }

        const usdtPairs = data.data
            .filter(p => p.instId.endsWith('-USDT'))
            .map(p => p.instId.replace('-USDT', ''));

        return usdtPairs;
    } catch (error) {
        console.error('OKX fetch failed:', error.message);
        return null;
    }
}

/**
 * Fetch available USDT pairs from AscendEX (public API)
 */
async function fetchAscendEXPairs() {
    try {
        const response = await fetch('https://ascendex.com/api/pro/v1/products');
        const data = await response.json();

        if (data.code !== 0) {
            throw new Error(`AscendEX API error: ${data.message}`);
        }

        const usdtPairs = data.data
            .filter(p => p.symbol.endsWith('/USDT') && p.status === 'Normal')
            .map(p => p.symbol.replace('/USDT', ''));

        return usdtPairs;
    } catch (error) {
        console.error('AscendEX fetch failed:', error.message);
        return null;
    }
}

/**
 * Fetch available USDT pairs from VALR (public API)
 */
async function fetchVALRPairs() {
    try {
        const response = await fetch('https://api.valr.com/v1/public/pairs');
        const pairs = await response.json();

        const usdtPairs = pairs
            .filter(p => p.quoteCurrency === 'USDT' && p.active)
            .map(p => p.baseCurrency);

        return usdtPairs;
    } catch (error) {
        console.error('VALR fetch failed:', error.message);
        return null;
    }
}

/**
 * Compare hardcoded pairs vs actual available pairs
 */
function comparePairs(exchange, hardcoded, actual) {
    if (!actual) {
        console.log(`\n❌ ${exchange.toUpperCase()}: Failed to fetch pairs from API\n`);
        return;
    }

    const hardcodedSet = new Set(hardcoded);
    const actualSet = new Set(actual);

    const valid = hardcoded.filter(p => actualSet.has(p));
    const invalid = hardcoded.filter(p => !actualSet.has(p));
    const missing = actual.filter(p => hardcodedSet.has(p) || ['BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOT', 'MATIC', 'AVAX', 'LINK', 'LTC', 'ATOM'].includes(p))
        .filter(p => !hardcodedSet.has(p));

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 ${exchange.toUpperCase()} VALIDATION`);
    console.log(`${'='.repeat(60)}`);

    console.log(`\n✅ VALID (${valid.length}/${hardcoded.length}): Hardcoded pairs that exist on exchange`);
    console.log(`   ${valid.join(', ')}`);

    if (invalid.length > 0) {
        console.log(`\n❌ INVALID (${invalid.length}): Hardcoded pairs that DON'T exist - REMOVE THESE!`);
        console.log(`   ${invalid.join(', ')}`);
    }

    if (missing.length > 0) {
        console.log(`\nℹ️  AVAILABLE (${missing.length}): Popular pairs you could ADD (optional)`);
        console.log(`   ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`);
    }

    if (invalid.length === 0) {
        console.log(`\n🎉 ALL HARDCODED PAIRS ARE VALID!`);
    }
}

/**
 * Main validation function
 */
async function validateAllExchanges() {
    console.log('\n🔍 VALIDATING HARDCODED USDT PAIRS PER EXCHANGE');
    console.log('This will check if our hardcoded pairs actually exist on each exchange\n');

    // Binance
    const binancePairs = await fetchBinancePairs();
    comparePairs('binance', HARDCODED_PAIRS.binance, binancePairs);

    // XT.com
    const xtPairs = await fetchXTPairs();
    comparePairs('xt', HARDCODED_PAIRS.xt, xtPairs);

    // AscendEX
    const ascendexPairs = await fetchAscendEXPairs();
    comparePairs('ascendex', HARDCODED_PAIRS.ascendex, ascendexPairs);

    // Gemini
    const geminiPairs = await fetchGeminiPairs();
    comparePairs('gemini', HARDCODED_PAIRS.gemini, geminiPairs);

    // Coincatch
    const coincatchPairs = await fetchCoincatchPairs();
    comparePairs('coincatch', HARDCODED_PAIRS.coincatch, coincatchPairs);

    // OKX
    const okxPairs = await fetchOKXPairs();
    comparePairs('okx', HARDCODED_PAIRS.okx, okxPairs);

    // VALR
    const valrPairs = await fetchVALRPairs();
    comparePairs('valr', HARDCODED_PAIRS.valr, valrPairs);

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ VALIDATION COMPLETE');
    console.log(`${'='.repeat(60)}\n`);
}

// Run validation
validateAllExchanges().catch(console.error);
