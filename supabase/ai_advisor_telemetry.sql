-- Advisor telemetry scaffolding (safe to re-run)

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  task text NOT NULL,
  request_payload jsonb DEFAULT '{}'::jsonb,
  response_payload jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ok',
  latency_ms integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_feedback (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_event_id uuid REFERENCES public.ai_usage_events (id) ON DELETE SET NULL,
  task text,
  sentiment text NOT NULL CHECK (sentiment IN ('up', 'down')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_action_outcomes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_event_id uuid REFERENCES public.ai_usage_events (id) ON DELETE SET NULL,
  task text,
  action_id text NOT NULL,
  action_label text,
  outcome text NOT NULL DEFAULT 'applied',
  details jsonb DEFAULT '{}'::jsonb,
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
CREATE POLICY "ai_usage_events_update_own" ON public.ai_usage_events FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ai_usage_events_delete_own" ON public.ai_usage_events FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_feedback_select_own" ON public.ai_feedback;
DROP POLICY IF EXISTS "ai_feedback_insert_own" ON public.ai_feedback;
DROP POLICY IF EXISTS "ai_feedback_update_own" ON public.ai_feedback;
DROP POLICY IF EXISTS "ai_feedback_delete_own" ON public.ai_feedback;
CREATE POLICY "ai_feedback_select_own" ON public.ai_feedback FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ai_feedback_insert_own" ON public.ai_feedback FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_feedback_update_own" ON public.ai_feedback FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ai_feedback_delete_own" ON public.ai_feedback FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ai_action_outcomes_select_own" ON public.ai_action_outcomes;
DROP POLICY IF EXISTS "ai_action_outcomes_insert_own" ON public.ai_action_outcomes;
DROP POLICY IF EXISTS "ai_action_outcomes_update_own" ON public.ai_action_outcomes;
DROP POLICY IF EXISTS "ai_action_outcomes_delete_own" ON public.ai_action_outcomes;
CREATE POLICY "ai_action_outcomes_select_own" ON public.ai_action_outcomes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ai_action_outcomes_insert_own" ON public.ai_action_outcomes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_action_outcomes_update_own" ON public.ai_action_outcomes FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ai_action_outcomes_delete_own" ON public.ai_action_outcomes FOR DELETE USING (auth.uid() = user_id);
