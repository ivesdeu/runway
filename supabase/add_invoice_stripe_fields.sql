-- Run once in Supabase SQL Editor before using Stripe Checkout sessions.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_status text;

CREATE INDEX IF NOT EXISTS invoices_stripe_checkout_session_id_idx
  ON public.invoices (stripe_checkout_session_id);
