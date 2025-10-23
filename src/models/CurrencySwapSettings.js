// Currency Swap Settings Model
// Stores user-specific currency swap strategy settings

const { query } = require('../database/connection');

/**
 * Database Schema:
 *
 * CREATE TABLE IF NOT EXISTS currency_swap_settings (
 *   id SERIAL PRIMARY KEY,
 *   user_id INTEGER UNIQUE REFERENCES users(id),
 *   strategy VARCHAR(50) DEFAULT 'currency-swap',
 *
 *   -- Risk Settings
 *   auto_trading_enabled BOOLEAN DEFAULT false,
 *   threshold_percent DECIMAL(5, 2) DEFAULT 0.5 CHECK (threshold_percent >= 0.1 AND threshold_percent <= 10),
 *   max_trade_amount_usdt DECIMAL(20, 2) DEFAULT 5000 CHECK (max_trade_amount_usdt >= 100 AND max_trade_amount_usdt <= 100000),
 *   max_daily_swaps INTEGER DEFAULT 10 CHECK (max_daily_swaps >= 1 AND max_daily_swaps <= 100),
 *
 *   -- Bridge Preferences
 *   preferred_bridge VARCHAR(10) DEFAULT 'AUTO' CHECK (preferred_bridge IN ('XRP', 'USDT', 'AUTO')),
 *
 *   -- Categories (stored as JSONB)
 *   enabled_categories JSONB DEFAULT '{"ZAR": true, "INTERNATIONAL": false}',
 *
 *   -- Allowed Fiat Pairs
 *   allowed_pairs TEXT[] DEFAULT ARRAY['ZAR-USDT', 'ZAR-USD'],
 *
 *   -- Exchange Preferences (stored as JSONB)
 *   exchange_preferences JSONB DEFAULT '{"ZAR": ["VALR", "Luno", "ChainEX"], "USD": ["Kraken", "Bybit", "OKX"], "EUR": ["Kraken", "Gate", "OKX"], "GBP": ["Kraken", "Gate", "OKX"]}',
 *
 *   -- Separate Credentials
 *   use_separate_credentials BOOLEAN DEFAULT false,
 *
 *   -- Timestamps
 *   created_at TIMESTAMP DEFAULT NOW(),
 *   updated_at TIMESTAMP DEFAULT NOW()
 * );
 *
 * CREATE INDEX IF NOT EXISTS idx_currency_swap_settings_user_id ON currency_swap_settings(user_id);
 */

class CurrencySwapSettings {
    /**
     * Create currency_swap_settings table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS currency_swap_settings (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE,
                strategy VARCHAR(50) DEFAULT 'currency-swap',

                -- Risk Settings
                auto_trading_enabled BOOLEAN DEFAULT false,
                threshold_percent DECIMAL(5, 2) DEFAULT 0.5 CHECK (threshold_percent >= 0.1 AND threshold_percent <= 10),
                max_trade_amount_usdt DECIMAL(20, 2) DEFAULT 5000 CHECK (max_trade_amount_usdt >= 100 AND max_trade_amount_usdt <= 100000),
                max_daily_swaps INTEGER DEFAULT 10 CHECK (max_daily_swaps >= 1 AND max_daily_swaps <= 100),

                -- Bridge Preferences
                preferred_bridge VARCHAR(10) DEFAULT 'AUTO' CHECK (preferred_bridge IN ('XRP', 'USDT', 'AUTO')),

                -- Categories
                enabled_categories JSONB DEFAULT '{"ZAR": true, "INTERNATIONAL": false}',

                -- Allowed Fiat Pairs
                allowed_pairs TEXT[] DEFAULT ARRAY['ZAR-USDT', 'ZAR-USD'],

                -- Exchange Preferences
                exchange_preferences JSONB DEFAULT '{"ZAR": ["VALR", "Luno", "ChainEX"], "USD": ["Kraken", "Bybit", "OKX"], "EUR": ["Kraken", "Gate", "OKX"], "GBP": ["Kraken", "Gate", "OKX"]}',

                -- Separate Credentials
                use_separate_credentials BOOLEAN DEFAULT false,

                -- Timestamps
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_currency_swap_settings_user_id ON currency_swap_settings(user_id);

            -- Add new columns if they don't exist (for existing installations)
            ALTER TABLE currency_swap_settings
            ADD COLUMN IF NOT EXISTS max_concurrent_trades INTEGER DEFAULT 2 CHECK (max_concurrent_trades >= 1 AND max_concurrent_trades <= 5),
            ADD COLUMN IF NOT EXISTS max_balance_percentage DECIMAL(5,2) DEFAULT 10.0 CHECK (max_balance_percentage > 0 AND max_balance_percentage <= 50),
            ADD COLUMN IF NOT EXISTS scan_interval_seconds INTEGER DEFAULT 60 CHECK (scan_interval_seconds >= 30 AND scan_interval_seconds <= 300),
            ADD COLUMN IF NOT EXISTS balance_check_required BOOLEAN DEFAULT true,
            ADD COLUMN IF NOT EXISTS min_balance_reserve_percent DECIMAL(5,2) DEFAULT 5.0 CHECK (min_balance_reserve_percent >= 0 AND min_balance_reserve_percent <= 20),
            ADD COLUMN IF NOT EXISTS selected_exchanges JSONB DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS selected_currencies JSONB DEFAULT '[]';
        `;

        await query(createTableQuery);
    }

    /**
     * Get or create settings for user (with defaults)
     */
    static async getOrCreate(userId) {
        // Try to find existing settings
        let result = await query('SELECT * FROM currency_swap_settings WHERE user_id = $1', [userId]);

        if (result.rows.length > 0) {
            return result.rows[0];
        }

        // Create default settings
        const insertQuery = `
            INSERT INTO currency_swap_settings (user_id)
            VALUES ($1)
            RETURNING *
        `;

        result = await query(insertQuery, [userId]);
        return result.rows[0];
    }

    /**
     * Update settings
     */
    static async update(userId, settings) {
        const {
            autoTradingEnabled,
            thresholdPercent,
            maxTradeAmountUSDT,
            maxDailySwaps,
            preferredBridge,
            enabledCategories,
            allowedPairs,
            exchangePreferences,
            useSeparateCredentials,
            selectedExchanges,
            selectedCurrencies
        } = settings;

        const updateQuery = `
            UPDATE currency_swap_settings
            SET auto_trading_enabled = COALESCE($1, auto_trading_enabled),
                threshold_percent = COALESCE($2, threshold_percent),
                max_trade_amount_usdt = COALESCE($3, max_trade_amount_usdt),
                max_daily_swaps = COALESCE($4, max_daily_swaps),
                preferred_bridge = COALESCE($5, preferred_bridge),
                enabled_categories = COALESCE($6, enabled_categories),
                allowed_pairs = COALESCE($7, allowed_pairs),
                exchange_preferences = COALESCE($8, exchange_preferences),
                use_separate_credentials = COALESCE($9, use_separate_credentials),
                selected_exchanges = COALESCE($10, selected_exchanges),
                selected_currencies = COALESCE($11, selected_currencies),
                updated_at = NOW()
            WHERE user_id = $12
            RETURNING *
        `;

        const values = [
            autoTradingEnabled,
            thresholdPercent,
            maxTradeAmountUSDT,
            maxDailySwaps,
            preferredBridge,
            enabledCategories ? JSON.stringify(enabledCategories) : null,
            allowedPairs,
            exchangePreferences ? JSON.stringify(exchangePreferences) : null,
            useSeparateCredentials,
            selectedExchanges ? JSON.stringify(selectedExchanges) : null,
            selectedCurrencies ? JSON.stringify(selectedCurrencies) : null,
            userId
        ];

        const result = await query(updateQuery, values);

        // If no rows updated, settings don't exist - create them
        if (result.rows.length === 0) {
            return await this.create(userId, settings);
        }

        return result.rows[0];
    }

    /**
     * Create settings with custom values
     */
    static async create(userId, settings = {}) {
        const {
            autoTradingEnabled = false,
            thresholdPercent = 0.5,
            maxTradeAmountUSDT = 5000,
            maxDailySwaps = 10,
            preferredBridge = 'AUTO',
            enabledCategories = { ZAR: true, INTERNATIONAL: false },
            allowedPairs = ['ZAR-USDT', 'ZAR-USD'],
            exchangePreferences = {
                ZAR: ['VALR', 'Luno', 'ChainEX'],
                USD: ['Kraken', 'Bybit', 'OKX'],
                EUR: ['Kraken', 'Gate', 'OKX'],
                GBP: ['Kraken', 'Gate', 'OKX']
            },
            useSeparateCredentials = false
        } = settings;

        const insertQuery = `
            INSERT INTO currency_swap_settings (
                user_id, auto_trading_enabled, threshold_percent,
                max_trade_amount_usdt, max_daily_swaps, preferred_bridge,
                enabled_categories, allowed_pairs, exchange_preferences,
                use_separate_credentials
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (user_id) DO UPDATE SET
                auto_trading_enabled = EXCLUDED.auto_trading_enabled,
                threshold_percent = EXCLUDED.threshold_percent,
                max_trade_amount_usdt = EXCLUDED.max_trade_amount_usdt,
                max_daily_swaps = EXCLUDED.max_daily_swaps,
                preferred_bridge = EXCLUDED.preferred_bridge,
                enabled_categories = EXCLUDED.enabled_categories,
                allowed_pairs = EXCLUDED.allowed_pairs,
                exchange_preferences = EXCLUDED.exchange_preferences,
                use_separate_credentials = EXCLUDED.use_separate_credentials,
                updated_at = NOW()
            RETURNING *
        `;

        const values = [
            userId,
            autoTradingEnabled,
            thresholdPercent,
            maxTradeAmountUSDT,
            maxDailySwaps,
            preferredBridge,
            JSON.stringify(enabledCategories),
            allowedPairs,
            JSON.stringify(exchangePreferences),
            useSeparateCredentials
        ];

        const result = await query(insertQuery, values);
        return result.rows[0];
    }

    /**
     * Toggle auto-trading
     */
    static async toggleAutoTrading(userId, enabled) {
        const updateQuery = `
            UPDATE currency_swap_settings
            SET auto_trading_enabled = $1,
                updated_at = NOW()
            WHERE user_id = $2
            RETURNING *
        `;

        const result = await query(updateQuery, [enabled, userId]);
        return result.rows[0];
    }

    /**
     * Get daily swap count
     */
    static async getDailySwapCount(userId) {
        const countQuery = `
            SELECT COUNT(*) as count
            FROM currency_swaps
            WHERE user_id = $1
            AND created_at >= CURRENT_DATE
            AND status IN ('completed', 'executing')
        `;

        const result = await query(countQuery, [userId]);
        return parseInt(result.rows[0].count);
    }

    /**
     * Check if user can execute more swaps today
     */
    static async canExecuteSwap(userId) {
        const settings = await this.getOrCreate(userId);
        const dailyCount = await this.getDailySwapCount(userId);

        return {
            canExecute: dailyCount < settings.max_daily_swaps,
            dailyCount: dailyCount,
            maxDaily: settings.max_daily_swaps,
            remaining: settings.max_daily_swaps - dailyCount
        };
    }

    /**
     * Delete settings (cleanup)
     */
    static async delete(userId) {
        const deleteQuery = 'DELETE FROM currency_swap_settings WHERE user_id = $1 RETURNING *';
        const result = await query(deleteQuery, [userId]);
        return result.rows[0];
    }
}

module.exports = CurrencySwapSettings;
