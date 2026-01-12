/**
 * Test script for network detection and smart selection
 * Run with: node scripts/test-network-selection.js
 */

// Mock the logger to avoid dependency issues
const mockLogger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: () => {} // Suppress debug logs
};

// Mock the require for logger
require.cache[require.resolve('../src/utils/logger')] = {
    exports: { systemLogger: mockLogger }
};

const NetworkDetectionService = require('../src/services/networkDetectionService');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Network Detection & Smart Selection Test');
console.log('═══════════════════════════════════════════════════════════════\n');

// Test 1: Network normalization
console.log('📋 TEST 1: Network Name Normalization');
console.log('─'.repeat(50));

const testNames = [
    'TRC20', 'TRON', 'tron (trc20)',
    'XLM', 'STELLARLUMENS', 'STELLAR NETWORK',
    'AVAX-C', 'AVALANCHE C CHAIN', 'AVAXC-CHAIN',
    'BCH', 'BITCOIN ABC', 'BITCOIN CASH',
    'ERC20', 'ETHEREUM', 'ETH',
    'ARBITRUMONE', 'ARBITRUM ONE', 'ARB'
];

for (const name of testNames) {
    const normalized = NetworkDetectionService.normalizeNetworkName(name);
    const status = normalized !== name.toUpperCase().replace(/[^A-Z0-9\-]/gi, '') ? '✅' : '➡️';
    console.log(`  ${status} "${name}" → "${normalized}"`);
}

// Test 2: Common networks for each crypto
console.log('\n📋 TEST 2: Common Networks (getCommonNetworks)');
console.log('─'.repeat(50));

const testCryptos = ['XRP', 'XLM', 'TRX', 'USDT', 'USDC', 'ETH', 'BTC', 'MATIC', 'AVAX'];

for (const crypto of testCryptos) {
    const networks = NetworkDetectionService.getCommonNetworks(crypto);
    const networkList = networks.map(n => `${n.network}(p${n.priority})`).join(', ');
    console.log(`  ${crypto}: ${networkList}`);
}

// Test 3: Find matching networks
console.log('\n📋 TEST 3: Find Matching Networks');
console.log('─'.repeat(50));

// Test matching between two hypothetical exchanges
const exchange1Networks = [
    { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1 },
    { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 15 },
    { network: 'BEP20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.5 }
];

const exchange2Networks = [
    { network: 'TRC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 1 },
    { network: 'ERC20', withdrawEnabled: true, depositEnabled: true, withdrawFee: 15 },
    { network: 'POLYGON', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.1 }
];

const matches = NetworkDetectionService.findMatchingNetworks(exchange1Networks, exchange2Networks);
console.log('  Exchange 1 networks: TRC20, ERC20, BEP20');
console.log('  Exchange 2 networks: TRC20, ERC20, POLYGON');
console.log('  Matching networks (sorted by priority):');
matches.forEach((m, i) => {
    console.log(`    ${i + 1}. ${m.network} - priority: ${m.priority}, fee: $${m.estimatedFeeUSD}`);
});

// Test 4: Recommended networks
console.log('\n📋 TEST 4: Recommended Networks');
console.log('─'.repeat(50));

for (const crypto of testCryptos) {
    const recommended = NetworkDetectionService.getRecommendedNetwork(crypto);
    console.log(`  ${crypto}: ${recommended}`);
}

// Test 5: Verify naming variations work
console.log('\n📋 TEST 5: Cross-Exchange Network Matching (with variations)');
console.log('─'.repeat(50));

// Simulate Bitget (uses STELLARLUMENS) vs Binance (uses XLM)
const bitgetXLM = [
    { network: 'STELLARLUMENS', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01 }
];
const binanceXLM = [
    { network: 'XLM', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01 }
];

const xlmMatches = NetworkDetectionService.findMatchingNetworks(bitgetXLM, binanceXLM);
console.log('  Bitget (STELLARLUMENS) vs Binance (XLM):');
console.log(`  Matches found: ${xlmMatches.length}`);
if (xlmMatches.length > 0) {
    console.log(`  ✅ Match: ${xlmMatches[0].network} (normalized from "${xlmMatches[0].rawFromNetwork}" → "${xlmMatches[0].rawToNetwork}")`);
} else {
    console.log('  ❌ No match found - normalization may need improvement');
}

// Test AVAX variations
const exchange1AVAX = [
    { network: 'AVALANCHE C CHAIN', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01 }
];
const exchange2AVAX = [
    { network: 'AVAX-C', withdrawEnabled: true, depositEnabled: true, withdrawFee: 0.01 }
];

const avaxMatches = NetworkDetectionService.findMatchingNetworks(exchange1AVAX, exchange2AVAX);
console.log('\n  Exchange 1 (AVALANCHE C CHAIN) vs Exchange 2 (AVAX-C):');
console.log(`  Matches found: ${avaxMatches.length}`);
if (avaxMatches.length > 0) {
    console.log(`  ✅ Match: ${avaxMatches[0].network}`);
} else {
    console.log('  ❌ No match found');
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  Tests Complete!');
console.log('═══════════════════════════════════════════════════════════════\n');
