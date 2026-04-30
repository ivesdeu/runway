-- Disable automatic org creation on auth.users inserts.
-- New users must be provisioned by developers/admin flows and attached to an org explicitly.

DROP TRIGGER IF EXISTS on_auth_user_created_org ON auth.users;

