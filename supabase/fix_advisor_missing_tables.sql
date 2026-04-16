-- Consolidated patch for missing Advisor/CRM telemetry tables.
-- Safe to re-run (CREATE IF NOT EXISTS + DROP POLICY IF EXISTS).
-- Run this whole file in Supabase SQL Editor.

-- ---------------------------------------------------------------------------
-- CRM events + weekly summaries (used by financial-core CRM/Personable widgets)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id uuid NULL REFERENCES public.clients (id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'note',
  title text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_events_user_id_event_at_idx
  ON public.crm_events (user_id, event_at DESC);
CREATE INDEX IF NOT EXISTS crm_events_user_id_kind_idx
  ON public.crm_events (user_id, kind);

CREATE TABLE IF NOT EXISTS public.weekly_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  summary_type text NOT NULL CHECK (summary_type IN ('monday', 'friday')),
  summary_date date NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, summary_type, summary_date)
);

CREATE INDEX IF NOT EXISTS weekly_summaries_user_id_created_at_idx
  ON public.weekly_summaries (user_id, created_at DESC);

ALTER TABLE public.crm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_events_select_own" ON public.crm_events;
DROP POLICY IF EXISTS "crm_events_insert_own" ON public.crm_events;
DROP POLICY IF EXISTS "crm_events_update_own" ON public.crm_events;
DROP POLICY IF EXISTS "crm_events_delete_own" ON public.crm_events;
CREATE POLICY "crm_events_select_own" ON public.crm_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "crm_events_insert_own" ON public.crm_events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "crm_events_update_own" ON public.crm_events FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "crm_events_delete_own" ON public.crm_events FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "weekly_summaries_select_own" ON public.weekly_summaries;
DROP POLICY IF EXISTS "weekly_summaries_insert_own" ON public.weekly_summaries;
DROP POLICY IF EXISTS "weekly_summaries_update_own" ON public.weekly_summaries;
DROP POLICY IF EXISTS "weekly_summaries_delete_own" ON public.weekly_summaries;
CREATE POLICY "weekly_summaries_select_own" ON public.weekly_summaries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "weekly_summaries_insert_own" ON public.weekly_summaries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "weekly_summaries_update_own" ON public.weekly_summaries FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "weekly_summaries_delete_own" ON public.weekly_summaries FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_summaries TO authenticated;
GRANT ALL ON public.crm_events TO service_role;
GRANT ALL ON public.weekly_summaries TO service_role;

-- ---------------------------------------------------------------------------
-- Advisor telemetry tables (used by dashboard-assistant logging hooks)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  task text NOT NULL DEFAULT 'general',
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ok',
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_event_id uuid REFERENCES public.ai_usage_events (id) ON DELETE SET NULL,
  task text,
  sentiment text NOT NULL CHECK (sentiment IN ('up', 'down')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_action_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_event_id uuid REFERENCES public.ai_usage_events (id) ON DELETE SET NULL,
  task text,
  action_id text,
  action_label text,
  outcome text NOT NULL DEFAULT 'applied',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_events_user_created_idx
  ON public.ai_usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_feedback_user_created_idx
  ON public.ai_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_action_outcomes_user_created_idx
  ON public.ai_action_outcomes (user_id, created_at DESC);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_action_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_usage_events_select_own" ON public.ai_usage_events;
DROP POLICY IF EXISTS "ai_usage_events_insert_own" ON public.ai_usage_events;
DROP POLICY IF EXISTS "ai_usage_events_update_own" ON public.ai_usage_events;
DROP POLICY IF EXISTS "ai_usage_events_delete_own" ON public.ai_usage_events;
CREATE POLICY "ai_usage_events_select_own" ON public.ai_usage_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ai_usage_events_insert_own" ON public.ai_usage_events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_usage_events_update_own" ON public.ai_usage_events FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_usage_events_delete_own" ON public.ai_usage_events FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_feedback_select_own" ON public.ai_feedback;
DROP POLICY IF EXISTS "ai_feedback_insert_own" ON public.ai_feedback;
DROP POLICY IF EXISTS "ai_feedback_update_own" ON public.ai_feedback;
DROP POLICY IF EXISTS "ai_feedback_delete_own" ON public.ai_feedback;
CREATE POLICY "ai_feedback_select_own" ON public.ai_feedback FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ai_feedback_insert_own" ON public.ai_feedback FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_feedback_update_own" ON public.ai_feedback FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_feedback_delete_own" ON public.ai_feedback FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_action_outcomes_select_own" ON public.ai_action_outcomes;
DROP POLICY IF EXISTS "ai_action_outcomes_insert_own" ON public.ai_action_outcomes;
DROP POLICY IF EXISTS "ai_action_outcomes_update_own" ON public.ai_action_outcomes;
DROP POLICY IF EXISTS "ai_action_outcomes_delete_own" ON public.ai_action_outcomes;
CREATE POLICY "ai_action_outcomes_select_own" ON public.ai_action_outcomes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ai_action_outcomes_insert_own" ON public.ai_action_outcomes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_action_outcomes_update_own" ON public.ai_action_outcomes FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_action_outcomes_delete_own" ON public.ai_action_outcomes FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_feedback TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_action_outcomes TO authenticated;
GRANT ALL ON public.ai_usage_events TO service_role;
GRANT ALL ON public.ai_feedback TO service_role;
GRANT ALL ON public.ai_action_outcomes TO service_role;
