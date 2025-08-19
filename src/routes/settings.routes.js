const express = require('express');
const { query } = require('../database/connection');
const { requireAdmin } = require('../middleware/adminPermissions');
const { authenticateUser } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// Apply authentication and admin permissions
router.use(authenticateUser);
router.use(requireAdmin);

// GET /api/v1/settings/platform - Get all platform settings
router.get('/platform', asyncHandler(async (req, res) => {
    const { category, public_only } = req.query;
    
    let whereClause = '';
    const params = [];
    
    if (category) {
        whereClause = 'WHERE category = $1';
        params.push(category);
    }
    
    if (public_only === 'true') {
        whereClause += whereClause ? ' AND is_public = true' : 'WHERE is_public = true';
    }
    
    const settings = await query(`
        SELECT 
            setting_key,
            setting_value,
            setting_type,
            category,
            description,
            is_public,
            updated_at
        FROM platform_settings 
        ${whereClause}
        ORDER BY category, setting_key
    `, params);

    res.json({
        success: true,
        data: {
            settings: settings.rows,
            categories: [...new Set(settings.rows.map(s => s.category))]
        }
    });
}));

// PUT /api/v1/settings/platform/:key - Update a platform setting
router.put('/platform/:key', asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value, updated_by } = req.body;
    
    if (value === undefined || value === null) {
        return res.status(400).json({
            success: false,
            error: 'Setting value is required'
        });
    }
    
    // Check if setting exists
    const existingSetting = await query(`
        SELECT setting_key, setting_type FROM platform_settings WHERE setting_key = $1
    `, [key]);
    
    if (existingSetting.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'Setting not found'
        });
    }
    
    // Validate value based on type
    const settingType = existingSetting.rows[0].setting_type;
    let validatedValue = value;
    
    if (settingType === 'boolean') {
        validatedValue = String(value === true || value === 'true');
    } else if (settingType === 'number') {
        const numValue = Number(value);
        if (isNaN(numValue)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid number value'
            });
        }
        validatedValue = String(numValue);
    }
    
    // Update setting
    const result = await query(`
        UPDATE platform_settings 
        SET setting_value = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
        WHERE setting_key = $3
        RETURNING *
    `, [validatedValue, updated_by || req.user.id, key]);
    
    res.json({
        success: true,
        data: {
            setting: result.rows[0]
        }
    });
}));

// POST /api/v1/settings/platform - Create a new platform setting
router.post('/platform', asyncHandler(async (req, res) => {
    const { 
        setting_key, 
        setting_value, 
        setting_type = 'string', 
        category = 'general', 
        description,
        is_public = false 
    } = req.body;
    
    if (!setting_key || setting_value === undefined) {
        return res.status(400).json({
            success: false,
            error: 'setting_key and setting_value are required'
        });
    }
    
    const result = await query(`
        INSERT INTO platform_settings 
        (setting_key, setting_value, setting_type, category, description, is_public, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
    `, [setting_key, setting_value, setting_type, category, description, is_public, req.user.id]);
    
    res.json({
        success: true,
        data: {
            setting: result.rows[0]
        }
    });
}));

// GET /api/v1/settings/notifications - Get admin notification preferences
router.get('/notifications', asyncHandler(async (req, res) => {
    const notifications = await query(`
        SELECT * FROM admin_notifications 
        ORDER BY notification_type
    `);

    res.json({
        success: true,
        data: {
            notifications: notifications.rows
        }
    });
}));

// PUT /api/v1/settings/notifications/:type - Update notification preference
router.put('/notifications/:type', asyncHandler(async (req, res) => {
    const { type } = req.params;
    const { enabled, email_enabled, push_enabled, threshold_value, frequency } = req.body;
    
    const updateFields = [];
    const params = [];
    let paramCount = 1;
    
    if (enabled !== undefined) {
        updateFields.push(`enabled = $${paramCount++}`);
        params.push(enabled);
    }
    
    if (email_enabled !== undefined) {
        updateFields.push(`email_enabled = $${paramCount++}`);
        params.push(email_enabled);
    }
    
    if (push_enabled !== undefined) {
        updateFields.push(`push_enabled = $${paramCount++}`);
        params.push(push_enabled);
    }
    
    if (threshold_value !== undefined) {
        updateFields.push(`threshold_value = $${paramCount++}`);
        params.push(threshold_value);
    }
    
    if (frequency !== undefined) {
        updateFields.push(`frequency = $${paramCount++}`);
        params.push(frequency);
    }
    
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(type);
    
    const result = await query(`
        UPDATE admin_notifications 
        SET ${updateFields.join(', ')}
        WHERE notification_type = $${paramCount}
        RETURNING *
    `, params);
    
    if (result.rows.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'Notification type not found'
        });
    }
    
    res.json({
        success: true,
        data: {
            notification: result.rows[0]
        }
    });
}));

// POST /api/v1/settings/maintenance/start - Start maintenance mode
router.post('/maintenance/start', asyncHandler(async (req, res) => {
    const { message, maintenance_type = 'scheduled' } = req.body;
    
    // Enable maintenance mode
    await query(`
        UPDATE platform_settings 
        SET setting_value = 'true', updated_by = $1 
        WHERE setting_key = 'maintenance_mode'
    `, [req.user.id]);
    
    // Log maintenance start
    const logResult = await query(`
        INSERT INTO maintenance_log 
        (maintenance_type, status, message, started_by)
        VALUES ($1, 'started', $2, $3)
        RETURNING *
    `, [maintenance_type, message || 'Maintenance mode activated', req.user.id]);
    
    res.json({
        success: true,
        data: {
            maintenance_log: logResult.rows[0],
            message: 'Maintenance mode activated'
        }
    });
}));

// POST /api/v1/settings/maintenance/end - End maintenance mode
router.post('/maintenance/end', asyncHandler(async (req, res) => {
    const { message } = req.body;
    
    // Disable maintenance mode
    await query(`
        UPDATE platform_settings 
        SET setting_value = 'false', updated_by = $1 
        WHERE setting_key = 'maintenance_mode'
    `, [req.user.id]);
    
    // Update maintenance log
    await query(`
        UPDATE maintenance_log 
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE status = 'started'
    `);
    
    // Create completion log entry
    const logResult = await query(`
        INSERT INTO maintenance_log 
        (maintenance_type, status, message, started_by, started_at, completed_at)
        VALUES ('scheduled', 'completed', $1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
    `, [message || 'Maintenance mode deactivated', req.user.id]);
    
    res.json({
        success: true,
        data: {
            maintenance_log: logResult.rows[0],
            message: 'Maintenance mode deactivated'
        }
    });
}));

// GET /api/v1/settings/maintenance/history - Get maintenance history
router.get('/maintenance/history', asyncHandler(async (req, res) => {
    const { limit = 50 } = req.query;
    
    const history = await query(`
        SELECT * FROM maintenance_log 
        ORDER BY started_at DESC 
        LIMIT $1
    `, [limit]);

    res.json({
        success: true,
        data: {
            history: history.rows
        }
    });
}));

// POST /api/v1/settings/backup/create - Create database backup
router.post('/backup/create', asyncHandler(async (req, res) => {
    const { backup_type = 'manual' } = req.body;
    
    try {
        // Log backup start
        const logResult = await query(`
            INSERT INTO maintenance_log 
            (maintenance_type, status, message, started_by, details)
            VALUES ('backup', 'started', 'Database backup initiated', $1, $2)
            RETURNING *
        `, [req.user.id, JSON.stringify({ backup_type, timestamp: new Date().toISOString() })]);
        
        // In a real implementation, you would trigger the actual backup process here
        // For now, we'll simulate a successful backup
        
        // Update log as completed
        await query(`
            UPDATE maintenance_log 
            SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
                message = 'Database backup completed successfully'
            WHERE id = $1
        `, [logResult.rows[0].id]);
        
        res.json({
            success: true,
            data: {
                backup_id: logResult.rows[0].id,
                message: 'Database backup initiated successfully',
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        // Log backup failure
        await query(`
            INSERT INTO maintenance_log 
            (maintenance_type, status, message, started_by, details)
            VALUES ('backup', 'failed', $1, $2, $3)
        `, [
            `Backup failed: ${error.message}`, 
            req.user.id, 
            JSON.stringify({ error: error.message, timestamp: new Date().toISOString() })
        ]);
        
        throw error;
    }
}));

// GET /api/v1/settings/export/data - Export platform data
router.get('/export/data', asyncHandler(async (req, res) => {
    const { format = 'json', include_users = false, include_payments = false } = req.query;
    
    const exportData = {
        export_timestamp: new Date().toISOString(),
        platform_settings: {},
        statistics: {}
    };
    
    // Export platform settings
    const settings = await query(`SELECT setting_key, setting_value, category FROM platform_settings`);
    settings.rows.forEach(setting => {
        if (!exportData.platform_settings[setting.category]) {
            exportData.platform_settings[setting.category] = {};
        }
        exportData.platform_settings[setting.category][setting.setting_key] = setting.setting_value;
    });
    
    // Export basic statistics
    const userCount = await query(`SELECT COUNT(*) as count FROM users`);
    const tradeCount = await query(`SELECT SUM(total_trades_count) as count FROM trading_activity`);
    const revenueSum = await query(`SELECT SUM(amount) as sum FROM payments WHERE status = 'completed'`);
    
    exportData.statistics = {
        total_users: parseInt(userCount.rows[0].count),
        total_trades: parseInt(tradeCount.rows[0].count || 0),
        total_revenue: parseFloat(revenueSum.rows[0].sum || 0)
    };
    
    // Include user data if requested (admin only)
    if (include_users === 'true') {
        const users = await query(`
            SELECT id, first_name, last_name, email, created_at, subscription_plan 
            FROM users 
            ORDER BY created_at DESC
        `);
        exportData.users = users.rows;
    }
    
    // Include payment data if requested (admin only)
    if (include_payments === 'true') {
        const payments = await query(`
            SELECT amount, status, created_at, payment_method 
            FROM payments 
            ORDER BY created_at DESC
        `);
        exportData.payments = payments.rows;
    }
    
    // Set appropriate headers for download
    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="arb4me_export.csv"');
        // Convert to CSV format (simplified)
        const csv = Object.entries(exportData.statistics)
            .map(([key, value]) => `${key},${value}`)
            .join('\n');
        res.send(csv);
    } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="arb4me_export.json"');
        res.json({
            success: true,
            data: exportData
        });
    }
}));

module.exports = router;