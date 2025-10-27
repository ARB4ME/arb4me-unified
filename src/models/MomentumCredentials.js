// Momentum Trading Credentials Model
// Stores encrypted API credentials for Momentum Trading strategy

const { query } = require('../database/connection');

class MomentumCredentials {
    /**
     * Create momentum_credentials table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS momentum_credentials (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                exchange VARCHAR(50) NOT NULL,

                -- Encrypted credentials
                api_key TEXT NOT NULL,
                api_secret TEXT NOT NULL,
                api_passphrase TEXT,

                -- Connection status
                is_connected BOOLEAN DEFAULT false,
                last_connected_at TIMESTAMP,

                -- Metadata
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),

                -- Unique constraint: one credential set per user per exchange
                UNIQUE(user_id, exchange)
            );

            CREATE INDEX IF NOT EXISTS idx_momentum_credentials_user_id ON momentum_credentials(user_id);
            CREATE INDEX IF NOT EXISTS idx_momentum_credentials_exchange ON momentum_credentials(exchange);
        `;

        await query(createTableQuery);
    }

    /**
     * Save or update credentials for an exchange
     */
    static async saveCredentials(userId, exchange, credentials) {
        const {
            apiKey,
            apiSecret,
            apiPassphrase = null
        } = credentials;

        const upsertQuery = `
            INSERT INTO momentum_credentials (
                user_id, exchange, api_key, api_secret, api_passphrase, is_connected, last_connected_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (user_id, exchange) DO UPDATE SET
                api_key = EXCLUDED.api_key,
                api_secret = EXCLUDED.api_secret,
                api_passphrase = EXCLUDED.api_passphrase,
                is_connected = EXCLUDED.is_connected,
                last_connected_at = NOW(),
                updated_at = NOW()
            RETURNING *;
        `;

        const result = await query(upsertQuery, [
            userId,
            exchange.toLowerCase(),
            apiKey,
            apiSecret,
            apiPassphrase,
            true
        ]);

        return result.rows[0];
    }

    /**
     * Get credentials for user and exchange
     */
    static async getCredentials(userId, exchange) {
        const selectQuery = `
            SELECT * FROM momentum_credentials
            WHERE user_id = $1 AND exchange = $2
        `;

        const result = await query(selectQuery, [userId, exchange.toLowerCase()]);
        return result.rows[0] || null;
    }

    /**
     * Delete credentials for exchange
     */
    static async deleteCredentials(userId, exchange) {
        const deleteQuery = `
            DELETE FROM momentum_credentials
            WHERE user_id = $1 AND exchange = $2
            RETURNING *;
        `;

        const result = await query(deleteQuery, [userId, exchange.toLowerCase()]);
        return result.rows[0] || null;
    }

    /**
     * Update connection status
     */
    static async updateConnectionStatus(userId, exchange, isConnected) {
        const updateQuery = `
            UPDATE momentum_credentials
            SET is_connected = $1,
                last_connected_at = NOW(),
                updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3
            RETURNING *;
        `;

        const result = await query(updateQuery, [isConnected, userId, exchange.toLowerCase()]);
        return result.rows[0] || null;
    }

    /**
     * Get all credentials for user (all exchanges)
     */
    static async getAllCredentialsByUser(userId) {
        const selectQuery = `
            SELECT * FROM momentum_credentials
            WHERE user_id = $1
            ORDER BY exchange ASC
        `;

        const result = await query(selectQuery, [userId]);
        return result.rows;
    }
}

module.exports = MomentumCredentials;
