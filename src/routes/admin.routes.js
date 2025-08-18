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
    logAdminActivity 
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

// Get all users for compose modal with proper authentication  
router.get('/all-users-test', authenticateUser, requireAdmin, asyncHandler(async (req, res) => {
    // Try with payment_reference, fallback without if column doesn't exist
    let usersResult;
    try {
        usersResult = await query(`
            SELECT 
                id, first_name, last_name, email, account_status, last_login_at, created_at, payment_reference
            FROM users 
            WHERE admin_role IS NULL OR admin_role != 'master'
            ORDER BY first_name ASC, last_name ASC
        `);
    } catch (error) {
        // If payment_reference column doesn't exist, query without it
        console.log('Payment reference column not found, querying without it');
        usersResult = await query(`
            SELECT 
                id, first_name, last_name, email, account_status, last_login_at, created_at
            FROM users 
            WHERE admin_role IS NULL OR admin_role != 'master'
            ORDER BY first_name ASC, last_name ASC
        `);
    }
    
    const users = usersResult.rows.map(row => ({
        id: row.id,
        name: `${row.first_name} ${row.last_name}`,
        email: row.email,
        status: row.account_status,
        lastLogin: row.last_login_at,
        paymentReference: row.payment_reference || null,
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
                u.created_at, u.updated_at, u.last_login_at, u.payment_reference
            FROM users u
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
                u.created_at, u.updated_at, u.last_login_at
            FROM users u
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
        paymentReference: row.payment_reference || null
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
    
    // Update user status
    const result = await query(
        'UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, account_status, first_name, last_name',
        [status, userId]
    );
    
    if (result.rows.length === 0) {
        throw new APIError('User not found', 404, 'USER_NOT_FOUND');
    }
    
    const user = result.rows[0];
    
    // Log the action (simple console log for now)
    console.log(`Admin updated user ${userId} status to ${status}`);
    
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
    
    console.log(`Bulk activate: ${results.success.length} successful, ${results.failed.length} failed`);
    
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
    
    console.log(`Bulk suspend: ${results.success.length} successful, ${results.failed.length} failed`);
    
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
        
        // Log the promotion activity
        await client.query(`
            SELECT log_admin_activity($1, $2, $3, $4, $5)
        `, [
            req.user.id, // Get admin ID from authenticated JWT
            'admin_promoted',
            'user',
            userId,
            JSON.stringify({
                previous_role: user.admin_role,
                new_role: newRole,
                user_name: `${user.first_name} ${user.last_name}`
            })
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
        
        // Log the demotion activity
        await client.query(`
            SELECT log_admin_activity($1, $2, $3, $4, $5)
        `, [
            req.user.id, // Get admin ID from authenticated JWT
            'admin_demoted',
            'user',
            userId,
            JSON.stringify({
                previous_role: user.admin_role,
                user_name: `${user.first_name} ${user.last_name}`
            })
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
    const { limit = 50, offset = 0 } = req.query;
    
    const logs = await query(`
        SELECT 
            al.id, al.action, al.target_type, al.target_id, al.details,
            al.ip_address, al.created_at,
            u.first_name, u.last_name, u.email, u.admin_role
        FROM admin_activity_log al
        JOIN users u ON al.admin_user_id = u.id
        ORDER BY al.created_at DESC
        LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)]);
    
    res.json({
        success: true,
        data: logs.rows,
        message: 'Admin activity log retrieved successfully'
    });
}));

module.exports = router;