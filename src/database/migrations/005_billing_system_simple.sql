-- Phase 6 Billing System - Simple Migration
-- This migration adds the essential billing structure step by step

-- 1. Add billing columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'basic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_payment_date DATE DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_reminder_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_sent_date DATE DEFAULT NULL;

-- 2. Create payments table
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    payment_reference VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_date DATE NOT NULL,
    bank_reference VARCHAR(100),
    marked_by_admin_id VARCHAR(50),
    payment_month VARCHAR(7) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Create billing_history table
CREATE TABLE IF NOT EXISTS billing_history (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    billing_month VARCHAR(7) NOT NULL,
    amount_due DECIMAL(10,2) NOT NULL,
    amount_paid DECIMAL(10,2) DEFAULT 0,
    due_date DATE NOT NULL,
    payment_status VARCHAR(20) DEFAULT 'unpaid',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. Create basic indexes
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(payment_month);
CREATE INDEX IF NOT EXISTS idx_billing_user_id ON billing_history(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_month ON billing_history(billing_month);
CREATE INDEX IF NOT EXISTS idx_users_subscription_expires ON users(subscription_expires_at);

-- 5. Update existing users with payment references (using a simpler approach)
DO $$
DECLARE
    user_record RECORD;
    counter INTEGER := 100001;
BEGIN
    FOR user_record IN SELECT id FROM users WHERE payment_reference IS NULL ORDER BY created_at LOOP
        UPDATE users 
        SET payment_reference = 'ARB-' || LPAD(counter::TEXT, 6, '0')
        WHERE id = user_record.id;
        counter := counter + 1;
    END LOOP;
END $$;