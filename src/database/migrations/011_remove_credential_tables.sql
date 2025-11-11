-- Migration 011: Remove Server-Side Credential Storage
-- Security Enhancement: Move all API credentials to client-side localStorage only
-- Date: 2025-01-11
-- BREAKING CHANGE: Users will need to re-enter credentials after this migration

-- ═══════════════════════════════════════════════════════════════════════
-- RATIONALE
-- ═══════════════════════════════════════════════════════════════════════
-- Storing thousands of users' exchange API credentials on our server creates
-- an unacceptable security liability. All 5 strategies (Cross-Exchange,
-- Triangular, Transfer, Momentum, Currency Swap) now use localStorage only,
-- passing credentials in API requests without server-side persistence.

-- ═══════════════════════════════════════════════════════════════════════
-- DROP CREDENTIAL TABLES
-- ═══════════════════════════════════════════════════════════════════════

-- Drop Momentum credentials table
DROP TABLE IF EXISTS momentum_credentials CASCADE;

-- Drop Currency Swap credentials table
DROP TABLE IF EXISTS currency_swap_credentials CASCADE;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════
-- After running this migration, verify tables are dropped:
-- \dt (should not show momentum_credentials or currency_swap_credentials)

-- ═══════════════════════════════════════════════════════════════════════
-- POST-MIGRATION ACTIONS REQUIRED
-- ═══════════════════════════════════════════════════════════════════════
-- 1. Users must re-enter credentials via Strategy API Configuration page
-- 2. Credentials will be stored in browser localStorage only
-- 3. Server never sees or stores credentials after this migration
-- 4. All strategies now follow consistent security model
