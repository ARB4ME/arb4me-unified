const express = require('express');
const { query } = require('../database/connection');
const { requireAdmin } = require('../middleware/adminPermissions');
const { authenticateUser } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// Apply authentication and admin permissions
router.use(authenticateUser);
router.use(requireAdmin);

// GET /api/v1/analytics/dashboard - Get comprehensive analytics dashboard data
router.get('/dashboard', asyncHandler(async (req, res) => {
    try {
        // Get user statistics
        const userStats = await query(`
            SELECT 
                COUNT(*) as total_users,
                COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as new_today,
                COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as new_this_week,
                COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_this_month,
                COUNT(CASE WHEN subscription_plan != 'basic' THEN 1 END) as premium_users,
                COUNT(CASE WHEN subscription_expires_at > CURRENT_TIMESTAMP OR subscription_expires_at IS NULL THEN 1 END) as active_subscriptions
            FROM users
        `);

        // Get trading activity statistics
        const tradingStats = await query(`
            SELECT 
                COUNT(*) as total_traders,
                COUNT(CASE WHEN trading_active = true THEN 1 END) as active_traders,
                COUNT(CASE WHEN api_keys_configured = true THEN 1 END) as configured_traders,
                SUM(total_trades_count) as total_trades,
                SUM(successful_trades_count) as successful_trades,
                SUM(failed_trades_count) as failed_trades,
                SUM(profit_loss_total) as total_profit_loss,
                AVG(auto_trading_readiness_percent) as avg_readiness,
                COUNT(CASE WHEN last_trading_activity >= CURRENT_DATE - INTERVAL '24 hours' THEN 1 END) as active_24h
            FROM trading_activity
        `);

        // Get payment statistics
        const paymentStats = await query(`
            SELECT 
                COUNT(*) as total_payments,
                SUM(amount) as total_revenue,
                COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as payments_today,
                COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as payments_this_month,
                AVG(amount) as avg_payment_amount
            FROM payments
            WHERE status = 'completed'
        `);

        // Get subscription expiry warnings
        const expiryWarnings = await query(`
            SELECT 
                COUNT(CASE WHEN subscription_expires_at <= CURRENT_DATE + INTERVAL '3 days' AND subscription_expires_at > CURRENT_TIMESTAMP THEN 1 END) as expiring_3_days,
                COUNT(CASE WHEN subscription_expires_at <= CURRENT_DATE + INTERVAL '7 days' AND subscription_expires_at > CURRENT_TIMESTAMP THEN 1 END) as expiring_7_days,
                COUNT(CASE WHEN subscription_expires_at <= CURRENT_TIMESTAMP THEN 1 END) as already_expired
            FROM users
            WHERE subscription_expires_at IS NOT NULL
        `);

        // Get message statistics
        const messageStats = await query(`
            SELECT 
                COUNT(*) as total_messages,
                COUNT(CASE WHEN priority IN ('high', 'critical') THEN 1 END) as urgent_messages,
                COUNT(CASE WHEN replied = true OR is_admin_reply = true THEN 1 END) as replied_messages,
                COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as messages_today
            FROM messages
        `);

        // Calculate growth metrics
        const growthStats = await query(`
            SELECT 
                DATE(created_at) as signup_date,
                COUNT(*) as daily_signups
            FROM users 
            WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY signup_date DESC
            LIMIT 30
        `);

        // Get platform health metrics
        const healthMetrics = {
            userEngagementRate: userStats.rows[0].total_users > 0 
                ? Math.round((tradingStats.rows[0].active_24h / userStats.rows[0].total_users) * 100) 
                : 0,
            apiConfigurationRate: userStats.rows[0].total_users > 0 
                ? Math.round((tradingStats.rows[0].configured_traders / userStats.rows[0].total_users) * 100) 
                : 0,
            tradeSuccessRate: tradingStats.rows[0].total_trades > 0 
                ? Math.round((tradingStats.rows[0].successful_trades / tradingStats.rows[0].total_trades) * 100) 
                : 0,
            supportResponseRate: messageStats.rows[0].total_messages > 0 
                ? Math.round((messageStats.rows[0].replied_messages / messageStats.rows[0].total_messages) * 100) 
                : 100,
            averageTradeValue: tradingStats.rows[0].total_trades > 0 
                ? Math.round(Math.abs(tradingStats.rows[0].total_profit_loss) / tradingStats.rows[0].total_trades)
                : 0
        };

        res.json({
            success: true,
            data: {
                users: userStats.rows[0],
                trading: tradingStats.rows[0],
                payments: paymentStats.rows[0],
                expiry: expiryWarnings.rows[0],
                messages: messageStats.rows[0],
                growth: growthStats.rows,
                health: healthMetrics,
                generatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Analytics dashboard error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch analytics data',
            details: error.message
        });
    }
}));

// GET /api/v1/analytics/growth - Get user growth analytics
router.get('/growth', asyncHandler(async (req, res) => {
    const { period = '30d' } = req.query;
    
    let interval;
    let dateFormat;
    switch (period) {
        case '7d':
            interval = '7 days';
            dateFormat = 'Day DD';
            break;
        case '30d':
            interval = '30 days';
            dateFormat = 'MM-DD';
            break;
        case '90d':
            interval = '90 days';
            dateFormat = 'MM-DD';
            break;
        case '1y':
            interval = '365 days';
            dateFormat = 'YYYY-MM';
            break;
        default:
            interval = '30 days';
            dateFormat = 'MM-DD';
    }

    const growthData = await query(`
        SELECT 
            DATE(created_at) as date,
            COUNT(*) as new_users,
            COUNT(*) OVER (ORDER BY DATE(created_at)) as cumulative_users
        FROM users 
        WHERE created_at >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY DATE(created_at)
        ORDER BY date ASC
    `);

    res.json({
        success: true,
        data: {
            period,
            growth: growthData.rows
        }
    });
}));

// GET /api/v1/analytics/trading - Get trading analytics
router.get('/trading', asyncHandler(async (req, res) => {
    const { period = '30d' } = req.query;
    
    let interval;
    switch (period) {
        case '7d':
            interval = '7 days';
            break;
        case '30d':
            interval = '30 days';
            break;
        case '90d':
            interval = '90 days';
            break;
        default:
            interval = '30 days';
    }

    const tradingAnalytics = await query(`
        SELECT 
            COUNT(CASE WHEN trading_active = true THEN 1 END) as active_traders,
            COUNT(CASE WHEN api_keys_configured = true THEN 1 END) as configured_traders,
            SUM(total_trades_count) as total_trades,
            SUM(successful_trades_count) as successful_trades,
            SUM(profit_loss_total) as total_profit,
            AVG(auto_trading_readiness_percent) as avg_readiness,
            AVG(exchanges_connected_count) as avg_exchanges
        FROM trading_activity ta
        JOIN users u ON ta.user_id = u.id
        WHERE u.created_at >= CURRENT_DATE - INTERVAL '${interval}'
    `);

    // Get daily trading activity for charts
    const dailyActivity = await query(`
        SELECT 
            DATE(ta.last_trading_activity) as date,
            COUNT(DISTINCT ta.user_id) as active_traders,
            SUM(ta.total_trades_count) as daily_trades
        FROM trading_activity ta
        WHERE ta.last_trading_activity >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY DATE(ta.last_trading_activity)
        ORDER BY date ASC
    `);

    res.json({
        success: true,
        data: {
            period,
            summary: tradingAnalytics.rows[0],
            dailyActivity: dailyActivity.rows
        }
    });
}));

// GET /api/v1/analytics/revenue - Get revenue analytics
router.get('/revenue', asyncHandler(async (req, res) => {
    const { period = '30d' } = req.query;
    
    let interval;
    switch (period) {
        case '7d':
            interval = '7 days';
            break;
        case '30d':
            interval = '30 days';
            break;
        case '90d':
            interval = '90 days';
            break;
        case '1y':
            interval = '365 days';
            break;
        default:
            interval = '30 days';
    }

    const revenueAnalytics = await query(`
        SELECT 
            SUM(amount) as total_revenue,
            COUNT(*) as total_payments,
            AVG(amount) as avg_payment,
            COUNT(DISTINCT user_id) as paying_users
        FROM payments 
        WHERE status = 'completed' 
        AND created_at >= CURRENT_DATE - INTERVAL '${interval}'
    `);

    // Get daily revenue for charts
    const dailyRevenue = await query(`
        SELECT 
            DATE(created_at) as date,
            SUM(amount) as daily_revenue,
            COUNT(*) as daily_payments
        FROM payments
        WHERE status = 'completed' 
        AND created_at >= CURRENT_DATE - INTERVAL '${interval}'
        GROUP BY DATE(created_at)
        ORDER BY date ASC
    `);

    // Get subscription breakdown
    const subscriptionBreakdown = await query(`
        SELECT 
            u.subscription_plan,
            COUNT(*) as user_count,
            SUM(p.amount) as revenue_from_plan
        FROM users u
        LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
        WHERE u.subscription_plan IS NOT NULL
        GROUP BY u.subscription_plan
    `);

    res.json({
        success: true,
        data: {
            period,
            summary: revenueAnalytics.rows[0],
            dailyRevenue: dailyRevenue.rows,
            subscriptionBreakdown: subscriptionBreakdown.rows
        }
    });
}));

module.exports = router;