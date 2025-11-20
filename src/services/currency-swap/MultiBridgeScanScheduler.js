/**
 * Multi-Bridge Scan Scheduler for Currency Swap
 *
 * Cycles through multiple bridge assets (XRP, XLM, TRX, LTC) with 60-second intervals
 * to find the most profitable arbitrage opportunities across all bridges.
 *
 * Scan Cycle:
 * [00:00] XRP bridge scan
 * [01:00] XLM bridge scan (60 sec after XRP)
 * [02:00] TRX bridge scan (60 sec after XLM)
 * [03:00] LTC bridge scan (60 sec after TRX)
 * [04:00] Cycle repeats (back to XRP)
 */

const CurrencySwapScannerService = require('./CurrencySwapScannerService');
const { logger } = require('../../utils/logger');

class MultiBridgeScanScheduler {
    constructor() {
        this.bridgeAssets = ['XRP', 'XLM', 'TRX', 'LTC'];
        this.currentBridgeIndex = 0;
        this.scanResults = {}; // Store results for each bridge
        this.isRunning = false;
        this.scanInterval = 60000; // 60 seconds between scans
        this.userId = null;
        this.timeoutId = null;
        this.cycleNumber = 0;
    }

    /**
     * Start the multi-bridge scan cycle
     * @param {number} userId - User ID
     */
    start(userId) {
        if (this.isRunning) {
            logger.warn('[MULTI-BRIDGE] Scanner already running');
            return {
                success: false,
                message: 'Scanner already running'
            };
        }

        this.userId = userId;
        this.isRunning = true;
        this.cycleNumber = 0;
        logger.info('[MULTI-BRIDGE] Starting multi-bridge scan cycle', {
            bridges: this.bridgeAssets,
            interval: `${this.scanInterval / 1000}s`
        });

        // Start first scan immediately
        this.runNextScan();

        return {
            success: true,
            message: 'Multi-bridge scan started',
            bridges: this.bridgeAssets,
            scanInterval: this.scanInterval
        };
    }

    /**
     * Stop the scan cycle
     */
    stop() {
        if (!this.isRunning) {
            return {
                success: false,
                message: 'Scanner not running'
            };
        }

        this.isRunning = false;
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        logger.info('[MULTI-BRIDGE] Scan cycle stopped', {
            cyclesCompleted: this.cycleNumber,
            totalScans: Object.keys(this.scanResults).length
        });

        return {
            success: true,
            message: 'Multi-bridge scan stopped',
            cyclesCompleted: this.cycleNumber
        };
    }

    /**
     * Run scan for next bridge in rotation
     * @private
     */
    async runNextScan() {
        if (!this.isRunning) return;

        const currentBridge = this.bridgeAssets[this.currentBridgeIndex];
        const scanNumber = this.currentBridgeIndex + 1;
        const totalBridges = this.bridgeAssets.length;

        logger.info(`[MULTI-BRIDGE] Starting scan ${scanNumber}/${totalBridges}`, {
            bridge: currentBridge,
            cycle: this.cycleNumber + 1
        });

        try {
            const scanStartTime = Date.now();

            // Run scan with current bridge
            const result = await CurrencySwapScannerService.scanOpportunities(
                this.userId,
                { bridgeAsset: currentBridge }
            );

            const scanDuration = Date.now() - scanStartTime;

            // Store result
            this.scanResults[currentBridge] = {
                ...result,
                scannedAt: new Date().toISOString(),
                bridge: currentBridge,
                scanDuration: `${(scanDuration / 1000).toFixed(1)}s`
            };

            const profitDisplay = result.opportunity?.profitPercent
                ? `${result.opportunity.profitPercent > 0 ? '+' : ''}${result.opportunity.profitPercent.toFixed(2)}%`
                : 'N/A';

            logger.info(`[MULTI-BRIDGE] ${currentBridge} scan complete in ${(scanDuration / 1000).toFixed(1)}s`, {
                bestProfit: profitDisplay,
                pathsScanned: result.scannedPaths,
                isProfitable: result.isProfitable,
                meetsThreshold: result.meetsThreshold
            });

        } catch (error) {
            logger.error(`[MULTI-BRIDGE] ${currentBridge} scan failed`, {
                error: error.message,
                stack: error.stack
            });

            this.scanResults[currentBridge] = {
                success: false,
                error: error.message,
                scannedAt: new Date().toISOString(),
                bridge: currentBridge
            };
        }

        // Move to next bridge (circular)
        this.currentBridgeIndex = (this.currentBridgeIndex + 1) % this.bridgeAssets.length;

        // Log cycle completion
        if (this.currentBridgeIndex === 0) {
            this.cycleNumber++;
            logger.info('[MULTI-BRIDGE] ═══════════════════════════════════════════════════════');
            logger.info(`[MULTI-BRIDGE] CYCLE #${this.cycleNumber} COMPLETE - All bridges scanned`);
            this.logBridgeComparison();
            logger.info('[MULTI-BRIDGE] ═══════════════════════════════════════════════════════');
        }

        // Schedule next scan (60 seconds)
        if (this.isRunning) {
            this.timeoutId = setTimeout(() => {
                this.runNextScan();
            }, this.scanInterval);
        }
    }

    /**
     * Get best opportunity across all bridges
     * @returns {object} Best opportunity details
     */
    getBestOpportunity() {
        let bestResult = null;
        let bestBridge = null;
        let bestProfit = -Infinity;

        for (const [bridge, result] of Object.entries(this.scanResults)) {
            if (result.success && result.opportunity) {
                if (result.opportunity.profitPercent > bestProfit) {
                    bestProfit = result.opportunity.profitPercent;
                    bestBridge = bridge;
                    bestResult = result;
                }
            }
        }

        return {
            bridge: bestBridge,
            opportunity: bestResult?.opportunity || null,
            allResults: this.scanResults,
            cycleNumber: this.cycleNumber
        };
    }

    /**
     * Log comparison of all bridges
     * @private
     */
    logBridgeComparison() {
        const comparison = [];

        for (const bridge of this.bridgeAssets) {
            const result = this.scanResults[bridge];

            if (!result) {
                comparison.push({
                    bridge,
                    status: 'Not scanned yet',
                    profit: 'N/A',
                    bestPath: 'N/A',
                    lastScan: 'Never'
                });
                continue;
            }

            const profit = result.opportunity?.profitPercent || 0;
            const path = result.opportunity
                ? `${result.opportunity.sourceExchange}→${result.opportunity.destExchange}`
                : 'None';

            const secondsAgo = result.scannedAt
                ? Math.floor((Date.now() - new Date(result.scannedAt).getTime()) / 1000)
                : 'N/A';

            comparison.push({
                bridge,
                bestPath: path,
                profit: profit > 0 ? `+${profit.toFixed(2)}%` : `${profit.toFixed(2)}%`,
                pathsScanned: result.scannedPaths || 0,
                lastScan: `${secondsAgo}s ago`,
                duration: result.scanDuration || 'N/A'
            });
        }

        // Sort by profit (highest first)
        comparison.sort((a, b) => {
            const profitA = parseFloat(a.profit) || -Infinity;
            const profitB = parseFloat(b.profit) || -Infinity;
            return profitB - profitA;
        });

        console.table(comparison);

        // Log best opportunity
        const best = this.getBestOpportunity();
        if (best.opportunity) {
            logger.info(`[MULTI-BRIDGE] 🏆 BEST: ${best.opportunity.profitPercent.toFixed(2)}% via ${best.bridge} bridge`, {
                path: best.opportunity.id,
                profitAmount: best.opportunity.profitAmount,
                inputAmount: best.opportunity.inputAmount,
                outputAmount: best.opportunity.outputAmount
            });
        } else {
            logger.warn('[MULTI-BRIDGE] No profitable opportunities found across any bridge');
        }
    }

    /**
     * Get current scan status
     * @returns {object} Status information
     */
    getStatus() {
        const nextBridge = this.bridgeAssets[this.currentBridgeIndex];
        const best = this.getBestOpportunity();

        // Calculate seconds until next scan
        let secondsUntilNext = 0;
        if (this.isRunning && Object.keys(this.scanResults).length > 0) {
            const lastScanTime = Math.max(
                ...Object.values(this.scanResults)
                    .filter(r => r.scannedAt)
                    .map(r => new Date(r.scannedAt).getTime())
            );
            const elapsed = Math.floor((Date.now() - lastScanTime) / 1000);
            secondsUntilNext = Math.max(0, 60 - elapsed);
        }

        return {
            isRunning: this.isRunning,
            currentCycle: this.cycleNumber + 1,
            totalScans: Object.keys(this.scanResults).length,
            nextScan: {
                bridge: nextBridge,
                in: secondsUntilNext > 0 ? `${secondsUntilNext}s` : 'Scanning now...'
            },
            bestOpportunity: best,
            bridgeResults: this.scanResults,
            bridges: this.bridgeAssets,
            scanInterval: this.scanInterval
        };
    }
}

// Singleton instance
let schedulerInstance = null;

module.exports = {
    MultiBridgeScanScheduler,

    /**
     * Get or create singleton instance
     * @returns {MultiBridgeScanScheduler}
     */
    getScheduler: () => {
        if (!schedulerInstance) {
            schedulerInstance = new MultiBridgeScanScheduler();
        }
        return schedulerInstance;
    },

    /**
     * Reset singleton (useful for testing)
     */
    resetScheduler: () => {
        if (schedulerInstance && schedulerInstance.isRunning) {
            schedulerInstance.stop();
        }
        schedulerInstance = null;
    }
};
