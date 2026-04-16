-- Optional JSON on each client (e.g. Customers tab revenue/cost overrides). Run once in Supabase SQL Editor.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
