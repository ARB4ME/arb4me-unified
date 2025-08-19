-- Phase 8: Platform Settings System
-- This migration creates the platform settings system for admin configuration

-- Create platform_settings table
CREATE TABLE IF NOT EXISTS platform_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT NOT NULL,
    setting_type VARCHAR(20) DEFAULT 'string',
    category VARCHAR(50) DEFAULT 'general',
    description TEXT,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(50)
);

-- Create admin_notifications table for notification preferences
CREATE TABLE IF NOT EXISTS admin_notifications (
    id SERIAL PRIMARY KEY,
    notification_type VARCHAR(50) NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    email_enabled BOOLEAN DEFAULT TRUE,
    push_enabled BOOLEAN DEFAULT TRUE,
    threshold_value DECIMAL(10,2),
    frequency VARCHAR(20) DEFAULT 'immediate',
    last_sent TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create maintenance_log table for tracking maintenance activities
CREATE TABLE IF NOT EXISTS maintenance_log (
    id SERIAL PRIMARY KEY,
    maintenance_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'started',
    message TEXT,
    started_by VARCHAR(50),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    details JSONB DEFAULT '{}'
);

-- Insert default platform settings
INSERT INTO platform_settings (setting_key, setting_value, setting_type, category, description, is_public) VALUES
('user_registration_enabled', 'true', 'boolean', 'user_management', 'Enable new user registration', true),
('api_trading_enabled', 'true', 'boolean', 'trading', 'Enable API trading functionality', true),
('support_messages_enabled', 'true', 'boolean', 'support', 'Enable support message system', true),
('maintenance_mode', 'false', 'boolean', 'system', 'Platform maintenance mode', true),
('max_users_limit', '1000', 'number', 'user_management', 'Maximum number of users allowed', false),
('default_subscription_plan', 'basic', 'string', 'billing', 'Default subscription plan for new users', false),
('platform_title', 'ARB4ME', 'string', 'branding', 'Platform title displayed to users', true),
('platform_description', 'Automated Cryptocurrency Arbitrage Trading', 'string', 'branding', 'Platform description', true),
('contact_email', 'support@arb4me.com', 'string', 'contact', 'Contact email for support', true),
('max_api_keys_per_user', '10', 'number', 'trading', 'Maximum API keys per user', false),
('session_timeout_minutes', '480', 'number', 'security', 'User session timeout in minutes', false),
('backup_frequency_hours', '24', 'number', 'system', 'Database backup frequency in hours', false),
('analytics_retention_days', '90', 'number', 'analytics', 'How long to keep analytics data', false),
('notification_email_limit_per_hour', '50', 'number', 'notifications', 'Email notification rate limit per hour', false),
('trading_halt_threshold_percent', '10', 'number', 'trading', 'Auto-halt trading if losses exceed this percent', false)
ON CONFLICT (setting_key) DO NOTHING;

-- Insert default admin notification preferences
INSERT INTO admin_notifications (notification_type, enabled, email_enabled, threshold_value, frequency) VALUES
('new_user_registration', true, true, NULL, 'immediate'),
('payment_received', true, true, 100.00, 'immediate'),
('subscription_expiring', true, true, NULL, 'daily'),
('high_priority_support', true, true, NULL, 'immediate'),
('system_error', true, true, NULL, 'immediate'),
('trading_halt', true, true, NULL, 'immediate'),
('low_exchange_balance', true, true, 50.00, 'hourly'),
('failed_trades_threshold', true, true, 5, 'hourly'),
('server_health_warning', true, true, NULL, 'immediate'),
('backup_completion', false, true, NULL, 'daily')
ON CONFLICT DO NOTHING;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_platform_settings_category ON platform_settings(category);
CREATE INDEX IF NOT EXISTS idx_platform_settings_public ON platform_settings(is_public);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_type ON admin_notifications(notification_type);
CREATE INDEX IF NOT EXISTS idx_maintenance_log_type ON maintenance_log(maintenance_type);
CREATE INDEX IF NOT EXISTS idx_maintenance_log_started_at ON maintenance_log(started_at);

-- Create function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_platform_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for platform_settings
DROP TRIGGER IF EXISTS update_platform_settings_trigger ON platform_settings;
CREATE TRIGGER update_platform_settings_trigger
BEFORE UPDATE ON platform_settings
FOR EACH ROW
EXECUTE FUNCTION update_platform_settings_timestamp();

-- Create trigger for admin_notifications
DROP TRIGGER IF EXISTS update_admin_notifications_trigger ON admin_notifications;
CREATE TRIGGER update_admin_notifications_trigger
BEFORE UPDATE ON admin_notifications
FOR EACH ROW
EXECUTE FUNCTION update_platform_settings_timestamp();