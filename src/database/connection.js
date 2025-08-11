// Database Connection Module
const { Pool } = require('pg');
const { logger } = require('../utils/logger');

// Database connection pool
let pool = null;

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
        console.log('PGHOST:', process.env.PGHOST);
        console.log('Config being used:', process.env.DATABASE_URL ? 'DATABASE_URL' : 'Individual variables');
        
        pool = new Pool(dbConfig);
        
        // Test connection
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        
        logger.info('Database connection established at:', result.rows[0].now);
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