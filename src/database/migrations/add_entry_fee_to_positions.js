// Migration: Add entry_fee column to momentum_positions
// Adds entry_fee column to properly track and calculate P&L with fees

const { query } = require('../connection');
const { logger } = require('../../utils/logger');

async function up() {
    try {
        logger.info('Adding entry_fee column to momentum_positions table...');

        // Check if column already exists
        const checkColumnQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'momentum_positions'
            AND column_name = 'entry_fee'
        `;

        const checkResult = await query(checkColumnQuery);

        if (checkResult.rows.length > 0) {
            logger.info('✓ entry_fee column already exists');
            return true;
        }

        // Add entry_fee column
        const addColumnQuery = `
            ALTER TABLE momentum_positions
            ADD COLUMN entry_fee DECIMAL(12,4) DEFAULT 0
        `;

        await query(addColumnQuery);
        logger.info('✓ entry_fee column added successfully');

        // Update existing rows to estimate fees based on entry_value_usdt
        // Use conservative 0.1% estimate for existing positions
        const updateExistingQuery = `
            UPDATE momentum_positions
            SET entry_fee = entry_value_usdt * 0.001
            WHERE entry_fee IS NULL OR entry_fee = 0
        `;

        const updateResult = await query(updateExistingQuery);
        logger.info(`✓ Updated ${updateResult.rowCount} existing positions with estimated fees`);

        logger.info('Migration completed successfully');
        return true;
    } catch (error) {
        logger.error('Failed to add entry_fee column:', error);
        throw error;
    }
}

async function down() {
    try {
        logger.info('Removing entry_fee column from momentum_positions table...');

        const dropColumnQuery = `
            ALTER TABLE momentum_positions
            DROP COLUMN IF EXISTS entry_fee
        `;

        await query(dropColumnQuery);
        logger.info('✓ entry_fee column removed successfully');

        logger.info('Migration rollback completed successfully');
        return true;
    } catch (error) {
        logger.error('Failed to remove entry_fee column:', error);
        throw error;
    }
}

module.exports = { up, down };
