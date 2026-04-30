-- ADDITIVE ONLY. Form / GA4 attribution leads (separate from shared public.clients).
-- Safe on shared Supabase: no DROP/TRUNCATE.

CREATE TABLE IF NOT EXISTS public.attribution_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  contact_name text,
  company_name text,
  email text,
  phone text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  ga_client_id text,
  ga_session_id text,
  user_pseudo_id text,
  gclid text,
  search_keyword text,
  first_touch jsonb NOT NULL DEFAULT '{}'::jsonb,
  marketing_client_id text,
  purchased boolean NOT NULL DEFAULT false,
  purchase_amount numeric NOT NULL DEFAULT 0,
  is_retainer boolean NOT NULL DEFAULT false,
  lifetime_value numeric NOT NULL DEFAULT 0,
  linked_client_id uuid REFERENCES public.clients (id) ON DELETE SET NULL,
  matched_at timestamptz,
  import_source text NOT NULL DEFAULT 'form',
  raw_import jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT attribution_leads_import_source_check CHECK (
    import_source IN ('form', 'csv', 'crm_import', 'dashboard')
  )
);

CREATE INDEX IF NOT EXISTS attribution_leads_org_created_idx
  ON public.attribution_leads (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS attribution_leads_org_email_idx
  ON public.attribution_leads (organization_id, lower(email));

CREATE INDEX IF NOT EXISTS attribution_leads_org_campaign_idx
  ON public.attribution_leads (organization_id, utm_campaign);

CREATE INDEX IF NOT EXISTS attribution_leads_org_marketing_id_idx
  ON public.attribution_leads (organization_id, marketing_client_id)
  WHERE marketing_client_id IS NOT NULL AND trim(marketing_client_id) <> '';

ALTER TABLE public.attribution_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attribution_leads_org_select" ON public.attribution_leads
  FOR SELECT TO authenticated
  USING (public.user_is_org_member(organization_id));

CREATE POLICY "attribution_leads_org_insert" ON public.attribution_leads
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "attribution_leads_org_update" ON public.attribution_leads
  FOR UPDATE TO authenticated
  USING (public.user_can_write_org(organization_id))
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "attribution_leads_org_delete" ON public.attribution_leads
  FOR DELETE TO authenticated
  USING (public.user_can_write_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attribution_leads TO authenticated;
GRANT ALL ON public.attribution_leads TO service_role;
