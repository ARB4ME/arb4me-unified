# Momentum Trading: Backend → Frontend Migration Guide

**Date:** 2025-10-28
**Status:** IN PROGRESS
**Reason:** Momentum trading was built with backend worker, but platform architecture requires frontend workers (like triangular arb, currency swap)

---

## Problem Statement

Momentum Trading was incorrectly built with a **backend worker** (`MomentumWorkerService.js`) that runs on the server. This is wrong for a multi-user platform because:

- ❌ All users share one worker on YOUR server
- ❌ Uses YOUR server CPU/memory/bandwidth
- ❌ User API credentials actively used on YOUR server
- ❌ Users cannot independently control start/stop
- ❌ Doesn't scale (1000 users = 1000 workers on YOUR server)

**Correct Architecture (like other strategies):**
- ✅ Worker runs in user's browser (frontend JavaScript)
- ✅ Each user controls their own worker independently
- ✅ Zero server load per user
- ✅ User's computer does the work
- ✅ Scalable to millions of users

---

## Migration Strategy: Copy Files to Frontend

Instead of rewriting from scratch, we're **copying** backend service files to frontend JavaScript files with minimal modifications.

### What Gets Copied (Backend → Frontend):

```
COPY & CONVERT (then delete backend):
─────────────────────────────────────────────────────────────────
Backend File (DELETE after)                Frontend File (NEW)
─────────────────────────────────────────────────────────────────
src/services/momentum/IndicatorService.js  → public/js/momentum/Indicators.js
src/services/momentum/SignalDetectionService.js → public/js/momentum/SignalDetection.js
src/services/momentum/PositionMonitorService.js → public/js/momentum/PositionMonitor.js
src/services/momentum/MomentumWorkerService.js → public/js/momentum/MomentumWorker.js
```

### What STAYS on Backend (provide APIs):

```
KEEP (provide API endpoints for frontend):
─────────────────────────────────────────────────────────────────
src/services/momentum/OrderExecutionService.js (execute trades via API)
src/services/momentum/VALRMarketDataService.js (fetch candles/prices)
src/services/momentum/LunoMarketDataService.js
src/services/momentum/BinanceMarketDataService.js
... (all 20 exchange market data services)

src/models/MomentumStrategy.js (database operations)
src/models/MomentumPosition.js (database operations)
src/models/MomentumCredentials.js (database operations)

src/routes/momentum-trading.routes.js (API endpoints)
```

---

## Conversion Rules: Backend → Frontend

### 1. Remove Node.js Imports/Exports

**Backend:**
```javascript
const IndicatorService = require('./IndicatorService');
const { logger } = require('../../utils/logger');

class SignalDetectionService {
    // ...
}

module.exports = SignalDetectionService;
```

**Frontend:**
```javascript
// No imports needed - loaded via <script> tags

const SignalDetection = {
    // Same methods
};

// No exports - global object
```

### 2. Convert Classes to Object Literals (or keep classes)

**Backend:**
```javascript
class SignalDetectionService {
    static checkEntrySignals(candles, strategy) {
        // logic
    }
}
```

**Frontend (Option 1 - Object Literal):**
```javascript
const SignalDetection = {
    checkEntrySignals(candles, strategy) {
        // SAME logic
    }
};
```

**Frontend (Option 2 - Keep Class):**
```javascript
class SignalDetection {
    static checkEntrySignals(candles, strategy) {
        // SAME logic
    }
}
```

### 3. Replace Direct Database Calls with API Fetch

**Backend:**
```javascript
const strategies = await MomentumStrategy.getAllActive();
const position = await MomentumPosition.getById(id);
```

**Frontend:**
```javascript
const response = await fetch('/api/v1/momentum/strategies?active=true');
const strategies = await response.json();

const posResponse = await fetch(`/api/v1/momentum/positions/${id}`);
const position = await posResponse.json();
```

### 4. Replace Service Calls with API Fetch

**Backend:**
```javascript
const candles = await this.valrService.fetchCandles(pair, timeframe, limit, credentials);
const currentPrice = await this.valrService.fetchCurrentPrice(pair, credentials);
```

**Frontend:**
```javascript
const url = `/api/v1/momentum/candles?exchange=valr&pair=${pair}&timeframe=${timeframe}&limit=${limit}`;
const candles = await fetch(url).then(r => r.json());

const priceUrl = `/api/v1/momentum/price?exchange=valr&pair=${pair}`;
const currentPrice = await fetch(priceUrl).then(r => r.json());
```

### 5. Replace Logger with Console (or remove)

**Backend:**
```javascript
logger.info('Signal detected', { pair, rsi });
logger.warn('Failed to calculate RSI', { error: error.message });
```

**Frontend:**
```javascript
console.log('🎯 Signal detected', pair, 'RSI:', rsi);
console.warn('⚠️ Failed to calculate RSI:', error.message);
```

### 6. Keep ALL Calculation Logic EXACTLY THE SAME

**Backend & Frontend (NO CHANGES):**
```javascript
calculateRSI(candles, period = 14) {
    // This formula stays EXACTLY the same
    const gains = [];
    const losses = [];

    for (let i = 1; i < candles.length; i++) {
        const change = candles[i].close - candles[i - 1].close;
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }

    // ... rest of RSI calculation
    return rsi;
}
```

---

## Step-by-Step Migration Process

### Phase 1: Setup (5 minutes)

1. Create folder structure:
```bash
mkdir -p public/js/momentum
```

2. Create 4 empty files:
```bash
touch public/js/momentum/Indicators.js
touch public/js/momentum/SignalDetection.js
touch public/js/momentum/PositionMonitor.js
touch public/js/momentum/MomentumWorker.js
```

### Phase 2: Convert Files (3-4 hours)

#### Step 2.1: Convert IndicatorService.js → Indicators.js

**Source:** `src/services/momentum/IndicatorService.js`
**Target:** `public/js/momentum/Indicators.js`

**Changes:**
- ❌ Remove `const { logger } = require(...)`
- ❌ Remove `module.exports`
- ✏️ Convert `class IndicatorService` → `const Indicators = {`
- ✏️ Change `logger.warn()` → `console.warn()`
- ✅ Keep ALL calculation methods (calculateRSI, calculateMACD, etc.)

#### Step 2.2: Convert SignalDetectionService.js → SignalDetection.js

**Source:** `src/services/momentum/SignalDetectionService.js`
**Target:** `public/js/momentum/SignalDetection.js`

**Changes:**
- ❌ Remove `const IndicatorService = require(...)`
- ❌ Remove `const { logger } = require(...)`
- ❌ Remove `module.exports`
- ✏️ Convert class to object literal
- ✏️ Change `IndicatorService.calculateRSI()` → `Indicators.calculateRSI()`
- ✏️ Change `logger.warn()` → `console.warn()`
- ✅ Keep ALL signal detection logic

#### Step 2.3: Convert PositionMonitorService.js → PositionMonitor.js

**Source:** `src/services/momentum/PositionMonitorService.js`
**Target:** `public/js/momentum/PositionMonitor.js`

**Changes:**
- ❌ Remove all `require()` statements
- ❌ Remove `module.exports`
- ✏️ Convert class to object literal
- ✏️ Replace `await MomentumPosition.getOpenByUserAndExchange()` with `await fetch('/api/v1/momentum/positions?...')`
- ✏️ Replace `await marketService.fetchCurrentPrice()` with `await fetch('/api/v1/momentum/price?...')`
- ✏️ Replace `await this.orderService.executeSellOrder()` with `await fetch('/api/v1/momentum/orders/sell', { method: 'POST', ... })`
- ✅ Keep ALL exit condition logic

#### Step 2.4: Convert MomentumWorkerService.js → MomentumWorker.js

**Source:** `src/services/momentum/MomentumWorkerService.js`
**Target:** `public/js/momentum/MomentumWorker.js`

**Changes:**
- ❌ Remove all `require()` statements (20+ exchange services)
- ❌ Remove `module.exports`
- ✏️ Convert class to object literal
- ✏️ Replace `await MomentumStrategy.getAllActive()` with `await fetch('/api/v1/momentum/strategies?active=true')`
- ✏️ Replace `await MomentumCredentials.getByUserAndExchange()` with `await fetch('/api/v1/momentum/credentials?...')`
- ✏️ Replace market service calls with fetch to API endpoints
- ✏️ Change `console.log()` backend messages to remain as `console.log()` (now visible in F12!)
- ✅ Keep ALL orchestration logic (60s interval, parallel processing, etc.)

### Phase 3: Update HTML (30 minutes)

**File:** `public/momentum-trading.html`

Add script tags before closing `</body>`:

```html
    <!-- Momentum Trading Frontend Worker -->
    <script src="/js/momentum/Indicators.js"></script>
    <script src="/js/momentum/SignalDetection.js"></script>
    <script src="/js/momentum/PositionMonitor.js"></script>
    <script src="/js/momentum/MomentumWorker.js"></script>

    <script>
        // Add worker controls
        let workerInterval = null;

        function startMomentumWorker() {
            if (workerInterval) {
                console.warn('⚠️ Worker already running');
                return;
            }

            console.log('🚀 Starting Momentum Worker...');
            MomentumWorker.start();
            workerInterval = setInterval(() => {
                MomentumWorker.runCycle();
            }, 60000);

            // Run first cycle immediately
            MomentumWorker.runCycle();
        }

        function stopMomentumWorker() {
            if (!workerInterval) {
                console.warn('⚠️ Worker not running');
                return;
            }

            console.log('⏹️ Stopping Momentum Worker...');
            clearInterval(workerInterval);
            workerInterval = null;
            MomentumWorker.stop();
        }

        // Add UI buttons (optional - or trigger on page load)
        // Could auto-start if user has active strategies
    </script>
</body>
</html>
```

### Phase 4: Test (1-2 hours)

1. **Test on localhost:**
   - Open momentum-trading.html
   - Open F12 console
   - Run `startMomentumWorker()`
   - Verify console messages appear
   - Check signals are detected
   - Verify positions open/close

2. **Test all exchanges:**
   - Create test strategy for each exchange
   - Verify candles fetched correctly
   - Verify signals detected
   - Test with small amounts

3. **Test error handling:**
   - Disconnect internet
   - Invalid API credentials
   - Rate limit scenarios

### Phase 5: Delete Backend (30 minutes)

**Only do this AFTER frontend is tested and working!**

1. **Delete backend service files:**
```bash
rm src/services/momentum/IndicatorService.js
rm src/services/momentum/SignalDetectionService.js
rm src/services/momentum/PositionMonitorService.js
rm src/services/momentum/MomentumWorkerService.js
```

2. **Remove from server.js:**

Delete lines 192-202:
```javascript
// START MOMENTUM TRADING WORKER - DELETE THIS BLOCK
if (dbConnection) {
    try {
        const momentumWorker = require('./src/services/momentum/MomentumWorkerService');
        momentumWorker.start();
        logger.info('Momentum Trading Worker started');
    } catch (error) {
        logger.warn('Momentum Trading Worker failed to start', { error: error.message });
    }
}
```

Delete lines 233-239:
```javascript
// STOP MOMENTUM WORKER - DELETE THIS BLOCK
try {
    const momentumWorker = require('./src/services/momentum/MomentumWorkerService');
    momentumWorker.stop();
    logger.info('Momentum Worker stopped');
} catch (error) {
    logger.warn('Failed to stop Momentum Worker', { error: error.message });
}
```

3. **Commit and deploy:**
```bash
git add .
git commit -m "Migrate Momentum Trading to frontend worker architecture"
git push origin main
```

---

## API Endpoints Needed (Verify These Exist)

Frontend will call these backend APIs:

### Strategy Management:
- `GET /api/v1/momentum/strategies?active=true&userId={userId}&exchange={exchange}`
- `POST /api/v1/momentum/strategies`
- `PUT /api/v1/momentum/strategies/:id`
- `DELETE /api/v1/momentum/strategies/:id`

### Position Management:
- `GET /api/v1/momentum/positions?userId={userId}&exchange={exchange}&status=OPEN`
- `POST /api/v1/momentum/positions` (create position)
- `PUT /api/v1/momentum/positions/:id/close` (close position)

### Market Data:
- `GET /api/v1/momentum/candles?exchange={exchange}&pair={pair}&timeframe={timeframe}&limit={limit}`
- `GET /api/v1/momentum/price?exchange={exchange}&pair={pair}`

### Order Execution:
- `POST /api/v1/momentum/orders/buy` (body: exchange, pair, amountUSDT, credentials)
- `POST /api/v1/momentum/orders/sell` (body: exchange, pair, quantity, credentials)

### Credentials:
- `GET /api/v1/momentum/credentials?userId={userId}&exchange={exchange}`

**All these should already exist in `src/routes/momentum-trading.routes.js`**

---

## Troubleshooting Common Issues

### Issue: "Indicators is not defined"
**Cause:** Script files loaded in wrong order
**Fix:** Load Indicators.js first (before SignalDetection.js)

### Issue: "Cannot read property 'json' of undefined"
**Cause:** API endpoint returns error
**Fix:** Check backend logs, verify API endpoint exists

### Issue: "CORS error"
**Cause:** Unlikely since frontend served from same domain
**Fix:** Check server CORS configuration

### Issue: Console messages not showing
**Cause:** Worker not started or errors blocking execution
**Fix:** Check for JavaScript errors in F12 console, add try/catch blocks

### Issue: Signals not detecting
**Cause:** Candle data not fetching or calculation errors
**Fix:** Console.log candles array, verify format matches backend expectations

---

## Success Criteria

✅ **Migration Complete When:**
1. Frontend worker runs in browser (60s intervals)
2. Console messages visible in F12
3. Signals detected and positions opened
4. Positions monitored and closed correctly
5. All 20 exchanges work
6. Backend worker files deleted
7. server.js worker code removed
8. Deployed to Railway successfully

---

## Rollback Plan (If Something Goes Wrong)

If frontend migration fails, rollback:

```bash
git revert HEAD
git push origin main
```

Backend worker will resume automatically.

---

## Notes for Next Claude Session

**Current Status:** {{ UPDATE THIS }}
- [ ] Phase 1: Setup complete
- [ ] Phase 2: Files converted
- [ ] Phase 3: HTML updated
- [ ] Phase 4: Tested
- [ ] Phase 5: Backend deleted

**Last File Worked On:** {{ UPDATE THIS }}

**Next Step:** {{ UPDATE THIS }}

**Issues Encountered:** {{ UPDATE THIS }}

---

## Contact

If stuck, check:
1. This migration guide
2. Git history: `git log --oneline --grep="momentum"`
3. Existing triangular arb pattern in `public/triangular-arb.html`
4. Audit report: `MOMENTUM_AUDIT_REPORT.md`
