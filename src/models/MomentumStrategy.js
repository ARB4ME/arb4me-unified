// Momentum Strategy Model
// Stores user-defined momentum trading strategies

const { query } = require('../database/connection');

/**
 * Database Schema:
 *
 * CREATE TABLE IF NOT EXISTS momentum_strategies (
 *   id SERIAL PRIMARY KEY,
 *   user_id VARCHAR(255) NOT NULL,
 *   exchange VARCHAR(50) NOT NULL,
 *   strategy_name VARCHAR(100) NOT NULL,
 *   assets TEXT[] NOT NULL,
 *   entry_indicators JSONB NOT NULL,
 *   entry_logic VARCHAR(20) NOT NULL CHECK (entry_logic IN ('2_out_of_3', 'all', 'any_1')),
 *   exit_rules JSONB NOT NULL,
 *   max_trade_amount DECIMAL(12,2) NOT NULL,
 *   max_open_positions INTEGER NOT NULL,
 *   is_active BOOLEAN DEFAULT false,
 *   created_at TIMESTAMP DEFAULT NOW(),
 *   updated_at TIMESTAMP DEFAULT NOW()
 * );
 *
 * CREATE INDEX IF NOT EXISTS idx_momentum_strategies_user_exchange ON momentum_strategies(user_id, exchange);
 * CREATE INDEX IF NOT EXISTS idx_momentum_strategies_active ON momentum_strategies(is_active);
 */

class MomentumStrategy {
    /**
     * Create momentum_strategies table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS momentum_strategies (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                exchange VARCHAR(50) NOT NULL,
                strategy_name VARCHAR(100) NOT NULL,
                assets TEXT[] NOT NULL,
                entry_indicators JSONB NOT NULL,
                entry_logic VARCHAR(20) NOT NULL CHECK (entry_logic IN ('2_out_of_3', 'all', 'any_1')),
                exit_rules JSONB NOT NULL,
                max_trade_amount DECIMAL(12,2) NOT NULL,
                max_open_positions INTEGER NOT NULL,
                is_active BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_momentum_strategies_user_exchange ON momentum_strategies(user_id, exchange);
            CREATE INDEX IF NOT EXISTS idx_momentum_strategies_active ON momentum_strategies(is_active);
        `;

        await query(createTableQuery);
    }

    /**
     * Create a new strategy
     */
    static async create(strategyData) {
        const {
            userId,
            exchange,
            strategyName,
            assets,
            entryIndicators,
            entryLogic,
            exitRules,
            maxTradeAmount,
            maxOpenPositions
        } = strategyData;

        const insertQuery = `
            INSERT INTO momentum_strategies (
                user_id, exchange, strategy_name, assets,
                entry_indicators, entry_logic, exit_rules,
                max_trade_amount, max_open_positions
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `;

        const values = [
            userId,
            exchange,
            strategyName,
            assets,
            JSON.stringify(entryIndicators),
            entryLogic,
            JSON.stringify(exitRules),
            maxTradeAmount,
            maxOpenPositions
        ];

        const result = await query(insertQuery, values);
        return result.rows[0];
    }

    /**
     * Get all strategies for a user and exchange
     */
    static async getByUserAndExchange(userId, exchange) {
        const selectQuery = `
            SELECT * FROM momentum_strategies
            WHERE user_id = $1 AND exchange = $2
            ORDER BY created_at DESC
        `;

        const result = await query(selectQuery, [userId, exchange]);
        return result.rows;
    }

    /**
     * Get active strategies for a user and exchange
     */
    static async getActiveByUserAndExchange(userId, exchange) {
        const selectQuery = `
            SELECT * FROM momentum_strategies
            WHERE user_id = $1 AND exchange = $2 AND is_active = true
            ORDER BY created_at DESC
        `;

        const result = await query(selectQuery, [userId, exchange]);
        return result.rows;
    }

    /**
     * Get strategy by ID
     */
    static async getById(strategyId) {
        const selectQuery = `
            SELECT * FROM momentum_strategies
            WHERE id = $1
        `;

        const result = await query(selectQuery, [strategyId]);
        return result.rows[0];
    }

    /**
     * Toggle strategy ON/OFF
     */
    static async toggle(strategyId, userId) {
        const updateQuery = `
            UPDATE momentum_strategies
            SET is_active = NOT is_active,
                updated_at = NOW()
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await query(updateQuery, [strategyId, userId]);
        return result.rows[0];
    }

    /**
     * Update strategy
     */
    static async update(strategyId, userId, updates) {
        const {
            strategyName,
            assets,
            entryIndicators,
            entryLogic,
            exitRules,
            maxTradeAmount,
            maxOpenPositions
        } = updates;

        const updateQuery = `
            UPDATE momentum_strategies
            SET strategy_name = COALESCE($1, strategy_name),
                assets = COALESCE($2, assets),
                entry_indicators = COALESCE($3, entry_indicators),
                entry_logic = COALESCE($4, entry_logic),
                exit_rules = COALESCE($5, exit_rules),
                max_trade_amount = COALESCE($6, max_trade_amount),
                max_open_positions = COALESCE($7, max_open_positions),
                updated_at = NOW()
            WHERE id = $8 AND user_id = $9
            RETURNING *
        `;

        const values = [
            strategyName,
            assets,
            entryIndicators ? JSON.stringify(entryIndicators) : null,
            entryLogic,
            exitRules ? JSON.stringify(exitRules) : null,
            maxTradeAmount,
            maxOpenPositions,
            strategyId,
            userId
        ];

        const result = await query(updateQuery, values);
        return result.rows[0];
    }

    /**
     * Delete strategy
     */
    static async delete(strategyId, userId) {
        const deleteQuery = `
            DELETE FROM momentum_strategies
            WHERE id = $1 AND user_id = $2
            RETURNING *
        `;

        const result = await query(deleteQuery, [strategyId, userId]);
        return result.rows[0];
    }

    /**
     * Count open positions for strategy
     */
    static async countOpenPositions(strategyId) {
        const countQuery = `
            SELECT COUNT(*) as count
            FROM momentum_positions
            WHERE strategy_id = $1 AND status = 'OPEN'
        `;

        const result = await query(countQuery, [strategyId]);
        return parseInt(result.rows[0].count);
    }

    /**
     * Check if strategy can open new position
     */
    static async canOpenPosition(strategyId) {
        const strategy = await this.getById(strategyId);
        if (!strategy || !strategy.is_active) {
            return false;
        }

        const openPositions = await this.countOpenPositions(strategyId);
        return openPositions < strategy.max_open_positions;
    }
}

module.exports = MomentumStrategy;
