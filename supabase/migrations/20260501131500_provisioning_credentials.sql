-- Store temporary credentials for developer provisioning (plaintext by request).
-- SECURITY: this table is locked down via RLS; only service_role should read/write.

CREATE TABLE IF NOT EXISTS public.organization_provisioning_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('org_admin', 'invite_user')),
  temporary_password text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

DO $cred_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_provisioning_credentials_email_trim'
      AND conrelid = 'public.organization_provisioning_credentials'::regclass
  ) THEN
    ALTER TABLE public.organization_provisioning_credentials
      ADD CONSTRAINT organization_provisioning_credentials_email_trim
      CHECK (email = lower(trim(email)) AND email <> '');
  END IF;
END $cred_checks$;

CREATE INDEX IF NOT EXISTS organization_provisioning_credentials_org_email_created_idx
  ON public.organization_provisioning_credentials (organization_id, email, created_at DESC);

ALTER TABLE public.organization_provisioning_credentials ENABLE ROW LEVEL SECURITY;

-- Deny all for normal authenticated users.
DROP POLICY IF EXISTS org_prov_creds_deny_all ON public.organization_provisioning_credentials;
CREATE POLICY org_prov_creds_deny_all ON public.organization_provisioning_credentials
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

