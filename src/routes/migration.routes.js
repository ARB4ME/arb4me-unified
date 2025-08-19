const express = require('express');
const { query } = require('../database/connection');
const { requireMaster } = require('../middleware/adminPermissions');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

// Apply authentication and admin requirements
router.use(authenticateUser);
router.use(requireMaster);

// POST /api/v1/migration/run-billing - Run Phase 6 billing migration
router.post('/run-billing', async (req, res) => {
    try {
        console.log('🔄 Starting Phase 6 Billing System Migration...');
        
        // Read the migration file content
        const fs = require('fs');
        const path = require('path');
        const migrationPath = path.join(__dirname, '../database/migrations/005_billing_system.sql');
        
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

        // Split into individual statements (basic approach)
        const statements = migrationSQL
            .split(';')
            .map(stmt => stmt.trim())
            .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

        const results = [];
        let successCount = 0;
        let errorCount = 0;

        // Execute each statement
        for (let i = 0; i < statements.length; i++) {
            const statement = statements[i];
            if (!statement) continue;

            try {
                console.log(`Executing statement ${i + 1}/${statements.length}`);
                const result = await query(statement);
                results.push({
                    statement: i + 1,
                    success: true,
                    rowCount: result.rowCount || 0
                });
                successCount++;
            } catch (error) {
                console.error(`Error in statement ${i + 1}:`, error.message);
                results.push({
                    statement: i + 1,
                    success: false,
                    error: error.message,
                    sql: statement.substring(0, 100) + '...'
                });
                errorCount++;
                
                // Don't stop on errors for CREATE IF NOT EXISTS statements
                if (!statement.toUpperCase().includes('IF NOT EXISTS')) {
                    throw error;
                }
            }
        }

        console.log('✅ Phase 6 Billing Migration completed');
        
        res.json({
            success: true,
            message: 'Phase 6 Billing Migration completed',
            summary: {
                totalStatements: statements.length,
                successful: successCount,
                errors: errorCount
            },
            results: results
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

module.exports = router;