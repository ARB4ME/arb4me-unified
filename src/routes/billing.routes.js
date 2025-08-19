// Billing System Routes
const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin, requireMaster, logAdminActivity } = require('../middleware/adminPermissions');
const { body, param, validationResult } = require('express-validator');

// Validation middleware
const validatePaymentRecording = [
    body('userId').notEmpty().withMessage('User ID is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('bankReference').optional().isString(),
    body('paymentDate').isISO8601().withMessage('Valid payment date required'),
    body('notes').optional().isString()
];

const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            success: false, 
            errors: errors.array() 
        });
    }
    next();
};

// =====================
// PAYMENT RECORDING
// =====================

// POST /api/v1/admin/payments/mark-received
router.post('/mark-received', 
    authenticateToken,
    requireAdmin,
    validatePaymentRecording,
    handleValidationErrors,
    async (req, res) => {
        const startTime = Date.now();
        try {
            const { userId, amount, bankReference, paymentDate, notes } = req.body;
            const adminId = req.user.id;

            // Log the before state
            const beforeState = await query(
                'SELECT account_status, subscription_expires_at FROM users WHERE id = $1',
                [userId]
            );

            // Call the record_payment function
            const result = await query(
                'SELECT record_payment($1, $2, $3, $4, $5, $6) as payment_id',
                [userId, amount, bankReference, paymentDate, adminId, notes]
            );

            const paymentId = result.rows[0]?.payment_id;

            if (!paymentId) {
                throw new Error('Payment recording failed');
            }

            // Get the after state
            const afterState = await query(
                'SELECT account_status, subscription_expires_at FROM users WHERE id = $1',
                [userId]
            );

            // Get user details for response
            const userDetails = await query(
                `SELECT u.email, u.first_name, u.last_name, u.payment_reference,
                        u.subscription_expires_at, u.account_status
                 FROM users u WHERE u.id = $1`,
                [userId]
            );

            // Log admin activity
            await logAdminActivity(
                adminId,
                'payment_recorded',
                'user',
                userId,
                {
                    payment_id: paymentId,
                    amount: amount,
                    bank_reference: bankReference,
                    payment_date: paymentDate
                },
                req.ip,
                req.get('User-Agent'),
                {
                    category: 'billing',
                    severity: 'info',
                    beforeState: beforeState.rows[0],
                    afterState: afterState.rows[0],
                    requestMethod: req.method,
                    requestUrl: req.originalUrl,
                    responseStatus: 200,
                    durationMs: Date.now() - startTime
                }
            );

            res.json({
                success: true,
                data: {
                    paymentId: paymentId,
                    user: userDetails.rows[0],
                    message: 'Payment recorded successfully'
                }
            });

        } catch (error) {
            console.error('Error recording payment:', error);
            
            // Log the failed attempt
            await logAdminActivity(
                req.user.id,
                'payment_recording_failed',
                'user',
                req.body.userId,
                { error: error.message },
                req.ip,
                req.get('User-Agent'),
                {
                    category: 'billing',
                    severity: 'error',
                    durationMs: Date.now() - startTime
                }
            );

            res.status(500).json({
                success: false,
                error: 'Failed to record payment',
                details: error.message
            });
        }
    }
);

// =====================
// PAYMENT HISTORY
// =====================

// GET /api/v1/admin/payments/history/:userId
router.get('/history/:userId',
    authenticateToken,
    requireAdmin,
    param('userId').notEmpty(),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { userId } = req.params;

            const payments = await query(
                `SELECT p.*, 
                        u.email, u.first_name || ' ' || u.last_name as user_name,
                        admin.first_name || ' ' || admin.last_name as recorded_by
                 FROM payments p
                 JOIN users u ON p.user_id = u.id
                 LEFT JOIN users admin ON p.marked_by_admin_id = admin.id
                 WHERE p.user_id = $1
                 ORDER BY p.payment_date DESC`,
                [userId]
            );

            res.json({
                success: true,
                data: payments.rows
            });

        } catch (error) {
            console.error('Error fetching payment history:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch payment history'
            });
        }
    }
);

// GET /api/v1/admin/payments/all
router.get('/all',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        try {
            const { limit = 50, offset = 0 } = req.query;

            const payments = await query(
                `SELECT * FROM recent_payments 
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );

            const total = await query(
                'SELECT COUNT(*) as total FROM payments'
            );

            res.json({
                success: true,
                data: {
                    payments: payments.rows,
                    total: parseInt(total.rows[0].total),
                    limit: parseInt(limit),
                    offset: parseInt(offset)
                }
            });

        } catch (error) {
            console.error('Error fetching all payments:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch payments'
            });
        }
    }
);

// =====================
// EXPIRY MANAGEMENT
// =====================

// GET /api/v1/admin/users/expiring
router.get('/users/expiring',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        try {
            const { days = 7 } = req.query;

            const expiringUsers = await query(
                'SELECT * FROM get_expiring_users($1)',
                [days]
            );

            res.json({
                success: true,
                data: {
                    users: expiringUsers.rows,
                    count: expiringUsers.rows.length,
                    days_ahead: parseInt(days)
                }
            });

        } catch (error) {
            console.error('Error fetching expiring users:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch expiring users'
            });
        }
    }
);

// GET /api/v1/admin/users/expired
router.get('/users/expired',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        try {
            const expiredUsers = await query(
                'SELECT * FROM get_expired_users()'
            );

            res.json({
                success: true,
                data: {
                    users: expiredUsers.rows,
                    count: expiredUsers.rows.length
                }
            });

        } catch (error) {
            console.error('Error fetching expired users:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch expired users'
            });
        }
    }
);

// POST /api/v1/admin/users/suspend-expired
router.post('/users/suspend-expired',
    authenticateToken,
    requireMaster,
    async (req, res) => {
        const startTime = Date.now();
        try {
            // Get expired users before suspending
            const expiredUsers = await query('SELECT * FROM get_expired_users()');
            
            // Run the suspension function
            const result = await query('SELECT suspend_expired_users() as count');
            const suspendedCount = result.rows[0]?.count || 0;

            // Log the bulk operation
            await logAdminActivity(
                req.user.id,
                'bulk_suspend_expired_users',
                'system',
                'billing',
                {
                    suspended_count: suspendedCount,
                    users: expiredUsers.rows.map(u => u.user_id)
                },
                req.ip,
                req.get('User-Agent'),
                {
                    category: 'billing',
                    severity: 'warning',
                    requestMethod: req.method,
                    requestUrl: req.originalUrl,
                    responseStatus: 200,
                    durationMs: Date.now() - startTime
                }
            );

            res.json({
                success: true,
                data: {
                    suspended_count: suspendedCount,
                    message: `Successfully suspended ${suspendedCount} expired user(s)`
                }
            });

        } catch (error) {
            console.error('Error suspending expired users:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to suspend expired users'
            });
        }
    }
);

// =====================
// BILLING SUMMARY
// =====================

// GET /api/v1/admin/billing/summary
router.get('/summary',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        try {
            // Get overall payment summary
            const summary = await query(`
                SELECT 
                    COUNT(DISTINCT user_id) as total_users,
                    COUNT(*) as total_payments,
                    SUM(amount) as total_revenue,
                    AVG(amount) as average_payment,
                    MAX(payment_date) as last_payment_date
                FROM payments
            `);

            // Get status breakdown
            const statusBreakdown = await query(`
                SELECT 
                    payment_status,
                    COUNT(*) as count
                FROM payment_summary
                GROUP BY payment_status
            `);

            // Get monthly revenue
            const monthlyRevenue = await query(`
                SELECT 
                    payment_month,
                    COUNT(*) as payment_count,
                    SUM(amount) as revenue
                FROM payments
                WHERE payment_date >= CURRENT_DATE - INTERVAL '12 months'
                GROUP BY payment_month
                ORDER BY payment_month DESC
            `);

            res.json({
                success: true,
                data: {
                    summary: summary.rows[0],
                    status_breakdown: statusBreakdown.rows,
                    monthly_revenue: monthlyRevenue.rows
                }
            });

        } catch (error) {
            console.error('Error fetching billing summary:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch billing summary'
            });
        }
    }
);

// =====================
// REMINDER SYSTEM
// =====================

// POST /api/v1/admin/reminders/send
router.post('/reminders/send',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        const startTime = Date.now();
        try {
            // Get users who need reminders
            const needReminders = await query(`
                SELECT * FROM get_expiring_users(7)
                WHERE user_id IN (
                    SELECT id FROM users 
                    WHERE payment_reminder_sent = FALSE 
                    OR reminder_sent_date < CURRENT_DATE - INTERVAL '7 days'
                )
            `);

            let sentCount = 0;
            const reminderResults = [];

            for (const user of needReminders.rows) {
                try {
                    // Here you would normally send an email/message
                    // For now, we'll just mark as sent
                    
                    await query(
                        'SELECT mark_reminder_sent($1)',
                        [user.user_id]
                    );

                    // Create a system message for the user
                    await query(`
                        INSERT INTO messages (
                            id, sender_id, recipient_id, subject, 
                            message, priority, created_at
                        ) VALUES (
                            'msg_' || gen_random_uuid(),
                            'system',
                            $1,
                            'Payment Reminder - Subscription Expiring Soon',
                            $2,
                            'high',
                            CURRENT_TIMESTAMP
                        )`,
                        [
                            user.user_id,
                            `Your subscription expires in ${user.days_remaining} days (${new Date(user.subscription_expires_at).toLocaleDateString()}). Please make your payment using reference: ${user.payment_reference}`
                        ]
                    );

                    sentCount++;
                    reminderResults.push({
                        user_id: user.user_id,
                        email: user.email,
                        status: 'sent'
                    });

                } catch (err) {
                    console.error(`Failed to send reminder to ${user.email}:`, err);
                    reminderResults.push({
                        user_id: user.user_id,
                        email: user.email,
                        status: 'failed',
                        error: err.message
                    });
                }
            }

            // Log the reminder operation
            await logAdminActivity(
                req.user.id,
                'payment_reminders_sent',
                'system',
                'billing',
                {
                    total_users: needReminders.rows.length,
                    sent_count: sentCount,
                    results: reminderResults
                },
                req.ip,
                req.get('User-Agent'),
                {
                    category: 'billing',
                    severity: 'info',
                    durationMs: Date.now() - startTime
                }
            );

            res.json({
                success: true,
                data: {
                    total_users: needReminders.rows.length,
                    sent_count: sentCount,
                    results: reminderResults
                }
            });

        } catch (error) {
            console.error('Error sending reminders:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to send payment reminders'
            });
        }
    }
);

module.exports = router;