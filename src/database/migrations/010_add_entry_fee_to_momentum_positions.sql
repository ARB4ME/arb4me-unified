-- Add entry_fee column to momentum_positions
-- Properly track entry fees for accurate P&L calculations
-- Created: 2025-10-28

-- Add entry_fee column if it doesn't exist
ALTER TABLE momentum_positions
ADD COLUMN IF NOT EXISTS entry_fee DECIMAL(12,4) DEFAULT 0;

-- Estimate fees for existing positions (0.1% of entry value)
UPDATE momentum_positions
SET entry_fee = entry_value_usdt * 0.001
WHERE entry_fee IS NULL OR entry_fee = 0;

-- Comment for documentation
COMMENT ON COLUMN momentum_positions.entry_fee IS 'Entry order fee in USDT (actual or 0.1% estimate)';
