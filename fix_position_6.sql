-- Fix stuck position 6 based on actual VALR transaction history
-- Transaction: Sold 4.085400 XRP for 9.342945 USDT on 04 Nov 2025 07:36

UPDATE momentum_positions 
SET 
    status = 'CLOSED',
    exit_price = 2.288,              -- 9.342945 / 4.085400 = 2.288 per XRP
    exit_quantity = 4.085400,         -- Actual sold amount from VALR
    exit_fee = 0.009343,              -- Estimate 0.1% of 9.342945
    exit_time = '2025-11-04 07:36:00',
    exit_reason = 'max_hold_time',
    exit_pnl_usdt = -0.657,           -- 9.342945 - 9.999970 = -0.657
    exit_pnl_percent = -6.57,         -- (-0.657 / 9.999970) * 100
    exit_order_id = NULL,
    updated_at = NOW()
WHERE id = 6;

-- Verify the update
SELECT id, status, entry_price, exit_price, entry_quantity, exit_quantity, exit_pnl_usdt, exit_pnl_percent, exit_time
FROM momentum_positions 
WHERE id = 6;
