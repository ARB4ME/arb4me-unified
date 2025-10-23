// Currency Swap Credentials Model
// Stores encrypted API credentials for Currency Swap strategy (separate from Transfer ARB)

const { query } = require('../database/connection');

class CurrencySwapCredentials {
    /**
     * Create currency_swap_credentials table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS currency_swap_credentials (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                exchange VARCHAR(50) NOT NULL,

                -- Encrypted credentials
                api_key TEXT NOT NULL,
                api_secret TEXT NOT NULL,
                api_passphrase TEXT,
                memo TEXT,

                -- Deposit addresses for this exchange
                deposit_addresses JSONB DEFAULT '{}',

                -- XRP deposit info (for receiving XRP transfers)
                xrp_deposit_address VARCHAR(100),
                xrp_deposit_tag VARCHAR(50),

                -- Connection status
                is_connected BOOLEAN DEFAULT false,
                last_connected_at TIMESTAMP,
                last_balance_check TIMESTAMP,

                -- Metadata
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),

                -- Unique constraint: one credential set per user per exchange
                UNIQUE(user_id, exchange)
            );

            CREATE INDEX IF NOT EXISTS idx_currency_swap_credentials_user_id ON currency_swap_credentials(user_id);
            CREATE INDEX IF NOT EXISTS idx_currency_swap_credentials_exchange ON currency_swap_credentials(exchange);
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
            apiPassphrase = null,
            memo = null,
            depositAddresses = {},
            xrpDepositAddress = null,
            xrpDepositTag = null
        } = credentials;

        const upsertQuery = `
            INSERT INTO currency_swap_credentials (
                user_id, exchange, api_key, api_secret, api_passphrase, memo,
                deposit_addresses, xrp_deposit_address, xrp_deposit_tag, is_connected, last_connected_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (user_id, exchange) DO UPDATE SET
                api_key = EXCLUDED.api_key,
                api_secret = EXCLUDED.api_secret,
                api_passphrase = EXCLUDED.api_passphrase,
                memo = EXCLUDED.memo,
                deposit_addresses = EXCLUDED.deposit_addresses,
                xrp_deposit_address = EXCLUDED.xrp_deposit_address,
                xrp_deposit_tag = EXCLUDED.xrp_deposit_tag,
                is_connected = EXCLUDED.is_connected,
                last_connected_at = NOW(),
                updated_at = NOW()
            RETURNING id
        `;

        const values = [
            userId,
            exchange,
            apiKey,
            apiSecret,
            apiPassphrase,
            memo,
            JSON.stringify(depositAddresses),
            xrpDepositAddress,
            xrpDepositTag,
            true
        ];

        const result = await query(upsertQuery, values);
        return result.rows[0];
    }

    /**
     * Get credentials for an exchange
     */
    static async getCredentials(userId, exchange) {
        const selectQuery = `
            SELECT * FROM currency_swap_credentials
            WHERE user_id = $1 AND exchange = $2
        `;

        const result = await query(selectQuery, [userId, exchange]);

        if (result.rows.length === 0) {
            return null;
        }

        const cred = result.rows[0];

        return {
            id: cred.id,
            userId: cred.user_id,
            exchange: cred.exchange,
            apiKey: cred.api_key,
            apiSecret: cred.api_secret,
            apiPassphrase: cred.api_passphrase,
            memo: cred.memo,
            depositAddresses: typeof cred.deposit_addresses === 'string'
                ? JSON.parse(cred.deposit_addresses)
                : cred.deposit_addresses,
            isConnected: cred.is_connected,
            lastConnectedAt: cred.last_connected_at,
            lastBalanceCheck: cred.last_balance_check,
            createdAt: cred.created_at,
            updatedAt: cred.updated_at
        };
    }

    /**
     * Get all credentials for a user
     */
    static async getAllCredentials(userId) {
        const selectQuery = `
            SELECT * FROM currency_swap_credentials
            WHERE user_id = $1
            ORDER BY exchange
        `;

        const result = await query(selectQuery, [userId]);

        return result.rows.map(cred => ({
            id: cred.id,
            userId: cred.user_id,
            exchange: cred.exchange,
            apiKey: cred.api_key,
            apiSecret: cred.api_secret,
            apiPassphrase: cred.api_passphrase,
            memo: cred.memo,
            depositAddresses: typeof cred.deposit_addresses === 'string'
                ? JSON.parse(cred.deposit_addresses)
                : cred.deposit_addresses,
            xrpDepositAddress: cred.xrp_deposit_address,
            xrpDepositTag: cred.xrp_deposit_tag,
            isConnected: cred.is_connected,
            lastConnectedAt: cred.last_connected_at,
            lastBalanceCheck: cred.last_balance_check
        }));
    }

    /**
     * Update deposit addresses for an exchange
     */
    static async updateDepositAddresses(userId, exchange, depositAddresses) {
        const updateQuery = `
            UPDATE currency_swap_credentials
            SET deposit_addresses = $1,
                updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3
            RETURNING id
        `;

        const result = await query(updateQuery, [
            JSON.stringify(depositAddresses),
            userId,
            exchange
        ]);

        return result.rows.length > 0;
    }

    /**
     * Update XRP deposit info for an exchange (for auto-save from frontend)
     */
    static async updateXrpDepositInfo(userId, exchange, xrpDepositAddress, xrpDepositTag) {
        const updateQuery = `
            UPDATE currency_swap_credentials
            SET xrp_deposit_address = $1,
                xrp_deposit_tag = $2,
                updated_at = NOW()
            WHERE user_id = $3 AND exchange = $4
            RETURNING id
        `;

        const result = await query(updateQuery, [
            xrpDepositAddress,
            xrpDepositTag,
            userId,
            exchange
        ]);

        return result.rows.length > 0;
    }

    /**
     * Update connection status
     */
    static async updateConnectionStatus(userId, exchange, isConnected) {
        const updateQuery = `
            UPDATE currency_swap_credentials
            SET is_connected = $1,
                last_connected_at = CASE WHEN $1 = true THEN NOW() ELSE last_connected_at END,
                updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3
            RETURNING id
        `;

        const result = await query(updateQuery, [isConnected, userId, exchange]);
        return result.rows.length > 0;
    }

    /**
     * Update last balance check timestamp
     */
    static async updateBalanceCheck(userId, exchange) {
        const updateQuery = `
            UPDATE currency_swap_credentials
            SET last_balance_check = NOW(),
                updated_at = NOW()
            WHERE user_id = $2 AND exchange = $3
        `;

        await query(updateQuery, [userId, exchange]);
    }

    /**
     * Delete credentials for an exchange
     */
    static async deleteCredentials(userId, exchange) {
        const deleteQuery = `
            DELETE FROM currency_swap_credentials
            WHERE user_id = $1 AND exchange = $2
            RETURNING id
        `;

        const result = await query(deleteQuery, [userId, exchange]);
        return result.rows.length > 0;
    }

    /**
     * Get list of connected exchanges for a user
     */
    static async getConnectedExchanges(userId) {
        const selectQuery = `
            SELECT exchange, is_connected, last_connected_at
            FROM currency_swap_credentials
            WHERE user_id = $1 AND is_connected = true
            ORDER BY exchange
        `;

        const result = await query(selectQuery, [userId]);
        return result.rows.map(row => ({
            exchange: row.exchange,
            isConnected: row.is_connected,
            lastConnectedAt: row.last_connected_at
        }));
    }
}

module.exports = CurrencySwapCredentials;
