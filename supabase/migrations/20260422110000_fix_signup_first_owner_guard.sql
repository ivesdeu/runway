-- Signup failed with "Database error saving new user": handle_new_user_org inserts
-- the first organization_members row as owner while auth.uid() is null (auth trigger context).
-- organization_members_owner_guard treated that as a non-owner adding an owner and raised.

CREATE OR REPLACE FUNCTION public.organization_members_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_is_owner boolean;
  other_owners int;
  org_has_members boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
      AND m.user_id = auth.uid()
      AND m.role = 'owner'
  ) INTO actor_is_owner;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' AND NOT COALESCE(actor_is_owner, false) THEN
      SELECT EXISTS (
        SELECT 1 FROM public.organization_members m
        WHERE m.organization_id = NEW.organization_id
      ) INTO org_has_members;
      IF org_has_members THEN
        RAISE EXCEPTION 'Only a workspace owner can add a member with role owner';
      END IF;
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
