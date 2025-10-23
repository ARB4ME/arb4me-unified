// One-time script to initialize Currency Swap tables
// Run this manually after deployment if auto-migration fails

require('dotenv').config();
const { query, connectDatabase } = require('./src/database/connection');

async function initializeTables() {
    try {
        console.log('Connecting to database...');
        await connectDatabase();
        console.log('Connected!');

        // Create asset declarations table
        console.log('\nCreating currency_swap_asset_declarations table...');
        await query(`
            CREATE TABLE IF NOT EXISTS currency_swap_asset_declarations (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,
                funded_assets JSONB NOT NULL DEFAULT '[]',
                initial_balances JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT true,
                last_updated TIMESTAMP DEFAULT NOW(),
                notes TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_user_exchange_declaration UNIQUE(user_id, exchange)
            );
        `);
        console.log('✓ asset_declarations table created');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_user_id ON currency_swap_asset_declarations(user_id);
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_exchange ON currency_swap_asset_declarations(exchange);
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_active ON currency_swap_asset_declarations(is_active);
        `);
        console.log('✓ asset_declarations indexes created');

        // Create balances table
        console.log('\nCreating currency_swap_balances table...');
        await query(`
            CREATE TABLE IF NOT EXISTS currency_swap_balances (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,
                asset VARCHAR(10) NOT NULL,
                available_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
                locked_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
                total_balance DECIMAL(20, 8) GENERATED ALWAYS AS (available_balance + locked_balance) STORED,
                last_synced_at TIMESTAMP DEFAULT NOW(),
                sync_source VARCHAR(20) DEFAULT 'api',
                sync_error TEXT,
                initial_balance DECIMAL(20, 8),
                total_profit DECIMAL(20, 8) DEFAULT 0,
                profit_percent DECIMAL(10, 4) DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_user_exchange_asset UNIQUE(user_id, exchange, asset)
            );
        `);
        console.log('✓ balances table created');

        await query(`
            CREATE INDEX IF NOT EXISTS idx_balances_user_exchange ON currency_swap_balances(user_id, exchange);
            CREATE INDEX IF NOT EXISTS idx_balances_user_asset ON currency_swap_balances(user_id, asset);
            CREATE INDEX IF NOT EXISTS idx_balances_asset ON currency_swap_balances(asset);
            CREATE INDEX IF NOT EXISTS idx_balances_synced ON currency_swap_balances(last_synced_at);
        `);
        console.log('✓ balances indexes created');

        // Enhance currency_swap_settings table
        console.log('\nEnhancing currency_swap_settings table...');
        await query(`
            ALTER TABLE currency_swap_settings
            ADD COLUMN IF NOT EXISTS max_concurrent_trades INTEGER DEFAULT 2 CHECK (max_concurrent_trades >= 1 AND max_concurrent_trades <= 5),
            ADD COLUMN IF NOT EXISTS max_balance_percentage DECIMAL(5,2) DEFAULT 10.0 CHECK (max_balance_percentage > 0 AND max_balance_percentage <= 50),
            ADD COLUMN IF NOT EXISTS scan_interval_seconds INTEGER DEFAULT 60 CHECK (scan_interval_seconds >= 30 AND scan_interval_seconds <= 300),
            ADD COLUMN IF NOT EXISTS balance_check_required BOOLEAN DEFAULT true,
            ADD COLUMN IF NOT EXISTS min_balance_reserve_percent DECIMAL(5,2) DEFAULT 5.0 CHECK (min_balance_reserve_percent >= 0 AND min_balance_reserve_percent <= 20);
        `);
        console.log('✓ settings table enhanced');

        console.log('\n✅ All Currency Swap tables initialized successfully!');
        console.log('\nYou can now use the Currency Swap APIs.');

        process.exit(0);

    } catch (error) {
        console.error('\n❌ Failed to initialize tables:', error.message);
        console.error(error);
        process.exit(1);
    }
}

initializeTables();
