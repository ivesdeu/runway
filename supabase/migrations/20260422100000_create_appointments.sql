-- Compass Scheduling: appointments tied to org + clients (CRM contacts).

CREATE TABLE IF NOT EXISTS public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients (id) ON DELETE SET NULL,
  title text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  location text,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('confirmed', 'pending', 'cancelled')),
  google_calendar_event_id text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_organization_id_start_time_idx
  ON public.appointments (organization_id, start_time);
CREATE INDEX IF NOT EXISTS appointments_client_id_idx ON public.appointments (client_id);
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_row_select" ON public.appointments;
DROP POLICY IF EXISTS "org_row_insert" ON public.appointments;
DROP POLICY IF EXISTS "org_row_update" ON public.appointments;
DROP POLICY IF EXISTS "org_row_delete" ON public.appointments;
CREATE POLICY "org_row_select" ON public.appointments FOR SELECT TO authenticated
  USING (public.user_is_org_member (organization_id));
CREATE POLICY "org_row_insert" ON public.appointments FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write_org (organization_id));
CREATE POLICY "org_row_update" ON public.appointments FOR UPDATE TO authenticated
  USING (public.user_can_write_org (organization_id))
  WITH CHECK (public.user_can_write_org (organization_id));
CREATE POLICY "org_row_delete" ON public.appointments FOR DELETE TO authenticated
  USING (public.user_can_write_org (organization_id));
-- client_id must belong to same organization (nullable allowed)
CREATE OR REPLACE FUNCTION public.trg_appointments_client_org ()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'appointments.organization_id is required';
  END IF;
  IF NEW.client_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'appointments.client_id does not belong to this organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS appointments_client_org ON public.appointments;
CREATE TRIGGER appointments_client_org
  BEFORE INSERT OR UPDATE OF client_id, organization_id ON public.appointments
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_appointments_client_org ();
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments TO authenticated;
GRANT ALL ON public.appointments TO service_role;
