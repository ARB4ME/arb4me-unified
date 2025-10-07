// Currency Swap Model
// Stores currency swap execution records

const { query, transaction } = require('../database/connection');

/**
 * Database Schema:
 *
 * CREATE TABLE IF NOT EXISTS currency_swaps (
 *   id SERIAL PRIMARY KEY,
 *   user_id INTEGER REFERENCES users(id),
 *   category VARCHAR(20) CHECK (category IN ('ZAR', 'INTERNATIONAL')),
 *
 *   -- Swap Details
 *   from_currency VARCHAR(10) NOT NULL,
 *   to_currency VARCHAR(10) NOT NULL,
 *   bridge_currency VARCHAR(10) NOT NULL,
 *   amount DECIMAL(20, 8) NOT NULL,
 *
 *   -- Route (stored as JSONB for flexibility)
 *   route JSONB NOT NULL,
 *
 *   -- Financial Results
 *   effective_rate DECIMAL(20, 8),
 *   wise_rate DECIMAL(20, 8),
 *   savings_percent DECIMAL(10, 4),
 *   net_profit DECIMAL(10, 4),
 *   threshold_used DECIMAL(10, 4),
 *   total_fees JSONB,
 *
 *   -- Execution Status
 *   status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'calculating', 'executing', 'completed', 'failed')),
 *   execution_time INTEGER,
 *   tx_hashes TEXT[],
 *   error_message TEXT,
 *
 *   -- Timestamps
 *   created_at TIMESTAMP DEFAULT NOW(),
 *   executed_at TIMESTAMP,
 *   completed_at TIMESTAMP
 * );
 *
 * CREATE INDEX IF NOT EXISTS idx_currency_swaps_user_id ON currency_swaps(user_id);
 * CREATE INDEX IF NOT EXISTS idx_currency_swaps_status ON currency_swaps(status);
 * CREATE INDEX IF NOT EXISTS idx_currency_swaps_category ON currency_swaps(category);
 * CREATE INDEX IF NOT EXISTS idx_currency_swaps_created_at ON currency_swaps(created_at DESC);
 */

class CurrencySwap {
    /**
     * Create currency_swaps table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS currency_swaps (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                category VARCHAR(20) CHECK (category IN ('ZAR', 'INTERNATIONAL')),

                -- Swap Details
                from_currency VARCHAR(10) NOT NULL,
                to_currency VARCHAR(10) NOT NULL,
                bridge_currency VARCHAR(10) NOT NULL,
                amount DECIMAL(20, 8) NOT NULL,

                -- Route (stored as JSONB)
                route JSONB NOT NULL,

                -- Financial Results
                effective_rate DECIMAL(20, 8),
                wise_rate DECIMAL(20, 8),
                savings_percent DECIMAL(10, 4),
                net_profit DECIMAL(10, 4),
                threshold_used DECIMAL(10, 4),
                total_fees JSONB,

                -- Execution Status
                status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'calculating', 'executing', 'completed', 'failed')),
                execution_time INTEGER,
                tx_hashes TEXT[],
                error_message TEXT,

                -- Timestamps
                created_at TIMESTAMP DEFAULT NOW(),
                executed_at TIMESTAMP,
                completed_at TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_currency_swaps_user_id ON currency_swaps(user_id);
            CREATE INDEX IF NOT EXISTS idx_currency_swaps_status ON currency_swaps(status);
            CREATE INDEX IF NOT EXISTS idx_currency_swaps_category ON currency_swaps(category);
            CREATE INDEX IF NOT EXISTS idx_currency_swaps_created_at ON currency_swaps(created_at DESC);
        `;

        await query(createTableQuery);
    }

    /**
     * Create a new currency swap record
     */
    static async create(swapData) {
        const {
            userId,
            category,
            fromCurrency,
            toCurrency,
            bridgeCurrency,
            amount,
            route,
            effectiveRate = null,
            wiseRate = null,
            savingsPercent = null,
            netProfit = null,
            thresholdUsed = null,
            totalFees = null,
            status = 'pending'
        } = swapData;

        const insertQuery = `
            INSERT INTO currency_swaps (
                user_id, category, from_currency, to_currency, bridge_currency,
                amount, route, effective_rate, wise_rate, savings_percent,
                net_profit, threshold_used, total_fees, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
        `;

        const values = [
            userId, category, fromCurrency, toCurrency, bridgeCurrency,
            amount, JSON.stringify(route), effectiveRate, wiseRate, savingsPercent,
            netProfit, thresholdUsed, totalFees ? JSON.stringify(totalFees) : null, status
        ];

        const result = await query(insertQuery, values);
        return result.rows[0];
    }

    /**
     * Find swap by ID
     */
    static async findById(swapId) {
        const result = await query('SELECT * FROM currency_swaps WHERE id = $1', [swapId]);
        return result.rows[0];
    }

    /**
     * Find swaps by user ID
     */
    static async findByUserId(userId, limit = 50) {
        const result = await query(
            'SELECT * FROM currency_swaps WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
            [userId, limit]
        );
        return result.rows;
    }

    /**
     * Find swaps by category
     */
    static async findByCategory(userId, category, limit = 50) {
        const result = await query(
            'SELECT * FROM currency_swaps WHERE user_id = $1 AND category = $2 ORDER BY created_at DESC LIMIT $3',
            [userId, category, limit]
        );
        return result.rows;
    }

    /**
     * Update swap status
     */
    static async updateStatus(swapId, status, errorMessage = null) {
        const updateQuery = `
            UPDATE currency_swaps
            SET status = $1,
                error_message = $2,
                executed_at = CASE WHEN $1 = 'executing' THEN NOW() ELSE executed_at END,
                completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN NOW() ELSE completed_at END
            WHERE id = $3
            RETURNING *
        `;

        const result = await query(updateQuery, [status, errorMessage, swapId]);
        return result.rows[0];
    }

    /**
     * Update swap with execution results
     */
    static async updateResults(swapId, results) {
        const {
            route,
            effectiveRate,
            wiseRate,
            savingsPercent,
            netProfit,
            totalFees,
            executionTime,
            txHashes,
            status = 'completed'
        } = results;

        const updateQuery = `
            UPDATE currency_swaps
            SET route = $1,
                effective_rate = $2,
                wise_rate = $3,
                savings_percent = $4,
                net_profit = $5,
                total_fees = $6,
                execution_time = $7,
                tx_hashes = $8,
                status = $9,
                completed_at = NOW()
            WHERE id = $10
            RETURNING *
        `;

        const values = [
            JSON.stringify(route),
            effectiveRate,
            wiseRate,
            savingsPercent,
            netProfit,
            JSON.stringify(totalFees),
            executionTime,
            txHashes,
            status,
            swapId
        ];

        const result = await query(updateQuery, values);
        return result.rows[0];
    }

    /**
     * Get swap statistics for user
     */
    static async getStats(userId) {
        const statsQuery = `
            SELECT
                COUNT(*) as total_swaps,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_swaps,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_swaps,
                SUM(CASE WHEN status = 'completed' THEN net_profit ELSE 0 END) as total_profit,
                AVG(CASE WHEN status = 'completed' THEN net_profit ELSE NULL END) as avg_profit,
                AVG(CASE WHEN status = 'completed' THEN execution_time ELSE NULL END) as avg_execution_time
            FROM currency_swaps
            WHERE user_id = $1
        `;

        const result = await query(statsQuery, [userId]);
        return result.rows[0];
    }

    /**
     * Get recent swaps with summary
     */
    static async getRecentSwaps(userId, days = 7) {
        const recentQuery = `
            SELECT * FROM currency_swaps
            WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '${days} days'
            ORDER BY created_at DESC
        `;

        const result = await query(recentQuery, [userId]);
        return result.rows;
    }

    /**
     * Delete old pending/failed swaps (cleanup)
     */
    static async cleanupOldSwaps(daysOld = 30) {
        const cleanupQuery = `
            DELETE FROM currency_swaps
            WHERE status IN ('pending', 'failed')
            AND created_at < NOW() - INTERVAL '${daysOld} days'
            RETURNING id
        `;

        const result = await query(cleanupQuery);
        return result.rows.length;
    }
}

module.exports = CurrencySwap;
