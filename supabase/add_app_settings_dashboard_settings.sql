-- Run in Supabase SQL Editor once. Stores Settings page business profile, budgets, and budget history JSON.
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS dashboard_settings jsonb DEFAULT '{}'::jsonb;
