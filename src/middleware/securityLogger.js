// Security Event Logging Middleware
const { query } = require('../database/connection');
const { logSecurityEvent } = require('./adminPermissions');

/**
 * Log successful admin login
 */
async function logAdminLogin(userId, ipAddress, userAgent, sessionId) {
    try {
        // Log to security events
        await logSecurityEvent(
            'admin_login',
            'info',
            userId,
            ipAddress,
            userAgent,
            {
                session_id: sessionId,
                timestamp: new Date().toISOString()
            }
        );
        
        // Create session record
        await query(
            'SELECT create_user_session($1, $2, $3, $4, $5, $6)',
            [sessionId, userId, ipAddress, userAgent, 'web', true]
        );
    } catch (error) {
        console.error('Error logging admin login:', error);
    }
}

/**
 * Log failed login attempt
 */
async function logFailedLogin(email, ipAddress, userAgent, reason) {
    try {
        // Check for user ID by email
        const userResult = await query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        
        const userId = userResult.rows[0]?.id || null;
        
        // Log security event
        await logSecurityEvent(
            'failed_login',
            'medium',
            userId,
            ipAddress,
            userAgent,
            {
                email,
                reason,
                timestamp: new Date().toISOString()
            }
        );
        
        // Check for brute force attempts (5+ failures in 5 minutes)
        const recentFailures = await query(`
            SELECT COUNT(*) as failure_count 
            FROM security_events 
            WHERE event_type = 'failed_login' 
            AND ip_address = $1 
            AND created_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        `, [ipAddress]);
        
        if (recentFailures.rows[0]?.failure_count >= 5) {
            await logSecurityEvent(
                'brute_force_detected',
                'critical',
                userId,
                ipAddress,
                userAgent,
                {
                    email,
                    failure_count: recentFailures.rows[0].failure_count,
                    timestamp: new Date().toISOString()
                }
            );
        }
    } catch (error) {
        console.error('Error logging failed login:', error);
    }
}

/**
 * Log admin logout
 */
async function logAdminLogout(userId, sessionId, ipAddress, userAgent) {
    try {
        // Log security event
        await logSecurityEvent(
            'admin_logout',
            'info',
            userId,
            ipAddress,
            userAgent,
            {
                session_id: sessionId,
                timestamp: new Date().toISOString()
            }
        );
        
        // End session
        await query(
            'SELECT end_user_session($1)',
            [sessionId]
        );
    } catch (error) {
        console.error('Error logging admin logout:', error);
    }
}

/**
 * Log suspicious activity
 */
async function logSuspiciousActivity(userId, activityType, details, ipAddress, userAgent) {
    try {
        await logSecurityEvent(
            'suspicious_activity',
            'high',
            userId,
            ipAddress,
            userAgent,
            {
                activity_type: activityType,
                details,
                timestamp: new Date().toISOString()
            }
        );
    } catch (error) {
        console.error('Error logging suspicious activity:', error);
    }
}

/**
 * Update session activity
 */
async function updateSessionActivity(sessionId) {
    try {
        await query(
            'SELECT update_session_activity($1)',
            [sessionId]
        );
    } catch (error) {
        console.error('Error updating session activity:', error);
    }
}

/**
 * Middleware to track session activity
 */
function sessionActivityTracker() {
    return (req, res, next) => {
        const sessionId = req.headers['x-session-id'];
        
        if (sessionId && req.user) {
            updateSessionActivity(sessionId);
        }
        
        next();
    };
}

module.exports = {
    logAdminLogin,
    logFailedLogin,
    logAdminLogout,
    logSuspiciousActivity,
    updateSessionActivity,
    sessionActivityTracker
};