const cron = require('node-cron');
const { query, transaction } = require('../database/connection');
const { systemLogger } = require('../utils/logger');

class AutoReminderService {
    constructor() {
        this.isRunning = false;
        this.lastRunTime = null;
        this.stats = {
            sevenDayReminders: 0,
            oneDayReminders: 0,
            totalReminders: 0,
            lastRunDate: null
        };
    }

    // Initialize the cron job
    initialize() {
        // Run daily at 9:00 AM South African time (UTC+2)
        // Cron format: second minute hour day month dayOfWeek
        // 0 9 * * * = Every day at 9:00 AM
        cron.schedule('0 9 * * *', async () => {
            await this.runDailyReminders();
        }, {
            scheduled: true,
            timezone: "Africa/Johannesburg"
        });

        systemLogger.info('Auto-reminder cron job initialized for 9:00 AM SA time');
        console.log('🤖 Auto-reminder system initialized - runs daily at 9:00 AM SA time');
    }

    // Main function that runs daily
    async runDailyReminders() {
        if (this.isRunning) {
            systemLogger.warn('Auto-reminder job already running, skipping this execution');
            return;
        }

        this.isRunning = true;
        const startTime = new Date();
        
        try {
            systemLogger.info('Starting daily auto-reminder job');
            console.log('🤖 Starting daily auto-reminder job at', startTime.toLocaleString());

            // Reset daily stats
            this.stats = {
                sevenDayReminders: 0,
                oneDayReminders: 0,
                totalReminders: 0,
                lastRunDate: startTime.toISOString().split('T')[0]
            };

            // Run 7-day reminders
            const sevenDayResults = await this.send7DayReminders();
            this.stats.sevenDayReminders = sevenDayResults.length;

            // Run 1-day reminders
            const oneDayResults = await this.send1DayReminders();
            this.stats.oneDayReminders = oneDayResults.length;

            this.stats.totalReminders = this.stats.sevenDayReminders + this.stats.oneDayReminders;
            this.lastRunTime = startTime;

            const endTime = new Date();
            const duration = endTime - startTime;

            systemLogger.info('Auto-reminder job completed successfully', {
                duration: `${duration}ms`,
                sevenDayReminders: this.stats.sevenDayReminders,
                oneDayReminders: this.stats.oneDayReminders,
                totalReminders: this.stats.totalReminders
            });

            console.log(`✅ Auto-reminder job completed: ${this.stats.sevenDayReminders} 7-day, ${this.stats.oneDayReminders} 1-day reminders sent`);

        } catch (error) {
            systemLogger.error('Auto-reminder job failed', {
                error: error.message,
                stack: error.stack
            });
            console.error('❌ Auto-reminder job failed:', error.message);
        } finally {
            this.isRunning = false;
        }
    }

    // Send 7-day reminders
    async send7DayReminders() {
        const remindersSent = [];
        
        try {
            // Find users expiring in exactly 7 days who haven't received 7-day reminder
            const sevenDaysFromNow = new Date();
            sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
            const sevenDaysDate = sevenDaysFromNow.toISOString().split('T')[0];

            const usersResult = await query(`
                SELECT 
                    id, first_name, last_name, email, payment_reference,
                    subscription_expires_at, last_payment_date,
                    seven_day_reminder_sent, one_day_reminder_sent,
                    last_reminder_type, last_reminder_date
                FROM users 
                WHERE DATE(subscription_expires_at) = $1
                AND account_status = 'active'
                AND (seven_day_reminder_sent IS FALSE OR seven_day_reminder_sent IS NULL)
                AND subscription_expires_at IS NOT NULL
            `, [sevenDaysDate]);

            console.log(`📅 Found ${usersResult.rows.length} users for 7-day reminders`);

            for (const user of usersResult.rows) {
                try {
                    await this.sendReminderToUser(user, '7day', 7);
                    remindersSent.push(user);
                } catch (error) {
                    systemLogger.error(`Failed to send 7-day reminder to user ${user.id}`, {
                        userId: user.id,
                        email: user.email,
                        error: error.message
                    });
                }
            }

        } catch (error) {
            systemLogger.error('Error in send7DayReminders', { error: error.message });
            throw error;
        }

        return remindersSent;
    }

    // Send 1-day reminders
    async send1DayReminders() {
        const remindersSent = [];
        
        try {
            // Find users expiring in exactly 1 day who haven't received 1-day reminder
            const oneDayFromNow = new Date();
            oneDayFromNow.setDate(oneDayFromNow.getDate() + 1);
            const oneDayDate = oneDayFromNow.toISOString().split('T')[0];

            const usersResult = await query(`
                SELECT 
                    id, first_name, last_name, email, payment_reference,
                    subscription_expires_at, last_payment_date,
                    seven_day_reminder_sent, one_day_reminder_sent,
                    last_reminder_type, last_reminder_date
                FROM users 
                WHERE DATE(subscription_expires_at) = $1
                AND account_status = 'active'
                AND (one_day_reminder_sent IS FALSE OR one_day_reminder_sent IS NULL)
                AND subscription_expires_at IS NOT NULL
            `, [oneDayDate]);

            console.log(`🚨 Found ${usersResult.rows.length} users for 1-day urgent reminders`);

            for (const user of usersResult.rows) {
                try {
                    await this.sendReminderToUser(user, '1day', 1);
                    remindersSent.push(user);
                } catch (error) {
                    systemLogger.error(`Failed to send 1-day reminder to user ${user.id}`, {
                        userId: user.id,
                        email: user.email,
                        error: error.message
                    });
                }
            }

        } catch (error) {
            systemLogger.error('Error in send1DayReminders', { error: error.message });
            throw error;
        }

        return remindersSent;
    }

    // Send reminder to individual user
    async sendReminderToUser(user, reminderType, daysUntilExpiry) {
        const result = await transaction(async (client) => {
            // Prepare reminder message content
            const isUrgent = reminderType === '1day';
            const subject = isUrgent 
                ? 'URGENT: Subscription Expires Tomorrow - Action Required!'
                : 'Subscription Expiry Reminder - Action Required';

            const content = isUrgent ? 
                `🚨 URGENT NOTICE - ${user.first_name}!

Your ARB4ME subscription expires TOMORROW (${new Date(user.subscription_expires_at).toDateString()}).

⚠️ IMPORTANT: If payment is not received by tomorrow, your trading access will be SUSPENDED.

💳 To avoid suspension, please make your R500 payment immediately:
- Reference: ${user.payment_reference}
- Amount: R500
- Contact admin if you need assistance

🔒 After expiry, you will still have access to:
- Account dashboard
- Trade history
- Messages

❌ But trading functions will be disabled until payment is received.

Don't lose your trading access - pay now!

The ARB4ME Team` :

                `Hi ${user.first_name}!

This is an important reminder that your ARB4ME subscription will expire in ${daysUntilExpiry} days on ${new Date(user.subscription_expires_at).toDateString()}.

💰 To continue enjoying uninterrupted access to our arbitrage trading platform, please ensure your R500 payment is made before the expiry date.

💳 Payment Details:
- Amount: R500
- Reference: ${user.payment_reference}
- You can make payment via EFT or instant payment

📞 Need Help?
If you have any questions or need assistance with your payment, please contact our admin team through the messaging system.

We appreciate your continued membership with ARB4ME!

The ARB4ME Team`;

            // Insert message
            const messageResult = await client.query(`
                INSERT INTO messages (user_id, subject, content, message_type, status, admin_user_id, reminder_type)
                VALUES ($1, $2, $3, 'admin_to_user', 'sent', 'auto_reminder_system', $4)
                RETURNING id, created_at
            `, [user.id, subject, content, reminderType]);

            // Update user reminder flags
            if (reminderType === '7day') {
                await client.query(`
                    UPDATE users 
                    SET 
                        seven_day_reminder_sent = TRUE,
                        last_reminder_type = '7day',
                        last_reminder_date = CURRENT_DATE
                    WHERE id = $1
                `, [user.id]);
            } else if (reminderType === '1day') {
                await client.query(`
                    UPDATE users 
                    SET 
                        one_day_reminder_sent = TRUE,
                        last_reminder_type = '1day',
                        last_reminder_date = CURRENT_DATE
                    WHERE id = $1
                `, [user.id]);
            }

            // Log to auto_reminders_log table
            await client.query(`
                INSERT INTO auto_reminders_log (
                    user_id, reminder_type, subscription_expires_at, 
                    days_until_expiry, message_id, user_email, user_name
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                user.id, 
                reminderType, 
                user.subscription_expires_at,
                daysUntilExpiry,
                messageResult.rows[0].id,
                user.email,
                `${user.first_name} ${user.last_name}`.trim()
            ]);

            return {
                userId: user.id,
                reminderType: reminderType,
                messageId: messageResult.rows[0].id,
                sentAt: messageResult.rows[0].created_at
            };
        });

        console.log(`📧 Sent ${reminderType} reminder to ${user.first_name} ${user.last_name} (${user.email})`);
        return result;
    }

    // Manual trigger for testing
    async runManualTest() {
        console.log('🧪 Running manual test of auto-reminder system...');
        await this.runDailyReminders();
        return this.stats;
    }

    // Get current stats
    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            lastRunTime: this.lastRunTime
        };
    }
}

// Create singleton instance
const autoReminderService = new AutoReminderService();

module.exports = autoReminderService;