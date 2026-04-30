-- New-user trigger omitted onboarding_completed, so NOT NULL DEFAULT true applied and onboarding never showed.
-- 1) Recreate trigger to insert onboarding_completed = false for new auth.users.
-- 2) Backfill: default slug org- + 12 hex chars means workspace setup was never finished (user never saved step 2).

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
UPDATE public.organizations o
SET onboarding_completed = false
WHERE o.onboarding_completed = true
  AND o.slug ~ '^org-[0-9a-f]{12}$'
  AND NOT (coalesce(o.onboarding, '{}'::jsonb) ? 'completedAt');
