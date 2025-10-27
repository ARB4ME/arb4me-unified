// Migration: Create Momentum Trading Tables
// Run this to set up momentum trading database tables

const MomentumStrategy = require('../../models/MomentumStrategy');
const MomentumPosition = require('../../models/MomentumPosition');
const { logger } = require('../../utils/logger');

async function up() {
    try {
        logger.info('Creating momentum trading tables...');

        // Create momentum_strategies table
        await MomentumStrategy.createTable();
        logger.info('✓ momentum_strategies table created');

        // Create momentum_positions table
        await MomentumPosition.createTable();
        logger.info('✓ momentum_positions table created');

        logger.info('Momentum trading tables created successfully');
        return true;
    } catch (error) {
        logger.error('Failed to create momentum trading tables:', error);
        throw error;
    }
}

async function down() {
    try {
        logger.info('Dropping momentum trading tables...');

        const { query } = require('../connection');

        // Drop tables in reverse order (to handle foreign key constraints)
        await query('DROP TABLE IF EXISTS momentum_positions CASCADE');
        logger.info('✓ momentum_positions table dropped');

        await query('DROP TABLE IF EXISTS momentum_strategies CASCADE');
        logger.info('✓ momentum_strategies table dropped');

        logger.info('Momentum trading tables dropped successfully');
        return true;
    } catch (error) {
        logger.error('Failed to drop momentum trading tables:', error);
        throw error;
    }
}

module.exports = { up, down };
