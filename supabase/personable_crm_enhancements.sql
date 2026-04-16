-- Personable CRM enhancements (safe to re-run)
-- Adds relationship metadata, timeline events, weekly summaries, and logo storage.

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS birthday date;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS communication_style text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS preferred_channel text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS last_touch_at date;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS next_follow_up_at date;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS relationship_notes text;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS dashboard_settings jsonb DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.crm_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id uuid NULL REFERENCES public.clients (id) ON DELETE SET NULL,
  kind text NOT NULL,
  title text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  event_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_events_user_id_event_at_idx
  ON public.crm_events (user_id, event_at DESC);
CREATE INDEX IF NOT EXISTS crm_events_user_id_kind_idx
  ON public.crm_events (user_id, kind);

CREATE TABLE IF NOT EXISTS public.weekly_summaries (
  id uuid PRIMARY KEY,
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
CREATE POLICY "crm_events_update_own" ON public.crm_events FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "crm_events_delete_own" ON public.crm_events FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "weekly_summaries_select_own" ON public.weekly_summaries;
DROP POLICY IF EXISTS "weekly_summaries_insert_own" ON public.weekly_summaries;
DROP POLICY IF EXISTS "weekly_summaries_update_own" ON public.weekly_summaries;
DROP POLICY IF EXISTS "weekly_summaries_delete_own" ON public.weekly_summaries;
CREATE POLICY "weekly_summaries_select_own" ON public.weekly_summaries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "weekly_summaries_insert_own" ON public.weekly_summaries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "weekly_summaries_update_own" ON public.weekly_summaries FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "weekly_summaries_delete_own" ON public.weekly_summaries FOR DELETE USING (auth.uid() = user_id);

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('brand-assets', 'brand-assets', true)
  ON CONFLICT (id) DO NOTHING;
EXCEPTION WHEN undefined_table THEN
  -- Storage extension not initialized on some projects.
  NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "brand_assets_select_public" ON storage.objects
    FOR SELECT TO public
    USING (bucket_id = 'brand-assets');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "brand_assets_insert_own" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'brand-assets' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "brand_assets_update_own" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'brand-assets' AND auth.uid()::text = (storage.foldername(name))[1])
    WITH CHECK (bucket_id = 'brand-assets' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "brand_assets_delete_own" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'brand-assets' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Strict isolation prep: quarantine any legacy rows that never had an owner.
-- Run this before applying strict RLS policies that require auth.uid() = user_id.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clients WHERE user_id IS NULL) THEN
    RAISE NOTICE 'Found % clients rows with NULL user_id. These rows must be reassigned or archived before strict RLS.', (SELECT count(*) FROM public.clients WHERE user_id IS NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE user_id IS NULL) THEN
    RAISE NOTICE 'Found % transactions rows with NULL user_id. These rows must be reassigned or archived before strict RLS.', (SELECT count(*) FROM public.transactions WHERE user_id IS NULL);
  END IF;
END $$;

-- Optional archive tables to preserve legacy rows that cannot be confidently reassigned.
CREATE TABLE IF NOT EXISTS public.clients_legacy_unowned AS
SELECT * FROM public.clients WHERE false;
CREATE TABLE IF NOT EXISTS public.transactions_legacy_unowned AS
SELECT * FROM public.transactions WHERE false;

INSERT INTO public.clients_legacy_unowned
SELECT * FROM public.clients c
WHERE c.user_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.clients_legacy_unowned a WHERE a.id = c.id);

INSERT INTO public.transactions_legacy_unowned
SELECT * FROM public.transactions t
WHERE t.user_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.transactions_legacy_unowned a WHERE a.id = t.id);

-- Remove unowned rows from live tables so strict per-user policies do not expose them.
DELETE FROM public.transactions WHERE user_id IS NULL;
DELETE FROM public.clients WHERE user_id IS NULL;
