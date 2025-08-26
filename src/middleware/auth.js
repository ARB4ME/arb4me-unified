const jwt = require('jsonwebtoken');
const { query } = require('../database/connection');
const { APIError } = require('./errorHandler');
const { systemLogger } = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Authenticate user middleware
const authenticateUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        console.log(`🔐 Auth check for ${req.method} ${req.originalUrl} - Header: ${authHeader ? 'Present' : 'Missing'}`);
        
        const token = authHeader?.split(' ')[1];
        
        if (!token) {
            console.log('❌ No token found in Authorization header');
            throw new APIError('Authentication token required', 401, 'TOKEN_REQUIRED');
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log(`🎫 Token decoded - userId: ${decoded.userId}, admin_role: ${decoded.admin_role || 'none'}`);
        
        // Get user details from database
        const userResult = await query(
            'SELECT id, first_name, last_name, email, admin_role, account_status FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (userResult.rows.length === 0) {
            // Special case: If JWT has admin_role, create minimal user object from JWT
            if (decoded.admin_role) {
                console.log(`✅ User ${decoded.userId} not found in DB, but JWT has admin_role: ${decoded.admin_role} - Creating user object from JWT`);
                req.user = {
                    id: decoded.userId,
                    admin_role: decoded.admin_role,
                    account_status: 'active',
                    first_name: 'Master',
                    last_name: 'Admin',
                    email: 'master@arb4me.com'
                };
                return next();
            }
            console.log(`❌ User ${decoded.userId} not found and no admin_role in JWT`);
            throw new APIError('User not found', 401, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        if (user.account_status !== 'active') {
            throw new APIError('Account is not active', 401, 'ACCOUNT_INACTIVE');
        }
        
        // If database doesn't have admin_role but JWT does, use JWT's admin_role
        if (!user.admin_role && decoded.admin_role) {
            user.admin_role = decoded.admin_role;
            console.log(`Using admin_role from JWT: ${decoded.admin_role} for user ${user.id}`);
        }
        
        req.user = user;
        next();
        
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            systemLogger.security('Invalid JWT token used', {
                ip: req.ip,
                userAgent: req.get('User-Agent'),
                endpoint: req.originalUrl
            });
            next(new APIError('Invalid authentication token', 401, 'INVALID_TOKEN'));
        } else if (error.name === 'TokenExpiredError') {
            next(new APIError('Authentication token has expired', 401, 'EXPIRED_TOKEN'));
        } else {
            next(error);
        }
    }
};

// Require admin role middleware
const requireAdmin = (req, res, next) => {
    if (!req.user) {
        return next(new APIError('Authentication required', 401, 'AUTH_REQUIRED'));
    }
    
    if (!req.user.admin_role) {
        systemLogger.security('Non-admin user attempted to access admin endpoint', {
            userId: req.user.id,
            endpoint: req.originalUrl,
            ip: req.ip
        });
        return next(new APIError('Admin privileges required', 403, 'INSUFFICIENT_PRIVILEGES'));
    }
    
    next();
};

// Require specific admin role middleware
const requireAdminRole = (minRole) => {
    const roleHierarchy = {
        'support': 1,
        'manager': 2,
        'admin': 3,
        'master': 4
    };
    
    return (req, res, next) => {
        console.log(`🛡️ Admin role check - Required: ${minRole}, User has: ${req.user?.admin_role || 'none'}, User ID: ${req.user?.id || 'no user'}`);
        
        if (!req.user || !req.user.admin_role) {
            console.log('❌ No user or admin_role in request');
            return next(new APIError('Admin privileges required', 403, 'INSUFFICIENT_PRIVILEGES'));
        }
        
        const userRoleLevel = roleHierarchy[req.user.admin_role] || 0;
        const requiredRoleLevel = roleHierarchy[minRole] || 999;
        
        console.log(`🔢 Role levels - User: ${userRoleLevel} (${req.user.admin_role}), Required: ${requiredRoleLevel} (${minRole})`);
        
        if (userRoleLevel < requiredRoleLevel) {
            systemLogger.security('Insufficient admin privileges attempted', {
                userId: req.user.id,
                userRole: req.user.admin_role,
                requiredRole: minRole,
                endpoint: req.originalUrl,
                ip: req.ip
            });
            return next(new APIError('Insufficient admin privileges', 403, 'INSUFFICIENT_PRIVILEGES'));
        }
        
        console.log(`✅ Admin role check passed for ${req.user.id}`);
        next();
    };
};

// Optional authentication (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return next(); // No token, continue without user
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const userResult = await query(
            'SELECT id, first_name, last_name, email, admin_role, account_status FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (userResult.rows.length > 0 && userResult.rows[0].account_status === 'active') {
            req.user = userResult.rows[0];
        }
        
        next();
        
    } catch (error) {
        // Token invalid, but that's okay for optional auth
        next();
    }
};

// Check if user owns resource or is admin
const requireOwnershipOrAdmin = (userIdField = 'user_id') => {
    return (req, res, next) => {
        if (!req.user) {
            return next(new APIError('Authentication required', 401, 'AUTH_REQUIRED'));
        }
        
        // Admin can access anything
        if (req.user.admin_role) {
            return next();
        }
        
        // Check ownership
        const resourceUserId = req.params[userIdField] || req.body[userIdField] || req.query[userIdField];
        
        if (req.user.id !== resourceUserId) {
            systemLogger.security('User attempted to access resource they do not own', {
                userId: req.user.id,
                attemptedResourceUserId: resourceUserId,
                endpoint: req.originalUrl,
                ip: req.ip
            });
            return next(new APIError('Access denied', 403, 'ACCESS_DENIED'));
        }
        
        next();
    };
};

module.exports = {
    authenticateUser,
    requireAdmin,
    requireAdminRole,
    optionalAuth,
    requireOwnershipOrAdmin
};