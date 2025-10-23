-- Currency Swap Enhancements Migration
-- Adds 3 new tables + enhances existing settings table for improved currency swap functionality
-- Created: 2025-10-23

-- ═══════════════════════════════════════════════════════════════════════
-- TABLE 1: Asset Declarations
-- Users declare which assets they have funded on each exchange
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS currency_swap_asset_declarations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    exchange VARCHAR(50) NOT NULL,

    -- Which assets user has funded on this exchange
    -- Example: ["ZAR", "USDT", "USD", "EUR"]
    funded_assets JSONB NOT NULL DEFAULT '[]',

    -- Optional: Initial balances for tracking profit
    -- Example: {"ZAR": 100000, "USDT": 5000, "USD": 3000}
    initial_balances JSONB DEFAULT '{}',

    -- Status
    is_active BOOLEAN DEFAULT true,
    last_updated TIMESTAMP DEFAULT NOW(),

    -- Notes (optional user notes about this exchange)
    notes TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    -- One declaration per user per exchange
    CONSTRAINT unique_user_exchange_declaration UNIQUE(user_id, exchange)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_asset_declarations_user_id ON currency_swap_asset_declarations(user_id);
CREATE INDEX IF NOT EXISTS idx_asset_declarations_exchange ON currency_swap_asset_declarations(exchange);
CREATE INDEX IF NOT EXISTS idx_asset_declarations_active ON currency_swap_asset_declarations(is_active);

-- Comment for documentation
COMMENT ON TABLE currency_swap_asset_declarations IS 'User declares which fiat/stablecoins they have funded on each exchange for currency swap strategy';
COMMENT ON COLUMN currency_swap_asset_declarations.funded_assets IS 'Array of asset codes user has deposited (e.g., ["ZAR", "USDT", "USD"])';


-- ═══════════════════════════════════════════════════════════════════════
-- TABLE 2: Balance Tracking
-- Real-time balance tracking for risk management and profit calculation
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS currency_swap_balances (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    exchange VARCHAR(50) NOT NULL,
    asset VARCHAR(10) NOT NULL,

    -- Balance amounts (in asset's native units)
    available_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
    locked_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
    total_balance DECIMAL(20, 8) GENERATED ALWAYS AS (available_balance + locked_balance) STORED,

    -- Sync tracking
    last_synced_at TIMESTAMP DEFAULT NOW(),
    sync_source VARCHAR(20) DEFAULT 'api', -- 'api', 'manual', 'calculated'
    sync_error TEXT, -- Store last sync error if any

    -- Profit tracking
    initial_balance DECIMAL(20, 8), -- Starting balance when user declared
    total_profit DECIMAL(20, 8) DEFAULT 0, -- Profit gained in this asset
    profit_percent DECIMAL(10, 4) DEFAULT 0, -- % profit

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    -- One balance record per user per exchange per asset
    CONSTRAINT unique_user_exchange_asset UNIQUE(user_id, exchange, asset)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_balances_user_exchange ON currency_swap_balances(user_id, exchange);
CREATE INDEX IF NOT EXISTS idx_balances_user_asset ON currency_swap_balances(user_id, asset);
CREATE INDEX IF NOT EXISTS idx_balances_asset ON currency_swap_balances(asset);
CREATE INDEX IF NOT EXISTS idx_balances_synced ON currency_swap_balances(last_synced_at);
CREATE INDEX IF NOT EXISTS idx_balances_updated ON currency_swap_balances(updated_at DESC);

-- Comment for documentation
COMMENT ON TABLE currency_swap_balances IS 'Real-time balance tracking across all exchanges for risk management';
COMMENT ON COLUMN currency_swap_balances.available_balance IS 'Balance available for trading (not locked in orders)';
COMMENT ON COLUMN currency_swap_balances.locked_balance IS 'Balance locked in pending orders or transfers';


-- ═══════════════════════════════════════════════════════════════════════
-- TABLE 3: Execution Queue
-- Tracks in-progress swaps to prevent conflicts and enable recovery
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS currency_swap_execution_queue (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    swap_id INTEGER, -- Links to currency_swaps table (nullable until created)

    -- Path details
    from_exchange VARCHAR(50) NOT NULL,
    from_asset VARCHAR(10) NOT NULL,
    to_exchange VARCHAR(50) NOT NULL,
    to_asset VARCHAR(10) NOT NULL,
    bridge_asset VARCHAR(10) DEFAULT 'XRP',

    -- Execution details
    trade_amount DECIMAL(20, 8) NOT NULL,
    expected_profit_percent DECIMAL(10, 4) NOT NULL,

    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'cancelled')),
    current_leg INTEGER DEFAULT 0, -- Which leg we're on (0=not started, 1=buy, 2=transfer, 3=sell)

    -- Leg execution tracking (JSONB for flexibility)
    leg_results JSONB DEFAULT '[]',
    -- Example: [
    --   {"leg": 1, "action": "buy", "amount": 1000, "price": 0.54, "txId": "abc123"},
    --   {"leg": 2, "action": "transfer", "txHash": "def456", "confirmations": 5},
    --   {"leg": 3, "action": "sell", "amount": 999, "price": 0.55, "txId": "ghi789"}
    -- ]

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,

    -- Error handling
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 2,

    -- Lock mechanism (prevent concurrent execution of same resources)
    locked_at TIMESTAMP,
    locked_by VARCHAR(100) -- Process ID or worker ID
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_queue_user_id ON currency_swap_execution_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON currency_swap_execution_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_user_status ON currency_swap_execution_queue(user_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_created ON currency_swap_execution_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_from_exchange_asset ON currency_swap_execution_queue(from_exchange, from_asset);

-- Comment for documentation
COMMENT ON TABLE currency_swap_execution_queue IS 'Tracks in-progress currency swaps to prevent conflicts and enable recovery from failures';
COMMENT ON COLUMN currency_swap_execution_queue.current_leg IS '0=not started, 1=buying bridge, 2=transferring, 3=selling bridge';
COMMENT ON COLUMN currency_swap_execution_queue.leg_results IS 'Array of completed leg results with transaction IDs and amounts';


-- ═══════════════════════════════════════════════════════════════════════
-- ENHANCE EXISTING: currency_swap_settings table
-- Add new fields for improved risk management
-- ═══════════════════════════════════════════════════════════════════════

-- Add new columns if they don't exist
ALTER TABLE currency_swap_settings
ADD COLUMN IF NOT EXISTS max_concurrent_trades INTEGER DEFAULT 2 CHECK (max_concurrent_trades >= 1 AND max_concurrent_trades <= 5),
ADD COLUMN IF NOT EXISTS max_balance_percentage DECIMAL(5,2) DEFAULT 10.0 CHECK (max_balance_percentage > 0 AND max_balance_percentage <= 50),
ADD COLUMN IF NOT EXISTS scan_interval_seconds INTEGER DEFAULT 60 CHECK (scan_interval_seconds >= 30 AND scan_interval_seconds <= 300),
ADD COLUMN IF NOT EXISTS balance_check_required BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS min_balance_reserve_percent DECIMAL(5,2) DEFAULT 5.0 CHECK (min_balance_reserve_percent >= 0 AND min_balance_reserve_percent <= 20);

-- Add comments for new fields
COMMENT ON COLUMN currency_swap_settings.max_concurrent_trades IS 'Maximum number of swaps to execute simultaneously (1-5)';
COMMENT ON COLUMN currency_swap_settings.max_balance_percentage IS 'Maximum % of balance to use per trade (prevents over-trading)';
COMMENT ON COLUMN currency_swap_settings.scan_interval_seconds IS 'How often to scan for opportunities in auto-trading mode';
COMMENT ON COLUMN currency_swap_settings.balance_check_required IS 'Whether to check balances before each trade';
COMMENT ON COLUMN currency_swap_settings.min_balance_reserve_percent IS 'Minimum % of balance to keep as reserve (safety buffer)';


-- ═══════════════════════════════════════════════════════════════════════
-- UPDATE: currency_swap_credentials table
-- Ensure deposit_addresses column exists (should exist from previous migration)
-- ═══════════════════════════════════════════════════════════════════════

-- Verify deposit_addresses column exists (safe to run multiple times)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'currency_swap_credentials'
        AND column_name = 'deposit_addresses'
    ) THEN
        ALTER TABLE currency_swap_credentials
        ADD COLUMN deposit_addresses JSONB DEFAULT '{}';

        COMMENT ON COLUMN currency_swap_credentials.deposit_addresses IS 'XRP deposit address and tag for receiving transfers (e.g., {"XRP": "rXXXX", "XRP_TAG": "12345"})';
    END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS (Optional - for convenience)
-- ═══════════════════════════════════════════════════════════════════════

-- Function to get user's total balance in USDT equivalent
-- (Can be used for dashboard stats)
CREATE OR REPLACE FUNCTION get_total_balance_usdt(p_user_id INTEGER)
RETURNS DECIMAL(20, 2) AS $$
DECLARE
    total DECIMAL(20, 2);
BEGIN
    -- This is a placeholder - actual implementation would need price conversion
    -- For now, just sum USDT balances
    SELECT COALESCE(SUM(total_balance), 0)
    INTO total
    FROM currency_swap_balances
    WHERE user_id = p_user_id AND asset = 'USDT';

    RETURN total;
END;
$$ LANGUAGE plpgsql;

-- Function to check if user has pending swaps
CREATE OR REPLACE FUNCTION has_pending_swaps(p_user_id INTEGER)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM currency_swap_execution_queue
        WHERE user_id = p_user_id
        AND status IN ('pending', 'executing')
    );
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (Run these after migration to verify)
-- ═══════════════════════════════════════════════════════════════════════

-- Uncomment to verify tables were created:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name LIKE 'currency_swap%'
-- ORDER BY table_name;

-- Uncomment to verify new columns in settings:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'currency_swap_settings'
-- ORDER BY ordinal_position;
