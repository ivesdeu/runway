-- Track first-login security requirements (e.g. must change password).

CREATE TABLE IF NOT EXISTS public.user_security (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_security ENABLE ROW LEVEL SECURITY;

-- Users can read their own flag; only service role can write.
DROP POLICY IF EXISTS user_security_select_own ON public.user_security;
CREATE POLICY user_security_select_own ON public.user_security
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_security_write_none ON public.user_security;
CREATE POLICY user_security_write_none ON public.user_security
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.clear_must_change_password()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Not authenticated');
  END IF;
  UPDATE public.user_security
  SET must_change_password = false
  WHERE user_id = uid;
  RETURN json_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.clear_must_change_password() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_must_change_password() TO authenticated, service_role;

