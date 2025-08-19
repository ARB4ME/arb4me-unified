-- Phase 7: Trading Activity Tracking
-- This migration creates the trading_activity table for tracking user trading status

-- Create trading_activity table if not exists
CREATE TABLE IF NOT EXISTS trading_activity (
    user_id VARCHAR(50) PRIMARY KEY,
    exchanges_connected TEXT DEFAULT '[]',
    exchanges_connected_count INTEGER DEFAULT 0,
    selected_crypto_assets TEXT DEFAULT '[]',
    trading_active BOOLEAN DEFAULT FALSE,
    auto_trading_enabled BOOLEAN DEFAULT FALSE,
    total_trades_count INTEGER DEFAULT 0,
    successful_trades_count INTEGER DEFAULT 0,
    failed_trades_count INTEGER DEFAULT 0,
    profit_loss_total DECIMAL(15,2) DEFAULT 0,
    api_keys_configured BOOLEAN DEFAULT FALSE,
    usdt_balance_detected BOOLEAN DEFAULT FALSE,
    safety_controls_completed BOOLEAN DEFAULT FALSE,
    auto_trading_readiness_percent INTEGER DEFAULT 0,
    last_trading_activity TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_trading_active ON trading_activity(trading_active);
CREATE INDEX IF NOT EXISTS idx_last_activity ON trading_activity(last_trading_activity);
CREATE INDEX IF NOT EXISTS idx_auto_trading ON trading_activity(auto_trading_enabled);

-- Initialize trading_activity for existing users
INSERT INTO trading_activity (user_id)
SELECT id FROM users
WHERE NOT EXISTS (
    SELECT 1 FROM trading_activity WHERE trading_activity.user_id = users.id
);

-- Create function to auto-create trading_activity record when user is created
CREATE OR REPLACE FUNCTION create_trading_activity_for_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO trading_activity (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-create trading_activity for new users
DROP TRIGGER IF EXISTS create_trading_activity_trigger ON users;
CREATE TRIGGER create_trading_activity_trigger
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION create_trading_activity_for_user();