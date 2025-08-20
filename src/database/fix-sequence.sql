-- Create sequence if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'user_payment_ref_seq') THEN
        CREATE SEQUENCE user_payment_ref_seq START WITH 1000 INCREMENT BY 1;
        RAISE NOTICE 'Created user_payment_ref_seq sequence';
    ELSE
        RAISE NOTICE 'user_payment_ref_seq sequence already exists';
    END IF;
END $$;

-- Ensure the sequence starts at a safe number
SELECT setval('user_payment_ref_seq', COALESCE((SELECT MAX(CAST(SUBSTRING(id FROM 6) AS INTEGER)) FROM users WHERE id LIKE 'user_%'), 1000), true);