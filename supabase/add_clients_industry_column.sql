-- Run once in Supabase SQL Editor if clients fail to save with:
-- "Could not find the 'industry' column of 'clients' in the schema cache"
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS industry text;
