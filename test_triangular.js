// Test Triangular Arbitrage Execution Logic
// This script verifies the triangular arbitrage functions work correctly

console.log('🧪 Testing Triangular Arbitrage Execution Logic...');

// Mock state and functions for testing
const state = {
    triangularArbitrage: true,
    settings: {
        maxTradeAmount: 50,
        tradeSize: 15
    },
    balances: {
        luno: {
            USDT: 53.97
        }
    }
};

// Mock delay function
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock addActivity function
function addActivity(message, type) {
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// Mock getRealPrice function
async function getRealPrice(pair, exchange) {
    // Simulate slightly profitable prices for testing execution
    const mockPrices = {
        'XBTUSDT': 65000,  // BTC price in USDT
        'ETHXBT': 0.037,   // ETH price in BTC (slightly better rate - more BTC per ETH)
        'ETHUSDT': 2470    // ETH price in USDT
    };
    
    return mockPrices[pair] || null;
}

// Mock Luno configuration
const lunoConfig = {
    profitThreshold: 0.8, // 0.8% minimum profit
    fees: {
        taker: 0.002, // 0.2% per trade
        total: 0.006  // 0.6% total for 3 trades
    }
};

// Luno triangular paths
const lunoTriangularPaths = {
    USDT_BTC_ETH: {
        pairs: ['XBTUSDT', 'ETHXBT', 'ETHUSDT'],
        sequence: 'USDT → BTC → ETH → USDT',
        baseCurrency: 'USDT',
        verified: true
    }
};

// Calculate Luno triangular profit (simplified version)
async function calculateLunoTriangularProfit(pathConfig, amount = 100) {
    const [pair1, pair2, pair3] = pathConfig.pairs;
    
    try {
        const price1 = await getRealPrice(pair1);
        const price2 = await getRealPrice(pair2);
        const price3 = await getRealPrice(pair3);
        
        if (!price1 || !price2 || !price3) {
            return null;
        }
        
        console.log(`Prices: ${pair1}=${price1}, ${pair2}=${price2}, ${pair3}=${price3}`);
        
        // Calculate triangular arbitrage
        const btcAmount = amount / price1;  // USDT/XBTUSDT = BTC
        const intermediateAmount = btcAmount / price2;  // BTC ÷ ETHXBT = ETH
        const finalAmount = intermediateAmount * price3;  // ETH × ETHUSDT = USDT
        
        const grossProfit = finalAmount - amount;
        const grossProfitPercent = (grossProfit / amount) * 100;
        
        // Apply fees
        const totalFees = amount * lunoConfig.fees.total;
        const netProfit = grossProfit - totalFees;
        const netProfitPercent = (netProfit / amount) * 100;
        
        console.log(`Calculation: ${amount} USDT → ${btcAmount.toFixed(6)} BTC → ${intermediateAmount.toFixed(6)} ETH → ${finalAmount.toFixed(2)} USDT`);
        console.log(`Gross profit: ${grossProfit.toFixed(4)} USDT (${grossProfitPercent.toFixed(3)}%)`);
        console.log(`Fees: ${totalFees.toFixed(4)} USDT`);
        console.log(`Net profit: ${netProfit.toFixed(4)} USDT (${netProfitPercent.toFixed(3)}%)`);
        
        return {
            pathName: pathConfig.sequence,
            amount: amount,
            grossProfit: grossProfit,
            grossProfitPercent: grossProfitPercent,
            netProfit: netProfit,
            netProfitPercent: netProfitPercent,
            profitable: netProfitPercent > lunoConfig.profitThreshold,
            prices: pathConfig.pairs,
            exchange: 'LUNO'
        };
        
    } catch (error) {
        console.error('Error calculating profit:', error);
        return null;
    }
}

// Execute a mock trade
async function executeTrade({ pair, side, amount, expectedPrice, step, totalSteps }) {
    console.log(`📊 Step ${step}/${totalSteps}: ${side} ${amount.toFixed(4)} on ${pair} at ~${expectedPrice}`);
    
    await delay(200); // Simulate network delay
    
    let receivedAmount;
    if (side === 'BUY') {
        receivedAmount = amount / expectedPrice;
    } else {
        receivedAmount = amount * expectedPrice;
    }
    
    // Apply fees
    const fee = receivedAmount * 0.002; // 0.2%
    receivedAmount = receivedAmount - fee;
    
    console.log(`✅ Step ${step} completed: Received ${receivedAmount.toFixed(6)} (fee: ${fee.toFixed(6)})`);
    
    return {
        success: true,
        pair: pair,
        side: side,
        amountTraded: amount,
        receivedAmount: receivedAmount,
        executedPrice: expectedPrice,
        fee: fee
    };
}

// Execute triangular opportunity (simplified)
async function executeTriangularOpportunity(opportunity) {
    try {
        const tradeAmount = 8.10; // User's max trade amount
        
        console.log(`🔺 Starting execution: ${opportunity.pathName}`);
        console.log(`💰 Trade amount: $${tradeAmount.toFixed(2)} USDT`);
        
        const prices = [65000, 0.037, 2470]; // Mock prices
        let currentAmount = tradeAmount;
        const executionResults = [];
        
        // Step 1: USDT → BTC
        const step1 = await executeTrade({
            pair: opportunity.prices[0],
            side: 'BUY',
            amount: currentAmount,
            expectedPrice: prices[0],
            step: 1,
            totalSteps: 3
        });
        executionResults.push(step1);
        currentAmount = step1.receivedAmount;
        
        await delay(1000);
        
        // Step 2: BTC → ETH
        const step2 = await executeTrade({
            pair: opportunity.prices[1],
            side: 'SELL',
            amount: currentAmount,
            expectedPrice: prices[1],
            step: 2,
            totalSteps: 3
        });
        executionResults.push(step2);
        currentAmount = step2.receivedAmount;
        
        await delay(1000);
        
        // Step 3: ETH → USDT
        const step3 = await executeTrade({
            pair: opportunity.prices[2],
            side: 'SELL',
            amount: currentAmount,
            expectedPrice: prices[2],
            step: 3,
            totalSteps: 3
        });
        executionResults.push(step3);
        const finalAmount = step3.receivedAmount;
        
        // Calculate actual results
        const actualProfit = finalAmount - tradeAmount;
        const actualProfitPercent = (actualProfit / tradeAmount) * 100;
        
        console.log(`\n🎯 Triangular arbitrage complete!`);
        console.log(`💰 Started with: ${tradeAmount} USDT`);
        console.log(`💰 Ended with: ${finalAmount.toFixed(4)} USDT`);
        console.log(`📈 Actual profit: ${actualProfit.toFixed(4)} USDT (${actualProfitPercent.toFixed(3)}%)`);
        
        addActivity(
            `✅ Triangle Complete: ${opportunity.pathName} - Profit: ${actualProfit.toFixed(4)} USDT (${actualProfitPercent.toFixed(2)}%)`,
            actualProfit > 0 ? 'success' : 'warning'
        );
        
    } catch (error) {
        console.error('Execution failed:', error);
        addActivity(`❌ Execution error: ${error.message}`, 'error');
    }
}

// Main test function
async function testTriangularSystem() {
    console.log('\n=== Testing Triangular Calculation ===');
    
    const pathConfig = lunoTriangularPaths.USDT_BTC_ETH;
    const result = await calculateLunoTriangularProfit(pathConfig, 8.10);
    
    if (result) {
        console.log(`\n📊 Calculation Result:`);
        console.log(`Path: ${result.pathName}`);
        console.log(`Net Profit: ${result.netProfitPercent.toFixed(3)}%`);
        console.log(`Profitable: ${result.profitable ? '✅ YES' : '❌ NO'}`);
        
        if (result.profitable) {
            console.log('\n=== Testing Execution ===');
            await executeTriangularOpportunity(result);
        } else {
            console.log('❌ Not executing - opportunity not profitable');
        }
    } else {
        console.log('❌ Failed to calculate opportunity');
    }
}

// Run the test
testTriangularSystem().then(() => {
    console.log('\n🎉 Test completed!');
}).catch(error => {
    console.error('Test failed:', error);
});