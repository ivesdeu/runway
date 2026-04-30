-- Cross-organization referential integrity (defense in depth).
-- Prerequisites:
--   1. supabase/organizations_multitenancy.sql (organization_id NOT NULL on tenant tables)
--   2. supabase/workflow_automation.sql if you use pipelines (clients.pipeline_id / pipeline_stage_id)
-- Prevents linking rows to clients/campaigns/projects/pipelines from another workspace.

-- -----------------------------------------------------------------------------
-- workspace_tasks: client_id and campaign_id must belong to NEW.organization_id
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_workspace_tasks_org_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'workspace_tasks.organization_id is required';
  END IF;
  IF NEW.client_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'workspace_tasks.client_id does not belong to this organization';
    END IF;
  END IF;
  IF NEW.campaign_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.campaigns ca
      WHERE ca.id = NEW.campaign_id AND ca.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'workspace_tasks.campaign_id does not belong to this organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workspace_tasks_org_refs ON public.workspace_tasks;
CREATE TRIGGER workspace_tasks_org_refs
  BEFORE INSERT OR UPDATE OF client_id, campaign_id, organization_id ON public.workspace_tasks
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_workspace_tasks_org_refs();
-- -----------------------------------------------------------------------------
-- crm_activities: client_id must match organization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_crm_activities_client_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'crm_activities.organization_id is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'crm_activities.client_id must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_activities_client_org ON public.crm_activities;
CREATE TRIGGER crm_activities_client_org
  BEFORE INSERT OR UPDATE OF client_id, organization_id ON public.crm_activities
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_crm_activities_client_org();
-- -----------------------------------------------------------------------------
-- transactions: optional client_id / project_id must match organization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_transactions_org_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'transactions.organization_id is required';
  END IF;
  IF NEW.client_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'transactions.client_id does not belong to this organization';
    END IF;
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = NEW.project_id AND p.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'transactions.project_id does not belong to this organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS transactions_org_refs ON public.transactions;
CREATE TRIGGER transactions_org_refs
  BEFORE INSERT OR UPDATE OF client_id, project_id, organization_id ON public.transactions
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_transactions_org_refs();
-- -----------------------------------------------------------------------------
-- projects: optional client_id must match organization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_projects_client_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'projects.organization_id is required';
  END IF;
  IF NEW.client_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'projects.client_id does not belong to this organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS projects_client_org ON public.projects;
CREATE TRIGGER projects_client_org
  BEFORE INSERT OR UPDATE OF client_id, organization_id ON public.projects
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_projects_client_org();
-- -----------------------------------------------------------------------------
-- clients: pipeline_id / pipeline_stage_id must belong to same organization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_clients_pipeline_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'clients.organization_id is required';
  END IF;
  IF NEW.pipeline_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pipelines pl
      WHERE pl.id = NEW.pipeline_id AND pl.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'clients.pipeline_id does not belong to this organization';
    END IF;
  END IF;
  IF NEW.pipeline_stage_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pipeline_stages ps
      INNER JOIN public.pipelines pl ON pl.id = ps.pipeline_id
      WHERE ps.id = NEW.pipeline_stage_id
        AND ps.organization_id = NEW.organization_id
        AND pl.organization_id = NEW.organization_id
        AND (NEW.pipeline_id IS NULL OR ps.pipeline_id = NEW.pipeline_id)
    ) THEN
      RAISE EXCEPTION 'clients.pipeline_stage_id does not match organization or pipeline';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- Requires clients.pipeline_id (see workflow_automation.sql).
DROP TRIGGER IF EXISTS clients_pipeline_org ON public.clients;
CREATE TRIGGER clients_pipeline_org
  BEFORE INSERT OR UPDATE OF pipeline_id, pipeline_stage_id, organization_id ON public.clients
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_clients_pipeline_org();
