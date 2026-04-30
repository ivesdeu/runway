-- Per-user UI state (theme, column visibility, income table prefs) — not workspace-shared.

CREATE TABLE IF NOT EXISTS public.user_ui_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_ui_preferences_updated_at_idx ON public.user_ui_preferences (updated_at DESC);
ALTER TABLE public.user_ui_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_ui_preferences_select_own" ON public.user_ui_preferences;
DROP POLICY IF EXISTS "user_ui_preferences_insert_own" ON public.user_ui_preferences;
DROP POLICY IF EXISTS "user_ui_preferences_update_own" ON public.user_ui_preferences;
CREATE POLICY "user_ui_preferences_select_own" ON public.user_ui_preferences
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "user_ui_preferences_insert_own" ON public.user_ui_preferences
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_ui_preferences_update_own" ON public.user_ui_preferences
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE ON public.user_ui_preferences TO authenticated;
