const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin, requireAdmin } = require('../middleware/auth');
const { tradingRateLimit, authenticatedRateLimit, adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { broadcastToAdmins } = require('../websocket/socketManager');

const router = express.Router();

// Apply authentication to all trading routes
router.use(authenticatedRateLimit);
router.use(authenticateUser);

// GET /api/v1/trading/activity - Get user's trading activity
router.get('/activity', asyncHandler(async (req, res) => {
    const activityResult = await query(`
        SELECT 
            exchanges_connected, exchanges_connected_count, selected_crypto_assets,
            trading_active, auto_trading_enabled, total_trades_count,
            successful_trades_count, failed_trades_count, profit_loss_total,
            api_keys_configured, usdt_balance_detected, safety_controls_completed,
            auto_trading_readiness_percent, last_trading_activity, created_at, updated_at
        FROM trading_activity
        WHERE user_id = $1
    `, [req.user.id]);
    
    if (activityResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const activity = activityResult.rows[0];
    
    res.json({
        success: true,
        data: {
            tradingActivity: {
                exchangesConnected: JSON.parse(activity.exchanges_connected || '[]'),
                exchangesConnectedCount: activity.exchanges_connected_count,
                selectedCryptoAssets: JSON.parse(activity.selected_crypto_assets || '[]'),
                tradingActive: activity.trading_active,
                autoTradingEnabled: activity.auto_trading_enabled,
                totalTrades: activity.total_trades_count,
                successfulTrades: activity.successful_trades_count,
                failedTrades: activity.failed_trades_count,
                profitLoss: parseFloat(activity.profit_loss_total),
                apiKeysConfigured: activity.api_keys_configured,
                usdtBalanceDetected: activity.usdt_balance_detected,
                safetyControlsCompleted: activity.safety_controls_completed,
                autoTradingReadinessPercent: activity.auto_trading_readiness_percent,
                lastTradingActivity: activity.last_trading_activity,
                createdAt: activity.created_at,
                updatedAt: activity.updated_at
            }
        }
    });
}));

// PUT /api/v1/trading/activity - Update trading activity (bulk update)
router.put('/activity', tradingRateLimit, [
    body('exchangesConnected').optional().isArray().withMessage('Exchanges connected must be an array'),
    body('selectedCryptoAssets').optional().isArray().withMessage('Selected crypto assets must be an array'),
    body('tradingActive').optional().isBoolean().withMessage('Trading active must be boolean'),
    body('autoTradingEnabled').optional().isBoolean().withMessage('Auto trading enabled must be boolean'),
    body('apiKeysConfigured').optional().isBoolean().withMessage('API keys configured must be boolean'),
    body('usdtBalanceDetected').optional().isBoolean().withMessage('USDT balance detected must be boolean'),
    body('safetyControlsCompleted').optional().isBoolean().withMessage('Safety controls completed must be boolean')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const {
        exchangesConnected,
        selectedCryptoAssets,
        tradingActive,
        autoTradingEnabled,
        apiKeysConfigured,
        usdtBalanceDetected,
        safetyControlsCompleted
    } = req.body;
    
    const updates = [];
    const values = [];
    let valueIndex = 1;
    
    // Build dynamic update query
    if (exchangesConnected !== undefined) {
        updates.push(`exchanges_connected = $${valueIndex++}`);
        values.push(JSON.stringify(exchangesConnected));
    }
    if (selectedCryptoAssets !== undefined) {
        updates.push(`selected_crypto_assets = $${valueIndex++}`);
        values.push(JSON.stringify(selectedCryptoAssets));
    }
    if (tradingActive !== undefined) {
        updates.push(`trading_active = $${valueIndex++}`);
        values.push(tradingActive);
    }
    if (autoTradingEnabled !== undefined) {
        updates.push(`auto_trading_enabled = $${valueIndex++}`);
        values.push(autoTradingEnabled);
    }
    if (apiKeysConfigured !== undefined) {
        updates.push(`api_keys_configured = $${valueIndex++}`);
        values.push(apiKeysConfigured);
    }
    if (usdtBalanceDetected !== undefined) {
        updates.push(`usdt_balance_detected = $${valueIndex++}`);
        values.push(usdtBalanceDetected);
    }
    if (safetyControlsCompleted !== undefined) {
        updates.push(`safety_controls_completed = $${valueIndex++}`);
        values.push(safetyControlsCompleted);
    }
    
    if (updates.length === 0) {
        throw new APIError('No valid fields to update', 400, 'NO_UPDATES');
    }
    
    // Add automatic fields
    updates.push('last_trading_activity = CURRENT_TIMESTAMP');
    updates.push('updated_at = CURRENT_TIMESTAMP');
    
    // Calculate readiness percentage
    let readinessScore = 0;
    if (apiKeysConfigured !== undefined ? apiKeysConfigured : false) readinessScore += 25;
    if (usdtBalanceDetected !== undefined ? usdtBalanceDetected : false) readinessScore += 25;
    if (safetyControlsCompleted !== undefined ? safetyControlsCompleted : false) readinessScore += 25;
    if (selectedCryptoAssets && selectedCryptoAssets.length > 0) readinessScore += 25;
    
    updates.push(`auto_trading_readiness_percent = $${valueIndex++}`);
    values.push(readinessScore);
    
    values.push(req.user.id);
    
    const updateResult = await query(
        `UPDATE trading_activity SET ${updates.join(', ')} WHERE user_id = $${valueIndex}
         RETURNING exchanges_connected, selected_crypto_assets, trading_active, auto_trading_enabled,
                   api_keys_configured, usdt_balance_detected, safety_controls_completed,
                   auto_trading_readiness_percent, last_trading_activity`,
        values
    );
    
    if (updateResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const updatedActivity = updateResult.rows[0];
    
    // Log user activity
    await query(
        'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [req.user.id, 'trading_activity_updated', {
            readinessPercent: readinessScore,
            tradingActive: tradingActive,
            autoTradingEnabled: autoTradingEnabled,
            assetsSelected: selectedCryptoAssets?.length || 0,
            exchangesConnected: exchangesConnected?.length || 0
        }, req.ip, req.get('User-Agent')]
    );
    
    // Notify admins if significant changes
    if (tradingActive !== undefined || autoTradingEnabled !== undefined) {
        broadcastToAdmins('user_trading_status_changed', {
            userId: req.user.id,
            userName: `${req.user.first_name} ${req.user.last_name}`,
            tradingActive: updatedActivity.trading_active,
            autoTradingEnabled: updatedActivity.auto_trading_enabled,
            readinessPercent: readinessScore,
            timestamp: new Date()
        });
    }
    
    systemLogger.trading('Trading activity updated', {
        userId: req.user.id,
        readinessPercent: readinessScore,
        tradingActive: updatedActivity.trading_active,
        autoTradingEnabled: updatedActivity.auto_trading_enabled
    });
    
    res.json({
        success: true,
        data: {
            tradingActivity: {
                exchangesConnected: JSON.parse(updatedActivity.exchanges_connected || '[]'),
                selectedCryptoAssets: JSON.parse(updatedActivity.selected_crypto_assets || '[]'),
                tradingActive: updatedActivity.trading_active,
                autoTradingEnabled: updatedActivity.auto_trading_enabled,
                apiKeysConfigured: updatedActivity.api_keys_configured,
                usdtBalanceDetected: updatedActivity.usdt_balance_detected,
                safetyControlsCompleted: updatedActivity.safety_controls_completed,
                autoTradingReadinessPercent: updatedActivity.auto_trading_readiness_percent,
                lastTradingActivity: updatedActivity.last_trading_activity
            }
        },
        message: 'Trading activity updated successfully'
    });
}));

// POST /api/v1/trading/trades - Record a completed trade
router.post('/trades', tradingRateLimit, [
    body('exchangePair').notEmpty().withMessage('Exchange pair is required'),
    body('asset').notEmpty().withMessage('Asset is required'),
    body('buyExchange').notEmpty().withMessage('Buy exchange is required'),
    body('sellExchange').notEmpty().withMessage('Sell exchange is required'),
    body('buyPrice').isFloat({ min: 0 }).withMessage('Buy price must be a positive number'),
    body('sellPrice').isFloat({ min: 0 }).withMessage('Sell price must be a positive number'),
    body('amount').isFloat({ min: 0 }).withMessage('Amount must be a positive number'),
    body('profit').isFloat().withMessage('Profit must be a number'),
    body('fees').optional().isFloat({ min: 0 }).withMessage('Fees must be a positive number'),
    body('successful').isBoolean().withMessage('Successful must be boolean'),
    body('errorMessage').optional().isString().withMessage('Error message must be string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const {
        exchangePair,
        asset,
        buyExchange,
        sellExchange,
        buyPrice,
        sellPrice,
        amount,
        profit,
        fees = 0,
        successful,
        errorMessage
    } = req.body;
    
    await transaction(async (client) => {
        // Update trading activity statistics
        const updateQuery = `
            UPDATE trading_activity 
            SET total_trades_count = total_trades_count + 1,
                successful_trades_count = successful_trades_count + ${successful ? 1 : 0},
                failed_trades_count = failed_trades_count + ${successful ? 0 : 1},
                profit_loss_total = profit_loss_total + $2,
                last_trading_activity = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
            RETURNING total_trades_count, successful_trades_count, failed_trades_count, profit_loss_total
        `;
        
        const updateResult = await client.query(updateQuery, [req.user.id, profit]);
        
        if (updateResult.rows.length === 0) {
            throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
        }
        
        const stats = updateResult.rows[0];
        
        // Log detailed trade information
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'trade_completed', {
                exchangePair,
                asset,
                buyExchange,
                sellExchange,
                buyPrice,
                sellPrice,
                amount,
                profit,
                fees,
                successful,
                errorMessage,
                netProfit: profit - fees,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of significant trades or failures
        if (!successful || Math.abs(profit) > 100) { // Failed trades or large profits
            broadcastToAdmins('significant_trade_event', {
                userId: req.user.id,
                userName: `${req.user.first_name} ${req.user.last_name}`,
                asset,
                profit,
                successful,
                errorMessage,
                exchangePair: `${buyExchange} → ${sellExchange}`,
                timestamp: new Date()
            });
        }
        
        systemLogger.trading('Trade recorded', {
            userId: req.user.id,
            asset,
            profit,
            successful,
            totalTrades: stats.total_trades_count,
            totalProfit: parseFloat(stats.profit_loss_total)
        });
        
        res.status(201).json({
            success: true,
            data: {
                trade: {
                    exchangePair,
                    asset,
                    buyExchange,
                    sellExchange,
                    buyPrice,
                    sellPrice,
                    amount,
                    profit,
                    fees,
                    netProfit: profit - fees,
                    successful,
                    timestamp: new Date()
                },
                updatedStats: {
                    totalTrades: stats.total_trades_count,
                    successfulTrades: stats.successful_trades_count,
                    failedTrades: stats.failed_trades_count,
                    totalProfitLoss: parseFloat(stats.profit_loss_total)
                }
            },
            message: 'Trade recorded successfully'
        });
    });
}));

// GET /api/v1/trading/trades/history - Get user's trade history
router.get('/trades/history', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const successful = req.query.successful; // true, false, or undefined for all
    const asset = req.query.asset; // filter by specific asset
    
    let whereClause = 'WHERE ua.user_id = $1 AND ua.activity_type = $2';
    const queryParams = [req.user.id, 'trade_completed'];
    let paramIndex = 3;
    
    if (successful !== undefined) {
        whereClause += ` AND (ua.activity_details->>'successful')::boolean = $${paramIndex++}`;
        queryParams.push(successful === 'true');
    }
    
    if (asset) {
        whereClause += ` AND ua.activity_details->>'asset' = $${paramIndex++}`;
        queryParams.push(asset);
    }
    
    queryParams.push(limit, offset);
    
    const tradesResult = await query(`
        SELECT ua.activity_details, ua.created_at
        FROM user_activity ua
        ${whereClause}
        ORDER BY ua.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, queryParams);
    
    // Get total count
    const countParams = queryParams.slice(0, -2);
    const countResult = await query(`
        SELECT COUNT(*) as total
        FROM user_activity ua
        ${whereClause.replace(/\$(\d+)/g, (match, num) => {
            const newNum = parseInt(num);
            return newNum <= countParams.length ? match : '';
        })}
    `, countParams);
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    const trades = tradesResult.rows.map(row => ({
        ...row.activity_details,
        timestamp: row.created_at
    }));
    
    res.json({
        success: true,
        data: {
            trades,
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// GET /api/v1/trading/stats - Get trading statistics and analytics
router.get('/stats', asyncHandler(async (req, res) => {
    const timeRange = req.query.range || '30d'; // 7d, 30d, 90d, all
    
    let interval = '30 days';
    if (timeRange === '7d') interval = '7 days';
    else if (timeRange === '90d') interval = '90 days';
    
    // Get basic trading stats
    const basicStatsResult = await query(`
        SELECT 
            total_trades_count, successful_trades_count, failed_trades_count,
            profit_loss_total, auto_trading_readiness_percent,
            trading_active, auto_trading_enabled, last_trading_activity
        FROM trading_activity
        WHERE user_id = $1
    `, [req.user.id]);
    
    if (basicStatsResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const basicStats = basicStatsResult.rows[0];
    
    // Get trade history within time range (if not 'all')
    let timeCondition = '';
    const params = [req.user.id, 'trade_completed'];
    
    if (timeRange !== 'all') {
        timeCondition = 'AND ua.created_at > NOW() - INTERVAL $3';
        params.push(interval);
    }
    
    const tradeHistoryResult = await query(`
        SELECT 
            (ua.activity_details->>'successful')::boolean as successful,
            (ua.activity_details->>'profit')::decimal as profit,
            ua.activity_details->>'asset' as asset,
            ua.activity_details->>'buyExchange' as buy_exchange,
            ua.activity_details->>'sellExchange' as sell_exchange,
            DATE_TRUNC('day', ua.created_at) as trade_date
        FROM user_activity ua
        WHERE ua.user_id = $1 AND ua.activity_type = $2 ${timeCondition}
        ORDER BY ua.created_at DESC
    `, params);
    
    // Calculate statistics
    const trades = tradeHistoryResult.rows;
    const successfulTrades = trades.filter(t => t.successful);
    const failedTrades = trades.filter(t => !t.successful);
    
    // Profit by day
    const profitByDay = {};
    trades.forEach(trade => {
        const day = trade.trade_date.toISOString().split('T')[0];
        if (!profitByDay[day]) profitByDay[day] = 0;
        profitByDay[day] += parseFloat(trade.profit || 0);
    });
    
    // Most profitable assets
    const assetProfits = {};
    trades.forEach(trade => {
        const asset = trade.asset;
        if (!assetProfits[asset]) assetProfits[asset] = { profit: 0, count: 0 };
        assetProfits[asset].profit += parseFloat(trade.profit || 0);
        assetProfits[asset].count += 1;
    });
    
    // Exchange pair performance
    const exchangePairStats = {};
    trades.forEach(trade => {
        const pair = `${trade.buy_exchange} → ${trade.sell_exchange}`;
        if (!exchangePairStats[pair]) {
            exchangePairStats[pair] = { trades: 0, profit: 0, successful: 0 };
        }
        exchangePairStats[pair].trades += 1;
        exchangePairStats[pair].profit += parseFloat(trade.profit || 0);
        if (trade.successful) exchangePairStats[pair].successful += 1;
    });
    
    const stats = {
        overview: {
            totalTrades: basicStats.total_trades_count,
            successfulTrades: basicStats.successful_trades_count,
            failedTrades: basicStats.failed_trades_count,
            successRate: basicStats.total_trades_count > 0 
                ? (basicStats.successful_trades_count / basicStats.total_trades_count * 100).toFixed(2)
                : 0,
            totalProfitLoss: parseFloat(basicStats.profit_loss_total),
            avgProfitPerTrade: trades.length > 0 
                ? (trades.reduce((sum, t) => sum + parseFloat(t.profit || 0), 0) / trades.length).toFixed(4)
                : 0,
            autoTradingReadiness: basicStats.auto_trading_readiness_percent,
            tradingActive: basicStats.trading_active,
            autoTradingEnabled: basicStats.auto_trading_enabled,
            lastActivity: basicStats.last_trading_activity
        },
        timeRange: {
            period: timeRange,
            tradesInPeriod: trades.length,
            profitInPeriod: trades.reduce((sum, t) => sum + parseFloat(t.profit || 0), 0).toFixed(4),
            successfulInPeriod: successfulTrades.length,
            failedInPeriod: failedTrades.length
        },
        profitByDay: Object.entries(profitByDay)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, profit]) => ({
                date,
                profit: parseFloat(profit.toFixed(4))
            })),
        topAssets: Object.entries(assetProfits)
            .sort(([,a], [,b]) => b.profit - a.profit)
            .slice(0, 10)
            .map(([asset, data]) => ({
                asset,
                profit: parseFloat(data.profit.toFixed(4)),
                trades: data.count,
                avgProfitPerTrade: parseFloat((data.profit / data.count).toFixed(4))
            })),
        exchangePairPerformance: Object.entries(exchangePairStats)
            .sort(([,a], [,b]) => b.profit - a.profit)
            .slice(0, 10)
            .map(([pair, data]) => ({
                pair,
                trades: data.trades,
                profit: parseFloat(data.profit.toFixed(4)),
                successfulTrades: data.successful,
                successRate: ((data.successful / data.trades) * 100).toFixed(2)
            }))
    };
    
    res.json({
        success: true,
        data: stats
    });
}));

// Admin-only routes for trading oversight
// GET /api/v1/trading/admin/overview - Get platform-wide trading overview
router.get('/admin/overview', adminRateLimit, requireAdmin, asyncHandler(async (req, res) => {
    // Get platform-wide trading statistics
    const platformStatsResult = await query(`
        SELECT 
            COUNT(DISTINCT user_id) as total_active_traders,
            COUNT(DISTINCT CASE WHEN trading_active = true THEN user_id END) as currently_trading,
            COUNT(DISTINCT CASE WHEN auto_trading_enabled = true THEN user_id END) as auto_trading_users,
            SUM(total_trades_count) as platform_total_trades,
            SUM(successful_trades_count) as platform_successful_trades,
            SUM(failed_trades_count) as platform_failed_trades,
            SUM(profit_loss_total) as platform_total_profit,
            AVG(auto_trading_readiness_percent) as avg_readiness_percent
        FROM trading_activity
    `);
    
    // Get recent trading activity (last 24 hours)
    const recentActivityResult = await query(`
        SELECT 
            u.id, u.first_name, u.last_name,
            ua.activity_details, ua.created_at
        FROM user_activity ua
        JOIN users u ON ua.user_id = u.id
        WHERE ua.activity_type = 'trade_completed' 
          AND ua.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY ua.created_at DESC
        LIMIT 50
    `);
    
    // Get top performers (last 30 days)
    const topPerformersResult = await query(`
        SELECT 
            u.id, u.first_name, u.last_name,
            ta.total_trades_count, ta.successful_trades_count, ta.profit_loss_total,
            COUNT(ua.id) as recent_trades,
            SUM((ua.activity_details->>'profit')::decimal) as recent_profit
        FROM trading_activity ta
        JOIN users u ON ta.user_id = u.id
        LEFT JOIN user_activity ua ON (
            ua.user_id = u.id 
            AND ua.activity_type = 'trade_completed'
            AND ua.created_at > NOW() - INTERVAL '30 days'
        )
        WHERE ta.total_trades_count > 0
        GROUP BY u.id, u.first_name, u.last_name, ta.total_trades_count, 
                 ta.successful_trades_count, ta.profit_loss_total
        ORDER BY recent_profit DESC NULLS LAST
        LIMIT 20
    `);
    
    const platformOverview = {
        statistics: {
            totalActiveTraders: parseInt(platformStatsResult.rows[0].total_active_traders),
            currentlyTrading: parseInt(platformStatsResult.rows[0].currently_trading),
            autoTradingUsers: parseInt(platformStatsResult.rows[0].auto_trading_users),
            platformTotalTrades: parseInt(platformStatsResult.rows[0].platform_total_trades),
            platformSuccessfulTrades: parseInt(platformStatsResult.rows[0].platform_successful_trades),
            platformFailedTrades: parseInt(platformStatsResult.rows[0].platform_failed_trades),
            platformTotalProfit: parseFloat(platformStatsResult.rows[0].platform_total_profit || 0),
            avgReadinessPercent: parseFloat(platformStatsResult.rows[0].avg_readiness_percent || 0),
            platformSuccessRate: platformStatsResult.rows[0].platform_total_trades > 0
                ? ((platformStatsResult.rows[0].platform_successful_trades / platformStatsResult.rows[0].platform_total_trades) * 100).toFixed(2)
                : 0
        },
        recentActivity: recentActivityResult.rows.map(row => ({
            userId: row.id,
            userName: `${row.first_name} ${row.last_name}`,
            tradeDetails: row.activity_details,
            timestamp: row.created_at
        })),
        topPerformers: topPerformersResult.rows.map(row => ({
            userId: row.id,
            userName: `${row.first_name} ${row.last_name}`,
            totalTrades: row.total_trades_count,
            successfulTrades: row.successful_trades_count,
            allTimeProfit: parseFloat(row.profit_loss_total || 0),
            recentTrades: parseInt(row.recent_trades || 0),
            recentProfit: parseFloat(row.recent_profit || 0)
        })),
        timestamp: new Date()
    };
    
    systemLogger.admin('Trading platform overview accessed', {
        adminId: req.user.id
    });
    
    res.json({
        success: true,
        data: platformOverview
    });
}));

// GET /api/v1/trading/admin/user/:userId/activity - Get specific user's trading activity (admin view)
router.get('/admin/user/:userId/activity', requireAdmin, asyncHandler(async (req, res) => {
    const userId = req.params.userId;
    
    // Get user's complete trading activity
    const userActivityResult = await query(`
        SELECT 
            ta.*, 
            u.first_name, u.last_name, u.email
        FROM trading_activity ta
        JOIN users u ON ta.user_id = u.id
        WHERE ta.user_id = $1
    `, [userId]);
    
    if (userActivityResult.rows.length === 0) {
        throw new APIError('User trading activity not found', 404, 'USER_TRADING_NOT_FOUND');
    }
    
    const activity = userActivityResult.rows[0];
    
    // Get recent trades
    const recentTradesResult = await query(`
        SELECT activity_details, created_at
        FROM user_activity
        WHERE user_id = $1 AND activity_type = 'trade_completed'
        ORDER BY created_at DESC
        LIMIT 50
    `, [userId]);
    
    const userTradingActivity = {
        userInfo: {
            id: userId,
            name: `${activity.first_name} ${activity.last_name}`,
            email: activity.email
        },
        tradingActivity: {
            exchangesConnected: JSON.parse(activity.exchanges_connected || '[]'),
            exchangesConnectedCount: activity.exchanges_connected_count,
            selectedCryptoAssets: JSON.parse(activity.selected_crypto_assets || '[]'),
            tradingActive: activity.trading_active,
            autoTradingEnabled: activity.auto_trading_enabled,
            totalTrades: activity.total_trades_count,
            successfulTrades: activity.successful_trades_count,
            failedTrades: activity.failed_trades_count,
            profitLoss: parseFloat(activity.profit_loss_total),
            apiKeysConfigured: activity.api_keys_configured,
            usdtBalanceDetected: activity.usdt_balance_detected,
            safetyControlsCompleted: activity.safety_controls_completed,
            autoTradingReadinessPercent: activity.auto_trading_readiness_percent,
            lastTradingActivity: activity.last_trading_activity,
            createdAt: activity.created_at,
            updatedAt: activity.updated_at
        },
        recentTrades: recentTradesResult.rows.map(row => ({
            ...row.activity_details,
            timestamp: row.created_at
        }))
    };
    
    systemLogger.admin('User trading activity accessed', {
        adminId: req.user.id,
        targetUserId: userId
    });
    
    res.json({
        success: true,
        data: userTradingActivity
    });
}));

module.exports = router;