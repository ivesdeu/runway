-- Add GA4 join key to CRM clients (nullable for manual/offline records).
-- Safe/additive migration.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS ga_client_id text;

CREATE INDEX IF NOT EXISTS clients_ga_client_id_idx
  ON public.clients (ga_client_id)
  WHERE ga_client_id IS NOT NULL AND trim(ga_client_id) <> '';
