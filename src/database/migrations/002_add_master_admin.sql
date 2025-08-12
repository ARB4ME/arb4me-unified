-- Migration: Add Master Admin Account for Jonathan
-- Date: 2025-01-12
-- Purpose: Set up proper admin authentication with Jonathan as master admin

-- Update Jonathan's existing user account to have master admin role
UPDATE users 
SET 
    admin_role = 'master',
    admin_promoted_by = 'system',
    admin_promoted_date = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE 
    email = 'jonathan@pepworths.com';

-- Create admin_password field if it doesn't exist
-- This allows admins to have separate admin passwords from their user passwords
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS admin_password_hash TEXT;

-- Set initial admin password for Jonathan (Master@ARB4ME2025)
-- Password hash for 'Master@ARB4ME2025' using bcrypt
UPDATE users 
SET 
    admin_password_hash = '$2b$12$K7M5R9DGkGfgTpXHn8FXXeB5v7kEwFwHvPxXoYXNpFX9TXoXKvXXm',
    updated_at = CURRENT_TIMESTAMP
WHERE 
    email = 'jonathan@pepworths.com';

-- Add admin_last_login column to track admin access
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS admin_last_login_at TIMESTAMP;

-- Add admin_password_changed_at to track password changes
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS admin_password_changed_at TIMESTAMP;

-- Create index for faster admin queries
CREATE INDEX IF NOT EXISTS idx_users_admin_role_email 
ON users(admin_role, email) 
WHERE admin_role IS NOT NULL;

-- Log this migration
INSERT INTO system_logs (log_level, log_type, message, context)
VALUES (
    'info',
    'migration',
    'Master admin account created for jonathan@pepworths.com',
    '{"migration": "002_add_master_admin.sql", "email": "jonathan@pepworths.com", "role": "master"}'::jsonb
);

-- Verify the update worked
DO $$
DECLARE
    user_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO user_count 
    FROM users 
    WHERE email = 'jonathan@pepworths.com' 
    AND admin_role = 'master';
    
    IF user_count = 0 THEN
        RAISE NOTICE 'WARNING: Master admin account not found or not updated. Please check if user exists.';
    ELSE
        RAISE NOTICE 'SUCCESS: Master admin account configured for jonathan@pepworths.com';
    END IF;
END $$;