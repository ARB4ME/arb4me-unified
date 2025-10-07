// Migration: Create Currency Swap Tables
// Run this to set up currency swap database tables

const CurrencySwap = require('../../models/CurrencySwap');
const CurrencySwapSettings = require('../../models/CurrencySwapSettings');
const { logger } = require('../../utils/logger');

async function up() {
    try {
        logger.info('Creating currency swap tables...');

        // Create currency_swaps table
        await CurrencySwap.createTable();
        logger.info('✓ currency_swaps table created');

        // Create currency_swap_settings table
        await CurrencySwapSettings.createTable();
        logger.info('✓ currency_swap_settings table created');

        logger.info('Currency swap tables created successfully');
        return true;
    } catch (error) {
        logger.error('Failed to create currency swap tables:', error);
        throw error;
    }
}

async function down() {
    try {
        logger.info('Dropping currency swap tables...');

        const { query } = require('../connection');

        // Drop tables in reverse order (to handle foreign key constraints)
        await query('DROP TABLE IF EXISTS currency_swap_settings CASCADE');
        logger.info('✓ currency_swap_settings table dropped');

        await query('DROP TABLE IF EXISTS currency_swaps CASCADE');
        logger.info('✓ currency_swaps table dropped');

        logger.info('Currency swap tables dropped successfully');
        return true;
    } catch (error) {
        logger.error('Failed to drop currency swap tables:', error);
        throw error;
    }
}

module.exports = { up, down };
