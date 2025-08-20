const rateLimit = require('express-rate-limit');
const { systemLogger } = require('../utils/logger');

// Store for tracking rate limit violations
const rateLimitViolations = new Map();

// Custom handler for when rate limit is exceeded
const rateLimitHandler = (req, res) => {
    const clientId = req.ip || req.connection.remoteAddress;
    const currentTime = Date.now();
    
    // Track violations
    if (!rateLimitViolations.has(clientId)) {
        rateLimitViolations.set(clientId, []);
    }
    
    const violations = rateLimitViolations.get(clientId);
    violations.push(currentTime);
    
    // Clean up old violations (older than 1 hour)
    const oneHourAgo = currentTime - (60 * 60 * 1000);
    const recentViolations = violations.filter(time => time > oneHourAgo);
    rateLimitViolations.set(clientId, recentViolations);
    
    // Log security event
    systemLogger.security('Rate limit exceeded', {
        ip: clientId,
        userAgent: req.get('User-Agent'),
        endpoint: req.originalUrl,
        method: req.method,
        violationsInLastHour: recentViolations.length,
        userId: req.user?.id
    });
    
    // Send rate limit response
    res.status(429).json({
        success: false,
        error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
            retryAfter: Math.round(req.rateLimit.resetTime / 1000)
        }
    });
};

// Skip rate limiting for certain conditions
const rateLimitSkip = (req) => {
    // Skip for health checks
    if (req.path === '/health') {
        return true;
    }
    
    // Skip for admin users (if authenticated and admin)
    if (req.user && req.user.admin_role) {
        return true;
    }
    
    return false;
};

// General API rate limiter (100 requests per 15 minutes per IP)
const generalRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    handler: rateLimitHandler,
    skip: rateLimitSkip,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Use user ID if authenticated, otherwise use IP
        return req.user?.id || req.ip;
    }
});

// Strict rate limiter for authentication endpoints (5 requests per 15 minutes per IP)
const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: 'Too many authentication attempts, please try again later.',
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip // Always use IP for auth attempts
});

// Relaxed rate limiter for authenticated users (200 requests per 15 minutes)
const authenticatedRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: 'Too many requests, please try again later.',
    handler: rateLimitHandler,
    skip: (req) => !req.user || rateLimitSkip(req),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip
});

// Admin-specific rate limiter (500 requests per 15 minutes)
const adminRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500,
    message: 'Too many admin requests, please try again later.',
    handler: rateLimitHandler,
    skip: (req) => !req.user || !req.user.admin_role,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip
});

// Trading activity rate limiter (more permissive for active traders)
const tradingRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 50, // 50 requests per 5 minutes for trading operations
    message: 'Too many trading requests, please wait before trying again.',
    handler: rateLimitHandler,
    skip: rateLimitSkip,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip
});

// Ticker data rate limiter (very permissive for price fetching)
const tickerRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute for ticker/price data
    message: 'Too many price data requests, please wait before trying again.',
    handler: rateLimitHandler,
    skip: rateLimitSkip,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip
});

// Message rate limiter (prevent spam)
const messageRateLimit = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 messages per minute
    message: 'Too many messages sent, please wait before sending another.',
    handler: rateLimitHandler,
    skip: rateLimitSkip,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip
});

// Cleanup function to remove old violation records
setInterval(() => {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    for (const [clientId, violations] of rateLimitViolations.entries()) {
        const recentViolations = violations.filter(time => time > oneHourAgo);
        
        if (recentViolations.length === 0) {
            rateLimitViolations.delete(clientId);
        } else {
            rateLimitViolations.set(clientId, recentViolations);
        }
    }
}, 60 * 60 * 1000); // Run cleanup every hour

// Export rate limiters
module.exports = {
    generalRateLimit,
    authRateLimit,
    authenticatedRateLimit,
    adminRateLimit,
    tradingRateLimit,
    tickerRateLimit,
    messageRateLimit,
    rateLimitViolations
};