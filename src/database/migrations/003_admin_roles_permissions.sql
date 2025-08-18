-- Admin Role Permissions Migration
-- Adds detailed permissions system for admin roles

-- Create admin_permissions table to define what each role can do
CREATE TABLE IF NOT EXISTS admin_permissions (
    id SERIAL PRIMARY KEY,
    role_name VARCHAR(20) NOT NULL,
    permission_name VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_name, permission_name)
);

-- Insert default permissions for each role
INSERT INTO admin_permissions (role_name, permission_name, description) VALUES
-- Support role - basic read access
('support', 'users.view', 'View user information and account details'),
('support', 'messages.view', 'View user messages and support tickets'),
('support', 'messages.reply', 'Reply to user messages and support tickets'),

-- Manager role - support + user management
('manager', 'users.view', 'View user information and account details'),
('manager', 'users.activate', 'Activate user accounts'),
('manager', 'users.suspend', 'Suspend user accounts for violations'),
('manager', 'messages.view', 'View user messages and support tickets'),
('manager', 'messages.reply', 'Reply to user messages and support tickets'),
('manager', 'billing.view', 'View billing information and payment status'),

-- Admin role - manager + bulk operations + system config
('admin', 'users.view', 'View user information and account details'),
('admin', 'users.activate', 'Activate user accounts'),
('admin', 'users.suspend', 'Suspend user accounts'),
('admin', 'users.delete', 'Delete user accounts'),
('admin', 'users.bulk_operations', 'Perform bulk user operations'),
('admin', 'messages.view', 'View user messages and support tickets'),
('admin', 'messages.reply', 'Reply to user messages and support tickets'),
('admin', 'messages.compose', 'Compose new messages to users'),
('admin', 'billing.view', 'View billing information and payment status'),
('admin', 'billing.manage', 'Manage billing and payment processing'),
('admin', 'system.config', 'Modify system configuration'),
('admin', 'admins.view', 'View other admin accounts'),

-- Master role - all permissions + admin management
('master', 'users.view', 'View user information and account details'),
('master', 'users.activate', 'Activate user accounts'),
('master', 'users.suspend', 'Suspend user accounts'),
('master', 'users.delete', 'Delete user accounts'),
('master', 'users.bulk_operations', 'Perform bulk user operations'),
('master', 'messages.view', 'View user messages and support tickets'),
('master', 'messages.reply', 'Reply to user messages and support tickets'),
('master', 'messages.compose', 'Compose new messages to users'),
('master', 'billing.view', 'View billing information and payment status'),
('master', 'billing.manage', 'Manage billing and payment processing'),
('master', 'system.config', 'Modify system configuration'),
('master', 'admins.view', 'View other admin accounts'),
('master', 'admins.create', 'Create new admin accounts'),
('master', 'admins.promote', 'Promote users to admin roles'),
('master', 'admins.demote', 'Demote admin users'),
('master', 'admins.delete', 'Delete admin accounts'),
('master', 'system.logs', 'Access system logs and audit trails')
ON CONFLICT (role_name, permission_name) DO NOTHING;

-- Add admin activity log table for audit trail
CREATE TABLE IF NOT EXISTS admin_activity_log (
    id SERIAL PRIMARY KEY,
    admin_user_id VARCHAR(50) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50), -- 'user', 'admin', 'system', etc.
    target_id VARCHAR(50),
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create index for efficient log queries
CREATE INDEX IF NOT EXISTS idx_admin_activity_log_admin_user_id ON admin_activity_log(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_activity_log_created_at ON admin_activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_activity_log_action ON admin_activity_log(action);

-- Add function to check if admin has permission
CREATE OR REPLACE FUNCTION admin_has_permission(user_role VARCHAR(20), required_permission VARCHAR(50))
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM admin_permissions 
        WHERE role_name = user_role 
        AND permission_name = required_permission
    );
END;
$$ LANGUAGE plpgsql;

-- Add function to log admin activity
CREATE OR REPLACE FUNCTION log_admin_activity(
    p_admin_user_id VARCHAR(50),
    p_action VARCHAR(100),
    p_target_type VARCHAR(50) DEFAULT NULL,
    p_target_id VARCHAR(50) DEFAULT NULL,
    p_details JSONB DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO admin_activity_log (
        admin_user_id, action, target_type, target_id, 
        details, ip_address, user_agent
    ) VALUES (
        p_admin_user_id, p_action, p_target_type, p_target_id,
        p_details, p_ip_address, p_user_agent
    );
END;
$$ LANGUAGE plpgsql;