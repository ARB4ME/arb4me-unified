// Asset Declaration Model
// Users declare which assets (fiat/stablecoins) they have funded on each exchange

const { query } = require('../database/connection');
const { systemLogger } = require('../utils/logger');

class AssetDeclaration {
    /**
     * Create asset_declarations table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS currency_swap_asset_declarations (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,

                -- Which assets user has funded on this exchange
                -- Example: ["ZAR", "USDT", "USD", "EUR"]
                funded_assets JSONB NOT NULL DEFAULT '[]',

                -- Optional: Initial balances for tracking profit
                -- Example: {"ZAR": 100000, "USDT": 5000, "USD": 3000}
                initial_balances JSONB DEFAULT '{}',

                -- Status
                is_active BOOLEAN DEFAULT true,
                last_updated TIMESTAMP DEFAULT NOW(),

                -- Notes (optional user notes about this exchange)
                notes TEXT,

                -- Timestamps
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),

                -- One declaration per user per exchange
                CONSTRAINT unique_user_exchange_declaration UNIQUE(user_id, exchange)
            );

            CREATE INDEX IF NOT EXISTS idx_asset_declarations_user_id ON currency_swap_asset_declarations(user_id);
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_exchange ON currency_swap_asset_declarations(exchange);
            CREATE INDEX IF NOT EXISTS idx_asset_declarations_active ON currency_swap_asset_declarations(is_active);
        `;

        await query(createTableQuery);
        systemLogger.info('Asset declarations table verified/created');
    }

    /**
     * Save or update asset declaration for an exchange
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name (VALR, Luno, Kraken, etc.)
     * @param {array} fundedAssets - Array of asset codes ["ZAR", "USDT", "USD"]
     * @param {object} initialBalances - Optional initial balances {"ZAR": 100000, "USDT": 5000}
     */
    static async saveDeclaration(userId, exchange, fundedAssets, initialBalances = {}) {
        const upsertQuery = `
            INSERT INTO currency_swap_asset_declarations (
                user_id, exchange, funded_assets, initial_balances, is_active, last_updated
            )
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (user_id, exchange) DO UPDATE SET
                funded_assets = EXCLUDED.funded_assets,
                initial_balances = EXCLUDED.initial_balances,
                is_active = EXCLUDED.is_active,
                last_updated = NOW(),
                updated_at = NOW()
            RETURNING *
        `;

        const values = [
            userId,
            exchange,
            JSON.stringify(fundedAssets),
            JSON.stringify(initialBalances),
            true
        ];

        const result = await query(upsertQuery, values);
        return this._mapRow(result.rows[0]);
    }

    /**
     * Get asset declarations for a user
     * @param {number} userId - User ID
     * @param {boolean} activeOnly - Only return active declarations
     */
    static async getByUserId(userId, activeOnly = true) {
        let selectQuery = `
            SELECT * FROM currency_swap_asset_declarations
            WHERE user_id = $1
        `;

        if (activeOnly) {
            selectQuery += ` AND is_active = true`;
        }

        selectQuery += ` ORDER BY exchange`;

        const result = await query(selectQuery, [userId]);
        return result.rows.map(row => this._mapRow(row));
    }

    /**
     * Get declaration for specific exchange
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     */
    static async getByExchange(userId, exchange) {
        const selectQuery = `
            SELECT * FROM currency_swap_asset_declarations
            WHERE user_id = $1 AND exchange = $2
        `;

        const result = await query(selectQuery, [userId, exchange]);
        return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
    }

    /**
     * Get all funded assets across all exchanges for a user
     * Useful for understanding user's total exposure
     */
    static async getAllFundedAssets(userId) {
        const declarations = await this.getByUserId(userId, true);

        const assetsByExchange = {};
        const allAssets = new Set();

        declarations.forEach(decl => {
            assetsByExchange[decl.exchange] = decl.fundedAssets;
            decl.fundedAssets.forEach(asset => allAssets.add(asset));
        });

        return {
            byExchange: assetsByExchange,
            uniqueAssets: Array.from(allAssets)
        };
    }

    /**
     * Delete asset declaration (soft delete - marks inactive)
     * @param {number} userId - User ID
     * @param {string} exchange - Exchange name
     */
    static async deleteDeclaration(userId, exchange) {
        const updateQuery = `
            UPDATE currency_swap_asset_declarations
            SET is_active = false, updated_at = NOW()
            WHERE user_id = $1 AND exchange = $2
            RETURNING *
        `;

        const result = await query(updateQuery, [userId, exchange]);
        return result.rows.length > 0;
    }

    /**
     * Hard delete (actually remove from database)
     * Use cautiously!
     */
    static async hardDelete(userId, exchange) {
        const deleteQuery = `
            DELETE FROM currency_swap_asset_declarations
            WHERE user_id = $1 AND exchange = $2
            RETURNING *
        `;

        const result = await query(deleteQuery, [userId, exchange]);
        return result.rows.length > 0;
    }

    /**
     * Update initial balances (for profit tracking)
     */
    static async updateInitialBalances(userId, exchange, initialBalances) {
        const updateQuery = `
            UPDATE currency_swap_asset_declarations
            SET initial_balances = $1, updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3
            RETURNING *
        `;

        const result = await query(updateQuery, [
            JSON.stringify(initialBalances),
            userId,
            exchange
        ]);

        return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
    }

    /**
     * Check if user has declared any assets
     */
    static async hasDeclarations(userId) {
        const countQuery = `
            SELECT COUNT(*) as count
            FROM currency_swap_asset_declarations
            WHERE user_id = $1 AND is_active = true
        `;

        const result = await query(countQuery, [userId]);
        return parseInt(result.rows[0].count) > 0;
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
            fundedAssets: typeof row.funded_assets === 'string'
                ? JSON.parse(row.funded_assets)
                : row.funded_assets,
            initialBalances: typeof row.initial_balances === 'string'
                ? JSON.parse(row.initial_balances)
                : row.initial_balances,
            isActive: row.is_active,
            lastUpdated: row.last_updated,
            notes: row.notes,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = AssetDeclaration;
