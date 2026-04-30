import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

const MAX_ROWS = 500;

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function normEmail(s: unknown): string {
  return String(s || "").trim().toLowerCase();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Use POST." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(req, 500, { error: "Missing Supabase env." });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(req, 401, { error: "Missing Authorization." });
  }
  const jwt = authHeader.slice("Bearer ".length);

  let body: { organizationId?: string; rows?: Record<string, unknown>[]; importSource?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(req, 400, { error: "Invalid JSON." });
  }

  const organizationId = String(body.organizationId || "").trim();
  if (!organizationId) return json(req, 400, { error: "organizationId is required." });

  const rowsIn = Array.isArray(body.rows) ? body.rows : [];
  if (!rowsIn.length) return json(req, 400, { error: "rows array is required." });
  if (rowsIn.length > MAX_ROWS) {
    return json(req, 400, { error: `At most ${MAX_ROWS} rows per request.` });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json(req, 401, { error: "Invalid session." });
  const user = userData.user;

  const { data: mem, error: memErr } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (memErr || !mem) return json(req, 403, { error: "Not a member of this organization." });

  const admin = createClient(supabaseUrl, serviceKey);
  const importSource = String(body.importSource || "csv").trim() || "csv";
  const now = new Date().toISOString();

  const payload = rowsIn.map((r) => {
    const submittedAtRaw = r.submittedAt != null ? String(r.submittedAt).trim() : "";
    const submittedAt = submittedAtRaw ? new Date(submittedAtRaw).toISOString() : now;
    return {
      organization_id: organizationId,
      submitted_at: submittedAt,
      contact_name: String(r.contactName || r.contact_name || "").trim() || null,
      company_name: String(r.companyName || r.company_name || "").trim() || null,
      email: normEmail(r.email) || null,
      phone: String(r.phone || "").trim() || null,
      utm_source: String(r.utmSource || r.utm_source || "").trim() || null,
      utm_medium: String(r.utmMedium || r.utm_medium || "").trim() || null,
      utm_campaign: String(r.utmCampaign || r.utm_campaign || "").trim() || null,
      ga_client_id: String(r.gaClientId || r.ga_client_id || "").trim() || null,
      search_keyword: String(r.searchKeyword || r.search_keyword || "").trim() || null,
      marketing_client_id: String(r.marketingClientId || r.marketing_client_id || "").trim() || null,
      purchased: Boolean(r.purchased),
      purchase_amount: Number(r.purchaseAmount ?? r.purchase_amount ?? 0) || 0,
      is_retainer: Boolean(r.isRetainer ?? r.is_retainer),
      lifetime_value: Number(r.lifetimeValue ?? r.lifetime_value ?? 0) || 0,
      import_source: importSource === "crm_import" ? "crm_import" : "csv",
      raw_import: typeof r === "object" ? r : {},
    };
  });

  const { error: insErr } = await admin.from("attribution_leads").insert(payload);
  if (insErr) {
    return json(req, 400, { error: insErr.message || "Bulk insert failed." });
  }

  return json(req, 200, { ok: true, inserted: payload.length });
});
