-- Migration 008: Create Position-Based Admin Accounts
-- This creates 3 hardcoded admin accounts for position-based access

-- Insert position-based admin accounts
-- Password hashes are bcrypt with 12 salt rounds for the specified passwords

-- support/admin456 (Support Staff)
INSERT INTO users (
    id, 
    first_name, 
    last_name, 
    email, 
    mobile, 
    country, 
    password_hash, 
    admin_role, 
    email_verified, 
    account_status,
    created_at,
    updated_at
) VALUES (
    'admin_support_position',
    'Support',
    'Staff',
    'support@arb4me.com',
    '+27000000001',
    'ZA',
    '$2b$12$xWgANK774PmNdPt.IyzMaeOQ6rG0QwagpH4NqhFKzGtJesg9IobNe', -- admin456
    'support',
    true,
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (id) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    admin_role = EXCLUDED.admin_role,
    updated_at = CURRENT_TIMESTAMP;

-- manager/admin789 (Support Manager)
INSERT INTO users (
    id, 
    first_name, 
    last_name, 
    email, 
    mobile, 
    country, 
    password_hash, 
    admin_role, 
    email_verified, 
    account_status,
    created_at,
    updated_at
) VALUES (
    'admin_manager_position',
    'Support',
    'Manager',
    'manager@arb4me.com',
    '+27000000002',
    'ZA',
    '$2b$12$ycNjA7sRbIO5Phsl2is3uurKowTgaEu3EbccAY1bemQ3dXheXjsoy', -- admin789
    'manager',
    true,
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (id) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    admin_role = EXCLUDED.admin_role,
    updated_at = CURRENT_TIMESTAMP;

-- admin/admin999 (General Admin)
INSERT INTO users (
    id, 
    first_name, 
    last_name, 
    email, 
    mobile, 
    country, 
    password_hash, 
    admin_role, 
    email_verified, 
    account_status,
    created_at,
    updated_at
) VALUES (
    'admin_general_position',
    'General',
    'Admin',
    'admin@arb4me.com',
    '+27000000003',
    'ZA',
    '$2b$12$P.elRg8ImlE.x4kEkMFuzexGlrzlT.Z2C2xK2nmGkBahpuIAasTwC', -- admin999
    'admin',
    true,
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (id) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    admin_role = EXCLUDED.admin_role,
    updated_at = CURRENT_TIMESTAMP;

-- Create trading activity records for admin accounts
INSERT INTO trading_activity (user_id) VALUES 
    ('admin_support_position'),
    ('admin_manager_position'),
    ('admin_general_position')
ON CONFLICT (user_id) DO NOTHING;

COMMIT;