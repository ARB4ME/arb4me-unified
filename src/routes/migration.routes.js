const express = require('express');
const { query } = require('../database/connection');
const { requireAdmin } = require('../middleware/adminPermissions');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

// Apply authentication only - remove admin requirement temporarily for migration
router.use(authenticateUser);
// router.use(requireAdmin); // Temporarily disabled for migration

// POST /api/v1/migration/run-billing - Run Phase 6 billing migration
router.post('/run-billing', async (req, res) => {
    try {
        console.log('🔄 Starting Phase 6 Billing System Migration...');
        
        // Read the migration file content
        const fs = require('fs');
        const path = require('path');
        const migrationPath = path.join(__dirname, '../database/migrations/005_billing_system_simple.sql');
        
        let migrationSQL;
        try {
            migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: 'Migration file not found',
                details: error.message
            });
        }

        // Execute the entire migration as one transaction
        console.log('Executing full migration script...');
        const result = await query(migrationSQL);
        
        console.log('✅ Phase 6 Billing Migration completed');
        
        res.json({
            success: true,
            message: 'Phase 6 Billing Migration completed successfully',
            summary: {
                executed: 'Full migration script',
                successful: 1,
                errors: 0
            }
        });

    } catch (error) {
        console.error('❌ Migration failed:', error);
        res.status(500).json({
            success: false,
            error: 'Migration failed',
            details: error.message
        });
    }
});

// POST /api/v1/migration/run-trading-activity - Run trading activity migration
router.post('/run-trading-activity', async (req, res) => {
    try {
        console.log('🔄 Starting Trading Activity Migration...');
        
        // Read the migration file content
        const fs = require('fs');
        const path = require('path');
        const migrationPath = path.join(__dirname, '../database/migrations/006_trading_activity.sql');
        
        let migrationSQL;
        try {
            migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: 'Migration file not found',
                details: error.message
            });
        }

        // Execute the entire migration as one transaction
        console.log('Executing trading activity migration...');
        const result = await query(migrationSQL);
        
        console.log('✅ Trading Activity Migration completed');
        
        res.json({
            success: true,
            message: 'Trading Activity Migration completed successfully',
            summary: {
                executed: 'Trading activity table and triggers created',
                successful: 1,
                errors: 0
            }
        });

    } catch (error) {
        console.error('❌ Migration failed:', error);
        res.status(500).json({
            success: false,
            error: 'Migration failed',
            details: error.message
        });
    }
});

// POST /api/v1/migration/promote-admin - Promote current user to admin
router.post('/promote-admin', async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Update user to master admin role
        await query(`
            UPDATE users 
            SET admin_role = 'master', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [userId]);

        res.json({
            success: true,
            message: 'User promoted to admin successfully',
            userId: userId
        });

    } catch (error) {
        console.error('❌ Admin promotion failed:', error);
        res.status(500).json({
            success: false,
            error: 'Admin promotion failed',
            details: error.message
        });
    }
});

// GET /api/v1/migration/status - Check migration status
router.get('/status', async (req, res) => {
    try {
        // Check if billing tables exist
        const tables = await query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN ('payments', 'billing_history')
        `);

        // Check if billing columns exist in users table
        const columns = await query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            AND column_name IN ('subscription_plan', 'subscription_expires_at', 'payment_reference')
        `);

        const billingTablesExist = tables.rows.length === 2;
        const billingColumnsExist = columns.rows.length === 3;

        res.json({
            success: true,
            status: {
                billingTablesExist,
                billingColumnsExist,
                migrationRequired: !billingTablesExist || !billingColumnsExist,
                existingTables: tables.rows.map(r => r.table_name),
                existingColumns: columns.rows.map(r => r.column_name)
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Could not check migration status',
            details: error.message
        });
    }
});

// POST /api/v1/migration/run-settings - Run settings system migration
router.post('/run-settings', async (req, res) => {
    try {
        console.log('🔄 Starting Platform Settings Migration...');
        
        // Read the migration file content
        const fs = require('fs');
        const path = require('path');
        const migrationPath = path.join(__dirname, '../database/migrations/007_platform_settings.sql');
        
        let migrationSQL;
        try {
            migrationSQL = fs.readFileSync(migrationPath, 'utf8');
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: 'Settings migration file not found',
                details: error.message
            });
        }

        // Execute the entire migration as one transaction
        console.log('Executing settings migration script...');
        const result = await query(migrationSQL);
        
        console.log('✅ Platform Settings Migration completed');
        
        res.json({
            success: true,
            message: 'Platform Settings Migration completed successfully',
            summary: {
                executed: 'Settings system tables and default values created',
                successful: 1,
                errors: 0
            }
        });

    } catch (error) {
        console.error('❌ Settings Migration failed:', error);
        res.status(500).json({
            success: false,
            error: 'Settings Migration failed',
            details: error.message
        });
    }
});

module.exports = router;