-- Developer allowlist (email-based) used to gate internal admin actions.

CREATE TABLE IF NOT EXISTS public.developer_accounts (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_accounts_email_trim CHECK (email = lower(trim(email)))
);

-- Seed: single developer account.
INSERT INTO public.developer_accounts (email)
VALUES ('contact@ivesdeu.com')
ON CONFLICT (email) DO NOTHING;

ALTER TABLE public.developer_accounts ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write allowlist via SQL; expose via SECURITY DEFINER helper instead.
DROP POLICY IF EXISTS developer_accounts_deny_all ON public.developer_accounts;
CREATE POLICY developer_accounts_deny_all ON public.developer_accounts
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.is_developer()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  em text;
BEGIN
  IF uid IS NULL THEN
    RETURN false;
  END IF;
  SELECT lower(trim(u.email)) INTO em
  FROM auth.users u
  WHERE u.id = uid;
  IF em IS NULL OR em = '' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.developer_accounts d WHERE d.email = em);
END;
$$;

REVOKE ALL ON FUNCTION public.is_developer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_developer() TO authenticated, service_role;

