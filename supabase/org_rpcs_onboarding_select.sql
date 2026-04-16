-- Run once on existing projects (after organizations.onboarding_completed exists).
-- Removes one round-trip during dashboard auth: my_organizations + organization_public_by_slug
-- include onboarding_completed so the client can skip fetchOrgNeedsOnboarding.
--
-- Postgres cannot change OUT/RETURNS TABLE shape with CREATE OR REPLACE; drop first.

DROP FUNCTION IF EXISTS public.my_organizations();
DROP FUNCTION IF EXISTS public.organization_public_by_slug(text);

CREATE FUNCTION public.organization_public_by_slug(sl text)
RETURNS TABLE (id uuid, slug text, name text, onboarding_completed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.name, o.onboarding_completed
  FROM public.organizations o
  WHERE o.slug = lower(trim(sl))
  LIMIT 1;
$$;

CREATE FUNCTION public.my_organizations()
RETURNS TABLE (id uuid, slug text, name text, role text, onboarding_completed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.name, m.role, o.onboarding_completed
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = auth.uid()
  ORDER BY o.created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.organization_public_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_public_by_slug(text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.my_organizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_organizations() TO authenticated, service_role;
