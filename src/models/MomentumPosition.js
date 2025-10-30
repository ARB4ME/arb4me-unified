// Momentum Position Model
// Tracks open and closed positions for momentum trading

const { query } = require('../database/connection');

/**
 * Database Schema:
 *
 * CREATE TABLE IF NOT EXISTS momentum_positions (
 *   id SERIAL PRIMARY KEY,
 *   user_id VARCHAR(255) NOT NULL,
 *   strategy_id INTEGER REFERENCES momentum_strategies(id) ON DELETE CASCADE,
 *   exchange VARCHAR(50) NOT NULL,
 *   asset VARCHAR(20) NOT NULL,
 *   pair VARCHAR(30) NOT NULL,
 *   entry_price DECIMAL(18,8) NOT NULL,
 *   entry_quantity DECIMAL(18,8) NOT NULL,
 *   entry_value_usdt DECIMAL(12,2) NOT NULL,
 *   entry_fee DECIMAL(12,4) DEFAULT 0,
 *   entry_time TIMESTAMP NOT NULL,
 *   entry_signals JSONB,
 *   entry_order_id VARCHAR(100),
 *   status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
 *   exit_price DECIMAL(18,8),
 *   exit_quantity DECIMAL(18,8),
 *   exit_fee DECIMAL(12,4) DEFAULT 0,
 *   exit_time TIMESTAMP,
 *   exit_reason VARCHAR(50),
 *   exit_pnl_usdt DECIMAL(12,2),
 *   exit_pnl_percent DECIMAL(10,4),
 *   exit_order_id VARCHAR(100),
 *   created_at TIMESTAMP DEFAULT NOW(),
 *   updated_at TIMESTAMP DEFAULT NOW()
 * );
 *
 * CREATE INDEX IF NOT EXISTS idx_momentum_positions_user_exchange ON momentum_positions(user_id, exchange);
 * CREATE INDEX IF NOT EXISTS idx_momentum_positions_strategy ON momentum_positions(strategy_id);
 * CREATE INDEX IF NOT EXISTS idx_momentum_positions_status ON momentum_positions(status);
 * CREATE INDEX IF NOT EXISTS idx_momentum_positions_entry_time ON momentum_positions(entry_time);
 */

class MomentumPosition {
    /**
     * Create momentum_positions table
     */
    static async createTable() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS momentum_positions (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                strategy_id INTEGER REFERENCES momentum_strategies(id) ON DELETE CASCADE,
                exchange VARCHAR(50) NOT NULL,
                asset VARCHAR(20) NOT NULL,
                pair VARCHAR(30) NOT NULL,
                entry_price DECIMAL(18,8) NOT NULL,
                entry_quantity DECIMAL(18,8) NOT NULL,
                entry_value_usdt DECIMAL(12,2) NOT NULL,
                entry_fee DECIMAL(12,4) DEFAULT 0,
                entry_time TIMESTAMP NOT NULL,
                entry_signals JSONB,
                entry_order_id VARCHAR(100),
                status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
                exit_price DECIMAL(18,8),
                exit_quantity DECIMAL(18,8),
                exit_fee DECIMAL(12,4) DEFAULT 0,
                exit_time TIMESTAMP,
                exit_reason VARCHAR(50),
                exit_pnl_usdt DECIMAL(12,2),
                exit_pnl_percent DECIMAL(10,4),
                exit_order_id VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_momentum_positions_user_exchange ON momentum_positions(user_id, exchange);
            CREATE INDEX IF NOT EXISTS idx_momentum_positions_strategy ON momentum_positions(strategy_id);
            CREATE INDEX IF NOT EXISTS idx_momentum_positions_status ON momentum_positions(status);
            CREATE INDEX IF NOT EXISTS idx_momentum_positions_entry_time ON momentum_positions(entry_time);

            -- Add exit_fee column to existing tables (safe to run multiple times)
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_name='momentum_positions' AND column_name='exit_fee') THEN
                    ALTER TABLE momentum_positions ADD COLUMN exit_fee DECIMAL(12,4) DEFAULT 0;
                END IF;
            END $$;
        `;

        await query(createTableQuery);
    }

    /**
     * Open a new position
     */
    static async create(positionData) {
        const {
            userId,
            strategyId,
            exchange,
            asset,
            pair,
            entryPrice,
            entryQuantity,
            entryValueUsdt,
            entryFee,
            entrySignals,
            entryOrderId
        } = positionData;

        const insertQuery = `
            INSERT INTO momentum_positions (
                user_id, strategy_id, exchange, asset, pair,
                entry_price, entry_quantity, entry_value_usdt, entry_fee,
                entry_time, entry_signals, entry_order_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, 'OPEN')
            RETURNING *
        `;

        const values = [
            userId,
            strategyId,
            exchange,
            asset,
            pair,
            entryPrice,
            entryQuantity,
            entryValueUsdt,
            entryFee || 0, // Default to 0 if not provided
            entrySignals ? JSON.stringify(entrySignals) : null,
            entryOrderId
        ];

        const result = await query(insertQuery, values);
        return result.rows[0];
    }

    /**
     * Get open positions for user and exchange
     */
    static async getOpenByUserAndExchange(userId, exchange) {
        const selectQuery = `
            SELECT
                p.*,
                s.strategy_name
            FROM momentum_positions p
            LEFT JOIN momentum_strategies s ON p.strategy_id = s.id
            WHERE p.user_id = $1 AND p.exchange = $2 AND p.status = 'OPEN'
            ORDER BY p.entry_time DESC
        `;

        const result = await query(selectQuery, [userId, exchange]);
        return result.rows;
    }

    /**
     * Get closed positions for user and exchange
     */
    static async getClosedByUserAndExchange(userId, exchange, limit = 50) {
        const selectQuery = `
            SELECT
                p.*,
                s.strategy_name
            FROM momentum_positions p
            LEFT JOIN momentum_strategies s ON p.strategy_id = s.id
            WHERE p.user_id = $1 AND p.exchange = $2 AND p.status = 'CLOSED'
            ORDER BY p.exit_time DESC
            LIMIT $3
        `;

        const result = await query(selectQuery, [userId, exchange, limit]);
        return result.rows;
    }

    /**
     * Get position by ID
     */
    static async getById(positionId) {
        const selectQuery = `
            SELECT
                p.*,
                s.strategy_name,
                s.exit_rules
            FROM momentum_positions p
            LEFT JOIN momentum_strategies s ON p.strategy_id = s.id
            WHERE p.id = $1
        `;

        const result = await query(selectQuery, [positionId]);
        return result.rows[0];
    }

    /**
     * Close a position
     */
    static async close(positionId, exitData) {
        const {
            exitPrice,
            exitQuantity,
            exitFee,
            exitReason,
            exitOrderId
        } = exitData;

        // Calculate P&L with ACTUAL fees (from exchange responses)
        const position = await this.getById(positionId);
        if (!position) {
            throw new Error('Position not found');
        }

        const exitValueUsdt = exitPrice * exitQuantity;

        // TRUE P&L = (Exit Value - Exit Fee) - (Entry Value + Entry Fee)
        // This gives the ACTUAL net profit after all exchange fees
        const entryFee = position.entry_fee || 0;
        const exitFeeAmount = exitFee || 0;
        const pnlUsdt = (exitValueUsdt - exitFeeAmount) - (position.entry_value_usdt + entryFee);
        const pnlPercent = (pnlUsdt / position.entry_value_usdt) * 100;

        const updateQuery = `
            UPDATE momentum_positions
            SET status = 'CLOSED',
                exit_price = $1,
                exit_quantity = $2,
                exit_fee = $3,
                exit_time = NOW(),
                exit_reason = $4,
                exit_pnl_usdt = $5,
                exit_pnl_percent = $6,
                exit_order_id = $7,
                updated_at = NOW()
            WHERE id = $8
            RETURNING *
        `;

        const values = [
            exitPrice,
            exitQuantity,
            exitFeeAmount,
            exitReason,
            pnlUsdt,
            pnlPercent,
            exitOrderId,
            positionId
        ];

        const result = await query(updateQuery, values);
        return result.rows[0];
    }

    /**
     * Get open positions for a strategy
     */
    static async getOpenByStrategy(strategyId) {
        const selectQuery = `
            SELECT * FROM momentum_positions
            WHERE strategy_id = $1 AND status = 'OPEN'
            ORDER BY entry_time ASC
        `;

        const result = await query(selectQuery, [strategyId]);
        return result.rows;
    }

    /**
     * Get positions that need exit checking
     * (All open positions)
     */
    static async getPositionsNeedingExitCheck(exchange) {
        const selectQuery = `
            SELECT
                p.*,
                s.exit_rules,
                s.strategy_name
            FROM momentum_positions p
            JOIN momentum_strategies s ON p.strategy_id = s.id
            WHERE p.exchange = $1
            AND p.status = 'OPEN'
            AND s.is_active = true
            ORDER BY p.entry_time ASC
        `;

        const result = await query(selectQuery, [exchange]);
        return result.rows;
    }

    /**
     * Get daily statistics
     */
    static async getDailyStats(userId, exchange) {
        const statsQuery = `
            SELECT
                COUNT(*) as total_trades,
                COUNT(CASE WHEN exit_pnl_usdt > 0 THEN 1 END) as winning_trades,
                COUNT(CASE WHEN exit_pnl_usdt < 0 THEN 1 END) as losing_trades,
                COALESCE(SUM(exit_pnl_usdt), 0) as total_pnl,
                COALESCE(AVG(exit_pnl_usdt), 0) as avg_pnl,
                COALESCE(MAX(exit_pnl_usdt), 0) as best_trade,
                COALESCE(MIN(exit_pnl_usdt), 0) as worst_trade
            FROM momentum_positions
            WHERE user_id = $1
            AND exchange = $2
            AND status = 'CLOSED'
            AND exit_time >= CURRENT_DATE
        `;

        const result = await query(statsQuery, [userId, exchange]);
        return result.rows[0];
    }

    /**
     * Delete position (for cleanup)
     */
    static async delete(positionId) {
        const deleteQuery = `
            DELETE FROM momentum_positions
            WHERE id = $1
            RETURNING *
        `;

        const result = await query(deleteQuery, [positionId]);
        return result.rows[0];
    }
}

module.exports = MomentumPosition;
