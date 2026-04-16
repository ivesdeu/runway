-- Dashboard full sync: run in Supabase SQL Editor (top to bottom).
-- CRITICAL: Select from line 1 through the end. If you start at "ALTER TABLE public.transactions",
-- you will get 42P01 because the table was never created.
-- Optional: run `supabase/bootstrap_core.sql` first, then this entire file.

-- =============================================================================
-- 0. Core tables (app requires these; CREATE IF NOT EXISTS is safe to re-run)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  company_name text,
  contact_name text,
  status text,
  industry text,
  email text,
  phone text,
  notes text,
  total_revenue numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  is_retainer boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS clients_user_id_idx ON public.clients (user_id);

CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  "date" date,
  category text,
  amount numeric DEFAULT 0,
  description text,
  source text,
  created_at timestamptz DEFAULT now(),
  client_id uuid,
  project_id uuid,
  other_label text,
  other_type text,
  note text,
  metadata jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON public.transactions (user_id);
CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON public.transactions (user_id, "date" DESC);

-- Row level security for core tables (required for browser clients using the anon key)
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clients_select_own" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_own" ON public.clients;
DROP POLICY IF EXISTS "clients_update_own" ON public.clients;
DROP POLICY IF EXISTS "clients_delete_own" ON public.clients;
CREATE POLICY "clients_select_own" ON public.clients FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "clients_insert_own" ON public.clients FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "clients_update_own" ON public.clients FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "clients_delete_own" ON public.clients FOR DELETE USING (auth.uid() = user_id);

-- If `clients` was created via SQL only, PostgREST may lack table grants; browser + JWT use role `authenticated`.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT ALL ON public.clients TO service_role;

DROP POLICY IF EXISTS "transactions_select_own" ON public.transactions;
DROP POLICY IF EXISTS "transactions_insert_own" ON public.transactions;
DROP POLICY IF EXISTS "transactions_update_own" ON public.transactions;
DROP POLICY IF EXISTS "transactions_delete_own" ON public.transactions;
CREATE POLICY "transactions_select_own" ON public.transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "transactions_insert_own" ON public.transactions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transactions_update_own" ON public.transactions FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transactions_delete_own" ON public.transactions FOR DELETE USING (auth.uid() = user_id);

-- ---- Extend existing rows: extra columns (skipped entirely if `transactions` is missing) ----
DO $ext$
BEGIN
  IF to_regclass('public.transactions') IS NULL THEN
    RAISE EXCEPTION 'public.transactions does not exist. Run from line 1 of this file, or run supabase/bootstrap_core.sql first.';
  END IF;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS client_id uuid;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS project_id uuid;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS other_label text;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS other_type text;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS note text;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
  ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS source text;
END $ext$;

DO $cl$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL THEN
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS industry text;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_retainer boolean DEFAULT false;
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
  END IF;
END $cl$;

-- ---- Projects ----
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id uuid,
  name text,
  status text,
  type text,
  start_date date,
  due_date date,
  value numeric DEFAULT 0,
  description text,
  notes text,
  satisfaction int,
  archived boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  case_study_published boolean DEFAULT false,
  case_study_challenge text,
  case_study_strategy jsonb DEFAULT '[]'::jsonb,
  case_study_results jsonb DEFAULT '[]'::jsonb,
  case_study_category text
);
CREATE INDEX IF NOT EXISTS projects_user_id_idx ON public.projects (user_id);

-- ---- Invoices (links to income transaction id) ----
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  income_tx_id uuid NOT NULL,
  number text,
  date_issued date,
  due_date date,
  amount numeric DEFAULT 0,
  status text DEFAULT 'sent',
  paid_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_user_id_idx ON public.invoices (user_id);
CREATE INDEX IF NOT EXISTS invoices_income_tx_id_idx ON public.invoices (income_tx_id);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_status text;
CREATE INDEX IF NOT EXISTS invoices_stripe_checkout_session_id_idx ON public.invoices (stripe_checkout_session_id);

-- ---- Marketing campaigns ----
CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text,
  channel text,
  start_date date,
  notes text,
  pipeline_value numeric DEFAULT 0,
  status text DEFAULT 'pipeline',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_user_id_idx ON public.campaigns (user_id);

-- ---- Timesheet entries ----
CREATE TABLE IF NOT EXISTS public.timesheet_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  "date" date,
  account text,
  project text,
  task text,
  activity_code text,
  minutes int DEFAULT 0,
  billable boolean DEFAULT true,
  notes text,
  external_note text,
  weekdays jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timesheet_entries_user_id_idx ON public.timesheet_entries (user_id);
CREATE INDEX IF NOT EXISTS timesheet_entries_user_date_idx ON public.timesheet_entries (user_id, "date" DESC);

-- ---- Per-user JSON settings (e.g. custom project status labels) ----
CREATE TABLE IF NOT EXISTS public.app_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  project_statuses jsonb DEFAULT '[]'::jsonb,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS dashboard_settings jsonb DEFAULT '{}'::jsonb;

-- ---- RLS ----
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select_own" ON public.projects;
DROP POLICY IF EXISTS "projects_insert_own" ON public.projects;
DROP POLICY IF EXISTS "projects_update_own" ON public.projects;
DROP POLICY IF EXISTS "projects_delete_own" ON public.projects;
CREATE POLICY "projects_select_own" ON public.projects FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "projects_insert_own" ON public.projects FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "projects_update_own" ON public.projects FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "projects_delete_own" ON public.projects FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "invoices_select_own" ON public.invoices;
DROP POLICY IF EXISTS "invoices_insert_own" ON public.invoices;
DROP POLICY IF EXISTS "invoices_update_own" ON public.invoices;
DROP POLICY IF EXISTS "invoices_delete_own" ON public.invoices;
CREATE POLICY "invoices_select_own" ON public.invoices FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "invoices_insert_own" ON public.invoices FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "invoices_update_own" ON public.invoices FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "invoices_delete_own" ON public.invoices FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "campaigns_select_own" ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_insert_own" ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_update_own" ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_delete_own" ON public.campaigns;
CREATE POLICY "campaigns_select_own" ON public.campaigns FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "campaigns_insert_own" ON public.campaigns FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "campaigns_update_own" ON public.campaigns FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "campaigns_delete_own" ON public.campaigns FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "timesheet_entries_select_own" ON public.timesheet_entries;
DROP POLICY IF EXISTS "timesheet_entries_insert_own" ON public.timesheet_entries;
DROP POLICY IF EXISTS "timesheet_entries_update_own" ON public.timesheet_entries;
DROP POLICY IF EXISTS "timesheet_entries_delete_own" ON public.timesheet_entries;
CREATE POLICY "timesheet_entries_select_own" ON public.timesheet_entries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "timesheet_entries_insert_own" ON public.timesheet_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "timesheet_entries_update_own" ON public.timesheet_entries FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "timesheet_entries_delete_own" ON public.timesheet_entries FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "app_settings_select_own" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_insert_own" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_update_own" ON public.app_settings;
CREATE POLICY "app_settings_select_own" ON public.app_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "app_settings_insert_own" ON public.app_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "app_settings_update_own" ON public.app_settings FOR UPDATE USING (auth.uid() = user_id);

-- Ensure transactions policies allow new columns (usually column-level is not restricted).
-- If `transactions` has no UPDATE for client_id/project_id, add policies as needed for your schema.

-- Case study fields (idempotent if already present — safe for existing `projects` rows)
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_published boolean DEFAULT false;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_challenge text;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_strategy jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_results jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS case_study_category text;
