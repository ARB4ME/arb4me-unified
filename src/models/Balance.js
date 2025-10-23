// Balance Model
// Real-time balance tracking for currency swap risk management

const { query } = require('../database/connection');
const { systemLogger } = require('../utils/logger');

class Balance {
    /**
     * Create balances table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS currency_swap_balances (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,
                asset VARCHAR(10) NOT NULL,

                -- Balance amounts (in asset's native units)
                available_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
                locked_balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
                total_balance DECIMAL(20, 8) GENERATED ALWAYS AS (available_balance + locked_balance) STORED,

                -- Sync tracking
                last_synced_at TIMESTAMP DEFAULT NOW(),
                sync_source VARCHAR(20) DEFAULT 'api', -- 'api', 'manual', 'calculated'
                sync_error TEXT,

                -- Profit tracking
                initial_balance DECIMAL(20, 8),
                total_profit DECIMAL(20, 8) DEFAULT 0,
                profit_percent DECIMAL(10, 4) DEFAULT 0,

                -- Timestamps
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),

                -- One balance record per user per exchange per asset
                CONSTRAINT unique_user_exchange_asset UNIQUE(user_id, exchange, asset)
            );

            CREATE INDEX IF NOT EXISTS idx_balances_user_exchange ON currency_swap_balances(user_id, exchange);
            CREATE INDEX IF NOT EXISTS idx_balances_user_asset ON currency_swap_balances(user_id, asset);
            CREATE INDEX IF NOT EXISTS idx_balances_asset ON currency_swap_balances(asset);
            CREATE INDEX IF NOT EXISTS idx_balances_synced ON currency_swap_balances(last_synced_at);
        `;

        await query(createTableQuery);
        systemLogger.info('Currency swap balances table verified/created');
    }

    /**
     * Update balance for user/exchange/asset
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     * @param {string} asset - Asset code (ZAR, USDT, USD, etc.)
     * @param {number} availableBalance - Available balance
     * @param {number} lockedBalance - Locked balance (in orders)
     * @param {string} syncSource - How was this synced? ('api', 'manual', 'calculated')
     */
    static async updateBalance(userId, exchange, asset, availableBalance, lockedBalance = 0, syncSource = 'api') {
        const upsertQuery = `
            INSERT INTO currency_swap_balances (
                user_id, exchange, asset, available_balance, locked_balance,
                last_synced_at, sync_source, sync_error
            )
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, NULL)
            ON CONFLICT (user_id, exchange, asset) DO UPDATE SET
                available_balance = EXCLUDED.available_balance,
                locked_balance = EXCLUDED.locked_balance,
                last_synced_at = NOW(),
                sync_source = EXCLUDED.sync_source,
                sync_error = NULL,
                updated_at = NOW()
            RETURNING *
        `;

        const values = [userId, exchange, asset, availableBalance, lockedBalance, syncSource];
        const result = await query(upsertQuery, values);
        return this._mapRow(result.rows[0]);
    }

    /**
     * Get balance for specific user/exchange/asset
     */
    static async getBalance(userId, exchange, asset) {
        const selectQuery = `
            SELECT * FROM currency_swap_balances
            WHERE user_id = $1 AND exchange = $2 AND asset = $3
        `;

        const result = await query(selectQuery, [userId, exchange, asset]);
        return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
    }

    /**
     * Get all balances for a user on a specific exchange
     */
    static async getExchangeBalances(userId, exchange) {
        const selectQuery = `
            SELECT * FROM currency_swap_balances
            WHERE user_id = $1 AND exchange = $2
            ORDER BY asset
        `;

        const result = await query(selectQuery, [userId, exchange]);
        return result.rows.map(row => this._mapRow(row));
    }

    /**
     * Get all balances for a user across all exchanges
     */
    static async getUserBalances(userId) {
        const selectQuery = `
            SELECT * FROM currency_swap_balances
            WHERE user_id = $1
            ORDER BY exchange, asset
        `;

        const result = await query(selectQuery, [userId]);
        return result.rows.map(row => this._mapRow(row));
    }

    /**
     * Get balances for specific asset across all exchanges
     * Useful for seeing total ZAR or USDT exposure
     */
    static async getAssetBalances(userId, asset) {
        const selectQuery = `
            SELECT * FROM currency_swap_balances
            WHERE user_id = $1 AND asset = $2
            ORDER BY exchange
        `;

        const result = await query(selectQuery, [userId, asset]);
        return result.rows.map(row => this._mapRow(row));
    }

    /**
     * Set initial balance (for profit tracking)
     * Should be called when user first declares funded assets
     */
    static async setInitialBalance(userId, exchange, asset, initialBalance) {
        const updateQuery = `
            UPDATE currency_swap_balances
            SET initial_balance = $1, updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3 AND asset = $4
            RETURNING *
        `;

        const result = await query(updateQuery, [initialBalance, userId, exchange, asset]);
        return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
    }

    /**
     * Calculate and update profit
     * Call after balance updates to track gains
     */
    static async calculateProfit(userId, exchange, asset) {
        const updateQuery = `
            UPDATE currency_swap_balances
            SET
                total_profit = total_balance - COALESCE(initial_balance, total_balance),
                profit_percent = CASE
                    WHEN COALESCE(initial_balance, 0) > 0
                    THEN ((total_balance - initial_balance) / initial_balance) * 100
                    ELSE 0
                END,
                updated_at = NOW()
            WHERE user_id = $1 AND exchange = $2 AND asset = $3
            RETURNING *
        `;

        const result = await query(updateQuery, [userId, exchange, asset]);
        return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
    }

    /**
     * Lock balance (when trade is pending)
     * Moves available → locked
     */
    static async lockBalance(userId, exchange, asset, amount) {
        const updateQuery = `
            UPDATE currency_swap_balances
            SET
                available_balance = available_balance - $1,
                locked_balance = locked_balance + $1,
                updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3 AND asset = $4
                AND available_balance >= $1
            RETURNING *
        `;

        const result = await query(updateQuery, [amount, userId, exchange, asset]);

        if (result.rows.length === 0) {
            throw new Error(`Insufficient balance to lock ${amount} ${asset} on ${exchange}`);
        }

        return this._mapRow(result.rows[0]);
    }

    /**
     * Unlock balance (when trade completes or fails)
     * Moves locked → available
     */
    static async unlockBalance(userId, exchange, asset, amount) {
        const updateQuery = `
            UPDATE currency_swap_balances
            SET
                available_balance = available_balance + $1,
                locked_balance = locked_balance - $1,
                updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3 AND asset = $4
                AND locked_balance >= $1
            RETURNING *
        `;

        const result = await query(updateQuery, [amount, userId, exchange, asset]);

        if (result.rows.length === 0) {
            throw new Error(`Insufficient locked balance to unlock ${amount} ${asset} on ${exchange}`);
        }

        return this._mapRow(result.rows[0]);
    }

    /**
     * Check if user has sufficient balance for trade
     */
    static async hasSufficientBalance(userId, exchange, asset, requiredAmount) {
        const balance = await this.getBalance(userId, exchange, asset);

        if (!balance) {
            return false;
        }

        return balance.availableBalance >= requiredAmount;
    }

    /**
     * Record sync error (when API fetch fails)
     */
    static async recordSyncError(userId, exchange, asset, errorMessage) {
        const updateQuery = `
            UPDATE currency_swap_balances
            SET sync_error = $1, updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3 AND asset = $4
            RETURNING *
        `;

        const result = await query(updateQuery, [errorMessage, userId, exchange, asset]);
        return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
    }

    /**
     * Get total profit across all exchanges for an asset
     */
    static async getTotalProfitByAsset(userId, asset) {
        const selectQuery = `
            SELECT
                SUM(total_profit) as total_profit,
                SUM(total_balance) as total_balance,
                SUM(initial_balance) as total_initial
            FROM currency_swap_balances
            WHERE user_id = $1 AND asset = $2
        `;

        const result = await query(selectQuery, [userId, asset]);
        const row = result.rows[0];

        return {
            asset,
            totalProfit: parseFloat(row.total_profit || 0),
            totalBalance: parseFloat(row.total_balance || 0),
            initialBalance: parseFloat(row.total_initial || 0),
            profitPercent: row.total_initial > 0
                ? ((row.total_profit || 0) / row.total_initial) * 100
                : 0
        };
    }

    /**
     * Get stale balances (not synced recently)
     * @param {number} minutesOld - Consider stale if older than this
     */
    static async getStaleBalances(userId, minutesOld = 5) {
        const selectQuery = `
            SELECT * FROM currency_swap_balances
            WHERE user_id = $1
                AND last_synced_at < NOW() - INTERVAL '${minutesOld} minutes'
            ORDER BY last_synced_at ASC
        `;

        const result = await query(selectQuery, [userId]);
        return result.rows.map(row => this._mapRow(row));
    }

    /**
     * Map database row to clean object
     * @private
     */
    static _mapRow(row) {
        if (!row) return null;

        return {
            id: row.id,
            userId: row.user_id,
            exchange: row.exchange,
            asset: row.asset,
            availableBalance: parseFloat(row.available_balance),
            lockedBalance: parseFloat(row.locked_balance),
            totalBalance: parseFloat(row.total_balance),
            lastSyncedAt: row.last_synced_at,
            syncSource: row.sync_source,
            syncError: row.sync_error,
            initialBalance: row.initial_balance ? parseFloat(row.initial_balance) : null,
            totalProfit: parseFloat(row.total_profit || 0),
            profitPercent: parseFloat(row.profit_percent || 0),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = Balance;
