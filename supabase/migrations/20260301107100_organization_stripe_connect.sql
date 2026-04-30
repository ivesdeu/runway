-- Stripe Connect: one connected Stripe account per organization (Express).
-- Run in Supabase SQL Editor after organizations_multitenancy.sql (needs organizations + organization_members).

CREATE TABLE IF NOT EXISTS public.organization_stripe_connections (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  connect_status text NOT NULL DEFAULT 'pending',
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  livemode boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  onboarded_by_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organization_stripe_connections_status_chk CHECK (
    connect_status IN ('pending', 'active', 'restricted', 'disconnected')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_stripe_connections_stripe_account_id_key
  ON public.organization_stripe_connections (stripe_account_id);
CREATE INDEX IF NOT EXISTS organization_stripe_connections_updated_at_idx
  ON public.organization_stripe_connections (updated_at DESC);
COMMENT ON TABLE public.organization_stripe_connections IS
  'Stripe Connect Express linkage; updated by Edge (onboarding) and stripe-webhook (account.updated).';
-- Idempotent revenue rows from Stripe webhooks (one row per payment intent per org).
CREATE UNIQUE INDEX IF NOT EXISTS transactions_org_stripe_payment_intent_uidx
  ON public.transactions (organization_id, ((metadata ->> 'stripe_payment_intent_id')))
  WHERE coalesce(metadata ->> 'stripe_payment_intent_id', '') <> '';
ALTER TABLE public.organization_stripe_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org_stripe_select" ON public.organization_stripe_connections;
DROP POLICY IF EXISTS "org_stripe_admin_all" ON public.organization_stripe_connections;
-- Reads for workspace members; inserts/updates/deletes only via Edge (service_role).
CREATE POLICY "org_stripe_select" ON public.organization_stripe_connections
  FOR SELECT TO authenticated
  USING (public.user_is_org_member(organization_id));
GRANT SELECT ON public.organization_stripe_connections TO authenticated;
GRANT ALL ON public.organization_stripe_connections TO service_role;
