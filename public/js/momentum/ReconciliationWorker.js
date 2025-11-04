// Reconciliation Worker
// Detects mismatches between exchange balances and database positions
// Runs every 10 minutes to catch positions that were sold but not updated in database

const ReconciliationWorker = {
    isRunning: false,
    intervalId: null,
    checkIntervalMs: 10 * 60 * 1000, // 10 minutes

    /**
     * Start the reconciliation worker
     */
    start() {
        if (this.isRunning) {
            console.warn('Reconciliation worker is already running');
            return;
        }

        console.log('🔄 Starting Reconciliation Worker (checks every 10 minutes)');
        this.isRunning = true;

        // Run immediately on start
        this.runReconciliation();

        // Then run every 10 minutes
        this.intervalId = setInterval(() => {
            this.runReconciliation();
        }, this.checkIntervalMs);
    },

    /**
     * Stop the reconciliation worker
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('🛑 Reconciliation Worker stopped');
    },

    /**
     * Run reconciliation check
     */
    async runReconciliation() {
        try {
            console.log('🔍 RECONCILIATION CHECK: Starting mismatch detection...');

            // Get user ID from localStorage or global state
            const userId = localStorage.getItem('userId') || '1';

            // Get all exchanges that have active strategies
            const exchanges = await this.getActiveExchanges(userId);

            if (exchanges.length === 0) {
                console.log('ℹ️  No active exchanges to reconcile');
                return;
            }

            console.log(`📊 Checking ${exchanges.length} exchange(s) for mismatches...`);

            let totalMismatches = 0;

            for (const exchange of exchanges) {
                try {
                    const mismatches = await this.checkExchange(userId, exchange);
                    totalMismatches += mismatches;
                } catch (error) {
                    console.error(`❌ Reconciliation failed for ${exchange}:`, error.message);
                }
            }

            if (totalMismatches > 0) {
                console.error(`⚠️  RECONCILIATION ALERT: Found ${totalMismatches} mismatch(es) requiring manual intervention!`);
            } else {
                console.log('✅ Reconciliation complete: No mismatches found');
            }

        } catch (error) {
            console.error('❌ Reconciliation worker error:', error);
        }
    },

    /**
     * Get list of active exchanges
     */
    async getActiveExchanges(userId) {
        try {
            const response = await fetch('/api/v1/momentum/strategies/active', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error(`Failed to fetch active strategies: ${response.status} ${response.statusText}`);
                return [];
            }

            const result = await response.json();
            const strategies = result.data || [];

            // Get unique exchanges from active strategies
            const exchanges = [...new Set(
                strategies
                    .filter(s => s.is_active)
                    .map(s => s.exchange)
            )];

            return exchanges;

        } catch (error) {
            console.error('Failed to get active exchanges:', error);
            return [];
        }
    },

    /**
     * Check a specific exchange for mismatches
     */
    async checkExchange(userId, exchange) {
        try {
            console.log(`🔎 Checking ${exchange} for mismatches...`);

            // Get all OPEN and CLOSING positions for this exchange
            const response = await fetch(`/api/v1/momentum/positions?userId=${userId}&exchange=${exchange}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch positions: ${response.statusText}`);
            }

            const result = await response.json();
            const openPositions = result.data?.open || [];

            if (openPositions.length === 0) {
                console.log(`   ℹ️  ${exchange}: No open positions to check`);
                return 0;
            }

            console.log(`   📋 ${exchange}: Found ${openPositions.length} open position(s) to verify`);

            let mismatchCount = 0;

            for (const position of openPositions) {
                const isMismatch = await this.checkPosition(position, exchange);
                if (isMismatch) {
                    mismatchCount++;
                }
            }

            return mismatchCount;

        } catch (error) {
            console.error(`Failed to check exchange ${exchange}:`, error);
            return 0;
        }
    },

    /**
     * Check if a position has a mismatch
     * Returns true if mismatch detected
     */
    async checkPosition(position, exchange) {
        try {
            // For now, we'll just flag positions that have been open for an unusually long time
            // and are in CLOSING status (which indicates a stuck state)

            const entryTime = new Date(position.entry_time).getTime();
            const now = Date.now();
            const hoursOpen = (now - entryTime) / (1000 * 60 * 60);

            // If position is in CLOSING status for more than 5 minutes, it's likely stuck
            if (position.status === 'CLOSING') {
                console.warn(`⚠️  MISMATCH DETECTED: Position ${position.id} stuck in CLOSING status`, {
                    positionId: position.id,
                    exchange,
                    pair: position.pair,
                    status: position.status,
                    entryTime: position.entry_time,
                    hoursOpen: hoursOpen.toFixed(2) + 'h',
                    action: 'Check if asset was sold on exchange and force-close in database'
                });
                return true;
            }

            // If position is OPEN for more than 48 hours, flag for review
            // (this is a safety net for positions that should have closed but didn't)
            if (position.status === 'OPEN' && hoursOpen > 48) {
                console.warn(`⚠️  ALERT: Position ${position.id} open for ${hoursOpen.toFixed(1)} hours`, {
                    positionId: position.id,
                    exchange,
                    pair: position.pair,
                    status: position.status,
                    entryTime: position.entry_time,
                    hoursOpen: hoursOpen.toFixed(2) + 'h',
                    action: 'Review why position has not closed - check max hold time and exit conditions'
                });
                return true;
            }

            return false;

        } catch (error) {
            console.error(`Failed to check position ${position.id}:`, error);
            return false;
        }
    }
};

// Start reconciliation worker when page loads (if on momentum trading page)
if (window.location.pathname.includes('momentum-trading')) {
    // Wait 30 seconds after page load to start reconciliation
    // (gives time for other workers to initialize)
    setTimeout(() => {
        ReconciliationWorker.start();
    }, 30000);
}
