-- Owner-only workspace deletion. Deletes the organization row; FK ON DELETE CASCADE removes members and org-scoped data.
-- Run once in the Supabase SQL editor after organizations_multitenancy.sql.

CREATE OR REPLACE FUNCTION public.delete_workspace_as_owner(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = p_org_id
      AND m.user_id = auth.uid()
      AND m.role = 'owner'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  DELETE FROM public.organizations WHERE id = p_org_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_workspace_as_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_workspace_as_owner(uuid) TO authenticated;
