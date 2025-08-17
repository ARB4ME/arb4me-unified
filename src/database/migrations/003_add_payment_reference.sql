-- Migration: Add permanent payment reference ID to users
-- This creates a unique 6-digit reference number for each user
-- Format: ARB-XXXXXX (e.g., ARB-100001)

-- Add sequence for generating unique 6-digit IDs
CREATE SEQUENCE IF NOT EXISTS user_payment_ref_seq
    START WITH 100001
    INCREMENT BY 1
    MINVALUE 100001
    MAXVALUE 999999
    NO CYCLE;

-- Add payment_reference column to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(20) UNIQUE;

-- Create function to generate payment reference
CREATE OR REPLACE FUNCTION generate_payment_reference()
RETURNS VARCHAR AS $$
DECLARE
    new_ref VARCHAR(20);
    ref_num INTEGER;
BEGIN
    -- Get next value from sequence
    ref_num := nextval('user_payment_ref_seq');
    new_ref := 'ARB-' || ref_num::TEXT;
    RETURN new_ref;
END;
$$ LANGUAGE plpgsql;

-- Update existing users with payment references
UPDATE users 
SET payment_reference = generate_payment_reference()
WHERE payment_reference IS NULL;

-- Make payment_reference NOT NULL after populating existing records
ALTER TABLE users 
ALTER COLUMN payment_reference SET NOT NULL;

-- Set default for new users
ALTER TABLE users 
ALTER COLUMN payment_reference SET DEFAULT generate_payment_reference();

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_payment_reference 
ON users(payment_reference);

-- Add comment explaining the column
COMMENT ON COLUMN users.payment_reference IS 'Unique payment reference in format ARB-XXXXXX used for all payments and as customer identifier';