-- Multi-step onboarding: organizations.onboarding + RPCs + list/slug RPC shape.
-- Idempotent column add; replaces update_workspace_profile (no longer sets onboarding_completed).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.organizations.onboarding IS 'Wizard state: currentStep, referral, billingCountry, useCase keys, etc. Shallow-merge patches from save_onboarding_progress.';
CREATE OR REPLACE FUNCTION public.update_workspace_profile(p_org_id uuid, p_name text, p_slug text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  nm text := trim(both from coalesce(p_name, ''));
  sl text := lower(trim(both from coalesce(p_slug, '')));
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Not authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = p_org_id AND m.user_id = uid AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Not allowed to update this workspace');
  END IF;
  IF length(nm) < 1 OR length(nm) > 200 THEN
    RETURN json_build_object('ok', false, 'error', 'Name is required (max 200 characters)');
  END IF;
  IF NOT public.workspace_slug_is_valid(sl) THEN
    RETURN json_build_object('ok', false, 'error', 'Invalid URL slug (lowercase letters, numbers, hyphens; 2–63 chars)');
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = sl AND o.id IS DISTINCT FROM p_org_id) THEN
    RETURN json_build_object('ok', false, 'error', 'That URL slug is already taken');
  END IF;
  BEGIN
    UPDATE public.organizations
    SET name = nm, slug = sl, updated_at = now()
    WHERE id = p_org_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN json_build_object('ok', false, 'error', 'That URL slug is already taken');
  END;
  RETURN json_build_object('ok', true, 'slug', sl);
END;
$$;
REVOKE ALL ON FUNCTION public.update_workspace_profile(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_workspace_profile(uuid, text, text) TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.save_onboarding_progress(p_org_id uuid, p_patch jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  merged jsonb;
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Not authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = p_org_id AND m.user_id = uid AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Not allowed to update this workspace');
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN json_build_object('ok', false, 'error', 'Invalid patch');
  END IF;
  merged := coalesce((SELECT onboarding FROM public.organizations WHERE id = p_org_id), '{}'::jsonb) || p_patch;
  UPDATE public.organizations
  SET onboarding = merged, updated_at = now()
  WHERE id = p_org_id;
  RETURN json_build_object('ok', true, 'onboarding', merged);
END;
$$;
REVOKE ALL ON FUNCTION public.save_onboarding_progress(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_onboarding_progress(uuid, jsonb) TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.complete_workspace_onboarding(p_org_id uuid, p_final jsonb)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  merged jsonb;
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Not authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = p_org_id AND m.user_id = uid AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Not allowed to update this workspace');
  END IF;
  merged := coalesce((SELECT onboarding FROM public.organizations WHERE id = p_org_id), '{}'::jsonb);
  IF p_final IS NOT NULL AND jsonb_typeof(p_final) = 'object' THEN
    merged := merged || p_final;
  END IF;
  merged := merged || jsonb_build_object('completedAt', to_jsonb(now()));
  UPDATE public.organizations
  SET onboarding = merged, onboarding_completed = true, updated_at = now()
  WHERE id = p_org_id;
  RETURN json_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.complete_workspace_onboarding(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_workspace_onboarding(uuid, jsonb) TO authenticated, service_role;
DROP FUNCTION IF EXISTS public.my_organizations();
DROP FUNCTION IF EXISTS public.organization_public_by_slug(text);
CREATE FUNCTION public.organization_public_by_slug(sl text)
RETURNS TABLE (id uuid, slug text, name text, onboarding_completed boolean, onboarding jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.name, o.onboarding_completed, coalesce(o.onboarding, '{}'::jsonb)
  FROM public.organizations o
  WHERE o.slug = lower(trim(sl))
  LIMIT 1;
$$;
CREATE FUNCTION public.my_organizations()
RETURNS TABLE (id uuid, slug text, name text, role text, onboarding_completed boolean, onboarding jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.slug, o.name, m.role, o.onboarding_completed, coalesce(o.onboarding, '{}'::jsonb)
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = auth.uid()
  ORDER BY o.created_at ASC;
$$;
REVOKE ALL ON FUNCTION public.organization_public_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_public_by_slug(text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.my_organizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_organizations() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.organization_public_by_slug(text) FROM anon;
