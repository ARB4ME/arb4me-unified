const jwt = require('jsonwebtoken');
const { systemLogger } = require('../utils/logger');
const { query } = require('../database/connection');

// Store active connections
const connectedUsers = new Map();
const adminUsers = new Map();

// WebSocket authentication middleware
const authenticateSocket = async (socket, next) => {
    try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return next(new Error('Authentication token required'));
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        
        // Get user details from database
        const userResult = await query(
            'SELECT id, first_name, last_name, email, admin_role, account_status FROM users WHERE id = $1',
            [decoded.userId]
        );
        
        if (userResult.rows.length === 0) {
            return next(new Error('User not found'));
        }
        
        const user = userResult.rows[0];
        
        if (user.account_status !== 'active') {
            return next(new Error('Account is not active'));
        }
        
        socket.user = user;
        next();
        
    } catch (error) {
        systemLogger.security('WebSocket authentication failed', {
            error: error.message,
            socketId: socket.id,
            ip: socket.handshake.address
        });
        next(new Error('Authentication failed'));
    }
};

// Setup WebSocket server
const setupWebSocket = (io) => {
    // Authentication middleware for all connections
    io.use(authenticateSocket);
    
    io.on('connection', async (socket) => {
        const user = socket.user;
        
        systemLogger.websocket('User connected via WebSocket', {
            userId: user.id,
            userName: `${user.first_name} ${user.last_name}`,
            socketId: socket.id,
            isAdmin: !!user.admin_role
        });
        
        // Store user connection
        connectedUsers.set(user.id, {
            socket: socket,
            user: user,
            connectedAt: new Date(),
            lastActivity: new Date()
        });
        
        // Store admin connections separately for easy access
        if (user.admin_role) {
            adminUsers.set(user.id, socket);
            
            // Send admin dashboard data immediately
            await sendAdminDashboardData(socket);
            
            // Join admin room for admin-only broadcasts
            socket.join('admin_room');
        }
        
        // Join user's personal room for direct messaging
        socket.join(`user_${user.id}`);
        
        // Handle user activity tracking
        socket.on('user_activity', async (data) => {
            try {
                await query(
                    'INSERT INTO user_activity (user_id, activity_type, activity_details, ip_address) VALUES ($1, $2, $3, $4)',
                    [user.id, data.type, JSON.stringify(data.details), socket.handshake.address]
                );
                
                // Update last activity
                const userConnection = connectedUsers.get(user.id);
                if (userConnection) {
                    userConnection.lastActivity = new Date();
                }
                
                // Notify admins of user activity
                if (data.type === 'trading_started' || data.type === 'trading_stopped') {
                    broadcastToAdmins('user_trading_status_changed', {
                        userId: user.id,
                        userName: `${user.first_name} ${user.last_name}`,
                        status: data.type,
                        timestamp: new Date()
                    });
                }
                
            } catch (error) {
                systemLogger.error('Failed to record user activity', error);
            }
        });
        
        // Handle trading activity updates
        socket.on('trading_update', async (data) => {
            try {
                // Update trading activity in database
                await query(
                    `UPDATE trading_activity 
                     SET selected_crypto_assets = $2, trading_active = $3, auto_trading_enabled = $4, 
                         last_trading_activity = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = $1`,
                    [user.id, JSON.stringify(data.selectedAssets), data.tradingActive, data.autoTradingEnabled]
                );
                
                // Notify admins of trading update
                broadcastToAdmins('user_trading_updated', {
                    userId: user.id,
                    userName: `${user.first_name} ${user.last_name}`,
                    tradingActive: data.tradingActive,
                    autoTradingEnabled: data.autoTradingEnabled,
                    assetCount: data.selectedAssets?.length || 0,
                    timestamp: new Date()
                });
                
                systemLogger.trading('User trading settings updated', {
                    userId: user.id,
                    tradingActive: data.tradingActive,
                    autoTradingEnabled: data.autoTradingEnabled,
                    assetCount: data.selectedAssets?.length || 0
                });
                
            } catch (error) {
                systemLogger.error('Failed to update trading activity', error);
                socket.emit('error', { message: 'Failed to update trading settings' });
            }
        });
        
        // Handle direct messages
        socket.on('send_message', async (data) => {
            try {
                // Insert message into database
                const messageResult = await query(
                    `INSERT INTO messages (user_id, subject, content, priority, message_type) 
                     VALUES ($1, $2, $3, $4, 'user_to_admin') 
                     RETURNING id, created_at`,
                    [user.id, data.subject, data.content, data.priority || 'medium']
                );
                
                const message = {
                    id: messageResult.rows[0].id,
                    from: `${user.first_name} ${user.last_name}`,
                    userId: user.id,
                    subject: data.subject,
                    content: data.content,
                    priority: data.priority || 'medium',
                    timestamp: messageResult.rows[0].created_at
                };
                
                // Notify all admins
                broadcastToAdmins('new_user_message', message);
                
                // Confirm to sender
                socket.emit('message_sent', { messageId: message.id, timestamp: message.timestamp });
                
                systemLogger.user('Message sent to admin', {
                    userId: user.id,
                    messageId: message.id,
                    subject: data.subject,
                    priority: data.priority
                });
                
            } catch (error) {
                systemLogger.error('Failed to send message', error);
                socket.emit('error', { message: 'Failed to send message' });
            }
        });
        
        // Handle admin responses (admin-only)
        if (user.admin_role) {
            socket.on('admin_reply', async (data) => {
                try {
                    // Insert admin reply
                    const replyResult = await query(
                        `INSERT INTO messages (user_id, subject, content, message_type, admin_user_id, parent_message_id) 
                         VALUES ($1, $2, $3, 'admin_to_user', $4, $5) 
                         RETURNING id, created_at`,
                        [data.targetUserId, data.subject, data.content, user.id, data.parentMessageId]
                    );
                    
                    // Send to target user if connected
                    const targetUserConnection = connectedUsers.get(data.targetUserId);
                    if (targetUserConnection) {
                        targetUserConnection.socket.emit('admin_message', {
                            id: replyResult.rows[0].id,
                            from: `Admin: ${user.first_name} ${user.last_name}`,
                            subject: data.subject,
                            content: data.content,
                            timestamp: replyResult.rows[0].created_at,
                            parentMessageId: data.parentMessageId
                        });
                    }
                    
                    // Notify other admins
                    socket.to('admin_room').emit('admin_replied_to_user', {
                        adminName: `${user.first_name} ${user.last_name}`,
                        targetUserId: data.targetUserId,
                        subject: data.subject,
                        timestamp: replyResult.rows[0].created_at
                    });
                    
                    systemLogger.admin('Admin replied to user message', {
                        adminId: user.id,
                        targetUserId: data.targetUserId,
                        messageId: replyResult.rows[0].id,
                        subject: data.subject
                    });
                    
                } catch (error) {
                    systemLogger.error('Failed to send admin reply', error);
                    socket.emit('error', { message: 'Failed to send reply' });
                }
            });
            
            socket.on('broadcast_message', async (data) => {
                try {
                    // Insert broadcast message
                    const broadcastResult = await query(
                        `INSERT INTO broadcast_messages (subject, content, priority, sent_by_admin_id, recipient_filter) 
                         VALUES ($1, $2, $3, $4, $5) 
                         RETURNING id`,
                        [data.subject, data.content, data.priority || 'medium', user.id, data.recipientFilter || 'all_users']
                    );
                    
                    const broadcastId = broadcastResult.rows[0].id;
                    
                    // Broadcast to all connected users
                    const broadcastMessage = {
                        id: broadcastId,
                        subject: data.subject,
                        content: data.content,
                        priority: data.priority || 'medium',
                        from: 'ARB4ME Admin',
                        timestamp: new Date()
                    };
                    
                    // Send to all connected users
                    connectedUsers.forEach((connection, userId) => {
                        if (!connection.user.admin_role) { // Don't send to admins
                            connection.socket.emit('broadcast_message', broadcastMessage);
                            
                            // Record delivery
                            query(
                                'INSERT INTO message_recipients (broadcast_message_id, user_id, delivered_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                                [broadcastId, userId]
                            ).catch(err => systemLogger.error('Failed to record message delivery', err));
                        }
                    });
                    
                    systemLogger.admin('Broadcast message sent', {
                        adminId: user.id,
                        broadcastId: broadcastId,
                        recipientCount: connectedUsers.size - adminUsers.size,
                        subject: data.subject
                    });
                    
                } catch (error) {
                    systemLogger.error('Failed to send broadcast message', error);
                    socket.emit('error', { message: 'Failed to send broadcast' });
                }
            });
        }
        
        // Handle disconnection
        socket.on('disconnect', (reason) => {
            systemLogger.websocket('User disconnected', {
                userId: user.id,
                userName: `${user.first_name} ${user.last_name}`,
                reason: reason,
                socketId: socket.id
            });
            
            // Remove from connected users
            connectedUsers.delete(user.id);
            
            if (user.admin_role) {
                adminUsers.delete(user.id);
            }
        });
    });
    
    systemLogger.websocket('WebSocket server initialized');
};

// Helper function to send admin dashboard data
const sendAdminDashboardData = async (socket) => {
    try {
        // Get user statistics
        const userStatsResult = await query(`
            SELECT 
                COUNT(*) as total_users,
                COUNT(CASE WHEN account_status = 'active' THEN 1 END) as active_users,
                COUNT(CASE WHEN last_login_at > NOW() - INTERVAL '24 hours' THEN 1 END) as recent_logins
            FROM users 
            WHERE admin_role IS NULL
        `);
        
        // Get trading statistics
        const tradingStatsResult = await query(`
            SELECT 
                COUNT(*) as total_traders,
                COUNT(CASE WHEN trading_active = true THEN 1 END) as active_traders,
                COUNT(CASE WHEN auto_trading_enabled = true THEN 1 END) as auto_traders,
                AVG(exchanges_connected_count) as avg_exchanges_connected
            FROM trading_activity
        `);
        
        // Get recent messages
        const recentMessagesResult = await query(`
            SELECT m.id, m.subject, m.priority, m.created_at,
                   u.first_name, u.last_name, u.id as user_id
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.message_type = 'user_to_admin' AND m.status = 'sent'
            ORDER BY m.created_at DESC
            LIMIT 10
        `);
        
        const dashboardData = {
            userStats: userStatsResult.rows[0],
            tradingStats: tradingStatsResult.rows[0],
            recentMessages: recentMessagesResult.rows,
            connectedUsers: Array.from(connectedUsers.values()).map(conn => ({
                id: conn.user.id,
                name: `${conn.user.first_name} ${conn.user.last_name}`,
                connectedAt: conn.connectedAt,
                lastActivity: conn.lastActivity
            })),
            timestamp: new Date()
        };
        
        socket.emit('admin_dashboard_data', dashboardData);
        
    } catch (error) {
        systemLogger.error('Failed to send admin dashboard data', error);
    }
};

// Helper function to broadcast to all admins
const broadcastToAdmins = (event, data) => {
    adminUsers.forEach((socket) => {
        socket.emit(event, data);
    });
};

// Get connected users (for external use)
const getConnectedUsers = () => {
    return Array.from(connectedUsers.values()).map(conn => ({
        id: conn.user.id,
        name: `${conn.user.first_name} ${conn.user.last_name}`,
        isAdmin: !!conn.user.admin_role,
        connectedAt: conn.connectedAt,
        lastActivity: conn.lastActivity
    }));
};

// Send notification to specific user
const notifyUser = (userId, event, data) => {
    const userConnection = connectedUsers.get(userId);
    if (userConnection) {
        userConnection.socket.emit(event, data);
        return true;
    }
    return false;
};

module.exports = {
    setupWebSocket,
    getConnectedUsers,
    broadcastToAdmins,
    notifyUser
};