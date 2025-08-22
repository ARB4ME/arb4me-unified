const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireAdmin, requireAdminRole } = require('../middleware/auth');
const { adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { getConnectedUsers, notifyUser, broadcastToAdmins } = require('../websocket/socketManager');
const { 
    requirePermission, 
    requireMaster, 
    requireAdmin: requireAdminPerm, 
    logAdminActivity,
    logSecurityEvent,
    adminActivityLogger
} = require('../middleware/adminPermissions');

const router = express.Router();

// Apply rate limiting to all routes
router.use(adminRateLimit);

// Messages endpoint with proper authentication
router.get('/messages-test', authenticateUser, requireAdmin, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all'; // sent, read, replied, all
    const priority = req.query.priority || 'all'; // low, medium, high, critical, all
    
    let whereClause = 'WHERE m.message_type = \'user_to_admin\'';
    const queryParams = [];
    let paramIndex = 1;
    
    if (status !== 'all') {
        whereClause += ` AND m.status = $${paramIndex++}`;
        queryParams.push(status);
    }
    
    if (priority !== 'all') {
        whereClause += ` AND m.priority = $${paramIndex++}`;
        queryParams.push(priority);
    }
    
    queryParams.push(limit, offset);
    
    const messagesResult = await query(`
        SELECT 
            m.id, m.subject, m.content, m.priority, m.status, m.created_at, m.thread_id,
            m.admin_read_at, m.admin_replied_at, m.admin_user_id, m.user_id,
            u.first_name, u.last_name, u.email,
            admin_u.first_name as admin_first_name, admin_u.last_name as admin_last_name
        FROM messages m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN users admin_u ON m.admin_user_id = admin_u.id
        ${whereClause}
        ORDER BY 
            CASE WHEN m.priority = 'critical' THEN 1
                 WHEN m.priority = 'high' THEN 2
                 WHEN m.priority = 'medium' THEN 3
                 ELSE 4 END,
            m.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, queryParams);
    
    const messages = messagesResult.rows.map(row => ({
        id: row.id,
        threadId: row.thread_id,
        subject: row.subject,
        content: row.content,
        priority: row.priority,
        status: row.status,
        timestamp: row.created_at,
        userId: row.user_id,
        sender: {
            name: `${row.first_name} ${row.last_name}`,
            email: row.email
        }
    }));
    
    res.json({
        success: true,
        data: {
            messages,
            pagination: {
                currentPage: page,
                totalPages: 1,
                totalRecords: messages.length,
                recordsPerPage: limit
            }
        }
    });
}));

// Force sequence update to much higher value
router.post('/debug-force-sequence-high', asyncHandler(async (req, res) => {
    try {
        // Set sequence to 200020 to avoid ALL possible conflicts (we have user_200003)
        const result = await query("SELECT setval('user_payment_ref_seq', 200020)");
        
        // Verify new value
        const verify = await query("SELECT last_value FROM user_payment_ref_seq");
        
        res.json({
            success: true,
            oldValue: 200003,
            newValue: verify.rows[0].last_value,
            message: 'Sequence forced to 200010 to avoid all conflicts'
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            detail: error.detail
        });
    }
}));

// Test user creation directly - no auth for debugging
router.post('/debug-create-test-user', asyncHandler(async (req, res) => {
    // Try to get next sequence value first
    let testUserId;
    let sequenceWorked = false;
    
    try {
        const seqResult = await query("SELECT nextval('user_payment_ref_seq') as ref_num");
        testUserId = `user_${seqResult.rows[0].ref_num}`;
        sequenceWorked = true;
    } catch (seqError) {
        // Fallback to SHORT timestamp
        const shortTimestamp = Date.now().toString().slice(-6); // Last 6 digits only
        testUserId = `user_${shortTimestamp}`;
    }
    
    const timestamp = Date.now();
    const testEmail = `test_${timestamp}@debug.com`;
    
    try {
        // Direct insert without transaction
        const result = await query(`
            INSERT INTO users (id, first_name, last_name, email, mobile, country, password_hash, account_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, email
        `, [testUserId, 'Test', 'Debug', testEmail, '1234567890', 'ZA', 'dummy_hash', 'active']);
        
        // Verify it was saved
        const verify = await query('SELECT id, email FROM users WHERE id = $1', [testUserId]);
        
        res.json({
            success: true,
            created: result.rows[0],
            verified: verify.rows.length > 0,
            sequenceWorked: sequenceWorked,
            userId: testUserId,
            message: `Test user ${testUserId} created and verified`
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            detail: error.detail,
            code: error.code,
            sequenceWorked: sequenceWorked,
            attemptedId: testUserId
        });
    }
}));

// Debug email check 
router.get('/debug-check-email/:email', asyncHandler(async (req, res) => {
    const email = req.params.email;
    
    try {
        // Exact same query as registration uses
        const result = await query(
            'SELECT id, first_name, last_name, email FROM users WHERE email = $1',
            [email]
        );
        
        // Also check with normalization
        const normalizedEmail = email.toLowerCase().trim();
        const normalizedResult = await query(
            'SELECT id, first_name, last_name, email FROM users WHERE LOWER(TRIM(email)) = $1',
            [normalizedEmail]
        );
        
        res.json({
            email: email,
            exactMatch: result.rows,
            exactCount: result.rows.length,
            normalizedMatch: normalizedResult.rows,
            normalizedCount: normalizedResult.rows.length,
            message: result.rows.length > 0 ? 'Email exists!' : 'Email does not exist'
        });
    } catch (error) {
        res.json({
            error: error.message,
            detail: error.detail
        });
    }
}));

// Check if sequence exists
router.get('/debug-check-sequence', asyncHandler(async (req, res) => {
    try {
        // Check if sequence exists
        const seqCheck = await query(`
            SELECT EXISTS (
                SELECT 1 FROM pg_sequences 
                WHERE schemaname = 'public' 
                AND sequencename = 'user_payment_ref_seq'
            ) as sequence_exists
        `);
        
        let currentValue = null;
        if (seqCheck.rows[0].sequence_exists) {
            // Get current value
            const currentVal = await query("SELECT last_value FROM user_payment_ref_seq");
            currentValue = currentVal.rows[0].last_value;
        }
        
        res.json({
            sequenceExists: seqCheck.rows[0].sequence_exists,
            currentValue: currentValue,
            message: seqCheck.rows[0].sequence_exists ? 
                `Sequence exists at value ${currentValue}` : 
                'Sequence does not exist - this is the problem!'
        });
    } catch (error) {
        res.json({
            error: error.message,
            detail: error.detail
        });
    }
}));

// Direct database check - no auth for debugging
router.get('/debug-users-count', asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, email, first_name, last_name, created_at, payment_reference
        FROM users 
        WHERE admin_role IS NULL OR admin_role != 'master'
        ORDER BY created_at DESC
        LIMIT 50
    `);
    
    res.json({
        total: result.rows.length,
        timestamp: new Date().toISOString(),
        users: result.rows.map(u => ({
            id: u.id,
            email: u.email,
            name: `${u.first_name} ${u.last_name}`,
            payment_ref: u.payment_reference,
            created: u.created_at
        }))
    });
}));

// Get all users for compose modal with proper authentication  
router.get('/all-users-test', authenticateUser, requireAdmin, asyncHandler(async (req, res) => {
    // Debug: Check total user count first
    const countResult = await query('SELECT COUNT(*) as total_users FROM users WHERE admin_role IS NULL OR admin_role != \'master\'');
    console.log(`🔍 Debug: Total regular users in database: ${countResult.rows[0].total_users}`);
    // Try with payment_reference, fallback without if column doesn't exist
    let usersResult;
    try {
        usersResult = await query(`
            SELECT 
                u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
                u.account_status, u.subscription_plan, u.subscription_expires_at,
                u.payment_reference,
                u.created_at, u.updated_at, u.last_login_at,
                ta.exchanges_connected_count, ta.trading_active, ta.auto_trading_enabled,
                ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
                ta.last_trading_activity
            FROM users u
            LEFT JOIN trading_activity ta ON u.id = ta.user_id
            WHERE u.admin_role IS NULL OR u.admin_role != 'master'
            ORDER BY u.first_name ASC, u.last_name ASC
        `);
        console.log(`🔍 Debug: Retrieved ${usersResult.rows.length} users with payment_reference`);
    } catch (error) {
        // If payment_reference column doesn't exist, query without it
        console.log('Payment reference column not found, querying without it');
        usersResult = await query(`
            SELECT 
                u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
                u.account_status, u.subscription_plan, u.subscription_expires_at,
                u.created_at, u.updated_at, u.last_login_at,
                ta.exchanges_connected_count, ta.trading_active, ta.auto_trading_enabled,
                ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
                ta.last_trading_activity
            FROM users u
            LEFT JOIN trading_activity ta ON u.id = ta.user_id
            WHERE u.admin_role IS NULL OR u.admin_role != 'master'
            ORDER BY u.first_name ASC, u.last_name ASC
        `);
        console.log(`🔍 Debug: Retrieved ${usersResult.rows.length} users without payment_reference`);
    }
    
    // Debug: Show recent users
    console.log('🔍 Debug: Recent 3 users:');
    usersResult.rows.slice(-3).forEach(user => {
        console.log(`   - ${user.first_name} ${user.last_name} (${user.email}) - Created: ${user.created_at}`);
    });
    
    const users = usersResult.rows.map(row => ({
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        name: `${row.first_name} ${row.last_name}`,
        email: row.email,
        mobile: row.mobile,
        country: row.country,
        account_status: row.account_status,
        accountStatus: row.account_status,
        status: row.account_status,
        subscription_plan: row.subscription_plan,
        subscription_expires_at: row.subscription_expires_at,
        created_at: row.created_at,
        createdAt: row.created_at,
        updated_at: row.updated_at,
        last_login_at: row.last_login_at,
        lastLoginAt: row.last_login_at,
        lastLogin: row.last_login_at,
        payment_reference: row.payment_reference,
        paymentReference: row.payment_reference,
        // Trading activity fields
        exchanges_connected_count: row.exchanges_connected_count || 0,
        exchangesConnectedCount: row.exchanges_connected_count || 0,
        trading_active: row.trading_active || false,
        tradingActive: row.trading_active || false,
        auto_trading_enabled: row.auto_trading_enabled || false,
        autoTradingEnabled: row.auto_trading_enabled || false,
        total_trades_count: row.total_trades_count || 0,
        totalTradesCount: row.total_trades_count || 0,
        successful_trades_count: row.successful_trades_count || 0,
        successfulTradesCount: row.successful_trades_count || 0,
        profit_loss_total: row.profit_loss_total || 0,
        profitLossTotal: row.profit_loss_total || 0,
        last_trading_activity: row.last_trading_activity,
        lastTradingActivity: row.last_trading_activity,
        isOnline: false // Default to offline since we don't track real-time status
    }));
    
    res.json({
        success: true,
        data: { users },
        message: `Found ${users.length} users`
    });
}));

// Users endpoint with proper authentication
router.get('/users-test', authenticateUser, requireAdmin, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all';
    
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramIndex = 1;
    
    if (status !== 'all') {
        whereClause += ` AND u.account_status = $${paramIndex++}`;
        queryParams.push(status);
    }
    
    queryParams.push(limit, offset);
    
    // Try with payment_reference, fallback without if column doesn't exist
    let usersResult;
    try {
        usersResult = await query(`
            SELECT 
                u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
                u.account_status, u.subscription_plan, u.subscription_expires_at,
                u.payment_reference,
                u.created_at, u.updated_at, u.last_login_at,
                ta.exchanges_connected_count, ta.trading_active, ta.auto_trading_enabled,
                ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
                ta.last_trading_activity
            FROM users u
            LEFT JOIN trading_activity ta ON u.id = ta.user_id
            ${whereClause}
            ORDER BY u.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `, queryParams);
    } catch (error) {
        // If payment_reference column doesn't exist, query without it
        console.log('Payment reference column not found, querying without it');
        usersResult = await query(`
            SELECT 
                u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
                u.account_status, u.subscription_plan, u.subscription_expires_at,
                u.created_at, u.updated_at, u.last_login_at,
                ta.exchanges_connected_count, ta.trading_active, ta.auto_trading_enabled,
                ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
                ta.last_trading_activity
            FROM users u
            LEFT JOIN trading_activity ta ON u.id = ta.user_id
            ${whereClause}
            ORDER BY u.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `, queryParams);
    }
    
    const users = usersResult.rows.map(row => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        mobile: row.mobile,
        country: row.country,
        accountStatus: row.account_status,
        subscriptionPlan: row.subscription_plan,
        subscriptionExpiresAt: row.subscription_expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastLoginAt: row.last_login_at,
        paymentReference: row.payment_reference || null,
        // Trading activity fields
        exchangesConnectedCount: row.exchanges_connected_count || 0,
        tradingActive: row.trading_active || false,
        autoTradingEnabled: row.auto_trading_enabled || false,
        totalTradesCount: row.total_trades_count || 0,
        successfulTradesCount: row.successful_trades_count || 0,
        profitLossTotal: row.profit_loss_total || 0,
        lastTradingActivity: row.last_trading_activity || null
    }));
    
    res.json({
        success: true,
        data: {
            users,
            pagination: {
                currentPage: page,
                totalPages: 1,
                totalRecords: users.length,
                recordsPerPage: limit
            }
        }
    });
}));

// Admin reply endpoint with proper authentication
router.post('/reply-test', authenticateUser, requireAdmin, asyncHandler(async (req, res) => {
    const { targetUserId, parentMessageId, subject, content } = req.body;
    
    await transaction(async (client) => {
        // Verify parent message exists and get thread info
        const parentResult = await client.query(
            'SELECT id, thread_id, user_id FROM messages WHERE id = $1',
            [parentMessageId]
        );
        
        if (parentResult.rows.length === 0) {
            throw new APIError('Parent message not found', 404, 'PARENT_MESSAGE_NOT_FOUND');
        }
        
        const parentMessage = parentResult.rows[0];
        
        // Verify target user exists
        const userResult = await client.query(
            'SELECT id, first_name, last_name FROM users WHERE id = $1 AND account_status = $2',
            [targetUserId, 'active']
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('Target user not found or inactive', 404, 'TARGET_USER_NOT_FOUND');
        }
        
        const targetUser = userResult.rows[0];
        
        // Insert admin reply (using a system admin ID for testing)
        const replyResult = await client.query(
            `INSERT INTO messages (user_id, subject, content, message_type, admin_user_id, parent_message_id, thread_id, status) 
             VALUES ($1, $2, $3, 'admin_to_user', $4, $5, $6, 'delivered') 
             RETURNING id, created_at`,
            [targetUserId, subject, content, req.user.id, parentMessageId, parentMessage.thread_id]
        );
        
        const reply = replyResult.rows[0];
        
        // Update parent message status
        await client.query(
            'UPDATE messages SET status = $1, admin_read_at = CURRENT_TIMESTAMP, admin_replied_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['replied', parentMessageId]
        );
        
        res.status(201).json({
            success: true,
            data: {
                reply: {
                    id: reply.id,
                    threadId: parentMessage.thread_id,
                    targetUser: `${targetUser.first_name} ${targetUser.last_name}`,
                    subject,
                    content,
                    timestamp: reply.created_at,
                    parentMessageId
                }
            },
            message: 'Reply sent successfully'
        });
    });
}));

router.use(requireAdmin);

// GET /api/v1/admin/dashboard - Main dashboard statistics
router.get('/dashboard', asyncHandler(async (req, res) => {
    // Get user statistics
    const userStatsResult = await query(`
        SELECT 
            COUNT(*) as total_users,
            COUNT(CASE WHEN account_status = 'active' THEN 1 END) as active_users,
            COUNT(CASE WHEN account_status = 'suspended' THEN 1 END) as suspended_users,
            COUNT(CASE WHEN account_status = 'trial' THEN 1 END) as trial_users,
            COUNT(CASE WHEN last_login_at > NOW() - INTERVAL '24 hours' THEN 1 END) as recent_logins,
            COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as new_users_week,
            COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_users_month
        FROM users
    `);
    
    // Get trading statistics
    const tradingStatsResult = await query(`
        SELECT 
            COUNT(*) as total_traders,
            COUNT(CASE WHEN trading_active = true THEN 1 END) as active_traders,
            COUNT(CASE WHEN auto_trading_enabled = true THEN 1 END) as auto_traders,
            AVG(exchanges_connected_count) as avg_exchanges_connected,
            SUM(total_trades_count) as total_trades_platform,
            SUM(successful_trades_count) as successful_trades_platform,
            SUM(failed_trades_count) as failed_trades_platform,
            SUM(profit_loss_total) as total_platform_profit,
            COUNT(CASE WHEN last_trading_activity > NOW() - INTERVAL '24 hours' THEN 1 END) as active_today
        FROM trading_activity
    `);
    
    // Get message statistics
    const messageStatsResult = await query(`
        SELECT 
            COUNT(CASE WHEN message_type = 'user_to_admin' THEN 1 END) as user_messages,
            COUNT(CASE WHEN message_type = 'user_to_admin' AND status = 'sent' THEN 1 END) as unread_messages,
            COUNT(CASE WHEN message_type = 'user_to_admin' AND created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as messages_today,
            COUNT(CASE WHEN message_type = 'admin_to_user' THEN 1 END) as admin_replies,
            COUNT(CASE WHEN priority = 'high' OR priority = 'critical' THEN 1 END) as high_priority_messages
        FROM messages
        WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    
    // Get system activity in last 24 hours
    const systemActivityResult = await query(`
        SELECT 
            activity_type,
            COUNT(*) as count
        FROM user_activity
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY activity_type
        ORDER BY count DESC
        LIMIT 10
    `);
    
    // Get recent error logs
    const errorLogsResult = await query(`
        SELECT 
            log_type,
            message,
            created_at,
            user_id
        FROM system_logs
        WHERE log_level = 'error'
        ORDER BY created_at DESC
        LIMIT 5
    `);
    
    // Get subscription statistics
    const subscriptionStatsResult = await query(`
        SELECT 
            subscription_plan,
            COUNT(*) as count,
            COUNT(CASE WHEN subscription_expires_at > NOW() THEN 1 END) as active_subscriptions
        FROM users
        WHERE admin_role IS NULL
        GROUP BY subscription_plan
    `);
    
    // Get connected users info
    const connectedUsers = getConnectedUsers();
    
    const dashboardData = {
        userStats: {
            total: parseInt(userStatsResult.rows[0].total_users),
            active: parseInt(userStatsResult.rows[0].active_users),
            suspended: parseInt(userStatsResult.rows[0].suspended_users),
            trial: parseInt(userStatsResult.rows[0].trial_users),
            recentLogins: parseInt(userStatsResult.rows[0].recent_logins),
            newThisWeek: parseInt(userStatsResult.rows[0].new_users_week),
            newThisMonth: parseInt(userStatsResult.rows[0].new_users_month)
        },
        tradingStats: {
            totalTraders: parseInt(tradingStatsResult.rows[0].total_traders),
            activeTraders: parseInt(tradingStatsResult.rows[0].active_traders),
            autoTraders: parseInt(tradingStatsResult.rows[0].auto_traders),
            avgExchangesConnected: parseFloat(tradingStatsResult.rows[0].avg_exchanges_connected || 0),
            totalTrades: parseInt(tradingStatsResult.rows[0].total_trades_platform),
            successfulTrades: parseInt(tradingStatsResult.rows[0].successful_trades_platform),
            failedTrades: parseInt(tradingStatsResult.rows[0].failed_trades_platform),
            totalProfit: parseFloat(tradingStatsResult.rows[0].total_platform_profit || 0),
            activeToday: parseInt(tradingStatsResult.rows[0].active_today)
        },
        messageStats: {
            userMessages: parseInt(messageStatsResult.rows[0].user_messages),
            unreadMessages: parseInt(messageStatsResult.rows[0].unread_messages),
            messagesToday: parseInt(messageStatsResult.rows[0].messages_today),
            adminReplies: parseInt(messageStatsResult.rows[0].admin_replies),
            highPriorityMessages: parseInt(messageStatsResult.rows[0].high_priority_messages)
        },
        systemActivity: systemActivityResult.rows.map(row => ({
            type: row.activity_type,
            count: parseInt(row.count)
        })),
        recentErrors: errorLogsResult.rows.map(row => ({
            type: row.log_type,
            message: row.message,
            timestamp: row.created_at,
            userId: row.user_id
        })),
        subscriptionStats: subscriptionStatsResult.rows.map(row => ({
            plan: row.subscription_plan,
            count: parseInt(row.count),
            activeCount: parseInt(row.active_subscriptions)
        })),
        connectedUsers: {
            total: connectedUsers.length,
            admins: connectedUsers.filter(u => u.isAdmin).length,
            regularUsers: connectedUsers.filter(u => !u.isAdmin).length,
            users: connectedUsers
        },
        timestamp: new Date()
    };
    
    systemLogger.admin('Dashboard data accessed', {
        adminId: req.user.id,
        timestamp: new Date()
    });
    
    res.json({
        success: true,
        data: dashboardData
    });
}));

// Apply authentication middleware to all following routes
router.use(authenticateUser);
router.use(requireAdmin);

// GET /api/v1/admin/users - Get all users with pagination and filters
router.get('/users', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all'; // active, suspended, trial, all
    const sortBy = req.query.sortBy || 'created_at'; // created_at, last_login_at, email
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = req.query.search ? `%${req.query.search}%` : null;
    
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramIndex = 1;
    
    if (status !== 'all') {
        whereClause += ` AND u.account_status = $${paramIndex++}`;
        queryParams.push(status);
    }
    
    if (search) {
        whereClause += ` AND (u.first_name ILIKE $${paramIndex++} OR u.last_name ILIKE $${paramIndex++} OR u.email ILIKE $${paramIndex++})`;
        queryParams.push(search, search, search);
    }
    
    // Add pagination parameters
    queryParams.push(limit, offset);
    
    const usersResult = await query(`
        SELECT 
            u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
            u.account_status, u.subscription_plan, u.subscription_expires_at,
            u.payment_reference,
            u.created_at, u.updated_at, u.last_login_at,
            ta.exchanges_connected_count, ta.trading_active, ta.auto_trading_enabled,
            ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
            ta.last_trading_activity
        FROM users u
        LEFT JOIN trading_activity ta ON u.id = ta.user_id
        ${whereClause}
        ORDER BY u.${sortBy} ${sortOrder}
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, queryParams);
    
    // Get total count for pagination
    const countParams = queryParams.slice(0, -2); // Remove limit and offset
    const countResult = await query(`
        SELECT COUNT(*) as total
        FROM users u
        ${whereClause.replace(/\$(\d+)/g, (match, num) => {
            const newNum = parseInt(num);
            return newNum <= countParams.length ? match : '';
        })}
    `, countParams);
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    const users = usersResult.rows.map(row => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        mobile: row.mobile,
        country: row.country,
        accountStatus: row.account_status,
        subscriptionPlan: row.subscription_plan,
        subscriptionExpiresAt: row.subscription_expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastLoginAt: row.last_login_at,
        tradingInfo: {
            exchangesConnectedCount: row.exchanges_connected_count || 0,
            tradingActive: row.trading_active || false,
            autoTradingEnabled: row.auto_trading_enabled || false,
            totalTrades: row.total_trades_count || 0,
            successfulTrades: row.successful_trades_count || 0,
            profitLoss: parseFloat(row.profit_loss_total || 0),
            lastTradingActivity: row.last_trading_activity
        }
    }));
    
    res.json({
        success: true,
        data: {
            users,
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// GET /api/v1/admin/users/:userId - Get specific user details
router.get('/users/:userId', asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    
    // Get user details with trading activity
    const userResult = await query(`
        SELECT 
            u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
            u.account_status, u.subscription_plan, u.subscription_expires_at,
            u.created_at, u.updated_at, u.last_login_at,
            ta.exchanges_connected, ta.exchanges_connected_count, ta.selected_crypto_assets,
            ta.trading_active, ta.auto_trading_enabled, ta.total_trades_count,
            ta.successful_trades_count, ta.failed_trades_count, ta.profit_loss_total,
            ta.api_keys_configured, ta.usdt_balance_detected, ta.safety_controls_completed,
            ta.auto_trading_readiness_percent, ta.last_trading_activity
        FROM users u
        LEFT JOIN trading_activity ta ON u.id = ta.user_id
        WHERE u.id = $1
    `, [userId]);
    
    if (userResult.rows.length === 0) {
        throw new APIError('User not found', 404, 'USER_NOT_FOUND');
    }
    
    const user = userResult.rows[0];
    
    // Get recent user activity
    const activityResult = await query(`
        SELECT activity_type, activity_details, ip_address, created_at
        FROM user_activity
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
    `, [userId]);
    
    // Get recent messages from this user
    const messagesResult = await query(`
        SELECT id, subject, content, priority, status, created_at
        FROM messages
        WHERE user_id = $1 AND message_type = 'user_to_admin'
        ORDER BY created_at DESC
        LIMIT 10
    `, [userId]);
    
    // Get profile change history
    const profileChangesResult = await query(`
        SELECT field_name, old_value, new_value, ip_address, created_at
        FROM profile_updates
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 10
    `, [userId]);
    
    const userDetails = {
        profile: {
            id: user.id,
            firstName: user.first_name,
            lastName: user.last_name,
            email: user.email,
            mobile: user.mobile,
            country: user.country,
            accountStatus: user.account_status,
            subscriptionPlan: user.subscription_plan,
            subscriptionExpiresAt: user.subscription_expires_at,
            createdAt: user.created_at,
            updatedAt: user.updated_at,
            lastLoginAt: user.last_login_at
        },
        tradingActivity: {
            exchangesConnected: JSON.parse(user.exchanges_connected || '[]'),
            exchangesConnectedCount: user.exchanges_connected_count || 0,
            selectedCryptoAssets: JSON.parse(user.selected_crypto_assets || '[]'),
            tradingActive: user.trading_active || false,
            autoTradingEnabled: user.auto_trading_enabled || false,
            totalTrades: user.total_trades_count || 0,
            successfulTrades: user.successful_trades_count || 0,
            failedTrades: user.failed_trades_count || 0,
            profitLoss: parseFloat(user.profit_loss_total || 0),
            apiKeysConfigured: user.api_keys_configured || false,
            usdtBalanceDetected: user.usdt_balance_detected || false,
            safetyControlsCompleted: user.safety_controls_completed || false,
            autoTradingReadinessPercent: user.auto_trading_readiness_percent || 0,
            lastTradingActivity: user.last_trading_activity
        },
        recentActivity: activityResult.rows.map(row => ({
            type: row.activity_type,
            details: row.activity_details,
            ipAddress: row.ip_address,
            timestamp: row.created_at
        })),
        recentMessages: messagesResult.rows.map(row => ({
            id: row.id,
            subject: row.subject,
            content: row.content,
            priority: row.priority,
            status: row.status,
            timestamp: row.created_at
        })),
        profileChanges: profileChangesResult.rows.map(row => ({
            fieldName: row.field_name,
            oldValue: row.old_value,
            newValue: row.new_value,
            ipAddress: row.ip_address,
            timestamp: row.created_at
        }))
    };
    
    systemLogger.admin('User details accessed', {
        adminId: req.user.id,
        targetUserId: userId
    });
    
    res.json({
        success: true,
        data: userDetails
    });
}));

// PUT /api/v1/admin/users/:userId/status - Update user account status
router.put('/users/:userId/status', requireAdminRole('manager'), [
    body('status').isIn(['active', 'suspended', 'trial']).withMessage('Invalid status'),
    body('reason').optional().trim().isLength({ min: 5, max: 500 }).withMessage('Reason must be 5-500 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const userId = req.params.userId;
    const { status, reason } = req.body;
    
    await transaction(async (client) => {
        // Verify user exists and is not admin
        const userResult = await client.query(
            'SELECT id, first_name, last_name, email, account_status FROM users WHERE id = $1 AND admin_role IS NULL',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('User not found', 404, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        const oldStatus = user.account_status;
        
        // Update user status
        await client.query(
            'UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [status, userId]
        );
        
        // Log admin action
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'admin_user_status_changed', {
                targetUserId: userId,
                targetUserEmail: user.email,
                oldStatus,
                newStatus: status,
                reason
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify user if connected
        notifyUser(userId, 'account_status_changed', {
            newStatus: status,
            reason: reason || 'No reason provided',
            timestamp: new Date()
        });
        
        systemLogger.admin('User status changed', {
            adminId: req.user.id,
            targetUserId: userId,
            oldStatus,
            newStatus: status,
            reason
        });
        
        res.json({
            success: true,
            data: {
                userId,
                oldStatus,
                newStatus: status,
                reason
            },
            message: 'User status updated successfully'
        });
    });
}));

// POST /api/v1/admin/users/:userId/message - Send direct message to user
router.post('/users/:userId/message', [
    body('subject').trim().isLength({ min: 5, max: 255 }).withMessage('Subject must be 5-255 characters'),
    body('content').trim().isLength({ min: 10, max: 5000 }).withMessage('Content must be 10-5000 characters'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const userId = req.params.userId;
    const { subject, content, priority = 'medium' } = req.body;
    
    await transaction(async (client) => {
        // Verify user exists
        const userResult = await client.query(
            'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND admin_role IS NULL AND account_status = $2',
            [userId, 'active']
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('User not found or inactive', 404, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        // Insert message
        const messageResult = await client.query(
            `INSERT INTO messages (user_id, subject, content, priority, message_type, admin_user_id, status) 
             VALUES ($1, $2, $3, $4, 'admin_to_user', $5, 'delivered') 
             RETURNING id, created_at, thread_id`,
            [userId, subject, content, priority, req.user.id]
        );
        
        const message = messageResult.rows[0];
        
        // Log admin activity
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'admin_direct_message', {
                targetUserId: userId,
                messageId: message.id,
                subject,
                priority
            }, req.ip, req.get('User-Agent')]
        );
        
        // Send real-time notification
        const notificationData = {
            id: message.id,
            threadId: message.thread_id,
            from: `Admin: ${req.user.first_name} ${req.user.last_name}`,
            subject,
            content,
            priority,
            timestamp: message.created_at,
            type: 'admin_to_user'
        };
        
        notifyUser(userId, 'admin_message', notificationData);
        
        systemLogger.admin('Direct message sent to user', {
            adminId: req.user.id,
            targetUserId: userId,
            messageId: message.id,
            subject,
            priority
        });
        
        res.status(201).json({
            success: true,
            data: {
                message: {
                    id: message.id,
                    threadId: message.thread_id,
                    targetUser: `${user.first_name} ${user.last_name}`,
                    subject,
                    content,
                    priority,
                    timestamp: message.created_at
                }
            },
            message: 'Message sent successfully'
        });
    });
}));

// GET /api/v1/admin/messages - Get all user messages for admin review
router.get('/messages', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all'; // sent, read, replied, all
    const priority = req.query.priority || 'all'; // low, medium, high, critical, all
    
    let whereClause = 'WHERE m.message_type = \'user_to_admin\'';
    const queryParams = [];
    let paramIndex = 1;
    
    if (status !== 'all') {
        whereClause += ` AND m.status = $${paramIndex++}`;
        queryParams.push(status);
    }
    
    if (priority !== 'all') {
        whereClause += ` AND m.priority = $${paramIndex++}`;
        queryParams.push(priority);
    }
    
    queryParams.push(limit, offset);
    
    const messagesResult = await query(`
        SELECT 
            m.id, m.subject, m.content, m.priority, m.status, m.created_at, m.thread_id,
            m.admin_read_at, m.admin_replied_at, m.admin_user_id,
            u.first_name, u.last_name, u.email,
            admin_u.first_name as admin_first_name, admin_u.last_name as admin_last_name
        FROM messages m
        JOIN users u ON m.user_id = u.id
        LEFT JOIN users admin_u ON m.admin_user_id = admin_u.id
        ${whereClause}
        ORDER BY 
            CASE WHEN m.priority = 'critical' THEN 1
                 WHEN m.priority = 'high' THEN 2
                 WHEN m.priority = 'medium' THEN 3
                 ELSE 4 END,
            m.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, queryParams);
    
    // Get total count
    const countParams = queryParams.slice(0, -2);
    const countResult = await query(`
        SELECT COUNT(*) as total
        FROM messages m
        ${whereClause.replace(/\$(\d+)/g, (match, num) => {
            const newNum = parseInt(num);
            return newNum <= countParams.length ? match : '';
        })}
    `, countParams);
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    const messages = messagesResult.rows.map(row => ({
        id: row.id,
        threadId: row.thread_id,
        subject: row.subject,
        content: row.content,
        priority: row.priority,
        status: row.status,
        timestamp: row.created_at,
        sender: {
            name: `${row.first_name} ${row.last_name}`,
            email: row.email
        },
        adminInfo: {
            readAt: row.admin_read_at,
            repliedAt: row.admin_replied_at,
            handledBy: row.admin_first_name ? `${row.admin_first_name} ${row.admin_last_name}` : null
        }
    }));
    
    res.json({
        success: true,
        data: {
            messages,
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// GET /api/v1/admin/analytics - Get platform analytics
router.get('/analytics', asyncHandler(async (req, res) => {
    const timeRange = req.query.range || '30d'; // 7d, 30d, 90d, 1y
    
    let interval = '30 days';
    let groupBy = 'day';
    
    switch (timeRange) {
        case '7d':
            interval = '7 days';
            groupBy = 'day';
            break;
        case '30d':
            interval = '30 days';
            groupBy = 'day';
            break;
        case '90d':
            interval = '90 days';
            groupBy = 'week';
            break;
        case '1y':
            interval = '1 year';
            groupBy = 'month';
            break;
    }
    
    // User registration trends
    const userTrendsResult = await query(`
        SELECT 
            DATE_TRUNC('${groupBy}', created_at) as period,
            COUNT(*) as registrations
        FROM users
        WHERE created_at > NOW() - INTERVAL '${interval}' AND admin_role IS NULL
        GROUP BY period
        ORDER BY period
    `);
    
    // Trading activity trends
    const tradingTrendsResult = await query(`
        SELECT 
            DATE_TRUNC('${groupBy}', last_trading_activity) as period,
            COUNT(DISTINCT user_id) as active_traders,
            SUM(total_trades_count) as total_trades,
            SUM(profit_loss_total) as total_profit
        FROM trading_activity
        WHERE last_trading_activity > NOW() - INTERVAL '${interval}'
        GROUP BY period
        ORDER BY period
    `);
    
    // Message volume trends
    const messageTrendsResult = await query(`
        SELECT 
            DATE_TRUNC('${groupBy}', created_at) as period,
            COUNT(CASE WHEN message_type = 'user_to_admin' THEN 1 END) as user_messages,
            COUNT(CASE WHEN message_type = 'admin_to_user' THEN 1 END) as admin_replies
        FROM messages
        WHERE created_at > NOW() - INTERVAL '${interval}'
        GROUP BY period
        ORDER BY period
    `);
    
    // Exchange usage statistics
    const exchangeStatsResult = await query(`
        SELECT 
            JSONB_ARRAY_ELEMENTS_TEXT(exchanges_connected) as exchange_name,
            COUNT(*) as usage_count
        FROM trading_activity
        WHERE exchanges_connected IS NOT NULL AND exchanges_connected != '[]'
        GROUP BY exchange_name
        ORDER BY usage_count DESC
    `);
    
    // Top crypto assets
    const assetStatsResult = await query(`
        SELECT 
            JSONB_ARRAY_ELEMENTS_TEXT(selected_crypto_assets) as asset_name,
            COUNT(*) as selection_count
        FROM trading_activity
        WHERE selected_crypto_assets IS NOT NULL AND selected_crypto_assets != '[]'
        GROUP BY asset_name
        ORDER BY selection_count DESC
        LIMIT 20
    `);
    
    const analytics = {
        timeRange,
        userTrends: userTrendsResult.rows.map(row => ({
            period: row.period,
            registrations: parseInt(row.registrations)
        })),
        tradingTrends: tradingTrendsResult.rows.map(row => ({
            period: row.period,
            activeTraders: parseInt(row.active_traders),
            totalTrades: parseInt(row.total_trades),
            totalProfit: parseFloat(row.total_profit || 0)
        })),
        messageTrends: messageTrendsResult.rows.map(row => ({
            period: row.period,
            userMessages: parseInt(row.user_messages),
            adminReplies: parseInt(row.admin_replies)
        })),
        exchangeUsage: exchangeStatsResult.rows.map(row => ({
            exchange: row.exchange_name,
            users: parseInt(row.usage_count)
        })),
        popularAssets: assetStatsResult.rows.map(row => ({
            asset: row.asset_name,
            selections: parseInt(row.selection_count)
        }))
    };
    
    systemLogger.admin('Analytics accessed', {
        adminId: req.user.id,
        timeRange
    });
    
    res.json({
        success: true,
        data: analytics
    });
}));

// POST /api/v1/admin/promote - Promote user to admin (master admin only)
router.post('/promote', requireAdminRole('master'), [
    body('userId').notEmpty().withMessage('User ID is required'),
    body('adminRole').isIn(['support', 'manager', 'admin']).withMessage('Invalid admin role'),
    body('adminPin').isLength({ min: 6, max: 20 }).withMessage('Admin PIN must be 6-20 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { userId, adminRole, adminPin } = req.body;
    
    await transaction(async (client) => {
        // Verify target user exists and is not already admin
        const userResult = await client.query(
            'SELECT id, first_name, last_name, email, admin_role FROM users WHERE id = $1',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('User not found', 404, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        if (user.admin_role) {
            throw new APIError('User is already an admin', 400, 'ALREADY_ADMIN');
        }
        
        // Hash admin PIN (using same method as passwords)
        const bcrypt = require('bcrypt');
        const adminPinHash = await bcrypt.hash(adminPin, 12);
        
        // Promote user
        await client.query(
            `UPDATE users 
             SET admin_role = $1, admin_pin = $2, admin_promoted_by = $3, admin_promoted_date = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [adminRole, adminPinHash, req.user.id, userId]
        );
        
        // Log the promotion
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'admin_user_promoted', {
                promotedUserId: userId,
                promotedUserEmail: user.email,
                newAdminRole: adminRole
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify the promoted user
        notifyUser(userId, 'admin_promotion', {
            role: adminRole,
            promotedBy: `${req.user.first_name} ${req.user.last_name}`,
            timestamp: new Date()
        });
        
        systemLogger.admin('User promoted to admin', {
            masterAdminId: req.user.id,
            promotedUserId: userId,
            newRole: adminRole
        });
        
        res.json({
            success: true,
            data: {
                promotedUser: {
                    id: user.id,
                    name: `${user.first_name} ${user.last_name}`,
                    email: user.email,
                    newRole: adminRole
                }
            },
            message: 'User promoted to admin successfully'
        });
    });
}));

// Admin compose message endpoint with proper authentication
router.post('/compose-test', authenticateUser, requireAdmin, asyncHandler(async (req, res) => {
    const { targetUserId, subject, content, priority = 'medium' } = req.body;
    
    if (!targetUserId || !subject || !content) {
        return res.status(400).json({
            success: false,
            error: { message: 'targetUserId, subject, and content are required' }
        });
    }
    
    try {
        // Verify target user exists
        const userResult = await query(
            'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND account_status = $2',
            [targetUserId, 'active']
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: { message: 'Target user not found or inactive' }
            });
        }
        
        const targetUser = userResult.rows[0];
        
        // Insert admin-initiated message
        const messageResult = await query(
            `INSERT INTO messages (user_id, subject, content, priority, message_type, admin_user_id, status) 
             VALUES ($1, $2, $3, $4, 'admin_to_user', $5, 'delivered') 
             RETURNING id, created_at, thread_id`,
            [targetUserId, subject, content, priority, 'user_admin_master'] // Using system admin ID
        );
        
        const message = messageResult.rows[0];
        
        res.status(201).json({
            success: true,
            data: {
                message: {
                    id: message.id,
                    threadId: message.thread_id,
                    targetUser: `${targetUser.first_name} ${targetUser.last_name}`,
                    targetEmail: targetUser.email,
                    subject,
                    content,
                    priority,
                    timestamp: message.created_at
                }
            },
            message: 'Message sent successfully'
        });
        
    } catch (error) {
        console.error('❌ Admin compose error:', error);
        res.status(500).json({
            success: false,
            error: { message: 'Failed to send message' }
        });
    }
}));

// POST /api/v1/admin/users/:userId/status - Update user account status
router.post('/users/:userId/status', authenticateUser, requireAdmin, requirePermission('users.suspend'), asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['active', 'suspended', 'trial', 'deleted'];
    if (!status || !validStatuses.includes(status)) {
        throw new APIError('Invalid status. Must be: active, suspended, trial, or deleted', 400, 'INVALID_STATUS');
    }
    
    // Get current user state before update
    const beforeResult = await query(
        'SELECT id, account_status, first_name, last_name, email FROM users WHERE id = $1',
        [userId]
    );
    
    if (beforeResult.rows.length === 0) {
        throw new APIError('User not found', 404, 'USER_NOT_FOUND');
    }
    
    const beforeState = beforeResult.rows[0];
    
    // Update user status
    const result = await query(
        'UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, account_status, first_name, last_name',
        [status, userId]
    );
    
    const user = result.rows[0];
    
    // Enhanced logging with before/after states
    await logAdminActivity(
        req.user.id,
        `user_status_changed`,
        'user',
        userId,
        {
            action: 'status_change',
            user_name: `${user.first_name} ${user.last_name}`,
            old_status: beforeState.account_status,
            new_status: status,
            reason: req.body.reason || 'No reason provided'
        },
        req.ip,
        req.get('User-Agent'),
        {
            category: 'user_management',
            severity: status === 'deleted' ? 'high' : 'medium',
            beforeState: { account_status: beforeState.account_status },
            afterState: { account_status: status }
        }
    );
    
    res.json({
        success: true,
        data: {
            userId: user.id,
            newStatus: user.account_status,
            userName: `${user.first_name} ${user.last_name}`
        },
        message: `User status updated to ${status}`
    });
}));

// Bulk user status operations
router.post('/users/bulk/activate', authenticateUser, requireAdmin, requirePermission('users.bulk_operations'), asyncHandler(async (req, res) => {
    const { userIds } = req.body;
    
    // Validate input
    if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new APIError('User IDs array is required and cannot be empty', 400, 'INVALID_USER_IDS');
    }
    
    if (userIds.length > 100) {
        throw new APIError('Cannot process more than 100 users at once', 400, 'TOO_MANY_USERS');
    }
    
    const results = {
        success: [],
        failed: [],
        total: userIds.length
    };
    
    // Process in transaction
    await transaction(async (client) => {
        for (const userId of userIds) {
            try {
                const result = await client.query(
                    'UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, account_status, first_name, last_name',
                    ['active', userId]
                );
                
                if (result.rows.length > 0) {
                    const user = result.rows[0];
                    results.success.push({
                        userId: user.id,
                        status: user.account_status,
                        name: `${user.first_name} ${user.last_name}`
                    });
                } else {
                    results.failed.push({
                        userId,
                        error: 'User not found'
                    });
                }
            } catch (error) {
                results.failed.push({
                    userId,
                    error: error.message
                });
            }
        }
    });
    
    // Enhanced logging for bulk operations
    await logAdminActivity(
        req.user.id,
        'bulk_users_activated',
        'bulk_operation',
        null,
        {
            action: 'bulk_activate',
            total_users: userIds.length,
            successful: results.success.length,
            failed: results.failed.length,
            user_ids: userIds,
            results: results
        },
        req.ip,
        req.get('User-Agent'),
        {
            category: 'bulk_operations',
            severity: 'high',
            beforeState: null,
            afterState: { activated_users: results.success.map(u => u.userId) }
        }
    );
    
    res.json({
        success: true,
        data: results,
        message: `Bulk activation completed: ${results.success.length} successful, ${results.failed.length} failed`
    });
}));

router.post('/users/bulk/suspend', authenticateUser, requireAdmin, requirePermission('users.bulk_operations'), asyncHandler(async (req, res) => {
    const { userIds } = req.body;
    
    // Validate input
    if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new APIError('User IDs array is required and cannot be empty', 400, 'INVALID_USER_IDS');
    }
    
    if (userIds.length > 100) {
        throw new APIError('Cannot process more than 100 users at once', 400, 'TOO_MANY_USERS');
    }
    
    const results = {
        success: [],
        failed: [],
        total: userIds.length
    };
    
    // Process in transaction
    await transaction(async (client) => {
        for (const userId of userIds) {
            try {
                const result = await client.query(
                    'UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, account_status, first_name, last_name',
                    ['suspended', userId]
                );
                
                if (result.rows.length > 0) {
                    const user = result.rows[0];
                    results.success.push({
                        userId: user.id,
                        status: user.account_status,
                        name: `${user.first_name} ${user.last_name}`
                    });
                } else {
                    results.failed.push({
                        userId,
                        error: 'User not found'
                    });
                }
            } catch (error) {
                results.failed.push({
                    userId,
                    error: error.message
                });
            }
        }
    });
    
    // Enhanced logging for bulk suspension
    await logAdminActivity(
        req.user.id,
        'bulk_users_suspended',
        'bulk_operation',
        null,
        {
            action: 'bulk_suspend',
            total_users: userIds.length,
            successful: results.success.length,
            failed: results.failed.length,
            user_ids: userIds,
            results: results
        },
        req.ip,
        req.get('User-Agent'),
        {
            category: 'bulk_operations',
            severity: 'high',
            beforeState: null,
            afterState: { suspended_users: results.success.map(u => u.userId) }
        }
    );
    
    res.json({
        success: true,
        data: results,
        message: `Bulk suspension completed: ${results.success.length} successful, ${results.failed.length} failed`
    });
}));

// Admin role management endpoints
router.get('/roles/permissions', authenticateUser, requireAdmin, requirePermission('admins.view'), asyncHandler(async (req, res) => {
    // Get all role permissions
    const permissions = await query(
        'SELECT role_name, permission_name, description FROM admin_permissions ORDER BY role_name, permission_name'
    );
    
    // Group by role
    const rolePermissions = {};
    permissions.rows.forEach(perm => {
        if (!rolePermissions[perm.role_name]) {
            rolePermissions[perm.role_name] = [];
        }
        rolePermissions[perm.role_name].push({
            permission: perm.permission_name,
            description: perm.description
        });
    });
    
    res.json({
        success: true,
        data: rolePermissions,
        message: 'Role permissions retrieved successfully'
    });
}));

router.get('/admins', authenticateUser, requireAdmin, requirePermission('admins.view'), asyncHandler(async (req, res) => {
    // Get all admin users
    const admins = await query(`
        SELECT id, first_name, last_name, email, admin_role, 
               admin_promoted_by, admin_promoted_date, admin_last_access,
               created_at
        FROM users 
        WHERE admin_role IS NOT NULL 
        ORDER BY 
            CASE admin_role 
                WHEN 'master' THEN 1 
                WHEN 'admin' THEN 2 
                WHEN 'manager' THEN 3 
                WHEN 'support' THEN 4 
            END,
            created_at DESC
    `);
    
    res.json({
        success: true,
        data: admins.rows,
        message: 'Admin users retrieved successfully'
    });
}));

router.post('/admins/:userId/promote', authenticateUser, requireAdmin, requireMaster, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { newRole } = req.body;
    
    // Validate new role
    const validRoles = ['support', 'manager', 'admin'];
    if (!validRoles.includes(newRole)) {
        throw new APIError('Invalid admin role', 400, 'INVALID_ROLE');
    }
    
    // Note: Simple confirmation handled on frontend
    
    await transaction(async (client) => {
        // Check if user exists
        const userResult = await client.query(
            'SELECT id, first_name, last_name, email, admin_role FROM users WHERE id = $1',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('User not found', 404, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        // Update user admin role
        await client.query(`
            UPDATE users SET 
                admin_role = $1,
                admin_promoted_by = $2,
                admin_promoted_date = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
        `, [newRole, req.user.id, userId]);
        
        // Enhanced logging for admin promotion
        await client.query(`
            SELECT log_admin_activity_enhanced($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
            req.user.id,
            'admin_promoted',
            'admin_actions',
            'high',
            'user',
            userId,
            JSON.stringify({
                previous_role: user.admin_role,
                new_role: newRole,
                user_name: `${user.first_name} ${user.last_name}`,
                promoted_by: `${req.user.first_name} ${req.user.last_name}`
            }),
            JSON.stringify({ admin_role: user.admin_role }),
            JSON.stringify({ admin_role: newRole }),
            req.ip,
            req.get('User-Agent')
        ]);
    });
    
    console.log(`User ${userId} promoted to ${newRole} role`);
    
    res.json({
        success: true,
        data: { userId, newRole },
        message: `User promoted to ${newRole} role successfully`
    });
}));

router.post('/admins/:userId/demote', authenticateUser, requireAdmin, requireMaster, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    
    // Note: Simple confirmation handled on frontend
    
    await transaction(async (client) => {
        // Check if user exists and is admin
        const userResult = await client.query(
            'SELECT id, first_name, last_name, email, admin_role FROM users WHERE id = $1 AND admin_role IS NOT NULL',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('Admin user not found', 404, 'ADMIN_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        // Cannot demote master admin
        if (user.admin_role === 'master') {
            throw new APIError('Cannot demote master admin', 403, 'CANNOT_DEMOTE_MASTER');
        }
        
        // Remove admin role
        await client.query(`
            UPDATE users SET 
                admin_role = NULL,
                admin_promoted_by = NULL,
                admin_promoted_date = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [userId]);
        
        // Enhanced logging for admin demotion
        await client.query(`
            SELECT log_admin_activity_enhanced($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
            req.user.id,
            'admin_demoted',
            'admin_actions',
            'high',
            'user',
            userId,
            JSON.stringify({
                previous_role: user.admin_role,
                user_name: `${user.first_name} ${user.last_name}`,
                demoted_by: `${req.user.first_name} ${req.user.last_name}`
            }),
            JSON.stringify({ admin_role: user.admin_role }),
            JSON.stringify({ admin_role: null }),
            req.ip,
            req.get('User-Agent')
        ]);
    });
    
    console.log(`User ${userId} demoted from admin role`);
    
    res.json({
        success: true,
        data: { userId },
        message: 'User demoted from admin role successfully'
    });
}));

router.get('/activity-log', authenticateUser, requireAdmin, requirePermission('system.logs'), asyncHandler(async (req, res) => {
    const { 
        limit = 50, 
        offset = 0,
        startDate,
        endDate,
        adminUserId,
        category,
        severity
    } = req.query;
    
    // Use the enhanced query function for filtering
    const logs = await query(`
        SELECT * FROM get_activity_logs($1, $2, $3, $4, $5, $6, $7)
    `, [
        startDate || null,
        endDate || null,
        adminUserId || null,
        category || null,
        severity || null,
        parseInt(limit),
        parseInt(offset)
    ]);
    
    // Get total count for pagination
    const countResult = await query(`
        SELECT COUNT(*) as total
        FROM admin_activity_log al
        WHERE 
            ($1::TIMESTAMP IS NULL OR al.created_at >= $1) AND
            ($2::TIMESTAMP IS NULL OR al.created_at <= $2) AND
            ($3::VARCHAR IS NULL OR al.admin_user_id = $3) AND
            ($4::VARCHAR IS NULL OR al.category = $4) AND
            ($5::VARCHAR IS NULL OR al.severity = $5)
    `, [startDate, endDate, adminUserId, category, severity]);
    
    res.json({
        success: true,
        data: {
            logs: logs.rows,
            total: parseInt(countResult.rows[0].total),
            page: Math.floor(offset / limit) + 1,
            limit: limit
        },
        message: 'Admin activity log retrieved successfully'
    });
}));

// GET /api/v1/admin/reports/export - Enhanced export functionality
router.get('/reports/export', authenticateUser, requireAdmin, requirePermission('system.logs'), asyncHandler(async (req, res) => {
    const { 
        format = 'csv',
        startDate,
        endDate,
        adminUserId,
        category,
        severity,
        reportType = 'activity_log'
    } = req.query;
    
    // Validate format
    if (!['csv', 'json', 'pdf'].includes(format)) {
        throw new APIError('Invalid export format. Supported: csv, json, pdf', 400, 'INVALID_FORMAT');
    }
    
    let logs, filename, contentType, content;
    
    if (reportType === 'activity_log') {
        // Get filtered logs for export
        logs = await query(`
            SELECT * FROM get_activity_logs($1, $2, $3, $4, $5, $6, $7)
        `, [
            startDate || null,
            endDate || null, 
            adminUserId || null,
            category || null,
            severity || null,
            10000, // Large limit for export
            0
        ]);
        
        const timestamp = new Date().toISOString().split('T')[0];
        
        switch (format) {
            case 'csv':
                filename = `activity_log_${timestamp}.csv`;
                contentType = 'text/csv';
                content = generateCSV(logs.rows);
                break;
                
            case 'json':
                filename = `activity_log_${timestamp}.json`;
                contentType = 'application/json';
                content = JSON.stringify({
                    exportDate: new Date().toISOString(),
                    filters: { startDate, endDate, adminUserId, category, severity },
                    totalRecords: logs.rows.length,
                    data: logs.rows
                }, null, 2);
                break;
                
            case 'pdf':
                // For now, return structured data that frontend can convert to PDF
                filename = `activity_log_${timestamp}.json`;
                contentType = 'application/json';
                content = JSON.stringify({
                    reportType: 'Activity Log Report',
                    generatedBy: `${req.user.first_name} ${req.user.last_name}`,
                    generatedAt: new Date().toISOString(),
                    filters: { startDate, endDate, adminUserId, category, severity },
                    summary: {
                        totalEvents: logs.rows.length,
                        criticalEvents: logs.rows.filter(l => l.severity === 'critical').length,
                        highEvents: logs.rows.filter(l => l.severity === 'high').length,
                        categories: [...new Set(logs.rows.map(l => l.category))],
                        admins: [...new Set(logs.rows.map(l => l.admin_name))]
                    },
                    data: logs.rows
                }, null, 2);
                break;
        }
    }
    
    // Log the export activity
    await logAdminActivity(
        req.user.id,
        'data_export',
        'system',
        reportType,
        {
            format,
            recordCount: logs.rows.length,
            filters: { startDate, endDate, adminUserId, category, severity }
        },
        req.ip,
        req.get('User-Agent'),
        {
            category: 'data_export',
            severity: 'medium'
        }
    );
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
    res.send(content);
}));

// GET /api/v1/admin/reports/summary - Generate summary reports
router.get('/reports/summary', authenticateUser, requireAdmin, requirePermission('system.logs'), asyncHandler(async (req, res) => {
    const { 
        period = '30d',
        type = 'security'
    } = req.query;
    
    let days;
    switch (period) {
        case '7d': days = 7; break;
        case '30d': days = 30; break;
        case '90d': days = 90; break;
        default: days = 30;
    }
    
    if (type === 'security') {
        // Security summary report
        const securityEvents = await query(`
            SELECT 
                event_type,
                severity,
                COUNT(*) as event_count,
                COUNT(*) FILTER (WHERE resolved = FALSE) as unresolved_count,
                MAX(created_at) as last_occurrence
            FROM security_events 
            WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '${days} days'
            GROUP BY event_type, severity
            ORDER BY event_count DESC
        `);
        
        const adminActivity = await query(`
            SELECT 
                category,
                severity,
                COUNT(*) as activity_count,
                COUNT(DISTINCT admin_user_id) as unique_admins
            FROM admin_activity_log 
            WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '${days} days'
            GROUP BY category, severity
            ORDER BY activity_count DESC
        `);
        
        const topAdmins = await query(`
            SELECT 
                u.first_name || ' ' || u.last_name as admin_name,
                u.admin_role,
                COUNT(*) as activity_count
            FROM admin_activity_log al
            JOIN users u ON al.admin_user_id = u.id
            WHERE al.created_at >= CURRENT_TIMESTAMP - INTERVAL '${days} days'
            GROUP BY u.id, u.first_name, u.last_name, u.admin_role
            ORDER BY activity_count DESC
            LIMIT 10
        `);
        
        res.json({
            success: true,
            data: {
                reportType: 'Security Summary',
                period: `${days} days`,
                generatedAt: new Date().toISOString(),
                securityEvents: securityEvents.rows,
                adminActivity: adminActivity.rows,
                topActiveAdmins: topAdmins.rows
            },
            message: 'Security summary report generated successfully'
        });
    }
    
    // Log the report generation
    await logAdminActivity(
        req.user.id,
        'report_generated',
        'system',
        type,
        { period, reportType: type },
        req.ip,
        req.get('User-Agent'),
        {
            category: 'data_export',
            severity: 'info'
        }
    );
}));

// Helper function to generate CSV content
function generateCSV(rows) {
    if (rows.length === 0) return 'No data available';
    
    const headers = Object.keys(rows[0]);
    const csvContent = [
        headers.join(','),
        ...rows.map(row => 
            headers.map(header => {
                const value = row[header];
                if (value === null || value === undefined) return '';
                if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
                if (typeof value === 'string' && value.includes(',')) return `"${value.replace(/"/g, '""')}"`;
                return value;
            }).join(',')
        )
    ].join('\n');
    
    return csvContent;
}

// GET /api/v1/admin/security/dashboard - Security monitoring dashboard
router.get('/security/dashboard', authenticateUser, requireAdmin, requirePermission('security.monitor'), asyncHandler(async (req, res) => {
    const { period = '24h' } = req.query;
    
    let hours;
    switch (period) {
        case '1h': hours = 1; break;
        case '24h': hours = 24; break;
        case '7d': hours = 168; break;
        default: hours = 24;
    }
    
    // Get critical security metrics
    const criticalEvents = await query(`
        SELECT 
            event_type,
            COUNT(*) as count,
            MAX(created_at) as last_occurrence
        FROM security_events 
        WHERE severity = 'critical' 
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
        GROUP BY event_type
        ORDER BY count DESC
    `);
    
    const unresolvedEvents = await query(`
        SELECT 
            event_type,
            severity,
            COUNT(*) as count,
            MIN(created_at) as oldest_event
        FROM security_events 
        WHERE resolved = FALSE
        GROUP BY event_type, severity
        ORDER BY 
            CASE severity 
                WHEN 'critical' THEN 1 
                WHEN 'high' THEN 2 
                WHEN 'medium' THEN 3 
                ELSE 4 
            END,
            count DESC
    `);
    
    const recentFailedLogins = await query(`
        SELECT 
            ip_address,
            COUNT(*) as attempts,
            MAX(created_at) as last_attempt,
            COUNT(DISTINCT details->>'email') as unique_emails
        FROM security_events 
        WHERE event_type = 'failed_login'
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
        GROUP BY ip_address
        HAVING COUNT(*) >= 3
        ORDER BY attempts DESC
        LIMIT 10
    `);
    
    const adminSessions = await query(`
        SELECT 
            u.first_name || ' ' || u.last_name as admin_name,
            u.admin_role,
            s.ip_address,
            s.login_time,
            s.last_activity
        FROM user_sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.logout_time IS NULL 
        AND s.is_admin_session = TRUE
        AND s.last_activity >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
        ORDER BY s.last_activity DESC
    `);
    
    const threatIndicators = await query(`
        SELECT 
            'brute_force' as threat_type,
            COUNT(*) as incidents,
            'IP addresses with 5+ failed login attempts' as description
        FROM security_events 
        WHERE event_type = 'brute_force_detected'
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
        
        UNION ALL
        
        SELECT 
            'suspicious_activity' as threat_type,
            COUNT(*) as incidents,
            'Flagged suspicious admin activities' as description
        FROM security_events 
        WHERE event_type = 'suspicious_activity'
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
        
        UNION ALL
        
        SELECT 
            'unauthorized_access' as threat_type,
            COUNT(*) as incidents,
            'Unauthorized access attempts' as description
        FROM admin_activity_log 
        WHERE action = 'unauthorized_access_attempt'
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
    `);
    
    res.json({
        success: true,
        data: {
            period: period,
            generatedAt: new Date().toISOString(),
            criticalEvents: criticalEvents.rows,
            unresolvedEvents: unresolvedEvents.rows,
            recentFailedLogins: recentFailedLogins.rows,
            activeAdminSessions: adminSessions.rows,
            threatIndicators: threatIndicators.rows
        },
        message: 'Security dashboard data retrieved successfully'
    });
}));

// GET /api/v1/admin/security/alerts - Get active security alerts
router.get('/security/alerts', authenticateUser, requireAdmin, requirePermission('security.monitor'), asyncHandler(async (req, res) => {
    const activeAlerts = await query(`
        SELECT 
            se.id,
            se.event_type,
            se.severity,
            se.user_id,
            se.ip_address,
            se.details,
            se.created_at,
            u.first_name || ' ' || u.last_name as user_name
        FROM security_events se
        LEFT JOIN users u ON se.user_id = u.id
        WHERE se.resolved = FALSE
        AND se.severity IN ('critical', 'high')
        ORDER BY 
            CASE se.severity 
                WHEN 'critical' THEN 1 
                WHEN 'high' THEN 2 
                ELSE 3 
            END,
            se.created_at DESC
        LIMIT 50
    `);
    
    res.json({
        success: true,
        data: {
            alerts: activeAlerts.rows,
            totalUnresolved: activeAlerts.rows.length
        },
        message: 'Active security alerts retrieved successfully'
    });
}));

// POST /api/v1/admin/security/alerts/:alertId/resolve - Resolve security alert
router.post('/security/alerts/:alertId/resolve', authenticateUser, requireAdmin, requirePermission('security.manage'), asyncHandler(async (req, res) => {
    const { alertId } = req.params;
    const { resolution, notes } = req.body;
    
    await transaction(async (client) => {
        // Get the alert details first
        const alertResult = await client.query(
            'SELECT * FROM security_events WHERE id = $1',
            [alertId]
        );
        
        if (alertResult.rows.length === 0) {
            throw new APIError('Security alert not found', 404, 'ALERT_NOT_FOUND');
        }
        
        const alert = alertResult.rows[0];
        
        // Update the alert as resolved
        await client.query(
            'UPDATE security_events SET resolved = TRUE, resolved_by = $1, resolved_at = CURRENT_TIMESTAMP WHERE id = $2',
            [req.user.id, alertId]
        );
        
        // Log the resolution activity
        await logAdminActivity(
            req.user.id,
            'security_alert_resolved',
            'security',
            alertId,
            {
                alertType: alert.event_type,
                severity: alert.severity,
                resolution,
                notes
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'security',
                severity: 'medium'
            }
        );
        
        res.json({
            success: true,
            data: {
                alertId: alertId,
                resolvedBy: `${req.user.first_name} ${req.user.last_name}`,
                resolvedAt: new Date().toISOString(),
                resolution,
                notes
            },
            message: 'Security alert resolved successfully'
        });
    });
}));

// POST /api/v1/admin/security/incidents/create - Create security incident
router.post('/security/incidents/create', authenticateUser, requireAdmin, requirePermission('security.manage'), asyncHandler(async (req, res) => {
    const { title, description, severity, affectedSystems, immediateActions } = req.body;
    
    // Validate input
    if (!title || !description || !severity) {
        throw new APIError('Title, description, and severity are required', 400, 'MISSING_FIELDS');
    }
    
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
        throw new APIError('Invalid severity level', 400, 'INVALID_SEVERITY');
    }
    
    await transaction(async (client) => {
        // Create security incident record
        const incidentResult = await client.query(`
            INSERT INTO security_events (
                event_type, severity, user_id, ip_address, details
            ) VALUES (
                'security_incident', $1, $2, $3, $4
            ) RETURNING id, created_at
        `, [
            severity,
            req.user.id,
            req.ip,
            {
                incident_type: 'manual_creation',
                title,
                description,
                affected_systems: affectedSystems,
                immediate_actions: immediateActions,
                created_by: `${req.user.first_name} ${req.user.last_name}`,
                admin_role: req.user.admin_role
            }
        ]);
        
        const incident = incidentResult.rows[0];
        
        // Log the incident creation
        await logAdminActivity(
            req.user.id,
            'security_incident_created',
            'security',
            incident.id,
            {
                title,
                severity,
                affectedSystems,
                immediateActions
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'security',
                severity: severity === 'critical' ? 'critical' : 'high'
            }
        );
        
        res.status(201).json({
            success: true,
            data: {
                incidentId: incident.id,
                title,
                severity,
                createdAt: incident.created_at,
                createdBy: `${req.user.first_name} ${req.user.last_name}`
            },
            message: 'Security incident created successfully'
        });
    });
}));

// GET /api/v1/admin/security/health - System security health check
router.get('/security/health', authenticateUser, requireAdmin, requirePermission('security.monitor'), asyncHandler(async (req, res) => {
    // Calculate security health score based on various metrics
    const last24Hours = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE severity = 'critical') as critical_events,
            COUNT(*) FILTER (WHERE severity = 'high') as high_events,
            COUNT(*) FILTER (WHERE event_type = 'failed_login') as failed_logins,
            COUNT(*) FILTER (WHERE event_type = 'brute_force_detected') as brute_force_attempts,
            COUNT(*) FILTER (WHERE resolved = FALSE) as unresolved_events
        FROM security_events 
        WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
    `);
    
    const metrics = last24Hours.rows[0];
    
    // Calculate health score (0-100)
    let healthScore = 100;
    
    // Deduct points for security issues
    healthScore -= (parseInt(metrics.critical_events) * 20); // -20 per critical event
    healthScore -= (parseInt(metrics.high_events) * 10);     // -10 per high event
    healthScore -= (parseInt(metrics.brute_force_attempts) * 15); // -15 per brute force
    healthScore -= (parseInt(metrics.unresolved_events) * 5); // -5 per unresolved event
    
    // Deduct for excessive failed logins
    if (parseInt(metrics.failed_logins) > 50) {
        healthScore -= Math.min(30, Math.floor(parseInt(metrics.failed_logins) / 10));
    }
    
    // Ensure score doesn't go below 0
    healthScore = Math.max(0, healthScore);
    
    let healthStatus;
    let healthColor;
    
    if (healthScore >= 90) {
        healthStatus = 'Excellent';
        healthColor = '#00ff88';
    } else if (healthScore >= 75) {
        healthStatus = 'Good';
        healthColor = '#00d4ff';
    } else if (healthScore >= 50) {
        healthStatus = 'Fair';
        healthColor = '#ff9500';
    } else if (healthScore >= 25) {
        healthStatus = 'Poor';
        healthColor = '#ff6b6b';
    } else {
        healthStatus = 'Critical';
        healthColor = '#ff4757';
    }
    
    res.json({
        success: true,
        data: {
            healthScore,
            healthStatus,
            healthColor,
            metrics: {
                criticalEvents: parseInt(metrics.critical_events),
                highEvents: parseInt(metrics.high_events),
                failedLogins: parseInt(metrics.failed_logins),
                bruteForceAttempts: parseInt(metrics.brute_force_attempts),
                unresolvedEvents: parseInt(metrics.unresolved_events)
            },
            recommendations: generateSecurityRecommendations(metrics, healthScore)
        },
        message: 'Security health check completed successfully'
    });
}));

// Helper function to generate security recommendations
function generateSecurityRecommendations(metrics, healthScore) {
    const recommendations = [];
    
    if (parseInt(metrics.critical_events) > 0) {
        recommendations.push({
            priority: 'critical',
            action: 'Immediate Response Required',
            description: `${metrics.critical_events} critical security events detected in the last 24 hours`,
            icon: '🚨'
        });
    }
    
    if (parseInt(metrics.unresolved_events) > 5) {
        recommendations.push({
            priority: 'high',
            action: 'Review Unresolved Events',
            description: `${metrics.unresolved_events} security events remain unresolved`,
            icon: '⚠️'
        });
    }
    
    if (parseInt(metrics.brute_force_attempts) > 0) {
        recommendations.push({
            priority: 'high',
            action: 'Implement IP Blocking',
            description: `${metrics.brute_force_attempts} brute force attempts detected`,
            icon: '🛡️'
        });
    }
    
    if (parseInt(metrics.failed_logins) > 100) {
        recommendations.push({
            priority: 'medium',
            action: 'Review Authentication Logs',
            description: `High number of failed login attempts (${metrics.failed_logins})`,
            icon: '🔐'
        });
    }
    
    if (healthScore < 75) {
        recommendations.push({
            priority: 'medium',
            action: 'Security Review Required',
            description: 'Overall security health is below optimal levels',
            icon: '📊'
        });
    }
    
    if (recommendations.length === 0) {
        recommendations.push({
            priority: 'info',
            action: 'System Secure',
            description: 'No immediate security concerns detected',
            icon: '✅'
        });
    }
    
    return recommendations;
}

// GET /api/v1/admin/maintenance/logs - Log maintenance and cleanup
router.get('/maintenance/logs', authenticateUser, requireAdmin, requirePermission('system.maintenance'), asyncHandler(async (req, res) => {
    // Get log statistics for different categories
    const logStats = await query(`
        SELECT 
            category,
            COUNT(*) as total_logs,
            MIN(created_at) as oldest_log,
            MAX(created_at) as newest_log,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days') as logs_older_than_30d,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days') as logs_older_than_90d,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '365 days') as logs_older_than_1y
        FROM admin_activity_log 
        GROUP BY category
        ORDER BY total_logs DESC
    `);
    
    const securityStats = await query(`
        SELECT 
            'security_events' as category,
            COUNT(*) as total_logs,
            MIN(created_at) as oldest_log,
            MAX(created_at) as newest_log,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days') as logs_older_than_30d,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days') as logs_older_than_90d,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '365 days') as logs_older_than_1y
        FROM security_events
    `);
    
    const sessionStats = await query(`
        SELECT 
            'user_sessions' as category,
            COUNT(*) as total_logs,
            MIN(created_at) as oldest_log,
            MAX(created_at) as newest_log,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days') as logs_older_than_30d,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days') as logs_older_than_90d,
            COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '365 days') as logs_older_than_1y
        FROM user_sessions
    `);
    
    // Get retention policies
    const retentionPolicies = await query(`
        SELECT category, retention_days, description 
        FROM log_categories 
        ORDER BY retention_days DESC
    `);
    
    // Calculate database size information
    const dbSizeInfo = await query(`
        SELECT 
            schemaname,
            tablename,
            pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
            pg_total_relation_size(schemaname||'.'||tablename) as size_bytes
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename IN ('admin_activity_log', 'security_events', 'user_sessions')
        ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);
    
    res.json({
        success: true,
        data: {
            logStatistics: logStats.rows,
            securityStatistics: securityStats.rows[0] || null,
            sessionStatistics: sessionStats.rows[0] || null,
            retentionPolicies: retentionPolicies.rows,
            databaseSize: dbSizeInfo.rows,
            generatedAt: new Date().toISOString()
        },
        message: 'Log maintenance statistics retrieved successfully'
    });
}));

// POST /api/v1/admin/maintenance/cleanup - Execute log cleanup
router.post('/maintenance/cleanup', authenticateUser, requireAdmin, requirePermission('system.maintenance'), asyncHandler(async (req, res) => {
    const { dryRun = true, categories = [] } = req.body;
    
    let deletedRecords = {
        adminActivityLog: 0,
        securityEvents: 0,
        userSessions: 0,
        totalDeleted: 0
    };
    
    await transaction(async (client) => {
        if (dryRun) {
            // Dry run - just calculate what would be deleted
            if (categories.length === 0 || categories.includes('admin_activity_log')) {
                const adminLogCount = await client.query(`
                    SELECT COUNT(*) as count FROM admin_activity_log al
                    JOIN log_categories lc ON al.category = lc.category
                    WHERE al.created_at < CURRENT_TIMESTAMP - INTERVAL '1 day' * lc.retention_days
                `);
                deletedRecords.adminActivityLog = parseInt(adminLogCount.rows[0].count);
            }
            
            if (categories.length === 0 || categories.includes('security_events')) {
                const securityEventCount = await client.query(`
                    SELECT COUNT(*) as count FROM security_events 
                    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '730 days'
                `);
                deletedRecords.securityEvents = parseInt(securityEventCount.rows[0].count);
            }
            
            if (categories.length === 0 || categories.includes('user_sessions')) {
                const sessionCount = await client.query(`
                    SELECT COUNT(*) as count FROM user_sessions 
                    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
                `);
                deletedRecords.userSessions = parseInt(sessionCount.rows[0].count);
            }
        } else {
            // Actual cleanup
            if (categories.length === 0 || categories.includes('admin_activity_log')) {
                const result = await client.query(`
                    DELETE FROM admin_activity_log 
                    WHERE id IN (
                        SELECT al.id FROM admin_activity_log al
                        JOIN log_categories lc ON al.category = lc.category
                        WHERE al.created_at < CURRENT_TIMESTAMP - INTERVAL '1 day' * lc.retention_days
                        LIMIT 1000
                    )
                `);
                deletedRecords.adminActivityLog = result.rowCount;
            }
            
            if (categories.length === 0 || categories.includes('security_events')) {
                const result = await client.query(`
                    DELETE FROM security_events 
                    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '730 days'
                    AND resolved = TRUE
                    LIMIT 1000
                `);
                deletedRecords.securityEvents = result.rowCount;
            }
            
            if (categories.length === 0 || categories.includes('user_sessions')) {
                const result = await client.query(`
                    DELETE FROM user_sessions 
                    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
                    LIMIT 1000
                `);
                deletedRecords.userSessions = result.rowCount;
            }
        }
        
        deletedRecords.totalDeleted = deletedRecords.adminActivityLog + 
                                     deletedRecords.securityEvents + 
                                     deletedRecords.userSessions;
        
        // Log the cleanup activity
        await logAdminActivity(
            req.user.id,
            dryRun ? 'log_cleanup_simulated' : 'log_cleanup_executed',
            'system',
            'maintenance',
            {
                dryRun,
                categories: categories.length > 0 ? categories : ['all'],
                deletedRecords
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'system',
                severity: dryRun ? 'info' : 'medium'
            }
        );
        
        res.json({
            success: true,
            data: {
                dryRun,
                deletedRecords,
                message: dryRun ? 
                    'Dry run completed - no records were deleted' : 
                    'Log cleanup completed successfully'
            },
            message: dryRun ? 'Log cleanup simulation completed' : 'Log cleanup executed successfully'
        });
    });
}));

// POST /api/v1/admin/maintenance/archive - Archive old logs
router.post('/maintenance/archive', authenticateUser, requireAdmin, requirePermission('system.maintenance'), asyncHandler(async (req, res) => {
    const { archiveBefore, categories = [] } = req.body;
    
    if (!archiveBefore) {
        throw new APIError('Archive date is required', 400, 'MISSING_ARCHIVE_DATE');
    }
    
    const archiveDate = new Date(archiveBefore);
    if (isNaN(archiveDate.getTime())) {
        throw new APIError('Invalid archive date format', 400, 'INVALID_DATE');
    }
    
    let archivedRecords = {
        adminActivityLog: 0,
        securityEvents: 0,
        totalArchived: 0
    };
    
    await transaction(async (client) => {
        // Create archive tables if they don't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_activity_log_archive (
                LIKE admin_activity_log INCLUDING ALL
            )
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS security_events_archive (
                LIKE security_events INCLUDING ALL
            )
        `);
        
        if (categories.length === 0 || categories.includes('admin_activity_log')) {
            // Move old admin activity logs to archive
            const result = await client.query(`
                WITH moved_rows AS (
                    DELETE FROM admin_activity_log 
                    WHERE created_at < $1
                    RETURNING *
                )
                INSERT INTO admin_activity_log_archive 
                SELECT * FROM moved_rows
            `, [archiveDate]);
            
            archivedRecords.adminActivityLog = result.rowCount;
        }
        
        if (categories.length === 0 || categories.includes('security_events')) {
            // Move old security events to archive (only resolved ones)
            const result = await client.query(`
                WITH moved_rows AS (
                    DELETE FROM security_events 
                    WHERE created_at < $1 AND resolved = TRUE
                    RETURNING *
                )
                INSERT INTO security_events_archive 
                SELECT * FROM moved_rows
            `, [archiveDate]);
            
            archivedRecords.securityEvents = result.rowCount;
        }
        
        archivedRecords.totalArchived = archivedRecords.adminActivityLog + archivedRecords.securityEvents;
        
        // Log the archiving activity
        await logAdminActivity(
            req.user.id,
            'log_archiving_completed',
            'system',
            'maintenance',
            {
                archiveBefore: archiveDate.toISOString(),
                categories: categories.length > 0 ? categories : ['all'],
                archivedRecords
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'system',
                severity: 'medium'
            }
        );
        
        res.json({
            success: true,
            data: {
                archiveBefore: archiveDate.toISOString(),
                archivedRecords,
                message: `Successfully archived ${archivedRecords.totalArchived} records`
            },
            message: 'Log archiving completed successfully'
        });
    });
}));

// GET /api/v1/admin/maintenance/vacuum - Database vacuum and analyze
router.post('/maintenance/vacuum', authenticateUser, requireAdmin, requirePermission('system.maintenance'), asyncHandler(async (req, res) => {
    const { tables = ['admin_activity_log', 'security_events', 'user_sessions'] } = req.body;
    
    const results = [];
    
    for (const table of tables) {
        try {
            // Get table size before vacuum
            const sizeBefore = await query(`
                SELECT pg_size_pretty(pg_total_relation_size($1)) as size,
                       pg_total_relation_size($1) as size_bytes
            `, [table]);
            
            // Perform VACUUM ANALYZE
            await query(`VACUUM ANALYZE ${table}`);
            
            // Get table size after vacuum
            const sizeAfter = await query(`
                SELECT pg_size_pretty(pg_total_relation_size($1)) as size,
                       pg_total_relation_size($1) as size_bytes
            `, [table]);
            
            const spaceSaved = sizeBefore.rows[0].size_bytes - sizeAfter.rows[0].size_bytes;
            
            results.push({
                table,
                sizeBefore: sizeBefore.rows[0].size,
                sizeAfter: sizeAfter.rows[0].size,
                spaceSaved: spaceSaved > 0 ? `${(spaceSaved / 1024 / 1024).toFixed(2)} MB` : '0 MB',
                status: 'completed'
            });
            
        } catch (error) {
            results.push({
                table,
                status: 'failed',
                error: error.message
            });
        }
    }
    
    // Log the vacuum activity
    await logAdminActivity(
        req.user.id,
        'database_vacuum_completed',
        'system',
        'maintenance',
        {
            tables,
            results
        },
        req.ip,
        req.get('User-Agent'),
        {
            category: 'system',
            severity: 'info'
        }
    );
    
    res.json({
        success: true,
        data: {
            results,
            totalTables: tables.length,
            completedTables: results.filter(r => r.status === 'completed').length
        },
        message: 'Database vacuum and analyze completed'
    });
}));

// =====================================
// BILLING & PAYMENT MANAGEMENT ENDPOINTS
// =====================================

// POST /api/v1/admin/record-payment - Record payment for user
router.post('/record-payment', 
    requireAdminPerm, 
    [
        body('userId').notEmpty().withMessage('User ID is required'),
        body('amount').isFloat({ min: 0 }).withMessage('Amount must be a positive number'),
        body('paymentDate').isISO8601().withMessage('Valid payment date required'),
        body('bankReference').optional().isString().withMessage('Bank reference must be a string'),
        body('paymentMonth').matches(/^\d{4}-\d{2}$/).withMessage('Payment month must be in YYYY-MM format'),
        body('notes').optional().isString().withMessage('Notes must be a string')
    ],
    asyncHandler(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
        }

        const { userId, amount, paymentDate, bankReference, paymentMonth, notes } = req.body;

        const result = await transaction(async (client) => {
            // Get user details
            const userResult = await client.query(
                'SELECT id, first_name, last_name, email, payment_reference FROM users WHERE id = $1',
                [userId]
            );

            if (userResult.rows.length === 0) {
                throw new APIError('User not found', 404, 'USER_NOT_FOUND');
            }

            const user = userResult.rows[0];

            // Insert payment record
            const paymentResult = await client.query(`
                INSERT INTO payments (user_id, payment_reference, amount, payment_date, bank_reference, marked_by_admin_id, payment_month, notes)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `, [userId, user.payment_reference, amount, paymentDate, bankReference, req.userId, paymentMonth, notes]);

            // Calculate new expiry date (add 30 days from payment date)
            const newExpiryDate = new Date(paymentDate);
            newExpiryDate.setDate(newExpiryDate.getDate() + 30);

            // Update user's subscription
            await client.query(`
                UPDATE users 
                SET subscription_expires_at = $1, 
                    last_payment_date = $2, 
                    payment_reminder_sent = FALSE, 
                    reminder_sent_date = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $3
            `, [newExpiryDate, paymentDate, userId]);

            // Send confirmation message to user
            await client.query(`
                INSERT INTO messages (user_id, subject, content, message_type, status, admin_user_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                userId,
                'Payment Received - Subscription Extended',
                `Hi ${user.first_name}!\n\nWe have received your payment of R${amount} for ${paymentMonth}.\n\nYour subscription has been extended until ${newExpiryDate.toDateString()}.\n\nThank you for using ARB4ME!\n\nThe ARB4ME Team`,
                'admin_to_user',
                'sent',
                req.userId
            ]);

            return {
                payment: paymentResult.rows[0],
                user: user,
                newExpiryDate: newExpiryDate
            };
        });

        await logAdminActivity(
            req.userId,
            'payment_recorded',
            { 
                target_user_id: userId,
                amount: amount,
                payment_month: paymentMonth
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'billing',
                severity: 'info'
            }
        );

        res.json({
            success: true,
            data: result,
            message: 'Payment recorded successfully'
        });
    })
);

// GET /api/v1/admin/users-expiring - Get users expiring within N days  
router.get('/users-expiring', requireAdminPerm, asyncHandler(async (req, res) => {
        console.log('🔍 users-expiring endpoint hit, user:', req.user?.id, 'admin role:', req.user?.admin_role, 'user object:', req.user);
        const days = parseInt(req.query.days) || 7;

        const result = await query(`
            SELECT 
                id, first_name, last_name, email, payment_reference,
                subscription_expires_at, last_payment_date, payment_reminder_sent
            FROM users 
            WHERE subscription_expires_at IS NOT NULL 
            AND subscription_expires_at <= CURRENT_DATE + INTERVAL '${days} days'
            AND subscription_expires_at > CURRENT_DATE
            AND account_status = 'active'
            ORDER BY subscription_expires_at ASC
        `);

        res.json({
            success: true,
            data: {
                users: result.rows.map(row => ({
                    id: row.id,
                    firstName: row.first_name,
                    lastName: row.last_name,
                    email: row.email,
                    paymentReference: row.payment_reference,
                    subscriptionExpiresAt: row.subscription_expires_at,
                    lastPaymentDate: row.last_payment_date,
                    paymentReminderSent: row.payment_reminder_sent,
                    daysUntilExpiry: Math.ceil((new Date(row.subscription_expires_at) - new Date()) / (1000 * 60 * 60 * 24))
                })),
                count: result.rows.length,
                searchedDays: days
            }
        });
    })
);

// GET /api/v1/admin/users-expired - Get expired users
router.get('/users-expired', requireAdminPerm, asyncHandler(async (req, res) => {
        const result = await query(`
            SELECT 
                id, first_name, last_name, email, payment_reference,
                subscription_expires_at, last_payment_date, account_status
            FROM users 
            WHERE subscription_expires_at IS NOT NULL 
            AND subscription_expires_at < CURRENT_DATE
            ORDER BY subscription_expires_at DESC
        `);

        res.json({
            success: true,
            data: {
                users: result.rows.map(row => ({
                    id: row.id,
                    firstName: row.first_name,
                    lastName: row.last_name,
                    email: row.email,
                    paymentReference: row.payment_reference,
                    subscriptionExpiresAt: row.subscription_expires_at,
                    lastPaymentDate: row.last_payment_date,
                    accountStatus: row.account_status,
                    daysExpired: Math.floor((new Date() - new Date(row.subscription_expires_at)) / (1000 * 60 * 60 * 24))
                })),
                count: result.rows.length
            }
        });
    })
);

// POST /api/v1/admin/send-expiry-reminders - Send reminders to expiring users
router.post('/send-expiry-reminders',
    requireAdminPerm,
    asyncHandler(async (req, res) => {
        const days = parseInt(req.body.days) || 7;

        const result = await transaction(async (client) => {
            // Get users expiring soon who haven't received reminders
            const usersResult = await client.query(`
                SELECT id, first_name, email, subscription_expires_at
                FROM users 
                WHERE subscription_expires_at IS NOT NULL 
                AND subscription_expires_at <= CURRENT_DATE + INTERVAL '${days} days'
                AND subscription_expires_at > CURRENT_DATE
                AND account_status = 'active'
                AND (payment_reminder_sent = FALSE OR payment_reminder_sent IS NULL)
            `);

            const remindersSent = [];

            for (const user of usersResult.rows) {
                // Send reminder message
                await client.query(`
                    INSERT INTO messages (user_id, subject, content, message_type, status, admin_user_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    user.id,
                    'Subscription Expiry Reminder - Action Required',
                    `Hi ${user.first_name}!\n\nThis is a friendly reminder that your ARB4ME subscription will expire on ${new Date(user.subscription_expires_at).toDateString()}.\n\nTo continue enjoying uninterrupted access to our arbitrage trading platform, please ensure your R500 payment is made before the expiry date.\n\nPayment details:\n- Amount: R500\n- Reference: Use your unique payment reference\n- Contact admin if you need assistance\n\nThank you for being part of ARB4ME!\n\nThe ARB4ME Team`,
                    'admin_to_user',
                    'sent',
                    req.userId
                ]);

                // Mark reminder as sent
                await client.query(`
                    UPDATE users 
                    SET payment_reminder_sent = TRUE, reminder_sent_date = CURRENT_DATE
                    WHERE id = $1
                `, [user.id]);

                remindersSent.push({
                    userId: user.id,
                    email: user.email,
                    firstName: user.first_name,
                    expiryDate: user.subscription_expires_at
                });
            }

            return remindersSent;
        });

        await logAdminActivity(
            req.userId,
            'expiry_reminders_sent',
            { 
                reminders_count: result.length,
                days_threshold: days
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'billing',
                severity: 'info'
            }
        );

        res.json({
            success: true,
            data: {
                remindersSent: result,
                count: result.length
            },
            message: `Sent ${result.length} expiry reminder(s)`
        });
    })
);

// POST /api/v1/admin/suspend-expired-users - Suspend expired user accounts
router.post('/suspend-expired-users',
    requireAdminPerm,
    asyncHandler(async (req, res) => {
        const graceDays = parseInt(req.body.graceDays) || 0;

        const result = await transaction(async (client) => {
            // Get users who expired more than graceDays ago and are still active
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - graceDays);

            const usersResult = await client.query(`
                SELECT id, first_name, last_name, email, subscription_expires_at
                FROM users 
                WHERE subscription_expires_at IS NOT NULL 
                AND subscription_expires_at < $1
                AND account_status = 'active'
            `, [cutoffDate]);

            const suspendedUsers = [];

            for (const user of usersResult.rows) {
                // Suspend the user
                await client.query(`
                    UPDATE users 
                    SET account_status = 'suspended', updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [user.id]);

                // Send suspension notification
                await client.query(`
                    INSERT INTO messages (user_id, subject, content, message_type, status, admin_user_id)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    user.id,
                    'Account Suspended - Payment Required',
                    `Hi ${user.first_name},\n\nYour ARB4ME account has been suspended due to an expired subscription.\n\nYour subscription expired on ${new Date(user.subscription_expires_at).toDateString()}.\n\nTo reactivate your account:\n1. Make your R500 payment\n2. Contact admin to process the payment\n3. Your account will be reactivated immediately\n\nWe look forward to having you back on the platform!\n\nThe ARB4ME Team`,
                    'admin_to_user',
                    'sent',
                    req.userId
                ]);

                suspendedUsers.push({
                    userId: user.id,
                    email: user.email,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    expiredDate: user.subscription_expires_at
                });
            }

            return suspendedUsers;
        });

        await logAdminActivity(
            req.userId,
            'users_suspended',
            { 
                suspended_count: result.length,
                grace_days: graceDays
            },
            req.ip,
            req.get('User-Agent'),
            {
                category: 'billing',
                severity: 'warning'
            }
        );

        res.json({
            success: true,
            data: {
                suspendedUsers: result,
                count: result.length
            },
            message: `Suspended ${result.length} expired user account(s)`
        });
    })
);

// GET /api/v1/admin/payment-history - Get payment history
router.get('/payment-history', requireAdminPerm, asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const offset = (page - 1) * limit;
        const userId = req.query.userId;
        const month = req.query.month; // YYYY-MM format

        let whereClause = 'WHERE 1=1';
        const queryParams = [];
        let paramIndex = 1;

        if (userId) {
            whereClause += ` AND p.user_id = $${paramIndex++}`;
            queryParams.push(userId);
        }

        if (month) {
            whereClause += ` AND p.payment_month = $${paramIndex++}`;
            queryParams.push(month);
        }

        queryParams.push(limit, offset);

        const paymentsResult = await query(`
            SELECT 
                p.id, p.user_id, p.payment_reference, p.amount, p.payment_date, 
                p.bank_reference, p.payment_month, p.notes, p.created_at,
                u.first_name, u.last_name, u.email,
                admin_u.first_name as admin_first_name, admin_u.last_name as admin_last_name
            FROM payments p
            JOIN users u ON p.user_id = u.id
            LEFT JOIN users admin_u ON p.marked_by_admin_id = admin_u.id
            ${whereClause}
            ORDER BY p.payment_date DESC, p.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `, queryParams);

        // Get total count
        const countParams = queryParams.slice(0, -2);
        const countResult = await query(`
            SELECT COUNT(*) as total
            FROM payments p
            JOIN users u ON p.user_id = u.id
            ${whereClause.replace(/\$(\d+)/g, (match, num) => {
                const newNum = parseInt(num);
                return newNum <= countParams.length ? match : '';
            })}
        `, countParams);

        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        const payments = paymentsResult.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            paymentReference: row.payment_reference,
            amount: parseFloat(row.amount),
            paymentDate: row.payment_date,
            bankReference: row.bank_reference,
            paymentMonth: row.payment_month,
            notes: row.notes,
            createdAt: row.created_at,
            user: {
                firstName: row.first_name,
                lastName: row.last_name,
                email: row.email
            },
            markedBy: row.admin_first_name ? {
                firstName: row.admin_first_name,
                lastName: row.admin_last_name
            } : null
        }));

        res.json({
            success: true,
            data: {
                payments,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalRecords: total,
                    recordsPerPage: limit
                }
            }
        });
    })
);

module.exports = router;