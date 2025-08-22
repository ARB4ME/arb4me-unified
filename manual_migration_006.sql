-- MANUAL MIGRATION FOR AUTO-REMINDER SYSTEM
-- Run this if Railway deployment fails and database changes are needed

-- Check if tables exist first
SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_name = 'auto_reminders_log'
);

-- Add reminder tracking fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_type VARCHAR(10) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_date DATE DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS seven_day_reminder_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS one_day_reminder_sent BOOLEAN DEFAULT FALSE;

-- Add reminder_type field to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(10) DEFAULT NULL;

-- Create auto_reminders_log table
CREATE TABLE IF NOT EXISTS auto_reminders_log (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    reminder_type VARCHAR(10) NOT NULL,
    subscription_expires_at TIMESTAMP NOT NULL,
    days_until_expiry INTEGER NOT NULL,
    message_id INTEGER,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_date DATE DEFAULT CURRENT_DATE,
    user_email VARCHAR(255),
    user_name VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_users_last_reminder_date ON users(last_reminder_date);
CREATE INDEX IF NOT EXISTS idx_users_reminder_flags ON users(seven_day_reminder_sent, one_day_reminder_sent);
CREATE INDEX IF NOT EXISTS idx_auto_reminders_sent_date ON auto_reminders_log(sent_date);
CREATE INDEX IF NOT EXISTS idx_auto_reminders_user_type ON auto_reminders_log(user_id, reminder_type);
CREATE INDEX IF NOT EXISTS idx_messages_reminder_type ON messages(reminder_type) WHERE reminder_type IS NOT NULL;

-- Verify tables were created
SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name IN ('users', 'messages', 'auto_reminders_log') 
AND column_name LIKE '%reminder%'
ORDER BY table_name, column_name;