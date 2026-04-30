-- Add needs_onboarding to eliminate a second client round-trip after login (RETURNS shape change → DROP).

DROP FUNCTION IF EXISTS public.resolve_session_workspace(text);
CREATE OR REPLACE FUNCTION public.resolve_session_workspace(p_slug text DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  role text,
  onboarding_completed boolean,
  needs_onboarding boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s text := nullif(lower(trim(coalesce(p_slug, ''))), '');
BEGIN
  IF s IS NULL OR s = '' THEN
    RETURN QUERY
    SELECT
      o.id,
      o.slug,
      o.name,
      m.role,
      o.onboarding_completed,
      (o.onboarding_completed = false) AS needs_onboarding
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = auth.uid()
    ORDER BY o.created_at ASC
    LIMIT 1;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = s) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = auth.uid()
      AND o.slug = s
  ) THEN
    RETURN QUERY
    SELECT
      o.id,
      o.slug,
      o.name,
      m.role,
      o.onboarding_completed,
      (o.onboarding_completed = false) AS needs_onboarding
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = auth.uid()
      AND o.slug = s
    LIMIT 1;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.slug,
    o.name,
    m.role,
    o.onboarding_completed,
    (o.onboarding_completed = false) AS needs_onboarding
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = auth.uid()
  ORDER BY o.created_at ASC
  LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_session_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_session_workspace(text) TO authenticated, service_role;
