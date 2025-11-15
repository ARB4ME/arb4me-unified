/**
 * Test Scan Service (Browser-Compatible)
 * Shared service for all arbitrage strategy TEST scans
 *
 * Provides common functionality:
 * - localStorage management (save, load, clear)
 * - Data analysis (top routes, best assets, consistency)
 * - Configuration persistence
 * - Storage quota tracking
 *
 * Used by: Triangular, Cross-Exchange, Futures, Funding Rate Arb
 * NOT used by: Transfer Arb (standalone implementation)
 */

class TestScanService {
    /**
     * @param {Object} config - Strategy configuration
     * @param {string} config.strategyName - Name of strategy (e.g., 'triangular', 'cross-exchange')
     * @param {number} config.maxResults - Maximum opportunities to store (default: 5000)
     * @param {Function} config.createRouteKey - Function to create unique route identifier
     * @param {Object} config.dataModel - Strategy-specific data model fields
     */
    constructor(config) {
        this.strategyName = config.strategyName;
        this.maxResults = config.maxResults || 5000;
        this.createRouteKey = config.createRouteKey;
        this.dataModel = config.dataModel || {};

        // localStorage keys (strategy-specific)
        this.dataKey = `testScan_${this.strategyName}_data`;
        this.configKey = `testScan_${this.strategyName}_config`;

        console.log(`[TestScanService] Initialized for ${this.strategyName}`);
    }

    /**
     * Store opportunities in localStorage
     */
    storeOpportunities(opportunities) {
        try {
            let data = this.getData();

            opportunities.forEach(opp => {
                // Create unique route key using strategy-specific function
                const routeKey = this.createRouteKey(opp);

                // Add metadata
                opp.timestamp = Date.now();
                opp.routeKey = routeKey;
                opp.hour = new Date().getHours();

                data.push(opp);
            });

            // Keep last N opportunities (localStorage quota limit)
            if (data.length > this.maxResults) {
                data = data.slice(-this.maxResults);
            }

            localStorage.setItem(this.dataKey, JSON.stringify(data));

            return {
                success: true,
                totalStored: data.length,
                newOpportunities: opportunities.length
            };
        } catch (error) {
            console.error(`[TestScanService] Failed to store opportunities for ${this.strategyName}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get all stored opportunities
     */
    getData() {
        try {
            const data = localStorage.getItem(this.dataKey);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error(`[TestScanService] Failed to load data for ${this.strategyName}:`, error);
            return [];
        }
    }

    /**
     * Clear all stored data
     */
    clearData() {
        try {
            localStorage.removeItem(this.dataKey);
            console.log(`[TestScanService] Cleared test scan data for ${this.strategyName}`);
            return { success: true };
        } catch (error) {
            console.error(`[TestScanService] Failed to clear data for ${this.strategyName}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Save configuration (selected assets, settings, etc.)
     */
    saveConfig(config) {
        try {
            const currentConfig = this.getConfig();
            const updatedConfig = { ...currentConfig, ...config };
            localStorage.setItem(this.configKey, JSON.stringify(updatedConfig));
            return { success: true };
        } catch (error) {
            console.error(`[TestScanService] Failed to save config for ${this.strategyName}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get saved configuration
     */
    getConfig() {
        try {
            const config = localStorage.getItem(this.configKey);
            return config ? JSON.parse(config) : {};
        } catch (error) {
            console.error(`[TestScanService] Failed to load config for ${this.strategyName}:`, error);
            return {};
        }
    }

    /**
     * Get storage statistics
     */
    getStorageStats() {
        try {
            const data = this.getData();
            const dataSize = new Blob([JSON.stringify(data)]).size;
            const totalSize = new Blob([localStorage.getItem(this.dataKey) || '']).size;

            // Estimate localStorage quota (typically 5-10MB)
            const ESTIMATED_QUOTA = 10 * 1024 * 1024; // 10MB
            const usedPercent = (totalSize / ESTIMATED_QUOTA) * 100;

            return {
                routeCount: data.length,
                maxRoutes: this.maxResults,
                storageUsed: totalSize,
                storagePercent: Math.min(usedPercent, 100),
                isFull: data.length >= this.maxResults
            };
        } catch (error) {
            console.error(`[TestScanService] Failed to get storage stats for ${this.strategyName}:`, error);
            return {
                routeCount: 0,
                maxRoutes: this.maxResults,
                storageUsed: 0,
                storagePercent: 0,
                isFull: false
            };
        }
    }

    /**
     * Check if storage is full
     */
    isStorageFull() {
        const stats = this.getStorageStats();
        return stats.isFull;
    }

    /**
     * Analyze data and compute top routes, best assets, etc.
     */
    analyzeData(limit = 20) {
        const data = this.getData();

        if (data.length === 0) {
            return this.getEmptyAnalysis();
        }

        return {
            topProfit: this.getTopByProfit(data, limit),
            topConsistency: this.getTopByConsistency(data, limit),
            bestAssets: this.getBestAssets(data, limit),
            bestExchanges: this.getBestExchanges(data, limit),
            timeAnalysis: this.getTimeAnalysis(data),
            summary: {
                totalOpportunities: data.length,
                uniqueRoutes: new Set(data.map(d => d.routeKey)).size,
                avgProfit: data.reduce((sum, d) => sum + (d.netProfitPercent || 0), 0) / data.length,
                bestProfit: Math.max(...data.map(d => d.netProfitPercent || 0)),
                timeRange: {
                    start: Math.min(...data.map(d => d.timestamp)),
                    end: Math.max(...data.map(d => d.timestamp))
                }
            }
        };
    }

    /**
     * Get top routes by average profit
     */
    getTopByProfit(data, limit = 20) {
        const routeStats = this.aggregateByRoute(data);
        const routes = Object.keys(routeStats).map(routeKey => {
            const stats = routeStats[routeKey];
            const profits = stats.profits;
            const avgProfit = profits.reduce((a, b) => a + b, 0) / profits.length;
            const maxProfit = Math.max(...profits);
            const minProfit = Math.min(...profits);

            return {
                routeKey,
                avgProfit,
                maxProfit,
                minProfit,
                count: stats.count,
                examples: stats.examples,
                consistency: this.calculateConsistency(profits)
            };
        });

        return routes
            .sort((a, b) => b.avgProfit - a.avgProfit)
            .slice(0, limit);
    }

    /**
     * Get top routes by consistency (most frequently found)
     */
    getTopByConsistency(data, limit = 20) {
        const routeStats = this.aggregateByRoute(data);
        const routes = Object.keys(routeStats).map(routeKey => {
            const stats = routeStats[routeKey];
            const profits = stats.profits;
            const avgProfit = profits.reduce((a, b) => a + b, 0) / profits.length;
            const maxProfit = Math.max(...profits);
            const minProfit = Math.min(...profits);

            return {
                routeKey,
                count: stats.count,
                avgProfit,
                maxProfit,
                minProfit,
                examples: stats.examples,
                consistency: this.calculateConsistency(profits)
            };
        });

        return routes
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    /**
     * Get best assets (most profitable)
     */
    getBestAssets(data, limit = 20) {
        const assetField = this.dataModel.assetField || 'crypto';
        const assetStats = {};

        data.forEach(opp => {
            const asset = opp[assetField];
            if (!asset) return;

            if (!assetStats[asset]) {
                assetStats[asset] = { profits: [], count: 0 };
            }
            assetStats[asset].profits.push(opp.netProfitPercent || 0);
            assetStats[asset].count++;
        });

        const assets = Object.keys(assetStats).map(asset => ({
            asset,
            count: assetStats[asset].count,
            avgProfit: assetStats[asset].profits.reduce((a, b) => a + b, 0) / assetStats[asset].profits.length
        }));

        return assets
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    /**
     * Get best exchange pairs (most profitable)
     */
    getBestExchanges(data, limit = 20) {
        const exchangeStats = {};

        data.forEach(opp => {
            const pair = this.dataModel.createExchangePairKey
                ? this.dataModel.createExchangePairKey(opp)
                : `${opp.fromExchange || opp.exchange}`;

            if (!exchangeStats[pair]) {
                exchangeStats[pair] = { profits: [], count: 0 };
            }
            exchangeStats[pair].profits.push(opp.netProfitPercent || 0);
            exchangeStats[pair].count++;
        });

        const exchanges = Object.keys(exchangeStats).map(pair => ({
            pair,
            count: exchangeStats[pair].count,
            avgProfit: exchangeStats[pair].profits.reduce((a, b) => a + b, 0) / exchangeStats[pair].profits.length
        }));

        return exchanges
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    /**
     * Get time analysis (best hours to trade)
     */
    getTimeAnalysis(data) {
        const hourStats = {};
        for (let i = 0; i < 24; i++) {
            hourStats[i] = { count: 0, profits: [], routes: {} };
        }

        data.forEach(opp => {
            const hour = opp.hour;
            if (hour === undefined) return;

            hourStats[hour].count++;
            hourStats[hour].profits.push(opp.netProfitPercent || 0);

            const routeKey = opp.routeKey;
            hourStats[hour].routes[routeKey] = (hourStats[hour].routes[routeKey] || 0) + 1;
        });

        return hourStats;
    }

    /**
     * Aggregate data by route key
     */
    aggregateByRoute(data) {
        const routeStats = {};

        data.forEach(opp => {
            const routeKey = opp.routeKey;
            if (!routeKey) return;

            if (!routeStats[routeKey]) {
                routeStats[routeKey] = {
                    profits: [],
                    count: 0,
                    examples: []
                };
            }

            routeStats[routeKey].profits.push(opp.netProfitPercent || 0);
            routeStats[routeKey].count++;

            // Keep first example for reference
            if (routeStats[routeKey].examples.length === 0) {
                routeStats[routeKey].examples.push(opp);
            }
        });

        return routeStats;
    }

    /**
     * Calculate consistency score (0-100%)
     * Lower variance = higher consistency
     */
    calculateConsistency(profits) {
        if (profits.length < 2) return 100;

        const avg = profits.reduce((a, b) => a + b, 0) / profits.length;
        const max = Math.max(...profits);
        const min = Math.min(...profits);

        if (avg === 0) return 0;

        // Consistency = how close min/max are to average
        const variance = (max - min) / avg;
        const consistency = Math.max(0, (1 - variance) * 100);

        return consistency;
    }

    /**
     * Get empty analysis structure
     */
    getEmptyAnalysis() {
        return {
            topProfit: [],
            topConsistency: [],
            bestAssets: [],
            bestExchanges: [],
            timeAnalysis: {},
            summary: {
                totalOpportunities: 0,
                uniqueRoutes: 0,
                avgProfit: 0,
                bestProfit: 0,
                timeRange: { start: 0, end: 0 }
            }
        };
    }

    /**
     * Export data to JSON
     */
    exportData() {
        const data = this.getData();
        const analysis = this.analyzeData();

        return {
            strategy: this.strategyName,
            exportedAt: new Date().toISOString(),
            summary: analysis.summary,
            opportunities: data,
            analysis: {
                topProfit: analysis.topProfit,
                topConsistency: analysis.topConsistency,
                bestAssets: analysis.bestAssets,
                bestExchanges: analysis.bestExchanges
            }
        };
    }

    /**
     * Import data from JSON
     */
    importData(importedData) {
        try {
            if (importedData.strategy !== this.strategyName) {
                throw new Error(`Strategy mismatch: expected ${this.strategyName}, got ${importedData.strategy}`);
            }

            localStorage.setItem(this.dataKey, JSON.stringify(importedData.opportunities));
            console.log(`[TestScanService] Imported ${importedData.opportunities.length} opportunities for ${this.strategyName}`);

            return {
                success: true,
                importedCount: importedData.opportunities.length
            };
        } catch (error) {
            console.error(`[TestScanService] Failed to import data for ${this.strategyName}:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}
