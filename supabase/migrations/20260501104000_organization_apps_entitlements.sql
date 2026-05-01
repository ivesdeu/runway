-- Organization-level app entitlements (Compass / Runway / future apps)
-- Goal: keep a single shared `organizations` table and let apps gate access by entitlements.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.organization_apps (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  app_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_apps_app_key_trim CHECK (app_key = lower(trim(app_key)) AND app_key <> ''),
  PRIMARY KEY (organization_id, app_key)
);

CREATE INDEX IF NOT EXISTS organization_apps_app_key_enabled_idx
  ON public.organization_apps (app_key, enabled, organization_id);

ALTER TABLE public.organization_apps ENABLE ROW LEVEL SECURITY;

-- Default: deny direct access. Access should be mediated by SECURITY DEFINER RPCs or service_role.
DROP POLICY IF EXISTS organization_apps_deny_all ON public.organization_apps;
CREATE POLICY organization_apps_deny_all ON public.organization_apps
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

-- Helper: check if an org has an app enabled.
DROP FUNCTION IF EXISTS public.org_app_enabled(uuid, text);
CREATE FUNCTION public.org_app_enabled(p_org_id uuid, p_app_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_apps oa
    WHERE oa.organization_id = p_org_id
      AND oa.app_key = lower(trim(p_app_key))
      AND oa.enabled = true
  );
$$;
REVOKE ALL ON FUNCTION public.org_app_enabled(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_app_enabled(uuid, text) TO authenticated, service_role;

-- Helper: signed-in user's orgs filtered by app entitlement.
DROP FUNCTION IF EXISTS public.my_enabled_organizations(text);
CREATE FUNCTION public.my_enabled_organizations(p_app_key text)
RETURNS TABLE (id uuid, slug text, name text, role text, onboarding_completed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.name, m.role, o.onboarding_completed
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.organization_id
  JOIN public.organization_apps oa ON oa.organization_id = o.id
  WHERE m.user_id = auth.uid()
    AND oa.app_key = lower(trim(p_app_key))
    AND oa.enabled = true
  ORDER BY o.created_at ASC;
$$;
REVOKE ALL ON FUNCTION public.my_enabled_organizations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_enabled_organizations(text) TO authenticated, service_role;

-- Backfill: since Compass is the base product that creates org rows, mark all existing orgs as Compass-enabled.
-- This is intentionally org-level (not user-level).
INSERT INTO public.organization_apps (organization_id, app_key, enabled)
SELECT o.id, 'compass', true
FROM public.organizations o
ON CONFLICT (organization_id, app_key) DO NOTHING;

