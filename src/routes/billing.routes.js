// Billing System Routes
const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');
const { authenticateUser, requireAdmin: requireAdminAuth } = require('../middleware/auth');
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
    authenticateUser,
    requireAdminAuth,
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
    authenticateUser,
    requireAdminAuth,
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
    authenticateUser,
    requireAdminAuth,
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
    authenticateUser,
    requireAdminAuth,
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
    authenticateUser,
    requireAdminAuth,
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
    authenticateUser,
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
    authenticateUser,
    requireAdminAuth,
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
    authenticateUser,
    requireAdminAuth,
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

// =====================================================
// PROFIT-BASED BILLING SYSTEM (3% of Profit)
// Added: 2026-08-06
// =====================================================

// GET /api/v1/billing/my-invoice - Get current user's latest invoice
router.get('/my-invoice',
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            // Get user's current billing period
            const periodResult = await query(
                'SELECT * FROM get_user_billing_period($1)',
                [userId]
            );

            const period = periodResult.rows[0];
            if (!period) {
                return res.json({
                    success: true,
                    data: {
                        invoice: null,
                        message: 'No billing period found'
                    }
                });
            }

            // Get any existing invoice for current period
            const invoiceResult = await query(
                `SELECT * FROM billing_invoices
                 WHERE user_id = $1
                 ORDER BY billing_period_start DESC
                 LIMIT 1`,
                [userId]
            );

            const invoice = invoiceResult.rows[0] || null;

            // Get user's billing status
            const userResult = await query(
                'SELECT billing_status, next_billing_date FROM users WHERE id = $1',
                [userId]
            );

            res.json({
                success: true,
                data: {
                    invoice: invoice,
                    currentPeriod: period,
                    billingStatus: userResult.rows[0]?.billing_status || 'active',
                    canTrade: userResult.rows[0]?.billing_status !== 'blocked'
                }
            });

        } catch (error) {
            console.error('Error fetching user invoice:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch invoice'
            });
        }
    }
);

// GET /api/v1/billing/my-history - Get user's invoice history
router.get('/my-history',
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;
            const { limit = 12 } = req.query;

            const invoices = await query(
                `SELECT * FROM billing_invoices
                 WHERE user_id = $1
                 ORDER BY billing_period_start DESC
                 LIMIT $2`,
                [userId, limit]
            );

            res.json({
                success: true,
                data: {
                    invoices: invoices.rows,
                    count: invoices.rows.length
                }
            });

        } catch (error) {
            console.error('Error fetching invoice history:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch invoice history'
            });
        }
    }
);

// GET /api/v1/billing/profit-summary - Get user's current period profit
router.get('/profit-summary',
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            // Get user's current billing period
            const periodResult = await query(
                'SELECT * FROM get_user_billing_period($1)',
                [userId]
            );

            const period = periodResult.rows[0];
            if (!period) {
                return res.json({
                    success: true,
                    data: {
                        profit: 0,
                        feeAmount: 0,
                        period: null
                    }
                });
            }

            // Calculate profit for current period
            const profitResult = await query(
                'SELECT calculate_period_profit($1, $2, $3) as profit',
                [userId, period.period_start, period.period_end]
            );

            const profit = parseFloat(profitResult.rows[0]?.profit || 0);
            const feeAmount = profit > 0 ? profit * 0.03 : 0;

            // Get trade count for period
            const tradeCountResult = await query(
                `SELECT COUNT(*) as trade_count
                 FROM user_activity
                 WHERE user_id = $1
                 AND activity_type = 'trade_completed'
                 AND (activity_details->>'successful')::BOOLEAN = true
                 AND created_at >= $2
                 AND created_at < ($3::DATE + INTERVAL '1 day')`,
                [userId, period.period_start, period.period_end]
            );

            res.json({
                success: true,
                data: {
                    periodStart: period.period_start,
                    periodEnd: period.period_end,
                    periodNumber: period.period_number,
                    totalProfit: profit,
                    feePercentage: 0.03,
                    feeAmount: feeAmount,
                    tradeCount: parseInt(tradeCountResult.rows[0]?.trade_count || 0)
                }
            });

        } catch (error) {
            console.error('Error fetching profit summary:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch profit summary'
            });
        }
    }
);

// GET /api/v1/billing/can-trade - Check if user can trade
router.get('/can-trade',
    authenticateUser,
    async (req, res) => {
        try {
            const userId = req.user.id;

            const result = await query(
                'SELECT can_user_trade($1) as can_trade',
                [userId]
            );

            const canTrade = result.rows[0]?.can_trade ?? true;

            // If can't trade, get the unpaid invoice details
            let unpaidInvoice = null;
            if (!canTrade) {
                const invoiceResult = await query(
                    `SELECT * FROM billing_invoices
                     WHERE user_id = $1 AND status = 'unpaid'
                     ORDER BY billing_period_start DESC LIMIT 1`,
                    [userId]
                );
                unpaidInvoice = invoiceResult.rows[0] || null;
            }

            res.json({
                success: true,
                data: {
                    canTrade: canTrade,
                    unpaidInvoice: unpaidInvoice,
                    message: canTrade ? 'Trading allowed' : 'Please pay outstanding invoice to continue trading'
                }
            });

        } catch (error) {
            console.error('Error checking trade permission:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to check trade permission'
            });
        }
    }
);

// =====================
// ADMIN INVOICE MANAGEMENT
// =====================

// POST /api/v1/admin/billing/generate-invoice/:userId - Generate invoice for user
router.post('/generate-invoice/:userId',
    authenticateUser,
    requireAdminAuth,
    param('userId').notEmpty(),
    handleValidationErrors,
    async (req, res) => {
        const startTime = Date.now();
        try {
            const { userId } = req.params;

            // Generate invoice using database function
            const result = await query(
                'SELECT generate_user_invoice($1) as invoice_id',
                [userId]
            );

            const invoiceId = result.rows[0]?.invoice_id;

            if (!invoiceId) {
                // No invoice generated (user had no profit)
                return res.json({
                    success: true,
                    data: {
                        invoice: null,
                        message: 'No invoice generated - user had no profit this period'
                    }
                });
            }

            // Get the created invoice
            const invoiceResult = await query(
                'SELECT * FROM billing_invoices WHERE id = $1',
                [invoiceId]
            );

            // Log admin activity
            await logAdminActivity(
                req.user.id,
                'invoice_generated',
                'user',
                userId,
                {
                    invoice_id: invoiceId,
                    fee_amount: invoiceResult.rows[0]?.fee_amount,
                    total_profit: invoiceResult.rows[0]?.total_profit
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
                    invoice: invoiceResult.rows[0],
                    message: 'Invoice generated successfully'
                }
            });

        } catch (error) {
            console.error('Error generating invoice:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to generate invoice',
                details: error.message
            });
        }
    }
);

// POST /api/v1/admin/billing/mark-invoice-paid/:invoiceId - Mark invoice as paid
router.post('/mark-invoice-paid/:invoiceId',
    authenticateUser,
    requireAdminAuth,
    param('invoiceId').isInt(),
    body('txHash').notEmpty().withMessage('Transaction hash is required'),
    body('network').optional().isIn(['TRC20', 'ERC20', 'BEP20']).withMessage('Invalid network'),
    body('amount').optional().isFloat({ min: 0 }),
    handleValidationErrors,
    async (req, res) => {
        const startTime = Date.now();
        try {
            const { invoiceId } = req.params;
            const { txHash, network = 'TRC20', amount } = req.body;

            // Get invoice before update
            const beforeInvoice = await query(
                'SELECT * FROM billing_invoices WHERE id = $1',
                [invoiceId]
            );

            if (beforeInvoice.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Invoice not found'
                });
            }

            // Mark as paid using database function
            const result = await query(
                'SELECT mark_invoice_paid($1, $2, $3, $4) as success',
                [invoiceId, txHash, network, amount]
            );

            const success = result.rows[0]?.success;

            if (!success) {
                return res.status(400).json({
                    success: false,
                    error: 'Failed to mark invoice as paid - may already be paid'
                });
            }

            // Get updated invoice
            const afterInvoice = await query(
                'SELECT * FROM billing_invoices WHERE id = $1',
                [invoiceId]
            );

            // Log admin activity
            await logAdminActivity(
                req.user.id,
                'invoice_marked_paid',
                'billing',
                invoiceId.toString(),
                {
                    user_id: beforeInvoice.rows[0].user_id,
                    fee_amount: beforeInvoice.rows[0].fee_amount,
                    tx_hash: txHash,
                    network: network
                },
                req.ip,
                req.get('User-Agent'),
                {
                    category: 'billing',
                    severity: 'info',
                    beforeState: { status: 'unpaid' },
                    afterState: { status: 'paid', tx_hash: txHash },
                    durationMs: Date.now() - startTime
                }
            );

            res.json({
                success: true,
                data: {
                    invoice: afterInvoice.rows[0],
                    message: 'Invoice marked as paid - user can now trade'
                }
            });

        } catch (error) {
            console.error('Error marking invoice as paid:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to mark invoice as paid',
                details: error.message
            });
        }
    }
);

// GET /api/v1/admin/billing/pending-invoices - Get all unpaid invoices
router.get('/pending-invoices',
    authenticateUser,
    requireAdminAuth,
    async (req, res) => {
        try {
            const invoices = await query(
                `SELECT
                    bi.*,
                    u.email,
                    u.first_name,
                    u.last_name,
                    u.payment_reference,
                    EXTRACT(DAY FROM (CURRENT_TIMESTAMP - bi.generated_at)) as days_overdue
                 FROM billing_invoices bi
                 JOIN users u ON bi.user_id = u.id
                 WHERE bi.status = 'unpaid'
                 ORDER BY bi.generated_at ASC`
            );

            // Calculate totals
            const totalDue = invoices.rows.reduce((sum, inv) => sum + parseFloat(inv.fee_amount), 0);

            res.json({
                success: true,
                data: {
                    invoices: invoices.rows,
                    count: invoices.rows.length,
                    totalDue: totalDue
                }
            });

        } catch (error) {
            console.error('Error fetching pending invoices:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch pending invoices'
            });
        }
    }
);

// GET /api/v1/admin/billing/user-profit/:userId - Get specific user's profit summary
router.get('/user-profit/:userId',
    authenticateUser,
    requireAdminAuth,
    param('userId').notEmpty(),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { userId } = req.params;

            // Get user's current billing period
            const periodResult = await query(
                'SELECT * FROM get_user_billing_period($1)',
                [userId]
            );

            const period = periodResult.rows[0];
            if (!period) {
                return res.json({
                    success: true,
                    data: {
                        profit: 0,
                        period: null,
                        message: 'No billing period found for user'
                    }
                });
            }

            // Calculate profit
            const profitResult = await query(
                'SELECT calculate_period_profit($1, $2, $3) as profit',
                [userId, period.period_start, period.period_end]
            );

            const profit = parseFloat(profitResult.rows[0]?.profit || 0);
            const feeAmount = profit > 0 ? profit * 0.03 : 0;

            // Get user details
            const userResult = await query(
                `SELECT id, email, first_name, last_name, payment_reference,
                        billing_status, created_at, next_billing_date
                 FROM users WHERE id = $1`,
                [userId]
            );

            // Get existing invoice if any
            const invoiceResult = await query(
                `SELECT * FROM billing_invoices
                 WHERE user_id = $1 AND billing_period_start = $2`,
                [userId, period.period_start]
            );

            res.json({
                success: true,
                data: {
                    user: userResult.rows[0],
                    period: period,
                    totalProfit: profit,
                    feePercentage: 0.03,
                    feeAmount: feeAmount,
                    existingInvoice: invoiceResult.rows[0] || null
                }
            });

        } catch (error) {
            console.error('Error fetching user profit:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch user profit'
            });
        }
    }
);

module.exports = router;