// Currency Swap Credentials Model
// Stores encrypted API credentials for Currency Swap strategy (separate from Transfer ARB)

const { query } = require('../database/connection');
const crypto = require('crypto');
const { systemLogger } = require('../utils/logger');

// Encryption configuration
const ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY
    ? Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, 'hex')
    : (() => {
        const key = crypto.randomBytes(32);
        systemLogger.error('⚠️ CREDENTIALS_ENCRYPTION_KEY not set! Using random key - credentials will not persist across restarts!');
        systemLogger.error(`Set this in Railway: CREDENTIALS_ENCRYPTION_KEY=${key.toString('hex')}`);
        return key;
    })();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt sensitive data
 */
function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Return iv:authTag:encrypted
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
function decrypt(encryptedData) {
    try {
        const parts = encryptedData.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted data format');
        }

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        throw new Error(`Decryption failed: ${error.message}`);
    }
}

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
            depositAddresses = {}
        } = credentials;

        // Encrypt sensitive data
        const encryptedApiKey = encrypt(apiKey);
        const encryptedApiSecret = encrypt(apiSecret);
        const encryptedPassphrase = apiPassphrase ? encrypt(apiPassphrase) : null;
        const encryptedMemo = memo ? encrypt(memo) : null;

        const upsertQuery = `
            INSERT INTO currency_swap_credentials (
                user_id, exchange, api_key, api_secret, api_passphrase, memo,
                deposit_addresses, is_connected, last_connected_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (user_id, exchange) DO UPDATE SET
                api_key = EXCLUDED.api_key,
                api_secret = EXCLUDED.api_secret,
                api_passphrase = EXCLUDED.api_passphrase,
                memo = EXCLUDED.memo,
                deposit_addresses = EXCLUDED.deposit_addresses,
                is_connected = EXCLUDED.is_connected,
                last_connected_at = NOW(),
                updated_at = NOW()
            RETURNING id
        `;

        const values = [
            userId,
            exchange,
            encryptedApiKey,
            encryptedApiSecret,
            encryptedPassphrase,
            encryptedMemo,
            JSON.stringify(depositAddresses),
            true
        ];

        const result = await query(upsertQuery, values);
        return result.rows[0];
    }

    /**
     * Get credentials for an exchange (decrypted)
     */
    static async getCredentials(userId, exchange) {
        try {
            const selectQuery = `
                SELECT * FROM currency_swap_credentials
                WHERE user_id = $1 AND exchange = $2
            `;

            const result = await query(selectQuery, [userId, exchange]);

            if (result.rows.length === 0) {
                return null;
            }

            const cred = result.rows[0];

            // Decrypt sensitive fields
            try {
                return {
                    id: cred.id,
                    userId: cred.user_id,
                    exchange: cred.exchange,
                    apiKey: decrypt(cred.api_key),
                    apiSecret: decrypt(cred.api_secret),
                    apiPassphrase: cred.api_passphrase ? decrypt(cred.api_passphrase) : null,
                    memo: cred.memo ? decrypt(cred.memo) : null,
                    depositAddresses: typeof cred.deposit_addresses === 'string'
                        ? JSON.parse(cred.deposit_addresses)
                        : cred.deposit_addresses,
                    isConnected: cred.is_connected,
                    lastConnectedAt: cred.last_connected_at,
                    lastBalanceCheck: cred.last_balance_check,
                    createdAt: cred.created_at,
                    updatedAt: cred.updated_at
                };
            } catch (decryptError) {
                systemLogger.error(`Failed to decrypt credentials for ${exchange}`, {
                    userId,
                    exchange,
                    error: decryptError.message
                });
                throw new Error(`Decryption failed for ${exchange}. CREDENTIALS_ENCRYPTION_KEY may have changed.`);
            }
        } catch (error) {
            systemLogger.error(`Failed to get credentials for ${exchange}`, {
                userId,
                exchange,
                error: error.message
            });
            throw error;
        }
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
            apiKey: decrypt(cred.api_key),
            apiSecret: decrypt(cred.api_secret),
            apiPassphrase: cred.api_passphrase ? decrypt(cred.api_passphrase) : null,
            memo: cred.memo ? decrypt(cred.memo) : null,
            depositAddresses: typeof cred.deposit_addresses === 'string'
                ? JSON.parse(cred.deposit_addresses)
                : cred.deposit_addresses,
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
