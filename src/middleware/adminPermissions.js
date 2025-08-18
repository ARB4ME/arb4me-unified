// Admin Permissions Middleware
const { query } = require('../database/connection');
const { APIError } = require('./errorHandler');

/**
 * Middleware to check if admin has required permission
 * @param {string} requiredPermission - The permission required for this action
 * @returns {Function} Express middleware function
 */
function requirePermission(requiredPermission) {
    return async (req, res, next) => {
        try {
            // Get user info from JWT (assuming it's already attached by auth middleware)
            const userId = req.user?.id;
            const userRole = req.user?.admin_role;
            
            if (!userId || !userRole) {
                throw new APIError('Admin authentication required', 401, 'ADMIN_AUTH_REQUIRED');
            }
            
            // Check if user has the required permission
            const hasPermission = await checkAdminPermission(userRole, requiredPermission);
            
            if (!hasPermission) {
                // Log unauthorized access attempt
                await logAdminActivity(
                    userId,
                    'unauthorized_access_attempt',
                    'permission',
                    requiredPermission,
                    { attempted_action: req.path, method: req.method },
                    req.ip,
                    req.get('User-Agent')
                );
                
                throw new APIError(
                    `Insufficient permissions. Required: ${requiredPermission}`,
                    403,
                    'INSUFFICIENT_PERMISSIONS'
                );
            }
            
            // Update last access time
            await updateAdminLastAccess(userId);
            
            next();
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Check if admin role has specific permission
 * @param {string} role - Admin role
 * @param {string} permission - Permission to check
 * @returns {boolean} - Has permission or not
 */
async function checkAdminPermission(role, permission) {
    try {
        // Check if admin_permissions table exists and function is available
        const result = await query(
            'SELECT admin_has_permission($1, $2) as has_permission',
            [role, permission]
        );
        
        return result.rows[0]?.has_permission || false;
    } catch (error) {
        console.error('Error checking admin permission:', error);
        // Fallback: If migration hasn't run yet, allow master admin all permissions
        if (role === 'master') {
            return true;
        }
        // For other roles, check basic permissions
        const basicPermissions = {
            'admin': ['users.view', 'users.activate', 'users.suspend', 'users.bulk_operations', 'admins.view'],
            'manager': ['users.view', 'users.activate', 'users.suspend'],
            'support': ['users.view', 'messages.view', 'messages.reply']
        };
        
        return basicPermissions[role]?.includes(permission) || false;
    }
}

/**
 * Log admin activity
 */
async function logAdminActivity(adminUserId, action, targetType, targetId, details, ipAddress, userAgent, options = {}) {
    try {
        // Use enhanced logging function if available, fallback to basic
        const {
            category = 'admin_actions',
            severity = 'info',
            beforeState = null,
            afterState = null,
            sessionId = null,
            requestMethod = null,
            requestUrl = null,
            responseStatus = null,
            durationMs = null
        } = options;

        await query(
            'SELECT log_admin_activity_enhanced($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
            [
                adminUserId, action, category, severity, targetType, targetId,
                details, beforeState, afterState, ipAddress, userAgent, sessionId,
                requestMethod, requestUrl, responseStatus, durationMs
            ]
        );
    } catch (error) {
        console.error('Error logging admin activity:', error);
        // Fallback to basic logging
        try {
            await query(
                'SELECT log_admin_activity($1, $2, $3, $4, $5, $6, $7)',
                [adminUserId, action, targetType, targetId, details, ipAddress, userAgent]
            );
        } catch (fallbackError) {
            console.log(`Admin Activity: ${adminUserId} performed ${action} on ${targetType}:${targetId}`, details);
        }
    }
}

async function logSecurityEvent(eventType, severity, userId, ipAddress, userAgent, details) {
    try {
        const result = await query(
            'SELECT log_security_event($1, $2, $3, $4, $5, $6)',
            [eventType, severity, userId, ipAddress, userAgent, details]
        );
        return result.rows[0]?.log_security_event;
    } catch (error) {
        console.error('Error logging security event:', error);
        console.log(`Security Event: ${eventType} (${severity}) for user ${userId}`, details);
        return null;
    }
}

/**
 * Update admin last access time
 */
async function updateAdminLastAccess(adminUserId) {
    try {
        await query(
            'UPDATE users SET admin_last_access = CURRENT_TIMESTAMP WHERE id = $1',
            [adminUserId]
        );
    } catch (error) {
        console.error('Error updating admin last access:', error);
    }
}

/**
 * Middleware to require specific admin role level
 * @param {string|string[]} requiredRoles - Role(s) required
 * @returns {Function} Express middleware function
 */
function requireRole(requiredRoles) {
    const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
    
    return (req, res, next) => {
        const userRole = req.user?.admin_role;
        
        if (!userRole || !roles.includes(userRole)) {
            return next(new APIError(
                `Access denied. Required role: ${roles.join(' or ')}`,
                403,
                'INSUFFICIENT_ROLE'
            ));
        }
        
        next();
    };
}

/**
 * Middleware to require master admin role
 */
const requireMaster = requireRole('master');

/**
 * Middleware to require admin or master role
 */
const requireAdmin = requireRole(['admin', 'master']);

/**
 * Middleware to require manager, admin, or master role
 */
const requireManager = requireRole(['manager', 'admin', 'master']);

/**
 * Enhanced logging middleware that captures request/response details
 */
function adminActivityLogger(category = 'admin_actions', severity = 'info') {
    return (req, res, next) => {
        const startTime = Date.now();
        
        // Capture original res.json to log response status
        const originalJson = res.json;
        res.json = function(data) {
            const duration = Date.now() - startTime;
            
            // Log the admin activity with enhanced details
            if (req.user && req.user.admin_role) {
                const action = `${req.method} ${req.route?.path || req.path}`;
                logAdminActivity(
                    req.user.id,
                    action,
                    category,
                    req.params?.userId || req.params?.id,
                    {
                        method: req.method,
                        url: req.originalUrl,
                        body: req.body,
                        params: req.params,
                        query: req.query,
                        response: data
                    },
                    req.ip,
                    req.get('User-Agent'),
                    {
                        category,
                        severity,
                        sessionId: req.headers['x-session-id'],
                        requestMethod: req.method,
                        requestUrl: req.originalUrl,
                        responseStatus: res.statusCode,
                        durationMs: duration
                    }
                );
            }
            
            return originalJson.call(this, data);
        };
        
        next();
    };
}

module.exports = {
    requirePermission,
    requireRole,
    requireMaster,
    requireAdmin,
    requireManager,
    checkAdminPermission,
    logAdminActivity,
    logSecurityEvent,
    updateAdminLastAccess,
    adminActivityLogger
};