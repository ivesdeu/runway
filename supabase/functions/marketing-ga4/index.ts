import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;

type RequestBody = {
  organizationId?: string;
  /** dashboard | channel_performance | audience | campaign_roi | attribution */
  reportKey?: string;
  /** Optional ISO start/end; otherwise preset last N days */
  startDate?: string;
  endDate?: string;
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
  return await resp.json() as Record<string, unknown>;
}

function metricValue(data: Record<string, unknown>, index: number): number {
  const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
  const first = rows[0] || {};
  const mv = Array.isArray(first.metricValues) ? (first.metricValues as Record<string, unknown>[]) : [];
  return Number(mv[index]?.value || 0) || 0;
}

function mapRows(data: Record<string, unknown>) {
  const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
  return rows.map((r) => {
    const dv = Array.isArray(r.dimensionValues) ? (r.dimensionValues as Record<string, unknown>[]) : [];
    const mv = Array.isArray(r.metricValues) ? (r.metricValues as Record<string, unknown>[]) : [];
    const dims = dv.map((x) => String(x?.value ?? ""));
    const metrics = mv.map((x) => Number(x?.value || 0) || 0);
    return { dimensions: dims, metrics };
  });
}

function stableCacheKey(organizationId: string, reportKey: string, start: string, end: string) {
  return `${reportKey}:${start}:${end}`;
}

async function readCache(
  admin: ReturnType<typeof createClient> | null,
  organizationId: string,
  cacheKey: string,
): Promise<Record<string, unknown> | null> {
  if (!admin) return null;
  const { data, error } = await admin
    .from("ga4_cache")
    .select("payload, fetched_at")
    .eq("organization_id", organizationId)
    .eq("cache_key", cacheKey)
    .maybeSingle();
  if (error || !data?.fetched_at) return null;
  const fetched = new Date(String(data.fetched_at)).getTime();
  if (Date.now() - fetched > CACHE_TTL_MS) return null;
  const payload = data.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

async function writeCache(
  admin: ReturnType<typeof createClient> | null,
  organizationId: string,
  cacheKey: string,
  payload: Record<string, unknown>,
) {
  if (!admin) return;
  await admin.from("ga4_cache").upsert(
    {
      organization_id: organizationId,
      cache_key: cacheKey,
      payload,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,cache_key" },
  );
}

function defaultDateRange() {
  return { startDate: "28daysAgo", endDate: "today" };
}

function priorDateRange() {
  return { startDate: "56daysAgo", endDate: "29daysAgo" };
}

async function buildDashboardPayload(apiKey: string, propertyId: string) {
  const cur = defaultDateRange();
  const prev = priorDateRange();

  const curTotals = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "newUsers" },
      { name: "conversions" },
      { name: "engagementRate" },
      { name: "averageSessionDuration" },
    ],
  });
  const prevTotals = await runGa4Report(apiKey, propertyId, {
    dateRanges: [prev],
    metrics: [
      { name: "sessions" },
      { name: "newUsers" },
      { name: "conversions" },
    ],
  });

  const sessions = metricValue(curTotals, 0);
  const sessionsPrev = metricValue(prevTotals, 0);
  const newUsers = metricValue(curTotals, 2);
  const newUsersPrev = metricValue(prevTotals, 1);
  const conversions = metricValue(curTotals, 3);
  const conversionsPrev = metricValue(prevTotals, 2);
  const cvr = sessions > 0 ? conversions / sessions : 0;
  const cvrPrev = sessionsPrev > 0 ? conversionsPrev / sessionsPrev : 0;

  const channels = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 10,
  });

  const sessionsByDayChannel = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    limit: 250,
  });

  const landingCvr = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "sessions" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 10,
  });

  const topCampaigns = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "sessionCampaignName" }],
    metrics: [{ name: "sessions" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 12,
  });

  const channelRows = mapRows(channels).map((r) => ({
    channel: r.dimensions[0] || "Unknown",
    sessions: r.metrics[0] || 0,
  }));
  const topChannel = channelRows[0]?.channel || "—";

  const series = mapRows(sessionsByDayChannel).map((r) => ({
    date: r.dimensions[0] || "",
    channel: r.dimensions[1] || "",
    sessions: r.metrics[0] || 0,
  }));

  const landingRows = mapRows(landingCvr).map((r) => {
    const s = r.metrics[0] || 0;
    const c = r.metrics[1] || 0;
    return {
      landingPage: r.dimensions[0] || "",
      sessions: s,
      conversions: c,
      cvr: s > 0 ? c / s : 0,
    };
  });

  const campaignRows = mapRows(topCampaigns).map((r) => ({
    campaign: r.dimensions[0] || "(not set)",
    sessions: r.metrics[0] || 0,
    conversions: r.metrics[1] || 0,
  }));

  return {
    dateRange: cur,
    summary: {
      sessions,
      sessionsPrev,
      sessionsDeltaPct: sessionsPrev > 0 ? ((sessions - sessionsPrev) / sessionsPrev) * 100 : null,
      newUsers,
      newUsersPrev,
      newUsersDeltaPct: newUsersPrev > 0 ? ((newUsers - newUsersPrev) / newUsersPrev) * 100 : null,
      totalUsers: metricValue(curTotals, 1),
      conversions,
      conversionRate: cvr,
      conversionRatePrev: cvrPrev,
      engagementRate: metricValue(curTotals, 4),
      avgSessionDuration: metricValue(curTotals, 5),
      topChannel,
      costPerLead: null as number | null,
      leadsNote: "CPL requires manual ad spend in workspace settings (dashboard_settings).",
    },
    channels: channelRows,
    sessionsByDayChannel: series,
    landingPages: landingRows,
    topCampaigns: campaignRows,
  };
}

async function buildChannelPerformance(apiKey: string, propertyId: string) {
  const cur = defaultDateRange();
  const data = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "sessions" }, { name: "newUsers" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 100,
  });
  const rows = mapRows(data).map((r) => {
    const s = r.metrics[0] || 0;
    const c = r.metrics[2] || 0;
    return {
      sessionSource: r.dimensions[0] || "",
      sessionMedium: r.dimensions[1] || "",
      sessions: s,
      newUsers: r.metrics[1] || 0,
      conversions: c,
      cvr: s > 0 ? c / s : 0,
    };
  });
  return { dateRange: cur, rows };
}

async function buildAudience(apiKey: string, propertyId: string) {
  const cur = defaultDateRange();
  const newVsReturning = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "date" }, { name: "newVsReturning" }],
    metrics: [{ name: "sessions" }],
    limit: 250,
  });
  const devices = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "deviceCategory" }],
    metrics: [{ name: "sessions" }, { name: "newUsers" }],
    limit: 20,
  });
  const geo = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "city" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 10,
  });
  return {
    dateRange: cur,
    newVsReturningOverTime: mapRows(newVsReturning).map((r) => ({
      date: r.dimensions[0],
      bucket: r.dimensions[1],
      sessions: r.metrics[0] || 0,
    })),
    devices: mapRows(devices).map((r) => ({
      deviceCategory: r.dimensions[0] || "",
      sessions: r.metrics[0] || 0,
      newUsers: r.metrics[1] || 0,
    })),
    topCities: mapRows(geo).map((r) => ({
      city: r.dimensions[0] || "",
      sessions: r.metrics[0] || 0,
    })),
  };
}

async function buildAttribution(apiKey: string, propertyId: string) {
  const cur = defaultDateRange();
  const utm = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "sessionCampaignName" }, { name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "sessions" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50,
  });
  const landing = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "sessions" }, { name: "conversions" }, { name: "engagementRate" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 25,
  });
  return {
    dateRange: cur,
    utmCampaigns: mapRows(utm).map((r) => {
      const s = r.metrics[0] || 0;
      const c = r.metrics[1] || 0;
      return {
        campaign: r.dimensions[0] || "",
        source: r.dimensions[1] || "",
        medium: r.dimensions[2] || "",
        sessions: s,
        conversions: c,
        cvr: s > 0 ? c / s : 0,
      };
    }),
    landingPages: mapRows(landing).map((r) => {
      const s = r.metrics[0] || 0;
      const c = r.metrics[1] || 0;
      return {
        landingPage: r.dimensions[0] || "",
        sessions: s,
        conversions: c,
        cvr: s > 0 ? c / s : 0,
        engagementRate: r.metrics[2] || 0,
      };
    }),
  };
}

/** campaign_roi GA4 slice: sessionCampaignName stats; merge with projects in client for budget/CPL */
async function buildCampaignRoiGa4(apiKey: string, propertyId: string) {
  const cur = defaultDateRange();
  const data = await runGa4Report(apiKey, propertyId, {
    dateRanges: [cur],
    dimensions: [{ name: "sessionCampaignName" }],
    metrics: [{ name: "sessions" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50,
  });
  const rows = mapRows(data).map((r) => {
    const s = r.metrics[0] || 0;
    const c = r.metrics[1] || 0;
    return {
      campaignName: r.dimensions[0] || "",
      sessions: s,
      conversions: c,
      cvr: s > 0 ? c / s : 0,
    };
  });
  return { dateRange: cur, ga4Campaigns: rows };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed. Use POST." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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

  const reportKey = String(body.reportKey || "dashboard").trim() || "dashboard";
  const startDate = String(body.startDate || "").trim();
  const endDate = String(body.endDate || "").trim();
  const rangeLabel = startDate && endDate ? `${startDate}:${endDate}` : "28d:default";

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

  const admin = serviceKey ? createClient(supabaseUrl, serviceKey) : null;
  const cacheKey = stableCacheKey(organizationId, reportKey, rangeLabel, "");
  const cached = await readCache(admin, organizationId, cacheKey);
  if (cached) {
    return json(req, 200, {
      ok: true,
      configured: true,
      cached: true,
      reportKey,
      data: cached,
    });
  }

  try {
    let data: Record<string, unknown>;
    switch (reportKey) {
      case "channel_performance":
        data = await buildChannelPerformance(cfg.apiKey, cfg.propertyId);
        break;
      case "audience":
        data = await buildAudience(cfg.apiKey, cfg.propertyId);
        break;
      case "campaign_roi":
        data = await buildCampaignRoiGa4(cfg.apiKey, cfg.propertyId);
        break;
      case "attribution":
        data = await buildAttribution(cfg.apiKey, cfg.propertyId);
        break;
      case "dashboard":
      default:
        data = await buildDashboardPayload(cfg.apiKey, cfg.propertyId);
        break;
    }

    await writeCache(admin, organizationId, cacheKey, data);

    return json(req, 200, {
      ok: true,
      configured: true,
      cached: false,
      reportKey,
      data,
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
