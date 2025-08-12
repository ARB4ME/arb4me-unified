-- Migration: Set Jonathan as Master Admin
-- Date: 2025-01-12
-- Purpose: Grant master admin role to jonathan@pepworths.com

-- Update Jonathan's existing user account to have master admin role
UPDATE users 
SET 
    admin_role = 'master',
    updated_at = CURRENT_TIMESTAMP
WHERE 
    email = 'jonathan@pepworths.com';

-- Log this change
INSERT INTO system_logs (log_level, log_type, message, context)
VALUES (
    'info',
    'admin_promotion',
    'User promoted to master admin',
    jsonb_build_object(
        'email', 'jonathan@pepworths.com',
        'role', 'master',
        'promoted_by', 'system_migration'
    )
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
        RAISE WARNING 'User jonathan@pepworths.com not found or not updated. Please ensure user is registered first.';
    ELSE
        RAISE NOTICE 'SUCCESS: jonathan@pepworths.com is now a master admin';
    END IF;
END $$;