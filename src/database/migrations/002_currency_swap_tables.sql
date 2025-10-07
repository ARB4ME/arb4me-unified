-- Currency Swap Tables Migration
-- Creates tables for Currency Swap strategy

-- Currency Swaps table
CREATE TABLE IF NOT EXISTS currency_swaps (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    category VARCHAR(20) CHECK (category IN ('ZAR', 'INTERNATIONAL')),

    -- Swap Details
    from_currency VARCHAR(10) NOT NULL,
    to_currency VARCHAR(10) NOT NULL,
    bridge_currency VARCHAR(10) NOT NULL,
    amount DECIMAL(20, 8) NOT NULL,

    -- Route (stored as JSONB)
    route JSONB NOT NULL,

    -- Financial Results
    effective_rate DECIMAL(20, 8),
    wise_rate DECIMAL(20, 8),
    savings_percent DECIMAL(10, 4),
    net_profit DECIMAL(10, 4),
    threshold_used DECIMAL(10, 4),
    total_fees JSONB,

    -- Execution Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'calculating', 'executing', 'completed', 'failed')),
    execution_time INTEGER,
    tx_hashes TEXT[],
    error_message TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    executed_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_currency_swaps_user_id ON currency_swaps(user_id);
CREATE INDEX IF NOT EXISTS idx_currency_swaps_status ON currency_swaps(status);
CREATE INDEX IF NOT EXISTS idx_currency_swaps_category ON currency_swaps(category);
CREATE INDEX IF NOT EXISTS idx_currency_swaps_created_at ON currency_swaps(created_at DESC);

-- Currency Swap Settings table
CREATE TABLE IF NOT EXISTS currency_swap_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE,
    strategy VARCHAR(50) DEFAULT 'currency-swap',

    -- Risk Settings
    auto_trading_enabled BOOLEAN DEFAULT false,
    threshold_percent DECIMAL(5, 2) DEFAULT 0.5 CHECK (threshold_percent >= 0.1 AND threshold_percent <= 10),
    max_trade_amount_usdt DECIMAL(20, 2) DEFAULT 5000 CHECK (max_trade_amount_usdt >= 100 AND max_trade_amount_usdt <= 100000),
    max_daily_swaps INTEGER DEFAULT 10 CHECK (max_daily_swaps >= 1 AND max_daily_swaps <= 100),

    -- Bridge Preferences
    preferred_bridge VARCHAR(10) DEFAULT 'AUTO' CHECK (preferred_bridge IN ('XRP', 'USDT', 'AUTO')),

    -- Categories
    enabled_categories JSONB DEFAULT '{"ZAR": true, "INTERNATIONAL": false}',

    -- Allowed Fiat Pairs
    allowed_pairs TEXT[] DEFAULT ARRAY['ZAR-USDT', 'ZAR-USD'],

    -- Exchange Preferences
    exchange_preferences JSONB DEFAULT '{"ZAR": ["VALR", "Luno", "ChainEX"], "USD": ["Kraken", "Bybit", "OKX"], "EUR": ["Kraken", "Gate", "OKX"], "GBP": ["Kraken", "Gate", "OKX"]}',

    -- Separate Credentials
    use_separate_credentials BOOLEAN DEFAULT false,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_currency_swap_settings_user_id ON currency_swap_settings(user_id);
