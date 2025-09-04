// Database Connection Module
const { Pool } = require('pg');
const { logger } = require('../utils/logger');

// Database connection pool
let pool = null;

// TEMPORARY: Skip database connection if variables not available
const skipDatabase = !process.env.DATABASE_URL && !process.env.DB_HOST;

// Use DATABASE_URL if available (Railway), otherwise use individual vars
const dbConfig = process.env.DATABASE_URL ? 
    {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
    } : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'arb4me_db',
        user: process.env.DB_USER || 'arb4me_user',
        password: process.env.DB_PASSWORD,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    };

// Create connection pool
async function connectDatabase() {
    try {
        console.log('Environment check:');
        console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
        console.log('DATABASE_URL length:', process.env.DATABASE_URL?.length);
        console.log('DB_HOST:', process.env.DB_HOST);
        console.log('NODE_ENV:', process.env.NODE_ENV);
        console.log('Config being used:', process.env.DATABASE_URL ? 'DATABASE_URL' : 'Individual variables');
        
        // Skip database if no connection info in production
        if (skipDatabase) {
            console.log('⚠️ SKIPPING DATABASE CONNECTION - No database credentials found');
            logger.warn('Running without database - using in-memory storage');
            return null;
        }
        
        pool = new Pool(dbConfig);
        
        // Test connection
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        logger.info('Database connection established at:', result.rows[0].now);
        
        // Ensure required sequences exist
        try {
            await client.query(`
                DO $$ 
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'user_payment_ref_seq') THEN
                        CREATE SEQUENCE user_payment_ref_seq START WITH 1000 INCREMENT BY 1;
                        RAISE NOTICE 'Created user_payment_ref_seq sequence';
                    END IF;
                    
                    -- Set sequence to safe value above existing payment references
                    PERFORM setval('user_payment_ref_seq', 
                        GREATEST(
                            (SELECT COALESCE(MAX(CAST(SUBSTRING(payment_reference FROM 5) AS INTEGER)), 100000) 
                             FROM users 
                             WHERE payment_reference LIKE 'ARB-%' 
                             AND payment_reference ~ '^ARB-[0-9]+$'),
                            100010
                        ) + 1
                    );
                END $$;
            `);
            logger.info('Database sequences verified/created');
        } catch (seqError) {
            logger.error('Failed to create sequence:', seqError);
            // Continue anyway - will use fallback in registration
        }
        
        client.release();
        return pool;
    } catch (error) {
        logger.error('Database connection failed:', error);
        throw error;
    }
}

// Get connection pool
function getPool() {
    if (!pool) {
        throw new Error('Database not connected. Call connectDatabase() first.');
    }
    return pool;
}

// Execute query with error handling
async function query(text, params = []) {
    const client = await pool.connect();
    try {
        const start = Date.now();
        const result = await client.query(text, params);
        const duration = Date.now() - start;
        
        if (duration > 1000) {
            logger.warn(`Slow query detected (${duration}ms):`, text);
        }
        
        return result;
    } catch (error) {
        logger.error('Database query error:', {
            query: text,
            params: params,
            error: error.message
        });
        throw error;
    } finally {
        client.release();
    }
}

// Transaction wrapper
async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Close database connection
async function closeDatabase() {
    if (pool) {
        await pool.end();
        logger.info('Database connection closed');
    }
}

module.exports = {
    connectDatabase,
    getPool,
    query,
    transaction,
    closeDatabase
};