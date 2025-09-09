// ============================================
// TRIANGULAR ARBITRAGE MANAGER
// ============================================
// Central coordinator for all exchange triangular arbitrage modules
// Routes requests to appropriate exchange-specific modules
//
// This module handles:
// - Exchange routing for triangular arbitrage requests  
// - Unified scanning across all exchanges
// - Performance monitoring and statistics
// - Shared reporting integration
//
// Created: Phase 9 of methodical extraction process
// Status: Complete coordinator with Luno integration

// ============================================
// EXCHANGE MODULE REGISTRY
// ============================================
// Registry of available triangular arbitrage modules

const TriangularExchanges = {
    LUNO: {
        name: 'LUNO',
        module: null, // Will be set when LunoTriangularV2 is loaded
        available: false,
        active: true
    },
    VALR: {
        name: 'VALR',
        module: null, // TODO: Set when VALR module is created
        available: false,
        active: false
    },
    CHAINEX: {
        name: 'ChainEX',
        module: null, // TODO: Set when ChainEX module is created
        available: false,
        active: false
    }
};

// ============================================
// INITIALIZATION & MODULE REGISTRATION
// ============================================

function initializeTriangularManager() {
    console.log('🔺 Initializing Triangular Arbitrage Manager...');
    
    // Check for available modules
    if (typeof window !== 'undefined') {
        // Register Luno module if available
        if (window.LunoTriangularV2) {
            TriangularExchanges.LUNO.module = window.LunoTriangularV2;
            TriangularExchanges.LUNO.available = true;
            console.log('✅ Luno triangular module registered');
        }
        
        // TODO: Register VALR module when available
        // if (window.ValrTriangularV2) {
        //     TriangularExchanges.VALR.module = window.ValrTriangularV2;
        //     TriangularExchanges.VALR.available = true;
        //     console.log('✅ VALR triangular module registered');
        // }
        
        // TODO: Register ChainEX module when available
        // if (window.ChainexTriangularV2) {
        //     TriangularExchanges.CHAINEX.module = window.ChainexTriangularV2;
        //     TriangularExchanges.CHAINEX.available = true;
        //     console.log('✅ ChainEX triangular module registered');
        // }
    }
    
    const availableCount = Object.values(TriangularExchanges).filter(ex => ex.available).length;
    console.log(`🔺 Triangular Manager initialized with ${availableCount} exchange modules`);
    
    return true;
}

// ============================================
// EXCHANGE ROUTING FUNCTIONS
// ============================================

// Route triangular scanning to specific exchange
async function scanTriangularByExchange(exchange, showActivity = false) {
    const exchangeKey = exchange.toUpperCase();
    const exchangeModule = TriangularExchanges[exchangeKey];
    
    if (!exchangeModule) {
        throw new Error(`Unknown exchange for triangular arbitrage: ${exchange}`);
    }
    
    if (!exchangeModule.available) {
        throw new Error(`${exchange} triangular module not available`);
    }
    
    if (!exchangeModule.active) {
        console.log(`⏸️ ${exchange} triangular module is disabled`);
        return [];
    }
    
    // Route to exchange-specific scanning function
    return await exchangeModule.module.scanOpportunities(showActivity);
}

// Route triangular profit calculation to specific exchange
async function calculateTriangularProfitByExchange(exchange, pathConfig, amount = 100) {
    const exchangeKey = exchange.toUpperCase();
    const exchangeModule = TriangularExchanges[exchangeKey];
    
    if (!exchangeModule || !exchangeModule.available) {
        throw new Error(`${exchange} triangular module not available`);
    }
    
    return await exchangeModule.module.calculateProfit(pathConfig, amount);
}

// Route triangular execution to specific exchange
async function executeTriangularByExchange(exchange, opportunity) {
    const exchangeKey = exchange.toUpperCase();
    const exchangeModule = TriangularExchanges[exchangeKey];
    
    if (!exchangeModule || !exchangeModule.available) {
        throw new Error(`${exchange} triangular module not available`);
    }
    
    return await exchangeModule.module.executeOpportunity(opportunity);
}

// ============================================
// UNIFIED SCANNING FUNCTIONS
// ============================================

// Scan all active exchanges for triangular opportunities
async function scanAllTriangularOpportunities(showActivity = false) {
    console.log('🔺 Starting unified triangular arbitrage scan across all exchanges...');
    
    const activeExchanges = Object.entries(TriangularExchanges)
        .filter(([key, exchange]) => exchange.available && exchange.active);
    
    if (activeExchanges.length === 0) {
        console.log('⚠️ No triangular exchange modules available');
        return [];
    }
    
    const allOpportunities = [];
    const scanPromises = [];
    
    // Scan all exchanges in parallel for better performance
    for (const [exchangeKey, exchangeConfig] of activeExchanges) {
        console.log(`🔍 Scanning ${exchangeConfig.name} triangular opportunities...`);
        const scanPromise = scanTriangularByExchange(exchangeConfig.name, showActivity)
            .then(opportunities => {
                console.log(`✅ ${exchangeConfig.name} scan complete: ${opportunities.length} opportunities`);
                return opportunities;
            })
            .catch(error => {
                console.error(`❌ ${exchangeConfig.name} scan failed:`, error);
                return [];
            });
        
        scanPromises.push(scanPromise);
    }
    
    // Wait for all scans to complete
    const results = await Promise.all(scanPromises);
    
    // Flatten and combine all opportunities
    for (const exchangeOpportunities of results) {
        allOpportunities.push(...exchangeOpportunities);
    }
    
    // Sort by profit percentage (highest first)
    allOpportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);
    
    const profitableCount = allOpportunities.filter(o => o.profitable).length;
    console.log(`🔺 Unified scan complete. Found ${profitableCount} profitable opportunities across ${activeExchanges.length} exchanges`);
    
    return allOpportunities;
}

// ============================================
// STATISTICS & MONITORING
// ============================================

// Get statistics for all triangular modules
function getTriangularStats() {
    const stats = {
        totalExchanges: Object.keys(TriangularExchanges).length,
        availableExchanges: Object.values(TriangularExchanges).filter(ex => ex.available).length,
        activeExchanges: Object.values(TriangularExchanges).filter(ex => ex.available && ex.active).length,
        exchanges: {},
        lastUpdate: new Date().toISOString()
    };
    
    // Get stats from each available exchange
    for (const [key, exchange] of Object.entries(TriangularExchanges)) {
        if (exchange.available && exchange.module.getStats) {
            stats.exchanges[key] = exchange.module.getStats();
        } else {
            stats.exchanges[key] = {
                available: exchange.available,
                active: exchange.active,
                status: exchange.available ? 'loaded' : 'not_loaded'
            };
        }
    }
    
    return stats;
}

// ============================================
// CONFIGURATION MANAGEMENT
// ============================================

// Enable/disable specific exchange
function setExchangeActive(exchange, active) {
    const exchangeKey = exchange.toUpperCase();
    if (TriangularExchanges[exchangeKey]) {
        TriangularExchanges[exchangeKey].active = active;
        console.log(`${active ? '✅ Enabled' : '⏸️ Disabled'} ${exchange} triangular arbitrage`);
        return true;
    }
    return false;
}

// Get list of available exchanges
function getAvailableExchanges() {
    return Object.entries(TriangularExchanges)
        .filter(([key, exchange]) => exchange.available)
        .map(([key, exchange]) => ({
            key: key,
            name: exchange.name,
            active: exchange.active
        }));
}

// ============================================
// PUBLIC INTERFACE
// ============================================

const TriangularManager = {
    // Core functions
    scanAll: scanAllTriangularOpportunities,
    scanByExchange: scanTriangularByExchange,
    calculateProfit: calculateTriangularProfitByExchange,
    execute: executeTriangularByExchange,
    
    // Configuration
    setExchangeActive: setExchangeActive,
    getAvailableExchanges: getAvailableExchanges,
    
    // Statistics
    getStats: getTriangularStats,
    
    // Utility
    init: initializeTriangularManager
};

// ============================================
// AUTO-INITIALIZATION
// ============================================

// Auto-initialize when script loads
if (typeof window !== 'undefined') {
    console.log('🔺 Registering TriangularManager to window...');
    window.TriangularManager = TriangularManager;
    window.initializeTriangularManager = initializeTriangularManager;
    
    // Initialize on load (after other modules are loaded)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initializeTriangularManager, 100); // Small delay to ensure other modules load first
        });
    } else {
        setTimeout(initializeTriangularManager, 100);
    }
    
    console.log('✅ TriangularManager module loaded successfully');
} else {
    console.warn('⚠️ Window not available, running in non-browser environment');
}