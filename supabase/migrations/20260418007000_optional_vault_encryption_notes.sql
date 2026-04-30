-- Optional: Supabase Vault / column encryption for refresh_token
-- -----------------------------------------------------------------
-- This repo stores tokens in integration_credentials (service_role only).
-- For stricter models you can:
--
-- 1) Supabase Vault (see https://supabase.com/docs/guides/database/vault)
--    - Store a master secret in vault.decrypted_secrets
--    - Use vault.create_secret / vault.decrypted_secrets in RPCs that run as SECURITY DEFINER
--
-- 2) pgsodium (if enabled on your project)
--    - Encrypt refresh_token column with a server-side key never sent to the browser
--
-- 3) Application-level AES-GCM in Edge Functions using INTEGRATION_TOKEN_ENCRYPTION_KEY
--    (set via `supabase secrets set`) before writing to integration_credentials.
--
-- No-op migration: run the statements you choose in the SQL editor when you adopt Vault/pgsodium.

SELECT 1;
