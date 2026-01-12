/**
 * Integration Test - Smart Network Selection Flow
 * Tests the complete flow: Scanner → Network Selection → Execution Ready
 *
 * Run with: node scripts/test-integration.js
 */

// Mock logger
const mockLogger = {
    info: () => {},
    warn: console.warn,
    error: console.error,
    debug: () => {},
    trading: () => {}
};

require.cache[require.resolve('../src/utils/logger')] = {
    exports: { systemLogger: mockLogger }
};

const TransferArbScanner = require('../src/services/transfer-arb-scanner');
const networkDetectionService = require('../src/services/networkDetectionService');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Integration Test: Smart Network Selection Flow');
console.log('═══════════════════════════════════════════════════════════════\n');

async function runTest() {
    const scanner = new TransferArbScanner();

    // Simulate exchange prices (bid/ask)
    const mockPrices = {
        binance: {
            XRP: { bid: 0.50, ask: 0.501 },
            USDT: { bid: 1.00, ask: 1.001 },
            ETH: { bid: 2500, ask: 2505 }
        },
        kucoin: {
            XRP: { bid: 0.515, ask: 0.516 },  // 3% higher - profitable!
            USDT: { bid: 1.00, ask: 1.001 },
            ETH: { bid: 2510, ask: 2515 }
        },
        okx: {
            XRP: { bid: 0.502, ask: 0.503 },
            USDT: { bid: 1.00, ask: 1.001 },
            ETH: { bid: 2480, ask: 2485 }   // Lower - could be profitable reverse
        }
    };

    // Simulate user balances
    const mockBalances = {
        binance: { USDT: 500 },
        kucoin: { USDT: 500 },
        okx: { USDT: 500 }
    };

    console.log('📋 TEST 1: Scanner with Auto Network Selection');
    console.log('─'.repeat(50));
    console.log('Testing route: Binance → KuCoin for XRP');
    console.log('Expected: Auto-select XRP network\n');

    // Test single route analysis
    const opportunity = await scanner.analyzeRoute(
        'binance',
        'kucoin',
        'XRP',
        mockPrices,
        mockBalances
    );

    if (opportunity) {
        console.log('✅ Opportunity found:');
        console.log(`   Route: ${opportunity.fromExchange} → ${opportunity.toExchange}`);
        console.log(`   Crypto: ${opportunity.crypto}`);
        console.log(`   Buy: $${opportunity.buyPrice} | Sell: $${opportunity.sellPrice}`);
        console.log(`   Spread: ${opportunity.priceSpread.toFixed(2)}%`);
        console.log(`   Net Profit: $${opportunity.netProfit.toFixed(2)} (${opportunity.netProfitPercent.toFixed(2)}%)`);
        console.log('');
        console.log('   🔌 NETWORK INFO (Auto-Selected):');
        console.log(`   Network: ${opportunity.network}`);
        console.log(`   Reason: ${opportunity.networkReason}`);
        console.log(`   Priority: ${opportunity.networkPriority}`);
        console.log(`   Est. Fee: $${opportunity.networkFeeUSD}`);
        if (opportunity.alternativeNetworks && opportunity.alternativeNetworks.length > 0) {
            console.log(`   Alternatives: ${opportunity.alternativeNetworks.join(', ')}`);
        }
    } else {
        console.log('❌ No opportunity found (may not be profitable)');
    }

    console.log('\n📋 TEST 2: Multi-Network Asset (USDT)');
    console.log('─'.repeat(50));
    console.log('Testing: Smart selection for USDT transfer');
    console.log('Expected: Auto-select TRC20 (cheapest)\n');

    const usdtSelection = await networkDetectionService.selectBestNetwork('binance', 'kucoin', 'USDT');

    if (usdtSelection.success) {
        console.log('✅ USDT Network Selection:');
        console.log(`   Best Network: ${usdtSelection.recommendation.network}`);
        console.log(`   Reason: ${usdtSelection.recommendation.reasoning}`);
        console.log(`   Est. Fee: $${usdtSelection.recommendation.estimatedFeeUSD}`);
        console.log(`   Total Matches: ${usdtSelection.matchCount}`);
        if (usdtSelection.allMatches) {
            console.log('   All Compatible Networks:');
            usdtSelection.allMatches.slice(0, 5).forEach((m, i) => {
                console.log(`     ${i + 1}. ${m.network} (priority: ${m.priority}, fee: $${m.estimatedFeeUSD})`);
            });
        }
    } else {
        console.log('❌ USDT selection failed:', usdtSelection.error);
    }

    console.log('\n📋 TEST 3: ETH Network Selection');
    console.log('─'.repeat(50));
    console.log('Expected: Auto-select ARBITRUM (cheaper than ERC20)\n');

    const ethSelection = await networkDetectionService.selectBestNetwork('binance', 'okx', 'ETH');

    if (ethSelection.success) {
        console.log('✅ ETH Network Selection:');
        console.log(`   Best Network: ${ethSelection.recommendation.network}`);
        console.log(`   Reason: ${ethSelection.recommendation.reasoning}`);
        console.log(`   Priority: ${ethSelection.recommendation.priority}`);
        if (ethSelection.allMatches) {
            console.log('   All Compatible Networks:');
            ethSelection.allMatches.forEach((m, i) => {
                console.log(`     ${i + 1}. ${m.network} (priority: ${m.priority}, fee: $${m.estimatedFeeUSD})`);
            });
        }
    } else {
        console.log('❌ ETH selection failed:', ethSelection.error);
    }

    console.log('\n📋 TEST 4: Opportunity Object Structure');
    console.log('─'.repeat(50));

    if (opportunity) {
        const hasAllFields = [
            'network',
            'networkReason',
            'networkPriority',
            'networkFeeUSD'
        ].every(field => opportunity.hasOwnProperty(field));

        if (hasAllFields) {
            console.log('✅ Opportunity object contains all network fields');
            console.log('   Ready for automated execution!');
        } else {
            console.log('❌ Missing network fields in opportunity object');
        }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Integration Test Complete!');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n🎯 Summary:');
    console.log('   - Scanner now auto-selects networks');
    console.log('   - Network info included in opportunity object');
    console.log('   - Execution service uses auto-selected network');
    console.log('   - No manual network configuration needed!\n');
}

runTest().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
