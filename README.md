# ARB4ME Backend Server

A comprehensive multi-user backend system for the ARB4ME cryptocurrency arbitrage trading platform.

## Features

### 🔐 Authentication & User Management
- User registration and login with JWT tokens
- Profile management with change tracking
- Account status management (active, suspended, trial)
- Password change functionality

### 📊 Admin Dashboard
- Real-time user monitoring via WebSocket
- Platform-wide trading statistics and analytics
- User management and status control
- Message management system
- User promotion to admin roles

### 💬 Messaging System
- User-to-admin messaging with priority levels
- Admin replies and broadcast messages
- Message threading and status tracking
- Real-time notifications

### 📈 Trading Activity Tracking
- Trading settings backup and synchronization
- Trade history recording and statistics
- Exchange connection tracking
- Crypto asset selection management
- Auto-trading readiness calculation

### 🔍 Comprehensive Logging
- Structured logging with Winston
- Security event tracking
- User activity monitoring
- Error logging and debugging

### 🛡️ Security Features
- Rate limiting per endpoint type
- Input validation and sanitization
- SQL injection protection
- JWT token management
- Role-based access control

## Architecture

```
backend/
├── src/
│   ├── database/           # Database connection and schemas
│   │   ├── connection.js   # PostgreSQL connection pool
│   │   ├── schema.sql      # Database schema
│   │   └── migrate.js      # Migration scripts
│   ├── middleware/         # Express middleware
│   │   ├── auth.js         # Authentication middleware
│   │   ├── errorHandler.js # Global error handling
│   │   └── rateLimiter.js  # Rate limiting
│   ├── routes/             # API route handlers
│   │   ├── auth.routes.js  # Authentication endpoints
│   │   ├── user.routes.js  # User management
│   │   ├── message.routes.js # Messaging system
│   │   ├── admin.routes.js # Admin dashboard
│   │   └── trading.routes.js # Trading activity
│   ├── utils/              # Utility functions
│   │   └── logger.js       # Logging system
│   └── websocket/          # Real-time features
│       └── socketManager.js # WebSocket handling
├── package.json            # Dependencies and scripts
└── server.js              # Main server file
```

## API Endpoints

### Authentication (`/api/v1/auth`)
- `POST /register` - User registration
- `POST /login` - User login
- `POST /logout` - User logout
- `POST /verify-token` - Token validation
- `POST /change-password` - Password change

### User Management (`/api/v1/user`)
- `GET /profile` - Get user profile
- `PUT /profile` - Update user profile
- `GET /activity` - Get user activity history
- `PUT /trading-settings` - Update trading settings
- `POST /record-trade` - Record completed trade

### Messaging (`/api/v1/messages`)
- `POST /send` - Send message to admin
- `GET /inbox` - Get user messages
- `GET /thread/:id` - Get message thread
- `GET /broadcast` - Get broadcast messages
- `POST /admin/reply` - Admin reply (admin only)
- `POST /admin/broadcast` - Send broadcast (admin only)

### Admin Dashboard (`/api/v1/admin`)
- `GET /dashboard` - Dashboard statistics
- `GET /users` - List all users
- `GET /users/:id` - Get user details
- `PUT /users/:id/status` - Update user status
- `POST /users/:id/message` - Send direct message
- `GET /messages` - Get all messages
- `GET /analytics` - Platform analytics
- `POST /promote` - Promote user to admin

### Trading (`/api/v1/trading`)
- `GET /activity` - Get trading activity
- `PUT /activity` - Update trading activity
- `POST /trades` - Record trade
- `GET /trades/history` - Get trade history
- `GET /stats` - Trading statistics
- `GET /admin/overview` - Platform trading overview (admin)

## Database Schema

The system uses PostgreSQL with the following main tables:
- `users` - User accounts and admin roles
- `trading_activity` - Trading settings and statistics
- `messages` - User-admin messaging
- `user_activity` - Activity logging
- `profile_updates` - Profile change tracking
- `broadcast_messages` - Admin broadcast system
- `sessions` - User sessions
- `system_logs` - System logging

## Installation & Setup

### Prerequisites
- Node.js 16+ 
- PostgreSQL 13+
- npm or yarn

### Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Database Setup**
   ```bash
   # Create PostgreSQL database and user
   createdb arb4me_db
   createuser arb4me_user
   
   # Run migration
   npm run migrate
   ```

3. **Configure Environment**
   ```bash
   # Copy example config
   cp .env.example .env
   
   # Edit .env with your settings
   ```

4. **Start Server**
   ```bash
   # Development
   npm run dev
   
   # Production
   npm start
   ```

## Environment Variables

Required environment variables:
- `DB_HOST` - PostgreSQL host
- `DB_PORT` - PostgreSQL port
- `DB_NAME` - Database name
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password
- `JWT_SECRET` - JWT signing secret
- `PORT` - Server port (default: 3000)

## WebSocket Events

### Client to Server
- `user_activity` - Track user activity
- `trading_update` - Update trading settings
- `send_message` - Send message to admin

### Server to Client
- `admin_dashboard_data` - Dashboard updates
- `new_user_message` - New user message (admin)
- `admin_message` - Admin message (user)
- `broadcast_message` - Platform broadcast

## Rate Limits

- General API: 100 requests/15min
- Authentication: 5 requests/15min  
- Trading: 50 requests/5min
- Messages: 5 requests/1min
- Admin: 500 requests/15min

## Logging

Logs are stored in `/logs/` directory:
- `combined.log` - All log levels
- `error.log` - Error logs only
- `arb4me.log` - Application-specific logs

## Security Considerations

- All passwords hashed with bcrypt (12 rounds)
- JWT tokens with configurable expiry
- SQL injection protection via parameterized queries
- Rate limiting on all endpoints
- Input validation on all routes
- Admin role hierarchy (support < manager < admin < master)

## Production Deployment

1. Set `NODE_ENV=production`
2. Use environment variables for all config
3. Set up reverse proxy (nginx recommended)
4. Configure SSL/TLS certificates
5. Set up database backups
6. Configure log rotation
7. Use process manager (PM2 recommended)

## Support

This backend integrates with the ARB4ME PWA frontend to provide:
- User account management
- Trading activity synchronization  
- Admin monitoring capabilities
- Real-time messaging system
- Comprehensive audit trails

The system is designed to handle multiple concurrent users while providing administrators with complete oversight of platform activities.