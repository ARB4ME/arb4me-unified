const express = require('express');
const { query } = require('../database/connection');
const { authenticateUser } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// Apply authentication to all routes
router.use(authenticateUser);

// POST /api/v1/trading-activity/update - Update user's trading activity status
router.post('/update', asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
        exchangesConnected,
        selectedCryptoAssets,
        apiKeysConfigured,
        tradingActive,
        autoTradingEnabled,
        safetyControlsCompleted,
        usdtBalanceDetected
    } = req.body;

    // Calculate readiness percentage
    let readinessPercent = 0;
    if (apiKeysConfigured) readinessPercent += 25;
    if (selectedCryptoAssets && selectedCryptoAssets.length > 0) readinessPercent += 25;
    if (safetyControlsCompleted) readinessPercent += 25;
    if (usdtBalanceDetected) readinessPercent += 25;

    // Update trading activity
    const result = await query(`
        INSERT INTO trading_activity (
            user_id,
            exchanges_connected,
            exchanges_connected_count,
            selected_crypto_assets,
            api_keys_configured,
            trading_active,
            auto_trading_enabled,
            safety_controls_completed,
            usdt_balance_detected,
            auto_trading_readiness_percent,
            last_trading_activity,
            updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET
            exchanges_connected = EXCLUDED.exchanges_connected,
            exchanges_connected_count = EXCLUDED.exchanges_connected_count,
            selected_crypto_assets = EXCLUDED.selected_crypto_assets,
            api_keys_configured = EXCLUDED.api_keys_configured,
            trading_active = EXCLUDED.trading_active,
            auto_trading_enabled = EXCLUDED.auto_trading_enabled,
            safety_controls_completed = EXCLUDED.safety_controls_completed,
            usdt_balance_detected = EXCLUDED.usdt_balance_detected,
            auto_trading_readiness_percent = EXCLUDED.auto_trading_readiness_percent,
            last_trading_activity = EXCLUDED.last_trading_activity,
            updated_at = CURRENT_TIMESTAMP
        RETURNING *
    `, [
        userId,
        JSON.stringify(exchangesConnected || []),
        exchangesConnected ? exchangesConnected.length : 0,
        JSON.stringify(selectedCryptoAssets || []),
        apiKeysConfigured || false,
        tradingActive || false,
        autoTradingEnabled || false,
        safetyControlsCompleted || false,
        usdtBalanceDetected || false,
        readinessPercent,
        tradingActive ? new Date() : null
    ]);

    res.json({
        success: true,
        data: {
            readinessPercent,
            tradingActivity: result.rows[0]
        }
    });
}));

// POST /api/v1/trading-activity/trade-completed - Record completed trade (summary only)
router.post('/trade-completed', asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { success, profit } = req.body;

    // Update trade counts and profit
    const updateQuery = success
        ? `UPDATE trading_activity 
           SET successful_trades_count = successful_trades_count + 1,
               total_trades_count = total_trades_count + 1,
               profit_loss_total = profit_loss_total + $2,
               last_trading_activity = CURRENT_TIMESTAMP
           WHERE user_id = $1`
        : `UPDATE trading_activity 
           SET failed_trades_count = failed_trades_count + 1,
               total_trades_count = total_trades_count + 1,
               last_trading_activity = CURRENT_TIMESTAMP
           WHERE user_id = $1`;

    await query(updateQuery, success ? [userId, profit || 0] : [userId]);

    res.json({
        success: true,
        message: 'Trade activity recorded'
    });
}));

// GET /api/v1/trading-activity/status - Get user's trading readiness status
router.get('/status', asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const result = await query(`
        SELECT * FROM trading_activity WHERE user_id = $1
    `, [userId]);

    if (result.rows.length === 0) {
        // Create default record
        await query(`
            INSERT INTO trading_activity (user_id) VALUES ($1)
        `, [userId]);
        
        res.json({
            success: true,
            data: {
                readinessPercent: 0,
                tradingActive: false,
                apiKeysConfigured: false,
                selectedCryptoAssets: [],
                exchangesConnected: []
            }
        });
    } else {
        const activity = result.rows[0];
        res.json({
            success: true,
            data: {
                readinessPercent: activity.auto_trading_readiness_percent,
                tradingActive: activity.trading_active,
                apiKeysConfigured: activity.api_keys_configured,
                selectedCryptoAssets: JSON.parse(activity.selected_crypto_assets || '[]'),
                exchangesConnected: JSON.parse(activity.exchanges_connected || '[]'),
                totalTrades: activity.total_trades_count,
                successfulTrades: activity.successful_trades_count,
                profitTotal: activity.profit_loss_total
            }
        });
    }
}));

module.exports = router;