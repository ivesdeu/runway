-- Team management: UPDATE/DELETE on organization_members, owner safeguards, invitations table.
-- Run after supabase/organizations_multitenancy.sql

-- =============================================================================
-- 1. Grants (RLS still governs row access)
-- =============================================================================
GRANT UPDATE, DELETE ON public.organization_members TO authenticated;

-- =============================================================================
-- 2. RLS: UPDATE / DELETE (admins and owners of the org)
-- =============================================================================
DROP POLICY IF EXISTS "organization_members_update_admin" ON public.organization_members;
CREATE POLICY "organization_members_update_admin" ON public.organization_members
  FOR UPDATE TO authenticated
  USING (public.user_can_admin_org(organization_id))
  WITH CHECK (public.user_can_admin_org(organization_id));

DROP POLICY IF EXISTS "organization_members_delete_admin" ON public.organization_members;
CREATE POLICY "organization_members_delete_admin" ON public.organization_members
  FOR DELETE TO authenticated
  USING (public.user_can_admin_org(organization_id));

-- =============================================================================
-- 3. Triggers: last owner, owner promotion, owner inserts
-- =============================================================================
CREATE OR REPLACE FUNCTION public.organization_members_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_is_owner boolean;
  other_owners int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
      AND m.user_id = auth.uid()
      AND m.role = 'owner'
  ) INTO actor_is_owner;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' AND NOT COALESCE(actor_is_owner, false) THEN
      RAISE EXCEPTION 'Only a workspace owner can add a member with role owner';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' THEN
      SELECT COUNT(*) INTO other_owners
      FROM public.organization_members
      WHERE organization_id = OLD.organization_id
        AND role = 'owner'
        AND user_id <> OLD.user_id;
      IF COALESCE(other_owners, 0) < 1 THEN
        RAISE EXCEPTION 'Cannot remove the last owner of this workspace';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'owner' AND NEW.role IS DISTINCT FROM 'owner' THEN
      SELECT COUNT(*) INTO other_owners
      FROM public.organization_members
      WHERE organization_id = NEW.organization_id
        AND role = 'owner'
        AND user_id <> OLD.user_id;
      IF COALESCE(other_owners, 0) < 1 THEN
        RAISE EXCEPTION 'Cannot demote the only owner; assign another owner first';
      END IF;
    END IF;
    IF NEW.role = 'owner' AND OLD.role IS DISTINCT FROM 'owner' THEN
      IF NOT COALESCE(actor_is_owner, false) THEN
        RAISE EXCEPTION 'Only a workspace owner can promote someone to owner';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS organization_members_owner_guard ON public.organization_members;
CREATE TRIGGER organization_members_owner_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.organization_members
  FOR EACH ROW
  EXECUTE PROCEDURE public.organization_members_owner_guard();

-- =============================================================================
-- 4. Pending invitations (accepted via Edge + service role)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_invitations_email_trim CHECK (email = lower(trim(email)))
);

CREATE INDEX IF NOT EXISTS organization_invitations_org_idx
  ON public.organization_invitations (organization_id);

CREATE INDEX IF NOT EXISTS organization_invitations_token_idx
  ON public.organization_invitations (token)
  WHERE accepted_at IS NULL;

DROP INDEX IF EXISTS organization_invitations_one_pending_per_email;
CREATE UNIQUE INDEX organization_invitations_one_pending_per_email
  ON public.organization_invitations (organization_id, email)
  WHERE accepted_at IS NULL;

ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_invitations_select_admin" ON public.organization_invitations;
CREATE POLICY "org_invitations_select_admin" ON public.organization_invitations
  FOR SELECT TO authenticated
  USING (public.user_can_admin_org(organization_id));

DROP POLICY IF EXISTS "org_invitations_insert_admin" ON public.organization_invitations;
CREATE POLICY "org_invitations_insert_admin" ON public.organization_invitations
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_admin_org(organization_id));

DROP POLICY IF EXISTS "org_invitations_delete_admin" ON public.organization_invitations;
CREATE POLICY "org_invitations_delete_admin" ON public.organization_invitations
  FOR DELETE TO authenticated
  USING (public.user_can_admin_org(organization_id));

GRANT SELECT, INSERT, DELETE ON public.organization_invitations TO authenticated;
