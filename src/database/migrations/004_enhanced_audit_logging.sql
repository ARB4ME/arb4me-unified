-- Enhanced Audit Logging System Migration
-- Comprehensive logging infrastructure for compliance and security

-- 1. ENHANCE EXISTING ADMIN_ACTIVITY_LOG TABLE
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general';
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info';
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS before_state JSONB;
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS after_state JSONB;
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS session_id VARCHAR(100);
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS request_method VARCHAR(10);
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS request_url TEXT;
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS response_status INTEGER;
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- 2. CREATE SECURITY_EVENTS TABLE for special security monitoring
CREATE TABLE IF NOT EXISTS security_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL, -- 'failed_login', 'suspicious_activity', 'brute_force', etc.
    severity VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
    user_id VARCHAR(50), -- Can be null for anonymous attempts
    ip_address INET,
    user_agent TEXT,
    details JSONB,
    resolved BOOLEAN DEFAULT FALSE,
    resolved_by VARCHAR(50),
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 3. CREATE USER_SESSIONS TABLE for session tracking
CREATE TABLE IF NOT EXISTS user_sessions (
    id VARCHAR(100) PRIMARY KEY, -- Session ID
    user_id VARCHAR(50) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    logout_time TIMESTAMP,
    session_type VARCHAR(20) DEFAULT 'web', -- 'web', 'api', 'mobile'
    is_admin_session BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. CREATE LOG_CATEGORIES REFERENCE TABLE
CREATE TABLE IF NOT EXISTS log_categories (
    category VARCHAR(50) PRIMARY KEY,
    description TEXT,
    retention_days INTEGER DEFAULT 365,
    export_allowed BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert standard log categories
INSERT INTO log_categories (category, description, retention_days, export_allowed) VALUES
('authentication', 'Login, logout, and authentication events', 730, TRUE),
('user_management', 'User creation, modification, deletion', 2555, TRUE), -- 7 years for compliance
('admin_actions', 'Administrative actions and role changes', 2555, TRUE),
('security', 'Security-related events and violations', 2555, TRUE),
('system', 'System configuration and maintenance', 365, TRUE),
('api_access', 'API key usage and external integrations', 365, FALSE),
('billing', 'Payment and billing related activities', 2555, TRUE),
('messages', 'Message sending and communication logs', 365, FALSE),
('bulk_operations', 'Bulk user operations and mass changes', 2555, TRUE),
('data_export', 'Data export and report generation', 365, TRUE)
ON CONFLICT (category) DO NOTHING;

-- 5. ADD PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_admin_activity_category ON admin_activity_log(category);
CREATE INDEX IF NOT EXISTS idx_admin_activity_severity ON admin_activity_log(severity);
CREATE INDEX IF NOT EXISTS idx_admin_activity_created_at ON admin_activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_activity_user_action ON admin_activity_log(admin_user_id, action);
CREATE INDEX IF NOT EXISTS idx_admin_activity_target ON admin_activity_log(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_unresolved ON security_events(resolved) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip_address);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions(logout_time) WHERE logout_time IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_sessions_admin ON user_sessions(is_admin_session) WHERE is_admin_session = TRUE;

-- 6. ENHANCED LOGGING FUNCTIONS

-- Enhanced admin activity logging with categorization
CREATE OR REPLACE FUNCTION log_admin_activity_enhanced(
    p_admin_user_id VARCHAR(50),
    p_action VARCHAR(100),
    p_category VARCHAR(50) DEFAULT 'general',
    p_severity VARCHAR(20) DEFAULT 'info',
    p_target_type VARCHAR(50) DEFAULT NULL,
    p_target_id VARCHAR(50) DEFAULT NULL,
    p_details JSONB DEFAULT NULL,
    p_before_state JSONB DEFAULT NULL,
    p_after_state JSONB DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_session_id VARCHAR(100) DEFAULT NULL,
    p_request_method VARCHAR(10) DEFAULT NULL,
    p_request_url TEXT DEFAULT NULL,
    p_response_status INTEGER DEFAULT NULL,
    p_duration_ms INTEGER DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO admin_activity_log (
        admin_user_id, action, category, severity, target_type, target_id, 
        details, before_state, after_state, ip_address, user_agent, session_id,
        request_method, request_url, response_status, duration_ms
    ) VALUES (
        p_admin_user_id, p_action, p_category, p_severity, p_target_type, p_target_id,
        p_details, p_before_state, p_after_state, p_ip_address, p_user_agent, p_session_id,
        p_request_method, p_request_url, p_response_status, p_duration_ms
    );
END;
$$ LANGUAGE plpgsql;

-- Security event logging function
CREATE OR REPLACE FUNCTION log_security_event(
    p_event_type VARCHAR(50),
    p_severity VARCHAR(20) DEFAULT 'medium',
    p_user_id VARCHAR(50) DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_details JSONB DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    event_id INTEGER;
BEGIN
    INSERT INTO security_events (
        event_type, severity, user_id, ip_address, user_agent, details
    ) VALUES (
        p_event_type, p_severity, p_user_id, p_ip_address, p_user_agent, p_details
    ) RETURNING id INTO event_id;
    
    RETURN event_id;
END;
$$ LANGUAGE plpgsql;

-- Session management functions
CREATE OR REPLACE FUNCTION create_user_session(
    p_session_id VARCHAR(100),
    p_user_id VARCHAR(50),
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_session_type VARCHAR(20) DEFAULT 'web',
    p_is_admin_session BOOLEAN DEFAULT FALSE
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO user_sessions (
        id, user_id, ip_address, user_agent, session_type, is_admin_session
    ) VALUES (
        p_session_id, p_user_id, p_ip_address, p_user_agent, p_session_type, p_is_admin_session
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_session_activity(
    p_session_id VARCHAR(100)
)
RETURNS VOID AS $$
BEGIN
    UPDATE user_sessions 
    SET last_activity = CURRENT_TIMESTAMP 
    WHERE id = p_session_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION end_user_session(
    p_session_id VARCHAR(100)
)
RETURNS VOID AS $$
BEGIN
    UPDATE user_sessions 
    SET logout_time = CURRENT_TIMESTAMP 
    WHERE id = p_session_id AND logout_time IS NULL;
END;
$$ LANGUAGE plpgsql;

-- 7. AUDIT QUERY HELPER FUNCTIONS

-- Get activity logs with filtering
CREATE OR REPLACE FUNCTION get_activity_logs(
    p_start_date TIMESTAMP DEFAULT NULL,
    p_end_date TIMESTAMP DEFAULT NULL,
    p_admin_user_id VARCHAR(50) DEFAULT NULL,
    p_category VARCHAR(50) DEFAULT NULL,
    p_severity VARCHAR(20) DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id INTEGER,
    admin_user_id VARCHAR(50),
    admin_name TEXT,
    admin_role VARCHAR(20),
    action VARCHAR(100),
    category VARCHAR(50),
    severity VARCHAR(20),
    target_type VARCHAR(50),
    target_id VARCHAR(50),
    details JSONB,
    before_state JSONB,
    after_state JSONB,
    ip_address INET,
    created_at TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        al.id, al.admin_user_id, 
        (u.first_name || ' ' || u.last_name) as admin_name,
        u.admin_role,
        al.action, al.category, al.severity,
        al.target_type, al.target_id, al.details,
        al.before_state, al.after_state, al.ip_address, al.created_at
    FROM admin_activity_log al
    JOIN users u ON al.admin_user_id = u.id
    WHERE 
        (p_start_date IS NULL OR al.created_at >= p_start_date) AND
        (p_end_date IS NULL OR al.created_at <= p_end_date) AND
        (p_admin_user_id IS NULL OR al.admin_user_id = p_admin_user_id) AND
        (p_category IS NULL OR al.category = p_category) AND
        (p_severity IS NULL OR al.severity = p_severity)
    ORDER BY al.created_at DESC
    LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql;

-- 8. LOG CLEANUP FUNCTION
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
    category_record RECORD;
BEGIN
    -- Clean up logs based on category retention policies
    FOR category_record IN 
        SELECT category, retention_days FROM log_categories
    LOOP
        DELETE FROM admin_activity_log 
        WHERE category = category_record.category 
        AND created_at < CURRENT_TIMESTAMP - INTERVAL '1 day' * category_record.retention_days;
        
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
    END LOOP;
    
    -- Clean up old security events (default 2 years)
    DELETE FROM security_events 
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '730 days';
    
    -- Clean up old sessions (keep 90 days)
    DELETE FROM user_sessions 
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days';
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 9. CREATE VIEWS FOR COMMON QUERIES

-- Recent admin activity view
CREATE OR REPLACE VIEW recent_admin_activity AS
SELECT 
    al.id, al.admin_user_id,
    (u.first_name || ' ' || u.last_name) as admin_name,
    u.admin_role, al.action, al.category, al.severity,
    al.target_type, al.target_id, al.details, al.ip_address, al.created_at
FROM admin_activity_log al
JOIN users u ON al.admin_user_id = u.id
WHERE al.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
ORDER BY al.created_at DESC;

-- Security events summary view
CREATE OR REPLACE VIEW security_events_summary AS
SELECT 
    event_type,
    severity,
    COUNT(*) as event_count,
    COUNT(*) FILTER (WHERE resolved = FALSE) as unresolved_count,
    MAX(created_at) as last_occurrence
FROM security_events
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
GROUP BY event_type, severity
ORDER BY event_count DESC;

-- Active admin sessions view
CREATE OR REPLACE VIEW active_admin_sessions AS
SELECT 
    s.id as session_id, s.user_id,
    (u.first_name || ' ' || u.last_name) as admin_name,
    u.admin_role, s.ip_address, s.login_time, s.last_activity
FROM user_sessions s
JOIN users u ON s.user_id = u.id
WHERE s.logout_time IS NULL 
AND s.is_admin_session = TRUE
AND s.last_activity >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
ORDER BY s.last_activity DESC;