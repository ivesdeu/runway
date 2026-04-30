-- New users: default workspace name from signup metadata when provided (otherwise email local-part).

CREATE OR REPLACE FUNCTION public.handle_new_user_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org uuid := gen_random_uuid();
  s text;
  org_name text;
  meta jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  s := 'org-' || substr(replace(NEW.id::text, '-', ''), 1, 12);
  s := lower(s);
  WHILE EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = s) LOOP
    s := 'org-' || substr(md5(random()::text || NEW.id::text), 1, 12);
  END LOOP;

  meta := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  org_name := NULLIF(trim(both from COALESCE(meta->>'company_name', '')), '');
  IF org_name IS NULL OR length(org_name) < 1 THEN
    org_name := split_part(COALESCE(NEW.email, 'user'), '@', 1);
  END IF;
  org_name := left(org_name, 200);

  INSERT INTO public.organizations (id, slug, name, created_at, updated_at, onboarding_completed)
  VALUES (new_org, s, org_name, now(), now(), false);
  INSERT INTO public.organization_members (organization_id, user_id, role, created_at)
  VALUES (new_org, NEW.id, 'owner', now());
  RETURN NEW;
END;
$$;
