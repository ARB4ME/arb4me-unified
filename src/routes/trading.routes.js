const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin, requireAdmin } = require('../middleware/auth');
const { tradingRateLimit, authenticatedRateLimit, adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { broadcastToAdmins } = require('../websocket/socketManager');

// Additional dependencies for exchange API integration
const crypto = require('crypto');
const https = require('https');

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

// ============================================================================
// LUNO EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// LUNO API Configuration
const LUNO_CONFIG = {
    baseUrl: 'https://api.luno.com',
    endpoints: {
        balance: '/api/1/balance',
        ticker: '/api/1/ticker',
        order: '/api/1/marketorder'
    }
};

// LUNO Authentication Helper - Simple Basic Auth
function createLunoAuth(apiKey, apiSecret) {
    return Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
}

// LUNO Balance Endpoint
router.post('/luno/balance', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('LUNO balance request initiated', {
            userId: req.user.id,
            exchange: 'luno',
            endpoint: 'balance'
        });
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform LUNO response to expected format
        const balances = {};
        if (balanceData.balance) {
            balanceData.balance.forEach(balance => {
                balances[balance.asset] = parseFloat(balance.balance);
            });
        }
        
        systemLogger.trading('LUNO balance retrieved successfully', {
            userId: req.user.id,
            exchange: 'luno',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('LUNO balance request failed', {
            userId: req.user.id,
            exchange: 'luno',
            error: error.message
        });
        
        throw new APIError(`LUNO balance request failed: ${error.message}`, 500, 'LUNO_BALANCE_ERROR');
    }
}));

// LUNO Ticker Endpoint
router.post('/luno/ticker', tradingRateLimit, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('LUNO ticker request initiated', {
            userId: req.user.id,
            exchange: 'luno',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle Luno's pair naming: convert USDT pairs to ZAR pairs
        let lunoPair = pair.replace('USDT', 'ZAR'); // Convert BTCUSDT -> BTCZAR
        if (lunoPair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.ticker}?pair=${lunoPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        systemLogger.trading('LUNO ticker retrieved successfully', {
            userId: req.user.id,
            exchange: 'luno',
            pair: lunoPair
        });
        
        res.json({
            success: true,
            data: {
                ticker: {
                    bid: parseFloat(tickerData.bid || 0),
                    ask: parseFloat(tickerData.ask || 0),
                    lastPrice: parseFloat(tickerData.last_trade || 0),
                    volume: parseFloat(tickerData.rolling_24_hour_volume || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('LUNO ticker request failed', {
            userId: req.user.id,
            exchange: 'luno',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`LUNO ticker request failed: ${error.message}`, 500, 'LUNO_TICKER_ERROR');
    }
}));

// LUNO Test Endpoint
router.post('/luno/test', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('LUNO connection test initiated', {
            userId: req.user.id,
            exchange: 'luno',
            endpoint: 'test'
        });
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        // Test connection by getting balance (minimal data)
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        systemLogger.trading('LUNO connection test successful', {
            userId: req.user.id,
            exchange: 'luno'
        });
        
        res.json({
            success: true,
            message: 'LUNO connection successful',
            data: {
                connected: true,
                balanceCount: balanceData.balance ? balanceData.balance.length : 0
            }
        });
        
    } catch (error) {
        systemLogger.error('LUNO connection test failed', {
            userId: req.user.id,
            exchange: 'luno',
            error: error.message
        });
        
        throw new APIError(`LUNO connection test failed: ${error.message}`, 500, 'LUNO_CONNECTION_ERROR');
    }
}));

// LUNO Buy Order Endpoint
router.post('/luno/buy-order', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume } = req.body;
    
    try {
        systemLogger.trading('LUNO buy order initiated', {
            userId: req.user.id,
            exchange: 'luno',
            endpoint: 'buy-order',
            pair,
            volume
        });
        
        // Handle Luno's different pair naming for Bitcoin
        let lunoPair = pair;
        if (pair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        const orderData = {
            pair: lunoPair,
            type: 'BUY',
            volume: volume.toString()
        };
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('LUNO buy order placed successfully', {
            userId: req.user.id,
            exchange: 'luno',
            orderId: orderResult.order_id,
            pair: lunoPair,
            volume
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_buy_order_placed', {
                orderId: orderResult.order_id,
                pair: lunoPair,
                volume,
                orderStatus: orderResult.state || 'PENDING',
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user.id,
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'LUNO',
            orderType: 'BUY',
            pair: lunoPair,
            volume,
            orderId: orderResult.order_id,
            status: orderResult.state || 'PENDING',
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderResult.order_id,
                    pair: lunoPair,
                    type: 'BUY',
                    volume,
                    status: orderResult.state || 'PENDING',
                    createdAt: orderResult.creation_timestamp || new Date()
                }
            },
            message: 'LUNO buy order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('LUNO buy order failed', {
            userId: req.user.id,
            exchange: 'luno',
            error: error.message,
            pair,
            volume
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_buy_order_failed', {
                pair,
                volume,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`LUNO buy order failed: ${error.message}`, 500, 'LUNO_BUY_ORDER_ERROR');
    }
}));

// LUNO Sell Order Endpoint
router.post('/luno/sell-order', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume } = req.body;
    
    try {
        systemLogger.trading('LUNO sell order initiated', {
            userId: req.user.id,
            exchange: 'luno',
            endpoint: 'sell-order',
            pair,
            volume
        });
        
        // Handle Luno's different pair naming for Bitcoin
        let lunoPair = pair;
        if (pair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        const orderData = {
            pair: lunoPair,
            type: 'SELL',
            volume: volume.toString()
        };
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('LUNO sell order placed successfully', {
            userId: req.user.id,
            exchange: 'luno',
            orderId: orderResult.order_id,
            pair: lunoPair,
            volume
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_sell_order_placed', {
                orderId: orderResult.order_id,
                pair: lunoPair,
                volume,
                orderStatus: orderResult.state || 'PENDING',
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user.id,
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'LUNO',
            orderType: 'SELL',
            pair: lunoPair,
            volume,
            orderId: orderResult.order_id,
            status: orderResult.state || 'PENDING',
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderResult.order_id,
                    pair: lunoPair,
                    type: 'SELL',
                    volume,
                    status: orderResult.state || 'PENDING',
                    createdAt: orderResult.creation_timestamp || new Date()
                }
            },
            message: 'LUNO sell order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('LUNO sell order failed', {
            userId: req.user.id,
            exchange: 'luno',
            error: error.message,
            pair,
            volume
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'luno_sell_order_failed', {
                pair,
                volume,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`LUNO sell order failed: ${error.message}`, 500, 'LUNO_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// VALR EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// VALR API Configuration
const VALR_CONFIG = {
    baseUrl: 'https://api.valr.com',
    endpoints: {
        balance: '/v1/account/balances',
        ticker: '/v1/public/marketsummary', 
        simpleBuyOrder: '/v1/simple/quotedorder',  // Updated to correct VALR endpoint
        simpleSellOrder: '/v1/simple/quotedorder', // Updated to correct VALR endpoint
        pairs: '/v1/public/pairs',
        orderStatus: '/v1/orders/:orderId',
        orderBook: '/v1/public/:pair/orderbook'
    }
};

// VALR Authentication Helper - FIXED TO MATCH FRONTEND BASE64 ENCODING
function createValrSignature(apiSecret, timestamp, verb, path, body = '') {
    const payload = timestamp + verb.toUpperCase() + path + (body || '');
    
    systemLogger.trading('VALR signature payload', {
        timestamp,
        method: verb.toUpperCase(),
        path,
        body: body || '',
        payload: payload
    });
    
    // Localhost server.js uses hex - match exactly
    const signature = crypto
        .createHmac('sha512', apiSecret)  // UTF-8 string
        .update(payload)
        .digest('hex');  // Use hex like working localhost server.js
    
    systemLogger.trading('VALR signature generated (hex)', { 
        signature: signature.substring(0, 20) + '...',
        encoding: 'hex',
        payloadLength: payload.length
    });
    
    return signature;
}

// VALR HTTP Request Helper
function makeValrRequest(endpoint, method, apiKey, apiSecret, body = null) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const path = endpoint;
        const bodyString = body ? JSON.stringify(body) : '';
        
        const options = {
            hostname: 'api.valr.com',
            path: path,
            method: method.toUpperCase(),
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'ARB4ME/1.0'
            }
        };
        
        // Add Content-Length if we have a body
        if (bodyString) {
            options.headers['Content-Length'] = Buffer.byteLength(bodyString);
        }
        
        // Only add authentication headers if API key is provided (for private endpoints)
        if (apiKey && apiSecret) {
            const signature = createValrSignature(apiSecret, timestamp.toString(), method, path, bodyString);
            // Use correct VALR header names (from working localhost version)
            options.headers['X-VALR-API-KEY'] = apiKey;
            options.headers['X-VALR-SIGNATURE'] = signature;
            options.headers['X-VALR-TIMESTAMP'] = timestamp.toString();
        }
        
        systemLogger.trading('VALR API request details', {
            method: method.toUpperCase(),
            path: path,
            hostname: options.hostname,
            headers: options.headers,
            bodyString: bodyString,
            hasAuth: !!(apiKey && apiSecret)
        });
        
        const req = https.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                systemLogger.trading('VALR API raw response', {
                    statusCode: res.statusCode,
                    data: data.substring(0, 500),
                    headers: res.headers
                });
                
                try {
                    if (!data || data.trim() === '') {
                        reject(new Error('Empty response from VALR API'));
                        return;
                    }
                    
                    const jsonData = JSON.parse(data);
                    
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(jsonData);
                    } else {
                        reject(new Error(jsonData.message || jsonData.error || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                } catch (parseError) {
                    reject(new Error(`Invalid JSON response from VALR: ${data.substring(0, 200)}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        if (bodyString) {
            req.write(bodyString);
        }
        
        req.end();
    });
}

// VALR Balance Endpoint
router.post('/valr/balance', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('VALR balance request initiated', {
            userId: req.user.id,
            exchange: 'valr',
            endpoint: 'balance'
        });
        
        // Call VALR API
        const balanceData = await makeValrRequest(
            VALR_CONFIG.endpoints.balance,
            'GET',
            apiKey,
            apiSecret
        );
        
        // Transform VALR response to expected format
        const balances = {};
        balanceData.forEach(balance => {
            balances[balance.currency] = parseFloat(balance.available) + parseFloat(balance.reserved);
        });
        
        systemLogger.trading('VALR balance retrieved successfully', {
            userId: req.user.id,
            exchange: 'valr',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('VALR balance request failed', {
            userId: req.user.id,
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR balance request failed: ${error.message}`, 500, 'VALR_BALANCE_ERROR');
    }
}));

// VALR Ticker Endpoint  
router.post('/valr/ticker', tradingRateLimit, asyncHandler(async (req, res) => {
    const { pair } = req.body;
    
    try {
        systemLogger.trading('VALR ticker request initiated', {
            userId: req.user.id,
            exchange: 'valr',
            endpoint: 'ticker',
            pair: pair
        });
        
        // VALR ticker is public endpoint, no authentication required
        const tickerData = await makeValrRequest(
            VALR_CONFIG.endpoints.ticker,
            'GET',
            null, // No API key needed for public endpoint
            null  // No secret needed for public endpoint
        );
        
        // Find the specific pair from all market summaries
        // VALR uses format like "BTCZAR", "ETHZAR", "USDTZAR" etc.
        const valrPair = pair.replace('USDT', 'ZAR'); // Convert BTCUSDT -> BTCZAR
        const pairData = tickerData.find(ticker => ticker.currencyPair === valrPair);
        
        if (!pairData) {
            throw new APIError(`Trading pair ${valrPair} not found on VALR`, 404, 'PAIR_NOT_FOUND');
        }
        
        // Format ticker response for consistency
        const formattedTicker = {
            lastPrice: parseFloat(pairData.lastTradedPrice),
            bid: parseFloat(pairData.bidPrice),
            ask: parseFloat(pairData.askPrice),
            volume: parseFloat(pairData.baseVolume),
            high: parseFloat(pairData.highPrice),
            low: parseFloat(pairData.lowPrice),
            change: parseFloat(pairData.changeFromPrevious)
        };
        
        systemLogger.trading('VALR ticker retrieved successfully', {
            userId: req.user.id,
            exchange: 'valr',
            pair: valrPair,
            lastPrice: formattedTicker.lastPrice
        });
        
        res.json({
            success: true,
            data: {
                ticker: formattedTicker
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR ticker request failed', {
            userId: req.user.id,
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR ticker request failed: ${error.message}`, 500, 'VALR_TICKER_ERROR');
    }
}));

// VALR Test Endpoint
router.post('/valr/test', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('VALR connection test initiated', {
            userId: req.user.id,
            exchange: 'valr',
            endpoint: 'test'
        });
        
        // Test connection by getting balance (minimal data)
        const balanceData = await makeValrRequest(
            VALR_CONFIG.endpoints.balance,
            'GET',
            apiKey,
            apiSecret
        );
        
        systemLogger.trading('VALR connection test successful', {
            userId: req.user.id,
            exchange: 'valr'
        });
        
        res.json({
            success: true,
            message: 'VALR connection successful',
            data: {
                connected: true,
                balanceCount: balanceData.length
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR connection test failed', {
            userId: req.user.id,
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR connection test failed: ${error.message}`, 500, 'VALR_CONNECTION_ERROR');
    }
}));

// VALR Buy Order Endpoint
router.post('/valr/buy-order', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('payInCurrency').notEmpty().withMessage('Pay-in currency is required'),
    body('payAmount').isFloat({ min: 0.01 }).withMessage('Pay amount must be a positive number'),
    body('customerOrderId').optional().isString().withMessage('Customer order ID must be string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, payInCurrency, payAmount, customerOrderId } = req.body;
    
    try {
        systemLogger.trading('VALR buy order initiated', {
            userId: req.user.id,
            exchange: 'valr',
            endpoint: 'buy-order',
            pair,
            payInCurrency,
            payAmount,
            customerOrderId
        });
        
        // Prepare order payload
        const orderPayload = {
            pair,
            payInCurrency,
            payAmount: parseFloat(payAmount).toString(),
            ...(customerOrderId && { customerOrderId })
        };
        
        // Call VALR API
        const orderData = await makeValrRequest(
            VALR_CONFIG.endpoints.simpleBuyOrder,
            'POST',
            apiKey,
            apiSecret,
            orderPayload
        );
        
        // Log successful order
        systemLogger.trading('VALR buy order placed successfully', {
            userId: req.user.id,
            exchange: 'valr',
            orderId: orderData.id,
            pair,
            payAmount,
            status: orderData.status
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_buy_order_placed', {
                orderId: orderData.id,
                pair,
                payInCurrency,
                payAmount,
                orderStatus: orderData.status,
                customerOrderId,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user.id,
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'VALR',
            orderType: 'BUY',
            pair,
            amount: payAmount,
            currency: payInCurrency,
            orderId: orderData.id,
            status: orderData.status,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderData.id,
                    pair,
                    payInCurrency,
                    payAmount,
                    status: orderData.status,
                    createdAt: orderData.createdAt || new Date(),
                    customerOrderId: orderData.customerOrderId
                }
            },
            message: 'VALR buy order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('VALR buy order failed', {
            userId: req.user.id,
            exchange: 'valr',
            error: error.message,
            pair,
            payAmount
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_buy_order_failed', {
                pair,
                payInCurrency,
                payAmount,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`VALR buy order failed: ${error.message}`, 500, 'VALR_BUY_ORDER_ERROR');
    }
}));

// VALR Sell Order Endpoint
router.post('/valr/sell-order', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('payAmount').isFloat({ min: 0.01 }).withMessage('Pay amount must be a positive number'),
    body('customerOrderId').optional().isString().withMessage('Customer order ID must be string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, payAmount, customerOrderId } = req.body;
    
    try {
        systemLogger.trading('VALR sell order initiated', {
            userId: req.user.id,
            exchange: 'valr',
            endpoint: 'sell-order',
            pair,
            payAmount,
            customerOrderId
        });
        
        // Prepare order payload
        const orderPayload = {
            pair,
            payAmount: parseFloat(payAmount).toString(),
            ...(customerOrderId && { customerOrderId })
        };
        
        // Call VALR API
        const orderData = await makeValrRequest(
            VALR_CONFIG.endpoints.simpleSellOrder,
            'POST',
            apiKey,
            apiSecret,
            orderPayload
        );
        
        // Log successful order
        systemLogger.trading('VALR sell order placed successfully', {
            userId: req.user.id,
            exchange: 'valr',
            orderId: orderData.id,
            pair,
            payAmount,
            status: orderData.status
        });
        
        // Record trade attempt in database
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_sell_order_placed', {
                orderId: orderData.id,
                pair,
                payAmount,
                orderStatus: orderData.status,
                customerOrderId,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        // Notify admins of trading activity
        broadcastToAdmins('user_trading_order', {
            userId: req.user.id,
            userName: `${req.user.first_name} ${req.user.last_name}`,
            exchange: 'VALR',
            orderType: 'SELL',
            pair,
            amount: payAmount,
            orderId: orderData.id,
            status: orderData.status,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            data: {
                order: {
                    id: orderData.id,
                    pair,
                    payAmount,
                    status: orderData.status,
                    createdAt: orderData.createdAt || new Date(),
                    customerOrderId: orderData.customerOrderId
                }
            },
            message: 'VALR sell order placed successfully'
        });
        
    } catch (error) {
        systemLogger.error('VALR sell order failed', {
            userId: req.user.id,
            exchange: 'valr',
            error: error.message,
            pair,
            payAmount
        });
        
        // Record failed order attempt
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'valr_sell_order_failed', {
                pair,
                payAmount,
                error: error.message,
                timestamp: new Date()
            }, req.ip, req.get('User-Agent')]
        );
        
        throw new APIError(`VALR sell order failed: ${error.message}`, 500, 'VALR_SELL_ORDER_ERROR');
    }
}));

// VALR Order Status Endpoint
router.post('/valr/order-status', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('orderId').notEmpty().withMessage('Order ID is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, orderId } = req.body;
    
    try {
        systemLogger.trading('VALR order status check initiated', {
            userId: req.user.id,
            exchange: 'valr',
            endpoint: 'order-status',
            orderId
        });
        
        // Call VALR API
        const orderData = await makeValrRequest(
            VALR_CONFIG.endpoints.orderStatus.replace(':orderId', orderId),
            'GET',
            apiKey,
            apiSecret
        );
        
        systemLogger.trading('VALR order status retrieved', {
            userId: req.user.id,
            exchange: 'valr',
            orderId,
            status: orderData.status
        });
        
        res.json({
            success: true,
            data: {
                order: orderData
            }
        });
        
    } catch (error) {
        systemLogger.error('VALR order status check failed', {
            userId: req.user.id,
            exchange: 'valr',
            error: error.message,
            orderId
        });
        
        throw new APIError(`VALR order status check failed: ${error.message}`, 500, 'VALR_ORDER_STATUS_ERROR');
    }
}));

// ============================================================================
// ALTCOINTRADER EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// AltCoinTrader API Configuration
const ALTCOINTRADER_CONFIG = {
    baseUrl: 'https://www.altcointrader.co.za/api',
    endpoints: {
        balance: '/balance',
        ticker: '/live_stats', 
        login: '/login',
        buy: '/order',
        sell: '/order'
    }
};

// AltCoinTrader Authentication Helper
async function createAltCoinTraderAuth(username, password) {
    // AltCoinTrader requires login to get auth token
    try {
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}${ALTCOINTRADER_CONFIG.endpoints.login}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                username: username,
                password: password
            })
        });

        if (!response.ok) {
            throw new Error(`Login failed: ${response.status}`);
        }

        const loginData = await response.json();
        return loginData.token; // Return the auth token
    } catch (error) {
        throw new Error(`AltCoinTrader authentication failed: ${error.message}`);
    }
}

// AltCoinTrader Balance Endpoint
router.post('/altcointrader/balance', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('Username is required'),
    body('apiSecret').notEmpty().withMessage('Password is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey: username, apiSecret: password } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader balance request initiated', {
            userId: req.user.id,
            exchange: 'altcointrader',
            endpoint: 'balance'
        });
        
        // Get auth token
        const authToken = await createAltCoinTraderAuth(username, password);
        
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}${ALTCOINTRADER_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform AltCoinTrader response to expected format
        const balances = {};
        if (balanceData && typeof balanceData === 'object') {
            Object.keys(balanceData).forEach(currency => {
                balances[currency] = parseFloat(balanceData[currency] || 0);
            });
        }
        
        systemLogger.trading('AltCoinTrader balance retrieved successfully', {
            userId: req.user.id,
            exchange: 'altcointrader',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader balance request failed', {
            userId: req.user.id,
            exchange: 'altcointrader',
            error: error.message
        });
        
        throw new APIError(`AltCoinTrader balance request failed: ${error.message}`, 500, 'ALTCOINTRADER_BALANCE_ERROR');
    }
}));

// AltCoinTrader Ticker Endpoint
router.post('/altcointrader/ticker', tradingRateLimit, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader ticker request initiated', {
            userId: req.user.id,
            exchange: 'altcointrader',
            endpoint: 'ticker',
            pair: pair
        });
        
        // AltCoinTrader ticker is public endpoint
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}${ALTCOINTRADER_CONFIG.endpoints.ticker}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        // Handle AltCoinTrader's pair naming: convert USDT pairs to ZAR pairs
        let altcoinPair = pair.replace('USDT', 'ZAR'); // Convert BTCUSDT -> BTCZAR
        let currency = altcoinPair.replace('ZAR', ''); // Extract currency (BTC, ETH, etc.)
        
        // Find the specific currency data
        const pairData = tickerData[currency];
        
        if (!pairData) {
            throw new APIError(`Trading pair ${currency} not found on AltCoinTrader`, 404, 'PAIR_NOT_FOUND');
        }
        
        systemLogger.trading('AltCoinTrader ticker retrieved successfully', {
            userId: req.user.id,
            exchange: 'altcointrader',
            pair: currency
        });
        
        res.json({
            success: true,
            data: {
                pair: altcoinPair,
                ticker: {
                    lastPrice: parseFloat(pairData.Price || 0),
                    bid: parseFloat(pairData.Buy || 0),
                    ask: parseFloat(pairData.Sell || 0),
                    volume: parseFloat(pairData.Volume || 0),
                    high: parseFloat(pairData.High || 0),
                    low: parseFloat(pairData.Low || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader ticker request failed', {
            userId: req.user.id,
            exchange: 'altcointrader',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`AltCoinTrader ticker request failed: ${error.message}`, 500, 'ALTCOINTRADER_TICKER_ERROR');
    }
}));

// AltCoinTrader Test Endpoint
router.post('/altcointrader/test', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('Username is required'),
    body('apiSecret').notEmpty().withMessage('Password is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey: username, apiSecret: password } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader connection test initiated', {
            userId: req.user.id,
            exchange: 'altcointrader',
            endpoint: 'test'
        });
        
        // Test connection by attempting to get auth token
        const authToken = await createAltCoinTraderAuth(username, password);
        
        systemLogger.trading('AltCoinTrader connection test successful', {
            userId: req.user.id,
            exchange: 'altcointrader'
        });
        
        res.json({
            success: true,
            message: 'AltCoinTrader connection successful',
            data: {
                connected: true,
                tokenReceived: !!authToken
            }
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader connection test failed', {
            userId: req.user.id,
            exchange: 'altcointrader',
            error: error.message
        });
        
        throw new APIError(`AltCoinTrader connection test failed: ${error.message}`, 500, 'ALTCOINTRADER_CONNECTION_ERROR');
    }
}));

// ============================================================================
// XAGO EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// XAGO API Configuration
const XAGO_CONFIG = {
    baseUrl: 'https://api.xago.io',
    endpoints: {
        balance: '/v1/account/balance',
        ticker: '/v1/market/ticker',
        login: '/v1/auth/login',
        order: '/v1/trading/order'
    }
};

// XAGO Authentication Helper
async function createXagoAuth(apiKey, apiSecret) {
    // XAGO uses API key/secret authentication
    try {
        const timestamp = Date.now().toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + apiKey)
            .digest('hex');
        
        return {
            apiKey,
            timestamp,
            signature
        };
    } catch (error) {
        throw new Error(`XAGO authentication failed: ${error.message}`);
    }
}

// XAGO Balance Endpoint
router.post('/xago/balance', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('XAGO balance request initiated', {
            userId: req.user.id,
            exchange: 'xago',
            endpoint: 'balance'
        });
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform XAGO response to expected format
        const balances = {};
        if (balanceData && balanceData.data) {
            balanceData.data.forEach(balance => {
                balances[balance.currency] = parseFloat(balance.available || 0);
            });
        }
        
        systemLogger.trading('XAGO balance retrieved successfully', {
            userId: req.user.id,
            exchange: 'xago',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('XAGO balance request failed', {
            userId: req.user.id,
            exchange: 'xago',
            error: error.message
        });
        
        throw new APIError(`XAGO balance request failed: ${error.message}`, 500, 'XAGO_BALANCE_ERROR');
    }
}));

// XAGO Ticker Endpoint
router.post('/xago/ticker', tradingRateLimit, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('XAGO ticker request initiated', {
            userId: req.user.id,
            exchange: 'xago',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle XAGO's pair naming: convert USDT pairs to ZAR pairs for SA market
        let xagoPair = pair.replace('USDT', 'ZAR');
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.ticker}?symbol=${xagoPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        if (!tickerData || !tickerData.data) {
            throw new APIError(`Trading pair ${xagoPair} not found on XAGO`, 404, 'PAIR_NOT_FOUND');
        }
        
        const pairData = tickerData.data;
        
        systemLogger.trading('XAGO ticker retrieved successfully', {
            userId: req.user.id,
            exchange: 'xago',
            pair: xagoPair
        });
        
        res.json({
            success: true,
            data: {
                pair: xagoPair,
                ticker: {
                    lastPrice: parseFloat(pairData.lastPrice || 0),
                    bid: parseFloat(pairData.bidPrice || 0),
                    ask: parseFloat(pairData.askPrice || 0),
                    volume: parseFloat(pairData.volume || 0),
                    high: parseFloat(pairData.highPrice || 0),
                    low: parseFloat(pairData.lowPrice || 0),
                    change: parseFloat(pairData.priceChange || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('XAGO ticker request failed', {
            userId: req.user.id,
            exchange: 'xago',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`XAGO ticker request failed: ${error.message}`, 500, 'XAGO_TICKER_ERROR');
    }
}));

// XAGO Test Endpoint
router.post('/xago/test', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('XAGO connection test initiated', {
            userId: req.user.id,
            exchange: 'xago',
            endpoint: 'test'
        });
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        // Test connection by getting balance
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        systemLogger.trading('XAGO connection test successful', {
            userId: req.user.id,
            exchange: 'xago'
        });
        
        res.json({
            success: true,
            message: 'XAGO connection successful',
            data: {
                connected: true,
                balanceCount: balanceData?.data?.length || 0
            }
        });
        
    } catch (error) {
        systemLogger.error('XAGO connection test failed', {
            userId: req.user.id,
            exchange: 'xago',
            error: error.message
        });
        
        throw new APIError(`XAGO connection test failed: ${error.message}`, 500, 'XAGO_CONNECTION_ERROR');
    }
}));

// ============================================================================
// CHAINEX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// ChainEX API Configuration
const CHAINEX_CONFIG = {
    baseUrl: 'https://api.chainex.io',
    endpoints: {
        balance: '/v1/account/balances',
        ticker: '/v1/market/ticker',
        order: '/v1/order'
    }
};

// ChainEX Authentication Helper
async function createChainEXAuth(apiKey, apiSecret) {
    // ChainEX uses API key/secret with timestamp and signature
    try {
        const timestamp = Date.now();
        const message = `${timestamp}${apiKey}`;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(message)
            .digest('hex');
        
        return {
            apiKey,
            timestamp: timestamp.toString(),
            signature
        };
    } catch (error) {
        throw new Error(`ChainEX authentication failed: ${error.message}`);
    }
}

// ChainEX Balance Endpoint
router.post('/chainex/balance', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('ChainEX balance request initiated', {
            userId: req.user.id,
            exchange: 'chainex',
            endpoint: 'balance'
        });
        
        const auth = await createChainEXAuth(apiKey, apiSecret);
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Transform ChainEX response to expected format
        const balances = {};
        if (balanceData && Array.isArray(balanceData)) {
            balanceData.forEach(balance => {
                balances[balance.asset] = parseFloat(balance.free || 0) + parseFloat(balance.locked || 0);
            });
        }
        
        systemLogger.trading('ChainEX balance retrieved successfully', {
            userId: req.user.id,
            exchange: 'chainex',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('ChainEX balance request failed', {
            userId: req.user.id,
            exchange: 'chainex',
            error: error.message
        });
        
        throw new APIError(`ChainEX balance request failed: ${error.message}`, 500, 'CHAINEX_BALANCE_ERROR');
    }
}));

// ChainEX Ticker Endpoint
router.post('/chainex/ticker', tradingRateLimit, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('ChainEX ticker request initiated', {
            userId: req.user.id,
            exchange: 'chainex',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle ChainEX's pair naming: convert USDT pairs to ZAR pairs for SA market
        let chainexPair = pair.replace('USDT', 'ZAR');
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.ticker}/${chainexPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const tickerData = await response.json();
        
        if (!tickerData) {
            throw new APIError(`Trading pair ${chainexPair} not found on ChainEX`, 404, 'PAIR_NOT_FOUND');
        }
        
        systemLogger.trading('ChainEX ticker retrieved successfully', {
            userId: req.user.id,
            exchange: 'chainex',
            pair: chainexPair
        });
        
        res.json({
            success: true,
            data: {
                pair: chainexPair,
                ticker: {
                    lastPrice: parseFloat(tickerData.last || 0),
                    bid: parseFloat(tickerData.bid || 0),
                    ask: parseFloat(tickerData.ask || 0),
                    volume: parseFloat(tickerData.volume || 0),
                    high: parseFloat(tickerData.high || 0),
                    low: parseFloat(tickerData.low || 0),
                    change: parseFloat(tickerData.change || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('ChainEX ticker request failed', {
            userId: req.user.id,
            exchange: 'chainex',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`ChainEX ticker request failed: ${error.message}`, 500, 'CHAINEX_TICKER_ERROR');
    }
}));

// ChainEX Test Endpoint
router.post('/chainex/test', tradingRateLimit, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('ChainEX connection test initiated', {
            userId: req.user.id,
            exchange: 'chainex',
            endpoint: 'test'
        });
        
        const auth = await createChainEXAuth(apiKey, apiSecret);
        
        // Test connection by getting balance
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.balance}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        systemLogger.trading('ChainEX connection test successful', {
            userId: req.user.id,
            exchange: 'chainex'
        });
        
        res.json({
            success: true,
            message: 'ChainEX connection successful',
            data: {
                connected: true,
                balanceCount: Array.isArray(balanceData) ? balanceData.length : 0
            }
        });
        
    } catch (error) {
        systemLogger.error('ChainEX connection test failed', {
            userId: req.user.id,
            exchange: 'chainex',
            error: error.message
        });
        
        throw new APIError(`ChainEX connection test failed: ${error.message}`, 500, 'CHAINEX_CONNECTION_ERROR');
    }
}));

module.exports = router;