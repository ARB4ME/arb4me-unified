// Admin Permissions Middleware
const { query } = require('../database/connection');
const { APIError } = require('../utils/errors');

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
        const result = await query(
            'SELECT admin_has_permission($1, $2) as has_permission',
            [role, permission]
        );
        
        return result.rows[0]?.has_permission || false;
    } catch (error) {
        console.error('Error checking admin permission:', error);
        return false;
    }
}

/**
 * Log admin activity
 */
async function logAdminActivity(adminUserId, action, targetType, targetId, details, ipAddress, userAgent) {
    try {
        await query(
            'SELECT log_admin_activity($1, $2, $3, $4, $5, $6, $7)',
            [adminUserId, action, targetType, targetId, details, ipAddress, userAgent]
        );
    } catch (error) {
        console.error('Error logging admin activity:', error);
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

module.exports = {
    requirePermission,
    requireRole,
    requireMaster,
    requireAdmin,
    requireManager,
    checkAdminPermission,
    logAdminActivity,
    updateAdminLastAccess
};