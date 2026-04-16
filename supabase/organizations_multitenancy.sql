-- Organizations, org-scoped rows, membership + RLS (run in Supabase SQL Editor after dashboard_sync + extensions).
-- Safe to re-run for idempotent pieces; review breaking changes before production.

-- =============================================================================
-- 1. Core org tables
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_lower CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key ON public.organizations (slug);

CREATE TABLE IF NOT EXISTS public.organization_members (
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS organization_members_user_id_idx ON public.organization_members (user_id);

-- =============================================================================
-- 2. Helper functions (RLS)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.user_is_org_member(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id IS NOT DISTINCT FROM p_org_id
      AND m.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.user_can_write_org(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id IS NOT DISTINCT FROM p_org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin', 'member')
  );
$$;

CREATE OR REPLACE FUNCTION public.user_can_admin_org(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id IS NOT DISTINCT FROM p_org_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.user_is_org_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_can_write_org(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_can_admin_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_is_org_member(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_write_org(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_admin_org(uuid) TO anon, authenticated, service_role;

-- Public slug resolve (no secrets)
-- OUT shape change: drop first (CREATE OR REPLACE cannot widen RETURNS TABLE on existing PG functions).
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
REVOKE ALL ON FUNCTION public.organization_public_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_public_by_slug(text) TO anon, authenticated, service_role;

-- Signed-in user's org memberships (for redirect / picker)
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
REVOKE ALL ON FUNCTION public.my_organizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_organizations() TO authenticated, service_role;

-- =============================================================================
-- 3. Add organization_id columns (nullable first)
-- =============================================================================
DO $addcol$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'clients', 'transactions', 'projects', 'invoices', 'campaigns', 'timesheet_entries',
    'crm_events', 'weekly_summaries',
    'pipelines', 'pipeline_stages', 'workspace_tasks', 'crm_activities',
    'workflow_rules', 'workflow_runs', 'workflow_outbox',
    'ai_usage_events', 'ai_feedback', 'ai_action_outcomes'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE', tbl);
    END IF;
  END LOOP;
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $addcol$;

-- =============================================================================
-- 4. Backfill: one org per distinct legacy user_id (data owner)
-- =============================================================================
DO $bf$
DECLARE
  r record;
  new_org uuid;
  base_slug text;
  final_slug text;
  u uuid;
  bfq text;
BEGIN
  /* app_settings may already use organization_id-only PK (user_id dropped); skip that arm unless the column exists. */
  bfq := format($BF$
    SELECT DISTINCT lu.legacy_user_id
    FROM (
      SELECT c.user_id AS legacy_user_id FROM public.clients c WHERE c.user_id IS NOT NULL
      UNION SELECT t.user_id FROM public.transactions t WHERE t.user_id IS NOT NULL
      UNION SELECT p.user_id FROM public.projects p WHERE p.user_id IS NOT NULL
      UNION SELECT i.user_id FROM public.invoices i WHERE i.user_id IS NOT NULL
      UNION SELECT ca.user_id FROM public.campaigns ca WHERE ca.user_id IS NOT NULL
      UNION SELECT te.user_id FROM public.timesheet_entries te WHERE te.user_id IS NOT NULL
      %s
      UNION SELECT ce.user_id FROM public.crm_events ce WHERE ce.user_id IS NOT NULL
      UNION SELECT ws.user_id FROM public.weekly_summaries ws WHERE ws.user_id IS NOT NULL
      UNION SELECT pl.user_id FROM public.pipelines pl WHERE pl.user_id IS NOT NULL
      UNION SELECT ps.user_id FROM public.pipeline_stages ps WHERE ps.user_id IS NOT NULL
      UNION SELECT wt.user_id FROM public.workspace_tasks wt WHERE wt.user_id IS NOT NULL
      UNION SELECT cra.user_id FROM public.crm_activities cra WHERE cra.user_id IS NOT NULL
      UNION SELECT wr.user_id FROM public.workflow_rules wr WHERE wr.user_id IS NOT NULL
      UNION SELECT wru.user_id FROM public.workflow_runs wru WHERE wru.user_id IS NOT NULL
      UNION SELECT wo.user_id FROM public.workflow_outbox wo WHERE wo.user_id IS NOT NULL
      UNION SELECT au.user_id FROM public.ai_usage_events au WHERE au.user_id IS NOT NULL
      UNION SELECT af.user_id FROM public.ai_feedback af WHERE af.user_id IS NOT NULL
      UNION SELECT ao.user_id FROM public.ai_action_outcomes ao WHERE ao.user_id IS NOT NULL
    ) lu
  $BF$,
    CASE WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'app_settings'
        AND column_name = 'user_id'
    ) THEN 'UNION SELECT a.user_id FROM public.app_settings a WHERE a.user_id IS NOT NULL' ELSE '' END
  );
  FOR r IN EXECUTE bfq
  LOOP
    u := r.legacy_user_id;
    IF EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = u) THEN
      CONTINUE;
    END IF;
    new_org := gen_random_uuid();
    base_slug := 'org-' || substr(replace(u::text, '-', ''), 1, 12);
    final_slug := lower(base_slug);
    WHILE EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = final_slug) LOOP
      final_slug := 'org-' || substr(md5(random()::text || u::text), 1, 12);
    END LOOP;
    INSERT INTO public.organizations (id, slug, name, created_at, updated_at)
    VALUES (new_org, final_slug, 'Workspace', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, created_at)
    VALUES (new_org, u, 'owner', now());
  END LOOP;
END $bf$;

-- Orphan auth users (no row in any table yet): optional second pass from auth.users
DO $authorph$
DECLARE
  r record;
  new_org uuid;
  final_slug text;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT au.id AS user_id
    FROM auth.users au
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = au.id)
    LIMIT 5000
  LOOP
    new_org := gen_random_uuid();
    final_slug := 'org-' || substr(replace(r.user_id::text, '-', ''), 1, 12);
    final_slug := lower(final_slug);
    WHILE EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = final_slug) LOOP
      final_slug := 'org-' || substr(md5(random()::text || r.user_id::text), 1, 12);
    END LOOP;
    INSERT INTO public.organizations (id, slug, name, created_at, updated_at)
    VALUES (new_org, final_slug, 'Workspace', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, created_at)
    VALUES (new_org, r.user_id, 'owner', now());
  END LOOP;
END $authorph$;

-- Map user_id -> organization_id via membership (single owner org per user from backfill)
UPDATE public.clients c
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE c.user_id = om.user_id AND c.organization_id IS NULL AND om.role = 'owner';

UPDATE public.transactions t
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE t.user_id = om.user_id AND t.organization_id IS NULL AND om.role = 'owner';

UPDATE public.projects p
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE p.user_id = om.user_id AND p.organization_id IS NULL AND om.role = 'owner';

UPDATE public.invoices i
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE i.user_id = om.user_id AND i.organization_id IS NULL AND om.role = 'owner';

UPDATE public.campaigns ca
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE ca.user_id = om.user_id AND ca.organization_id IS NULL AND om.role = 'owner';

UPDATE public.timesheet_entries te
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE te.user_id = om.user_id AND te.organization_id IS NULL AND om.role = 'owner';

UPDATE public.crm_events e
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE e.user_id = om.user_id AND e.organization_id IS NULL AND om.role = 'owner';

UPDATE public.weekly_summaries w
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE w.user_id = om.user_id AND w.organization_id IS NULL AND om.role = 'owner';

UPDATE public.pipelines pl
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE pl.user_id = om.user_id AND pl.organization_id IS NULL AND om.role = 'owner';

UPDATE public.pipeline_stages ps
SET organization_id = pl.organization_id
FROM public.pipelines pl
WHERE ps.pipeline_id = pl.id AND ps.organization_id IS NULL AND pl.organization_id IS NOT NULL;

UPDATE public.pipeline_stages ps
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE ps.user_id = om.user_id AND ps.organization_id IS NULL AND om.role = 'owner';

UPDATE public.workspace_tasks wt
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE wt.user_id = om.user_id AND wt.organization_id IS NULL AND om.role = 'owner';

UPDATE public.crm_activities a
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE a.user_id = om.user_id AND a.organization_id IS NULL AND om.role = 'owner';

UPDATE public.workflow_rules wr
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE wr.user_id = om.user_id AND wr.organization_id IS NULL AND om.role = 'owner';

UPDATE public.workflow_runs wrn
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE wrn.user_id = om.user_id AND wrn.organization_id IS NULL AND om.role = 'owner';

UPDATE public.workflow_outbox wo
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE wo.user_id = om.user_id AND wo.organization_id IS NULL AND om.role = 'owner';

UPDATE public.ai_usage_events ai
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE ai.user_id = om.user_id AND ai.organization_id IS NULL AND om.role = 'owner';

UPDATE public.ai_feedback fb
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE fb.user_id = om.user_id AND fb.organization_id IS NULL AND om.role = 'owner';

UPDATE public.ai_action_outcomes ao
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE ao.user_id = om.user_id AND ao.organization_id IS NULL AND om.role = 'owner';

-- app_settings: attach to owner's org (skip if user_id already removed)
DO $asmap$
BEGIN
  IF to_regclass('public.app_settings') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'user_id'
  ) THEN
    RETURN;
  END IF;
  UPDATE public.app_settings a
  SET organization_id = om.organization_id
  FROM public.organization_members om
  WHERE a.user_id = om.user_id AND a.organization_id IS NULL AND om.role = 'owner';
END $asmap$;

-- Drop orphan rows that cannot be assigned
DELETE FROM public.clients WHERE user_id IS NULL OR organization_id IS NULL;
DELETE FROM public.transactions WHERE user_id IS NULL OR organization_id IS NULL;

-- =============================================================================
-- 5. app_settings: move primary key to organization_id
-- =============================================================================
DO $appset$
BEGIN
  IF to_regclass('public.app_settings') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM public.app_settings WHERE organization_id IS NULL;
  ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.app_settings DROP COLUMN user_id CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_pkey' AND conrelid = 'public.app_settings'::regclass
  ) THEN
    ALTER TABLE public.app_settings ADD PRIMARY KEY (organization_id);
  END IF;
END $appset$;

-- =============================================================================
-- 6. Unique constraints: org-scoped idempotency / summaries
-- =============================================================================
ALTER TABLE public.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_user_id_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_org_idempotency_key ON public.workflow_runs (organization_id, idempotency_key);

ALTER TABLE public.weekly_summaries DROP CONSTRAINT IF EXISTS weekly_summaries_user_id_summary_type_summary_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS weekly_summaries_org_summary_type_date ON public.weekly_summaries (organization_id, summary_type, summary_date);

-- =============================================================================
-- 7. NOT NULL organization_id on tenant tables
-- =============================================================================
DO $nn$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'clients', 'transactions', 'projects', 'invoices', 'campaigns', 'timesheet_entries',
    'crm_events', 'weekly_summaries',
    'pipelines', 'pipeline_stages', 'workspace_tasks', 'crm_activities',
    'workflow_rules', 'workflow_runs', 'workflow_outbox',
    'ai_usage_events', 'ai_feedback', 'ai_action_outcomes'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', tbl);
    END IF;
  END LOOP;
END $nn$;

CREATE INDEX IF NOT EXISTS clients_organization_id_idx ON public.clients (organization_id);
CREATE INDEX IF NOT EXISTS transactions_organization_id_idx ON public.transactions (organization_id);
CREATE INDEX IF NOT EXISTS projects_organization_id_idx ON public.projects (organization_id);
CREATE INDEX IF NOT EXISTS invoices_organization_id_idx ON public.invoices (organization_id);
CREATE INDEX IF NOT EXISTS campaigns_organization_id_idx ON public.campaigns (organization_id);
CREATE INDEX IF NOT EXISTS timesheet_entries_organization_id_idx ON public.timesheet_entries (organization_id);
CREATE INDEX IF NOT EXISTS crm_events_organization_id_idx ON public.crm_events (organization_id);
CREATE INDEX IF NOT EXISTS weekly_summaries_organization_id_idx ON public.weekly_summaries (organization_id);
CREATE INDEX IF NOT EXISTS pipelines_organization_id_idx ON public.pipelines (organization_id);
CREATE INDEX IF NOT EXISTS pipeline_stages_organization_id_idx ON public.pipeline_stages (organization_id);
CREATE INDEX IF NOT EXISTS workspace_tasks_organization_id_idx ON public.workspace_tasks (organization_id);
CREATE INDEX IF NOT EXISTS crm_activities_organization_id_idx ON public.crm_activities (organization_id);
CREATE INDEX IF NOT EXISTS workflow_rules_organization_id_idx ON public.workflow_rules (organization_id);
CREATE INDEX IF NOT EXISTS workflow_runs_organization_id_idx ON public.workflow_runs (organization_id);
CREATE INDEX IF NOT EXISTS workflow_outbox_organization_id_idx ON public.workflow_outbox (organization_id);
CREATE INDEX IF NOT EXISTS ai_usage_events_organization_id_idx ON public.ai_usage_events (organization_id);
CREATE INDEX IF NOT EXISTS ai_feedback_organization_id_idx ON public.ai_feedback (organization_id);
CREATE INDEX IF NOT EXISTS ai_action_outcomes_organization_id_idx ON public.ai_action_outcomes (organization_id);

-- =============================================================================
-- 8. New user default org (signup)
-- =============================================================================
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
  INSERT INTO public.organizations (id, slug, name, created_at, updated_at)
  VALUES (new_org, s, split_part(COALESCE(NEW.email, 'user'), '@', 1), now(), now());
  INSERT INTO public.organization_members (organization_id, user_id, role, created_at)
  VALUES (new_org, NEW.id, 'owner', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_org ON auth.users;
CREATE TRIGGER on_auth_user_created_org
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user_org();

-- =============================================================================
-- 9. RLS: organizations + members
-- =============================================================================
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organizations_select_member" ON public.organizations;
DROP POLICY IF EXISTS "organizations_update_admin" ON public.organizations;
CREATE POLICY "organizations_select_member" ON public.organizations
  FOR SELECT TO authenticated
  USING (public.user_is_org_member(id));
CREATE POLICY "organizations_update_admin" ON public.organizations
  FOR UPDATE TO authenticated
  USING (public.user_can_admin_org(id))
  WITH CHECK (public.user_can_admin_org(id));

DROP POLICY IF EXISTS "organization_members_select" ON public.organization_members;
DROP POLICY IF EXISTS "organization_members_insert_admin" ON public.organization_members;
CREATE POLICY "organization_members_select" ON public.organization_members
  FOR SELECT TO authenticated
  USING (public.user_is_org_member(organization_id));
CREATE POLICY "organization_members_insert_admin" ON public.organization_members
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_admin_org(organization_id));

GRANT SELECT, UPDATE ON public.organizations TO authenticated;
GRANT SELECT, INSERT ON public.organization_members TO authenticated;

-- =============================================================================
-- 10. RLS policies: drop legacy *_own policies, then org policies
-- =============================================================================
DO $drop_legacy$
BEGIN
  /* clients */
  DROP POLICY IF EXISTS "clients_select_own" ON public.clients;
  DROP POLICY IF EXISTS "clients_insert_own" ON public.clients;
  DROP POLICY IF EXISTS "clients_update_own" ON public.clients;
  DROP POLICY IF EXISTS "clients_delete_own" ON public.clients;
  DROP POLICY IF EXISTS "org_row_select" ON public.clients;
  DROP POLICY IF EXISTS "org_row_insert" ON public.clients;
  DROP POLICY IF EXISTS "org_row_update" ON public.clients;
  DROP POLICY IF EXISTS "org_row_delete" ON public.clients;
  /* transactions */
  DROP POLICY IF EXISTS "transactions_select_own" ON public.transactions;
  DROP POLICY IF EXISTS "transactions_insert_own" ON public.transactions;
  DROP POLICY IF EXISTS "transactions_update_own" ON public.transactions;
  DROP POLICY IF EXISTS "transactions_delete_own" ON public.transactions;
  DROP POLICY IF EXISTS "org_row_select" ON public.transactions;
  DROP POLICY IF EXISTS "org_row_insert" ON public.transactions;
  DROP POLICY IF EXISTS "org_row_update" ON public.transactions;
  DROP POLICY IF EXISTS "org_row_delete" ON public.transactions;
  /* projects */
  DROP POLICY IF EXISTS "projects_select_own" ON public.projects;
  DROP POLICY IF EXISTS "projects_insert_own" ON public.projects;
  DROP POLICY IF EXISTS "projects_update_own" ON public.projects;
  DROP POLICY IF EXISTS "projects_delete_own" ON public.projects;
  DROP POLICY IF EXISTS "org_row_select" ON public.projects;
  DROP POLICY IF EXISTS "org_row_insert" ON public.projects;
  DROP POLICY IF EXISTS "org_row_update" ON public.projects;
  DROP POLICY IF EXISTS "org_row_delete" ON public.projects;
  /* invoices */
  DROP POLICY IF EXISTS "invoices_select_own" ON public.invoices;
  DROP POLICY IF EXISTS "invoices_insert_own" ON public.invoices;
  DROP POLICY IF EXISTS "invoices_update_own" ON public.invoices;
  DROP POLICY IF EXISTS "invoices_delete_own" ON public.invoices;
  DROP POLICY IF EXISTS "org_row_select" ON public.invoices;
  DROP POLICY IF EXISTS "org_row_insert" ON public.invoices;
  DROP POLICY IF EXISTS "org_row_update" ON public.invoices;
  DROP POLICY IF EXISTS "org_row_delete" ON public.invoices;
  /* campaigns */
  DROP POLICY IF EXISTS "campaigns_select_own" ON public.campaigns;
  DROP POLICY IF EXISTS "campaigns_insert_own" ON public.campaigns;
  DROP POLICY IF EXISTS "campaigns_update_own" ON public.campaigns;
  DROP POLICY IF EXISTS "campaigns_delete_own" ON public.campaigns;
  DROP POLICY IF EXISTS "org_row_select" ON public.campaigns;
  DROP POLICY IF EXISTS "org_row_insert" ON public.campaigns;
  DROP POLICY IF EXISTS "org_row_update" ON public.campaigns;
  DROP POLICY IF EXISTS "org_row_delete" ON public.campaigns;
  /* timesheet */
  DROP POLICY IF EXISTS "timesheet_entries_select_own" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "timesheet_entries_insert_own" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "timesheet_entries_update_own" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "timesheet_entries_delete_own" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "org_row_select" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "org_row_insert" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "org_row_update" ON public.timesheet_entries;
  DROP POLICY IF EXISTS "org_row_delete" ON public.timesheet_entries;
  /* app_settings */
  DROP POLICY IF EXISTS "app_settings_select_own" ON public.app_settings;
  DROP POLICY IF EXISTS "app_settings_insert_own" ON public.app_settings;
  DROP POLICY IF EXISTS "app_settings_update_own" ON public.app_settings;
  DROP POLICY IF EXISTS "org_row_select" ON public.app_settings;
  DROP POLICY IF EXISTS "org_row_insert" ON public.app_settings;
  DROP POLICY IF EXISTS "org_row_update" ON public.app_settings;
  /* crm_events */
  DROP POLICY IF EXISTS "crm_events_select_own" ON public.crm_events;
  DROP POLICY IF EXISTS "crm_events_insert_own" ON public.crm_events;
  DROP POLICY IF EXISTS "crm_events_update_own" ON public.crm_events;
  DROP POLICY IF EXISTS "crm_events_delete_own" ON public.crm_events;
  DROP POLICY IF EXISTS "org_row_select" ON public.crm_events;
  DROP POLICY IF EXISTS "org_row_insert" ON public.crm_events;
  DROP POLICY IF EXISTS "org_row_update" ON public.crm_events;
  DROP POLICY IF EXISTS "org_row_delete" ON public.crm_events;
  /* weekly_summaries */
  DROP POLICY IF EXISTS "weekly_summaries_select_own" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "weekly_summaries_insert_own" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "weekly_summaries_update_own" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "weekly_summaries_delete_own" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "org_row_select" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "org_row_insert" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "org_row_update" ON public.weekly_summaries;
  DROP POLICY IF EXISTS "org_row_delete" ON public.weekly_summaries;
  /* pipelines */
  DROP POLICY IF EXISTS "pipelines_select_own" ON public.pipelines;
  DROP POLICY IF EXISTS "pipelines_insert_own" ON public.pipelines;
  DROP POLICY IF EXISTS "pipelines_update_own" ON public.pipelines;
  DROP POLICY IF EXISTS "pipelines_delete_own" ON public.pipelines;
  DROP POLICY IF EXISTS "org_row_select" ON public.pipelines;
  DROP POLICY IF EXISTS "org_row_insert" ON public.pipelines;
  DROP POLICY IF EXISTS "org_row_update" ON public.pipelines;
  DROP POLICY IF EXISTS "org_row_delete" ON public.pipelines;
  /* pipeline_stages */
  DROP POLICY IF EXISTS "pipeline_stages_select_own" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "pipeline_stages_insert_own" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "pipeline_stages_update_own" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "pipeline_stages_delete_own" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "org_row_select" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "org_row_insert" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "org_row_update" ON public.pipeline_stages;
  DROP POLICY IF EXISTS "org_row_delete" ON public.pipeline_stages;
  /* workspace_tasks */
  DROP POLICY IF EXISTS "workspace_tasks_select_own" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "workspace_tasks_insert_own" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "workspace_tasks_update_own" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "workspace_tasks_delete_own" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "org_row_select" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "org_row_insert" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "org_row_update" ON public.workspace_tasks;
  DROP POLICY IF EXISTS "org_row_delete" ON public.workspace_tasks;
  /* crm_activities */
  DROP POLICY IF EXISTS "crm_activities_select_own" ON public.crm_activities;
  DROP POLICY IF EXISTS "crm_activities_insert_own" ON public.crm_activities;
  DROP POLICY IF EXISTS "crm_activities_update_own" ON public.crm_activities;
  DROP POLICY IF EXISTS "crm_activities_delete_own" ON public.crm_activities;
  DROP POLICY IF EXISTS "org_row_select" ON public.crm_activities;
  DROP POLICY IF EXISTS "org_row_insert" ON public.crm_activities;
  DROP POLICY IF EXISTS "org_row_update" ON public.crm_activities;
  DROP POLICY IF EXISTS "org_row_delete" ON public.crm_activities;
  /* workflow_rules */
  DROP POLICY IF EXISTS "workflow_rules_select_own" ON public.workflow_rules;
  DROP POLICY IF EXISTS "workflow_rules_insert_own" ON public.workflow_rules;
  DROP POLICY IF EXISTS "workflow_rules_update_own" ON public.workflow_rules;
  DROP POLICY IF EXISTS "workflow_rules_delete_own" ON public.workflow_rules;
  DROP POLICY IF EXISTS "org_row_select" ON public.workflow_rules;
  DROP POLICY IF EXISTS "org_row_insert" ON public.workflow_rules;
  DROP POLICY IF EXISTS "org_row_update" ON public.workflow_rules;
  DROP POLICY IF EXISTS "org_row_delete" ON public.workflow_rules;
  /* workflow_runs */
  DROP POLICY IF EXISTS "workflow_runs_select_own" ON public.workflow_runs;
  DROP POLICY IF EXISTS "workflow_runs_insert_own" ON public.workflow_runs;
  DROP POLICY IF EXISTS "workflow_runs_update_own" ON public.workflow_runs;
  DROP POLICY IF EXISTS "workflow_runs_delete_own" ON public.workflow_runs;
  DROP POLICY IF EXISTS "org_row_select" ON public.workflow_runs;
  DROP POLICY IF EXISTS "org_row_insert" ON public.workflow_runs;
  DROP POLICY IF EXISTS "org_row_update" ON public.workflow_runs;
  DROP POLICY IF EXISTS "org_row_delete" ON public.workflow_runs;
  /* workflow_outbox */
  DROP POLICY IF EXISTS "workflow_outbox_select_own" ON public.workflow_outbox;
  DROP POLICY IF EXISTS "workflow_outbox_insert_own" ON public.workflow_outbox;
  DROP POLICY IF EXISTS "workflow_outbox_update_own" ON public.workflow_outbox;
  DROP POLICY IF EXISTS "org_row_select" ON public.workflow_outbox;
  DROP POLICY IF EXISTS "org_row_insert" ON public.workflow_outbox;
  DROP POLICY IF EXISTS "org_row_update" ON public.workflow_outbox;
  DROP POLICY IF EXISTS "org_row_delete" ON public.workflow_outbox;
  /* ai_* */
  DROP POLICY IF EXISTS "ai_usage_events_select_own" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "ai_usage_events_insert_own" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "ai_usage_events_update_own" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "ai_usage_events_delete_own" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "org_row_select" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "org_row_insert" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "org_row_update" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "org_row_delete" ON public.ai_usage_events;
  DROP POLICY IF EXISTS "ai_feedback_select_own" ON public.ai_feedback;
  DROP POLICY IF EXISTS "ai_feedback_insert_own" ON public.ai_feedback;
  DROP POLICY IF EXISTS "ai_feedback_update_own" ON public.ai_feedback;
  DROP POLICY IF EXISTS "ai_feedback_delete_own" ON public.ai_feedback;
  DROP POLICY IF EXISTS "org_row_select" ON public.ai_feedback;
  DROP POLICY IF EXISTS "org_row_insert" ON public.ai_feedback;
  DROP POLICY IF EXISTS "org_row_update" ON public.ai_feedback;
  DROP POLICY IF EXISTS "org_row_delete" ON public.ai_feedback;
  DROP POLICY IF EXISTS "ai_action_outcomes_select_own" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "ai_action_outcomes_insert_own" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "ai_action_outcomes_update_own" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "ai_action_outcomes_delete_own" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "org_row_select" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "org_row_insert" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "org_row_update" ON public.ai_action_outcomes;
  DROP POLICY IF EXISTS "org_row_delete" ON public.ai_action_outcomes;
END $drop_legacy$;

-- Per-table CREATE POLICY
CREATE POLICY "org_row_select" ON public.clients FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.clients FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.clients FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.clients FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.transactions FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.transactions FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.transactions FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.transactions FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.projects FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.projects FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.projects FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.projects FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.invoices FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.invoices FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.invoices FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.invoices FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.campaigns FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.campaigns FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.campaigns FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.campaigns FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.timesheet_entries FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.timesheet_entries FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.timesheet_entries FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.timesheet_entries FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.app_settings FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.app_settings FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.app_settings FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.crm_events FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.crm_events FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.crm_events FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.crm_events FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.weekly_summaries FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.weekly_summaries FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.weekly_summaries FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.weekly_summaries FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.pipelines FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.pipelines FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.pipelines FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.pipelines FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.pipeline_stages FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.pipeline_stages FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.pipeline_stages FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.pipeline_stages FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.workspace_tasks FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.workspace_tasks FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.workspace_tasks FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.workspace_tasks FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.crm_activities FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.crm_activities FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.crm_activities FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.crm_activities FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.workflow_rules FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.workflow_rules FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.workflow_rules FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.workflow_rules FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.workflow_runs FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.workflow_runs FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.workflow_runs FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.workflow_runs FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.workflow_outbox FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.workflow_outbox FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.workflow_outbox FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.workflow_outbox FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.ai_usage_events FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.ai_usage_events FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.ai_usage_events FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.ai_usage_events FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.ai_feedback FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.ai_feedback FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.ai_feedback FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.ai_feedback FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

CREATE POLICY "org_row_select" ON public.ai_action_outcomes FOR SELECT TO authenticated USING (public.user_is_org_member(organization_id));
CREATE POLICY "org_row_insert" ON public.ai_action_outcomes FOR INSERT TO authenticated WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_update" ON public.ai_action_outcomes FOR UPDATE TO authenticated USING (public.user_can_write_org(organization_id)) WITH CHECK (public.user_can_write_org(organization_id));
CREATE POLICY "org_row_delete" ON public.ai_action_outcomes FOR DELETE TO authenticated USING (public.user_can_write_org(organization_id));

-- Grants (mirror dashboard_sync pattern)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.timesheet_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_summaries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipelines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_activities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_outbox TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_feedback TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_action_outcomes TO authenticated;
