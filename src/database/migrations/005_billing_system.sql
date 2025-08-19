-- Phase 6: Billing System Database Schema
-- Comprehensive payment tracking and subscription management

-- 1. CREATE PAYMENTS TABLE
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    payment_reference VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_date DATE NOT NULL,
    bank_reference VARCHAR(100),
    marked_by_admin_id VARCHAR(50),
    marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    payment_month VARCHAR(7) NOT NULL, -- Format: "2025-01"
    notes TEXT,
    status VARCHAR(20) DEFAULT 'completed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (marked_by_admin_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 2. CREATE BILLING_HISTORY TABLE
CREATE TABLE IF NOT EXISTS billing_history (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    billing_month VARCHAR(7) NOT NULL, -- Format: "2025-01"
    amount_due DECIMAL(10,2) NOT NULL DEFAULT 500.00,
    amount_paid DECIMAL(10,2) DEFAULT 0.00,
    payment_status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'paid', 'overdue', 'partial'
    due_date DATE NOT NULL,
    paid_date DATE,
    payment_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
    UNIQUE(user_id, billing_month)
);

-- 3. UPDATE USERS TABLE FIELDS
-- Add billing-related fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_payment_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_reminder_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_sent_date DATE;

-- Update subscription_expires_at to be properly used
-- (This field already exists, we'll just make sure it's utilized)

-- 4. CREATE PERFORMANCE INDEXES
-- Payments table indexes
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(payment_reference);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(payment_month);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Billing history indexes
CREATE INDEX IF NOT EXISTS idx_billing_user_id ON billing_history(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_month ON billing_history(billing_month);
CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_history(payment_status);
CREATE INDEX IF NOT EXISTS idx_billing_due_date ON billing_history(due_date);

-- Users table billing indexes
CREATE INDEX IF NOT EXISTS idx_users_subscription_expires ON users(subscription_expires_at);
CREATE INDEX IF NOT EXISTS idx_users_last_payment ON users(last_payment_date);
CREATE INDEX IF NOT EXISTS idx_users_reminder_sent ON users(payment_reminder_sent);

-- 5. BILLING FUNCTIONS

-- Function to record a payment and update user subscription
CREATE OR REPLACE FUNCTION record_payment(
    p_user_id VARCHAR(50),
    p_amount DECIMAL(10,2),
    p_bank_reference VARCHAR(100),
    p_payment_date DATE,
    p_marked_by_admin_id VARCHAR(50),
    p_notes TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    payment_id INTEGER;
    user_payment_ref VARCHAR(20);
    new_expiry_date DATE;
    billing_month VARCHAR(7);
BEGIN
    -- Get user's payment reference
    SELECT payment_reference INTO user_payment_ref
    FROM users WHERE id = p_user_id;
    
    IF user_payment_ref IS NULL THEN
        RAISE EXCEPTION 'User not found or no payment reference';
    END IF;
    
    -- Calculate new expiry date (30 days from payment date)
    new_expiry_date := p_payment_date + INTERVAL '30 days';
    
    -- Get billing month (YYYY-MM format)
    billing_month := TO_CHAR(p_payment_date, 'YYYY-MM');
    
    -- Insert payment record
    INSERT INTO payments (
        user_id, payment_reference, amount, payment_date, 
        bank_reference, marked_by_admin_id, payment_month, notes
    ) VALUES (
        p_user_id, user_payment_ref, p_amount, p_payment_date,
        p_bank_reference, p_marked_by_admin_id, billing_month, p_notes
    ) RETURNING id INTO payment_id;
    
    -- Update user subscription
    UPDATE users SET 
        subscription_expires_at = new_expiry_date,
        last_payment_date = p_payment_date,
        account_status = 'active',
        payment_reminder_sent = FALSE,
        reminder_sent_date = NULL
    WHERE id = p_user_id;
    
    -- Update or create billing history
    INSERT INTO billing_history (
        user_id, billing_month, amount_due, amount_paid, 
        payment_status, due_date, paid_date, payment_id
    ) VALUES (
        p_user_id, billing_month, p_amount, p_amount,
        'paid', p_payment_date + INTERVAL '30 days', p_payment_date, payment_id
    ) ON CONFLICT (user_id, billing_month) 
    DO UPDATE SET
        amount_paid = billing_history.amount_paid + EXCLUDED.amount_paid,
        payment_status = CASE 
            WHEN billing_history.amount_paid + EXCLUDED.amount_paid >= billing_history.amount_due 
            THEN 'paid' 
            ELSE 'partial' 
        END,
        paid_date = EXCLUDED.paid_date,
        payment_id = EXCLUDED.payment_id,
        updated_at = CURRENT_TIMESTAMP;
    
    RETURN payment_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get users expiring in N days
CREATE OR REPLACE FUNCTION get_expiring_users(days_ahead INTEGER DEFAULT 7)
RETURNS TABLE (
    user_id VARCHAR(50),
    email VARCHAR(100),
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    payment_reference VARCHAR(20),
    subscription_expires_at TIMESTAMP,
    days_remaining INTEGER,
    last_payment_date DATE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.payment_reference,
        u.subscription_expires_at,
        EXTRACT(DAY FROM (u.subscription_expires_at - CURRENT_TIMESTAMP))::INTEGER as days_remaining,
        u.last_payment_date
    FROM users u
    WHERE u.subscription_expires_at IS NOT NULL
    AND u.subscription_expires_at <= CURRENT_TIMESTAMP + INTERVAL '1 day' * days_ahead
    AND u.subscription_expires_at > CURRENT_TIMESTAMP
    AND u.account_status = 'active'
    ORDER BY u.subscription_expires_at ASC;
END;
$$ LANGUAGE plpgsql;

-- Function to get expired users
CREATE OR REPLACE FUNCTION get_expired_users()
RETURNS TABLE (
    user_id VARCHAR(50),
    email VARCHAR(100),
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    payment_reference VARCHAR(20),
    subscription_expires_at TIMESTAMP,
    days_expired INTEGER,
    last_payment_date DATE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.payment_reference,
        u.subscription_expires_at,
        EXTRACT(DAY FROM (CURRENT_TIMESTAMP - u.subscription_expires_at))::INTEGER as days_expired,
        u.last_payment_date
    FROM users u
    WHERE u.subscription_expires_at IS NOT NULL
    AND u.subscription_expires_at < CURRENT_TIMESTAMP
    AND u.account_status != 'suspended'
    ORDER BY u.subscription_expires_at ASC;
END;
$$ LANGUAGE plpgsql;

-- Function to auto-suspend expired users
CREATE OR REPLACE FUNCTION suspend_expired_users()
RETURNS INTEGER AS $$
DECLARE
    suspended_count INTEGER := 0;
    user_record RECORD;
BEGIN
    -- Get all expired users
    FOR user_record IN 
        SELECT * FROM get_expired_users()
    LOOP
        -- Update user status to suspended
        UPDATE users 
        SET account_status = 'suspended'
        WHERE id = user_record.user_id;
        
        suspended_count := suspended_count + 1;
        
        -- Log the suspension (using existing admin activity logging)
        PERFORM log_admin_activity_enhanced(
            'system',
            'auto_suspend_expired_user',
            'billing',
            'warning',
            'user',
            user_record.user_id,
            json_build_object(
                'reason', 'subscription_expired',
                'expired_date', user_record.subscription_expires_at,
                'days_expired', user_record.days_expired
            ),
            NULL,
            json_build_object('account_status', 'suspended'),
            NULL,
            'System Auto-Suspension',
            NULL,
            'POST',
            '/system/suspend-expired',
            200,
            NULL
        );
    END LOOP;
    
    RETURN suspended_count;
END;
$$ LANGUAGE plpgsql;

-- Function to mark payment reminders as sent
CREATE OR REPLACE FUNCTION mark_reminder_sent(p_user_id VARCHAR(50))
RETURNS VOID AS $$
BEGIN
    UPDATE users 
    SET payment_reminder_sent = TRUE,
        reminder_sent_date = CURRENT_DATE
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- 6. CREATE VIEWS FOR COMMON QUERIES

-- Payment summary view
CREATE OR REPLACE VIEW payment_summary AS
SELECT 
    u.id as user_id,
    u.email,
    u.first_name || ' ' || u.last_name as full_name,
    u.payment_reference,
    u.subscription_expires_at,
    u.last_payment_date,
    u.account_status,
    CASE 
        WHEN u.subscription_expires_at IS NULL THEN 'no_subscription'
        WHEN u.subscription_expires_at < CURRENT_TIMESTAMP THEN 'expired'
        WHEN u.subscription_expires_at <= CURRENT_TIMESTAMP + INTERVAL '7 days' THEN 'expiring_soon'
        ELSE 'active'
    END as payment_status,
    CASE 
        WHEN u.subscription_expires_at IS NULL THEN NULL
        ELSE EXTRACT(DAY FROM (u.subscription_expires_at - CURRENT_TIMESTAMP))::INTEGER
    END as days_remaining,
    (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) as total_payments,
    (SELECT SUM(amount) FROM payments p WHERE p.user_id = u.id) as total_paid
FROM users u
ORDER BY u.subscription_expires_at ASC NULLS LAST;

-- Recent payments view
CREATE OR REPLACE VIEW recent_payments AS
SELECT 
    p.id,
    p.user_id,
    u.email,
    u.first_name || ' ' || u.last_name as user_name,
    p.payment_reference,
    p.amount,
    p.payment_date,
    p.bank_reference,
    p.payment_month,
    p.notes,
    admin.first_name || ' ' || admin.last_name as marked_by,
    p.marked_at
FROM payments p
JOIN users u ON p.user_id = u.id
LEFT JOIN users admin ON p.marked_by_admin_id = admin.id
ORDER BY p.payment_date DESC, p.marked_at DESC;