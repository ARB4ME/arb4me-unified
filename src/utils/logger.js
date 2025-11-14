const winston = require('winston');
const path = require('path');

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
        
        // Add metadata if present
        if (Object.keys(meta).length > 0) {
            log += ` | ${JSON.stringify(meta)}`;
        }
        
        // Add stack trace for errors
        if (stack) {
            log += `\n${stack}`;
        }
        
        return log;
    })
);

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
require('fs').mkdirSync(logsDir, { recursive: true });

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    transports: [
        // Console output (all levels in development)
        new winston.transports.Console({
            level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        
        // Error log file
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
            tailable: true
        }),
        
        // Combined log file
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true
        }),
        
        // ARB4ME specific logs
        new winston.transports.File({
            filename: path.join(logsDir, 'arb4me.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    ]
});

// Create specific loggers for different system components
const systemLogger = {
    // Generic info logging
    info: (message, meta = {}) => logger.info(`[INFO] ${message}`, meta),

    // Generic warning logging
    warn: (message, meta = {}) => logger.warn(`[WARN] ${message}`, meta),

    // Authentication events
    auth: (message, meta = {}) => logger.info(`[AUTH] ${message}`, meta),

    // User activity
    user: (message, meta = {}) => logger.info(`[USER] ${message}`, meta),

    // Admin actions
    admin: (message, meta = {}) => logger.info(`[ADMIN] ${message}`, meta),

    // Trading activity
    trading: (message, meta = {}) => logger.info(`[TRADING] ${message}`, meta),

    // Database operations
    database: (message, meta = {}) => logger.info(`[DATABASE] ${message}`, meta),

    // WebSocket events
    websocket: (message, meta = {}) => logger.info(`[WEBSOCKET] ${message}`, meta),

    // API requests
    api: (message, meta = {}) => logger.info(`[API] ${message}`, meta),

    // Security events
    security: (message, meta = {}) => logger.warn(`[SECURITY] ${message}`, meta),

    // System errors
    error: (message, error, meta = {}) => {
        const errorMeta = {
            ...meta,
            error: error instanceof Error ? {
                message: error.message,
                stack: error.stack,
                name: error.name
            } : error
        };
        logger.error(`[ERROR] ${message}`, errorMeta);
    }
};

// Log system startup
logger.info('ARB4ME Backend Logger initialized', {
    logLevel: logger.level,
    environment: process.env.NODE_ENV,
    logsDirectory: logsDir
});

module.exports = {
    logger,
    systemLogger
};