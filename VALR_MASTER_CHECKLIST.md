# VALR TRIANGULAR ARBITRAGE - MASTER IMPLEMENTATION CHECKLIST
## Production-Ready Multi-User Trading Platform Standard

> **Purpose**: This checklist defines the COMPLETE implementation standard based on VALR (our master reference exchange). All 21 exchanges MUST meet these standards before going live with real user funds.

---

## 📋 **1. BACKEND IMPLEMENTATION** (`src/routes/triangular-arb.routes.js`)

### 1.1 Path Definitions
- [ ] All paths defined with `steps` arrays for ProfitCalculatorService
- [ ] Each path has: `id`, `path`, `sequence`, `description`, `steps`
- [ ] Steps include: `{ pair, side }` for each leg
- [ ] Paths organized into logical SETS (e.g., SET_1_MAJORS, SET_2_ALTS)
- [ ] Minimum 20-40 paths total across multiple sets

### 1.2 Scan Endpoint (`/[exchange]/triangular/scan`)
- [ ] Accepts: `apiKey`, `apiSecret`, (passphrase if needed)
- [ ] Accepts: `maxTradeAmount` (default: 1000)
- [ ] Accepts: `portfolioPercent` (default: 10)
- [ ] Accepts: `profitThreshold` (default: 0.5)
- [ ] Accepts: `enabledSets` or `scanSet` parameter
- [ ] Accepts: `currentBalanceUSDT`, `currentBalanceZAR` (or relevant currencies)
- [ ] Fetches USDT/primary balance from exchange
- [ ] Uses `portfolioCalculator.calculateTradeAmount()` with portfolio % logic
- [ ] Checks `portfolioCalc.canTrade` before proceeding
- [ ] Fetches orderbooks for all required pairs
- [ ] Uses `ProfitCalculatorService.calculate()` for each path
- [ ] Filters results by `profitThreshold`
- [ ] Returns: `{ success, profitableCount, scanned, opportunities, balance, portfolioCalculation }`

### 1.3 Balance Endpoint (`/[exchange]/balance`)
- [ ] Accepts: `apiKey`, `apiSecret`, (passphrase if needed)
- [ ] Accepts: `currency` parameter (USDT, ZAR, USD, etc.)
- [ ] Uses exchange-specific authentication (HMAC, etc.)
- [ ] Returns: `{ success, currency, balance, locked, total, timestamp }`

### 1.4 Execute Endpoint (`/[exchange]/triangular/execute`)
- [ ] Accepts: `pathId`, `amount`, `apiKey`, `apiSecret`
- [ ] Validates all required parameters
- [ ] Executes 3-leg (or 4-leg) trade atomically
- [ ] Returns detailed execution results
- [ ] Logs all trades for audit trail

### 1.5 Authentication & Security
- [ ] Exchange-specific signature function (e.g., `createValrSignature()`)
- [ ] Proper HMAC-SHA256/SHA512 implementation
- [ ] Timestamp/nonce handling
- [ ] Passphrase support (if required by exchange)
- [ ] No credentials stored - passed as parameters only

### 1.6 Fee Structure
- [ ] Fees defined in `ProfitCalculatorService.js`
- [ ] Correct maker/taker fees for the exchange
- [ ] Format: `{ maker: 0.001, taker: 0.001 }`

---

## 🎨 **2. FRONTEND HTML** (`public/triangular-arb.html`)

### 2.1 UI Structure
- [ ] Exchange section with professional styling
- [ ] Header with toggle switch (ON/OFF)
- [ ] FUNDING REQUIREMENTS banner with color-coded path sets
- [ ] 3-column responsive grid layout
- [ ] Balance Tracker with tabs (Balance / Current Opportunities)
- [ ] Performance Stats section

### 2.2 Column 1: Risk Management
- [ ] Max Trade Amount input (default: 500-1000)
- [ ] Portfolio % to Use input (default: 10%)
- [ ] Profit Threshold % input (default: 0.5%)
- [ ] Auto-save on change

### 2.3 Column 2: Path Selection
- [ ] Checkboxes for each path SET
- [ ] Default: 2-3 sets enabled
- [ ] "View All Paths" button (modal)
- [ ] Settings auto-save note

### 2.4 Column 3: Performance Stats
- [ ] Total Scans counter
- [ ] Opportunities Found counter
- [ ] Trades Executed counter
- [ ] Success Rate %
- [ ] Total Profit display
- [ ] Avg Profit/Trade display

### 2.5 Balance Tracker Tab
- [ ] Starting Balance display
- [ ] Current Balance display
- [ ] Change (P&L) display with color coding
- [ ] Refresh Balance button
- [ ] Reset Starting Point button

### 2.6 Current Opportunities Tab
- [ ] "Scan Opportunities Now" button
- [ ] Scan status display
- [ ] Opportunities list (live updates)
- [ ] Clear Opportunity History button

---

## ⚙️ **3. FRONTEND JAVASCRIPT** (`public/triangular-arb.html`)

### 3.1 Toggle Function
- [ ] `toggle[Exchange]Triangular()` function exists
- [ ] Updates toggle visual state
- [ ] Updates status text (ON/OFF)
- [ ] Saves state to localStorage
- [ ] Starts/stops worker based on state

### 3.2 View Paths Modal
- [ ] `view[Exchange]PathDetails()` function exists
- [ ] Professional modal with backdrop blur
- [ ] Color-coded path sets display
- [ ] Shows all paths with descriptions
- [ ] Close button functionality
- [ ] Click outside to close

### 3.3 Tab Switching
- [ ] `switch[Exchange]Tab(tab)` function exists
- [ ] Switches between 'balance' and 'trading' tabs
- [ ] Updates button styling
- [ ] Shows/hides content divs

### 3.4 Balance Tracking
- [ ] `[exchange]BalanceTracking` state object
- [ ] Properties: `starting`, `current`, `initialized`
- [ ] `initialize[Exchange]Balance()` - auto-fetch on page load
- [ ] `update[Exchange]Balance()` - manual refresh button
- [ ] `update[Exchange]BalanceDisplay()` - updates UI with NaN prevention
- [ ] `reset[Exchange]StartingBalance()` - resets P&L baseline

### 3.5 Scan Function
- [ ] `scan[Exchange]TriangularPaths()` function exists
- [ ] Reads settings from UI (maxTrade, portfolioPercent, profitThreshold)
- [ ] Reads API credentials from localStorage
- [ ] Validates credentials before scan
- [ ] Collects enabled sets from checkboxes
- [ ] Sends POST request to `/[exchange]/triangular/scan`
- [ ] Displays scan status with loading state
- [ ] Displays opportunities with color-coded profit %
- [ ] Shows "Execute Trade" buttons for each opportunity

### 3.6 Execute Trade Function
- [ ] `execute[Exchange]TriangularTrade(pathId)` function exists
- [ ] Sends POST request to `/[exchange]/triangular/execute`
- [ ] Shows confirmation/success message
- [ ] Updates balance after execution
- [ ] Logs trade to history

### 3.7 Clear History Function
- [ ] `clear[Exchange]History()` function exists
- [ ] Confirmation prompt
- [ ] Clears opportunities display

### 3.8 Settings Functions
- [ ] `save[Exchange]TriangularSettings()` function exists
- [ ] Saves: maxTrade, portfolioPercent, profitThreshold, enabledSets
- [ ] Stores in localStorage with key: `[exchange]_triangular_settings`
- [ ] `load[Exchange]TriangularSettings()` function exists
- [ ] Loads settings from localStorage on page load
- [ ] Applies defaults if no saved settings

### 3.9 DOMContentLoaded Initialization
- [ ] Event listener for `DOMContentLoaded`
- [ ] Calls `load[Exchange]TriangularSettings()`
- [ ] Calls `initialize[Exchange]Balance()`
- [ ] Initializes default tab (balance)
- [ ] Restores toggle state from localStorage
- [ ] Attaches auto-save listeners to inputs

---

## 🤖 **4. WORKER IMPLEMENTATION** (Sequential Scanning)

### 4.1 Worker Variables
- [ ] `[exchange]WorkerInterval` variable (for setInterval ID)
- [ ] `[exchange]WorkerStats` object with: `totalScans`, `totalOpportunities`, `totalTrades`, `successfulTrades`, `totalProfit`, `bestProfit`, `bestPath`

### 4.2 Start Worker Function
- [ ] `start[Exchange]Worker()` function exists
- [ ] Reads API credentials from localStorage
- [ ] Reads settings from UI (profitThreshold, maxTradeAmount)
- [ ] Gets selected path sets from checkboxes
- [ ] Validates: at least 1 set selected
- [ ] Initializes balance tracking
- [ ] Implements **sequential scanning** (ONE set at a time)
- [ ] Uses `currentSetIndex` to track position
- [ ] Scans one set, waits 5-8 seconds, scans next set
- [ ] Loops back to first set after completing all sets
- [ ] Passes `portfolioPercent` and `maxTradeAmount` to scan endpoint
- [ ] Passes current balance to scan endpoint
- [ ] Filters results by `profitThreshold`
- [ ] Logs detailed profit % for each path
- [ ] Executes profitable opportunities immediately (if toggle ON)
- [ ] Updates worker stats after each trade
- [ ] Updates balance after each scan cycle
- [ ] Handles errors gracefully (continues scanning)

### 4.3 Stop Worker Function
- [ ] `stop[Exchange]Worker()` function exists
- [ ] Clears `setInterval` if running
- [ ] Resets worker interval variable to null
- [ ] Logs stop message to console

### 4.4 Error Handling
- [ ] `handle[Exchange]ExecutionError()` function
- [ ] Logs errors but doesn't stop worker
- [ ] Displays user-friendly error messages
- [ ] Categorizes errors (insufficient balance, slippage, API errors)
- [ ] Adds failed trades to history with reason

---

## 🔧 **5. SERVICE LAYER INTEGRATION**

### 5.1 ProfitCalculatorService
- [ ] Exchange added to `feeStructures` object
- [ ] Correct maker/taker fees configured
- [ ] Service called in scan endpoint
- [ ] Returns: `success`, `profitPercentage`, `steps`, `totalFees`, `startAmount`, `endAmount`

### 5.2 PortfolioCalculator
- [ ] Used in scan endpoint
- [ ] Called with: `balance`, `portfolioPercent`, `maxTradeAmount`, `currency`, `exchange`
- [ ] Returns: `amount`, `canTrade`, `warning`, `reason`
- [ ] Respects MIN(portfolioPercent × balance, maxTradeAmount) formula

---

## 📊 **6. RISK MANAGEMENT**

### 6.1 Portfolio Percentage Mode
- [ ] Default: 10% of balance
- [ ] Safety cap: maxTradeAmount (default $500-1000)
- [ ] Formula: `tradeAmount = MIN(portfolioPercent × balance, maxTradeAmount)`
- [ ] Workers respect risk settings on every scan
- [ ] Balance checked before each scan cycle

### 6.2 Profit Threshold
- [ ] Default: 0.5% minimum profit
- [ ] Configurable per exchange
- [ ] Worker filters opportunities below threshold
- [ ] Only executes above-threshold opportunities

### 6.3 Balance Tracking
- [ ] Real-time balance fetching
- [ ] Starting vs Current comparison
- [ ] P&L calculation with color coding (green/red)
- [ ] Manual refresh button
- [ ] Reset baseline feature

---

## 🎯 **7. FUNDING REQUIREMENTS**

### 7.1 Funding Banner
- [ ] Displays total recommended funding
- [ ] Color-coded path sets (5 different colors)
- [ ] Funding range per set (e.g., $200-400 USDT)
- [ ] Total funding calculation (e.g., $1,000-2,000 USDT)
- [ ] Starter vs Advanced funding levels

### 7.2 Path Set Organization
- [ ] SET 1: Essential/High Volume (enabled by default)
- [ ] SET 2: Popular pairs (enabled by default)
- [ ] SET 3-5: Advanced/Extended (disabled by default)
- [ ] Clear descriptions for each set
- [ ] Path count per set displayed

---

## ✅ **8. QUALITY ASSURANCE**

### 8.1 Code Quality
- [ ] No console errors
- [ ] No syntax errors
- [ ] NaN prevention (`Number() || 0` pattern)
- [ ] Proper error handling
- [ ] Clean, readable code
- [ ] Comments for complex logic

### 8.2 User Experience
- [ ] Professional, consistent UI
- [ ] Responsive design (mobile-friendly)
- [ ] Loading states for async operations
- [ ] Clear success/error messages
- [ ] No broken buttons or links
- [ ] Settings persist across page reloads

### 8.3 Data Accuracy
- [ ] Correct trading pairs for exchange
- [ ] Accurate fee calculations
- [ ] Proper currency handling (USDT, ZAR, USD, etc.)
- [ ] Balance displays match exchange
- [ ] Profit calculations verified

### 8.4 Security
- [ ] No API credentials hardcoded
- [ ] Credentials passed as parameters (stateless)
- [ ] Proper authentication signatures
- [ ] No credentials logged to console
- [ ] localStorage used securely

---

## 🚀 **9. PRODUCTION READINESS**

### 9.1 Testing Checklist
- [ ] Toggle ON/OFF works
- [ ] Balance fetching works
- [ ] Manual scan works
- [ ] Worker starts and scans sequentially
- [ ] Worker stops cleanly
- [ ] Settings save/load works
- [ ] View Paths modal works
- [ ] Execute trade works (test mode)
- [ ] Error handling works
- [ ] Performance acceptable (no lag)

### 9.2 Multi-User Safety
- [ ] No shared state between users
- [ ] Each user's credentials isolated
- [ ] No credential leakage
- [ ] Proper rate limiting
- [ ] Audit logging enabled
- [ ] Error recovery mechanisms

### 9.3 Documentation
- [ ] Path sets documented
- [ ] Funding requirements clear
- [ ] Default settings documented
- [ ] API authentication method documented
- [ ] Known limitations documented

---

## 📝 **EXCHANGE-SPECIFIC NOTES**

### Authentication Types
- **VALR**: HMAC-SHA512 (X-VALR-SIGNATURE, X-VALR-TIMESTAMP, X-VALR-API-KEY)
- **Luno**: Basic Auth (apiKey:apiSecret base64)
- **Binance**: HMAC-SHA256 (X-MBX-APIKEY)
- **Kraken**: Kraken-specific (API-Key + API-Sign)
- **OKX**: HMAC-SHA256 + Passphrase
- **Gemini**: HMAC-SHA384 (X-GEMINI-PAYLOAD, X-GEMINI-SIGNATURE)
- **KuCoin**: HMAC-SHA256 + Passphrase
- **Gate.io**: HMAC-SHA512
- **Crypto.com**: HMAC-SHA256
- **MEXC**: HMAC-SHA256
- **HTX (Huobi)**: HMAC-SHA256

### Pair Format Examples
- **VALR**: `BTCZAR`, `ETHUSDT`
- **Luno**: `XBTZAR` (uses XBT instead of BTC)
- **Binance**: `BTCUSDT`
- **Gemini**: `btcusdt` (lowercase)
- **KuCoin**: `BTC-USDT` (with hyphen)
- **Coincatch**: `BTCUSDT_SPBL` (with suffix)

---

## 🎓 **USAGE INSTRUCTIONS**

1. **Use this checklist for each exchange implementation**
2. **Check off items as you implement/verify them**
3. **All items must be checked before exchange goes live**
4. **Review checklist during code review**
5. **Update checklist if new requirements discovered**

---

**Last Updated**: 2025-01-23
**Master Reference**: VALR Triangular Arbitrage Implementation
**Target**: Production-ready multi-user trading platform with real money
