# Currency Swap API Endpoints - Testing Reference

This document lists all NEW Currency Swap API endpoints built with the modular backend-first approach.

**Base URL**: `/api/v1/currency-swap`

---

## 1. ASSET DECLARATION ENDPOINTS

Users declare which assets (fiat/stablecoins) they have funded on each exchange.

### POST /asset-declarations
Save user's asset declaration for an exchange.

**Request Body**:
```json
{
  "userId": 1,
  "exchange": "VALR",
  "fundedAssets": ["ZAR", "USDT", "USD"],
  "initialBalances": {
    "ZAR": 100000,
    "USDT": 5000,
    "USD": 3000
  }
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "declaration": { ... },
    "message": "Successfully declared 3 asset(s) on VALR"
  }
}
```

---

### GET /asset-declarations
Get all asset declarations for a user.

**Query Parameters**:
- `userId` (default: 1)
- `activeOnly` (default: true)

**Response**:
```json
{
  "success": true,
  "data": {
    "declarations": [
      {
        "id": 1,
        "userId": 1,
        "exchange": "VALR",
        "fundedAssets": ["ZAR", "USDT"],
        "initialBalances": { "ZAR": 100000, "USDT": 5000 },
        "isActive": true
      }
    ],
    "count": 1
  }
}
```

---

### GET /asset-declarations/summary
Get summary of user's asset declarations.

**Query Parameters**:
- `userId` (default: 1)

**Response**:
```json
{
  "success": true,
  "data": {
    "totalExchanges": 3,
    "exchanges": ["VALR", "Kraken", "Bybit"],
    "totalUniqueAssets": 5,
    "uniqueAssets": ["ZAR", "USDT", "USD", "EUR", "GBP"],
    "assetsByExchange": {
      "VALR": ["ZAR", "USDT"],
      "Kraken": ["USD", "EUR", "USDT"],
      "Bybit": ["USDT", "GBP"]
    }
  }
}
```

---

### DELETE /asset-declarations/:exchange
Delete asset declaration for an exchange.

**URL Parameters**:
- `exchange`: Exchange name (e.g., "VALR")

**Query Parameters**:
- `userId` (default: 1)

**Response**:
```json
{
  "success": true,
  "message": "Successfully removed declaration for VALR"
}
```

---

## 2. PATH GENERATION ENDPOINTS

Auto-generate ALL possible swap paths from user's declared assets.

### GET /paths
Get all possible swap paths for a user (with optional filters).

**Query Parameters**:
- `userId` (default: 1)
- `sourceExchange` (optional filter)
- `destExchange` (optional filter)
- `sourceAsset` (optional filter)
- `destAsset` (optional filter)
- `bridgeAsset` (optional filter)

**Example**: `/paths?userId=1&sourceAsset=ZAR`

**Response**:
```json
{
  "success": true,
  "data": {
    "paths": [
      {
        "id": "VALR-ZAR-Kraken-USD",
        "sourceExchange": "VALR",
        "sourceAsset": "ZAR",
        "destExchange": "Kraken",
        "destAsset": "USD",
        "bridgeAsset": "XRP",
        "description": "ZAR on VALR → USD on Kraken via XRP",
        "legs": [
          {
            "leg": 1,
            "action": "buy",
            "exchange": "VALR",
            "pair": "XRP/ZAR",
            "side": "buy"
          },
          {
            "leg": 2,
            "action": "transfer",
            "fromExchange": "VALR",
            "toExchange": "Kraken",
            "asset": "XRP"
          },
          {
            "leg": 3,
            "action": "sell",
            "exchange": "Kraken",
            "pair": "XRP/USD",
            "side": "sell"
          }
        ]
      }
    ],
    "count": 12
  }
}
```

---

### GET /paths/stats
Get path statistics for user.

**Query Parameters**:
- `userId` (default: 1)

**Response**:
```json
{
  "success": true,
  "data": {
    "totalPaths": 24,
    "totalExchanges": 3,
    "totalAssets": 5,
    "bySourceExchange": {
      "VALR": 8,
      "Kraken": 10,
      "Bybit": 6
    },
    "byDestExchange": {
      "VALR": 8,
      "Kraken": 10,
      "Bybit": 6
    },
    "byAssetPair": {
      "ZAR-USD": 4,
      "ZAR-USDT": 2,
      "USD-ZAR": 4
    }
  }
}
```

---

### GET /paths/grouped
Get paths grouped by exchange pair.

**Query Parameters**:
- `userId` (default: 1)

**Response**:
```json
{
  "success": true,
  "data": {
    "VALR-Kraken": {
      "sourceExchange": "VALR",
      "destExchange": "Kraken",
      "paths": [ ... ]
    },
    "Kraken-Bybit": {
      "sourceExchange": "Kraken",
      "destExchange": "Bybit",
      "paths": [ ... ]
    }
  }
}
```

---

### POST /paths/validate
Validate a specific path.

**Request Body**:
```json
{
  "userId": 1,
  "pathId": "VALR-ZAR-Kraken-USD"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "valid": true,
    "path": { ... }
  }
}
```

---

## 3. RISK ASSESSMENT ENDPOINTS

Calculate safe trade amounts and assess risk.

### POST /risk-assessment
Assess risk for a specific swap path.

**Request Body**:
```json
{
  "userId": 1,
  "path": {
    "id": "VALR-ZAR-Kraken-USD",
    "sourceExchange": "VALR",
    "sourceAsset": "ZAR",
    "destExchange": "Kraken",
    "destAsset": "USD"
  },
  "prices": {
    "XRP/ZAR": 10.5,
    "XRP/USD": 0.55
  }
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "canProceed": true,
    "tradeAmount": {
      "canTrade": true,
      "recommendedAmount": 10000,
      "maxByBalance": 95000,
      "maxByPercentage": 10000,
      "maxByUSDTLimit": 95000,
      "reserveAmount": 5000,
      "constraint": "percentage"
    },
    "dailyLimit": {
      "canExecute": true,
      "dailyCount": 3,
      "maxDaily": 10,
      "remaining": 7
    },
    "concurrentLimit": {
      "canExecute": true,
      "currentlyExecuting": 0,
      "maxConcurrent": 2,
      "remaining": 2
    },
    "risks": []
  }
}
```

---

### POST /calculate-trade-amount
Calculate recommended trade amount for a swap.

**Request Body**:
```json
{
  "userId": 1,
  "sourceExchange": "VALR",
  "sourceAsset": "ZAR",
  "prices": {
    "ZAR/USDT": 0.053
  }
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "canTrade": true,
    "recommendedAmount": 10000,
    "maxByBalance": 95000,
    "maxByPercentage": 10000,
    "maxByUSDTLimit": 95000,
    "reserveAmount": 5000,
    "availableBalance": 100000,
    "constraint": "percentage",
    "settings": {
      "maxBalancePercentage": 10,
      "maxTradeAmountUSDT": 5000,
      "minReservePercent": 5
    }
  }
}
```

---

### GET /daily-limit-check
Check if user can execute more swaps today.

**Query Parameters**:
- `userId` (default: 1)

**Response**:
```json
{
  "success": true,
  "data": {
    "canExecute": true,
    "dailyCount": 5,
    "maxDaily": 10,
    "remaining": 5
  }
}
```

---

## Testing Flow (Recommended Order)

1. **Declare Assets** - POST /asset-declarations for 2-3 exchanges
2. **View Declarations** - GET /asset-declarations/summary to confirm
3. **Generate Paths** - GET /paths to see all auto-generated swap opportunities
4. **Check Statistics** - GET /paths/stats to see breakdown
5. **Calculate Trade Amount** - POST /calculate-trade-amount for a specific asset
6. **Assess Risk** - POST /risk-assessment for a specific path
7. **Check Limits** - GET /daily-limit-check to verify execution permissions

---

## Example cURL Commands

### 1. Declare Assets
```bash
curl -X POST http://localhost:3000/api/v1/currency-swap/asset-declarations \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "exchange": "VALR",
    "fundedAssets": ["ZAR", "USDT"],
    "initialBalances": {"ZAR": 100000, "USDT": 5000}
  }'
```

### 2. Get All Paths
```bash
curl http://localhost:3000/api/v1/currency-swap/paths?userId=1
```

### 3. Get Path Statistics
```bash
curl http://localhost:3000/api/v1/currency-swap/paths/stats?userId=1
```

### 4. Calculate Trade Amount
```bash
curl -X POST http://localhost:3000/api/v1/currency-swap/calculate-trade-amount \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "sourceExchange": "VALR",
    "sourceAsset": "ZAR"
  }'
```

---

## Notes

- All endpoints default to `userId: 1` when not specified (for testing)
- In production, userId should come from auth middleware
- The backend is fully functional and ready for testing
- Frontend integration will come in STEP 6
