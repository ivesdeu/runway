-- Workflow automation: pipelines, stages, tasks, rules, runs, activities.
-- Run in Supabase SQL Editor after bootstrap_core / personable_crm_enhancements.
-- Safe to re-run (IF NOT EXISTS / IF EXISTS guards).

-- ---------------------------------------------------------------------------
-- Client columns for pipeline binding
-- ---------------------------------------------------------------------------
DO $clwf$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL THEN
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS pipeline_id uuid;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS pipeline_stage_id uuid;
  END IF;
END $clwf$;

-- ---------------------------------------------------------------------------
-- Pipelines & stages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  entity text NOT NULL CHECK (entity IN ('client', 'campaign')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipelines_user_id_idx ON public.pipelines (user_id);
CREATE INDEX IF NOT EXISTS pipelines_user_entity_idx ON public.pipelines (user_id, entity);

CREATE TABLE IF NOT EXISTS public.pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  label text NOT NULL,
  slug text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, slug)
);
CREATE INDEX IF NOT EXISTS pipeline_stages_pipeline_id_idx ON public.pipeline_stages (pipeline_id);
CREATE INDEX IF NOT EXISTS pipeline_stages_user_id_idx ON public.pipeline_stages (user_id);

-- Optional FK from clients (added only if columns exist)
DO $fkps$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL AND to_regclass('public.pipelines') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'clients_pipeline_id_fkey'
    ) THEN
      ALTER TABLE public.clients
        ADD CONSTRAINT clients_pipeline_id_fkey
        FOREIGN KEY (pipeline_id) REFERENCES public.pipelines (id) ON DELETE SET NULL;
    END IF;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $fkps$;

DO $fks$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL AND to_regclass('public.pipeline_stages') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'clients_pipeline_stage_id_fkey'
    ) THEN
      ALTER TABLE public.clients
        ADD CONSTRAINT clients_pipeline_stage_id_fkey
        FOREIGN KEY (pipeline_stage_id) REFERENCES public.pipeline_stages (id) ON DELETE SET NULL;
    END IF;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $fks$;

-- ---------------------------------------------------------------------------
-- Workspace tasks (assignable work; MVP: owner-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL,
  body text DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'snoozed')),
  due_at timestamptz,
  client_id uuid REFERENCES public.clients (id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns (id) ON DELETE SET NULL,
  created_by text NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'workflow')),
  workflow_run_id uuid,
  assigned_to_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_tasks_user_status_idx ON public.workspace_tasks (user_id, status);
CREATE INDEX IF NOT EXISTS workspace_tasks_user_due_idx ON public.workspace_tasks (user_id, due_at);

-- ---------------------------------------------------------------------------
-- CRM activities (meeting / call triggers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN ('meeting', 'call', 'email', 'other')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_activities_user_client_idx ON public.crm_activities (user_id, client_id);
CREATE INDEX IF NOT EXISTS crm_activities_user_occurred_idx ON public.crm_activities (user_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Workflow rules & idempotent runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workflow_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  pipeline_id uuid REFERENCES public.pipelines (id) ON DELETE SET NULL,
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_rules_user_enabled_idx ON public.workflow_rules (user_id, enabled);

CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  rule_id uuid REFERENCES public.workflow_rules (id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'success',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS workflow_runs_user_created_idx ON public.workflow_runs (user_id, created_at DESC);

-- Future: async worker / email / Slack (optional phase)
CREATE TABLE IF NOT EXISTS public.workflow_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'stub',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS workflow_outbox_user_unprocessed_idx ON public.workflow_outbox (user_id) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pipelines_select_own" ON public.pipelines;
DROP POLICY IF EXISTS "pipelines_insert_own" ON public.pipelines;
DROP POLICY IF EXISTS "pipelines_update_own" ON public.pipelines;
DROP POLICY IF EXISTS "pipelines_delete_own" ON public.pipelines;
CREATE POLICY "pipelines_select_own" ON public.pipelines FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "pipelines_insert_own" ON public.pipelines FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "pipelines_update_own" ON public.pipelines FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "pipelines_delete_own" ON public.pipelines FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "pipeline_stages_select_own" ON public.pipeline_stages;
DROP POLICY IF EXISTS "pipeline_stages_insert_own" ON public.pipeline_stages;
DROP POLICY IF EXISTS "pipeline_stages_update_own" ON public.pipeline_stages;
DROP POLICY IF EXISTS "pipeline_stages_delete_own" ON public.pipeline_stages;
CREATE POLICY "pipeline_stages_select_own" ON public.pipeline_stages FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "pipeline_stages_insert_own" ON public.pipeline_stages FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "pipeline_stages_update_own" ON public.pipeline_stages FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "pipeline_stages_delete_own" ON public.pipeline_stages FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workspace_tasks_select_own" ON public.workspace_tasks;
DROP POLICY IF EXISTS "workspace_tasks_insert_own" ON public.workspace_tasks;
DROP POLICY IF EXISTS "workspace_tasks_update_own" ON public.workspace_tasks;
DROP POLICY IF EXISTS "workspace_tasks_delete_own" ON public.workspace_tasks;
CREATE POLICY "workspace_tasks_select_own" ON public.workspace_tasks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "workspace_tasks_insert_own" ON public.workspace_tasks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workspace_tasks_update_own" ON public.workspace_tasks FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workspace_tasks_delete_own" ON public.workspace_tasks FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "crm_activities_select_own" ON public.crm_activities;
DROP POLICY IF EXISTS "crm_activities_insert_own" ON public.crm_activities;
DROP POLICY IF EXISTS "crm_activities_update_own" ON public.crm_activities;
DROP POLICY IF EXISTS "crm_activities_delete_own" ON public.crm_activities;
CREATE POLICY "crm_activities_select_own" ON public.crm_activities FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "crm_activities_insert_own" ON public.crm_activities FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "crm_activities_update_own" ON public.crm_activities FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "crm_activities_delete_own" ON public.crm_activities FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workflow_rules_select_own" ON public.workflow_rules;
DROP POLICY IF EXISTS "workflow_rules_insert_own" ON public.workflow_rules;
DROP POLICY IF EXISTS "workflow_rules_update_own" ON public.workflow_rules;
DROP POLICY IF EXISTS "workflow_rules_delete_own" ON public.workflow_rules;
CREATE POLICY "workflow_rules_select_own" ON public.workflow_rules FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "workflow_rules_insert_own" ON public.workflow_rules FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workflow_rules_update_own" ON public.workflow_rules FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workflow_rules_delete_own" ON public.workflow_rules FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workflow_runs_select_own" ON public.workflow_runs;
DROP POLICY IF EXISTS "workflow_runs_insert_own" ON public.workflow_runs;
DROP POLICY IF EXISTS "workflow_runs_update_own" ON public.workflow_runs;
DROP POLICY IF EXISTS "workflow_runs_delete_own" ON public.workflow_runs;
CREATE POLICY "workflow_runs_select_own" ON public.workflow_runs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "workflow_runs_insert_own" ON public.workflow_runs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workflow_runs_update_own" ON public.workflow_runs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workflow_runs_delete_own" ON public.workflow_runs FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workflow_outbox_select_own" ON public.workflow_outbox;
DROP POLICY IF EXISTS "workflow_outbox_insert_own" ON public.workflow_outbox;
DROP POLICY IF EXISTS "workflow_outbox_update_own" ON public.workflow_outbox;
CREATE POLICY "workflow_outbox_select_own" ON public.workflow_outbox FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "workflow_outbox_insert_own" ON public.workflow_outbox FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workflow_outbox_update_own" ON public.workflow_outbox FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipelines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_activities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_outbox TO authenticated;

GRANT ALL ON public.pipelines TO service_role;
GRANT ALL ON public.pipeline_stages TO service_role;
GRANT ALL ON public.workspace_tasks TO service_role;
GRANT ALL ON public.crm_activities TO service_role;
GRANT ALL ON public.workflow_rules TO service_role;
GRANT ALL ON public.workflow_runs TO service_role;
GRANT ALL ON public.workflow_outbox TO service_role;

-- FK workflow_runs.rule_id (optional, after workflow_rules exists)
DO $wfr$
BEGIN
  IF to_regclass('public.workflow_runs') IS NOT NULL AND to_regclass('public.workflow_rules') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_rule_id_fkey') THEN
      ALTER TABLE public.workflow_runs
        ADD CONSTRAINT workflow_runs_rule_id_fkey
        FOREIGN KEY (rule_id) REFERENCES public.workflow_rules (id) ON DELETE SET NULL;
    END IF;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $wfr$;

DO $wft$
BEGIN
  IF to_regclass('public.workspace_tasks') IS NOT NULL AND to_regclass('public.workflow_runs') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_tasks_workflow_run_id_fkey') THEN
      ALTER TABLE public.workspace_tasks
        ADD CONSTRAINT workspace_tasks_workflow_run_id_fkey
        FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs (id) ON DELETE SET NULL;
    END IF;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $wft$;
