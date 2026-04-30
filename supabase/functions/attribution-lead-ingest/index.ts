import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

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
  const ingestSecret = String(Deno.env.get("ATTRIBUTION_INGEST_SECRET") || "").trim();
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(req, 500, { error: "Missing Supabase env." });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(req, 400, { error: "Invalid JSON." });
  }

  const organizationId = String(body.organizationId || "").trim();
  if (!organizationId) return json(req, 400, { error: "organizationId is required." });

  const admin = createClient(supabaseUrl, serviceKey);

  const secretHeader = String(req.headers.get("x-attribution-ingest-secret") || "").trim();
  const secretBody = String(body.ingestSecret || "").trim();
  const provided = secretHeader || secretBody;
  const authHeader = req.headers.get("Authorization");

  let allowed = false;

  if (ingestSecret && provided === ingestSecret) {
    allowed = true;
  } else if (authHeader?.startsWith("Bearer ")) {
    const jwt = authHeader.slice("Bearer ".length);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json(req, 401, { error: "Invalid session." });
    }
    const user = userData.user;
    const { data: mem } = await userClient
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!mem) return json(req, 403, { error: "Not a member of this organization." });
    allowed = true;
  }

  if (!allowed) {
    return json(req, 401, {
      error: "Provide a valid session (Authorization: Bearer) or x-attribution-ingest-secret matching ATTRIBUTION_INGEST_SECRET.",
    });
  }

  const submittedAtRaw = body.submittedAt != null ? String(body.submittedAt).trim() : "";
  const submittedAt = submittedAtRaw ? new Date(submittedAtRaw).toISOString() : new Date().toISOString();

  const row = {
    organization_id: organizationId,
    submitted_at: submittedAt,
    contact_name: String(body.contactName || body.contact_name || "").trim() || null,
    company_name: String(body.companyName || body.company_name || "").trim() || null,
    email: normEmail(body.email) || null,
    phone: String(body.phone || "").trim() || null,
    utm_source: String(body.utmSource || body.utm_source || "").trim() || null,
    utm_medium: String(body.utmMedium || body.utm_medium || "").trim() || null,
    utm_campaign: String(body.utmCampaign || body.utm_campaign || "").trim() || null,
    ga_client_id: String(body.gaClientId || body.ga_client_id || "").trim() || null,
    ga_session_id: String(body.gaSessionId || body.ga_session_id || "").trim() || null,
    user_pseudo_id: String(body.userPseudoId || body.user_pseudo_id || "").trim() || null,
    gclid: String(body.gclid || "").trim() || null,
    search_keyword: String(body.searchKeyword || body.search_keyword || "").trim() || null,
    marketing_client_id: String(body.marketingClientId || body.marketing_client_id || "").trim() || null,
    first_touch: typeof body.firstTouch === "object" && body.firstTouch !== null
      ? body.firstTouch as Record<string, unknown>
      : {},
    import_source: (() => {
      const s = String(body.importSource || "form").trim() || "form";
      return ["form", "csv", "crm_import", "dashboard"].includes(s) ? s : "form";
    })(),
    raw_import: typeof body.raw === "object" && body.raw !== null ? body.raw as Record<string, unknown> : {},
  };

  const { data: ins, error: insErr } = await admin.from("attribution_leads").insert(row).select("id").maybeSingle();
  if (insErr) {
    return json(req, 400, { error: insErr.message || "Insert failed." });
  }

  return json(req, 200, { ok: true, id: ins?.id });
});
