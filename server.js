// ARB4ME Backend Server
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
// const helmet = require('helmet'); // Disabled for inline scripts
const compression = require('compression');
const morgan = require('morgan');
const { createServer } = require('http');
const { Server } = require('socket.io');

// Import configurations and utilities
const { logger } = require('./src/utils/logger');
const { connectDatabase } = require('./src/database/connection');
const { setupWebSocket } = require('./src/websocket/socketManager');
const { errorHandler } = require('./src/middleware/errorHandler');
const { generalRateLimit } = require('./src/middleware/rateLimiter');

// Import routes
const authRoutes = require('./src/routes/auth.routes');
const userRoutes = require('./src/routes/user.routes');
const messageRoutes = require('./src/routes/message.routes');
const adminRoutes = require('./src/routes/admin.routes');
const tradingRoutes = require('./src/routes/trading.routes');
const billingRoutes = require('./src/routes/billing.routes');
const migrationRoutes = require('./src/routes/migration.routes');
const tradingActivityRoutes = require('./src/routes/trading-activity.routes');
const analyticsRoutes = require('./src/routes/analytics.routes');

// Initialize Express app
const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
const io = new Server(httpServer, {
    cors: {
        origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:8080'],
        credentials: true
    }
});

// Global middleware
// Helmet disabled to allow inline scripts in PWA
// app.use(helmet({
//     contentSecurityPolicy: false,
//     crossOriginEmbedderPolicy: false
// }));
app.use(compression());
app.use(cors({
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:8080'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV
    });
});

// API version prefix
const API_PREFIX = '/api/v1';

// Apply rate limiting to all API routes
app.use(API_PREFIX, generalRateLimit);

// API Routes
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/user`, userRoutes);
app.use(`${API_PREFIX}/messages`, messageRoutes);
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/admin/payments`, billingRoutes);
app.use(`${API_PREFIX}/migration`, migrationRoutes);
app.use(`${API_PREFIX}/trading`, tradingRoutes);
app.use(`${API_PREFIX}/trading-activity`, tradingActivityRoutes);
app.use(`${API_PREFIX}/analytics`, analyticsRoutes);

// Serve PWA static files
app.use(express.static('public'));

// PWA route handler - serve index.html for all non-API routes
app.get('*', (req, res) => {
    // Don't serve PWA for API routes
    if (req.path.startsWith(API_PREFIX) || req.path === '/health') {
        return res.status(404).json({
            success: false,
            error: {
                code: 'NOT_FOUND',
                message: 'The requested API endpoint was not found'
            }
        });
    }
    
    // Serve PWA for all other routes (SPA routing)
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use(errorHandler);

// Start server
async function startServer() {
    try {
        // Connect to database (optional)
        const dbConnection = await connectDatabase();
        if (dbConnection) {
            logger.info('Database connected successfully');
            
            // Skip automatic migration - should be run separately
            // Migration can be triggered via npm run migrate
        } else {
            logger.warn('Running without database - PWA will use localStorage only');
        }

        // Setup WebSocket
        setupWebSocket(io);
        logger.info('WebSocket server initialized');

        // Start HTTP server
        const PORT = process.env.PORT || 3000;
        httpServer.listen(PORT, () => {
            logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
            logger.info(`API available at http://localhost:${PORT}${API_PREFIX}`);
        });

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
    logger.error('Unhandled Rejection:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    httpServer.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
    });
});

// Start the server
startServer();

module.exports = { app, io };