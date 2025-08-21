const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');

const router = express.Router();

// JWT secret and expiry
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

// Validation rules
const registerValidation = [
    body('firstName').trim().isLength({ min: 2, max: 50 }).withMessage('First name must be 2-50 characters'),
    body('lastName').trim().isLength({ min: 2, max: 50 }).withMessage('Last name must be 2-50 characters'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('mobile').isLength({ min: 10, max: 15 }).withMessage('Mobile number must be 10-15 digits'),
    body('country').isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
];

const loginValidation = [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
];

// Helper function to generate JWT
const generateToken = (userId) => {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
};

// Helper function to generate unified user ID and payment reference
const generateUserIdAndPaymentRef = async (client) => {
    // Use timestamp + high entropy random for uniqueness (under 10 digits)
    const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0'); // 4-digit random
    const shortId = timestamp + random; // Total: 10 digits max
    
    console.log('🔍 Generated unique timestamp ID:', shortId);
    
    return {
        userId: `user_${shortId}`,
        paymentReference: null // Will be set to NULL, no sequence conflicts
    };
};

// Apply auth rate limiting to all routes
router.use(authRateLimit);

// POST /api/v1/auth/register - Register new user
router.post('/register', registerValidation, asyncHandler(async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const errorMessages = errors.array().map(error => `${error.param}: ${error.msg}`).join(', ');
        throw new APIError(`Validation failed: ${errorMessages}`, 400, 'VALIDATION_ERROR');
    }
    
    const { firstName, lastName, email, mobile, country, password } = req.body;
    
    console.log('🔍 Registration attempt:', { email, firstName, lastName, country });
    systemLogger.auth('Registration attempt started', { email, firstName, lastName });
    
    const transactionResult = await transaction(async (client) => {
        console.log('🔍 Transaction started for:', email);
        // Check if user already exists - EXACT same query as debug endpoint
        console.log(`🔍 About to check for existing user with email: "${email}"`);
        const existingUser = await client.query(
            'SELECT id, first_name, last_name, email FROM users WHERE email = $1',
            [email]
        );
        
        console.log(`🔍 Existing user query result: Found ${existingUser.rows.length} users`);
        if (existingUser.rows.length > 0) {
            console.log(`🔍 Found users:`, existingUser.rows);
        }
        
        if (existingUser.rows.length > 0) {
            console.log(`🔍 User already exists: ${existingUser.rows[0].id} - ${existingUser.rows[0].first_name} ${existingUser.rows[0].last_name} - ${existingUser.rows[0].email}`);
            // Include debug info in the error for troubleshooting
            throw new APIError(`User with this email already exists. Debug: Found ${existingUser.rows.length} users: ${JSON.stringify(existingUser.rows)}`, 409, 'USER_EXISTS');
        }
        
        console.log(`🔍 No existing user found for ${email}, proceeding with registration`);
        
        // Hash password
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        
        // Generate unified user ID and payment reference
        const { userId, paymentReference } = await generateUserIdAndPaymentRef(client);
        
        console.log('🔍 Generated userId:', userId, 'paymentRef:', paymentReference);
        
        // Insert user with NULL payment_reference (like working debug users)
        console.log('🔍 Attempting to insert user into database...');
        const userResult = await client.query(
            `INSERT INTO users (id, first_name, last_name, email, mobile, country, password_hash, account_status, payment_reference) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL) 
             RETURNING id, first_name, last_name, email, created_at, payment_reference`,
            [userId, firstName, lastName, email, mobile, country, passwordHash]
        );
        
        console.log('🔍 User insert result:', userResult.rowCount, 'rows affected');
        const user = userResult.rows[0];
        console.log('🔍 User created:', user.id, user.email);
        
        // Create trading activity record
        await client.query(
            'INSERT INTO trading_activity (user_id) VALUES ($1)',
            [userId]
        );
        
        // Log registration
        systemLogger.auth('New user registered', {
            userId: userId,
            email: email,
            ip: req.ip,
            userAgent: req.get('User-Agent')
        });
        
        // Log user activity
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [userId, 'registration', { email }, req.ip, req.get('User-Agent')]
        );
        
        // Send welcome message
        await client.query(
            `INSERT INTO messages (user_id, subject, content, message_type, status, admin_user_id) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                userId,
                'Welcome to ARB4ME - Complete Setup Guide to Activate Trading',
                `🎉 Welcome to ARB4ME!

Hi ${firstName}! 👋

Congratulations on joining the ARB4ME arbitrage trading platform! We're excited to have you on board.

🚀 **TO ACTIVATE TRADING, PLEASE FOLLOW THESE STEPS:**

**Step 1:** Go to the SETTINGS button on the dashboard and set your screen timeout setting.

**Step 2:** Go to the PROFILE button on the dashboard and update your profile if required.

**Step 3:** Go to the ABOUT button on the dashboard and read all the about info.

**Step 4:** Go to the ARB INFO button on the dashboard and read all the info.

**Step 5:** Go to the API button on the dashboard and read how to get your APIs.

**Step 6:** Register on your favorite Crypto Exchanges and complete the verification processes.

**Step 7:** Get your API keys from the exchanges and insert them into the SETUP section of the App. The SETUP button is on the dashboard.

**Step 8:** Fund your selected exchanges and ensure you have USDT available to arbitrage.

**Step 9:** Go to SETTINGS button on the Dashboard and select the Crypto Assets you want to arbitrage. While on the SETTINGS page, tick the 4 Safety Trading Controls and set your MAXIMUM SINGLE TRADE to the lowest setting. Finally, also on the Settings page, set your Trading Parameters.

✅ **FINAL STEP:** Once you have completed all these steps, you will be able to switch the AUTO Trading from OFF to ON by clicking on it.

🔒 **Security Reminder:**
Your account is protected with advanced security features. Always use strong passwords and enable screen lock for maximum security.

If you have any questions during setup, don't hesitate to reach out through this messaging system!

Happy trading! 📈
The ARB4ME Team`,
                'admin_to_user',
                'sent',
                'user_admin_master'
            ]
        );
        
        console.log('🔍 Transaction completed successfully for user:', userId);
        
        // Generate token
        const token = generateToken(userId);
        
        // Return the result to be handled after transaction
        return { user, token };
    });
    
    console.log('🔍 Transaction committed, sending response...');
    
    // Verify the user was actually saved
    const verifyResult = await query('SELECT id, email FROM users WHERE id = $1', [transactionResult?.user?.id]);
    console.log(`🔍 Verification: User ${transactionResult?.user?.id} exists in DB: ${verifyResult.rows.length > 0}`);
    
    if (transactionResult) {
        const { user, token } = transactionResult;
        res.status(201).json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    email: user.email,
                    createdAt: user.created_at,
                    paymentReference: user.payment_reference
                },
                token
            },
            message: 'Registration successful'
        });
    } else {
        console.error('🔴 No transaction result returned');
        throw new APIError('Registration failed - no result', 500, 'REGISTRATION_FAILED');
    }
}));

// POST /api/v1/auth/login - User login
router.post('/login', loginValidation, asyncHandler(async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const errorMessages = errors.array().map(error => `${error.param}: ${error.msg}`).join(', ');
        throw new APIError(`Validation failed: ${errorMessages}`, 400, 'VALIDATION_ERROR');
    }
    
    const { email, password } = req.body;
    
    // Get user with password hash
    const userResult = await query(
        'SELECT id, first_name, last_name, email, password_hash, admin_role, account_status FROM users WHERE email = $1',
        [email]
    );
    
    if (userResult.rows.length === 0) {
        systemLogger.security('Login attempt with non-existent email', {
            email,
            ip: req.ip,
            userAgent: req.get('User-Agent')
        });
        throw new APIError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }
    
    const user = userResult.rows[0];
    
    // Check account status
    if (user.account_status !== 'active') {
        systemLogger.security('Login attempt with inactive account', {
            userId: user.id,
            email,
            accountStatus: user.account_status,
            ip: req.ip
        });
        throw new APIError('Account is not active', 401, 'ACCOUNT_INACTIVE');
    }
    
    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
        systemLogger.security('Login attempt with invalid password', {
            userId: user.id,
            email,
            ip: req.ip,
            userAgent: req.get('User-Agent')
        });
        throw new APIError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }
    
    // Update last login
    await query(
        'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
    );
    
    // Log user activity
    await query(
        'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [user.id, 'login', { email }, req.ip, req.get('User-Agent')]
    );
    
    systemLogger.auth('User login successful', {
        userId: user.id,
        email,
        isAdmin: !!user.admin_role,
        ip: req.ip
    });
    
    // Generate token
    const token = generateToken(user.id);
    
    res.json({
        success: true,
        data: {
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                email: user.email,
                adminRole: user.admin_role,
                paymentReference: user.payment_reference
            },
            token
        },
        message: 'Login successful'
    });
}));

// POST /api/v1/auth/logout - User logout
router.post('/logout', asyncHandler(async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // Log user activity
            await query(
                'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
                [decoded.userId, 'logout', {}, req.ip, req.get('User-Agent')]
            );
            
            systemLogger.auth('User logout', {
                userId: decoded.userId,
                ip: req.ip
            });
        } catch (error) {
            // Token invalid, but logout request is still valid
        }
    }
    
    res.json({
        success: true,
        message: 'Logout successful'
    });
}));

// POST /api/v1/auth/verify-token - Verify JWT token
router.post('/verify-token', asyncHandler(async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        throw new APIError('Token required', 401, 'TOKEN_REQUIRED');
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Get current user details
        const userResult = await query(
            'SELECT id, first_name, last_name, email, admin_role, account_status FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('User not found', 401, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        if (user.account_status !== 'active') {
            throw new APIError('Account is not active', 401, 'ACCOUNT_INACTIVE');
        }
        
        res.json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    email: user.email,
                    adminRole: user.admin_role
                },
                tokenValid: true
            }
        });
        
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            throw new APIError('Invalid or expired token', 401, 'INVALID_TOKEN');
        }
        throw error;
    }
}));

// POST /api/v1/auth/change-password - Change user password
router.post('/change-password', [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('New password must contain lowercase, uppercase, and number')
], asyncHandler(async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        throw new APIError('Authentication required', 401, 'AUTH_REQUIRED');
    }
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { currentPassword, newPassword } = req.body;
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Get user with password hash
        const userResult = await query(
            'SELECT id, password_hash FROM users WHERE id = $1 AND account_status = $2',
            [decoded.userId, 'active']
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('User not found', 401, 'USER_NOT_FOUND');
        }
        
        const user = userResult.rows[0];
        
        // Verify current password
        const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!passwordValid) {
            systemLogger.security('Password change attempt with invalid current password', {
                userId: user.id,
                ip: req.ip
            });
            throw new APIError('Current password is incorrect', 400, 'INVALID_CURRENT_PASSWORD');
        }
        
        // Hash new password
        const saltRounds = 12;
        const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);
        
        // Update password
        await query(
            'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newPasswordHash, user.id]
        );
        
        // Log activity
        await query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [user.id, 'password_changed', {}, req.ip, req.get('User-Agent')]
        );
        
        systemLogger.security('Password changed successfully', {
            userId: user.id,
            ip: req.ip
        });
        
        res.json({
            success: true,
            message: 'Password changed successfully'
        });
        
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            throw new APIError('Invalid or expired token', 401, 'INVALID_TOKEN');
        }
        throw error;
    }
}));

module.exports = router;