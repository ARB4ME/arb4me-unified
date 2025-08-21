const { logger, systemLogger } = require('../utils/logger');

// Custom error class for API errors
class APIError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.name = 'APIError';
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;
    }
}

// Database error handler
const handleDatabaseError = (error) => {
    if (error.code === '23505') { // Unique constraint violation
        // Include constraint details for debugging
        const constraintInfo = error.constraint || error.detail || 'Unknown constraint';
        return new APIError(`Resource already exists: ${constraintInfo}`, 409, 'DUPLICATE_ENTRY');
    }
    
    if (error.code === '23503') { // Foreign key constraint violation
        return new APIError('Referenced resource not found', 400, 'INVALID_REFERENCE');
    }
    
    if (error.code === '23502') { // Not null constraint violation
        return new APIError('Required field is missing', 400, 'MISSING_FIELD');
    }
    
    if (error.code === '42703') { // Undefined column
        return new APIError('Invalid field specified', 400, 'INVALID_FIELD');
    }
    
    // Generic database error
    systemLogger.error('Database error', error);
    return new APIError('Database operation failed', 500, 'DATABASE_ERROR');
};

// JWT error handler
const handleJWTError = (error) => {
    if (error.name === 'JsonWebTokenError') {
        return new APIError('Invalid authentication token', 401, 'INVALID_TOKEN');
    }
    
    if (error.name === 'TokenExpiredError') {
        return new APIError('Authentication token has expired', 401, 'EXPIRED_TOKEN');
    }
    
    return new APIError('Authentication failed', 401, 'AUTH_FAILED');
};

// Validation error handler
const handleValidationError = (error) => {
    const validationErrors = error.array ? error.array() : [error];
    const messages = validationErrors.map(err => err.msg || err.message).join(', ');
    return new APIError(`Validation failed: ${messages}`, 400, 'VALIDATION_ERROR');
};

// Main error handler middleware
const errorHandler = (error, req, res, next) => {
    let err = error;
    
    // Handle different error types
    if (error.code && error.code.startsWith('23')) {
        err = handleDatabaseError(error);
    } else if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        err = handleJWTError(error);
    } else if (error.name === 'ValidationError' || error.array) {
        err = handleValidationError(error);
    } else if (error.name === 'CastError') {
        err = new APIError('Invalid resource ID format', 400, 'INVALID_ID');
    } else if (!error.isOperational) {
        // Handle unexpected errors
        err = new APIError('Something went wrong', 500, 'INTERNAL_ERROR');
    }
    
    // Log the error
    const errorContext = {
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id,
        body: req.method !== 'GET' ? req.body : undefined,
        params: req.params,
        query: req.query
    };
    
    if (err.statusCode >= 500) {
        systemLogger.error('Server error occurred', err, errorContext);
    } else if (err.statusCode >= 400) {
        systemLogger.api(`Client error: ${err.message}`, errorContext);
    }
    
    // Send error response
    const response = {
        success: false,
        error: {
            code: err.code || 'UNKNOWN_ERROR',
            message: err.message || 'An unexpected error occurred'
        }
    };
    
    // Include additional error details in development
    if (process.env.NODE_ENV === 'development') {
        response.error.stack = err.stack;
        response.error.details = errorContext;
    }
    
    // Handle specific ARB4ME business logic errors
    if (err.code === 'USER_NOT_FOUND') {
        systemLogger.security('Attempt to access non-existent user', errorContext);
    } else if (err.code === 'INSUFFICIENT_PRIVILEGES') {
        systemLogger.security('Unauthorized access attempt', errorContext);
    } else if (err.code === 'TRADING_NOT_CONFIGURED') {
        systemLogger.user('User attempted trading without proper configuration', errorContext);
    }
    
    res.status(err.statusCode || 500).json(response);
};

// Async error wrapper - catches async errors and passes to error handler
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 404 handler
const notFoundHandler = (req, res) => {
    systemLogger.api(`404 - Resource not found: ${req.originalUrl}`, {
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });
    
    res.status(404).json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: 'The requested resource was not found'
        }
    });
};

module.exports = {
    APIError,
    errorHandler,
    asyncHandler,
    notFoundHandler
};