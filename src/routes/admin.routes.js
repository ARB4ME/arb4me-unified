const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireAdmin, requireAdminRole, optionalAuth } = require('../middleware/auth');
const { adminRateLimit, messageRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');

const router = express.Router();

// Apply admin rate limiting to all routes
router.use(adminRateLimit);

// POST /api/v1/admin/compose-message - Compose message to users
router.post('/compose-message', authenticateUser, requireAdmin, messageRateLimit, [
    body('userIds').isArray().withMessage('User IDs must be an array'),
    body('subject').notEmpty().withMessage('Subject is required'),
    body('content').notEmpty().withMessage('Content is required'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority level')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { userIds, subject, content, priority = 'medium' } = req.body;
    const adminId = req.user.id;

    // Validate that admin has permission to send messages
    if (!req.user.admin_role) {
        throw new APIError('Admin privileges required', 403, 'INSUFFICIENT_PRIVILEGES');
    }

    const results = await transaction(async (client) => {
        const messageResults = [];
        
        for (const userId of userIds) {
            try {
                // Verify user exists
                const userCheck = await client.query(
                    'SELECT id FROM users WHERE id = $1',
                    [userId]
                );
                
                if (userCheck.rows.length === 0) {
                    messageResults.push({
                        userId,
                        success: false,
                        error: 'User not found'
                    });
                    continue;
                }
                
                // Insert message
                const messageResult = await client.query(
                    `INSERT INTO messages 
                     (user_id, subject, content, message_type, status, priority, admin_user_id, created_at) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) 
                     RETURNING id, created_at`,
                    [userId, subject, content, 'admin_to_user', 'sent', priority, adminId]
                );
                
                messageResults.push({
                    userId,
                    success: true,
                    messageId: messageResult.rows[0].id,
                    createdAt: messageResult.rows[0].created_at
                });
                
                // Log admin activity
                await client.query(
                    'INSERT INTO admin_activity (admin_id, activity_type, activity_details) VALUES ($1, $2, $3)',
                    [adminId, 'message_sent', { userId, subject, priority }]
                );
                
            } catch (error) {
                messageResults.push({
                    userId,
                    success: false,
                    error: error.message
                });
            }
        }
        
        return messageResults;
    });

    systemLogger.admin('Bulk message sent', {
        adminId,
        recipientCount: userIds.length,
        successCount: results.filter(r => r.success).length,
        subject
    });

    res.json({
        success: true,
        data: {
            results,
            summary: {
                total: userIds.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            }
        }
    });
}));

// Force sequence update to much higher value
router.post('/debug-force-sequence-high', asyncHandler(async (req, res) => {
    try {
        // Set sequence to 200000 to avoid ALL possible conflicts
        const result = await query("SELECT setval('user_payment_ref_seq', 200000)");
        
        // Verify new value
        const verify = await query("SELECT last_value FROM user_payment_ref_seq");
        
        res.json({
            success: true,
            oldValue: 100012,
            newValue: verify.rows[0].last_value,
            message: 'Sequence forced to 200000 to avoid all conflicts'
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
        updated_at: row.updated_at,
        last_login_at: row.last_login_at,
        exchanges_connected_count: row.exchanges_connected_count || 0,
        trading_active: row.trading_active || false,
        auto_trading_enabled: row.auto_trading_enabled || false,
        total_trades_count: row.total_trades_count || 0,
        successful_trades_count: row.successful_trades_count || 0,
        profit_loss_total: row.profit_loss_total || 0,
        last_trading_activity: row.last_trading_activity,
        payment_reference: row.payment_reference,
        paymentReference: row.payment_reference,
        apiKeysConfigured: row.exchanges_connected_count > 0,
        hasBalance: false
    }));

    res.json({ 
        success: true,
        users: users 
    });
}));

// *** REST OF FILE CONTINUES WITH OTHER ADMIN ENDPOINTS ***
// (Analytics, messages, user management, etc.)

module.exports = router;