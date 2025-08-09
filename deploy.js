#!/usr/bin/env node

// ARB4ME Backend Deployment Script
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

console.log('🚀 ARB4ME Backend Deployment Script');
console.log('====================================');

async function checkPrerequisites() {
    console.log('📋 Checking prerequisites...');
    
    try {
        // Check Node.js version
        const { stdout: nodeVersion } = await execAsync('node --version');
        console.log(`✅ Node.js: ${nodeVersion.trim()}`);
        
        // Check npm
        const { stdout: npmVersion } = await execAsync('npm --version');
        console.log(`✅ npm: ${npmVersion.trim()}`);
        
        // Check PostgreSQL
        try {
            const { stdout: pgVersion } = await execAsync('psql --version');
            console.log(`✅ PostgreSQL: ${pgVersion.trim()}`);
        } catch (error) {
            console.log('⚠️  PostgreSQL not found in PATH (may still be available)');
        }
        
    } catch (error) {
        console.error('❌ Prerequisites check failed:', error.message);
        process.exit(1);
    }
}

async function checkEnvironment() {
    console.log('🔧 Checking environment configuration...');
    
    try {
        // Check if .env exists
        await fs.access('.env');
        console.log('✅ .env file found');
        
        // Read and validate required env vars
        const envContent = await fs.readFile('.env', 'utf8');
        const requiredVars = [
            'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
            'JWT_SECRET', 'PORT'
        ];
        
        const missingVars = [];
        requiredVars.forEach(varName => {
            if (!envContent.includes(`${varName}=`)) {
                missingVars.push(varName);
            }
        });
        
        if (missingVars.length > 0) {
            console.log('⚠️  Missing environment variables:', missingVars.join(', '));
            console.log('   Please check your .env file');
        } else {
            console.log('✅ All required environment variables present');
        }
        
    } catch (error) {
        console.log('⚠️  .env file not found');
        console.log('   Copy .env.example to .env and configure your settings');
    }
}

async function installDependencies() {
    console.log('📦 Installing dependencies...');
    
    try {
        await execAsync('npm ci --production');
        console.log('✅ Dependencies installed successfully');
    } catch (error) {
        console.log('⚠️  Production install failed, trying regular install...');
        try {
            await execAsync('npm install');
            console.log('✅ Dependencies installed successfully');
        } catch (installError) {
            console.error('❌ Dependency installation failed:', installError.message);
            process.exit(1);
        }
    }
}

async function runDatabaseMigration() {
    console.log('🗄️  Running database migration...');
    
    try {
        await execAsync('npm run migrate');
        console.log('✅ Database migration completed');
    } catch (error) {
        console.log('⚠️  Database migration failed:', error.message);
        console.log('   Please ensure:');
        console.log('   1. PostgreSQL is running');
        console.log('   2. Database credentials are correct');
        console.log('   3. Database and user exist');
        console.log('   You can run migration manually with: npm run migrate');
    }
}

async function createDirectories() {
    console.log('📁 Creating necessary directories...');
    
    const directories = ['logs', 'uploads'];
    
    for (const dir of directories) {
        try {
            await fs.mkdir(dir, { recursive: true });
            console.log(`✅ Created directory: ${dir}`);
        } catch (error) {
            if (error.code !== 'EEXIST') {
                console.log(`⚠️  Failed to create directory ${dir}:`, error.message);
            }
        }
    }
}

async function createSystemdService() {
    const serviceName = 'arb4me-backend';
    const currentDir = process.cwd();
    const user = process.env.USER || 'ubuntu';
    
    const serviceContent = `[Unit]
Description=ARB4ME Backend Server
After=network.target postgresql.service

[Service]
Type=simple
User=${user}
WorkingDirectory=${currentDir}
Environment=NODE_ENV=production
ExecStart=${process.execPath} server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=${serviceName}

[Install]
WantedBy=multi-user.target
`;
    
    try {
        await fs.writeFile(`${serviceName}.service`, serviceContent);
        console.log(`✅ Created systemd service file: ${serviceName}.service`);
        console.log('   To install and start the service:');
        console.log(`   sudo mv ${serviceName}.service /etc/systemd/system/`);
        console.log('   sudo systemctl daemon-reload');
        console.log(`   sudo systemctl enable ${serviceName}`);
        console.log(`   sudo systemctl start ${serviceName}`);
    } catch (error) {
        console.log('⚠️  Failed to create systemd service:', error.message);
    }
}

async function createNginxConfig() {
    const domain = process.env.DOMAIN || 'your-domain.com';
    const port = process.env.PORT || '3000';
    
    const nginxConfig = `server {
    listen 80;
    server_name ${domain};
    
    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${domain};
    
    # SSL Configuration (update paths to your certificates)
    ssl_certificate /path/to/your/certificate.pem;
    ssl_certificate_key /path/to/your/private-key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    
    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    
    location / {
        limit_req zone=api burst=20 nodelay;
        
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # WebSocket support
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
    
    # Health check endpoint (no rate limiting)
    location /health {
        proxy_pass http://127.0.0.1:${port}/health;
        access_log off;
    }
}
`;
    
    try {
        await fs.writeFile('nginx-arb4me-backend.conf', nginxConfig);
        console.log('✅ Created nginx configuration: nginx-arb4me-backend.conf');
        console.log('   To install:');
        console.log('   sudo mv nginx-arb4me-backend.conf /etc/nginx/sites-available/');
        console.log('   sudo ln -s /etc/nginx/sites-available/nginx-arb4me-backend.conf /etc/nginx/sites-enabled/');
        console.log('   sudo nginx -t && sudo systemctl reload nginx');
    } catch (error) {
        console.log('⚠️  Failed to create nginx config:', error.message);
    }
}

async function createPM2Config() {
    const pm2Config = {
        apps: [{
            name: 'arb4me-backend',
            script: 'server.js',
            instances: 'max',
            exec_mode: 'cluster',
            env: {
                NODE_ENV: 'production',
                PORT: process.env.PORT || 3000
            },
            error_file: './logs/pm2-error.log',
            out_file: './logs/pm2-out.log',
            log_file: './logs/pm2-combined.log',
            time: true,
            watch: false,
            max_memory_restart: '1G',
            node_args: '--max-old-space-size=1024'
        }]
    };
    
    try {
        await fs.writeFile('ecosystem.config.js', 
            `module.exports = ${JSON.stringify(pm2Config, null, 2)};`);
        console.log('✅ Created PM2 configuration: ecosystem.config.js');
        console.log('   To use PM2:');
        console.log('   npm install -g pm2');
        console.log('   pm2 start ecosystem.config.js');
        console.log('   pm2 save && pm2 startup');
    } catch (error) {
        console.log('⚠️  Failed to create PM2 config:', error.message);
    }
}

async function displaySummary() {
    console.log('');
    console.log('🎉 ARB4ME Backend Deployment Complete!');
    console.log('=====================================');
    console.log('');
    console.log('📋 Next Steps:');
    console.log('1. Configure your .env file with production settings');
    console.log('2. Set up SSL certificates for HTTPS');
    console.log('3. Configure your reverse proxy (nginx config provided)');
    console.log('4. Set up process management (systemd or PM2 configs provided)');
    console.log('5. Configure database backups');
    console.log('6. Set up monitoring and log rotation');
    console.log('');
    console.log('🚀 Start the server:');
    console.log('   npm start                    # Direct start');
    console.log('   pm2 start ecosystem.config.js # PM2 cluster mode');
    console.log('   sudo systemctl start arb4me-backend # Systemd service');
    console.log('');
    console.log('🔍 Monitor:');
    console.log('   curl http://localhost:3000/health  # Health check');
    console.log('   tail -f logs/combined.log          # View logs');
    console.log('   pm2 logs                           # PM2 logs');
    console.log('');
    console.log('📚 API Documentation available in README.md');
}

async function main() {
    try {
        await checkPrerequisites();
        await checkEnvironment();
        await installDependencies();
        await createDirectories();
        await runDatabaseMigration();
        await createSystemdService();
        await createNginxConfig();
        await createPM2Config();
        await displaySummary();
    } catch (error) {
        console.error('❌ Deployment failed:', error.message);
        process.exit(1);
    }
}

// Run deployment if script is executed directly
if (require.main === module) {
    main();
}

module.exports = { main };