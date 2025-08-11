// Database Migration Script
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// Database configuration - use DATABASE_URL if available
const dbConfig = process.env.DATABASE_URL ? 
    {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    } : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'arb4me_db',
        user: process.env.DB_USER || 'arb4me_user',
        password: process.env.DB_PASSWORD,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    };

console.log('🚀 ARB4ME Database Migration Tool');
console.log('==================================');

async function runMigration() {
    let pool = null;
    
    try {
        console.log('📊 Connecting to database...');
        pool = new Pool(dbConfig);
        
        // Test connection
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        
        console.log('✅ Database connection established:', result.rows[0].now);
        
        // Read schema file
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSQL = await fs.readFile(schemaPath, 'utf8');
        
        console.log('📋 Executing database schema...');
        
        // Execute schema in transaction
        const migrationClient = await pool.connect();
        
        try {
            await migrationClient.query('BEGIN');
            
            // Split and execute SQL statements
            const statements = schemaSQL.split(';').filter(stmt => stmt.trim());
            
            for (let i = 0; i < statements.length; i++) {
                const statement = statements[i].trim();
                if (statement) {
                    console.log(`   Executing statement ${i + 1}/${statements.length}...`);
                    await migrationClient.query(statement);
                }
            }
            
            await migrationClient.query('COMMIT');
            console.log('✅ Database schema created successfully');
            
        } catch (error) {
            await migrationClient.query('ROLLBACK');
            throw error;
        } finally {
            migrationClient.release();
        }
        
        // Create master admin user if it doesn't exist
        console.log('👤 Setting up master admin user...');
        await setupMasterAdmin(pool);
        
        console.log('🎉 Database migration completed successfully!');
        console.log('');
        console.log('Next steps:');
        console.log('1. Start the server with: npm start');
        console.log('2. Access the API at: http://localhost:3000/api/v1');
        console.log('3. Use the master admin credentials to access admin features');
        
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.log('');
            console.log('Database connection failed. Please ensure:');
            console.log('1. PostgreSQL is running');
            console.log('2. Database credentials are correct in .env file');
            console.log('3. Database and user exist');
        }
        
        process.exit(1);
    } finally {
        if (pool) {
            await pool.end();
        }
    }
}

async function setupMasterAdmin(pool) {
    try {
        // Check if master admin already exists
        const existingAdmin = await pool.query(
            'SELECT id FROM users WHERE admin_role = $1',
            ['master']
        );
        
        if (existingAdmin.rows.length > 0) {
            console.log('   Master admin user already exists');
            return;
        }
        
        // Create master admin with default credentials
        const adminEmail = process.env.MASTER_ADMIN_EMAIL || 'admin@arb4me.com';
        const adminPassword = process.env.MASTER_ADMIN_PASSWORD || 'ARB4ME_Admin_2024!';
        const adminPin = process.env.MASTER_ADMIN_PIN || '123456';
        
        // Hash password and PIN
        const passwordHash = await bcrypt.hash(adminPassword, 12);
        const pinHash = await bcrypt.hash(adminPin, 12);
        
        // Insert master admin
        await pool.query(
            `INSERT INTO users (
                id, first_name, last_name, email, mobile, country,
                password_hash, admin_role, admin_pin, email_verified, account_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                'user_admin_master',
                'Master',
                'Admin',
                adminEmail,
                '+27000000000',
                'ZA',
                passwordHash,
                'master',
                pinHash,
                true,
                'active'
            ]
        );
        
        // Create trading activity record for admin
        await pool.query(
            'INSERT INTO trading_activity (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            ['user_admin_master']
        );
        
        console.log('✅ Master admin user created:');
        console.log(`   Email: ${adminEmail}`);
        console.log(`   Password: ${adminPassword}`);
        console.log(`   Admin PIN: ${adminPin}`);
        console.log('');
        console.log('⚠️  IMPORTANT: Change these credentials after first login!');
        
    } catch (error) {
        // If it's a unique constraint error, the user already exists
        if (error.code === '23505') {
            console.log('   Master admin user already exists with provided email');
        } else {
            console.error('   Failed to create master admin:', error.message);
        }
    }
}

// Check if this script is being run directly
if (require.main === module) {
    runMigration();
}

module.exports = { runMigration, setupMasterAdmin };