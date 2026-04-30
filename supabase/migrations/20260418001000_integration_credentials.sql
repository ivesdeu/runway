-- Integration OAuth tokens (Google / Microsoft Graph, etc.)
-- Written only by Edge Functions using the service role key.
-- Run in Supabase SQL editor after organizations_multitenancy.sql.

CREATE TABLE IF NOT EXISTS public.integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  provider_account_id text,
  raw_token jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, provider)
);
CREATE INDEX IF NOT EXISTS integration_credentials_org_idx ON public.integration_credentials (organization_id);
CREATE INDEX IF NOT EXISTS integration_credentials_user_idx ON public.integration_credentials (user_id);
ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;
-- No policies: authenticated/anon cannot read rows. Edge Functions use service_role (bypasses RLS).
REVOKE ALL ON public.integration_credentials FROM PUBLIC;
GRANT ALL ON public.integration_credentials TO service_role;
COMMENT ON TABLE public.integration_credentials IS
  'OAuth refresh/access tokens for workspace integrations; only service_role Edge Functions should access.';
