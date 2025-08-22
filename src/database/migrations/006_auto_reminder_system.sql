-- Auto-Reminder System Migration
-- Adds reminder tracking to users table and creates reminder history log

-- 1. Add reminder tracking fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_type VARCHAR(10) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_date DATE DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS seven_day_reminder_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS one_day_reminder_sent BOOLEAN DEFAULT FALSE;

-- 2. Create auto_reminders_log table for complete history tracking
CREATE TABLE IF NOT EXISTS auto_reminders_log (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    reminder_type VARCHAR(10) NOT NULL, -- '7day' or '1day'
    subscription_expires_at TIMESTAMP NOT NULL,
    days_until_expiry INTEGER NOT NULL,
    message_id INTEGER, -- Links to messages table
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_date DATE DEFAULT CURRENT_DATE,
    user_email VARCHAR(255),
    user_name VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Add reminder_type field to messages table for filtering
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(10) DEFAULT NULL;

-- 4. Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_users_last_reminder_date ON users(last_reminder_date);
CREATE INDEX IF NOT EXISTS idx_users_reminder_flags ON users(seven_day_reminder_sent, one_day_reminder_sent);
CREATE INDEX IF NOT EXISTS idx_users_subscription_expires ON users(subscription_expires_at) WHERE subscription_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auto_reminders_sent_date ON auto_reminders_log(sent_date);
CREATE INDEX IF NOT EXISTS idx_auto_reminders_user_type ON auto_reminders_log(user_id, reminder_type);
CREATE INDEX IF NOT EXISTS idx_auto_reminders_expires ON auto_reminders_log(subscription_expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_reminder_type ON messages(reminder_type) WHERE reminder_type IS NOT NULL;

-- 5. Add helpful comments
COMMENT ON COLUMN users.last_reminder_type IS 'Last reminder sent: 7day or 1day';
COMMENT ON COLUMN users.last_reminder_date IS 'Date when last reminder was sent';
COMMENT ON COLUMN users.seven_day_reminder_sent IS 'True if 7-day reminder sent for current subscription';
COMMENT ON COLUMN users.one_day_reminder_sent IS 'True if 1-day reminder sent for current subscription';
COMMENT ON TABLE auto_reminders_log IS 'Complete history of all auto-reminders sent';
COMMENT ON COLUMN auto_reminders_log.reminder_type IS '7day for 7-day warnings, 1day for 1-day urgent reminders';
COMMENT ON COLUMN auto_reminders_log.days_until_expiry IS 'Calculated days until expiry when reminder was sent';
COMMENT ON COLUMN messages.reminder_type IS 'Links messages to auto-reminder system: 7day or 1day';