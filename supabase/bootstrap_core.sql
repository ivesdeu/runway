-- MINIMAL BOOTSTRAP — run this whole file first if anything else errors on `transactions`.
-- Then run `dashboard_sync.sql` from line 1 (entire file). Do not run dashboard_sync starting at ALTER.

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

-- Column is quoted as "date" (safe with type date); PostgREST still exposes it as `date`.
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

CREATE TABLE IF NOT EXISTS public.timesheet_entries (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE,
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

-- Sanity check (should print a non-null regclass):
SELECT to_regclass('public.clients') AS clients_regclass, to_regclass('public.transactions') AS transactions_regclass, to_regclass('public.timesheet_entries') AS timesheet_entries_regclass;
