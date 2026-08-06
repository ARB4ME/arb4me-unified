-- Migration 012: Profit-Based Billing System
-- Date: 2026-08-06
-- Purpose: Replace subscription model with 3% profit-based billing
-- Billing cycle: User's signup anniversary (monthly from created_at)

-- 1. CREATE BILLING INVOICES TABLE
CREATE TABLE IF NOT EXISTS billing_invoices (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    billing_period_start DATE NOT NULL,
    billing_period_end DATE NOT NULL,
    total_profit DECIMAL(15,2) NOT NULL DEFAULT 0,
    fee_percentage DECIMAL(5,4) NOT NULL DEFAULT 0.03,
    fee_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'unpaid', -- unpaid, paid, waived
    payment_tx_hash VARCHAR(100),
    payment_date TIMESTAMP,
    payment_network VARCHAR(20), -- TRC20, ERC20, BEP20
    payment_amount DECIMAL(15,2),
    notes TEXT,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, billing_period_start)
);

-- 2. CREATE INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_billing_invoices_user_id ON billing_invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_status ON billing_invoices(status);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_period ON billing_invoices(billing_period_start, billing_period_end);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_created ON billing_invoices(created_at);

-- 3. ADD LAST BILLING DATE TO USERS TABLE
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_billing_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) DEFAULT 'active'; -- active, blocked

-- 4. CREATE INDEX FOR BILLING STATUS
CREATE INDEX IF NOT EXISTS idx_users_billing_status ON users(billing_status);
CREATE INDEX IF NOT EXISTS idx_users_next_billing ON users(next_billing_date);

-- 5. FUNCTION: Calculate user's billing period based on signup anniversary
CREATE OR REPLACE FUNCTION get_user_billing_period(p_user_id VARCHAR(50), p_reference_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    period_start DATE,
    period_end DATE,
    period_number INTEGER
) AS $$
DECLARE
    signup_date DATE;
    signup_day INTEGER;
    current_year INTEGER;
    current_month INTEGER;
    calc_start DATE;
    calc_end DATE;
    periods_since_signup INTEGER;
BEGIN
    -- Get user's signup date
    SELECT DATE(created_at) INTO signup_date
    FROM users WHERE id = p_user_id;

    IF signup_date IS NULL THEN
        RETURN;
    END IF;

    -- Get the day of month they signed up
    signup_day := EXTRACT(DAY FROM signup_date);

    -- Calculate how many complete months since signup
    periods_since_signup := (
        (EXTRACT(YEAR FROM p_reference_date) - EXTRACT(YEAR FROM signup_date)) * 12 +
        (EXTRACT(MONTH FROM p_reference_date) - EXTRACT(MONTH FROM signup_date))
    );

    -- Adjust if we haven't reached the anniversary day this month
    IF EXTRACT(DAY FROM p_reference_date) < signup_day THEN
        periods_since_signup := periods_since_signup - 1;
    END IF;

    -- Calculate current billing period start
    calc_start := signup_date + (periods_since_signup * INTERVAL '1 month');
    calc_end := calc_start + INTERVAL '1 month' - INTERVAL '1 day';

    period_start := calc_start;
    period_end := calc_end;
    period_number := periods_since_signup + 1;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- 6. FUNCTION: Calculate user's profit for a billing period
CREATE OR REPLACE FUNCTION calculate_period_profit(
    p_user_id VARCHAR(50),
    p_period_start DATE,
    p_period_end DATE
)
RETURNS DECIMAL(15,2) AS $$
DECLARE
    total_profit DECIMAL(15,2) := 0;
BEGIN
    -- Sum profit from user_activity trade logs for the period
    SELECT COALESCE(SUM((activity_details->>'profit')::DECIMAL), 0)
    INTO total_profit
    FROM user_activity
    WHERE user_id = p_user_id
    AND activity_type = 'trade_completed'
    AND (activity_details->>'successful')::BOOLEAN = true
    AND created_at >= p_period_start
    AND created_at < (p_period_end + INTERVAL '1 day');

    RETURN total_profit;
END;
$$ LANGUAGE plpgsql;

-- 7. FUNCTION: Generate invoice for user
CREATE OR REPLACE FUNCTION generate_user_invoice(
    p_user_id VARCHAR(50),
    p_period_start DATE DEFAULT NULL,
    p_period_end DATE DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_period_start DATE;
    v_period_end DATE;
    v_total_profit DECIMAL(15,2);
    v_fee_amount DECIMAL(15,2);
    v_invoice_id INTEGER;
    v_existing_invoice INTEGER;
BEGIN
    -- If period not specified, use current billing period
    IF p_period_start IS NULL THEN
        SELECT period_start, period_end INTO v_period_start, v_period_end
        FROM get_user_billing_period(p_user_id);
    ELSE
        v_period_start := p_period_start;
        v_period_end := p_period_end;
    END IF;

    -- Check if invoice already exists for this period
    SELECT id INTO v_existing_invoice
    FROM billing_invoices
    WHERE user_id = p_user_id AND billing_period_start = v_period_start;

    IF v_existing_invoice IS NOT NULL THEN
        RETURN v_existing_invoice; -- Return existing invoice ID
    END IF;

    -- Calculate profit for the period
    v_total_profit := calculate_period_profit(p_user_id, v_period_start, v_period_end);

    -- Only create invoice if there's profit
    IF v_total_profit <= 0 THEN
        RETURN NULL; -- No invoice needed
    END IF;

    -- Calculate 3% fee
    v_fee_amount := v_total_profit * 0.03;

    -- Create invoice
    INSERT INTO billing_invoices (
        user_id,
        billing_period_start,
        billing_period_end,
        total_profit,
        fee_percentage,
        fee_amount,
        status
    ) VALUES (
        p_user_id,
        v_period_start,
        v_period_end,
        v_total_profit,
        0.03,
        v_fee_amount,
        'unpaid'
    ) RETURNING id INTO v_invoice_id;

    -- Update user's billing status to blocked (must pay to trade)
    UPDATE users SET
        billing_status = 'blocked',
        next_billing_date = v_period_end + INTERVAL '1 day',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_user_id;

    RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql;

-- 8. FUNCTION: Mark invoice as paid
CREATE OR REPLACE FUNCTION mark_invoice_paid(
    p_invoice_id INTEGER,
    p_tx_hash VARCHAR(100),
    p_network VARCHAR(20) DEFAULT 'TRC20',
    p_amount DECIMAL(15,2) DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    v_user_id VARCHAR(50);
    v_fee_amount DECIMAL(15,2);
BEGIN
    -- Get invoice details
    SELECT user_id, fee_amount INTO v_user_id, v_fee_amount
    FROM billing_invoices
    WHERE id = p_invoice_id AND status = 'unpaid';

    IF v_user_id IS NULL THEN
        RETURN FALSE; -- Invoice not found or already paid
    END IF;

    -- Update invoice
    UPDATE billing_invoices SET
        status = 'paid',
        payment_tx_hash = p_tx_hash,
        payment_network = p_network,
        payment_amount = COALESCE(p_amount, v_fee_amount),
        payment_date = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_invoice_id;

    -- Unblock user for trading
    UPDATE users SET
        billing_status = 'active',
        last_billing_date = CURRENT_DATE,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = v_user_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- 9. FUNCTION: Check if user can trade (no unpaid invoices)
CREATE OR REPLACE FUNCTION can_user_trade(p_user_id VARCHAR(50))
RETURNS BOOLEAN AS $$
DECLARE
    v_unpaid_count INTEGER;
    v_billing_status VARCHAR(20);
BEGIN
    -- Check user's billing status
    SELECT billing_status INTO v_billing_status
    FROM users WHERE id = p_user_id;

    IF v_billing_status = 'blocked' THEN
        RETURN FALSE;
    END IF;

    -- Also check for any unpaid invoices (belt and suspenders)
    SELECT COUNT(*) INTO v_unpaid_count
    FROM billing_invoices
    WHERE user_id = p_user_id AND status = 'unpaid';

    RETURN v_unpaid_count = 0;
END;
$$ LANGUAGE plpgsql;

-- 10. VIEW: Users with unpaid invoices
CREATE OR REPLACE VIEW users_with_unpaid_invoices AS
SELECT
    u.id as user_id,
    u.email,
    u.first_name,
    u.last_name,
    u.payment_reference,
    u.billing_status,
    bi.id as invoice_id,
    bi.billing_period_start,
    bi.billing_period_end,
    bi.total_profit,
    bi.fee_amount,
    bi.generated_at,
    EXTRACT(DAY FROM (CURRENT_TIMESTAMP - bi.generated_at)) as days_overdue
FROM users u
JOIN billing_invoices bi ON u.id = bi.user_id
WHERE bi.status = 'unpaid'
ORDER BY bi.generated_at ASC;

-- 11. Initialize next_billing_date for existing users
UPDATE users
SET next_billing_date = DATE(created_at) + INTERVAL '1 month'
WHERE next_billing_date IS NULL AND created_at IS NOT NULL;

-- Log migration
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'system_logs') THEN
        INSERT INTO system_logs (log_level, log_type, message, context)
        VALUES (
            'info',
            'migration',
            'Profit-based billing system (012) installed',
            '{"migration": "012_profit_billing_system.sql", "model": "3% of profit", "billing_cycle": "user_anniversary"}'::jsonb
        );
    END IF;
END $$;
