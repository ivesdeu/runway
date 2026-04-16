import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@16.12.0";
import { corsHeadersFor } from "../_shared/cors.ts";

type RequestBody = {
  invoiceId?: string;
  organizationId?: string;
  successUrl?: string;
  cancelUrl?: string;
};

function jsonResponse(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeadersFor(req),
      "Content-Type": "application/json",
    },
  });
}

function isWriteRole(role: string | undefined) {
  return role === "owner" || role === "admin" || role === "member";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, 405, { error: "Method not allowed. Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !stripeSecretKey) {
    return jsonResponse(req, 500, {
      error:
        "Missing required env vars. Expected SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY.",
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse(req, 401, { error: "Missing Authorization header." });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse(req, 400, { error: "Invalid JSON body." });
  }

  if (!body.invoiceId) {
    return jsonResponse(req, 400, { error: "invoiceId is required." });
  }
  if (!body.organizationId) {
    return jsonResponse(req, 400, { error: "organizationId is required." });
  }

  const appBaseUrl = Deno.env.get("APP_BASE_URL") || "http://localhost:5173";
  const successUrl = body.successUrl || `${appBaseUrl}?payment=success`;
  const cancelUrl = body.cancelUrl || `${appBaseUrl}?payment=cancel`;

  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : authHeader;
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const stripe = new Stripe(stripeSecretKey, {
    appInfo: {
      name: "idm-business-dashboard",
      version: "1.0.0",
    },
  });

  // Pass JWT explicitly — server-side clients have no session state.
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse(req, 401, { error: "Invalid or expired auth token." });
  }
  const user = userData.user;

  const { data: membership, error: memErr } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", body.organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (memErr || !membership || !isWriteRole(membership.role as string | undefined)) {
    return jsonResponse(req, 403, { error: "Not allowed to bill for this organization." });
  }

  const { data: invoice, error: invoiceErr } = await adminClient
    .from("invoices")
    .select("id, user_id, organization_id, income_tx_id, number, amount, status")
    .eq("id", body.invoiceId)
    .eq("organization_id", body.organizationId)
    .maybeSingle();

  if (invoiceErr) {
    return jsonResponse(req, 500, { error: "Failed to load invoice.", details: invoiceErr.message });
  }
  if (!invoice) {
    return jsonResponse(req, 404, { error: "Invoice not found for this organization." });
  }

  const amount = Number(invoice.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonResponse(req, 400, { error: "Invoice amount must be greater than zero." });
  }

  const amountInCents = Math.round(amount * 100);
  const invoiceLabel = invoice.number ? `Invoice ${invoice.number}` : `Invoice ${invoice.id}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountInCents,
            product_data: {
              name: invoiceLabel,
              description: "Payment for dashboard invoice",
            },
          },
        },
      ],
      metadata: {
        invoice_id: String(invoice.id),
        organization_id: String(body.organizationId),
        user_id: String(user.id),
        income_tx_id: String(invoice.income_tx_id || ""),
      },
      client_reference_id: String(invoice.id),
      customer_email: user.email || undefined,
    });

    const { error: updateErr } = await adminClient
      .from("invoices")
      .update({
        stripe_checkout_session_id: session.id,
        stripe_status: session.status || "open",
      })
      .eq("id", invoice.id)
      .eq("organization_id", body.organizationId);

    if (updateErr) {
      return jsonResponse(req, 500, {
        error: "Checkout session created but failed to save Stripe metadata to invoice.",
        details: updateErr.message,
      });
    }

    return jsonResponse(req, 200, {
      sessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown Stripe error";
    return jsonResponse(req, 500, { error: "Failed to create Stripe Checkout session.", details: msg });
  }
});
