const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireOwnershipOrAdmin } = require('../middleware/auth');
const { authenticatedRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');

const router = express.Router();

// Apply authentication and rate limiting to all user routes
router.use(authenticatedRateLimit);
router.use(authenticateUser);

// GET /api/v1/user/profile - Get user profile
router.get('/profile', asyncHandler(async (req, res) => {
    const userResult = await query(`
        SELECT u.id, u.first_name, u.last_name, u.email, u.mobile, u.country,
               u.admin_role, u.account_status, u.subscription_plan, u.subscription_expires_at,
               u.created_at, u.updated_at, u.last_login_at, u.payment_reference,
               ta.exchanges_connected, ta.exchanges_connected_count, ta.selected_crypto_assets,
               ta.trading_active, ta.auto_trading_enabled, ta.total_trades_count,
               ta.successful_trades_count, ta.failed_trades_count, ta.profit_loss_total,
               ta.api_keys_configured, ta.usdt_balance_detected, ta.safety_controls_completed,
               ta.auto_trading_readiness_percent, ta.last_trading_activity
        FROM users u
        LEFT JOIN trading_activity ta ON u.id = ta.user_id
        WHERE u.id = $1
    `, [req.user.id]);
    
    if (userResult.rows.length === 0) {
        throw new APIError('User not found', 404, 'USER_NOT_FOUND');
    }
    
    const userData = userResult.rows[0];
    
    res.json({
        success: true,
        data: {
            profile: {
                id: userData.id,
                firstName: userData.first_name,
                lastName: userData.last_name,
                email: userData.email,
                mobile: userData.mobile,
                country: userData.country,
                adminRole: userData.admin_role,
                accountStatus: userData.account_status,
                subscriptionPlan: userData.subscription_plan,
                subscriptionExpiresAt: userData.subscription_expires_at,
                createdAt: userData.created_at,
                updatedAt: userData.updated_at,
                lastLoginAt: userData.last_login_at,
                paymentReference: userData.payment_reference
            },
            tradingActivity: {
                exchangesConnected: userData.exchanges_connected || [],
                exchangesConnectedCount: userData.exchanges_connected_count || 0,
                selectedCryptoAssets: userData.selected_crypto_assets || [],
                tradingActive: userData.trading_active || false,
                autoTradingEnabled: userData.auto_trading_enabled || false,
                totalTradesCount: userData.total_trades_count || 0,
                successfulTradesCount: userData.successful_trades_count || 0,
                failedTradesCount: userData.failed_trades_count || 0,
                profitLossTotal: parseFloat(userData.profit_loss_total || 0),
                apiKeysConfigured: userData.api_keys_configured || false,
                usdtBalanceDetected: userData.usdt_balance_detected || false,
                safetyControlsCompleted: userData.safety_controls_completed || false,
                autoTradingReadinessPercent: userData.auto_trading_readiness_percent || 0,
                lastTradingActivity: userData.last_trading_activity
            }
        }
    });
}));

// PUT /api/v1/user/profile - Update user profile
router.put('/profile', [
    body('firstName').optional().trim().isLength({ min: 2, max: 50 }).withMessage('First name must be 2-50 characters'),
    body('lastName').optional().trim().isLength({ min: 2, max: 50 }).withMessage('Last name must be 2-50 characters'),
    body('mobile').optional().isMobilePhone().withMessage('Valid mobile number is required'),
    body('country').optional().isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { firstName, lastName, mobile, country } = req.body;
    const updates = [];
    const values = [];
    let valueIndex = 1;
    
    // Build dynamic update query
    if (firstName !== undefined) {
        updates.push(`first_name = $${valueIndex++}`);
        values.push(firstName);
    }
    if (lastName !== undefined) {
        updates.push(`last_name = $${valueIndex++}`);
        values.push(lastName);
    }
    if (mobile !== undefined) {
        updates.push(`mobile = $${valueIndex++}`);
        values.push(mobile);
    }
    if (country !== undefined) {
        updates.push(`country = $${valueIndex++}`);
        values.push(country);
    }
    
    if (updates.length === 0) {
        throw new APIError('No valid fields to update', 400, 'NO_UPDATES');
    }
    
    // Add updated_at and user ID
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.user.id);
    
    await transaction(async (client) => {
        // Get old values for logging
        const oldDataResult = await client.query(
            'SELECT first_name, last_name, mobile, country FROM users WHERE id = $1',
            [req.user.id]
        );
        const oldData = oldDataResult.rows[0];
        
        // Update user
        const updateResult = await client.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${valueIndex} RETURNING first_name, last_name, mobile, country`,
            values
        );
        
        const updatedUser = updateResult.rows[0];
        
        // Log profile changes
        const changes = {};
        if (firstName !== undefined && firstName !== oldData.first_name) {
            changes.firstName = { from: oldData.first_name, to: firstName };
            await client.query(
                'INSERT INTO profile_updates (user_id, field_name, old_value, new_value, ip_address) VALUES ($1, $2, $3, $4, $5)',
                [req.user.id, 'first_name', oldData.first_name, firstName, req.ip]
            );
        }
        if (lastName !== undefined && lastName !== oldData.last_name) {
            changes.lastName = { from: oldData.last_name, to: lastName };
            await client.query(
                'INSERT INTO profile_updates (user_id, field_name, old_value, new_value, ip_address) VALUES ($1, $2, $3, $4, $5)',
                [req.user.id, 'last_name', oldData.last_name, lastName, req.ip]
            );
        }
        if (mobile !== undefined && mobile !== oldData.mobile) {
            changes.mobile = { from: oldData.mobile, to: mobile };
            await client.query(
                'INSERT INTO profile_updates (user_id, field_name, old_value, new_value, ip_address) VALUES ($1, $2, $3, $4, $5)',
                [req.user.id, 'mobile', oldData.mobile, mobile, req.ip]
            );
        }
        if (country !== undefined && country !== oldData.country) {
            changes.country = { from: oldData.country, to: country };
            await client.query(
                'INSERT INTO profile_updates (user_id, field_name, old_value, new_value, ip_address) VALUES ($1, $2, $3, $4, $5)',
                [req.user.id, 'country', oldData.country, country, req.ip]
            );
        }
        
        // Log user activity
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'profile_updated', changes, req.ip, req.get('User-Agent')]
        );
        
        systemLogger.user('Profile updated', {
            userId: req.user.id,
            changes: Object.keys(changes),
            ip: req.ip
        });
        
        res.json({
            success: true,
            data: {
                profile: {
                    firstName: updatedUser.first_name,
                    lastName: updatedUser.last_name,
                    mobile: updatedUser.mobile,
                    country: updatedUser.country
                }
            },
            message: 'Profile updated successfully'
        });
    });
}));

// GET /api/v1/user/activity - Get user activity history
router.get('/activity', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 records
    const offset = (page - 1) * limit;
    
    const activityResult = await query(`
        SELECT activity_type, activity_details, ip_address, created_at
        FROM user_activity
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `, [req.user.id, limit, offset]);
    
    const countResult = await query(
        'SELECT COUNT(*) as total FROM user_activity WHERE user_id = $1',
        [req.user.id]
    );
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    res.json({
        success: true,
        data: {
            activity: activityResult.rows.map(row => ({
                type: row.activity_type,
                details: row.activity_details,
                ipAddress: row.ip_address,
                timestamp: row.created_at
            })),
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// GET /api/v1/user/profile-changes - Get profile change history
router.get('/profile-changes', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    
    const changesResult = await query(`
        SELECT field_name, old_value, new_value, ip_address, created_at
        FROM profile_updates
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `, [req.user.id, limit, offset]);
    
    const countResult = await query(
        'SELECT COUNT(*) as total FROM profile_updates WHERE user_id = $1',
        [req.user.id]
    );
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    res.json({
        success: true,
        data: {
            changes: changesResult.rows.map(row => ({
                fieldName: row.field_name,
                oldValue: row.old_value,
                newValue: row.new_value,
                ipAddress: row.ip_address,
                timestamp: row.created_at
            })),
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// PUT /api/v1/user/trading-settings - Update trading settings
router.put('/trading-settings', [
    body('selectedCryptoAssets').optional().isArray().withMessage('Selected crypto assets must be an array'),
    body('tradingActive').optional().isBoolean().withMessage('Trading active must be boolean'),
    body('autoTradingEnabled').optional().isBoolean().withMessage('Auto trading enabled must be boolean'),
    body('apiKeysConfigured').optional().isBoolean().withMessage('API keys configured must be boolean'),
    body('usdtBalanceDetected').optional().isBoolean().withMessage('USDT balance detected must be boolean'),
    body('safetyControlsCompleted').optional().isBoolean().withMessage('Safety controls completed must be boolean'),
    body('exchangesConnected').optional().isArray().withMessage('Exchanges connected must be an array')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const {
        selectedCryptoAssets,
        tradingActive,
        autoTradingEnabled,
        apiKeysConfigured,
        usdtBalanceDetected,
        safetyControlsCompleted,
        exchangesConnected
    } = req.body;
    
    const updates = [];
    const values = [];
    let valueIndex = 1;
    
    // Build dynamic update query
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
    if (exchangesConnected !== undefined) {
        updates.push(`exchanges_connected = $${valueIndex++}`);
        values.push(JSON.stringify(exchangesConnected));
    }
    
    if (updates.length === 0) {
        throw new APIError('No valid trading settings to update', 400, 'NO_UPDATES');
    }
    
    // Add automatic fields
    updates.push('last_trading_activity = CURRENT_TIMESTAMP');
    updates.push('updated_at = CURRENT_TIMESTAMP');
    
    // Calculate auto trading readiness percentage
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
         RETURNING selected_crypto_assets, trading_active, auto_trading_enabled, 
                   api_keys_configured, usdt_balance_detected, safety_controls_completed,
                   exchanges_connected, auto_trading_readiness_percent, last_trading_activity`,
        values
    );
    
    if (updateResult.rows.length === 0) {
        throw new APIError('Trading activity record not found', 404, 'TRADING_RECORD_NOT_FOUND');
    }
    
    const updatedSettings = updateResult.rows[0];
    
    // Log user activity
    await query(
        'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [req.user.id, 'trading_settings_updated', {
            readinessPercent: readinessScore,
            tradingActive: tradingActive,
            autoTradingEnabled: autoTradingEnabled
        }, req.ip, req.get('User-Agent')]
    );
    
    systemLogger.trading('Trading settings updated', {
        userId: req.user.id,
        readinessPercent: readinessScore,
        tradingActive: tradingActive,
        autoTradingEnabled: autoTradingEnabled,
        assetsSelected: selectedCryptoAssets?.length || 0
    });
    
    res.json({
        success: true,
        data: {
            tradingSettings: {
                selectedCryptoAssets: JSON.parse(updatedSettings.selected_crypto_assets || '[]'),
                tradingActive: updatedSettings.trading_active,
                autoTradingEnabled: updatedSettings.auto_trading_enabled,
                apiKeysConfigured: updatedSettings.api_keys_configured,
                usdtBalanceDetected: updatedSettings.usdt_balance_detected,
                safetyControlsCompleted: updatedSettings.safety_controls_completed,
                exchangesConnected: JSON.parse(updatedSettings.exchanges_connected || '[]'),
                autoTradingReadinessPercent: updatedSettings.auto_trading_readiness_percent,
                lastTradingActivity: updatedSettings.last_trading_activity
            }
        },
        message: 'Trading settings updated successfully'
    });
}));

// POST /api/v1/user/record-trade - Record a completed trade
router.post('/record-trade', [
    body('exchangePair').notEmpty().withMessage('Exchange pair is required'),
    body('asset').notEmpty().withMessage('Asset is required'),
    body('buyExchange').notEmpty().withMessage('Buy exchange is required'),
    body('sellExchange').notEmpty().withMessage('Sell exchange is required'),
    body('buyPrice').isFloat({ min: 0 }).withMessage('Buy price must be a positive number'),
    body('sellPrice').isFloat({ min: 0 }).withMessage('Sell price must be a positive number'),
    body('amount').isFloat({ min: 0 }).withMessage('Amount must be a positive number'),
    body('profit').isFloat().withMessage('Profit must be a number'),
    body('successful').isBoolean().withMessage('Successful must be boolean')
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
        successful
    } = req.body;
    
    await transaction(async (client) => {
        // Update trading activity stats
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
        
        // Log user activity with trade details
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
                successful
            }, req.ip, req.get('User-Agent')]
        );
        
        systemLogger.trading('Trade recorded', {
            userId: req.user.id,
            asset,
            profit,
            successful,
            totalTrades: stats.total_trades_count
        });
        
        res.json({
            success: true,
            data: {
                tradeStats: {
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

// DELETE /api/v1/user/account - Delete user account (soft delete)
router.delete('/account', asyncHandler(async (req, res) => {
    await transaction(async (client) => {
        // Soft delete user account
        await client.query(
            'UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['deleted', req.user.id]
        );
        
        // Log account deletion
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'account_deleted', {}, req.ip, req.get('User-Agent')]
        );
        
        systemLogger.user('User account deleted', {
            userId: req.user.id,
            email: req.user.email,
            ip: req.ip
        });
    });
    
    res.json({
        success: true,
        message: 'Account deleted successfully'
    });
}));

module.exports = router;