-- Rich invoice draft (line items, memo, metadata) for the full-screen editor; optional for legacy rows.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_details jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.invoices.invoice_details IS
  'Client-only draft fields: lineItems[], memo, billingMethod, currency, taxRate, metadata object.';
