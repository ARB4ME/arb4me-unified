-- Migration 007: Add Triangular Trade History Table
-- PostgreSQL migration for VALR triangular arbitrage trading history
-- Created for Task 12: Create triangular trade history database table

-- TRIANGULAR_TRADES TABLE
CREATE TABLE IF NOT EXISTS triangular_trades (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    
    -- Trade identification
    trade_id VARCHAR(100) UNIQUE NOT NULL DEFAULT 'TRI_' || EXTRACT(EPOCH FROM NOW())::TEXT || '_' || LPAD((RANDOM() * 999999)::INT::TEXT, 6, '0'),
    exchange VARCHAR(20) NOT NULL DEFAULT 'VALR',
    path_id VARCHAR(50) NOT NULL,
    path_sequence TEXT NOT NULL,
    
    -- Opportunity details
    opportunity_data JSONB NOT NULL,
    initial_amount DECIMAL(15,8) NOT NULL,
    currency_start VARCHAR(10) NOT NULL DEFAULT 'ZAR',
    
    -- Trade execution details
    execution_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (execution_status IN ('pending', 'executing', 'completed', 'failed', 'rolled_back')),
    execution_type VARCHAR(20) NOT NULL DEFAULT 'atomic' CHECK (execution_type IN ('atomic', 'manual', 'test')),
    dry_run BOOLEAN DEFAULT FALSE,
    
    -- Individual leg results
    leg1_order_id VARCHAR(100),
    leg1_pair VARCHAR(20),
    leg1_side VARCHAR(10),
    leg1_amount DECIMAL(15,8),
    leg1_price DECIMAL(15,8),
    leg1_fee DECIMAL(15,8),
    leg1_status VARCHAR(20),
    leg1_executed_at TIMESTAMP,
    
    leg2_order_id VARCHAR(100),
    leg2_pair VARCHAR(20),
    leg2_side VARCHAR(10),
    leg2_amount DECIMAL(15,8),
    leg2_price DECIMAL(15,8),
    leg2_fee DECIMAL(15,8),
    leg2_status VARCHAR(20),
    leg2_executed_at TIMESTAMP,
    
    leg3_order_id VARCHAR(100),
    leg3_pair VARCHAR(20),
    leg3_side VARCHAR(10),
    leg3_amount DECIMAL(15,8),
    leg3_price DECIMAL(15,8),
    leg3_fee DECIMAL(15,8),
    leg3_status VARCHAR(20),
    leg3_executed_at TIMESTAMP,
    
    -- Financial results
    expected_profit_zar DECIMAL(15,2),
    expected_profit_percent DECIMAL(8,4),
    actual_profit_zar DECIMAL(15,2),
    actual_profit_percent DECIMAL(8,4),
    total_fees_paid DECIMAL(15,8),
    slippage_percent DECIMAL(8,4),
    
    -- Execution timing
    scan_started_at TIMESTAMP,
    execution_started_at TIMESTAMP,
    execution_completed_at TIMESTAMP,
    total_execution_time_ms INTEGER,
    
    -- Risk assessment
    risk_assessment VARCHAR(20) CHECK (risk_assessment IN ('EXECUTE', 'CAUTIOUS', 'AVOID')),
    max_slippage_allowed DECIMAL(8,4) DEFAULT 0.5,
    actual_slippage DECIMAL(8,4),
    
    -- Error handling
    error_message TEXT,
    rollback_reason TEXT,
    rollback_completed_at TIMESTAMP,
    
    -- Market conditions snapshot
    market_snapshot JSONB,
    order_book_snapshot JSONB,
    
    -- Metadata
    user_agent TEXT,
    ip_address INET,
    api_version VARCHAR(20) DEFAULT 'v1',
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_triangular_trades_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_triangular_trades_user_id ON triangular_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_exchange ON triangular_trades(exchange);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_path_id ON triangular_trades(path_id);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_status ON triangular_trades(execution_status);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_created_at ON triangular_trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_execution_time ON triangular_trades(execution_started_at, execution_completed_at);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_profit ON triangular_trades(actual_profit_zar DESC);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_user_profit ON triangular_trades(user_id, actual_profit_zar DESC);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_daily_stats ON triangular_trades(user_id, DATE(created_at));

-- COMPOSITE INDEXES FOR COMMON QUERIES
CREATE INDEX IF NOT EXISTS idx_triangular_trades_user_status_date ON triangular_trades(user_id, execution_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triangular_trades_exchange_status_date ON triangular_trades(exchange, execution_status, created_at DESC);

-- Update function for updated_at timestamp
CREATE OR REPLACE FUNCTION update_triangular_trades_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER trigger_update_triangular_trades_timestamp
    BEFORE UPDATE ON triangular_trades
    FOR EACH ROW
    EXECUTE FUNCTION update_triangular_trades_timestamp();

-- VIEWS FOR COMMON QUERIES

-- Daily trading stats view
CREATE OR REPLACE VIEW triangular_daily_stats AS
SELECT 
    user_id,
    exchange,
    DATE(created_at) as trade_date,
    COUNT(*) as total_trades,
    COUNT(*) FILTER (WHERE execution_status = 'completed') as successful_trades,
    COUNT(*) FILTER (WHERE execution_status = 'failed') as failed_trades,
    COALESCE(SUM(actual_profit_zar) FILTER (WHERE execution_status = 'completed'), 0) as total_profit_zar,
    COALESCE(AVG(actual_profit_percent) FILTER (WHERE execution_status = 'completed'), 0) as avg_profit_percent,
    COALESCE(MAX(actual_profit_zar) FILTER (WHERE execution_status = 'completed'), 0) as best_trade_profit,
    COALESCE(AVG(total_execution_time_ms) FILTER (WHERE execution_status = 'completed'), 0) as avg_execution_time_ms,
    COALESCE(SUM(total_fees_paid) FILTER (WHERE execution_status = 'completed'), 0) as total_fees_paid
FROM triangular_trades 
GROUP BY user_id, exchange, DATE(created_at);

-- Top performing paths view
CREATE OR REPLACE VIEW triangular_top_paths AS
SELECT 
    path_id,
    path_sequence,
    exchange,
    COUNT(*) as trade_count,
    COUNT(*) FILTER (WHERE execution_status = 'completed') as successful_count,
    ROUND(COUNT(*) FILTER (WHERE execution_status = 'completed') * 100.0 / COUNT(*), 2) as success_rate_percent,
    COALESCE(SUM(actual_profit_zar) FILTER (WHERE execution_status = 'completed'), 0) as total_profit_zar,
    COALESCE(AVG(actual_profit_percent) FILTER (WHERE execution_status = 'completed'), 0) as avg_profit_percent,
    COALESCE(AVG(total_execution_time_ms) FILTER (WHERE execution_status = 'completed'), 0) as avg_execution_time_ms
FROM triangular_trades 
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY path_id, path_sequence, exchange
HAVING COUNT(*) >= 5
ORDER BY total_profit_zar DESC;

-- Recent trades view (for feeds)
CREATE OR REPLACE VIEW triangular_recent_trades AS
SELECT 
    t.id,
    t.trade_id,
    t.user_id,
    u.first_name || ' ' || u.last_name as user_name,
    t.exchange,
    t.path_id,
    t.path_sequence,
    t.execution_status,
    t.actual_profit_zar,
    t.actual_profit_percent,
    t.total_execution_time_ms,
    t.created_at,
    t.execution_completed_at
FROM triangular_trades t
JOIN users u ON t.user_id = u.id
WHERE t.created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
ORDER BY t.created_at DESC
LIMIT 100;

-- User trading summary view
CREATE OR REPLACE VIEW triangular_user_summary AS
SELECT 
    t.user_id,
    u.first_name || ' ' || u.last_name as user_name,
    COUNT(*) as total_trades,
    COUNT(*) FILTER (WHERE execution_status = 'completed') as successful_trades,
    COUNT(*) FILTER (WHERE execution_status = 'failed') as failed_trades,
    ROUND(COUNT(*) FILTER (WHERE execution_status = 'completed') * 100.0 / COUNT(*), 2) as success_rate_percent,
    COALESCE(SUM(actual_profit_zar) FILTER (WHERE execution_status = 'completed'), 0) as total_profit_zar,
    COALESCE(AVG(actual_profit_percent) FILTER (WHERE execution_status = 'completed'), 0) as avg_profit_percent,
    COALESCE(MAX(actual_profit_zar) FILTER (WHERE execution_status = 'completed'), 0) as best_trade_profit,
    MIN(created_at) as first_trade_date,
    MAX(created_at) as last_trade_date
FROM triangular_trades t
JOIN users u ON t.user_id = u.id
GROUP BY t.user_id, u.first_name, u.last_name;

-- Comment documenting the migration
COMMENT ON TABLE triangular_trades IS 'Triangular arbitrage trade history and execution tracking for VALR and other exchanges';
COMMENT ON COLUMN triangular_trades.opportunity_data IS 'JSON snapshot of the arbitrage opportunity including prices, spreads, and calculations';
COMMENT ON COLUMN triangular_trades.market_snapshot IS 'JSON snapshot of market conditions at execution time';
COMMENT ON COLUMN triangular_trades.order_book_snapshot IS 'JSON snapshot of relevant order books for debugging and analysis';