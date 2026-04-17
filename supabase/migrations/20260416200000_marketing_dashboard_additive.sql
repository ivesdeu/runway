-- ADDITIVE ONLY. DO NOT RUN ON FINANCE DASHBOARD.
-- Marketing dashboard: ga4_cache + lead/campaign columns. Safe to apply on shared Supabase; no DROP/TRUNCATE.

-- ---------------------------------------------------------------------------
-- GA4 response cache (1h TTL enforced in Edge Function)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ga4_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ga4_cache_org_key UNIQUE (organization_id, cache_key)
);

CREATE INDEX IF NOT EXISTS ga4_cache_org_fetched_idx ON public.ga4_cache (organization_id, fetched_at DESC);

ALTER TABLE public.ga4_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ga4_cache_org_select" ON public.ga4_cache
  FOR SELECT TO authenticated
  USING (public.user_is_org_member(organization_id));

CREATE POLICY "ga4_cache_org_insert" ON public.ga4_cache
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "ga4_cache_org_update" ON public.ga4_cache
  FOR UPDATE TO authenticated
  USING (public.user_can_write_org(organization_id))
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "ga4_cache_org_delete" ON public.ga4_cache
  FOR DELETE TO authenticated
  USING (public.user_can_write_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ga4_cache TO authenticated;
GRANT ALL ON public.ga4_cache TO service_role;

-- ---------------------------------------------------------------------------
-- Leads (clients): UTM + Salesforce export status
-- ---------------------------------------------------------------------------
DO $leadcols$
BEGIN
  IF to_regclass('public.clients') IS NULL THEN
    RAISE NOTICE 'public.clients missing; skip lead columns.';
  ELSE
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS lead_source text;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS utm_source text;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS utm_medium text;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS utm_campaign text;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS salesforce_status text DEFAULT 'not_exported';
    BEGIN
      ALTER TABLE public.clients ADD CONSTRAINT clients_salesforce_status_check
        CHECK (salesforce_status IS NULL OR salesforce_status IN ('not_exported', 'exported', 'synced'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $leadcols$;

-- ---------------------------------------------------------------------------
-- Campaigns (projects): channel, budget, leads_generated
-- ---------------------------------------------------------------------------
DO $projcols$
BEGIN
  IF to_regclass('public.projects') IS NULL THEN
    RAISE NOTICE 'public.projects missing; skip campaign columns.';
  ELSE
    ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS channel text;
    ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS budget numeric DEFAULT 0;
    ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS leads_generated integer DEFAULT 0;
  END IF;
END $projcols$;
