const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../database/connection');
const { asyncHandler, APIError } = require('../middleware/errorHandler');
const { authenticateUser, requireAdmin, requireOwnershipOrAdmin } = require('../middleware/auth');
const { messageRateLimit, authenticatedRateLimit } = require('../middleware/rateLimiter');
const { systemLogger } = require('../utils/logger');
const { notifyUser, broadcastToAdmins } = require('../websocket/socketManager');

const router = express.Router();

// Apply authentication to all message routes
router.use(authenticatedRateLimit);
router.use(authenticateUser);

// POST /api/v1/messages/send - Send message (user-to-admin OR admin-to-user)
router.post('/send', messageRateLimit, [
    body('subject').trim().isLength({ min: 5, max: 255 }).withMessage('Subject must be 5-255 characters'),
    body('content').trim().isLength({ min: 10, max: 5000 }).withMessage('Content must be 10-5000 characters'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority level'),
    body('targetUserId').optional().isString().withMessage('Target user ID must be a string')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { subject, content, priority = 'medium', targetUserId } = req.body;
    
    // Determine message type and recipient
    let messageType, userId, adminUserId;
    
    if (req.user.admin_role && targetUserId) {
        // Admin sending to specific user
        messageType = 'admin_to_user';
        userId = targetUserId;
        adminUserId = req.user.id;
        
        // Verify target user exists
        const userCheck = await query(
            'SELECT id FROM users WHERE id = $1 AND account_status = $2',
            [targetUserId, 'active']
        );
        if (userCheck.rows.length === 0) {
            throw new APIError('Target user not found or inactive', 404, 'USER_NOT_FOUND');
        }
    } else {
        // Regular user sending to admin
        messageType = 'user_to_admin';
        userId = req.user.id;
        adminUserId = null;
    }
    
    // Insert message into database
    const messageResult = await query(
        `INSERT INTO messages (user_id, subject, content, priority, message_type, status, admin_user_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id, created_at, thread_id`,
        [userId, subject, content, priority, messageType, 'sent', adminUserId]
    );
    
    const message = messageResult.rows[0];
    
    // Log user activity
    await query(
        'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [req.user.id, 'message_sent', {
            messageId: message.id,
            subject,
            priority
        }, req.ip, req.get('User-Agent')]
    );
    
    // Notify appropriate recipients via WebSocket
    const messageData = {
        id: message.id,
        threadId: message.thread_id,
        from: `${req.user.first_name} ${req.user.last_name}`,
        userId: messageType === 'admin_to_user' ? targetUserId : req.user.id,
        subject,
        content,
        priority,
        timestamp: message.created_at,
        type: messageType
    };
    
    if (messageType === 'admin_to_user') {
        // Notify the specific user
        notifyUser(targetUserId, 'new_admin_message', messageData);
        systemLogger.admin('Admin message sent to user', {
            adminId: req.user.id,
            targetUserId,
            messageId: message.id,
            subject,
            priority
        });
    } else {
        // Notify all admins
        broadcastToAdmins('new_user_message', messageData);
        systemLogger.user('Message sent to admin', {
            userId: req.user.id,
            messageId: message.id,
            subject,
            priority,
            threadId: message.thread_id
        });
    }
    
    res.status(201).json({
        success: true,
        data: {
            message: {
                id: message.id,
                threadId: message.thread_id,
                subject,
                content,
                priority,
                status: 'sent',
                timestamp: message.created_at
            }
        },
        message: 'Message sent successfully'
    });
}));

// GET /api/v1/messages/inbox - Get user's messages (inbox)
router.get('/inbox', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all'; // sent, read, replied, all
    
    let statusCondition = '';
    const queryParams = [req.user.id, limit, offset];
    
    if (status !== 'all') {
        statusCondition = 'AND m.status = $4';
        queryParams.push(status);
    }
    
    // Try to get messages with reminder_type field, fall back if column doesn't exist
    let messagesResult;
    try {
        messagesResult = await query(`
            SELECT m.id, m.subject, m.content, m.priority, m.message_type, m.status,
                   m.created_at, m.thread_id, m.parent_message_id, m.reminder_type,
                   m.admin_user_id, m.admin_read_at, m.admin_replied_at,
                   CASE 
                       WHEN m.admin_user_id IS NOT NULL THEN 
                           (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE id = m.admin_user_id)
                       ELSE 'ARB4ME Admin'
                   END as admin_name
            FROM messages m
            WHERE (m.user_id = $1 OR (m.message_type = 'admin_to_user' AND m.user_id = $1))
            ${statusCondition}
            ORDER BY m.thread_id DESC, m.created_at ASC
            LIMIT $2 OFFSET $3
        `, queryParams);
    } catch (error) {
        // Fall back to query without reminder_type if column doesn't exist
        messagesResult = await query(`
            SELECT m.id, m.subject, m.content, m.priority, m.message_type, m.status,
                   m.created_at, m.thread_id, m.parent_message_id, NULL as reminder_type,
                   m.admin_user_id, m.admin_read_at, m.admin_replied_at,
                   CASE 
                       WHEN m.admin_user_id IS NOT NULL THEN 
                           (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE id = m.admin_user_id)
                       ELSE 'ARB4ME Admin'
                   END as admin_name
            FROM messages m
            WHERE (m.user_id = $1 OR (m.message_type = 'admin_to_user' AND m.user_id = $1))
            ${statusCondition}
            ORDER BY m.thread_id DESC, m.created_at ASC
            LIMIT $2 OFFSET $3
        `, queryParams);
    }
    
    // Get total count
    const countParams = [req.user.id];
    let countCondition = '';
    if (status !== 'all') {
        countCondition = 'AND status = $2';
        countParams.push(status);
    }
    
    const countResult = await query(`
        SELECT COUNT(*) as total 
        FROM messages 
        WHERE (user_id = $1 OR (message_type = 'admin_to_user' AND user_id = $1))
        ${countCondition}
    `, countParams);
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    // Group messages by thread for better organization
    const threads = {};
    messagesResult.rows.forEach(message => {
        if (!threads[message.thread_id]) {
            threads[message.thread_id] = [];
        }
        threads[message.thread_id].push({
            id: message.id,
            subject: message.subject,
            content: message.content,
            priority: message.priority,
            type: message.message_type,
            status: message.status,
            timestamp: message.created_at,
            parentMessageId: message.parent_message_id,
            adminName: message.admin_name,
            adminReadAt: message.admin_read_at,
            adminRepliedAt: message.admin_replied_at
        });
    });
    
    res.json({
        success: true,
        data: {
            threads: Object.values(threads),
            messages: messagesResult.rows.map(row => ({
                id: row.id,
                threadId: row.thread_id,
                subject: row.subject,
                content: row.content,
                priority: row.priority,
                type: row.message_type,
                status: row.status,
                timestamp: row.created_at,
                parentMessageId: row.parent_message_id,
                adminName: row.admin_name,
                adminReadAt: row.admin_read_at,
                adminRepliedAt: row.admin_replied_at
            })),
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// GET /api/v1/messages/thread/:threadId - Get specific message thread
router.get('/thread/:threadId', asyncHandler(async (req, res) => {
    const threadId = parseInt(req.params.threadId);
    
    if (!threadId || isNaN(threadId)) {
        throw new APIError('Invalid thread ID', 400, 'INVALID_THREAD_ID');
    }
    
    // Get all messages in thread, ensuring user owns the thread
    const threadResult = await query(`
        SELECT m.id, m.subject, m.content, m.priority, m.message_type, m.status,
               m.created_at, m.thread_id, m.parent_message_id, m.user_id, m.reminder_type,
               m.admin_user_id, m.admin_read_at, m.admin_replied_at,
               CASE 
                   WHEN m.admin_user_id IS NOT NULL THEN 
                       (SELECT CONCAT(first_name, ' ', last_name) FROM users WHERE id = m.admin_user_id)
                   ELSE 'ARB4ME Admin'
               END as admin_name,
               u.first_name, u.last_name
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.thread_id = $1 AND (m.user_id = $2 OR m.message_type = 'admin_to_user')
        ORDER BY m.created_at ASC
    `, [threadId, req.user.id]);
    
    if (threadResult.rows.length === 0) {
        throw new APIError('Thread not found or access denied', 404, 'THREAD_NOT_FOUND');
    }
    
    // Verify user owns this thread
    const threadOwner = threadResult.rows.find(msg => msg.message_type === 'user_to_admin')?.user_id;
    if (threadOwner !== req.user.id) {
        throw new APIError('Access denied to this thread', 403, 'ACCESS_DENIED');
    }
    
    // Mark user messages as read (update status if needed)
    await query(
        `UPDATE messages SET status = 'read', updated_at = CURRENT_TIMESTAMP 
         WHERE thread_id = $1 AND user_id = $2 AND message_type = 'admin_to_user' AND status = 'delivered'`,
        [threadId, req.user.id]
    );
    
    const messages = threadResult.rows.map(row => ({
        id: row.id,
        subject: row.subject,
        content: row.content,
        priority: row.priority,
        type: row.message_type,
        status: row.status,
        timestamp: row.created_at,
        parentMessageId: row.parent_message_id,
        sender: row.message_type === 'user_to_admin' 
            ? `${row.first_name} ${row.last_name}`
            : row.admin_name,
        adminReadAt: row.admin_read_at,
        adminRepliedAt: row.admin_replied_at
    }));
    
    res.json({
        success: true,
        data: {
            threadId,
            messages
        }
    });
}));

// PUT /api/v1/messages/:messageId/mark-read - Mark message as read
router.put('/:messageId/mark-read', asyncHandler(async (req, res) => {
    const messageId = parseInt(req.params.messageId);
    
    if (!messageId || isNaN(messageId)) {
        throw new APIError('Invalid message ID', 400, 'INVALID_MESSAGE_ID');
    }
    
    // Update message status to read
    const updateResult = await query(
        `UPDATE messages 
         SET status = 'read', updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND user_id = $2 AND message_type = 'admin_to_user'
         RETURNING id, thread_id`,
        [messageId, req.user.id]
    );
    
    if (updateResult.rows.length === 0) {
        throw new APIError('Message not found or access denied', 404, 'MESSAGE_NOT_FOUND');
    }
    
    const message = updateResult.rows[0];
    
    systemLogger.user('Message marked as read', {
        userId: req.user.id,
        messageId: message.id,
        threadId: message.thread_id
    });
    
    res.json({
        success: true,
        message: 'Message marked as read'
    });
}));

// POST /api/v1/messages/broadcast - Send broadcast message to all users (admin only)
router.post('/broadcast', [
    body('subject').trim().isLength({ min: 5, max: 255 }).withMessage('Subject must be 5-255 characters'),
    body('content').trim().isLength({ min: 10, max: 5000 }).withMessage('Content must be 10-5000 characters'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority level')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { subject, content, priority = 'medium' } = req.body;
    
    // Insert broadcast message
    const broadcastResult = await query(
        `INSERT INTO broadcast_messages (sent_by_admin_id, subject, content, priority, sent_at) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) 
         RETURNING id, created_at, sent_at`,
        [req.user.id, subject, content, priority]
    );
    
    const broadcast = broadcastResult.rows[0];
    
    // Get all active users
    const usersResult = await query(
        'SELECT id, first_name, last_name FROM users WHERE account_status = $1 AND admin_role IS NULL',
        ['active']
    );
    
    // Insert message recipients
    const recipientPromises = usersResult.rows.map(user => 
        query(
            'INSERT INTO message_recipients (broadcast_message_id, user_id, delivered_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
            [broadcast.id, user.id]
        )
    );
    
    await Promise.all(recipientPromises);
    
    // Notify all users via WebSocket
    const broadcastData = {
        id: broadcast.id,
        subject,
        content,
        priority,
        timestamp: broadcast.sent_at,
        from: `${req.user.first_name} ${req.user.last_name}`,
        type: 'broadcast'
    };
    
    // Notify each user
    usersResult.rows.forEach(user => {
        notifyUser(user.id, 'new_broadcast_message', broadcastData);
    });
    
    systemLogger.admin('Broadcast message sent', {
        adminId: req.user.id,
        broadcastId: broadcast.id,
        recipientCount: usersResult.rows.length,
        subject,
        priority
    });
    
    res.status(201).json({
        success: true,
        data: {
            broadcast: {
                id: broadcast.id,
                subject,
                content,
                priority,
                recipientCount: usersResult.rows.length,
                timestamp: broadcast.sent_at
            }
        },
        message: `Broadcast sent to ${usersResult.rows.length} users`
    });
}));

// GET /api/v1/messages/broadcast - Get broadcast messages for user
router.get('/broadcast', asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    
    // Get broadcast messages for this user
    const broadcastResult = await query(`
        SELECT bm.id, bm.subject, bm.content, bm.priority, bm.created_at, bm.sent_at,
               mr.delivered_at, mr.read_at,
               u.first_name, u.last_name
        FROM broadcast_messages bm
        LEFT JOIN message_recipients mr ON bm.id = mr.broadcast_message_id AND mr.user_id = $1
        LEFT JOIN users u ON bm.sent_by_admin_id = u.id
        WHERE bm.sent_at IS NOT NULL AND (bm.recipient_filter = 'all_users' OR mr.user_id = $1)
        ORDER BY bm.sent_at DESC
        LIMIT $2 OFFSET $3
    `, [req.user.id, limit, offset]);
    
    // Get total count
    const countResult = await query(`
        SELECT COUNT(DISTINCT bm.id) as total
        FROM broadcast_messages bm
        LEFT JOIN message_recipients mr ON bm.id = mr.broadcast_message_id AND mr.user_id = $1
        WHERE bm.sent_at IS NOT NULL AND (bm.recipient_filter = 'all_users' OR mr.user_id = $1)
    `, [req.user.id]);
    
    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);
    
    // Mark unread broadcast messages as read
    const unreadMessages = broadcastResult.rows
        .filter(row => row.delivered_at && !row.read_at)
        .map(row => row.id);
    
    if (unreadMessages.length > 0) {
        await query(
            `UPDATE message_recipients 
             SET read_at = CURRENT_TIMESTAMP 
             WHERE broadcast_message_id = ANY($1) AND user_id = $2 AND read_at IS NULL`,
            [unreadMessages, req.user.id]
        );
    }
    
    const broadcasts = broadcastResult.rows.map(row => ({
        id: row.id,
        subject: row.subject,
        content: row.content,
        priority: row.priority,
        createdAt: row.created_at,
        sentAt: row.sent_at,
        deliveredAt: row.delivered_at,
        readAt: row.read_at || (unreadMessages.includes(row.id) ? new Date() : null),
        senderName: `${row.first_name || 'ARB4ME'} ${row.last_name || 'Admin'}`
    }));
    
    res.json({
        success: true,
        data: {
            broadcasts,
            pagination: {
                currentPage: page,
                totalPages,
                totalRecords: total,
                recordsPerPage: limit
            }
        }
    });
}));

// Admin-only routes
// POST /api/v1/messages/admin/reply - Admin reply to user message
router.post('/admin/reply', requireAdmin, [
    body('targetUserId').notEmpty().withMessage('Target user ID is required'),
    body('parentMessageId').isInt({ min: 1 }).withMessage('Valid parent message ID is required'),
    body('subject').trim().isLength({ min: 5, max: 255 }).withMessage('Subject must be 5-255 characters'),
    body('content').trim().isLength({ min: 10, max: 5000 }).withMessage('Content must be 10-5000 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { targetUserId, parentMessageId, subject, content } = req.body;
    
    await transaction(async (client) => {
        // Verify parent message exists and get thread info
        const parentResult = await client.query(
            'SELECT id, thread_id, user_id FROM messages WHERE id = $1',
            [parentMessageId]
        );
        
        if (parentResult.rows.length === 0) {
            throw new APIError('Parent message not found', 404, 'PARENT_MESSAGE_NOT_FOUND');
        }
        
        const parentMessage = parentResult.rows[0];
        
        // Verify target user exists
        const userResult = await client.query(
            'SELECT id, first_name, last_name FROM users WHERE id = $1 AND account_status = $2',
            [targetUserId, 'active']
        );
        
        if (userResult.rows.length === 0) {
            throw new APIError('Target user not found or inactive', 404, 'TARGET_USER_NOT_FOUND');
        }
        
        const targetUser = userResult.rows[0];
        
        // Insert admin reply
        const replyResult = await client.query(
            `INSERT INTO messages (user_id, subject, content, message_type, admin_user_id, parent_message_id, thread_id, status) 
             VALUES ($1, $2, $3, 'admin_to_user', $4, $5, $6, 'delivered') 
             RETURNING id, created_at`,
            [targetUserId, subject, content, req.user.id, parentMessageId, parentMessage.thread_id]
        );
        
        const reply = replyResult.rows[0];
        
        // Update parent message status
        await client.query(
            'UPDATE messages SET status = $1, admin_read_at = CURRENT_TIMESTAMP, admin_replied_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['replied', parentMessageId]
        );
        
        // Log admin activity
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'admin_message_reply', {
                targetUserId,
                messageId: reply.id,
                parentMessageId,
                threadId: parentMessage.thread_id,
                subject
            }, req.ip, req.get('User-Agent')]
        );
        
        // Send real-time notification to user if connected
        const notificationData = {
            id: reply.id,
            threadId: parentMessage.thread_id,
            from: `Admin: ${req.user.first_name} ${req.user.last_name}`,
            subject,
            content,
            timestamp: reply.created_at,
            parentMessageId,
            type: 'admin_to_user'
        };
        
        notifyUser(targetUserId, 'admin_message', notificationData);
        
        systemLogger.admin('Admin replied to user message', {
            adminId: req.user.id,
            targetUserId,
            messageId: reply.id,
            threadId: parentMessage.thread_id,
            subject
        });
        
        res.status(201).json({
            success: true,
            data: {
                reply: {
                    id: reply.id,
                    threadId: parentMessage.thread_id,
                    targetUser: `${targetUser.first_name} ${targetUser.last_name}`,
                    subject,
                    content,
                    timestamp: reply.created_at,
                    parentMessageId
                }
            },
            message: 'Reply sent successfully'
        });
    });
}));

// POST /api/v1/messages/admin/broadcast - Send broadcast message
router.post('/admin/broadcast', requireAdmin, [
    body('subject').trim().isLength({ min: 5, max: 255 }).withMessage('Subject must be 5-255 characters'),
    body('content').trim().isLength({ min: 10, max: 5000 }).withMessage('Content must be 10-5000 characters'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority level'),
    body('recipientFilter').optional().isIn(['all_users', 'active_traders', 'new_users']).withMessage('Invalid recipient filter')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        throw new APIError('Validation failed', 400, 'VALIDATION_ERROR');
    }
    
    const { subject, content, priority = 'medium', recipientFilter = 'all_users' } = req.body;
    
    await transaction(async (client) => {
        // Get target users based on filter
        let userQuery = 'SELECT id, first_name, last_name FROM users WHERE account_status = $1 AND admin_role IS NULL';
        const userParams = ['active'];
        
        if (recipientFilter === 'active_traders') {
            userQuery = `
                SELECT u.id, u.first_name, u.last_name 
                FROM users u 
                JOIN trading_activity ta ON u.id = ta.user_id 
                WHERE u.account_status = $1 AND u.admin_role IS NULL AND ta.trading_active = true
            `;
        } else if (recipientFilter === 'new_users') {
            userQuery += ' AND created_at > NOW() - INTERVAL \'30 days\'';
        }
        
        const usersResult = await client.query(userQuery, userParams);
        const targetUsers = usersResult.rows;
        
        if (targetUsers.length === 0) {
            throw new APIError('No users found matching the filter criteria', 400, 'NO_TARGET_USERS');
        }
        
        // Insert broadcast message
        const broadcastResult = await client.query(
            `INSERT INTO broadcast_messages (subject, content, priority, sent_by_admin_id, recipient_filter, recipient_count, sent_at) 
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) 
             RETURNING id, created_at`,
            [subject, content, priority, req.user.id, recipientFilter, targetUsers.length]
        );
        
        const broadcast = broadcastResult.rows[0];
        
        // Insert message recipients
        const recipientInserts = targetUsers.map(user => 
            client.query(
                'INSERT INTO message_recipients (broadcast_message_id, user_id, delivered_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                [broadcast.id, user.id]
            )
        );
        
        await Promise.all(recipientInserts);
        
        // Log admin activity
        await client.query(
            'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
            [req.user.id, 'admin_broadcast_sent', {
                broadcastId: broadcast.id,
                recipientCount: targetUsers.length,
                recipientFilter,
                subject,
                priority
            }, req.ip, req.get('User-Agent')]
        );
        
        systemLogger.admin('Broadcast message sent', {
            adminId: req.user.id,
            broadcastId: broadcast.id,
            recipientCount: targetUsers.length,
            recipientFilter,
            subject,
            priority
        });
        
        res.status(201).json({
            success: true,
            data: {
                broadcast: {
                    id: broadcast.id,
                    subject,
                    content,
                    priority,
                    recipientFilter,
                    recipientCount: targetUsers.length,
                    sentAt: broadcast.created_at
                }
            },
            message: 'Broadcast message sent successfully'
        });
    });
}));

module.exports = router;