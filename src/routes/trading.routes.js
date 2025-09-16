const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin, requireAdmin, optionalAuth } = require('../middleware/auth');
const { tradingRateLimit, tickerRateLimit, authenticatedRateLimit, adminRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { broadcastToAdmins } = require('../websocket/socketManager');

// Additional dependencies for exchange API integration
const crypto = require('crypto');
const https = require('https');

const router = express.Router();

// Note: We'll apply authentication selectively per route, not globally
// This allows balance endpoints to work without JWT when API keys are provided

// GET /api/v1/trading/activity - Get user's trading activity
router.get('/activity', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
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
router.put('/activity', authenticatedRateLimit, authenticateUser, tradingRateLimit, [
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
            userId: req.user?.id || 'anonymous',
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
router.post('/trades', authenticatedRateLimit, authenticateUser, tradingRateLimit, [
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
                userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
router.get('/trades/history', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
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
router.get('/stats', authenticatedRateLimit, authenticateUser, asyncHandler(async (req, res) => {
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
        tickers: '/api/1/tickers',
        order: '/api/1/marketorder'
    }
};

// LUNO Trading Pairs Endpoint
router.get('/luno/pairs', tickerRateLimit, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('LUNO pairs request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'pairs'
        });

        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.tickers}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const tickersData = await response.json();
        
        // Extract pairs from tickers response
        const pairs = tickersData.tickers.map(ticker => ({
            pair: ticker.pair,
            status: ticker.status,
            last_trade: ticker.last_trade,
            rolling_24_hour_volume: ticker.rolling_24_hour_volume
        }));
        
        systemLogger.trading('LUNO pairs retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            pairCount: pairs.length
        });

        res.json({
            success: true,
            pairs: pairs,
            exchange: 'LUNO'
        });

    } catch (error) {
        systemLogger.error('LUNO pairs request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message
        });

        throw new APIError(`LUNO pairs request failed: ${error.message}`, 500, 'LUNO_PAIRS_ERROR');
    }
}));

// LUNO Authentication Helper - Simple Basic Auth
function createLunoAuth(apiKey, apiSecret) {
    return Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
}

// LUNO Balance Endpoint
router.post('/luno/balance', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('LUNO balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message
        });
        
        throw new APIError(`LUNO balance request failed: ${error.message}`, 500, 'LUNO_BALANCE_ERROR');
    }
}));

// LUNO Ticker Endpoint
router.post('/luno/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('LUNO ticker request initiated', {
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`LUNO ticker request failed: ${error.message}`, 500, 'LUNO_TICKER_ERROR');
    }
}));

// LUNO Test Endpoint
router.post('/luno/test', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            error: error.message
        });
        
        throw new APIError(`LUNO connection test failed: ${error.message}`, 500, 'LUNO_CONNECTION_ERROR');
    }
}));

// LUNO Buy Order Endpoint
router.post('/luno/buy-order', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
router.post('/luno/sell-order', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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

// LUNO Triangular Arbitrage Endpoint - Execute single triangular trade step
router.post('/luno/triangular', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('side').isIn(['buy', 'sell']).withMessage('Side must be buy or sell'),
    body('amount').isFloat({ min: 0.0001 }).withMessage('Amount must be a positive number'),
    body('expectedPrice').isFloat({ min: 0 }).withMessage('Expected price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, side, amount, expectedPrice, type = 'market' } = req.body;
    
    try {
        systemLogger.trading('LUNO triangular trade initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            endpoint: 'triangular',
            pair,
            side,
            amount,
            type
        });
        
        // Handle Luno's different pair naming for Bitcoin
        let lunoPair = pair;
        if (pair === 'BTCZAR') {
            lunoPair = 'XBTZAR'; // Luno uses XBTZAR for Bitcoin
        }
        
        const auth = createLunoAuth(apiKey, apiSecret);
        
        // Calculate volume for market orders according to Luno API documentation
        let orderData;
        
        if (side.toUpperCase() === 'BUY') {
            // For BUY market orders, use counter_volume (amount in ZAR/quote currency)
            orderData = {
                pair: lunoPair,
                type: 'BUY',
                counter_volume: amount.toString() // Amount in ZAR
            };
        } else {
            // For SELL market orders, use base_volume (amount in crypto/base currency)
            const baseVolume = (amount / expectedPrice).toString();
            orderData = {
                pair: lunoPair,
                type: 'SELL',
                base_volume: baseVolume // Amount in crypto (e.g., BTC, ETH, etc.)
            };
        }
        
        // Log the exact request being sent for debugging
        systemLogger.trading('LUNO triangular order request', {
            endpoint: `${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`,
            orderData: orderData,
            side: side.toUpperCase()
        });
        
        const response = await fetch(`${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorData = await response.text();
            systemLogger.error('LUNO triangular order failed - API response', {
                status: response.status,
                error: errorData,
                sentData: orderData,
                endpoint: `${LUNO_CONFIG.baseUrl}${LUNO_CONFIG.endpoints.order}`
            });
            throw new Error(`HTTP ${response.status}: ${errorData}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('LUNO triangular trade successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'luno',
            orderId: orderResult.order_id,
            pair: lunoPair,
            side,
            executedAmount: orderResult.volume,
            executedPrice: orderResult.price
        });
        
        res.json({
            success: true,
            data: {
                orderId: orderResult.order_id,
                pair: lunoPair,
                side: side.toUpperCase(),
                executedAmount: parseFloat(orderResult.volume),
                executedPrice: parseFloat(orderResult.price),
                fee: parseFloat(orderResult.fee || '0'),
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        systemLogger.error('LUNO triangular trade failed', {
            userId: req.user?.id || 'anonymous',
            error: error.message,
            pair,
            side,
            amount
        });
        throw new APIError(`LUNO triangular trade failed: ${error.message}`, 500, 'LUNO_TRIANGULAR_ERROR');
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

// VALR Trading Pairs Endpoint
router.get('/valr/pairs', tickerRateLimit, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('VALR pairs request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            endpoint: 'pairs'
        });

        const response = await fetch(`${VALR_CONFIG.baseUrl}${VALR_CONFIG.endpoints.pairs}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const pairsData = await response.json();
        
        systemLogger.trading('VALR pairs retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            pairCount: pairsData.length
        });

        res.json({
            success: true,
            pairs: pairsData,
            exchange: 'VALR'
        });

    } catch (error) {
        systemLogger.error('VALR pairs request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });

        throw new APIError(`VALR pairs request failed: ${error.message}`, 500, 'VALR_PAIRS_ERROR');
    }
}));

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
router.post('/valr/balance', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('VALR balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR balance request failed: ${error.message}`, 500, 'VALR_BALANCE_ERROR');
    }
}));

// VALR Ticker Endpoint  
router.post('/valr/ticker', tickerRateLimit, optionalAuth, asyncHandler(async (req, res) => {
    const { pair } = req.body;
    
    try {
        systemLogger.trading('VALR ticker request initiated', {
            userId: req.user?.id || 'anonymous',
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
        let valrPair;
        if (pair === 'USDTZAR') {
            // Don't change USDTZAR - it's already correct for VALR
            valrPair = 'USDTZAR';
        } else if (pair.endsWith('USDT')) {
            // Convert crypto/USDT pairs to crypto/ZAR (e.g., BTCUSDT -> BTCZAR)
            valrPair = pair.replace('USDT', 'ZAR');
        } else {
            // Keep other pairs as is (BTCZAR, ETHZAR, etc.)
            valrPair = pair;
        }
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR ticker request failed: ${error.message}`, 500, 'VALR_TICKER_ERROR');
    }
}));

// VALR Test Endpoint
router.post('/valr/test', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'valr',
            error: error.message
        });
        
        throw new APIError(`VALR connection test failed: ${error.message}`, 500, 'VALR_CONNECTION_ERROR');
    }
}));

// VALR Buy Order Endpoint
router.post('/valr/buy-order', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
router.post('/valr/sell-order', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
router.post('/altcointrader/balance', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('AltCoinTrader balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message
        });
        
        throw new APIError(`AltCoinTrader balance request failed: ${error.message}`, 500, 'ALTCOINTRADER_BALANCE_ERROR');
    }
}));

// AltCoinTrader Ticker Endpoint
router.post('/altcointrader/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader ticker request initiated', {
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`AltCoinTrader ticker request failed: ${error.message}`, 500, 'ALTCOINTRADER_TICKER_ERROR');
    }
}));

// AltCoinTrader Test Endpoint
router.post('/altcointrader/test', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'test'
        });
        
        // Test connection by attempting to get auth token
        const authToken = await createAltCoinTraderAuth(username, password);
        
        systemLogger.trading('AltCoinTrader connection test successful', {
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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

// AltCoinTrader Buy Order Endpoint
router.post('/altcointrader/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'buy-order',
            pair,
            amount,
            price
        });
        
        // Format pair for AltCoinTrader (remove ZAR suffix if present)
        const altCoinTraderPair = pair.replace('ZAR', '').replace('USDT', '');
        
        const orderData = {
            coin: altCoinTraderPair,
            amount: amount.toString(),
            price: (price || 0).toString()
        };
        
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}/v3/simple-buy-order`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'X-API-SECRET': apiSecret,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('AltCoinTrader buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            orderId: orderResult.uuid,
            pair: altCoinTraderPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.uuid,
                price: parseFloat(orderResult.price),
                amount: parseFloat(orderResult.amount),
                fee: parseFloat(orderResult.fee || 0),
                status: orderResult.status,
                timestamp: orderResult.created_at
            }
        });
        
    } catch (error) {
        systemLogger.trading('AltCoinTrader buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`AltCoinTrader buy order failed: ${error.message}`, 500, 'ALTCOINTRADER_BUY_ORDER_ERROR');
    }
}));

// AltCoinTrader Sell Order Endpoint
router.post('/altcointrader/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('AltCoinTrader sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            endpoint: 'sell-order',
            pair,
            amount,
            price
        });
        
        // Format pair for AltCoinTrader (remove ZAR suffix if present)
        const altCoinTraderPair = pair.replace('ZAR', '').replace('USDT', '');
        
        const orderData = {
            coin: altCoinTraderPair,
            amount: amount.toString(),
            price: (price || 0).toString()
        };
        
        const response = await fetch(`${ALTCOINTRADER_CONFIG.baseUrl}/v3/simple-sell-order`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'X-API-SECRET': apiSecret,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('AltCoinTrader sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            orderId: orderResult.uuid,
            pair: altCoinTraderPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.uuid,
                price: parseFloat(orderResult.price),
                amount: parseFloat(orderResult.amount),
                fee: parseFloat(orderResult.fee || 0),
                status: orderResult.status,
                timestamp: orderResult.created_at
            }
        });
        
    } catch (error) {
        systemLogger.trading('AltCoinTrader sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'altcointrader',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`AltCoinTrader sell order failed: ${error.message}`, 500, 'ALTCOINTRADER_SELL_ORDER_ERROR');
    }
}));

// XAGO Balance Endpoint
router.post('/xago/balance', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('XAGO balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message
        });
        
        throw new APIError(`XAGO balance request failed: ${error.message}`, 500, 'XAGO_BALANCE_ERROR');
    }
}));

// XAGO Ticker Endpoint
router.post('/xago/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('XAGO ticker request initiated', {
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`XAGO ticker request failed: ${error.message}`, 500, 'XAGO_TICKER_ERROR');
    }
}));

// XAGO Test Endpoint
router.post('/xago/test', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message
        });
        
        throw new APIError(`XAGO connection test failed: ${error.message}`, 500, 'XAGO_CONNECTION_ERROR');
    }
}));

// XAGO Buy Order Endpoint
router.post('/xago/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('XAGO buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'buy-order',
            pair,
            amount,
            price
        });
        
        // Format pair for XAGO (convert USDT pairs to ZAR)
        let xagoPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        const orderData = {
            symbol: xagoPair,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('XAGO buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            orderId: orderResult.orderId,
            pair: xagoPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: xagoPair,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XAGO buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`XAGO buy order failed: ${error.message}`, 500, 'XAGO_BUY_ORDER_ERROR');
    }
}));

// XAGO Sell Order Endpoint
router.post('/xago/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('XAGO sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            endpoint: 'sell-order',
            pair,
            amount,
            price
        });
        
        // Format pair for XAGO (convert USDT pairs to ZAR)
        let xagoPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createXagoAuth(apiKey, apiSecret);
        
        const orderData = {
            symbol: xagoPair,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${XAGO_CONFIG.baseUrl}${XAGO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('XAGO sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            orderId: orderResult.orderId,
            pair: xagoPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: xagoPair,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XAGO sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xago',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`XAGO sell order failed: ${error.message}`, 500, 'XAGO_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// CHAINEX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// ChainEX API Configuration
const CHAINEX_CONFIG = {
    baseUrl: 'https://api.chainex.io',
    endpoints: {
        balance: '/wallet/balances',
        ticker: '/market/summary',
        markets: '/market/summary',
        order: '/trading/order'
    }
};

// ChainEX Trading Pairs Endpoint
router.get('/chainex/pairs', tickerRateLimit, asyncHandler(async (req, res) => {
    try {
        systemLogger.trading('ChainEX pairs request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'pairs'
        });

        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.markets}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const marketsData = await response.json();
        
        // Log the structure for debugging
        systemLogger.trading('ChainEX raw response structure', {
            hasStatus: !!marketsData.status,
            hasCount: !!marketsData.count,
            hasData: !!marketsData.data,
            dataType: marketsData.data ? typeof marketsData.data : 'no data field',
            dataIsArray: Array.isArray(marketsData.data),
            topLevelKeys: Object.keys(marketsData).slice(0, 10),
            sampleData: marketsData.data ? JSON.stringify(marketsData.data).slice(0, 200) : 'none'
        });
        
        let pairs = [];
        
        // ChainEX returns {status: "success", count: X, data: [...]}
        if (marketsData.status === 'success' && marketsData.data && Array.isArray(marketsData.data)) {
            pairs = marketsData.data.map(market => ({
                pair: market.market,  // ChainEX uses "market" field for pair name
                last: market.last_price || market.last || '0',
                high: market.high_price || market.high || '0',
                low: market.low_price || market.low || '0',
                volume: market.volume || market.baseVolume || '0',
                yesterday_price: market.yesterday_price,
                change_24h: market.change_24h
            }));
        } else if (typeof marketsData === 'object') {
            // Fallback: direct object with pairs as keys
            const marketPairs = Object.keys(marketsData).filter(key => {
                return key !== 'status' && key !== 'count' && key !== 'data' && 
                       key !== 'message' && marketsData[key] && 
                       typeof marketsData[key] === 'object';
            });
            
            pairs = marketPairs.map(pair => ({
                pair: pair,
                last: marketsData[pair].last || '0',
                high: marketsData[pair].high || '0',
                low: marketsData[pair].low || '0',
                volume: marketsData[pair].volume || '0'
            }));
        }
        
        systemLogger.trading('ChainEX pairs retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            pairCount: pairs.length
        });

        res.json({
            success: true,
            pairs: pairs,
            exchange: 'CHAINEX'
        });

    } catch (error) {
        systemLogger.error('ChainEX pairs request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message
        });

        throw new APIError(`ChainEX pairs request failed: ${error.message}`, 500, 'CHAINEX_PAIRS_ERROR');
    }
}));

// ChainEX Authentication Helper
function createChainEXAuth(apiKey, apiSecret, endpoint, queryParams = {}) {
    // ChainEX uses query string authentication with HMAC-SHA-256
    try {
        const time = Math.floor(Date.now() / 1000); // Unix timestamp
        
        // Build query string
        const params = new URLSearchParams({
            time: time.toString(),
            key: apiKey,
            ...queryParams
        });
        
        // Create full URL for hashing
        const fullUrl = `${CHAINEX_CONFIG.baseUrl}${endpoint}?${params.toString()}`;
        
        // Create hash of full URL
        const hash = crypto
            .createHmac('sha256', apiSecret)
            .update(fullUrl)
            .digest('hex');
        
        // Add hash to params
        params.append('hash', hash);
        
        return {
            queryString: params.toString(),
            fullUrl: `${CHAINEX_CONFIG.baseUrl}${endpoint}?${params.toString()}`
        };
    } catch (error) {
        throw new Error(`ChainEX authentication failed: ${error.message}`);
    }
}

// ChainEX Balance Endpoint
router.post('/chainex/balance', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'balance'
        });
        
        const auth = createChainEXAuth(apiKey, apiSecret, CHAINEX_CONFIG.endpoints.balance);
        
        const response = await fetch(auth.fullUrl, {
            method: 'GET'
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // ChainEX returns {status, count, data: [{code, balance_available, balance_held, ...}]}
        if (balanceData.status !== 'success') {
            throw new Error(`ChainEX API error: ${balanceData.message || 'Unknown error'}`);
        }
        
        // Transform ChainEX response to expected format
        const balances = {};
        if (balanceData.data && Array.isArray(balanceData.data)) {
            balanceData.data.forEach(balance => {
                balances[balance.code] = parseFloat(balance.balance_available || 0) + parseFloat(balance.balance_held || 0);
            });
        }
        
        systemLogger.trading('ChainEX balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            balances: balances
        });
        
    } catch (error) {
        systemLogger.error('ChainEX balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message
        });
        
        throw new APIError(`ChainEX balance request failed: ${error.message}`, 500, 'CHAINEX_BALANCE_ERROR');
    }
}));

// ChainEX Ticker Endpoint
router.post('/chainex/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('ChainEX ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Handle ChainEX's pair naming: convert USDT pairs to ZAR pairs for SA market
        let chainexPair;
        if (pair === 'USDTZAR') {
            // Don't change USDTZAR - it's already correct
            chainexPair = 'USDTZAR';
        } else if (pair.endsWith('USDT')) {
            // Convert crypto/USDT pairs to crypto/ZAR (e.g., BTCUSDT → BTCZAR)
            chainexPair = pair.replace('USDT', 'ZAR');
        } else {
            // Keep other pairs as is (BTCZAR, ETHZAR, etc.)
            chainexPair = pair;
        }
        
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
            userId: req.user?.id || 'anonymous',
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
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`ChainEX ticker request failed: ${error.message}`, 500, 'CHAINEX_TICKER_ERROR');
    }
}));

// ChainEX Test Endpoint
router.post('/chainex/test', tradingRateLimit, optionalAuth, [
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
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'test'
        });
        
        const auth = createChainEXAuth(apiKey, apiSecret, CHAINEX_CONFIG.endpoints.balance);
        
        // Test connection by getting balance
        const response = await fetch(auth.fullUrl, {
            method: 'GET'
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const balanceData = await response.json();
        
        // Check ChainEX response status
        if (balanceData.status !== 'success') {
            throw new Error(`ChainEX API error: ${balanceData.message || 'Unknown error'}`);
        }
        
        systemLogger.trading('ChainEX connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex'
        });
        
        res.json({
            success: true,
            message: 'ChainEX connection successful',
            data: {
                connected: true,
                balanceCount: balanceData.data ? balanceData.data.length : 0
            }
        });
        
    } catch (error) {
        systemLogger.error('ChainEX connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message
        });
        
        throw new APIError(`ChainEX connection test failed: ${error.message}`, 500, 'CHAINEX_CONNECTION_ERROR');
    }
}));

// ChainEX Buy Order Endpoint
router.post('/chainex/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('ChainEX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'buy-order',
            pair,
            amount,
            price
        });
        
        // Format pair for ChainEX (convert USDT pairs to ZAR if needed)
        let chainexPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createChainEXAuth(apiKey, apiSecret);
        
        const orderData = {
            market: chainexPair,
            side: 'buy',
            amount: amount.toString(),
            type: price ? 'limit' : 'market',
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('ChainEX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            orderId: orderResult.id,
            pair: chainexPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                market: chainexPair,
                side: 'buy',
                type: orderResult.type,
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.state,
                timestamp: orderResult.created_at || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ChainEX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`ChainEX buy order failed: ${error.message}`, 500, 'CHAINEX_BUY_ORDER_ERROR');
    }
}));

// ChainEX Sell Order Endpoint
router.post('/chainex/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, amount, price } = req.body;
    
    try {
        systemLogger.trading('ChainEX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            endpoint: 'sell-order',
            pair,
            amount,
            price
        });
        
        // Format pair for ChainEX (convert USDT pairs to ZAR if needed)
        let chainexPair = pair.replace('USDT', 'ZAR');
        
        const auth = await createChainEXAuth(apiKey, apiSecret);
        
        const orderData = {
            market: chainexPair,
            side: 'sell',
            amount: amount.toString(),
            type: price ? 'limit' : 'market',
            ...(price && { price: price.toString() })
        };
        
        const response = await fetch(`${CHAINEX_CONFIG.baseUrl}${CHAINEX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-API-KEY': auth.apiKey,
                'X-TIMESTAMP': auth.timestamp,
                'X-SIGNATURE': auth.signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('ChainEX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            orderId: orderResult.id,
            pair: chainexPair,
            amount,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                market: chainexPair,
                side: 'sell',
                type: orderResult.type,
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.state,
                timestamp: orderResult.created_at || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ChainEX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'chainex',
            error: error.message,
            pair,
            amount
        });
        
        throw new APIError(`ChainEX sell order failed: ${error.message}`, 500, 'CHAINEX_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BINANCE EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Get server IP endpoint
router.get('/server-ip', asyncHandler(async (req, res) => {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        res.json({ ip: data.ip, source: 'Railway Server' });
    } catch (error) {
        res.json({ error: 'Could not determine server IP' });
    }
}));

// Binance API Configuration
const BINANCE_CONFIG = {
    baseUrl: 'https://api.binance.com',
    endpoints: {
        balance: '/api/v3/account',
        ticker: '/api/v3/ticker/price',
        ticker24hr: '/api/v3/ticker/24hr',
        order: '/api/v3/order',
        time: '/api/v3/time'
    }
};

// Binance Authentication Helper
function createBinanceSignature(queryString, apiSecret) {
    return crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');
}

// Binance Balance Endpoint
router.post('/binance/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('Binance balance request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'balance'
        });
        
        const timestamp = Date.now();
        const recvWindow = 60000; // 60 second window for better reliability
        // Include recvWindow for better compatibility with trading-enabled API keys
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createBinanceSignature(queryString, apiSecret);
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.error('Binance balance API error', {
                userId: req.user?.id || 'anonymous',
                status: response.status,
                error: errorText
            });
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const accountData = await response.json();
        
        // Check for Binance-specific errors
        if (accountData.code && accountData.msg) {
            systemLogger.error('Binance API returned error', {
                userId: req.user?.id || 'anonymous',
                code: accountData.code,
                message: accountData.msg
            });
            throw new APIError(`Binance error ${accountData.code}: ${accountData.msg}`, 400, 'BINANCE_API_ERROR');
        }
        
        // Transform Binance response to expected format
        const balances = {};
        if (accountData && accountData.balances) {
            accountData.balances.forEach(balance => {
                const total = parseFloat(balance.free) + parseFloat(balance.locked);
                if (total > 0) {
                    balances[balance.asset] = total;
                }
            });
        }
        
        systemLogger.trading('Binance balance retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            balanceCount: Object.keys(balances).length
        });
        
        res.json({
            success: true,
            data: {
                exchange: 'binance',
                balances: balances
            }
        });
        
    } catch (error) {
        systemLogger.error('Binance balance request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message
        });
        
        // Return error details to frontend for debugging (like MEXC does)
        res.json({
            success: false,
            data: {
                exchange: 'binance',
                error: error.message || 'Failed to fetch Binance balance'
            }
        });
    }
}));

// Binance Ticker Endpoint
router.post('/binance/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { pair } = req.body;
    
    try {
        systemLogger.trading('Binance ticker request initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'ticker',
            pair: pair
        });
        
        // Binance uses direct USDT pairs (BTCUSDT, ETHUSDT, etc.)
        const binancePair = pair.toUpperCase();
        
        // Get both price and 24hr stats
        const [priceResponse, statsResponse] = await Promise.all([
            fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.ticker}?symbol=${binancePair}`),
            fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.ticker24hr}?symbol=${binancePair}`)
        ]);

        if (!priceResponse.ok || !statsResponse.ok) {
            const errorText = !priceResponse.ok ? await priceResponse.text() : await statsResponse.text();
            throw new Error(`HTTP ${!priceResponse.ok ? priceResponse.status : statsResponse.status}: ${errorText}`);
        }
        
        const priceData = await priceResponse.json();
        const statsData = await statsResponse.json();
        
        systemLogger.trading('Binance ticker retrieved successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            pair: binancePair
        });
        
        res.json({
            success: true,
            data: {
                pair: binancePair,
                ticker: {
                    lastPrice: parseFloat(priceData.price || statsData.lastPrice || 0),
                    bid: parseFloat(statsData.bidPrice || 0),
                    ask: parseFloat(statsData.askPrice || 0),
                    volume: parseFloat(statsData.volume || 0),
                    high: parseFloat(statsData.highPrice || 0),
                    low: parseFloat(statsData.lowPrice || 0),
                    change: parseFloat(statsData.priceChangePercent || 0)
                }
            }
        });
        
    } catch (error) {
        systemLogger.error('Binance ticker request failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message,
            pair: pair
        });
        
        throw new APIError(`Binance ticker request failed: ${error.message}`, 500, 'BINANCE_TICKER_ERROR');
    }
}));

// Binance Test Endpoint
router.post('/binance/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret } = req.body;
    
    try {
        systemLogger.trading('Binance connection test initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'test'
        });
        
        // Test connection by getting server time and account info
        const timestamp = Date.now();
        const recvWindow = 60000; // 60 second window for better reliability
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createBinanceSignature(queryString, apiSecret);
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const accountData = await response.json();
        
        systemLogger.trading('Binance connection test successful', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance'
        });
        
        res.json({
            success: true,
            message: 'Binance connection successful',
            data: {
                connected: true,
                balanceCount: accountData.balances ? accountData.balances.length : 0,
                accountType: accountData.accountType || 'SPOT'
            }
        });
        
    } catch (error) {
        systemLogger.error('Binance connection test failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message
        });
        
        throw new APIError(`Binance connection test failed: ${error.message}`, 500, 'BINANCE_CONNECTION_ERROR');
    }
}));

// Binance Buy Order Endpoint
router.post('/binance/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Binance buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'buy-order',
            pair,
            quantity,
            price
        });
        
        const auth = createBinanceAuth(apiKey, apiSecret);
        const timestamp = Date.now();
        
        const orderData = {
            symbol: pair,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Binance buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            orderId: orderResult.orderId,
            pair,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Binance buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message,
            pair,
            quantity
        });
        
        throw new APIError(`Binance buy order failed: ${error.message}`, 500, 'BINANCE_BUY_ORDER_ERROR');
    }
}));

// Binance Sell Order Endpoint
router.post('/binance/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Binance sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            endpoint: 'sell-order',
            pair,
            quantity,
            price
        });
        
        const auth = createBinanceAuth(apiKey, apiSecret);
        const timestamp = Date.now();
        
        const orderData = {
            symbol: pair,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINANCE_CONFIG.baseUrl}${BINANCE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Binance sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            orderId: orderResult.orderId,
            pair,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Binance sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'binance',
            error: error.message,
            pair,
            quantity
        });
        
        throw new APIError(`Binance sell order failed: ${error.message}`, 500, 'BINANCE_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// KRAKEN EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Kraken API Configuration
const KRAKEN_CONFIG = {
    baseUrl: 'https://api.kraken.com',
    endpoints: {
        balance: '/0/private/Balance',
        ticker: '/0/public/Ticker',
        test: '/0/private/Balance'
    }
};

// Kraken Authentication Helper
function createKrakenSignature(path, postdata, apiSecret, nonce) {
    const message = postdata;
    const secret_buffer = Buffer.from(apiSecret, 'base64');
    const hash = crypto.createHash('sha256');
    const hmac = crypto.createHmac('sha512', secret_buffer);
    const hash_digest = hash.update(nonce + message).digest('binary');
    const hmac_digest = hmac.update(path + hash_digest, 'binary').digest('base64');
    return hmac_digest;
}

// POST /api/v1/trading/kraken/balance - Get Kraken account balance
router.post('/kraken/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now().toString();
        const postdata = `nonce=${nonce}`;
        const path = KRAKEN_CONFIG.endpoints.balance;
        const signature = createKrakenSignature(path, postdata, apiSecret, nonce);

        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postdata
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Kraken balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Kraken API error: ${response.status}`, 502, 'KRAKEN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new APIError(`Kraken error: ${data.error.join(', ')}`, 400, 'KRAKEN_ERROR');
        }

        const balances = {};
        if (data.result) {
            for (const [currency, balance] of Object.entries(data.result)) {
                const amount = parseFloat(balance);
                if (amount > 0) {
                    balances[currency] = amount;
                }
            }
        }

        systemLogger.trading('Kraken balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'kraken',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('Kraken balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Kraken balance', 500, 'KRAKEN_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/kraken/ticker - Get Kraken ticker data
router.post('/kraken/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (e.g., BTCUSDT -> XBTUSDT for Kraken)
        let krakenPair = pair;
        if (pair === 'BTCUSDT') krakenPair = 'XBTUSDT';
        if (pair === 'ETHUSDT') krakenPair = 'ETHUSDT';
        
        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${KRAKEN_CONFIG.endpoints.ticker}?pair=${krakenPair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Kraken ticker API error', {
                userId: req.user?.id,
                pair: krakenPair,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Kraken API error: ${response.status}`, 502, 'KRAKEN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new APIError(`Kraken error: ${data.error.join(', ')}`, 400, 'KRAKEN_ERROR');
        }

        let ticker = null;
        if (data.result) {
            const pairData = Object.values(data.result)[0];
            if (pairData) {
                ticker = {
                    symbol: krakenPair,
                    lastPrice: parseFloat(pairData.c[0]),
                    bidPrice: parseFloat(pairData.b[0]),
                    askPrice: parseFloat(pairData.a[0]),
                    volume: parseFloat(pairData.v[1]),
                    high: parseFloat(pairData.h[1]),
                    low: parseFloat(pairData.l[1])
                };
            }
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('Kraken ticker retrieved', {
            userId: req.user?.id,
            pair: krakenPair,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'kraken',
                pair: krakenPair,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('Kraken ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Kraken ticker', 500, 'KRAKEN_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/kraken/test - Test Kraken API connection
router.post('/kraken/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now().toString();
        const postdata = `nonce=${nonce}`;
        const path = KRAKEN_CONFIG.endpoints.test;
        const signature = createKrakenSignature(path, postdata, apiSecret, nonce);

        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postdata
        });

        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            systemLogger.trading('Kraken API test failed', {
                userId: req.user?.id,
                error: data.error.join(', ')
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'kraken',
                    connected: false,
                    error: data.error.join(', ')
                }
            });
            return;
        }

        systemLogger.trading('Kraken API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'kraken',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('Kraken test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'kraken',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Kraken Buy Order Endpoint
router.post('/kraken/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume, price } = req.body;
    
    try {
        systemLogger.trading('Kraken buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            endpoint: 'buy-order',
            pair,
            volume,
            price
        });
        
        const auth = createKrakenAuth(apiKey, apiSecret);
        const nonce = Date.now() * 1000;
        
        const orderData = {
            nonce: nonce.toString(),
            ordertype: price ? 'limit' : 'market',
            type: 'buy',
            volume: volume.toString(),
            pair,
            ...(price && { price: price.toString() })
        };
        
        const postData = new URLSearchParams(orderData).toString();
        const path = KRAKEN_CONFIG.endpoints.order;
        const signature = crypto
            .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
            .update(path + crypto.createHash('sha256').update(nonce + postData).digest())
            .digest('base64');
        
        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postData
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new Error(data.error.join(', '));
        }
        
        systemLogger.trading('Kraken buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            txId: data.result?.txid?.[0],
            pair,
            volume,
            price
        });
        
        res.json({
            success: true,
            order: {
                txId: data.result?.txid?.[0],
                pair,
                type: 'buy',
                ordertype: price ? 'limit' : 'market',
                volume: parseFloat(volume),
                price: parseFloat(price || 0),
                status: 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Kraken buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            error: error.message,
            pair,
            volume
        });
        
        throw new APIError(`Kraken buy order failed: ${error.message}`, 500, 'KRAKEN_BUY_ORDER_ERROR');
    }
}));

// Kraken Sell Order Endpoint
router.post('/kraken/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('pair').notEmpty().withMessage('Trading pair is required'),
    body('volume').isFloat({ min: 0.01 }).withMessage('Volume must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, pair, volume, price } = req.body;
    
    try {
        systemLogger.trading('Kraken sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            endpoint: 'sell-order',
            pair,
            volume,
            price
        });
        
        const auth = createKrakenAuth(apiKey, apiSecret);
        const nonce = Date.now() * 1000;
        
        const orderData = {
            nonce: nonce.toString(),
            ordertype: price ? 'limit' : 'market',
            type: 'sell',
            volume: volume.toString(),
            pair,
            ...(price && { price: price.toString() })
        };
        
        const postData = new URLSearchParams(orderData).toString();
        const path = KRAKEN_CONFIG.endpoints.order;
        const signature = crypto
            .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
            .update(path + crypto.createHash('sha256').update(nonce + postData).digest())
            .digest('base64');
        
        const response = await fetch(`${KRAKEN_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'API-Key': apiKey,
                'API-Sign': signature,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postData
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (data.error && data.error.length > 0) {
            throw new Error(data.error.join(', '));
        }
        
        systemLogger.trading('Kraken sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            txId: data.result?.txid?.[0],
            pair,
            volume,
            price
        });
        
        res.json({
            success: true,
            order: {
                txId: data.result?.txid?.[0],
                pair,
                type: 'sell',
                ordertype: price ? 'limit' : 'market',
                volume: parseFloat(volume),
                price: parseFloat(price || 0),
                status: 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Kraken sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kraken',
            error: error.message,
            pair,
            volume
        });
        
        throw new APIError(`Kraken sell order failed: ${error.message}`, 500, 'KRAKEN_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BYBIT EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// ByBit API Configuration
const BYBIT_CONFIG = {
    baseUrl: 'https://api.bybit.com',
    endpoints: {
        balance: '/v5/account/wallet-balance',
        ticker: '/v5/market/tickers',
        test: '/v5/account/wallet-balance'
    }
};

// ByBit Authentication Helper
function createByBitSignature(timestamp, apiKey, apiSecret, recv_window, queryString) {
    const param_str = timestamp + apiKey + recv_window + queryString;
    return crypto.createHmac('sha256', apiSecret).update(param_str).digest('hex');
}

// POST /api/v1/trading/bybit/balance - Get ByBit account balance
router.post('/bybit/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const recv_window = '5000';
        const queryString = 'accountType=UNIFIED';
        const signature = createByBitSignature(timestamp, apiKey, apiSecret, recv_window, queryString);

        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.balance}?${queryString}`, {
            method: 'GET',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-SIGN-TYPE': '2',
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recv_window,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('ByBit balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`ByBit API error: ${response.status}`, 502, 'BYBIT_API_ERROR');
        }

        const data = await response.json();
        
        if (data.retCode !== 0) {
            throw new APIError(`ByBit error: ${data.retMsg}`, 400, 'BYBIT_ERROR');
        }

        const balances = {};
        if (data.result && data.result.list && data.result.list.length > 0) {
            const account = data.result.list[0];
            if (account.coin) {
                account.coin.forEach(coin => {
                    const balance = parseFloat(coin.walletBalance);
                    if (balance > 0) {
                        balances[coin.coin] = balance;
                    }
                });
            }
        }

        systemLogger.trading('ByBit balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'bybit',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('ByBit balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch ByBit balance', 500, 'BYBIT_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bybit/ticker - Get ByBit ticker data
router.post('/bybit/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.ticker}?category=spot&symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('ByBit ticker API error', {
                userId: req.user?.id,
                pair,
                status: response.status,
                error: errorText
            });
            throw new APIError(`ByBit API error: ${response.status}`, 502, 'BYBIT_API_ERROR');
        }

        const data = await response.json();
        
        if (data.retCode !== 0) {
            throw new APIError(`ByBit error: ${data.retMsg}`, 400, 'BYBIT_ERROR');
        }

        let ticker = null;
        if (data.result && data.result.list && data.result.list.length > 0) {
            const tickerData = data.result.list[0];
            ticker = {
                symbol: tickerData.symbol,
                lastPrice: parseFloat(tickerData.lastPrice),
                bidPrice: parseFloat(tickerData.bid1Price),
                askPrice: parseFloat(tickerData.ask1Price),
                volume: parseFloat(tickerData.volume24h),
                high: parseFloat(tickerData.highPrice24h),
                low: parseFloat(tickerData.lowPrice24h),
                change: parseFloat(tickerData.price24hPcnt)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('ByBit ticker retrieved', {
            userId: req.user?.id,
            pair,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'bybit',
                pair,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('ByBit ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch ByBit ticker', 500, 'BYBIT_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bybit/test - Test ByBit API connection
router.post('/bybit/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const recv_window = '5000';
        const queryString = 'accountType=UNIFIED';
        const signature = createByBitSignature(timestamp, apiKey, apiSecret, recv_window, queryString);

        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.test}?${queryString}`, {
            method: 'GET',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-SIGN-TYPE': '2',
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recv_window,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.retCode !== 0) {
            systemLogger.trading('ByBit API test failed', {
                userId: req.user?.id,
                error: data.retMsg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'bybit',
                    connected: false,
                    error: data.retMsg
                }
            });
            return;
        }

        systemLogger.trading('ByBit API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'bybit',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('ByBit test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'bybit',
                connected: false,
                error: error.message
            }
        });
    }
}));

// ByBit Buy Order Endpoint
router.post('/bybit/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('qty').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, qty, price } = req.body;
    
    try {
        systemLogger.trading('ByBit buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            endpoint: 'buy-order',
            symbol,
            qty,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            category: 'spot',
            symbol,
            side: 'Buy',
            orderType: price ? 'Limit' : 'Market',
            qty: qty.toString(),
            ...(price && { price: price.toString() })
        };
        
        const queryString = Object.keys(orderData)
            .sort()
            .map(key => `${key}=${orderData[key]}`)
            .join('&');
            
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + apiKey + queryString)
            .digest('hex');
        
        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp.toString(),
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.retCode !== 0) {
            throw new Error(orderResult.retMsg);
        }
        
        systemLogger.trading('ByBit buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            orderId: orderResult.result?.orderId,
            symbol,
            qty,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol,
                side: 'Buy',
                orderType: price ? 'Limit' : 'Market',
                qty: parseFloat(qty),
                price: parseFloat(price || 0),
                status: orderResult.result?.orderStatus || 'New',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ByBit buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            error: error.message,
            symbol,
            qty
        });
        
        throw new APIError(`ByBit buy order failed: ${error.message}`, 500, 'BYBIT_BUY_ORDER_ERROR');
    }
}));

// ByBit Sell Order Endpoint
router.post('/bybit/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('qty').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, qty, price } = req.body;
    
    try {
        systemLogger.trading('ByBit sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            endpoint: 'sell-order',
            symbol,
            qty,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            category: 'spot',
            symbol,
            side: 'Sell',
            orderType: price ? 'Limit' : 'Market',
            qty: qty.toString(),
            ...(price && { price: price.toString() })
        };
        
        const queryString = Object.keys(orderData)
            .sort()
            .map(key => `${key}=${orderData[key]}`)
            .join('&');
            
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + apiKey + queryString)
            .digest('hex');
        
        const response = await fetch(`${BYBIT_CONFIG.baseUrl}${BYBIT_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp.toString(),
                'X-BAPI-RECV-WINDOW': '5000',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.retCode !== 0) {
            throw new Error(orderResult.retMsg);
        }
        
        systemLogger.trading('ByBit sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            orderId: orderResult.result?.orderId,
            symbol,
            qty,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol,
                side: 'Sell',
                orderType: price ? 'Limit' : 'Market',
                qty: parseFloat(qty),
                price: parseFloat(price || 0),
                status: orderResult.result?.orderStatus || 'New',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('ByBit sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bybit',
            error: error.message,
            symbol,
            qty
        });
        
        throw new APIError(`ByBit sell order failed: ${error.message}`, 500, 'BYBIT_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// GATE.IO EXCHANGE API PROXY ENDPOINTS  
// ============================================================================

// Gate.io API Configuration
const GATEIO_CONFIG = {
    baseUrl: 'https://api.gateio.ws',
    endpoints: {
        balance: '/api/v4/spot/accounts',
        ticker: '/api/v4/spot/tickers',
        test: '/api/v4/spot/accounts'
    }
};

// Gate.io Authentication Helper
function createGateioSignature(method, url, queryString, body, timestamp, apiSecret) {
    const hashedPayload = crypto.createHash('sha512').update(body || '').digest('hex');
    const signingString = `${method}\n${url}\n${queryString}\n${hashedPayload}\n${timestamp}`;
    return crypto.createHmac('sha512', apiSecret).update(signingString).digest('hex');
}

// POST /api/v1/trading/gateio/balance - Get Gate.io account balance
router.post('/gateio/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const method = 'GET';
        const url = GATEIO_CONFIG.endpoints.balance;
        const queryString = '';
        const signature = createGateioSignature(method, url, queryString, '', timestamp, apiSecret);

        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${url}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'KEY': apiKey,
                'Timestamp': timestamp,
                'SIGN': signature
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Gate.io balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Gate.io API error: ${response.status}`, 502, 'GATEIO_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (Array.isArray(data)) {
            data.forEach(account => {
                const available = parseFloat(account.available);
                if (available > 0) {
                    balances[account.currency] = available;
                }
            });
        }

        systemLogger.trading('Gate.io balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'gateio',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('Gate.io balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gate.io balance', 500, 'GATEIO_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/gateio/ticker - Get Gate.io ticker data
router.post('/gateio/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC_USDT for Gate.io)
        const gateioSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${GATEIO_CONFIG.endpoints.ticker}?currency_pair=${gateioSymbol}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Gate.io ticker API error', {
                userId: req.user?.id,
                pair: gateioSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`Gate.io API error: ${response.status}`, 502, 'GATEIO_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (Array.isArray(data) && data.length > 0) {
            const tickerData = data[0];
            ticker = {
                symbol: tickerData.currency_pair,
                lastPrice: parseFloat(tickerData.last),
                bidPrice: parseFloat(tickerData.highest_bid),
                askPrice: parseFloat(tickerData.lowest_ask),
                volume: parseFloat(tickerData.base_volume),
                high: parseFloat(tickerData.high_24h),
                low: parseFloat(tickerData.low_24h),
                change: parseFloat(tickerData.change_percentage)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('Gate.io ticker retrieved', {
            userId: req.user?.id,
            pair: gateioSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'gateio',
                pair: gateioSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('Gate.io ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gate.io ticker', 500, 'GATEIO_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/gateio/test - Test Gate.io API connection
router.post('/gateio/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const method = 'GET';
        const url = GATEIO_CONFIG.endpoints.test;
        const queryString = '';
        const signature = createGateioSignature(method, url, queryString, '', timestamp, apiSecret);

        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${url}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'KEY': apiKey,
                'Timestamp': timestamp,
                'SIGN': signature
            }
        });

        const data = await response.json();
        
        if (!response.ok || (data.message && data.message !== 'Success')) {
            systemLogger.trading('Gate.io API test failed', {
                userId: req.user?.id,
                error: data.message || `HTTP ${response.status}`
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'gateio',
                    connected: false,
                    error: data.message || `HTTP ${response.status}`
                }
            });
            return;
        }

        systemLogger.trading('Gate.io API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'gateio',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('Gate.io test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'gateio',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Gate.io Buy Order Endpoint
router.post('/gateio/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('currencyPair').notEmpty().withMessage('Currency pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, currencyPair, amount, price } = req.body;
    
    try {
        systemLogger.trading('Gate.io buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            endpoint: 'buy-order',
            currencyPair,
            amount,
            price
        });
        
        // Format pair for Gate.io (ensure underscore format like BTC_USDT)
        const gateioSymbol = currencyPair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const timestamp = Math.floor(Date.now() / 1000);
        const orderData = {
            currency_pair: gateioSymbol,
            type: price ? 'limit' : 'market',
            account: 'spot',
            side: 'buy',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const payloadHash = crypto.createHash('sha512').update(body).digest('hex');
        const signString = `POST\n/api/v4/spot/orders\n\n${payloadHash}\n${timestamp}`;
        const signature = crypto.createHmac('sha512', apiSecret).update(signString).digest('hex');
        
        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${GATEIO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'KEY': apiKey,
                'SIGN': signature,
                'Timestamp': timestamp.toString(),
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Gate.io buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            orderId: orderResult.id,
            currencyPair: gateioSymbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                currencyPair: gateioSymbol,
                type: price ? 'limit' : 'market',
                side: 'buy',
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: new Date(orderResult.create_time * 1000)
            }
        });
        
    } catch (error) {
        systemLogger.trading('Gate.io buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            error: error.message,
            currencyPair,
            amount
        });
        
        throw new APIError(`Gate.io buy order failed: ${error.message}`, 500, 'GATEIO_BUY_ORDER_ERROR');
    }
}));

// Gate.io Sell Order Endpoint
router.post('/gateio/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('currencyPair').notEmpty().withMessage('Currency pair is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, currencyPair, amount, price } = req.body;
    
    try {
        systemLogger.trading('Gate.io sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            endpoint: 'sell-order',
            currencyPair,
            amount,
            price
        });
        
        // Format pair for Gate.io (ensure underscore format like BTC_USDT)
        const gateioSymbol = currencyPair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const timestamp = Math.floor(Date.now() / 1000);
        const orderData = {
            currency_pair: gateioSymbol,
            type: price ? 'limit' : 'market',
            account: 'spot',
            side: 'sell',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const payloadHash = crypto.createHash('sha512').update(body).digest('hex');
        const signString = `POST\n/api/v4/spot/orders\n\n${payloadHash}\n${timestamp}`;
        const signature = crypto.createHmac('sha512', apiSecret).update(signString).digest('hex');
        
        const response = await fetch(`${GATEIO_CONFIG.baseUrl}${GATEIO_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'KEY': apiKey,
                'SIGN': signature,
                'Timestamp': timestamp.toString(),
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Gate.io sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            orderId: orderResult.id,
            currencyPair: gateioSymbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.id,
                currencyPair: gateioSymbol,
                type: price ? 'limit' : 'market',
                side: 'sell',
                amount: parseFloat(orderResult.amount || amount),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: new Date(orderResult.create_time * 1000)
            }
        });
        
    } catch (error) {
        systemLogger.trading('Gate.io sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'gateio',
            error: error.message,
            currencyPair,
            amount
        });
        
        throw new APIError(`Gate.io sell order failed: ${error.message}`, 500, 'GATEIO_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// OKX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// OKX API Configuration
const OKX_CONFIG = {
    baseUrl: 'https://www.okx.com',
    endpoints: {
        balance: '/api/v5/account/balance',
        ticker: '/api/v5/market/ticker',
        test: '/api/v5/account/balance'
    }
};

// OKX Authentication Helper
function createOKXSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = timestamp + method + requestPath + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// POST /api/v1/trading/okx/balance - Get OKX account balance
router.post('/okx/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = new Date().toISOString();
        const method = 'GET';
        const requestPath = OKX_CONFIG.endpoints.balance;
        const signature = createOKXSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('OKX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`OKX API error: ${response.status}`, 502, 'OKX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '0') {
            throw new APIError(`OKX error: ${data.msg}`, 400, 'OKX_ERROR');
        }

        const balances = {};
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            const account = data.data[0];
            if (account.details && Array.isArray(account.details)) {
                account.details.forEach(detail => {
                    const available = parseFloat(detail.availBal);
                    if (available > 0) {
                        balances[detail.ccy] = available;
                    }
                });
            }
        }

        systemLogger.trading('OKX balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'okx',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('OKX balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch OKX balance', 500, 'OKX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/okx/ticker - Get OKX ticker data
router.post('/okx/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format for OKX (BTCUSDT -> BTC-USDT)
        let okxSymbol;
        if (pair.includes('USDT')) {
            // Handle USDT pairs: BTCUSDT -> BTC-USDT
            okxSymbol = pair.replace('USDT', '-USDT');
        } else if (pair.includes('USDC')) {
            // Handle USDC pairs: BTCUSDC -> BTC-USDC
            okxSymbol = pair.replace('USDC', '-USDC');
        } else if (pair.includes('BTC') && !pair.startsWith('BTC')) {
            // Handle pairs with BTC as quote: ETHBTC -> ETH-BTC
            okxSymbol = pair.replace('BTC', '-BTC');
        } else if (pair.includes('ETH') && !pair.startsWith('ETH')) {
            // Handle pairs with ETH as quote: XRPETH -> XRP-ETH
            okxSymbol = pair.replace('ETH', '-ETH');
        } else {
            // Fallback - try to add hyphen before last 3-4 characters
            okxSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1-$2');
        }
        
        const response = await fetch(`${OKX_CONFIG.baseUrl}${OKX_CONFIG.endpoints.ticker}?instId=${okxSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('OKX ticker API error', {
                userId: req.user?.id,
                pair: okxSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`OKX API error: ${response.status}`, 502, 'OKX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '0') {
            throw new APIError(`OKX error: ${data.msg}`, 400, 'OKX_ERROR');
        }

        let ticker = null;
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            const tickerData = data.data[0];
            ticker = {
                symbol: tickerData.instId,
                lastPrice: parseFloat(tickerData.last),
                bidPrice: parseFloat(tickerData.bidPx),
                askPrice: parseFloat(tickerData.askPx),
                volume: parseFloat(tickerData.vol24h),
                high: parseFloat(tickerData.high24h),
                low: parseFloat(tickerData.low24h),
                change: parseFloat(tickerData.chgUtc8)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('OKX ticker retrieved', {
            userId: req.user?.id,
            pair: okxSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'okx',
                pair: okxSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('OKX ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch OKX ticker', 500, 'OKX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/okx/test - Test OKX API connection
router.post('/okx/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = new Date().toISOString();
        const method = 'GET';
        const requestPath = OKX_CONFIG.endpoints.test;
        const signature = createOKXSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== '0') {
            systemLogger.trading('OKX API test failed', {
                userId: req.user?.id,
                error: data.msg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'okx',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        systemLogger.trading('OKX API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'okx',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('OKX test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'okx',
                connected: false,
                error: error.message
            }
        });
    }
}));

// OKX Buy Order Endpoint
router.post('/okx/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('instId').notEmpty().withMessage('Instrument ID is required'),
    body('sz').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('px').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, instId, sz, px } = req.body;
    
    try {
        systemLogger.trading('OKX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            endpoint: 'buy-order',
            instId,
            sz,
            px
        });
        
        const timestamp = new Date().toISOString();
        const orderData = {
            instId,
            tdMode: 'cash',
            side: 'buy',
            ordType: px ? 'limit' : 'market',
            sz: sz.toString(),
            ...(px && { px: px.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const method = 'POST';
        const requestPath = '/api/v5/trade/order';
        const signature = createOKXSignature(timestamp, method, requestPath, body, apiSecret);
        
        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('OKX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            ordId: orderResult.data?.[0]?.ordId,
            instId,
            sz,
            px
        });
        
        res.json({
            success: true,
            order: {
                ordId: orderResult.data?.[0]?.ordId,
                instId,
                tdMode: 'cash',
                side: 'buy',
                ordType: px ? 'limit' : 'market',
                sz: parseFloat(sz),
                px: parseFloat(px || 0),
                state: orderResult.data?.[0]?.sCode || 'live',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('OKX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            error: error.message,
            instId,
            sz
        });
        
        throw new APIError(`OKX buy order failed: ${error.message}`, 500, 'OKX_BUY_ORDER_ERROR');
    }
}));

// OKX Sell Order Endpoint
router.post('/okx/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('instId').notEmpty().withMessage('Instrument ID is required'),
    body('sz').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('px').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, instId, sz, px } = req.body;
    
    try {
        systemLogger.trading('OKX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            endpoint: 'sell-order',
            instId,
            sz,
            px
        });
        
        const timestamp = new Date().toISOString();
        const orderData = {
            instId,
            tdMode: 'cash',
            side: 'sell',
            ordType: px ? 'limit' : 'market',
            sz: sz.toString(),
            ...(px && { px: px.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const method = 'POST';
        const requestPath = '/api/v5/trade/order';
        const signature = createOKXSignature(timestamp, method, requestPath, body, apiSecret);
        
        const response = await fetch(`${OKX_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('OKX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            ordId: orderResult.data?.[0]?.ordId,
            instId,
            sz,
            px
        });
        
        res.json({
            success: true,
            order: {
                ordId: orderResult.data?.[0]?.ordId,
                instId,
                tdMode: 'cash',
                side: 'sell',
                ordType: px ? 'limit' : 'market',
                sz: parseFloat(sz),
                px: parseFloat(px || 0),
                state: orderResult.data?.[0]?.sCode || 'live',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('OKX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'okx',
            error: error.message,
            instId,
            sz
        });
        
        throw new APIError(`OKX sell order failed: ${error.message}`, 500, 'OKX_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// MEXC EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// MEXC API Configuration
const MEXC_CONFIG = {
    baseUrl: 'https://api.mexc.com',
    endpoints: {
        balance: '/api/v3/account',
        ticker: '/api/v3/ticker/24hr',
        test: '/api/v3/account',
        order: '/api/v3/order'
    }
};

// MEXC Authentication Helper
function createMEXCSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/mexc/balance - Get MEXC account balance
router.post('/mexc/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const recvWindow = 5000; // 5 second window for timing security
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createMEXCSignature(queryString, apiSecret);

        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('MEXC balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`MEXC API error: ${response.status}`, 502, 'MEXC_API_ERROR');
        }

        const data = await response.json();
        
        // Log the raw MEXC response for debugging
        systemLogger.trading('MEXC raw response', {
            userId: req.user?.id,
            hasBalances: !!data.balances,
            balanceCount: data.balances ? data.balances.length : 0,
            sampleBalance: data.balances && data.balances.length > 0 ? data.balances[0] : null
        });
        
        // MEXC uses code field for errors (code 0 or undefined means success)
        if (data.code && data.code !== 0 && data.code !== '0') {
            systemLogger.trading('MEXC API returned error code', {
                userId: req.user?.id,
                code: data.code,
                msg: data.msg
            });
            
            // Return detailed error to frontend for debugging
            res.json({
                success: false,
                data: {
                    exchange: 'mexc',
                    error: data.msg || 'Unknown MEXC error',
                    code: data.code
                }
            });
            return;
        }

        const balances = {};
        // MEXC returns balances array directly in the response
        if (data.balances && Array.isArray(data.balances)) {
            data.balances.forEach(balance => {
                const free = parseFloat(balance.free);
                // Include all balances, even 0, for debugging
                balances[balance.asset] = free;
            });
        } else if (Array.isArray(data)) {
            // Sometimes MEXC returns the array directly
            data.forEach(balance => {
                const free = parseFloat(balance.free);
                balances[balance.asset] = free;
            });
        }

        systemLogger.trading('MEXC balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'mexc',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('MEXC balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        // Return error details to frontend
        res.json({
            success: false,
            data: {
                exchange: 'mexc',
                error: error.message || 'Failed to fetch MEXC balance'
            }
        });
    }
}));

// POST /api/v1/trading/mexc/ticker - Get MEXC ticker data
router.post('/mexc/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('MEXC ticker API error', {
                userId: req.user?.id,
                pair,
                status: response.status,
                error: errorText
            });
            throw new APIError(`MEXC API error: ${response.status}`, 502, 'MEXC_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code && data.code !== 200) {
            throw new APIError(`MEXC error: ${data.msg}`, 400, 'MEXC_ERROR');
        }

        let ticker = null;
        if (data.symbol) {
            ticker = {
                symbol: data.symbol,
                lastPrice: parseFloat(data.lastPrice),
                bidPrice: parseFloat(data.bidPrice),
                askPrice: parseFloat(data.askPrice),
                volume: parseFloat(data.volume),
                high: parseFloat(data.highPrice),
                low: parseFloat(data.lowPrice),
                change: parseFloat(data.priceChangePercent)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('MEXC ticker retrieved', {
            userId: req.user?.id,
            pair,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'mexc',
                pair,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('MEXC ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch MEXC ticker', 500, 'MEXC_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/mexc/test - Test MEXC API connection
router.post('/mexc/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const recvWindow = 5000; // 5 second window for timing security
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createMEXCSignature(queryString, apiSecret);

        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.test}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code && data.code !== 200) {
            systemLogger.trading('MEXC API test failed', {
                userId: req.user?.id,
                error: data.msg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'mexc',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        systemLogger.trading('MEXC API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'mexc',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('MEXC test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'mexc',
                connected: false,
                error: error.message
            }
        });
    }
}));

// MEXC Buy Order Endpoint
router.post('/mexc/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('MEXC buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('MEXC buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('MEXC buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`MEXC buy order failed: ${error.message}`, 500, 'MEXC_BUY_ORDER_ERROR');
    }
}));

// MEXC Sell Order Endpoint
router.post('/mexc/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('MEXC sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${MEXC_CONFIG.baseUrl}${MEXC_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MEXC-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('MEXC sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('MEXC sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'mexc',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`MEXC sell order failed: ${error.message}`, 500, 'MEXC_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// KUCOIN EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// KuCoin API Configuration
const KUCOIN_CONFIG = {
    baseUrl: 'https://api.kucoin.com',
    endpoints: {
        balance: '/api/v1/accounts',
        ticker: '/api/v1/market/orderbook/level1',
        test: '/api/v1/accounts'
    }
};

// KuCoin Authentication Helper
function createKuCoinSignature(timestamp, method, endpoint, body, apiSecret) {
    const strForSign = timestamp + method + endpoint + (body || '');
    const signatureResult = crypto.createHmac('sha256', apiSecret).update(strForSign).digest('base64');
    return signatureResult;
}

// POST /api/v1/trading/kucoin/balance - Get KuCoin account balance
router.post('/kucoin/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now();
        const method = 'GET';
        const endpoint = KUCOIN_CONFIG.endpoints.balance;
        const signature = createKuCoinSignature(timestamp, method, endpoint, '', apiSecret);
        const passphraseHash = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');

        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': passphraseHash,
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('KuCoin balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`KuCoin API error: ${response.status}`, 502, 'KUCOIN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '200000') {
            throw new APIError(`KuCoin error: ${data.msg}`, 400, 'KUCOIN_ERROR');
        }

        const balances = {};
        if (data.data && Array.isArray(data.data)) {
            data.data.forEach(account => {
                const available = parseFloat(account.available);
                if (available > 0) {
                    balances[account.currency] = available;
                }
            });
        }

        systemLogger.trading('KuCoin balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'kucoin',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('KuCoin balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch KuCoin balance', 500, 'KUCOIN_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/kucoin/ticker - Get KuCoin ticker data
router.post('/kucoin/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC-USDT for KuCoin)
        const kucoinSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1-$2');
        
        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${KUCOIN_CONFIG.endpoints.ticker}?symbol=${kucoinSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('KuCoin ticker API error', {
                userId: req.user?.id,
                pair: kucoinSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`KuCoin API error: ${response.status}`, 502, 'KUCOIN_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '200000') {
            throw new APIError(`KuCoin error: ${data.msg}`, 400, 'KUCOIN_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: kucoinSymbol,
                lastPrice: parseFloat(data.data.price),
                bidPrice: parseFloat(data.data.bestBid),
                askPrice: parseFloat(data.data.bestAsk),
                volume: parseFloat(data.data.size),
                high: parseFloat(data.data.price), // KuCoin level1 doesn't provide 24h high/low
                low: parseFloat(data.data.price),
                change: 0
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('KuCoin ticker retrieved', {
            userId: req.user?.id,
            pair: kucoinSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'kucoin',
                pair: kucoinSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('KuCoin ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch KuCoin ticker', 500, 'KUCOIN_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/kucoin/test - Test KuCoin API connection
router.post('/kucoin/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now();
        const method = 'GET';
        const endpoint = KUCOIN_CONFIG.endpoints.test;
        const signature = createKuCoinSignature(timestamp, method, endpoint, '', apiSecret);
        const passphraseHash = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');

        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': passphraseHash,
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== '200000') {
            systemLogger.trading('KuCoin API test failed', {
                userId: req.user?.id,
                error: data.msg
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'kucoin',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        systemLogger.trading('KuCoin API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'kucoin',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('KuCoin test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'kucoin',
                connected: false,
                error: error.message
            }
        });
    }
}));

// ============================================================================
// XT.COM EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// XT.com API Configuration
const XT_CONFIG = {
    baseUrl: 'https://sapi.xt.com',  // Back to v4 base URL
    endpoints: {
        balance: '/v4/balances',  // v4 endpoint with v1 auth
        ticker: '/v4/public/ticker',
        test: '/v4/balances'
    }
};

// XT.com Authentication Helper - Copy MEXC pattern exactly
function createXTSignature(queryString, apiSecret) {
    // Use exact same format as working MEXC implementation
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/xt/balance - Get XT.com account balance
router.post('/xt/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        // Copy MEXC implementation exactly
        const timestamp = Date.now();
        const recvWindow = 5000;
        const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
        const signature = createXTSignature(queryString, apiSecret);

        const response = await fetch(`${XT_CONFIG.baseUrl}${XT_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'XT-APIKEY': apiKey, // Try XT's version of X-MEXC-APIKEY
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('XT.com balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`XT.com API error: ${response.status}`, 502, 'XT_API_ERROR');
        }

        const data = await response.json();
        
        // Log the actual response for debugging
        systemLogger.trading('XT.com balance response', {
            userId: req.user?.id,
            responseData: JSON.stringify(data)
        });
        
        if (data.rc && data.rc !== '0' && data.rc !== 'OK' && data.code !== 200) {
            throw new APIError(`XT.com error: ${data.rc} - ${data.msg || data.message || JSON.stringify(data)}`, 400, 'XT_ERROR');
        }

        const balances = {};
        if (data.result && Array.isArray(data.result)) {
            data.result.forEach(balance => {
                const available = parseFloat(balance.availableAmount || balance.available);
                if (available > 0) {
                    balances[balance.currency || balance.coin] = available;
                }
            });
        }

        systemLogger.trading('XT.com balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'xt',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('XT.com balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch XT.com balance', 500, 'XT_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/xt/ticker - Get XT.com ticker data
router.post('/xt/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> btc_usdt for XT.com)
        const xtSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2').toLowerCase();
        
        const response = await fetch(`${XT_CONFIG.baseUrl}${XT_CONFIG.endpoints.ticker}?symbol=${xtSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('XT.com ticker API error', {
                userId: req.user?.id,
                pair: xtSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`XT.com API error: ${response.status}`, 502, 'XT_API_ERROR');
        }

        const data = await response.json();
        
        if (data.rc !== 0 && data.code !== 200) {
            throw new APIError(`XT.com error: ${data.msg || data.message}`, 400, 'XT_ERROR');
        }

        let ticker = null;
        if (data.result) {
            const tickerData = Array.isArray(data.result) ? data.result[0] : data.result;
            ticker = {
                symbol: xtSymbol,
                lastPrice: parseFloat(tickerData.c || tickerData.last),
                bidPrice: parseFloat(tickerData.b || tickerData.bid),
                askPrice: parseFloat(tickerData.a || tickerData.ask),
                volume: parseFloat(tickerData.v || tickerData.volume),
                high: parseFloat(tickerData.h || tickerData.high),
                low: parseFloat(tickerData.l || tickerData.low),
                change: parseFloat(tickerData.cr || tickerData.changeRate || 0)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('XT.com ticker retrieved', {
            userId: req.user?.id,
            pair: xtSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'xt',
                pair: xtSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('XT.com ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch XT.com ticker', 500, 'XT_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/xt/test - Test XT.com API connection
router.post('/xt/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const endpoint = XT_CONFIG.endpoints.test;
        const signature = createXTSignature(timestamp, method, endpoint, null, apiKey, apiSecret);

        const response = await fetch(`${XT_CONFIG.baseUrl}${endpoint}`, {
            method: 'GET',
            headers: {
                'validate-algorithms': 'HmacSHA256',
                'validate-appkey': apiKey,
                'validate-timestamp': timestamp,
                'validate-signature': signature,
                'validate-recvwindow': '60000',
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.rc && data.rc !== '0' && data.rc !== 'OK' && data.code !== 200) {
            systemLogger.trading('XT.com API test failed', {
                userId: req.user?.id,
                error: data.msg || data.message
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'xt',
                    connected: false,
                    error: data.msg || data.message
                }
            });
            return;
        }

        systemLogger.trading('XT.com API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'xt',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('XT.com test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'xt',
                connected: false,
                error: error.message
            }
        });
    }
}));

// XT.com Buy Order Endpoint
router.post('/xt/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('XT.com buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const method = 'POST';
        const endpoint = '/v4/order';
        
        const orderData = {
            symbol: symbol.toLowerCase().replace(/([a-z]+)([a-z]{3,4})$/, '$1_$2'), // Convert btcusdt -> btc_usdt
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const signature = createXTSignature(timestamp, method, endpoint, orderData, apiKey, apiSecret);
        
        const response = await fetch(`${XT_CONFIG.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'xt-validate-algorithms': 'HmacSHA256',
                'xt-validate-appkey': apiKey,
                'xt-validate-recvwindow': '5000',
                'xt-validate-timestamp': timestamp.toString(),
                'xt-validate-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.rc !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('XT.com buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            orderId: orderResult.result?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol: orderData.symbol,
                side: 'buy',
                type: price ? 'limit' : 'market',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XT.com buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            symbol,
            quantity,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// XT.com Sell Order Endpoint
router.post('/xt/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('XT.com sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const method = 'POST';
        const endpoint = '/v4/order';
        
        const orderData = {
            symbol: symbol.toLowerCase().replace(/([a-z]+)([a-z]{3,4})$/, '$1_$2'), // Convert btcusdt -> btc_usdt
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const signature = createXTSignature(timestamp, method, endpoint, orderData, apiKey, apiSecret);
        
        const response = await fetch(`${XT_CONFIG.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'xt-validate-algorithms': 'HmacSHA256',
                'xt-validate-appkey': apiKey,
                'xt-validate-recvwindow': '5000',
                'xt-validate-timestamp': timestamp.toString(),
                'xt-validate-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.rc !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('XT.com sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            orderId: orderResult.result?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.orderId,
                symbol: orderData.symbol,
                side: 'sell',
                type: price ? 'limit' : 'market',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('XT.com sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'xt',
            symbol,
            quantity,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// ============================================================================
// ASCENDEX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// AscendEX API Configuration
const ASCENDEX_CONFIG = {
    baseUrl: 'https://ascendex.com',
    endpoints: {
        balance: '/api/pro/data/v1/cash/balance/snapshot',  // Updated to current API format
        ticker: '/api/pro/v1/ticker',
        test: '/api/pro/v1/info'
    }
};

// AscendEX Authentication Helper  
function createAscendEXSignature(timestamp, path, apiSecret) {
    // AscendEX format: timestamp + method + requestPath + body
    // For GET requests with no body: timestamp + 'GET' + full_path + ''
    const method = 'GET';
    const body = '';
    const prehashString = timestamp + method + path + body;
    return crypto.createHmac('sha256', apiSecret).update(prehashString).digest('base64');
}

// POST /api/v1/trading/ascendex/balance - Get AscendEX account balance
router.post('/ascendex/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const path = ASCENDEX_CONFIG.endpoints.balance;
        const method = 'GET';
        const body = '';
        const prehashString = timestamp + method + path + body;
        const signature = createAscendEXSignature(timestamp, path, apiSecret);

        // Add comprehensive debugging
        systemLogger.trading('AscendEX signature debug', {
            userId: req.user?.id,
            timestamp: timestamp,
            path: path,
            method: method,
            body: body,
            prehashString: prehashString,
            signature: signature.substring(0, 16) + '...',
            apiKeyPrefix: apiKey.substring(0, 8) + '...',
            fullUrl: `${ASCENDEX_CONFIG.baseUrl}${path}`
        });

        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'GET',
            headers: {
                'x-bitmax-apikey': apiKey,
                'x-bitmax-timestamp': timestamp,
                'x-bitmax-signature': signature,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = errorText;
            }
            
            systemLogger.trading('AscendEX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorData,
                requestDetails: {
                    url: `${ASCENDEX_CONFIG.baseUrl}${path}`,
                    headers: {
                        'x-bitmax-apikey': apiKey.substring(0, 8) + '...',
                        'x-bitmax-timestamp': timestamp,
                        'x-bitmax-signature': signature.substring(0, 16) + '...'
                    }
                }
            });
            
            // Return debug info to frontend like HTX
            const errorMessage = errorData?.message || errorData?.msg || `AscendEX API error: ${response.status}`;
            res.json({
                success: false,
                error: {
                    code: 'ASCENDEX_AUTH_ERROR',
                    message: `AscendEX error: ${errorMessage}`,
                    debug: {
                        timestamp: timestamp,
                        path: path,
                        prehashString: prehashString,
                        signature: signature.substring(0, 16) + '...',
                        errorData: errorData
                    }
                }
            });
            return;
        }

        const data = await response.json();
        
        // Log successful response to see AscendEX structure
        systemLogger.trading('AscendEX balance response', {
            userId: req.user?.id,
            code: data.code,
            message: data.message,
            hasData: !!data.data,
            fullResponse: JSON.stringify(data)
        });
        
        if (data.code !== 0) {
            // Return debug info to frontend for AscendEX errors too
            res.json({
                success: false,
                error: {
                    code: 'ASCENDEX_API_ERROR',
                    message: `AscendEX error: ${data.message || 'Unknown error'}`,
                    debug: {
                        responseCode: data.code,
                        responseMessage: data.message,
                        fullResponse: data,
                        timestamp: timestamp,
                        path: path,
                        prehashString: prehashString
                    }
                }
            });
            return;
        }

        const balances = {};
        if (data.data && Array.isArray(data.data)) {
            data.data.forEach(balance => {
                const available = parseFloat(balance.availableBalance);
                if (available > 0) {
                    balances[balance.asset] = available;
                }
            });
        }

        systemLogger.trading('AscendEX balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'ascendex',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('AscendEX balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch AscendEX balance', 500, 'ASCENDEX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/ascendex/ticker - Get AscendEX ticker data
router.post('/ascendex/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC/USDT for AscendEX)
        const ascendexSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1/$2');
        
        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${ASCENDEX_CONFIG.endpoints.ticker}?symbol=${ascendexSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('AscendEX ticker API error', {
                userId: req.user?.id,
                pair: ascendexSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`AscendEX API error: ${response.status}`, 502, 'ASCENDEX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 0) {
            throw new APIError(`AscendEX error: ${data.message}`, 400, 'ASCENDEX_ERROR');
        }

        let ticker = null;
        if (data.data) {
            const tickerData = Array.isArray(data.data) ? data.data[0] : data.data;
            ticker = {
                symbol: ascendexSymbol,
                lastPrice: parseFloat(tickerData.close),
                bidPrice: parseFloat(tickerData.bid?.[0] || tickerData.close),
                askPrice: parseFloat(tickerData.ask?.[0] || tickerData.close),
                volume: parseFloat(tickerData.volume),
                high: parseFloat(tickerData.high),
                low: parseFloat(tickerData.low),
                change: parseFloat(tickerData.changeRate || 0)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('AscendEX ticker retrieved', {
            userId: req.user?.id,
            pair: ascendexSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'ascendex',
                pair: ascendexSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('AscendEX ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch AscendEX ticker', 500, 'ASCENDEX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/ascendex/test - Test AscendEX API connection
router.post('/ascendex/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const path = ASCENDEX_CONFIG.endpoints.test;
        const signature = createAscendEXSignature(timestamp, path, apiSecret);

        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'GET',
            headers: {
                'x-bitmax-apikey': apiKey,
                'x-bitmax-timestamp': timestamp,
                'x-bitmax-signature': signature,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== 0) {
            systemLogger.trading('AscendEX API test failed', {
                userId: req.user?.id,
                error: data.message
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'ascendex',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        systemLogger.trading('AscendEX API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'ascendex',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('AscendEX test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'ascendex',
                connected: false,
                error: error.message
            }
        });
    }
}));

// AscendEX Buy Order Endpoint
router.post('/ascendex/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('orderQty').isFloat({ min: 0.01 }).withMessage('Order quantity must be a positive number'),
    body('orderPrice').optional().isFloat({ min: 0.01 }).withMessage('Order price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, orderQty, orderPrice } = req.body;
    
    try {
        systemLogger.trading('AscendEX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            endpoint: 'buy-order',
            symbol,
            orderQty,
            orderPrice
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol: symbol.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1/$2'), // Convert BTCUSDT -> BTC/USDT
            orderQty: orderQty.toString(),
            side: 'Buy',
            orderType: orderPrice ? 'Limit' : 'Market',
            ...(orderPrice && { orderPrice: orderPrice.toString() })
        };
        
        const path = '/api/pro/v1/order';
        const signature = createAscendEXSignature(timestamp, path, apiSecret);
        
        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': timestamp.toString(),
                'x-auth-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('AscendEX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            orderId: orderResult.data?.orderId,
            symbol,
            orderQty,
            orderPrice
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderData.symbol,
                side: 'buy',
                type: orderPrice ? 'limit' : 'market',
                quantity: parseFloat(orderQty),
                price: parseFloat(orderPrice || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('AscendEX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            symbol,
            orderQty,
            orderPrice,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// AscendEX Sell Order Endpoint
router.post('/ascendex/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('orderQty').isFloat({ min: 0.01 }).withMessage('Order quantity must be a positive number'),
    body('orderPrice').optional().isFloat({ min: 0.01 }).withMessage('Order price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, orderQty, orderPrice } = req.body;
    
    try {
        systemLogger.trading('AscendEX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            endpoint: 'sell-order',
            symbol,
            orderQty,
            orderPrice
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol: symbol.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1/$2'), // Convert BTCUSDT -> BTC/USDT
            orderQty: orderQty.toString(),
            side: 'Sell',
            orderType: orderPrice ? 'Limit' : 'Market',
            ...(orderPrice && { orderPrice: orderPrice.toString() })
        };
        
        const path = '/api/pro/v1/order';
        const signature = createAscendEXSignature(timestamp, path, apiSecret);
        
        const response = await fetch(`${ASCENDEX_CONFIG.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'x-auth-key': apiKey,
                'x-auth-timestamp': timestamp.toString(),
                'x-auth-signature': signature,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('AscendEX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            orderId: orderResult.data?.orderId,
            symbol,
            orderQty,
            orderPrice
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderData.symbol,
                side: 'sell',
                type: orderPrice ? 'limit' : 'market',
                quantity: parseFloat(orderQty),
                price: parseFloat(orderPrice || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('AscendEX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'ascendex',
            symbol,
            orderQty,
            orderPrice,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// ============================================================================
// HTX (HUOBI) EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// HTX API Configuration
const HTX_CONFIG = {
    baseUrl: 'https://api.huobi.pro',
    endpoints: {
        balance: '/v1/account/accounts/{account-id}/balance',
        accounts: '/v1/account/accounts',
        ticker: '/market/detail/merged',
        test: '/v1/account/accounts'
    }
};

// HTX Authentication Helper
function createHTXSignature(method, host, path, params, apiSecret) {
    const sortedParams = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    const meta = [method, host, path, sortedParams].join('\n');
    return crypto.createHmac('sha256', apiSecret).update(meta).digest('base64');
}

// POST /api/v1/trading/htx/balance - Get HTX account balance
router.post('/htx/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        // First get account ID
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const params = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        // Add detailed logging for debugging
        const sortedParamsString = Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
        const signatureString = `GET\napi.huobi.pro\n${HTX_CONFIG.endpoints.accounts}\n${sortedParamsString}`;
        
        systemLogger.trading('HTX signature debug', {
            userId: req.user?.id,
            timestamp: timestamp,
            params: JSON.stringify(params),
            sortedParams: sortedParamsString,
            signatureString: signatureString,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        });
        
        // Try both standard host and host with port (common issue from Stack Overflow)
        let signature = createHTXSignature('GET', 'api.huobi.pro', HTX_CONFIG.endpoints.accounts, params, apiSecret);
        
        systemLogger.trading('HTX trying standard host signature', {
            userId: req.user?.id,
            signature: signature.substring(0, 16) + '...'
        });
        params.Signature = signature;
        
        const accountsUrl = `${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.accounts}?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;
        
        systemLogger.trading('HTX request URL debug', {
            userId: req.user?.id,
            url: accountsUrl
        });
        
        const accountsResponse = await fetch(accountsUrl);
        
        if (!accountsResponse.ok) {
            const errorText = await accountsResponse.text();
            systemLogger.trading('HTX accounts HTTP error', {
                userId: req.user?.id,
                status: accountsResponse.status,
                error: errorText,
                url: accountsUrl
            });
            throw new APIError(`HTX API error: ${accountsResponse.status} - ${errorText}`, 502, 'HTX_API_ERROR');
        }
        
        const accountsData = await accountsResponse.json();
        
        // Add debugging to see what HTX returns
        systemLogger.trading('HTX accounts response', {
            userId: req.user?.id,
            status: accountsData.status,
            errCode: accountsData['err-code'],
            errMsg: accountsData['err-msg'],
            hasData: !!accountsData.data,
            response: JSON.stringify(accountsData)
        });
        
        if (accountsData.status !== 'ok') {
            systemLogger.trading('HTX authentication failed', {
                userId: req.user?.id,
                errCode: accountsData['err-code'],
                errMsg: accountsData['err-msg'],
                timestamp: timestamp,
                signatureUsed: signature.substring(0, 16) + '...'
            });
            
            // Return debug info to frontend for troubleshooting
            res.json({
                success: false,
                error: {
                    code: 'HTX_AUTH_ERROR',
                    message: `HTX error: ${accountsData['err-code']} - ${accountsData['err-msg']}`,
                    debug: {
                        timestamp: timestamp,
                        sortedParams: sortedParamsString,
                        signatureString: signatureString,
                        errCode: accountsData['err-code'],
                        errMsg: accountsData['err-msg'],
                        apiKeyPrefix: apiKey.substring(0, 8) + '...'
                    }
                }
            });
            return;
        }
        
        if (!accountsData.data || accountsData.data.length === 0) {
            throw new APIError('HTX error: No accounts found - API key may need account permissions', 400, 'HTX_ERROR');
        }
        
        const accountId = accountsData.data[0].id;
        
        // Now get balance
        const balanceParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '')
        };
        
        const balancePath = HTX_CONFIG.endpoints.balance.replace('{account-id}', accountId);
        signature = createHTXSignature('GET', 'api.huobi.pro', balancePath, balanceParams, apiSecret);
        balanceParams.Signature = signature;
        
        const balanceUrl = `${HTX_CONFIG.baseUrl}${balancePath}?${Object.keys(balanceParams).map(key => `${key}=${encodeURIComponent(balanceParams[key])}`).join('&')}`;
        const response = await fetch(balanceUrl);

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('HTX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorText
            });
            throw new APIError(`HTX API error: ${response.status}`, 502, 'HTX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.status !== 'ok') {
            throw new APIError(`HTX error: ${data['err-msg']}`, 400, 'HTX_ERROR');
        }

        const balances = {};
        if (data.data && data.data.list) {
            data.data.list.forEach(balance => {
                if (balance.type === 'trade') {
                    const amount = parseFloat(balance.balance);
                    if (amount > 0) {
                        balances[balance.currency.toUpperCase()] = amount;
                    }
                }
            });
        }

        systemLogger.trading('HTX balance retrieved', {
            userId: req.user?.id,
            currencies: Object.keys(balances)
        });

        res.json({
            success: true,
            data: {
                exchange: 'htx',
                balances
            }
        });

    } catch (error) {
        systemLogger.trading('HTX balance error', {
            userId: req.user?.id,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch HTX balance', 500, 'HTX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/htx/ticker - Get HTX ticker data
router.post('/htx/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> btcusdt for HTX)
        const htxSymbol = pair.toLowerCase();
        
        const response = await fetch(`${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.ticker}?symbol=${htxSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('HTX ticker API error', {
                userId: req.user?.id,
                pair: htxSymbol,
                status: response.status,
                error: errorText
            });
            throw new APIError(`HTX API error: ${response.status}`, 502, 'HTX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.status !== 'ok') {
            throw new APIError(`HTX error: ${data['err-msg']}`, 400, 'HTX_ERROR');
        }

        let ticker = null;
        if (data.tick) {
            ticker = {
                symbol: htxSymbol,
                lastPrice: parseFloat(data.tick.close),
                bidPrice: parseFloat(data.tick.bid[0]),
                askPrice: parseFloat(data.tick.ask[0]),
                volume: parseFloat(data.tick.vol),
                high: parseFloat(data.tick.high),
                low: parseFloat(data.tick.low),
                change: ((parseFloat(data.tick.close) - parseFloat(data.tick.open)) / parseFloat(data.tick.open) * 100)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        systemLogger.trading('HTX ticker retrieved', {
            userId: req.user?.id,
            pair: htxSymbol,
            price: ticker.lastPrice
        });

        res.json({
            success: true,
            data: {
                exchange: 'htx',
                pair: htxSymbol,
                ticker
            }
        });

    } catch (error) {
        systemLogger.trading('HTX ticker error', {
            userId: req.user?.id,
            pair,
            error: error.message
        });
        
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch HTX ticker', 500, 'HTX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/htx/test - Test HTX API connection
router.post('/htx/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const params = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        const signature = createHTXSignature('GET', 'api.huobi.pro', HTX_CONFIG.endpoints.test, params, apiSecret);
        params.Signature = signature;
        
        const url = `${HTX_CONFIG.baseUrl}${HTX_CONFIG.endpoints.test}?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;
        const response = await fetch(url);

        const data = await response.json();
        
        if (data.status !== 'ok') {
            systemLogger.trading('HTX API test failed', {
                userId: req.user?.id,
                error: data['err-msg']
            });
            
            res.json({
                success: false,
                data: {
                    exchange: 'htx',
                    connected: false,
                    error: data['err-msg']
                }
            });
            return;
        }

        systemLogger.trading('HTX API test successful', {
            userId: req.user?.id
        });

        res.json({
            success: true,
            data: {
                exchange: 'htx',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        systemLogger.trading('HTX test error', {
            userId: req.user?.id,
            error: error.message
        });
        
        res.json({
            success: false,
            data: {
                exchange: 'htx',
                connected: false,
                error: error.message
            }
        });
    }
}));

// HTX Buy Order Endpoint
router.post('/htx/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, amount, price } = req.body;
    
    try {
        systemLogger.trading('HTX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            endpoint: 'buy-order',
            symbol,
            amount,
            price
        });
        
        // First get account ID
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const accountParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        const accountSignature = createHTXSignature('GET', 'api.huobi.pro', '/v1/account/accounts', accountParams, apiSecret);
        accountParams.Signature = accountSignature;
        
        const accountQuery = Object.keys(accountParams).sort().map(key => `${key}=${encodeURIComponent(accountParams[key])}`).join('&');
        
        const accountResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/account/accounts?${accountQuery}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!accountResponse.ok) {
            const errorText = await accountResponse.text();
            throw new Error(`Account fetch failed: ${errorText}`);
        }
        
        const accountData = await accountResponse.json();
        
        if (accountData.status !== 'ok' || !accountData.data || accountData.data.length === 0) {
            throw new Error(accountData['err-msg'] || 'No trading accounts found');
        }
        
        const spotAccount = accountData.data.find(acc => acc.type === 'spot');
        if (!spotAccount) {
            throw new Error('Spot trading account not found');
        }
        
        // Now place order
        const orderTimestamp = new Date().toISOString().replace(/\.\d{3}/, '');
        const orderData = {
            'account-id': spotAccount.id.toString(),
            symbol: symbol.toLowerCase(),
            type: price ? 'buy-limit' : 'buy-market',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const orderBody = JSON.stringify(orderData);
        const orderParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: orderTimestamp
        };
        
        const orderSignature = createHTXSignature('POST', 'api.huobi.pro', '/v1/order/orders/place', orderParams, apiSecret);
        orderParams.Signature = orderSignature;
        
        const orderQuery = Object.keys(orderParams).sort().map(key => `${key}=${encodeURIComponent(orderParams[key])}`).join('&');
        
        const orderResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/order/orders/place?${orderQuery}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: orderBody
        });
        
        if (!orderResponse.ok) {
            const errorText = await orderResponse.text();
            throw new Error(`HTTP ${orderResponse.status}: ${errorText}`);
        }
        
        const orderResult = await orderResponse.json();
        
        if (orderResult.status !== 'ok') {
            throw new Error(orderResult['err-msg'] || 'Order placement failed');
        }
        
        systemLogger.trading('HTX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            orderId: orderResult.data,
            symbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data,
                symbol: symbol.toLowerCase(),
                side: 'buy',
                type: price ? 'limit' : 'market',
                amount: parseFloat(amount),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('HTX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            symbol,
            amount,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// HTX Sell Order Endpoint
router.post('/htx/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, amount, price } = req.body;
    
    try {
        systemLogger.trading('HTX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            endpoint: 'sell-order',
            symbol,
            amount,
            price
        });
        
        // First get account ID
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // HTX expects YYYY-MM-DDThh:mm:ss format in UTC
        const accountParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: timestamp
        };
        
        const accountSignature = createHTXSignature('GET', 'api.huobi.pro', '/v1/account/accounts', accountParams, apiSecret);
        accountParams.Signature = accountSignature;
        
        const accountQuery = Object.keys(accountParams).sort().map(key => `${key}=${encodeURIComponent(accountParams[key])}`).join('&');
        
        const accountResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/account/accounts?${accountQuery}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!accountResponse.ok) {
            const errorText = await accountResponse.text();
            throw new Error(`Account fetch failed: ${errorText}`);
        }
        
        const accountData = await accountResponse.json();
        
        if (accountData.status !== 'ok' || !accountData.data || accountData.data.length === 0) {
            throw new Error(accountData['err-msg'] || 'No trading accounts found');
        }
        
        const spotAccount = accountData.data.find(acc => acc.type === 'spot');
        if (!spotAccount) {
            throw new Error('Spot trading account not found');
        }
        
        // Now place order
        const orderTimestamp = new Date().toISOString().replace(/\.\d{3}/, '');
        const orderData = {
            'account-id': spotAccount.id.toString(),
            symbol: symbol.toLowerCase(),
            type: price ? 'sell-limit' : 'sell-market',
            amount: amount.toString(),
            ...(price && { price: price.toString() })
        };
        
        const orderBody = JSON.stringify(orderData);
        const orderParams = {
            AccessKeyId: apiKey,
            SignatureMethod: 'HmacSHA256',
            SignatureVersion: '2',
            Timestamp: orderTimestamp
        };
        
        const orderSignature = createHTXSignature('POST', 'api.huobi.pro', '/v1/order/orders/place', orderParams, apiSecret);
        orderParams.Signature = orderSignature;
        
        const orderQuery = Object.keys(orderParams).sort().map(key => `${key}=${encodeURIComponent(orderParams[key])}`).join('&');
        
        const orderResponse = await fetch(`${HTX_CONFIG.baseUrl}/v1/order/orders/place?${orderQuery}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: orderBody
        });
        
        if (!orderResponse.ok) {
            const errorText = await orderResponse.text();
            throw new Error(`HTTP ${orderResponse.status}: ${errorText}`);
        }
        
        const orderResult = await orderResponse.json();
        
        if (orderResult.status !== 'ok') {
            throw new Error(orderResult['err-msg'] || 'Order placement failed');
        }
        
        systemLogger.trading('HTX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            orderId: orderResult.data,
            symbol,
            amount,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data,
                symbol: symbol.toLowerCase(),
                side: 'sell',
                type: price ? 'limit' : 'market',
                amount: parseFloat(amount),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('HTX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'htx',
            symbol,
            amount,
            price,
            error: error.message
        });
        
        res.json({
            success: false,
            error: error.message
        });
    }
}));

// KuCoin Buy Order Endpoint
router.post('/kucoin/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('KuCoin buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            clientOid: `${timestamp}`,
            side: 'buy',
            symbol,
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const str_to_sign = timestamp + 'POST' + '/api/v1/orders' + body;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(str_to_sign)
            .digest('base64');
        
        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}/api/v1/orders`, {
            method: 'POST',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': crypto
                    .createHmac('sha256', apiSecret)
                    .update(passphrase)
                    .digest('base64'),
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '200000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('KuCoin buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                clientOid: `${timestamp}`,
                symbol,
                side: 'buy',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'active',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('KuCoin buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`KuCoin buy order failed: ${error.message}`, 500, 'KUCOIN_BUY_ORDER_ERROR');
    }
}));

// KuCoin Sell Order Endpoint
router.post('/kucoin/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('KuCoin sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            clientOid: `${timestamp}`,
            side: 'sell',
            symbol,
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const str_to_sign = timestamp + 'POST' + '/api/v1/orders' + body;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(str_to_sign)
            .digest('base64');
        
        const response = await fetch(`${KUCOIN_CONFIG.baseUrl}/api/v1/orders`, {
            method: 'POST',
            headers: {
                'KC-API-KEY': apiKey,
                'KC-API-SIGN': signature,
                'KC-API-TIMESTAMP': timestamp.toString(),
                'KC-API-PASSPHRASE': crypto
                    .createHmac('sha256', apiSecret)
                    .update(passphrase)
                    .digest('base64'),
                'KC-API-KEY-VERSION': '2',
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '200000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('KuCoin sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                clientOid: `${timestamp}`,
                symbol,
                side: 'sell',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'active',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('KuCoin sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'kucoin',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`KuCoin sell order failed: ${error.message}`, 500, 'KUCOIN_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BINGX EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// BingX API Configuration
const BINGX_CONFIG = {
    baseUrl: 'https://open-api.bingx.com',
    endpoints: {
        balance: '/openApi/spot/v1/account/balance',
        ticker: '/openApi/spot/v1/ticker/24hr',
        test: '/openApi/spot/v1/account/balance'
    }
};

// BingX Authentication Helper
function createBingXSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/bingx/balance - Get BingX account balance
router.post('/bingx/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBingXSignature(queryString, apiSecret);

        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = errorText;
            }
            
            systemLogger.trading('BingX balance API error', {
                userId: req.user?.id,
                status: response.status,
                error: errorData,
                requestDetails: {
                    url: `${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.balance}`,
                    queryString: queryString,
                    signature: signature.substring(0, 16) + '...',
                    apiKey: apiKey.substring(0, 8) + '...'
                }
            });
            
            // Pass the actual error message to the frontend
            const errorMessage = errorData?.msg || errorData?.message || `BingX API error: ${response.status}`;
            throw new APIError(errorMessage, 502, 'BINGX_API_ERROR');
        }

        const data = await response.json();
        
        // Log successful response for debugging
        systemLogger.trading('BingX balance response', {
            userId: req.user?.id,
            code: data.code,
            msg: data.msg,
            hasData: !!data.data
        });
        
        if (data.code !== 0) {
            systemLogger.trading('BingX API returned error code', {
                userId: req.user?.id,
                code: data.code,
                message: data.msg,
                fullResponse: JSON.stringify(data)
            });
            throw new APIError(`BingX error: ${data.msg || 'Unknown error'}`, 400, 'BINGX_ERROR');
        }

        const balances = {};
        if (data.data && data.data.balances) {
            data.data.balances.forEach(balance => {
                const free = parseFloat(balance.free);
                if (free > 0) {
                    balances[balance.asset] = free;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bingx',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BingX balance', 500, 'BINGX_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bingx/ticker - Get BingX ticker data
router.post('/bingx/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`BingX API error: ${response.status}`, 502, 'BINGX_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 0) {
            throw new APIError(`BingX error: ${data.msg}`, 400, 'BINGX_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: data.data.symbol,
                lastPrice: parseFloat(data.data.lastPrice),
                bidPrice: parseFloat(data.data.bidPrice),
                askPrice: parseFloat(data.data.askPrice),
                volume: parseFloat(data.data.volume),
                high: parseFloat(data.data.highPrice),
                low: parseFloat(data.data.lowPrice),
                change: parseFloat(data.data.priceChangePercent)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bingx',
                pair,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BingX ticker', 500, 'BINGX_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bingx/test - Test BingX API connection
router.post('/bingx/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBingXSignature(queryString, apiSecret);

        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.test}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== 0) {
            res.json({
                success: false,
                data: {
                    exchange: 'bingx',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bingx',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bingx',
                connected: false,
                error: error.message
            }
        });
    }
}));

// BingX Buy Order Endpoint
router.post('/bingx/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('BingX buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('BingX buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            orderId: orderResult.data?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderResult.data?.symbol,
                side: 'BUY',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'NEW',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BingX buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`BingX buy order failed: ${error.message}`, 500, 'BINGX_BUY_ORDER_ERROR');
    }
}));

// BingX Sell Order Endpoint
router.post('/bingx/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('BingX sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BINGX_CONFIG.baseUrl}${BINGX_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-BX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('BingX sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            orderId: orderResult.data?.orderId,
            symbol,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol: orderResult.data?.symbol,
                side: 'SELL',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'NEW',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BingX sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bingx',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`BingX sell order failed: ${error.message}`, 500, 'BINGX_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BITGET EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Bitget API Configuration
const BITGET_CONFIG = {
    baseUrl: 'https://api.bitget.com',
    endpoints: {
        balance: '/api/spot/v1/account/assets',
        ticker: '/api/spot/v1/market/ticker',
        test: '/api/spot/v1/account/assets'
    }
};

// Bitget Authentication Helper
function createBitgetSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = timestamp + method + requestPath + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('base64');
}

// POST /api/v1/trading/bitget/balance - Get Bitget account balance
router.post('/bitget/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = BITGET_CONFIG.endpoints.balance;
        const signature = createBitgetSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${BITGET_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitget API error: ${response.status}`, 502, 'BITGET_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '00000') {
            throw new APIError(`Bitget error: ${data.msg}`, 400, 'BITGET_ERROR');
        }

        const balances = {};
        if (data.data) {
            data.data.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.coinName] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitget',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitget balance', 500, 'BITGET_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bitget/ticker - Get Bitget ticker data
router.post('/bitget/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTCUSDT_SPBL for Bitget)
        const bitgetSymbol = `${pair}_SPBL`;
        
        const response = await fetch(`${BITGET_CONFIG.baseUrl}${BITGET_CONFIG.endpoints.ticker}?symbol=${bitgetSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitget API error: ${response.status}`, 502, 'BITGET_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== '00000') {
            throw new APIError(`Bitget error: ${data.msg}`, 400, 'BITGET_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: bitgetSymbol,
                lastPrice: parseFloat(data.data.close),
                bidPrice: parseFloat(data.data.bidPr),
                askPrice: parseFloat(data.data.askPr),
                volume: parseFloat(data.data.baseVol),
                high: parseFloat(data.data.high24h),
                low: parseFloat(data.data.low24h),
                change: parseFloat(data.data.change)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitget',
                pair: bitgetSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitget ticker', 500, 'BITGET_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bitget/test - Test Bitget API connection
router.post('/bitget/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = BITGET_CONFIG.endpoints.test;
        const signature = createBitgetSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${BITGET_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code !== '00000') {
            res.json({
                success: false,
                data: {
                    exchange: 'bitget',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitget',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bitget',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Bitget Buy Order Endpoint
router.post('/bitget/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('Bitget buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'buy',
            orderType: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = createBitgetSignature(timestamp, 'POST', '/api/spot/v1/trade/orders', body, apiSecret);
        
        const response = await fetch(`${BITGET_CONFIG.baseUrl}/api/spot/v1/trade/orders`, {
            method: 'POST',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '00000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('Bitget buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol,
                side: 'buy',
                orderType: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'new',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitget buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`Bitget buy order failed: ${error.message}`, 500, 'BITGET_BUY_ORDER_ERROR');
    }
}));

// Bitget Sell Order Endpoint
router.post('/bitget/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, passphrase, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('Bitget sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'sell',
            orderType: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = createBitgetSignature(timestamp, 'POST', '/api/spot/v1/trade/orders', body, apiSecret);
        
        const response = await fetch(`${BITGET_CONFIG.baseUrl}/api/spot/v1/trade/orders`, {
            method: 'POST',
            headers: {
                'ACCESS-KEY': apiKey,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '00000') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('Bitget sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            orderId: orderResult.data?.orderId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.orderId,
                symbol,
                side: 'sell',
                orderType: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: orderResult.data?.status || 'new',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitget sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitget',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`Bitget sell order failed: ${error.message}`, 500, 'BITGET_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BITMART EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// BitMart API Configuration
const BITMART_CONFIG = {
    baseUrl: 'https://api-cloud.bitmart.com',
    endpoints: {
        balance: '/spot/v1/wallet',
        ticker: '/spot/v1/ticker',
        test: '/spot/v1/wallet'
    }
};

// BitMart Authentication Helper
function createBitMartSignature(timestamp, memo, queryString, apiSecret) {
    // BitMart signature format: timestamp + '#' + memo + '#' + queryString
    const message = timestamp + '#' + (memo || '') + '#' + (queryString || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

// POST /api/v1/trading/bitmart/balance - Get BitMart account balance
router.post('/bitmart/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').optional() // Made memo optional
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, memo } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        // For GET requests, queryString is empty
        const signature = createBitMartSignature(timestamp, memo || '', '', apiSecret);

        const headers = {
            'X-BM-KEY': apiKey,
            'X-BM-SIGN': signature,
            'X-BM-TIMESTAMP': timestamp,
            'Content-Type': 'application/json'
        };
        
        // Only add memo header if provided
        if (memo) {
            headers['X-BM-PASSPHRASE'] = memo;
        }

        const response = await fetch(`${BITMART_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new APIError(`BitMart API error: ${response.status}`, 502, 'BITMART_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 1000) {
            throw new APIError(`BitMart error: ${data.message}`, 400, 'BITMART_ERROR');
        }

        const balances = {};
        if (data.data && data.data.wallet) {
            data.data.wallet.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.id] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitmart',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BitMart balance', 500, 'BITMART_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bitmart/ticker - Get BitMart ticker data
router.post('/bitmart/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC_USDT for BitMart)
        const bitmartSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const response = await fetch(`${BITMART_CONFIG.baseUrl}${BITMART_CONFIG.endpoints.ticker}?symbol=${bitmartSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`BitMart API error: ${response.status}`, 502, 'BITMART_API_ERROR');
        }

        const data = await response.json();
        
        if (data.code !== 1000) {
            throw new APIError(`BitMart error: ${data.message}`, 400, 'BITMART_ERROR');
        }

        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: bitmartSymbol,
                lastPrice: parseFloat(data.data.last_price),
                bidPrice: parseFloat(data.data.best_bid),
                askPrice: parseFloat(data.data.best_ask),
                volume: parseFloat(data.data.base_volume_24h),
                high: parseFloat(data.data.high_24h),
                low: parseFloat(data.data.low_24h),
                change: parseFloat(data.data.fluctuation)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitmart',
                pair: bitmartSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch BitMart ticker', 500, 'BITMART_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bitmart/test - Test BitMart API connection
router.post('/bitmart/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').optional() // Made memo optional
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, memo } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        // For GET requests, queryString is empty
        const signature = createBitMartSignature(timestamp, memo || '', '', apiSecret);

        const headers = {
            'X-BM-KEY': apiKey,
            'X-BM-SIGN': signature,
            'X-BM-TIMESTAMP': timestamp,
            'Content-Type': 'application/json'
        };
        
        // Only add memo header if provided
        if (memo) {
            headers['X-BM-PASSPHRASE'] = memo;
        }

        const response = await fetch(`${BITMART_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('BitMart API error', {
                status: response.status,
                error: errorText,
                headers: headers
            });
            throw new APIError(`BitMart API error: ${response.status}`, 502, 'BITMART_API_ERROR');
        }

        const data = await response.json().catch(() => ({}));
        
        if (!data || data.code !== 1000) {
            res.json({
                success: false,
                data: {
                    exchange: 'bitmart',
                    connected: false,
                    error: data.message || 'Failed to connect to BitMart'
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitmart',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bitmart',
                connected: false,
                error: error.message
            }
        });
    }
}));

// BitMart Buy Order Endpoint
router.post('/bitmart/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').notEmpty().withMessage('Memo is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, memo, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('BitMart buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'buy',
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        // For POST requests with body, the queryString is the body itself
        const signature = createBitMartSignature(timestamp, memo || '', body, apiSecret);
        
        const response = await fetch(`${BITMART_CONFIG.baseUrl}/spot/v2/submit_order`, {
            method: 'POST',
            headers: {
                'X-BM-KEY': apiKey,
                'X-BM-SIGN': signature,
                'X-BM-TIMESTAMP': timestamp,
                'X-BM-MEMO': memo,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 1000) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('BitMart buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            orderId: orderResult.data?.order_id,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.order_id,
                symbol,
                side: 'buy',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BitMart buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`BitMart buy order failed: ${error.message}`, 500, 'BITMART_BUY_ORDER_ERROR');
    }
}));

// BitMart Sell Order Endpoint
router.post('/bitmart/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('memo').notEmpty().withMessage('Memo is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, memo, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('BitMart sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            symbol,
            side: 'sell',
            type: price ? 'limit' : 'market',
            size: size.toString(),
            ...(price && { price: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        // For POST requests with body, the queryString is the body itself
        const signature = createBitMartSignature(timestamp, memo || '', body, apiSecret);
        
        const response = await fetch(`${BITMART_CONFIG.baseUrl}/spot/v2/submit_order`, {
            method: 'POST',
            headers: {
                'X-BM-KEY': apiKey,
                'X-BM-SIGN': signature,
                'X-BM-TIMESTAMP': timestamp,
                'X-BM-MEMO': memo,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 1000) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('BitMart sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            orderId: orderResult.data?.order_id,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.order_id,
                symbol,
                side: 'sell',
                type: price ? 'limit' : 'market',
                size: parseFloat(size),
                price: parseFloat(price || 0),
                status: 'submitted',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('BitMart sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitmart',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`BitMart sell order failed: ${error.message}`, 500, 'BITMART_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// BITRUE EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Bitrue API Configuration
const BITRUE_CONFIG = {
    baseUrl: 'https://openapi.bitrue.com',
    endpoints: {
        balance: '/api/v1/account',
        ticker: '/api/v1/ticker/24hr',
        test: '/api/v1/account'
    }
};

// Bitrue Authentication Helper (similar to Binance)
function createBitrueSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/v1/trading/bitrue/balance - Get Bitrue account balance
router.post('/bitrue/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBitrueSignature(queryString, apiSecret);

        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.balance}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitrue API error: ${response.status}`, 502, 'BITRUE_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (data.balances) {
            data.balances.forEach(balance => {
                const free = parseFloat(balance.free);
                if (free > 0) {
                    balances[balance.asset] = free;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitrue',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitrue balance', 500, 'BITRUE_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/bitrue/ticker - Get Bitrue ticker data
router.post('/bitrue/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Bitrue API error: ${response.status}`, 502, 'BITRUE_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.symbol) {
            ticker = {
                symbol: data.symbol,
                lastPrice: parseFloat(data.lastPrice),
                bidPrice: parseFloat(data.bidPrice),
                askPrice: parseFloat(data.askPrice),
                volume: parseFloat(data.volume),
                high: parseFloat(data.highPrice),
                low: parseFloat(data.lowPrice),
                change: parseFloat(data.priceChangePercent)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitrue',
                pair,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Bitrue ticker', 500, 'BITRUE_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/bitrue/test - Test Bitrue API connection
router.post('/bitrue/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = createBitrueSignature(queryString, apiSecret);

        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.test}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code && data.code < 0) {
            res.json({
                success: false,
                data: {
                    exchange: 'bitrue',
                    connected: false,
                    error: data.msg
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'bitrue',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'bitrue',
                connected: false,
                error: error.message
            }
        });
    }
}));

// ============================================================================
// GEMINI EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Gemini API Configuration
const GEMINI_CONFIG = {
    baseUrl: 'https://api.gemini.com',
    endpoints: {
        balance: '/v1/balances',
        ticker: '/v1/pubticker',
        test: '/v1/heartbeat'
    }
};

// Gemini Authentication Helper
function createGeminiSignature(payload, apiSecret) {
    return crypto.createHmac('sha384', apiSecret).update(payload).digest('hex');
}

// POST /api/v1/trading/gemini/balance - Get Gemini account balance
router.post('/gemini/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now();
        const payload = {
            request: GEMINI_CONFIG.endpoints.balance,
            nonce: nonce,
            account: 'primary'  // Gemini expects account specification
        };
        const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
        const signature = createGeminiSignature(payloadBase64, apiSecret);

        systemLogger.trading('Gemini request debug', {
            userId: req.user?.id,
            url: `${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.balance}`,
            payload: JSON.stringify(payload),
            payloadBase64: payloadBase64
        });

        const response = await fetch(`${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.balance}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'X-GEMINI-APIKEY': apiKey,
                'X-GEMINI-PAYLOAD': payloadBase64,
                'X-GEMINI-SIGNATURE': signature
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            systemLogger.trading('Gemini API error', {
                userId: req.user?.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers),
                error: errorText,
                requestDetails: {
                    url: `${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.balance}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain',
                        'X-GEMINI-APIKEY': apiKey.substring(0, 8) + '...',
                        'X-GEMINI-PAYLOAD': payloadBase64.substring(0, 50) + '...',
                        'X-GEMINI-SIGNATURE': signature.substring(0, 16) + '...'
                    }
                }
            });
            throw new APIError(`Gemini API error: ${response.status} - ${errorText}`, 502, 'GEMINI_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (Array.isArray(data)) {
            data.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.currency] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'gemini',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gemini balance', 500, 'GEMINI_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/gemini/ticker - Get Gemini ticker data
router.post('/gemini/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> btcusd for Gemini)
        const geminiSymbol = pair.replace('USDT', 'USD').toLowerCase();
        
        const response = await fetch(`${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.ticker}/${geminiSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Gemini API error: ${response.status}`, 502, 'GEMINI_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.last) {
            ticker = {
                symbol: geminiSymbol,
                lastPrice: parseFloat(data.last),
                bidPrice: parseFloat(data.bid),
                askPrice: parseFloat(data.ask),
                volume: parseFloat(data.volume[Object.keys(data.volume)[0]] || 0),
                high: parseFloat(data.last),
                low: parseFloat(data.last),
                change: 0
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'gemini',
                pair: geminiSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Gemini ticker', 500, 'GEMINI_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/gemini/test - Test Gemini API connection
router.post('/gemini/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const nonce = Date.now();
        const payload = {
            request: GEMINI_CONFIG.endpoints.test,
            nonce: nonce
        };
        const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
        const signature = createGeminiSignature(payloadBase64, apiSecret);

        const response = await fetch(`${GEMINI_CONFIG.baseUrl}${GEMINI_CONFIG.endpoints.test}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'X-GEMINI-APIKEY': apiKey,
                'X-GEMINI-PAYLOAD': payloadBase64,
                'X-GEMINI-SIGNATURE': signature
            }
        });

        const data = await response.json();
        
        if (data.result === 'error') {
            res.json({
                success: false,
                data: {
                    exchange: 'gemini',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'gemini',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'gemini',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Bitrue Buy Order Endpoint
router.post('/bitrue/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Bitrue buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            endpoint: 'buy-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Bitrue buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'BUY',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitrue buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`Bitrue buy order failed: ${error.message}`, 500, 'BITRUE_BUY_ORDER_ERROR');
    }
}));

// Bitrue Sell Order Endpoint
router.post('/bitrue/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Bitrue sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            endpoint: 'sell-order',
            symbol,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            symbol,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            timestamp: timestamp.toString(),
            ...(price && { price: price.toString(), timeInForce: 'GTC' })
        };
        
        const queryString = new URLSearchParams(orderData).toString();
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');
            
        orderData.signature = signature;
        
        const response = await fetch(`${BITRUE_CONFIG.baseUrl}${BITRUE_CONFIG.endpoints.order}`, {
            method: 'POST',
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(orderData).toString()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        systemLogger.trading('Bitrue sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            orderId: orderResult.orderId,
            symbol,
            quantity,
            price: orderResult.price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.orderId,
                symbol: orderResult.symbol,
                side: 'SELL',
                type: orderResult.type,
                quantity: parseFloat(orderResult.origQty || quantity),
                price: parseFloat(orderResult.price || price || 0),
                status: orderResult.status,
                timestamp: orderResult.transactTime || new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Bitrue sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'bitrue',
            error: error.message,
            symbol,
            quantity
        });
        
        throw new APIError(`Bitrue sell order failed: ${error.message}`, 500, 'BITRUE_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// CRYPTO.COM EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// Crypto.com API Configuration
const CRYPTOCOM_CONFIG = {
    baseUrl: 'https://api.crypto.com',
    endpoints: {
        balance: '/v2/private/get-account-summary',
        ticker: '/v2/public/get-ticker',
        test: '/v2/private/get-account-summary'
    }
};

// Crypto.com Authentication Helper
function createCryptoComSignature(method, requestPath, body, apiSecret, timestamp, nonce) {
    const paramString = method + requestPath + body + timestamp + nonce;
    return crypto.createHmac('sha256', apiSecret).update(paramString).digest('hex');
}

// POST /api/v1/trading/cryptocom/balance - Get Crypto.com account balance
router.post('/cryptocom/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const nonce = Date.now();
        const method = 'POST';
        const requestPath = CRYPTOCOM_CONFIG.endpoints.balance;
        const requestBody = JSON.stringify({
            id: 11,
            method: 'private/get-account-summary',
            api_key: apiKey,
            nonce: nonce
        });
        
        const signature = createCryptoComSignature(method, requestPath, requestBody, apiSecret, timestamp, nonce);

        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `${apiKey}:${signature}:${nonce}`
            },
            body: requestBody
        });

        if (!response.ok) {
            throw new APIError(`Crypto.com API error: ${response.status}`, 502, 'CRYPTOCOM_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (data.result && data.result.accounts) {
            data.result.accounts.forEach(account => {
                const available = parseFloat(account.available);
                if (available > 0) {
                    balances[account.currency] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'cryptocom',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Crypto.com balance', 500, 'CRYPTOCOM_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/cryptocom/ticker - Get Crypto.com ticker data
router.post('/cryptocom/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        // Convert pair format (BTCUSDT -> BTC_USDT for Crypto.com)
        const cryptocomSymbol = pair.replace(/([A-Z]+)([A-Z]{3,4})$/, '$1_$2');
        
        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${CRYPTOCOM_CONFIG.endpoints.ticker}?instrument_name=${cryptocomSymbol}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`Crypto.com API error: ${response.status}`, 502, 'CRYPTOCOM_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.result && data.result.data && data.result.data.length > 0) {
            const tickerData = data.result.data[0];
            ticker = {
                symbol: cryptocomSymbol,
                lastPrice: parseFloat(tickerData.a),
                bidPrice: parseFloat(tickerData.b),
                askPrice: parseFloat(tickerData.k),
                volume: parseFloat(tickerData.v),
                high: parseFloat(tickerData.h),
                low: parseFloat(tickerData.l),
                change: parseFloat(tickerData.c || 0)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'cryptocom',
                pair: cryptocomSymbol,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch Crypto.com ticker', 500, 'CRYPTOCOM_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/cryptocom/test - Test Crypto.com API connection
router.post('/cryptocom/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret } = req.body;
    
    try {
        const timestamp = Date.now();
        const nonce = Date.now();
        const method = 'POST';
        const requestPath = CRYPTOCOM_CONFIG.endpoints.test;
        const requestBody = JSON.stringify({
            id: 11,
            method: 'private/get-account-summary',
            api_key: apiKey,
            nonce: nonce
        });
        
        const signature = createCryptoComSignature(method, requestPath, requestBody, apiSecret, timestamp, nonce);

        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `${apiKey}:${signature}:${nonce}`
            },
            body: requestBody
        });

        const data = await response.json();
        
        if (data.code && data.code !== 0) {
            res.json({
                success: false,
                data: {
                    exchange: 'cryptocom',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'cryptocom',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'cryptocom',
                connected: false,
                error: error.message
            }
        });
    }
}));

// Crypto.com Buy Order Endpoint
router.post('/cryptocom/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('instrument_name').notEmpty().withMessage('Instrument name is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, instrument_name, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Crypto.com buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            endpoint: 'buy-order',
            instrument_name,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            instrument_name,
            side: 'BUY',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const nonce = timestamp;
        const method = 'POST';
        const requestPath = '/v2/private/create-order';
        const body = JSON.stringify(orderData);
        
        const signaturePayload = method + requestPath + body + nonce;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');
        
        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
                'signature': signature,
                'nonce': nonce.toString()
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('Crypto.com buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            orderId: orderResult.result?.order_id,
            instrument_name,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.order_id,
                instrument_name,
                side: 'BUY',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.result?.status || 'PENDING',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Crypto.com buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            error: error.message,
            instrument_name,
            quantity
        });
        
        throw new APIError(`Crypto.com buy order failed: ${error.message}`, 500, 'CRYPTOCOM_BUY_ORDER_ERROR');
    }
}));

// Crypto.com Sell Order Endpoint
router.post('/cryptocom/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('instrument_name').notEmpty().withMessage('Instrument name is required'),
    body('quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, instrument_name, quantity, price } = req.body;
    
    try {
        systemLogger.trading('Crypto.com sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            endpoint: 'sell-order',
            instrument_name,
            quantity,
            price
        });
        
        const timestamp = Date.now();
        const orderData = {
            instrument_name,
            side: 'SELL',
            type: price ? 'LIMIT' : 'MARKET',
            quantity: quantity.toString(),
            ...(price && { price: price.toString() })
        };
        
        const nonce = timestamp;
        const method = 'POST';
        const requestPath = '/v2/private/create-order';
        const body = JSON.stringify(orderData);
        
        const signaturePayload = method + requestPath + body + nonce;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signaturePayload)
            .digest('hex');
        
        const response = await fetch(`${CRYPTOCOM_CONFIG.baseUrl}${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
                'signature': signature,
                'nonce': nonce.toString()
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== 0) {
            throw new Error(orderResult.message || 'Order placement failed');
        }
        
        systemLogger.trading('Crypto.com sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            orderId: orderResult.result?.order_id,
            instrument_name,
            quantity,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.result?.order_id,
                instrument_name,
                side: 'SELL',
                type: price ? 'LIMIT' : 'MARKET',
                quantity: parseFloat(quantity),
                price: parseFloat(price || 0),
                status: orderResult.result?.status || 'PENDING',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('Crypto.com sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'cryptocom',
            error: error.message,
            instrument_name,
            quantity
        });
        
        throw new APIError(`Crypto.com sell order failed: ${error.message}`, 500, 'CRYPTOCOM_SELL_ORDER_ERROR');
    }
}));

// ============================================================================
// COINCATCH EXCHANGE API PROXY ENDPOINTS
// ============================================================================

// CoinCatch API Configuration
const COINCATCH_CONFIG = {
    baseUrl: 'https://api.coincatch.com',
    endpoints: {
        balance: '/api/v1/account/balance',
        ticker: '/api/v1/market/ticker',
        test: '/api/v1/account/balance'
    }
};

// CoinCatch Authentication Helper
function createCoinCatchSignature(timestamp, method, requestPath, body, apiSecret) {
    const message = timestamp + method + requestPath + (body || '');
    return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

// POST /api/v1/trading/coincatch/balance - Get CoinCatch account balance
router.post('/coincatch/balance', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = COINCATCH_CONFIG.endpoints.balance;
        const signature = createCoinCatchSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'CC-API-KEY': apiKey,
                'CC-API-SIGN': signature,
                'CC-API-TIMESTAMP': timestamp,
                'CC-API-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`CoinCatch API error: ${response.status}`, 502, 'COINCATCH_API_ERROR');
        }

        const data = await response.json();
        
        const balances = {};
        if (data.data && Array.isArray(data.data)) {
            data.data.forEach(balance => {
                const available = parseFloat(balance.available);
                if (available > 0) {
                    balances[balance.currency] = available;
                }
            });
        }

        res.json({
            success: true,
            data: {
                exchange: 'coincatch',
                balances
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch CoinCatch balance', 500, 'COINCATCH_BALANCE_ERROR');
    }
}));

// POST /api/v1/trading/coincatch/ticker - Get CoinCatch ticker data
router.post('/coincatch/ticker', tickerRateLimit, optionalAuth, [
    body('pair').notEmpty().withMessage('Trading pair is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { pair } = req.body;
    
    try {
        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}${COINCATCH_CONFIG.endpoints.ticker}?symbol=${pair}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new APIError(`CoinCatch API error: ${response.status}`, 502, 'COINCATCH_API_ERROR');
        }

        const data = await response.json();
        
        let ticker = null;
        if (data.data) {
            ticker = {
                symbol: data.data.symbol,
                lastPrice: parseFloat(data.data.close),
                bidPrice: parseFloat(data.data.bid),
                askPrice: parseFloat(data.data.ask),
                volume: parseFloat(data.data.volume),
                high: parseFloat(data.data.high),
                low: parseFloat(data.data.low),
                change: parseFloat(data.data.change)
            };
        }

        if (!ticker) {
            throw new APIError('No ticker data available', 404, 'NO_TICKER_DATA');
        }

        res.json({
            success: true,
            data: {
                exchange: 'coincatch',
                pair,
                ticker
            }
        });

    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError('Failed to fetch CoinCatch ticker', 500, 'COINCATCH_TICKER_ERROR');
    }
}));

// POST /api/v1/trading/coincatch/test - Test CoinCatch API connection
router.post('/coincatch/test', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('passphrase').notEmpty().withMessage('Passphrase is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }

    const { apiKey, apiSecret, passphrase } = req.body;
    
    try {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = COINCATCH_CONFIG.endpoints.test;
        const signature = createCoinCatchSignature(timestamp, method, requestPath, '', apiSecret);

        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}${requestPath}`, {
            method: 'GET',
            headers: {
                'CC-API-KEY': apiKey,
                'CC-API-SIGN': signature,
                'CC-API-TIMESTAMP': timestamp,
                'CC-API-PASSPHRASE': passphrase,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        
        if (data.code && data.code !== '0') {
            res.json({
                success: false,
                data: {
                    exchange: 'coincatch',
                    connected: false,
                    error: data.message
                }
            });
            return;
        }

        res.json({
            success: true,
            data: {
                exchange: 'coincatch',
                connected: true,
                message: 'API connection successful'
            }
        });

    } catch (error) {
        res.json({
            success: false,
            data: {
                exchange: 'coincatch',
                connected: false,
                error: error.message
            }
        });
    }
}));

// CoinCatch Buy Order Endpoint
router.post('/coincatch/buy-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('CoinCatch buy order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            endpoint: 'buy-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            instId: symbol,
            tdMode: 'cash',
            side: 'buy',
            ordType: price ? 'limit' : 'market',
            sz: size.toString(),
            ...(price && { px: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + 'POST' + '/api/v5/trade/order' + body)
            .digest('base64');
        
        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}/api/v5/trade/order`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': apiSecret,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('CoinCatch buy order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            orderId: orderResult.data?.[0]?.ordId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.[0]?.ordId,
                instId: symbol,
                side: 'buy',
                ordType: price ? 'limit' : 'market',
                sz: parseFloat(size),
                px: parseFloat(price || 0),
                state: orderResult.data?.[0]?.sCode || 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('CoinCatch buy order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`CoinCatch buy order failed: ${error.message}`, 500, 'COINCATCH_BUY_ORDER_ERROR');
    }
}));

// CoinCatch Sell Order Endpoint
router.post('/coincatch/sell-order', tradingRateLimit, optionalAuth, [
    body('apiKey').notEmpty().withMessage('API key is required'),
    body('apiSecret').notEmpty().withMessage('API secret is required'),
    body('symbol').notEmpty().withMessage('Trading symbol is required'),
    body('size').isFloat({ min: 0.01 }).withMessage('Size must be a positive number'),
    body('price').optional().isFloat({ min: 0.01 }).withMessage('Price must be a positive number')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { apiKey, apiSecret, symbol, size, price } = req.body;
    
    try {
        systemLogger.trading('CoinCatch sell order initiated', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            endpoint: 'sell-order',
            symbol,
            size,
            price
        });
        
        const timestamp = Date.now().toString();
        const orderData = {
            instId: symbol,
            tdMode: 'cash',
            side: 'sell',
            ordType: price ? 'limit' : 'market',
            sz: size.toString(),
            ...(price && { px: price.toString() })
        };
        
        const body = JSON.stringify(orderData);
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(timestamp + 'POST' + '/api/v5/trade/order' + body)
            .digest('base64');
        
        const response = await fetch(`${COINCATCH_CONFIG.baseUrl}/api/v5/trade/order`, {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': apiSecret,
                'Content-Type': 'application/json'
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const orderResult = await response.json();
        
        if (orderResult.code !== '0') {
            throw new Error(orderResult.msg || 'Order placement failed');
        }
        
        systemLogger.trading('CoinCatch sell order placed successfully', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            orderId: orderResult.data?.[0]?.ordId,
            symbol,
            size,
            price
        });
        
        res.json({
            success: true,
            order: {
                orderId: orderResult.data?.[0]?.ordId,
                instId: symbol,
                side: 'sell',
                ordType: price ? 'limit' : 'market',
                sz: parseFloat(size),
                px: parseFloat(price || 0),
                state: orderResult.data?.[0]?.sCode || 'pending',
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        systemLogger.trading('CoinCatch sell order failed', {
            userId: req.user?.id || 'anonymous',
            exchange: 'coincatch',
            error: error.message,
            symbol,
            size
        });
        
        throw new APIError(`CoinCatch sell order failed: ${error.message}`, 500, 'COINCATCH_SELL_ORDER_ERROR');
    }
}));

module.exports = router;