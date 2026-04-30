-- Expose workspace accent on organization_public_by_slug so the tenant login URL
-- (anon-friendly) can theme the auth gate to match Settings → Branding.

DROP FUNCTION IF EXISTS public.organization_public_by_slug(text);
CREATE FUNCTION public.organization_public_by_slug(sl text)
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  onboarding_completed boolean,
  onboarding jsonb,
  login_accent text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.slug,
    o.name,
    o.onboarding_completed,
    coalesce(o.onboarding, '{}'::jsonb),
    nullif(trim(coalesce(s.dashboard_settings #>> '{business,accent}', '')), '') AS login_accent
  FROM public.organizations o
  LEFT JOIN public.app_settings s ON s.organization_id = o.id
  WHERE o.slug = lower(trim(sl))
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.organization_public_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_public_by_slug(text) TO anon, authenticated, service_role;
