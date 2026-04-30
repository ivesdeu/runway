-- Add organizations.admin_email (canonical admin email for the workspace)
-- Idempotent: safe to run multiple times.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS admin_email text;

DO $org_admin_email$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_admin_email_trim'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_admin_email_trim
      CHECK (admin_email IS NULL OR admin_email = lower(trim(admin_email)));
  END IF;
END $org_admin_email$;

-- Backfill admin_email from the earliest owner; fall back to earliest admin/member if needed.
WITH ranked AS (
  SELECT
    m.organization_id,
    lower(trim(u.email)) AS email,
    row_number() OVER (
      PARTITION BY m.organization_id
      ORDER BY
        CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        m.created_at ASC
    ) AS rn
  FROM public.organization_members m
  JOIN auth.users u ON u.id = m.user_id
  WHERE u.email IS NOT NULL
)
UPDATE public.organizations o
SET admin_email = r.email
FROM ranked r
WHERE r.organization_id = o.id
  AND r.rn = 1
  AND (o.admin_email IS NULL OR trim(o.admin_email) = '');

