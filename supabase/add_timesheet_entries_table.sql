-- Run once in Supabase SQL Editor to enable cloud sync for Timesheet tab.
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

ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "timesheet_entries_select_own" ON public.timesheet_entries;
DROP POLICY IF EXISTS "timesheet_entries_insert_own" ON public.timesheet_entries;
DROP POLICY IF EXISTS "timesheet_entries_update_own" ON public.timesheet_entries;
DROP POLICY IF EXISTS "timesheet_entries_delete_own" ON public.timesheet_entries;
CREATE POLICY "timesheet_entries_select_own" ON public.timesheet_entries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "timesheet_entries_insert_own" ON public.timesheet_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "timesheet_entries_update_own" ON public.timesheet_entries FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "timesheet_entries_delete_own" ON public.timesheet_entries FOR DELETE USING (auth.uid() = user_id);
