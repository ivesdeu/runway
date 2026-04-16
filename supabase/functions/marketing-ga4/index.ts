import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

type RequestBody = {
  organizationId?: string;
};

type Ga4Config = {
  apiKey: string;
  propertyId: string;
};

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function parseGa4Config(raw: string | undefined): Ga4Config | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  // Preferred format in secret: {"apiKey":"...","propertyId":"123456789"}
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const apiKey = String(parsed.apiKey || parsed.key || "").trim();
      const propertyId = String(parsed.propertyId || parsed.property || "").trim();
      if (apiKey && propertyId) return { apiKey, propertyId };
    } catch {
      return null;
    }
    return null;
  }

  // Optional compact formats: <apiKey>|<propertyId> or <propertyId>|<apiKey>
  const parts = text.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    const [a, b] = parts;
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (!aNum && bNum) return { apiKey: a, propertyId: b };
    if (aNum && !bNum) return { apiKey: b, propertyId: a };
  }

  return null;
}

async function runGa4Report(apiKey: string, propertyId: string, body: Record<string, unknown>) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`GA4 API ${resp.status}: ${txt.slice(0, 450)}`);
  }
  return await resp.json();
}

function metricValue(data: Record<string, unknown>, index: number): number {
  const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
  const first = rows[0] || {};
  const mv = Array.isArray(first.metricValues) ? (first.metricValues as Record<string, unknown>[]) : [];
  return Number(mv[index]?.value || 0) || 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed. Use POST." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return json(req, 500, { error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const jwt = authHeader.slice("Bearer ".length);

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json(req, 400, { error: "Invalid JSON body." });
  }
  const organizationId = String(body.organizationId || "").trim();
  if (!organizationId) return json(req, 400, { error: "organizationId is required." });

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json(req, 401, { error: "Invalid session" });
  const user = userData.user;

  const { data: membership, error: memErr } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (memErr || !membership) return json(req, 403, { error: "Not a member of this organization." });

  const cfg = parseGa4Config(Deno.env.get("GA4"));
  if (!cfg) {
    return json(req, 200, {
      ok: true,
      configured: false,
      reason: "GA4 secret is missing or invalid. Set GA4 as JSON: {\"apiKey\":\"...\",\"propertyId\":\"...\"}.",
    });
  }

  try {
    const summaryData = await runGa4Report(cfg.apiKey, cfg.propertyId, {
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "newUsers" },
        { name: "screenPageViews" },
        { name: "conversions" },
      ],
    });

    const channelsData = await runGa4Report(cfg.apiKey, cfg.propertyId, {
      dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 6,
    });

    const channels = (Array.isArray(channelsData.rows) ? channelsData.rows : []).map((r: Record<string, unknown>) => {
      const dv = Array.isArray(r.dimensionValues) ? (r.dimensionValues as Record<string, unknown>[]) : [];
      const mv = Array.isArray(r.metricValues) ? (r.metricValues as Record<string, unknown>[]) : [];
      return {
        source: String(dv[0]?.value || "Unknown"),
        sessions: Number(mv[0]?.value || 0) || 0,
      };
    });

    return json(req, 200, {
      ok: true,
      configured: true,
      window: "last_7_days",
      summary: {
        sessions: metricValue(summaryData, 0),
        users: metricValue(summaryData, 1),
        newUsers: metricValue(summaryData, 2),
        pageViews: metricValue(summaryData, 3),
        conversions: metricValue(summaryData, 4),
      },
      channels,
    });
  } catch (err) {
    const details = err instanceof Error ? err.message : "Unknown GA4 error";
    return json(req, 200, {
      ok: true,
      configured: true,
      error: "GA4 request failed.",
      details,
    });
  }
});
