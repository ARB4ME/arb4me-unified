-- ARB4ME Database Schema
-- PostgreSQL 13+

-- Create database (run this separately as superuser)
-- CREATE DATABASE arb4me_db;
-- CREATE USER arb4me_user WITH ENCRYPTED PASSWORD 'your_password';
-- GRANT ALL PRIVILEGES ON DATABASE arb4me_db TO arb4me_user;

-- Connect to arb4me_db and run the rest

-- Enable UUID extension for better ID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS TABLE
CREATE TABLE users (
    id VARCHAR(50) PRIMARY KEY DEFAULT 'user_' || EXTRACT(EPOCH FROM NOW())::TEXT || '_' || LPAD((RANDOM() * 999999)::INT::TEXT, 6, '0'),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    mobile VARCHAR(50) NOT NULL,
    country VARCHAR(2) NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified BOOLEAN DEFAULT FALSE,
    
    -- Admin fields
    admin_role VARCHAR(20) CHECK (admin_role IN ('support', 'manager', 'admin', 'master')),
    admin_pin TEXT,
    admin_promoted_by VARCHAR(50),
    admin_promoted_date TIMESTAMP,
    admin_last_access TIMESTAMP,
    
    -- Account status
    account_status VARCHAR(20) DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'trial', 'deleted')),
    subscription_plan VARCHAR(50) DEFAULT 'free',
    subscription_expires_at TIMESTAMP,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

-- 2. MESSAGES TABLE
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    message_type VARCHAR(20) NOT NULL CHECK (message_type IN ('user_to_admin', 'admin_to_user', 'broadcast')),
    status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'replied')),
    
    -- Threading
    parent_message_id INTEGER,
    thread_id INTEGER,
    
    -- Admin fields
    admin_user_id VARCHAR(50),
    admin_read_at TIMESTAMP,
    admin_replied_at TIMESTAMP,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_messages_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_parent FOREIGN KEY (parent_message_id) REFERENCES messages(id),
    CONSTRAINT fk_messages_admin FOREIGN KEY (admin_user_id) REFERENCES users(id)
);

-- 3. TRADING_ACTIVITY TABLE
CREATE TABLE trading_activity (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) UNIQUE NOT NULL,
    
    -- Exchange connections
    exchanges_connected JSONB DEFAULT '[]',
    exchanges_connected_count INTEGER DEFAULT 0,
    
    -- Trading settings
    selected_crypto_assets JSONB DEFAULT '[]',
    trading_active BOOLEAN DEFAULT FALSE,
    auto_trading_enabled BOOLEAN DEFAULT FALSE,
    
    -- Trading stats
    total_trades_count INTEGER DEFAULT 0,
    successful_trades_count INTEGER DEFAULT 0,
    failed_trades_count INTEGER DEFAULT 0,
    profit_loss_total DECIMAL(15,2) DEFAULT 0.00,
    
    -- Requirements tracking
    api_keys_configured BOOLEAN DEFAULT FALSE,
    usdt_balance_detected BOOLEAN DEFAULT FALSE,
    safety_controls_completed BOOLEAN DEFAULT FALSE,
    auto_trading_readiness_percent INTEGER DEFAULT 0,
    
    -- Timestamps
    last_trading_activity TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_trading_activity_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. USER_ACTIVITY TABLE
CREATE TABLE user_activity (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    
    -- Activity tracking
    activity_type VARCHAR(50) NOT NULL,
    activity_details JSONB,
    ip_address INET,
    user_agent TEXT,
    
    -- Session info
    session_id VARCHAR(100),
    device_type VARCHAR(50),
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_user_activity_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 5. PROFILE_UPDATES TABLE
CREATE TABLE profile_updates (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    field_name VARCHAR(50) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    ip_address INET,
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_profile_updates_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 6. BROADCAST_MESSAGES TABLE
CREATE TABLE broadcast_messages (
    id SERIAL PRIMARY KEY,
    subject VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    
    -- Sender info
    sent_by_admin_id VARCHAR(50) NOT NULL,
    
    -- Targeting
    recipient_filter VARCHAR(50) DEFAULT 'all_users',
    recipient_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    scheduled_for TIMESTAMP,
    sent_at TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_broadcast_sent_by FOREIGN KEY (sent_by_admin_id) REFERENCES users(id)
);

-- 7. MESSAGE_RECIPIENTS TABLE
CREATE TABLE message_recipients (
    id SERIAL PRIMARY KEY,
    broadcast_message_id INTEGER NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    
    -- Delivery tracking
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    
    -- Unique constraint
    UNIQUE(broadcast_message_id, user_id),
    
    -- Foreign key constraints
    CONSTRAINT fk_recipients_broadcast FOREIGN KEY (broadcast_message_id) REFERENCES broadcast_messages(id) ON DELETE CASCADE,
    CONSTRAINT fk_recipients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 8. SESSIONS TABLE
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    
    -- Session info
    ip_address INET,
    user_agent TEXT,
    device_type VARCHAR(50),
    
    -- Expiry
    expires_at TIMESTAMP NOT NULL,
    last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_sessions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 9. SYSTEM_LOGS TABLE
CREATE TABLE system_logs (
    id SERIAL PRIMARY KEY,
    log_level VARCHAR(20) NOT NULL CHECK (log_level IN ('debug', 'info', 'warning', 'error', 'critical')),
    log_type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    context JSONB,
    user_id VARCHAR(50),
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_system_logs_user FOREIGN KEY (user_id) REFERENCES users(id)
);

-- INDEXES FOR PERFORMANCE

-- Users table indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_admin_role ON users(admin_role);
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_users_last_login ON users(last_login_at);

-- Messages table indexes
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_priority ON messages(priority);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_user_status ON messages(user_id, status);

-- Trading activity indexes
CREATE INDEX idx_trading_activity_user_id ON trading_activity(user_id);
CREATE INDEX idx_trading_activity_active ON trading_activity(trading_active);
CREATE INDEX idx_trading_activity_last_activity ON trading_activity(last_trading_activity);

-- User activity indexes
CREATE INDEX idx_user_activity_user_id ON user_activity(user_id);
CREATE INDEX idx_user_activity_type ON user_activity(activity_type);
CREATE INDEX idx_user_activity_created_at ON user_activity(created_at);
CREATE INDEX idx_user_activity_user_date ON user_activity(user_id, created_at DESC);

-- Profile updates indexes
CREATE INDEX idx_profile_updates_user_id ON profile_updates(user_id);
CREATE INDEX idx_profile_updates_field_name ON profile_updates(field_name);
CREATE INDEX idx_profile_updates_created_at ON profile_updates(created_at);

-- Broadcast messages indexes
CREATE INDEX idx_broadcast_sent_by ON broadcast_messages(sent_by_admin_id);
CREATE INDEX idx_broadcast_sent_at ON broadcast_messages(sent_at);

-- Message recipients indexes
CREATE INDEX idx_recipients_broadcast_id ON message_recipients(broadcast_message_id);
CREATE INDEX idx_recipients_user_id ON message_recipients(user_id);

-- Sessions indexes
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- System logs indexes
CREATE INDEX idx_system_logs_level ON system_logs(log_level);
CREATE INDEX idx_system_logs_type ON system_logs(log_type);
CREATE INDEX idx_system_logs_created_at ON system_logs(created_at);

-- TRIGGERS AND FUNCTIONS

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS 'BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;' LANGUAGE 'plpgsql';

-- Apply updated_at trigger to relevant tables
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_messages_updated_at 
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trading_activity_updated_at 
    BEFORE UPDATE ON trading_activity
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to assign thread_id for messages
CREATE OR REPLACE FUNCTION assign_thread_id() RETURNS TRIGGER AS 'BEGIN IF NEW.parent_message_id IS NULL THEN NEW.thread_id = NULL; ELSE SELECT thread_id INTO NEW.thread_id FROM messages WHERE id = NEW.parent_message_id; END IF; RETURN NEW; END;' LANGUAGE 'plpgsql';

-- Thread ID trigger
CREATE TRIGGER assign_message_thread_id 
    BEFORE INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION assign_thread_id();

-- Function to update thread_id after insert (for new threads)
CREATE OR REPLACE FUNCTION update_thread_id_after_insert() RETURNS TRIGGER AS 'BEGIN IF NEW.thread_id IS NULL THEN UPDATE messages SET thread_id = NEW.id WHERE id = NEW.id; END IF; RETURN NEW; END;' LANGUAGE 'plpgsql';

-- Update thread ID after insert
CREATE TRIGGER update_thread_id_after_insert
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_thread_id_after_insert();

-- Function to update exchanges_connected_count
CREATE OR REPLACE FUNCTION update_exchanges_count() RETURNS TRIGGER AS 'BEGIN NEW.exchanges_connected_count = jsonb_array_length(NEW.exchanges_connected); RETURN NEW; END;' LANGUAGE 'plpgsql';

-- Exchanges count trigger
CREATE TRIGGER update_trading_exchanges_count 
    BEFORE INSERT OR UPDATE OF exchanges_connected ON trading_activity
    FOR EACH ROW EXECUTE FUNCTION update_exchanges_count();

-- Initial data
-- Insert master admin user (password will be hashed by application)
INSERT INTO users (
    id, first_name, last_name, email, mobile, country,
    password_hash, email_verified, admin_role, account_status
) VALUES (
    'user_admin_master',
    'Master', 'Admin', 
    COALESCE(NULLIF(current_setting('app.master_admin_email', true), ''), 'admin@arb4me.com'),
    '+27000000000', 'ZA',
    '$2b$12$placeholder_hash_to_be_replaced_by_app', 
    true, 'master', 'active'
) ON CONFLICT (email) DO NOTHING;

-- Create initial trading activity for master admin
INSERT INTO trading_activity (user_id) 
SELECT 'user_admin_master' 
WHERE EXISTS (SELECT 1 FROM users WHERE id = 'user_admin_master')
ON CONFLICT (user_id) DO NOTHING;

-- Add self-referencing foreign key constraint for users table (after table creation)
ALTER TABLE users ADD CONSTRAINT fk_admin_promoted_by 
    FOREIGN KEY (admin_promoted_by) REFERENCES users(id);