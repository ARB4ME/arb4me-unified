# ARB4ME - 3% Profit Billing Implementation Plan
## Created: 2026-08-06

---

## BILLING MODEL SUMMARY

| Setting | Value |
|---------|-------|
| Fee | **3% of profit** |
| Billing Cycle | **User's signup anniversary** (monthly from join date) |
| Grace Period | **None** - due immediately |
| Minimum Fee | **Only if in profit** (any amount > $0) |
| Payment Method | **USDT only** |
| Non-Payment | **No trading until paid** |

---

## HOW IT WORKS

```
User signs up: January 15, 2026
    |
Billing period 1: Jan 15 - Feb 14
    |
Feb 15: System calculates profit for that period
    |
If profit = $500 --> Invoice: $15 (3%)
If profit = $0 or loss --> No invoice, trading continues
    |
User must pay $15 USDT to continue trading
    |
Once paid --> Trading unlocked for next period
```

---

## EXISTING CODE (REUSABLE)

### Frontend (index.html) - Already Built:
- billingState.serviceFeePercentage: 0.03 (3%)
- updateBillingDashboard() - calculates and displays fees
- checkMonthlyPaymentStatus() - handles "no profit = no fee"
- executeUSDTPaymentToAdmin() - USDT payment flow
- renderUserBillingCards() - admin billing display
- suspendUserTrading() / reactivateUserTrading()

### Backend - Already Built:
- trading_activity.profit_loss_total - cumulative profit tracking
- POST /api/v1/trading/trades - records trades with profit
- user_activity table - detailed trade logs with profit data
- users.payment_reference - unique ARB-XXXXXX per user

---

## IMPLEMENTATION PHASES

### PHASE 1: BACKEND CHANGES

#### 1.1 Create billing_invoices table
```sql
CREATE TABLE billing_invoices (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    billing_period_start DATE NOT NULL,
    billing_period_end DATE NOT NULL,
    total_profit DECIMAL(15,2) NOT NULL,
    fee_percentage DECIMAL(5,4) DEFAULT 0.03,
    fee_amount DECIMAL(15,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'unpaid',
    payment_tx_hash VARCHAR(100),
    payment_date TIMESTAMP,
    payment_network VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, billing_period_start)
);
```

#### 1.2 Add billing endpoints to billing.routes.js

| Endpoint | Purpose |
|----------|---------|
| GET /api/v1/billing/my-invoice | User's current/latest invoice |
| GET /api/v1/billing/my-history | User's invoice history |
| GET /api/v1/billing/profit-summary | User's current period profit |
| POST /api/v1/admin/billing/generate-invoice/:userId | Generate invoice for user |
| POST /api/v1/admin/billing/mark-paid/:invoiceId | Mark invoice as paid |
| GET /api/v1/admin/billing/pending-invoices | All unpaid invoices |

#### 1.3 Add profit calculation function
- Calculate profit from user_activity logs
- Use user's created_at for anniversary billing period
- Only count completed trades

#### 1.4 Add trading gate middleware
- Check if user has unpaid invoice before trade execution
- Return error if unpaid: "Please pay outstanding invoice to continue trading"

---

### PHASE 2: FRONTEND CHANGES (User Side)

#### 2.1 Update calculateUserMonthlyProfit()
- Change from mock data to API call: GET /api/v1/billing/profit-summary

#### 2.2 Update billing cycle logic
- Change from calendar month to user anniversary date
- Use user.created_at from userData

#### 2.3 Add USDT address placeholder
- billingState.adminUSDTAddress = 'YOUR_USDT_ADDRESS_HERE'
- billingState.adminUSDTNetwork = 'TRC20'

#### 2.4 Update trading blocked UI
- Show clear message when invoice unpaid
- Display invoice amount and pay button

#### 2.5 Remove subscription expiry logic
- Remove subscription_expires_at checks
- Remove subscription warning banners
- Remove grace period logic

---

### PHASE 3: ADMIN DASHBOARD CHANGES

#### 3.1 Update refreshAdminBillingData()
- Call backend for real user profits instead of mock
- Display invoice status per user

#### 3.2 Add Generate Invoice button
- Trigger invoice creation for due billing periods

#### 3.3 Update Mark as Paid flow
- Call backend to mark invoice paid with tx hash

---

### PHASE 4: UI TEXT REVIEW

#### 4.1 Review all user-facing billing text
- Payment instructions
- Invoice displays
- Error messages
- Trading blocked messages

#### 4.2 Update messaging to reflect profit-based model
- Remove subscription terminology
- Add invoice/profit terminology

#### 4.3 Update admin-facing text
- Billing tab labels
- User status displays

---

## BACKUP INFO

**Physical Backup:**
C:\Users\Jonathan\OneDrive\Documents\Work\JONO WORK\AIM Arbitrage\2023\IDATCO\ARB4ME\BACKUP_2026-08-06_before_profit_billing\

**Git Backup Branch:**
backup-before-profit-billing-2026-08-06

**Restore Command:**
```
git checkout backup-before-profit-billing-2026-08-06
```

---

## USDT ADDRESS

**Status:** Placeholder - Jonathan to provide
**Address:** YOUR_USDT_ADDRESS_HERE
**Network:** TRC20 (recommended - lowest fees)

---

## FILES TO MODIFY

| File | Changes |
|------|---------|
| src/routes/billing.routes.js | Add new endpoints |
| src/database/migrations/012_profit_billing.sql | New invoice table |
| src/middleware/tradingGate.js | New file - check invoice before trading |
| public/index.html | Wire frontend to backend, update logic |

---

## TESTING CHECKLIST

- [ ] User with profit sees correct invoice amount
- [ ] User with no profit sees no invoice
- [ ] User with loss sees no invoice
- [ ] Unpaid invoice blocks trading
- [ ] USDT payment records correctly
- [ ] Admin can generate invoices
- [ ] Admin can mark invoices paid
- [ ] Trading unlocks after payment
- [ ] Anniversary billing period calculates correctly
