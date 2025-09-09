// ============================================
// EXCHANGE PAIRS DATA - ALL EXCHANGES
// ============================================
// Central data file for all exchange trading pairs
// Used by triangular arbitrage modules for validation and reference
//
// This file contains:
// - Trading pairs for each exchange
// - Pair metadata (active status, limits, etc.)
// - Lookup and validation functions
// - Last updated timestamps
//
// Created: Phase 1 of methodical extraction process
// Status: Template with Luno data section ready

// ============================================
// LUNO TRADING PAIRS DATA
// ============================================
const lunoPairsData = {
    lastUpdated: null, // TODO: Add timestamp when we fetch data
    totalPairs: 0,     // TODO: Count when we add pairs
    activePairs: 0,    // TODO: Count active pairs
    pairs: {
        // TODO: Add Luno pairs data here
        // Format: 'PAIRNAME': { active: true/false, minAmount: x, maxAmount: y, etc. }
    }
};

// ============================================
// VALR TRADING PAIRS DATA
// ============================================
const valrPairsData = {
    lastUpdated: null, // TODO: Add when ready for VALR
    totalPairs: 0,     
    activePairs: 0,    
    pairs: {
        // TODO: Add VALR pairs data later
    }
};

// ============================================
// CHAINEX TRADING PAIRS DATA
// ============================================
const chainexPairsData = {
    lastUpdated: null, // TODO: Add when ready for ChainEX
    totalPairs: 0,     
    activePairs: 0,    
    pairs: {
        // TODO: Add ChainEX pairs data later
    }
};

// ============================================
// LOOKUP FUNCTIONS
// ============================================

// Get Luno pairs
function getLunoPairs() {
    return lunoPairsData.pairs;
}

// Get VALR pairs
function getValrPairs() {
    return valrPairsData.pairs;
}

// Get ChainEX pairs
function getChainexPairs() {
    return chainexPairsData.pairs;
}

// Check if pair exists on exchange
function isPairAvailable(exchange, pairName) {
    switch(exchange.toLowerCase()) {
        case 'luno':
            return lunoPairsData.pairs.hasOwnProperty(pairName);
        case 'valr':
            return valrPairsData.pairs.hasOwnProperty(pairName);
        case 'chainex':
            return chainexPairsData.pairs.hasOwnProperty(pairName);
        default:
            return false;
    }
}

// Get pair info
function getPairInfo(exchange, pairName) {
    switch(exchange.toLowerCase()) {
        case 'luno':
            return lunoPairsData.pairs[pairName] || null;
        case 'valr':
            return valrPairsData.pairs[pairName] || null;
        case 'chainex':
            return chainexPairsData.pairs[pairName] || null;
        default:
            return null;
    }
}

// Get all active pairs for exchange
function getActivePairs(exchange) {
    const allPairs = getPairsForExchange(exchange);
    return Object.keys(allPairs).filter(pairName => allPairs[pairName].active === true);
}

// Get pairs for exchange
function getPairsForExchange(exchange) {
    switch(exchange.toLowerCase()) {
        case 'luno':
            return getLunoPairs();
        case 'valr':
            return getValrPairs();
        case 'chainex':
            return getChainexPairs();
        default:
            return {};
    }
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

// Validate triangular path pairs exist
function validateTriangularPath(exchange, pathPairs) {
    return pathPairs.every(pair => isPairAvailable(exchange, pair));
}

// Get pair statistics
function getExchangeStats(exchange) {
    switch(exchange.toLowerCase()) {
        case 'luno':
            return {
                total: lunoPairsData.totalPairs,
                active: lunoPairsData.activePairs,
                lastUpdated: lunoPairsData.lastUpdated
            };
        case 'valr':
            return {
                total: valrPairsData.totalPairs,
                active: valrPairsData.activePairs,
                lastUpdated: valrPairsData.lastUpdated
            };
        case 'chainex':
            return {
                total: chainexPairsData.totalPairs,
                active: chainexPairsData.activePairs,
                lastUpdated: chainexPairsData.lastUpdated
            };
        default:
            return null;
    }
}

// ============================================
// MODULE EXPORTS (if using modules)
// ============================================
// TODO: Add exports when we convert to proper modules

// For now, functions are globally available
// Later we can convert to: export { getLunoPairs, getValrPairs, etc. }