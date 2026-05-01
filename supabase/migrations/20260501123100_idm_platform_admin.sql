-- IDM platform admin organization + role
-- Purpose: allow a dedicated internal org (IDM) to grant admin features across apps.
-- Idempotent migration.

-- 1) Allow a special membership role for platform admins.
DO $$
BEGIN
  -- Drop and recreate the CHECK constraint to include 'platform_admin'.
  -- Constraint name is not guaranteed, so we scan for the role check on organization_members.
  IF to_regclass('public.organization_members') IS NOT NULL THEN
    -- Drop any existing role check constraints that match the legacy set.
    EXECUTE (
      SELECT coalesce(
        string_agg(format('ALTER TABLE public.organization_members DROP CONSTRAINT IF EXISTS %I;', c.conname), ' '),
        'SELECT 1;'
      )
      FROM pg_constraint c
      WHERE c.conrelid = 'public.organization_members'::regclass
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%role IN (%owner%,%admin%,%member%,%viewer%)%'
    );
    -- Add the new check if it doesn't already exist.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conrelid = 'public.organization_members'::regclass
        AND c.contype = 'c'
        AND c.conname = 'organization_members_role_check'
    ) THEN
      ALTER TABLE public.organization_members
        ADD CONSTRAINT organization_members_role_check
        CHECK (role IN ('owner','admin','member','viewer','platform_admin'));
    END IF;
  END IF;
END $$;

-- 2) Ensure IDM org exists (canonical slug 'idm').
INSERT INTO public.organizations (slug, name, admin_email, onboarding_completed)
VALUES ('idm', 'IDM', 'contact@ivesdeu.com', true)
ON CONFLICT (slug) DO NOTHING;

-- 3) Ensure IDM has Compass+Runway entitlements (Runway implies Compass).
INSERT INTO public.organization_apps (organization_id, app_key, enabled)
SELECT o.id, x.app_key, true
FROM public.organizations o
JOIN (VALUES ('compass'), ('runway')) AS x(app_key) ON true
WHERE o.slug = 'idm'
ON CONFLICT (organization_id, app_key) DO NOTHING;

-- 4) Helper: is current user a platform admin (member of IDM with role platform_admin)?
DROP FUNCTION IF EXISTS public.is_platform_admin();
CREATE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = auth.uid()
      AND o.slug = 'idm'
      AND m.role = 'platform_admin'
  );
$$;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

