// ============================================
// VALR TRIANGULAR ARBITRAGE MODULE
// ============================================
// Independent module for VALR triangular arbitrage
// Based on Luno template with VALR-specific configurations
//
// This module handles:
// - VALR triangular path configurations  
// - VALR price fetching with caching
// - VALR triangular profit calculations
// - VALR triangular opportunity scanning
// - VALR triangular trade execution
//
// Created: Emergency implementation due to Luno account restrictions
// Status: Ready for testing - VALR has working trade permissions

console.log('🔺 Loading VALR Triangular module...');

const PlatformReporting = {
    // Trade recording functions
    recordTrade: function(tradeData) {
        if (typeof window !== 'undefined' && window.recordVALRTriangularTrade) {
            return window.recordVALRTriangularTrade(tradeData);
        }
        console.log('📊 VALR Trade (offline):', tradeData);
    },
    
    // Activity feed functions
    addActivity: function(message, type = 'info') {
        if (typeof window !== 'undefined' && window.addActivity) {
            return window.addActivity(message, type);
        }
        console.log(`[${type.toUpperCase()}] ${message}`);
    },
    
    addLiveActivity: function(message, type, icon, color) {
        if (typeof window !== 'undefined' && window.addLiveActivity) {
            return window.addLiveActivity(message, type, icon, color);
        }
        console.log(`${icon} ${message}`);
    },
    
    // UI update functions
    updateTradeHistory: function() {
        if (typeof window !== 'undefined' && window.updateTradeHistoryDisplay) {
            return window.updateTradeHistoryDisplay();
        }
    },
    
    updateHub: function() {
        if (typeof window !== 'undefined' && window.updateIntelligenceHub) {
            return window.updateIntelligenceHub();
        }
    },
    
    // Shared utility functions
    delay: function(ms) {
        if (typeof window !== 'undefined' && window.delay) {
            return window.delay(ms);
        }
        return new Promise(resolve => setTimeout(resolve, ms));
    },
    
    getRealPrice: function(pair, exchange) {
        if (typeof window !== 'undefined' && window.getRealPrice) {
            return window.getRealPrice(pair, exchange);
        }
        throw new Error('getRealPrice function not available');
    }
};

// ============================================
// VALR TRIANGULAR CONFIGURATION
// ============================================
// VALR commonly traded pairs - based on major South African exchange

const valrTriangularPaths = {
    // PROVEN WORKING PATHS - USDT/ZAR BASED (NO BTC)
    
    // Direct Asset → USDT → ZAR paths (PROVEN WORKING)
    ZAR_LINK_USDT: {
        pairs: ['LINKZAR', 'LINKUSDT', 'USDTZAR'],
        sequence: 'ZAR → LINK → USDT → ZAR',
        steps: [
            { pair: 'LINKZAR', side: 'buy', description: 'ZAR → LINK' },
            { pair: 'LINKUSDT', side: 'sell', description: 'LINK → USDT' },
            { pair: 'USDTZAR', side: 'sell', description: 'USDT → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: true // Confirmed working in tests
    },
    ZAR_ETH_USDT: {
        pairs: ['ETHZAR', 'ETHUSDT', 'USDTZAR'],
        sequence: 'ZAR → ETH → USDT → ZAR',
        steps: [
            { pair: 'ETHZAR', side: 'buy', description: 'ZAR → ETH' },
            { pair: 'ETHUSDT', side: 'sell', description: 'ETH → USDT' },
            { pair: 'USDTZAR', side: 'sell', description: 'USDT → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    },
    ZAR_ADA_USDT: {
        pairs: ['ADAZAR', 'ADAUSDT', 'USDTZAR'],
        sequence: 'ZAR → ADA → USDT → ZAR',
        steps: [
            { pair: 'ADAZAR', side: 'buy', description: 'ZAR → ADA' },
            { pair: 'ADAUSDT', side: 'sell', description: 'ADA → USDT' },
            { pair: 'USDTZAR', side: 'sell', description: 'USDT → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    },
    ZAR_DOT_USDT: {
        pairs: ['DOTZAR', 'DOTUSDT', 'USDTZAR'],
        sequence: 'ZAR → DOT → USDT → ZAR',
        steps: [
            { pair: 'DOTZAR', side: 'buy', description: 'ZAR → DOT' },
            { pair: 'DOTUSDT', side: 'sell', description: 'DOT → USDT' },
            { pair: 'USDTZAR', side: 'sell', description: 'USDT → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    },
    
    // Reverse paths: ZAR → USDT → Asset → ZAR (PROVEN WORKING)
    ZAR_USDT_LINK: {
        pairs: ['USDTZAR', 'LINKUSDT', 'LINKZAR'],
        sequence: 'ZAR → USDT → LINK → ZAR',
        steps: [
            { pair: 'USDTZAR', side: 'buy', description: 'ZAR → USDT' },
            { pair: 'LINKUSDT', side: 'buy', description: 'USDT → LINK' },
            { pair: 'LINKZAR', side: 'sell', description: 'LINK → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: true // Confirmed working in tests
    },
    ZAR_USDT_ETH: {
        pairs: ['USDTZAR', 'ETHUSDT', 'ETHZAR'],
        sequence: 'ZAR → USDT → ETH → ZAR',
        steps: [
            { pair: 'USDTZAR', side: 'buy', description: 'ZAR → USDT' },
            { pair: 'ETHUSDT', side: 'buy', description: 'USDT → ETH' },
            { pair: 'ETHZAR', side: 'sell', description: 'ETH → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    },
    ZAR_USDT_ADA: {
        pairs: ['USDTZAR', 'ADAUSDT', 'ADAZAR'],
        sequence: 'ZAR → USDT → ADA → ZAR',
        steps: [
            { pair: 'USDTZAR', side: 'buy', description: 'ZAR → USDT' },
            { pair: 'ADAUSDT', side: 'buy', description: 'USDT → ADA' },
            { pair: 'ADAZAR', side: 'sell', description: 'ADA → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    },
    
    // Additional high-volume paths
    ZAR_SOL_USDT: {
        pairs: ['SOLZAR', 'SOLUSDT', 'USDTZAR'],
        sequence: 'ZAR → SOL → USDT → ZAR',
        steps: [
            { pair: 'SOLZAR', side: 'buy', description: 'ZAR → SOL' },
            { pair: 'SOLUSDT', side: 'sell', description: 'SOL → USDT' },
            { pair: 'USDTZAR', side: 'sell', description: 'USDT → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    },
    ZAR_MATIC_USDT: {
        pairs: ['MATICZAR', 'MATICUSDT', 'USDTZAR'],
        sequence: 'ZAR → MATIC → USDT → ZAR',
        steps: [
            { pair: 'MATICZAR', side: 'buy', description: 'ZAR → MATIC' },
            { pair: 'MATICUSDT', side: 'sell', description: 'MATIC → USDT' },
            { pair: 'USDTZAR', side: 'sell', description: 'USDT → ZAR' }
        ],
        baseCurrency: 'ZAR',
        verified: true,
        proven: false
    }
};

// VALR price cache
const valrPriceCache = {
    prices: {},
    lastUpdate: 0,
    ttl: 10000 // Cache for 10 seconds
};

// VALR-specific configuration
const valrConfig = {
    fees: {
        maker: 0.001,        // 0.1% maker
        taker: 0.0015,       // 0.15% taker (lower than Luno)
        total: 0.0045        // 0.45% for 3 taker trades (0.15% × 3)
    },
    profitThreshold: 0.6,    // Need 0.6% profit to overcome 0.45% fees
    rateLimits: {
        triangular: {
            priceChecks: 10,     // VALR typically more permissive
            intervalMs: 5000,    // Every 5 seconds  
            delayBetween: 200,   // 200ms between calls
            maxPerMinute: 100,   // More generous limit
            cacheExtended: true  // Use 10s cache
        }
    }
};

// ============================================
// VALR PRICE FETCHING
// ============================================

async function getVALRPriceWithCache(pair) {
    const now = Date.now();
    
    // Check if cache is still valid
    if (valrPriceCache.prices[pair] && (now - valrPriceCache.lastUpdate) < valrPriceCache.ttl) {
        console.log(`📦 Using cached VALR price for ${pair}: ${valrPriceCache.prices[pair]}`);
        return valrPriceCache.prices[pair];
    }
    
    // Fetch fresh price using platform integration
    try {
        // Use platform's getRealPrice function
        const price = await PlatformReporting.getRealPrice(pair, 'valr');
        
        if (price && price > 0) {
            valrPriceCache.prices[pair] = price;
            valrPriceCache.lastUpdate = now;
            console.log(`🔄 Fetched fresh VALR price for ${pair}: ${price}`);
            return price;
        } else {
            throw new Error(`Invalid price returned for ${pair}: ${price}`);
        }
    } catch (error) {
        console.error(`❌ Failed to get VALR price for ${pair}:`, error);
        
        // Fallback: Try direct fetch to VALR pairs endpoint
        try {
            const response = await fetch('/api/v1/trading/valr/pairs');
            const data = await response.json();
            
            if (!data.success || !data.pairs) {
                throw new Error('Invalid response from VALR pairs endpoint');
            }
            
            const pairData = data.pairs.find(p => p.pair === pair);
            if (!pairData) {
                throw new Error(`Pair ${pair} not found on VALR`);
            }
            
            const price = parseFloat(pairData.lastTradedPrice || pairData.lastPrice);
            if (price && price > 0) {
                valrPriceCache.prices[pair] = price;
                valrPriceCache.lastUpdate = now;
                console.log(`🔄 Fallback: Fetched VALR price for ${pair}: ${price}`);
                return price;
            } else {
                throw new Error(`Invalid fallback price for ${pair}: ${price}`);
            }
        } catch (fallbackError) {
            console.error(`❌ Fallback VALR price fetch also failed for ${pair}:`, fallbackError);
            return null;
        }
    }
}

// ============================================
// VALR PROFIT CALCULATION
// ============================================

async function calculateVALRTriangularProfit(pathConfig, amount = 100) {
    const [pair1, pair2, pair3] = pathConfig.pairs;
    const startTime = Date.now();
    
    try {
        // Get all prices with rate limiting
        const price1 = await getVALRPriceWithCache(pair1);
        await PlatformReporting.delay(valrConfig.rateLimits.triangular.delayBetween);
        
        const price2 = await getVALRPriceWithCache(pair2);
        await PlatformReporting.delay(valrConfig.rateLimits.triangular.delayBetween);
        
        const price3 = await getVALRPriceWithCache(pair3);
        
        if (!price1 || !price2 || !price3) {
            const errorMsg = 'Failed to get all VALR prices for triangular calculation';
            console.error('❌', errorMsg);
            PlatformReporting.addActivity(`❌ VALR triangular: ${errorMsg}`, 'error');
            return null;
        }
        
        // Calculate triangular arbitrage
        // Step 1: Base currency to BTC
        const btcAmount = amount / price1;  // ZAR/BTCZAR = BTC
        
        // Step 2: BTC to intermediate currency (ETH, XRP, etc.)
        const intermediateAmount = btcAmount / price2;  // BTC ÷ ETHBTC = ETH
        
        // Step 3: Intermediate back to base currency
        const finalAmount = intermediateAmount * price3;  // ETH × ETHZAR = ZAR
        
        // Calculate profit
        const profit = finalAmount - amount;
        const profitPercent = (profit / amount) * 100;
        
        // Calculate fees using VALR-specific configuration
        const totalFees = amount * valrConfig.fees.total;
        const netProfit = profit - totalFees;
        const netProfitPercent = (netProfit / amount) * 100;
        
        const executionTime = Date.now() - startTime;
        
        return {
            pathName: pathConfig.sequence,
            pairs: pathConfig.pairs,
            prices: { [pair1]: price1, [pair2]: price2, [pair3]: price3 },
            baseCurrency: pathConfig.baseCurrency,
            startAmount: amount,
            finalAmount: finalAmount,
            profit: profit,
            profitPercent: profitPercent,
            netProfit: netProfit,
            netProfitPercent: netProfitPercent,
            fees: totalFees,
            profitable: netProfitPercent > valrConfig.profitThreshold,
            executionTimeMs: executionTime,
            timestamp: new Date().toISOString(),
            exchange: 'VALR',
            feeStructure: valrConfig.fees
        };
        
    } catch (error) {
        console.error('❌ Error calculating VALR triangular profit:', error);
        PlatformReporting.addActivity(`❌ VALR triangular calculation error: ${error.message}`, 'error');
        return null;
    }
}

// ============================================
// VALR OPPORTUNITY SCANNING
// ============================================

async function scanVALRTriangularOpportunities(showActivity = false) {
    console.log('🔺 Starting VALR triangular arbitrage scan...');
    PlatformReporting.addActivity('🔺 Starting VALR triangular scan...', 'info');
    const opportunities = [];
    
    // Auto-detect funded currencies from balances
    const valrBalances = (typeof window !== 'undefined' && window.state?.balances?.valr) || {};
    const fundedCurrencies = Object.keys(valrBalances).filter(currency => (valrBalances[currency] || 0) >= 10);
    
    console.log('💰 Funded currencies:', fundedCurrencies);
    console.log('🔍 Available balances:', valrBalances);
    
    // Scan paths for all funded currencies
    const fundedPaths = Object.entries(valrTriangularPaths)
        .filter(([key, config]) => {
            return config.verified && fundedCurrencies.includes(config.baseCurrency);
        });
    
    console.log(`📊 Scanning ${fundedPaths.length} VALR triangular paths across ${fundedCurrencies.length} funded currencies`);
    PlatformReporting.addActivity(`📊 Scanning ${fundedPaths.length} VALR triangular paths`, 'info');
    
    for (const [pathName, pathConfig] of fundedPaths) {
        console.log(`Checking VALR ${pathName}...`);
        const result = await calculateVALRTriangularProfit(pathConfig);
        
        if (result) {
            opportunities.push(result);
            
            if (result.profitable) {
                console.log(`✅ PROFITABLE: ${pathName} - ${result.netProfitPercent.toFixed(3)}% profit (threshold: ${valrConfig.profitThreshold}%)`);
                
                // Add to activity log
                PlatformReporting.addActivity(
                    `🔺 VALR Triangular Opportunity: ${result.pathName} - ${result.netProfitPercent.toFixed(3)}% profit (after ${valrConfig.fees.total*100}% fees)`,
                    result.netProfitPercent > 1 ? 'success' : 'warning'
                );
                
                // Execute if enabled
                const triangularArbitrageEnabled = (typeof window !== 'undefined' && window.state?.triangularArbitrage) || false;
                if (triangularArbitrageEnabled) {
                    console.log(`🚀 Auto-trading enabled - executing VALR triangular opportunity: ${pathName}`);
                    
                    const opportunityWithExecution = {
                        ...result,
                        prices: pathConfig.pairs,
                        exchange: 'VALR'
                    };
                    
                    executeVALRTriangularOpportunity(opportunityWithExecution).catch(error => {
                        console.error('❌ Failed to execute VALR triangular opportunity:', error);
                        PlatformReporting.addActivity(`❌ Failed to execute ${pathName}: ${error.message}`, 'error');
                    });
                }
            } else {
                console.log(`❌ Not profitable: ${pathName} - ${result.netProfitPercent.toFixed(3)}% (need ${valrConfig.profitThreshold}%+)`);
            }
        }
        
        // Rate limiting
        const pathDelay = fundedPaths.length > 5 ? 600 : 400;
        await PlatformReporting.delay(pathDelay);
    }
    
    // Sort by profit percentage
    opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);
    
    const profitableCount = opportunities.filter(o => o.profitable).length;
    console.log(`🔺 VALR scan complete. Found ${profitableCount} profitable opportunities`);
    
    if (profitableCount > 0) {
        PlatformReporting.addActivity(`✅ Found ${profitableCount} profitable VALR triangular opportunities!`, 'success');
    } else if (opportunities.length > 0) {
        const best = opportunities[0];
        PlatformReporting.addActivity(`📊 Best VALR triangle: ${best.pathName.split(' → ')[1]} at ${best.netProfitPercent.toFixed(2)}% (need ${valrConfig.profitThreshold}%+)`, 'info');
    }
    
    return opportunities;
}

// ============================================
// VALR TRADE EXECUTION
// ============================================

async function executeVALRTriangularOpportunity(opportunity) {
    try {
        const startTime = Date.now();
        
        // Report execution start
        PlatformReporting.addActivity(
            `🔺 EXECUTING: VALR ${opportunity.pathName} - ${opportunity.netProfitPercent.toFixed(3)}% profit`, 
            'info'
        );
        
        PlatformReporting.addLiveActivity(
            `🔺 Executing VALR triangular: ${opportunity.pathName}`,
            'execution',
            '🔺',
            '#00C851'
        );
        
        // Find the path configuration
        const pathConfig = Object.values(valrTriangularPaths).find(p => p.sequence === opportunity.pathName);
        if (!pathConfig || !pathConfig.steps) {
            throw new Error(`Path configuration not found for ${opportunity.pathName}`);
        }
        
        // Execute real VALR API trades using proven endpoint
        const executionSteps = [];
        let currentAmount = opportunity.startAmount;
        let totalFees = 0;
        
        // Execute each step using our proven VALR triangular API
        for (let i = 0; i < pathConfig.steps.length; i++) {
            const step = pathConfig.steps[i];
            const stepNum = i + 1;
            
            PlatformReporting.addActivity(`🔄 VALR Step ${stepNum}: ${step.description}`, 'info');
            
            // Determine amount and price for this step
            let tradeAmount, expectedPrice;
            if (stepNum === 1) {
                tradeAmount = currentAmount;
                expectedPrice = opportunity.prices[step.pair];
            } else if (stepNum === 2) {
                tradeAmount = currentAmount * 0.002; // Small crypto amount for middle asset
                expectedPrice = opportunity.prices[step.pair];
            } else {
                tradeAmount = currentAmount * 0.25; // USDT amount for final conversion
                expectedPrice = opportunity.prices[step.pair];
            }
            
            // Execute real trade via proven API endpoint
            try {
                const tradeResponse = await fetch('/api/v1/trading/valr/triangular', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        pair: step.pair,
                        side: step.side,
                        amount: tradeAmount,
                        expectedPrice: expectedPrice,
                        simulate: false // REAL TRADING
                    })
                });
                
                const tradeResult = await tradeResponse.json();
                
                if (!tradeResult.success) {
                    throw new Error(`Step ${stepNum} failed: ${tradeResult.error?.message || 'Unknown error'}`);
                }
                
                // Calculate step results
                const stepFee = tradeAmount * valrConfig.fees.taker;
                const outputAmount = step.side === 'buy' 
                    ? tradeAmount / expectedPrice 
                    : tradeAmount * expectedPrice;
                
                executionSteps.push({
                    step: stepNum,
                    pair: step.pair,
                    side: step.side,
                    action: step.description,
                    inputAmount: tradeAmount,
                    outputAmount: outputAmount,
                    price: expectedPrice,
                    fee: stepFee,
                    status: 'completed',
                    apiResponse: tradeResult
                });
                
                currentAmount = outputAmount;
                totalFees += stepFee;
                
                // Rate limiting between steps
                await PlatformReporting.delay(1500);
                
            } catch (stepError) {
                console.error(`❌ VALR Step ${stepNum} failed:`, stepError);
                PlatformReporting.addActivity(`❌ VALR Step ${stepNum} failed: ${stepError.message}`, 'error');
                throw stepError;
            }
        }
        
        // Calculate final results
        const finalAmount = currentAmount;
        const actualProfit = finalAmount - opportunity.startAmount;
        const actualProfitPercent = (actualProfit / opportunity.startAmount) * 100;
        const executionTimeMs = Date.now() - startTime;
        
        // Create trade record
        const tradeRecord = {
            id: `valr-tri-${Date.now()}`,
            type: 'triangular',
            subType: 'valr-triangular',
            exchange: 'VALR',
            path: opportunity.pathName,
            pairs: opportunity.pairs,
            startAmount: opportunity.startAmount,
            endAmount: finalAmount,
            startCurrency: opportunity.baseCurrency,
            profit: actualProfit,
            profitPercent: actualProfitPercent,
            fees: totalFees,
            executionTimeMs: executionTimeMs,
            timestamp: new Date().toISOString(),
            status: 'completed_real_trades', // Real API calls executed
            steps: executionSteps,
            error: null
        };
        
        // Report completion
        if (actualProfit > 0) {
            PlatformReporting.addActivity(
                `✅ VALR triangular completed: ${actualProfitPercent.toFixed(3)}% profit (${actualProfit.toFixed(2)} ${opportunity.baseCurrency})`,
                'success'
            );
        } else {
            PlatformReporting.addActivity(
                `⚠️ VALR triangular completed with loss: ${actualProfitPercent.toFixed(3)}% (${actualProfit.toFixed(2)} ${opportunity.baseCurrency})`,
                'warning'
            );
        }
        
        // Record trade and update displays
        PlatformReporting.recordTrade(tradeRecord);
        PlatformReporting.updateTradeHistory();
        PlatformReporting.updateHub();
        
        return tradeRecord;
        
    } catch (error) {
        console.error('❌ VALR triangular execution error:', error);
        PlatformReporting.addActivity(`❌ VALR triangular failed: ${error.message}`, 'error');
        throw error;
    }
}

// ============================================
// VALR MODULE PUBLIC INTERFACE
// ============================================

const VALRTriangular = {
    // Configuration access
    getPaths: () => valrTriangularPaths,
    getConfig: () => valrConfig,
    
    // Core functions
    scanOpportunities: scanVALRTriangularOpportunities,
    calculateProfit: calculateVALRTriangularProfit,
    executeOpportunity: executeVALRTriangularOpportunity,
    getPrice: getVALRPriceWithCache,
    
    // Utility functions
    validatePath: function(pathConfig) {
        return pathConfig && pathConfig.pairs && pathConfig.pairs.length === 3;
    },
    
    getStats: function() {
        return {
            totalPaths: Object.keys(valrTriangularPaths).length,
            activePaths: Object.values(valrTriangularPaths).filter(p => p.verified).length,
            lastScan: new Date().toISOString()
        };
    }
};

// ============================================
// INITIALIZATION
// ============================================

function initializeVALRTriangular() {
    console.log('🔺 Initializing VALR Triangular Module...');
    
    // Verify platform integration
    const integrationStatus = {
        addActivity: typeof window !== 'undefined' && typeof window.addActivity === 'function',
        updateTradeHistory: typeof window !== 'undefined' && typeof window.updateTradeHistoryDisplay === 'function',
        getRealPrice: typeof window !== 'undefined' && typeof window.getRealPrice === 'function',
        recordTrade: typeof window !== 'undefined' && typeof window.recordVALRTriangularTrade === 'function'
    };
    
    console.log('🔧 VALR Platform Integration Status:', integrationStatus);
    PlatformReporting.addActivity('🔺 VALR Triangular Module initialized', 'info');
    return true;
}

// Auto-initialize when script loads
if (typeof window !== 'undefined') {
    console.log('🔺 Registering VALRTriangular to window...');
    window.VALRTriangular = VALRTriangular;
    window.initializeVALRTriangular = initializeVALRTriangular;
    
    // Initialize on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeVALRTriangular);
    } else {
        initializeVALRTriangular();
    }
    
    console.log('✅ VALR Triangular module loaded successfully');
} else {
    console.warn('⚠️ Window not available, running in non-browser environment');
}