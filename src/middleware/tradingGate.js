/**
 * Trading Gate Middleware
 * Blocks trading for users with unpaid invoices (3% profit billing)
 * Created: 2026-08-06
 */

const { query } = require('../database/connection');

/**
 * Check if user can trade (no unpaid invoices)
 * Use this middleware before any trade execution endpoints
 */
const requirePaidInvoices = async (req, res, next) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }

        // Check if user can trade using database function
        const result = await query(
            'SELECT can_user_trade($1) as can_trade',
            [userId]
        );

        const canTrade = result.rows[0]?.can_trade ?? true;

        if (!canTrade) {
            // Get the unpaid invoice details
            const invoiceResult = await query(
                `SELECT id, fee_amount, billing_period_start, billing_period_end, generated_at
                 FROM billing_invoices
                 WHERE user_id = $1 AND status = 'unpaid'
                 ORDER BY billing_period_start DESC LIMIT 1`,
                [userId]
            );

            const invoice = invoiceResult.rows[0];

            return res.status(403).json({
                success: false,
                error: 'Trading blocked - unpaid invoice',
                code: 'INVOICE_UNPAID',
                data: {
                    message: 'Please pay your outstanding invoice to continue trading',
                    invoice: invoice ? {
                        id: invoice.id,
                        amount: parseFloat(invoice.fee_amount),
                        periodStart: invoice.billing_period_start,
                        periodEnd: invoice.billing_period_end,
                        generatedAt: invoice.generated_at
                    } : null,
                    action: 'PAY_INVOICE'
                }
            });
        }

        // User can trade - continue
        next();

    } catch (error) {
        console.error('Trading gate error:', error);
        // On error, allow trading (fail open) to not block legitimate trades
        // But log the error for investigation
        next();
    }
};

/**
 * Soft check - adds canTrade status to request but doesn't block
 * Useful for endpoints that want to show warnings but not block completely
 */
const checkTradingStatus = async (req, res, next) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            req.tradingStatus = { canTrade: false, reason: 'not_authenticated' };
            return next();
        }

        const result = await query(
            'SELECT can_user_trade($1) as can_trade',
            [userId]
        );

        const canTrade = result.rows[0]?.can_trade ?? true;

        if (!canTrade) {
            const invoiceResult = await query(
                `SELECT id, fee_amount FROM billing_invoices
                 WHERE user_id = $1 AND status = 'unpaid'
                 ORDER BY billing_period_start DESC LIMIT 1`,
                [userId]
            );

            req.tradingStatus = {
                canTrade: false,
                reason: 'unpaid_invoice',
                invoiceId: invoiceResult.rows[0]?.id,
                amountDue: parseFloat(invoiceResult.rows[0]?.fee_amount || 0)
            };
        } else {
            req.tradingStatus = { canTrade: true };
        }

        next();

    } catch (error) {
        console.error('Trading status check error:', error);
        req.tradingStatus = { canTrade: true, error: true };
        next();
    }
};

/**
 * Check billing period and auto-generate invoice if needed
 * Call this periodically or on user login
 */
const checkAndGenerateInvoice = async (userId) => {
    try {
        // Get user's current billing period
        const periodResult = await query(
            'SELECT * FROM get_user_billing_period($1)',
            [userId]
        );

        const period = periodResult.rows[0];
        if (!period) return null;

        // Check if period has ended and we need to generate invoice
        const periodEnd = new Date(period.period_end);
        const now = new Date();

        if (now > periodEnd) {
            // Period has ended - check if invoice exists
            const existingInvoice = await query(
                `SELECT id FROM billing_invoices
                 WHERE user_id = $1 AND billing_period_start = $2`,
                [userId, period.period_start]
            );

            if (existingInvoice.rows.length === 0) {
                // Generate invoice
                const result = await query(
                    'SELECT generate_user_invoice($1, $2, $3) as invoice_id',
                    [userId, period.period_start, period.period_end]
                );

                return result.rows[0]?.invoice_id;
            }
        }

        return null;

    } catch (error) {
        console.error('Error checking/generating invoice:', error);
        return null;
    }
};

module.exports = {
    requirePaidInvoices,
    checkTradingStatus,
    checkAndGenerateInvoice
};
