# Momentum Trading Frontend Migration - Execution Plan

**Date:** 2025-10-28
**Estimated Time:** 4-6 hours total
**Current Status:** READY TO START

---

## 📋 Pre-Flight Checklist

Before starting, confirm:
- ✅ Migration guide saved: `MOMENTUM_FRONTEND_MIGRATION.md`
- ✅ TODO list created (10 tasks)
- ✅ Backup/rollback plan documented
- ✅ ~88,000 tokens remaining (plenty)
- ✅ User has saved migration guide externally

---

## 🎯 PHASE 1: Setup Folder Structure (5 minutes)

### Actions:
1. Create `public/js/momentum/` directory
2. Create 4 empty JavaScript files

### Commands:
```bash
mkdir -p public/js/momentum
touch public/js/momentum/Indicators.js
touch public/js/momentum/SignalDetection.js
touch public/js/momentum/PositionMonitor.js
touch public/js/momentum/MomentumWorker.js
```

### Success Criteria:
✅ Folder exists: `public/js/momentum/`
✅ 4 empty files created

### Checkpoint: STOP and confirm folder structure is correct before proceeding

---

## 🎯 PHASE 2.1: Convert Indicators (45 minutes)

### Source File:
`src/services/momentum/IndicatorService.js` (344 lines)

### Target File:
`public/js/momentum/Indicators.js`

### Conversion Steps:

**1. Copy entire content** from IndicatorService.js

**2. Remove these lines:**
- Line 1: `const { logger } = require('../../utils/logger');`
- Last line: `module.exports = IndicatorService;`

**3. Change class declaration:**
```javascript
// FROM:
class IndicatorService {

// TO:
const Indicators = {
```

**4. Change closing:**
```javascript
// FROM:
}
module.exports = IndicatorService;

// TO:
};
```

**5. Replace logger calls:**
- Find all: `logger.warn(`
- Replace with: `console.warn(`

**6. Keep EVERYTHING ELSE THE SAME:**
- ✅ calculateRSI()
- ✅ calculateMACD()
- ✅ calculateVolumeSpike()
- ✅ calculateEMA()
- ✅ calculateBollingerBands()
- ✅ calculateStochastic()
- ✅ All formulas stay EXACTLY the same

### Success Criteria:
✅ File compiles without errors
✅ All 6 indicator functions present
✅ No `require()` statements
✅ No `module.exports`
✅ Global `Indicators` object defined

### Checkpoint: Test in browser console - type `Indicators` should show object

---

## 🎯 PHASE 2.2: Convert Signal Detection (1 hour)

### Source File:
`src/services/momentum/SignalDetectionService.js` (327 lines)

### Target File:
`public/js/momentum/SignalDetection.js`

### Conversion Steps:

**1. Copy entire content**

**2. Remove these lines:**
```javascript
const IndicatorService = require('./IndicatorService');
const { logger } = require('../../utils/logger');
module.exports = SignalDetectionService;
```

**3. Change class to object:**
```javascript
// FROM:
class SignalDetectionService {

// TO:
const SignalDetection = {
```

**4. Replace all `IndicatorService` references:**
- Find: `IndicatorService.calculateRSI`
- Replace: `Indicators.calculateRSI`
- (Do this for all indicator methods)

**5. Replace logger calls:**
- `logger.warn(` → `console.warn(`
- `logger.info(` → `console.log(`

**6. Keep all logic the same:**
- ✅ checkEntrySignals()
- ✅ checkExitSignals()
- ✅ Entry logic evaluation (2_out_of_3, all, any_1)
- ✅ Exit condition checks (TP, SL, max hold)

### Success Criteria:
✅ File compiles without errors
✅ No `require()` statements
✅ Uses `Indicators.` for calculations
✅ Global `SignalDetection` object defined

### Checkpoint: Test `SignalDetection.checkEntrySignals` exists

---

## 🎯 PHASE 2.3: Convert Position Monitor (1.5 hours)

### Source File:
`src/services/momentum/PositionMonitorService.js` (344 lines)

### Target File:
`public/js/momentum/PositionMonitor.js`

### Conversion Steps:

**1. Copy entire content**

**2. Remove all require statements:**
```javascript
const MomentumPosition = require('../../models/MomentumPosition');
const MomentumStrategy = require('../../models/MomentumStrategy');
const SignalDetectionService = require('./SignalDetectionService');
const OrderExecutionService = require('./OrderExecutionService');
const { logger } = require('../../utils/logger');
module.exports = PositionMonitorService;
```

**3. Change class to object:**
```javascript
const PositionMonitor = {
```

**4. Replace database calls with fetch:**

**Original:**
```javascript
const openPositions = await MomentumPosition.getOpenByUserAndExchange(userId, exchange);
```

**Replace with:**
```javascript
const response = await fetch(`/api/v1/momentum/positions?userId=${userId}&exchange=${exchange}&status=OPEN`);
const result = await response.json();
const openPositions = result.success ? result.data : [];
```

**5. Replace market service calls:**

**Original:**
```javascript
const marketService = this._getMarketService(exchange);
const currentPrice = await marketService.fetchCurrentPrice(pair, credentials);
```

**Replace with:**
```javascript
const priceUrl = `/api/v1/momentum/price?exchange=${exchange}&pair=${pair}`;
const priceResponse = await fetch(priceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials })
});
const priceResult = await priceResponse.json();
const currentPrice = priceResult.success ? priceResult.data : null;
```

**6. Replace order execution:**

**Original:**
```javascript
const sellOrder = await this.orderService.executeSellOrder(
    exchange,
    position.pair,
    position.entry_quantity,
    credentials
);
```

**Replace with:**
```javascript
const orderResponse = await fetch('/api/v1/momentum/orders/sell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        exchange: exchange,
        pair: position.pair,
        quantity: position.entry_quantity,
        credentials: credentials
    })
});
const orderResult = await orderResponse.json();
const sellOrder = orderResult.success ? orderResult.data : null;
```

**7. Replace close position:**

**Original:**
```javascript
const closedPosition = await MomentumPosition.close(position.id, {
    exitPrice: exitPrice,
    exitQuantity: position.entry_quantity,
    exitReason: reason,
    exitOrderId: sellOrder.orderId
});
```

**Replace with:**
```javascript
const closeResponse = await fetch(`/api/v1/momentum/positions/${position.id}/close`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        exitPrice: exitPrice,
        exitQuantity: position.entry_quantity,
        exitReason: reason,
        exitOrderId: sellOrder.orderId
    })
});
const closeResult = await closeResponse.json();
const closedPosition = closeResult.success ? closeResult.data : null;
```

**8. Replace SignalDetectionService calls:**
- `SignalDetectionService.checkExitSignals` → `SignalDetection.checkExitSignals`

**9. Replace logger:**
- `logger.info(` → `console.log(`
- `logger.error(` → `console.error(`
- `logger.debug(` → `console.log(`

### Success Criteria:
✅ No database calls (all fetch)
✅ No service calls (all fetch)
✅ Uses `SignalDetection.` for signals
✅ Global `PositionMonitor` object defined

### Checkpoint: Test `PositionMonitor.monitorPositions` exists

---

## 🎯 PHASE 2.4: Convert Worker Service (1.5 hours)

### Source File:
`src/services/momentum/MomentumWorkerService.js` (726 lines)

### Target File:
`public/js/momentum/MomentumWorker.js`

### Conversion Steps:

**1. Copy entire content**

**2. Remove ALL require statements (20+ lines):**
```javascript
const MomentumStrategy = require('../../models/MomentumStrategy');
const MomentumPosition = require('../../models/MomentumPosition');
const MomentumCredentials = require('../../models/MomentumCredentials');
// ... all 20 exchange services
// ... all other services
const { logger } = require('../../utils/logger');
module.exports = new MomentumWorkerService();
```

**3. Change class:**
```javascript
const MomentumWorker = {
    isRunning: false,
    intervalId: null,
```

**4. Remove market service initialization:**
Delete the entire `this.marketDataServices = { ... }` object (40+ lines)

**5. Replace strategy database calls:**

**Original:**
```javascript
async _getAllActiveStrategies() {
    const result = await query(`SELECT * FROM momentum_strategies WHERE is_active = true`);
    return result.rows;
}
```

**Replace with:**
```javascript
async _getAllActiveStrategies() {
    const response = await fetch('/api/v1/momentum/strategies?active=true');
    const result = await response.json();
    return result.success ? result.data : [];
}
```

**6. Replace credentials fetch:**

**Original:**
```javascript
const credentials = await MomentumCredentials.getByUserAndExchange(strategy.user_id, strategy.exchange);
```

**Replace with:**
```javascript
const credResponse = await fetch(`/api/v1/momentum/credentials?userId=${strategy.user_id}&exchange=${strategy.exchange}`);
const credResult = await credResponse.json();
const credentials = credResult.success ? credResult.data : null;
```

**7. Replace market data calls:**

**Original:**
```javascript
const marketService = this.getMarketService(strategy.exchange);
const candles = await marketService.fetchCandles(pair, '1h', 100, credentials);
```

**Replace with:**
```javascript
const candlesUrl = `/api/v1/momentum/candles?exchange=${strategy.exchange}&pair=${pair}&timeframe=1h&limit=100`;
const candlesResponse = await fetch(candlesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials })
});
const candlesResult = await candlesResponse.json();
const candles = candlesResult.success ? candlesResult.data : [];
```

**8. Replace position creation:**

**Original:**
```javascript
const position = await MomentumPosition.create({
    userId: strategy.user_id,
    // ... other fields
});
```

**Replace with:**
```javascript
const posResponse = await fetch('/api/v1/momentum/positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        userId: strategy.user_id,
        // ... other fields
    })
});
const posResult = await posResponse.json();
const position = posResult.success ? posResult.data : null;
```

**9. Replace order execution:**

**Original:**
```javascript
const buyOrder = await this.orderService.executeBuyOrder(
    strategy.exchange,
    pair,
    strategy.max_trade_amount,
    credentials
);
```

**Replace with:**
```javascript
const orderResponse = await fetch('/api/v1/momentum/orders/buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        exchange: strategy.exchange,
        pair: pair,
        amountUSDT: strategy.max_trade_amount,
        credentials: credentials
    })
});
const orderResult = await orderResponse.json();
const buyOrder = orderResult.success ? orderResult.data : null;
```

**10. Replace service references:**
- `SignalDetectionService.checkEntrySignals` → `SignalDetection.checkEntrySignals`
- `PositionMonitorService.monitorPositions` → `PositionMonitor.monitorPositions`

**11. Keep console messages (they'll now appear in F12!):**
- All `console.log()` statements stay EXACTLY the same
- These will now be visible in browser console!

**12. Update start/stop methods:**
```javascript
start() {
    this.isRunning = true;
    console.log('🚀 MOMENTUM TRADING WORKER STARTED');
    console.log(`📅 Started at: ${new Date().toLocaleString()}`);
},

stop() {
    this.isRunning = false;
    console.log('⏹️ MOMENTUM TRADING WORKER STOPPED');
}
```

### Success Criteria:
✅ No require statements
✅ All database calls replaced with fetch
✅ All service calls replaced with fetch
✅ Console messages preserved
✅ Global `MomentumWorker` object defined

### Checkpoint: Test `MomentumWorker.start` and `MomentumWorker.runCycle` exist

---

## 🎯 PHASE 3: Update HTML - Add Script Tags (15 minutes)

### File:
`public/momentum-trading.html`

### Actions:

**1. Find the closing `</body>` tag**

**2. Add script tags BEFORE `</body>`:**

```html
    <!-- Momentum Trading Frontend Worker Scripts -->
    <script src="/js/momentum/Indicators.js"></script>
    <script src="/js/momentum/SignalDetection.js"></script>
    <script src="/js/momentum/PositionMonitor.js"></script>
    <script src="/js/momentum/MomentumWorker.js"></script>

</body>
</html>
```

**Order matters:** Load in dependency order (Indicators first, Worker last)

### Success Criteria:
✅ 4 script tags added
✅ Correct order (Indicators → SignalDetection → PositionMonitor → Worker)
✅ Before closing `</body>` tag

### Checkpoint: Open HTML in browser, check F12 console for errors

---

## 🎯 PHASE 4: Add Worker Control Functions (30 minutes)

### File:
`public/momentum-trading.html`

### Actions:

**1. Add worker control code AFTER script tags, BEFORE `</body>`:**

```html
    <script>
        // Momentum Worker Control
        let momentumWorkerInterval = null;
        let workerRunning = false;

        async function startMomentumWorker() {
            if (workerRunning) {
                console.warn('⚠️ Momentum Worker already running');
                return;
            }

            console.log('🚀 Starting Momentum Worker...');
            workerRunning = true;
            MomentumWorker.start();

            // Run first cycle immediately
            await MomentumWorker.runCycle();

            // Then run every 60 seconds
            momentumWorkerInterval = setInterval(async () => {
                if (workerRunning) {
                    await MomentumWorker.runCycle();
                }
            }, 60000);

            console.log('✅ Momentum Worker started - running every 60 seconds');
        }

        function stopMomentumWorker() {
            if (!workerRunning) {
                console.warn('⚠️ Momentum Worker not running');
                return;
            }

            console.log('⏹️ Stopping Momentum Worker...');
            workerRunning = false;

            if (momentumWorkerInterval) {
                clearInterval(momentumWorkerInterval);
                momentumWorkerInterval = null;
            }

            MomentumWorker.stop();
            console.log('✅ Momentum Worker stopped');
        }

        // Auto-start worker if user has active strategies (optional)
        document.addEventListener('DOMContentLoaded', async function() {
            // Check if user has active strategies
            const response = await fetch(`/api/v1/momentum/strategies?active=true&userId=${USER_ID}`);
            const result = await response.json();

            if (result.success && result.data && result.data.length > 0) {
                console.log(`📊 Found ${result.data.length} active strategies - auto-starting worker`);
                await startMomentumWorker();
            } else {
                console.log('ℹ️ No active strategies found - worker will start when strategy is activated');
            }
        });

        // Stop worker when page unloads
        window.addEventListener('beforeunload', () => {
            if (workerRunning) {
                stopMomentumWorker();
            }
        });
    </script>
</body>
</html>
```

### Success Criteria:
✅ `startMomentumWorker()` function defined
✅ `stopMomentumWorker()` function defined
✅ Auto-start on page load if strategies exist
✅ Auto-stop on page unload

### Checkpoint: Test in browser - F12 console should show worker starting

---

## 🎯 PHASE 5: Commit and Test (30 minutes)

### Actions:

**1. Commit frontend changes:**
```bash
git add public/js/momentum/
git add public/momentum-trading.html
git commit -m "Add frontend worker for Momentum Trading (Phase 1)"
git push origin main
```

**2. Wait for Railway deployment (~2 minutes)**

**3. Test in browser:**
- Open momentum-trading.html
- Open F12 console
- Verify worker auto-starts
- Check for console messages:
  - 🚀 MOMENTUM TRADING WORKER STARTED
  - 🔄 MOMENTUM WORKER CYCLE STARTED
  - etc.

**4. Test functionality:**
- Create a test strategy
- Verify signals detected
- Test position opening (with small amount!)
- Test position closing

**5. Test all 20 exchanges:**
- Create strategy for each exchange
- Verify candles fetch
- Verify no errors

### Success Criteria:
✅ Worker runs in browser
✅ Console messages visible in F12
✅ Signals detected
✅ Positions open/close correctly
✅ No JavaScript errors

### Checkpoint: STOP - Don't delete backend until this works perfectly!

---

## 🎯 PHASE 6: Delete Backend Files (15 minutes)

**⚠️ ONLY DO THIS AFTER PHASE 5 IS VERIFIED WORKING!**

### Actions:

**1. Delete backend service files:**
```bash
git rm src/services/momentum/IndicatorService.js
git rm src/services/momentum/SignalDetectionService.js
git rm src/services/momentum/PositionMonitorService.js
git rm src/services/momentum/MomentumWorkerService.js
```

**2. Verify these files still exist (don't delete):**
```bash
ls src/services/momentum/
# Should still see:
# - OrderExecutionService.js
# - All 20 MarketDataService files (VALR, Luno, etc.)
```

### Success Criteria:
✅ 4 service files deleted
✅ 20 exchange services remain
✅ OrderExecutionService remains
✅ Models remain

### Checkpoint: Verify backend still compiles (npm start)

---

## 🎯 PHASE 7: Clean server.js (15 minutes)

### File:
`server.js`

### Actions:

**1. Find and delete lines 192-202:**
```javascript
// DELETE THIS ENTIRE BLOCK:
        // Start Momentum Trading Worker
        if (dbConnection) {
            try {
                const momentumWorker = require('./src/services/momentum/MomentumWorkerService');
                momentumWorker.start();
                logger.info('Momentum Trading Worker started - monitoring active strategies');
            } catch (error) {
                logger.warn('Momentum Trading Worker failed to start', { error: error.message });
                // Don't crash the server if worker fails
            }
        }
```

**2. Find and delete lines 233-239 (in graceful shutdown):**
```javascript
// DELETE THIS ENTIRE BLOCK:
    // Stop Momentum Worker
    try {
        const momentumWorker = require('./src/services/momentum/MomentumWorkerService');
        momentumWorker.stop();
        logger.info('Momentum Worker stopped');
    } catch (error) {
        logger.warn('Failed to stop Momentum Worker', { error: error.message });
    }
```

**3. Commit cleanup:**
```bash
git add server.js
git commit -m "Remove backend Momentum Worker - now runs in frontend"
git push origin main
```

### Success Criteria:
✅ No references to MomentumWorkerService in server.js
✅ Server starts without errors
✅ Frontend worker still works

---

## ✅ Final Verification Checklist

After all phases complete:

- [ ] Frontend worker runs in browser (F12 console shows messages)
- [ ] Backend worker deleted (files removed)
- [ ] server.js cleaned (no worker start/stop)
- [ ] All 20 exchanges work
- [ ] Signals detected correctly
- [ ] Positions open correctly
- [ ] Positions close correctly
- [ ] No JavaScript errors in F12
- [ ] No backend errors in Railway logs
- [ ] Committed and deployed to Railway

---

## 🆘 Rollback Procedure (If Needed)

If something goes wrong:

```bash
git log --oneline | head -5  # Find commit before changes
git revert HEAD              # Or specific commit hash
git push origin main
```

Backend worker will resume on next deployment.

---

## 📊 Estimated Timeline

| Phase | Time | Cumulative |
|-------|------|------------|
| 1. Setup | 5 min | 5 min |
| 2.1 Indicators | 45 min | 50 min |
| 2.2 Signal Detection | 1 hour | 1h 50min |
| 2.3 Position Monitor | 1.5 hours | 3h 20min |
| 2.4 Worker Service | 1.5 hours | 4h 50min |
| 3. HTML Scripts | 15 min | 5h 5min |
| 4. Worker Controls | 30 min | 5h 35min |
| 5. Test | 30 min | 6h 5min |
| 6. Delete Backend | 15 min | 6h 20min |
| 7. Clean server.js | 15 min | 6h 35min |

**Total: ~6-7 hours**

---

## 📝 Notes Section

**Progress Tracking:**
- Current Phase: {{ WAITING TO START }}
- Last Completed: {{ NONE }}
- Issues Encountered: {{ NONE }}
- Next Step: {{ Phase 1: Create folder structure }}

**Update this section as we progress!**
