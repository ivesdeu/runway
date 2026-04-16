-- Workspace onboarding flag + profile RPCs + second-org creation.
-- Run in Supabase SQL Editor after organizations_multitenancy.sql.

-- -----------------------------------------------------------------------------
-- 1. Column: new signups need setup; existing orgs stay "completed"
-- -----------------------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.onboarding_completed IS 'False until first-time workspace setup is finished in the dashboard.';

-- -----------------------------------------------------------------------------
-- 2. New users: default org starts with onboarding_completed = false
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org uuid := gen_random_uuid();
  s text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  s := 'org-' || substr(replace(NEW.id::text, '-', ''), 1, 12);
  s := lower(s);
  WHILE EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = s) LOOP
    s := 'org-' || substr(md5(random()::text || NEW.id::text), 1, 12);
  END LOOP;
  INSERT INTO public.organizations (id, slug, name, created_at, updated_at, onboarding_completed)
  VALUES (new_org, s, split_part(COALESCE(NEW.email, 'user'), '@', 1), now(), now(), false);
  INSERT INTO public.organization_members (organization_id, user_id, role, created_at)
  VALUES (new_org, NEW.id, 'owner', now());
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Slug validation (matches organizations_slug_lower)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_slug_is_valid(p_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(trim(p_slug)) = p_slug
    AND p_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$';
$$;

REVOKE ALL ON FUNCTION public.workspace_slug_is_valid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_slug_is_valid(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Update org name + slug + mark onboarding done (owner/admin only)
-- -----------------------------------------------------------------------------
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
    SET name = nm, slug = sl, updated_at = now(), onboarding_completed = true
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

-- -----------------------------------------------------------------------------
-- 5. Create another workspace (owner of new org)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_workspace_for_user(p_name text, p_slug text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  nm text := trim(both from coalesce(p_name, ''));
  sl text := lower(trim(both from coalesce(p_slug, '')));
  new_org uuid := gen_random_uuid();
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Not authenticated');
  END IF;
  IF length(nm) < 1 OR length(nm) > 200 THEN
    RETURN json_build_object('ok', false, 'error', 'Name is required (max 200 characters)');
  END IF;
  IF NOT public.workspace_slug_is_valid(sl) THEN
    RETURN json_build_object('ok', false, 'error', 'Invalid URL slug (lowercase letters, numbers, hyphens; 2–63 chars)');
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = sl) THEN
    RETURN json_build_object('ok', false, 'error', 'That URL slug is already taken');
  END IF;
  BEGIN
    INSERT INTO public.organizations (id, slug, name, created_at, updated_at, onboarding_completed)
    VALUES (new_org, sl, nm, now(), now(), true);
  EXCEPTION
    WHEN unique_violation THEN
      RETURN json_build_object('ok', false, 'error', 'That URL slug is already taken');
  END;
  INSERT INTO public.organization_members (organization_id, user_id, role, created_at)
  VALUES (new_org, uid, 'owner', now());
  RETURN json_build_object('ok', true, 'id', new_org, 'slug', sl);
END;
$$;

REVOKE ALL ON FUNCTION public.create_workspace_for_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_workspace_for_user(text, text) TO authenticated, service_role;
