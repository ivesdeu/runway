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

function slugOk(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(s);
}

type Action =
  | "create_org"
  | "invite_user"
  | "list_orgs"
  | "org_members"
  | "list_runway_orgs"
  | "list_compass_orgs_without_runway"
  | "enable_runway_for_org"
  | "get_latest_credentials";

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function pick(chars: string): string {
  const idx = Math.floor(Math.random() * chars.length);
  return chars[idx] || chars[0];
}

function generateTempPassword15(): string {
  // 15 chars; at least one lowercase, uppercase, number.
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const all = lower + upper + digits;

  const chars: string[] = [pick(lower), pick(upper), pick(digits)];
  while (chars.length < 15) chars.push(pick(all));

  // Fisher–Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(req, 500, { error: "Missing Supabase env vars" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return json(req, 401, { error: "Missing Authorization" });
  const accessToken = authHeader.slice(7).trim();
  if (!accessToken) return json(req, 401, { error: "Missing Authorization" });

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(req, 400, { error: "Invalid JSON" });
  }

  const action = String(payload.action || "") as Action;
  if (
    action !== "create_org" &&
    action !== "invite_user" &&
    action !== "list_orgs" &&
    action !== "org_members" &&
    action !== "list_runway_orgs" &&
    action !== "list_compass_orgs_without_runway" &&
    action !== "enable_runway_for_org" &&
    action !== "get_latest_credentials"
  ) {
    return json(req, 400, { error: "Unknown action" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData?.user?.id) return json(req, 401, { error: "Invalid session" });
  const callerId = userData.user.id;
  const callerEmail = normEmail(userData.user.email);
  if (!callerEmail) return json(req, 403, { error: "Developer access denied" });

  // Developer gate:
  // - Preferred: IDM org membership with role `platform_admin` (RPC: is_platform_admin)
  // - Fallback: hard allow `contact@ivesdeu.com` so dev tools work even before migrations are applied.
  let isDev = callerEmail === "contact@ivesdeu.com";
  try {
    const { data: plat, error: pErr } = await admin.rpc("is_platform_admin");
    if (!pErr && plat === true) isDev = true;
  } catch (_) {}
  if (!isDev) return json(req, 403, { error: "Developer access denied" });

  if (action === "create_org") {
    const name = String(payload.name || "").trim();
    const slug = String(payload.slug || "").trim().toLowerCase();
    const adminEmail = normEmail(payload.adminEmail);
    if (!name) return json(req, 400, { error: "name is required" });
    if (!slugOk(slug)) return json(req, 400, { error: "Invalid slug" });
    if (!adminEmail) return json(req, 400, { error: "adminEmail is required" });
    if (!isValidEmail(adminEmail)) return json(req, 400, { error: "Invalid adminEmail" });

    const { data: orgIns, error: orgErr } = await admin
      .from("organizations")
      .insert({
        name,
        slug,
        admin_email: adminEmail,
        onboarding_completed: false,
      })
      .select("id, slug, name, admin_email, created_at, onboarding_completed")
      .single();
    if (orgErr) return json(req, 400, { error: orgErr.message });

    // Entitlements: Runway implies Compass.
    const entRows = [
      { organization_id: orgIns.id, app_key: "compass", enabled: true },
      { organization_id: orgIns.id, app_key: "runway", enabled: true },
    ];
    const { error: entErr } = await admin.from("organization_apps").upsert(entRows, { onConflict: "organization_id,app_key" });
    if (entErr) return json(req, 400, { error: entErr.message });

    // Provision initial admin user with a temporary password.
    // Important: If this email already exists, DO NOT reset their password. Users may belong to multiple orgs/apps.
    let temporaryPassword: string | null = null;

    let targetUserId: string | null = null;
    try {
      const { data: existing } = await admin.auth.admin.getUserByEmail(adminEmail);
      targetUserId = existing?.user?.id || null;
    } catch (_) {}

    if (!targetUserId) {
      temporaryPassword = generateTempPassword15();
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: adminEmail,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { provisioned_by: callerEmail },
      });
      if (cErr) return json(req, 400, { error: cErr.message });
      targetUserId = created?.user?.id || null;
    }

    if (!targetUserId) return json(req, 500, { error: "Could not provision admin user" });

    const { error: memErr } = await admin.from("organization_members").upsert(
      { organization_id: orgIns.id, user_id: targetUserId, role: "admin", created_at: new Date().toISOString() },
      { onConflict: "organization_id,user_id" },
    );
    if (memErr) return json(req, 400, { error: memErr.message });

    // Only force password change for newly provisioned accounts.
    if (temporaryPassword) {
      await admin.from("user_security").upsert({ user_id: targetUserId, must_change_password: true });
      await admin.from("organization_provisioning_credentials").insert({
        organization_id: orgIns.id,
        email: adminEmail,
        kind: "org_admin",
        temporary_password: temporaryPassword,
      });
    }

    return json(req, 200, { ok: true, organization: orgIns, userId: targetUserId, temporaryPassword });
  }

  async function memberCountsForOrgIds(ids: string[]) {
    const memberCounts: Record<string, number> = {};
    if (!ids.length) return memberCounts;
    const { data: counts, error: cErr } = await admin
      .from("organization_members")
      .select("organization_id")
      .in("organization_id", ids);
    if (!cErr && counts) {
      for (const row of counts) {
        const oid = String((row as { organization_id?: string }).organization_id || "");
        if (!oid) continue;
        memberCounts[oid] = (memberCounts[oid] || 0) + 1;
      }
    }
    return memberCounts;
  }

  async function listOrgsByIds(ids: string[]) {
    if (!ids.length) return [];
    const { data: orgs, error } = await admin
      .from("organizations")
      .select("id, slug, name, admin_email, created_at, onboarding_completed")
      .in("id", ids)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return orgs || [];
  }

  if (action === "list_orgs") {
    const { data: orgs, error } = await admin
      .from("organizations")
      .select("id, slug, name, admin_email, created_at, onboarding_completed")
      .order("created_at", { ascending: false });
    if (error) return json(req, 400, { error: error.message });

    const ids = (orgs || []).map((o) => (o as { id: string }).id);
    const memberCounts = await memberCountsForOrgIds(ids);

    return json(req, 200, {
      ok: true,
      organizations: (orgs || []).map((o) => {
        const id = String((o as { id?: string }).id || "");
        return {
          ...o,
          member_count: memberCounts[id] || 0,
        };
      }),
    });
  }

  if (action === "list_runway_orgs") {
    const { data: rows, error } = await admin
      .from("organization_apps")
      .select("organization_id")
      .eq("app_key", "runway")
      .eq("enabled", true);
    if (error) return json(req, 400, { error: error.message });
    const ids: string[] = Array.from(
      new Set((rows || []).map((r) => String((r as { organization_id?: string }).organization_id || "")).filter(Boolean)),
    );
    try {
      const orgs = await listOrgsByIds(ids);
      const memberCounts = await memberCountsForOrgIds(ids);
      return json(req, 200, {
        ok: true,
        organizations: orgs.map((o) => {
          const id = String((o as { id?: string }).id || "");
          return { ...o, member_count: memberCounts[id] || 0 };
        }),
      });
    } catch (e) {
      return json(req, 400, { error: String((e as Error).message || e) });
    }
  }

  if (action === "list_compass_orgs_without_runway") {
    const { data: comp, error: cErr } = await admin
      .from("organization_apps")
      .select("organization_id")
      .eq("app_key", "compass")
      .eq("enabled", true);
    if (cErr) return json(req, 400, { error: cErr.message });
    const { data: run, error: rErr } = await admin
      .from("organization_apps")
      .select("organization_id")
      .eq("app_key", "runway")
      .eq("enabled", true);
    if (rErr) return json(req, 400, { error: rErr.message });

    const compassIds: Set<string> = new Set(
      (comp || []).map((r) => String((r as { organization_id?: string }).organization_id || "")).filter(Boolean),
    );
    const runwayIds: Set<string> = new Set(
      (run || []).map((r) => String((r as { organization_id?: string }).organization_id || "")).filter(Boolean),
    );
    const ids: string[] = Array.from(compassIds).filter((id) => !runwayIds.has(id));

    try {
      const orgs = await listOrgsByIds(ids);
      const memberCounts = await memberCountsForOrgIds(ids);
      return json(req, 200, {
        ok: true,
        organizations: orgs.map((o) => {
          const id = String((o as { id?: string }).id || "");
          return { ...o, member_count: memberCounts[id] || 0 };
        }),
      });
    } catch (e) {
      return json(req, 400, { error: String((e as Error).message || e) });
    }
  }

  if (action === "enable_runway_for_org") {
    const organizationId = String(payload.organizationId || "").trim();
    if (!organizationId) return json(req, 400, { error: "organizationId is required" });
    const entRows = [
      { organization_id: organizationId, app_key: "compass", enabled: true },
      { organization_id: organizationId, app_key: "runway", enabled: true },
    ];
    const { error: entErr } = await admin.from("organization_apps").upsert(entRows, { onConflict: "organization_id,app_key" });
    if (entErr) return json(req, 400, { error: entErr.message });
    return json(req, 200, { ok: true });
  }

  if (action === "get_latest_credentials") {
    const organizationId = String(payload.organizationId || "").trim();
    const email = normEmail(payload.email);
    if (!organizationId) return json(req, 400, { error: "organizationId is required" });
    if (!email) return json(req, 400, { error: "email is required" });
    const { data, error } = await admin
      .from("organization_provisioning_credentials")
      .select("temporary_password, created_at, kind")
      .eq("organization_id", organizationId)
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return json(req, 400, { error: error.message });
    const row = data && data[0] ? data[0] as { temporary_password?: string; created_at?: string; kind?: string } : null;
    return json(req, 200, { ok: true, temporaryPassword: row?.temporary_password || null, created_at: row?.created_at || null, kind: row?.kind || null });
  }

  if (action === "org_members") {
    const organizationId = String(payload.organizationId || "").trim();
    if (!organizationId) return json(req, 400, { error: "organizationId is required" });
    const { data: rows, error } = await admin
      .from("organization_members")
      .select("user_id, role, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true });
    if (error) return json(req, 400, { error: error.message });

    const members: { email: string | null; role: string; created_at: string | null }[] = [];
    for (const r of rows || []) {
      const uid = String((r as { user_id?: string }).user_id || "");
      if (!uid) continue;
      let email: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(uid);
        email = u?.user?.email || null;
      } catch (_) {
        email = null;
      }
      members.push({
        email,
        role: String((r as { role?: string }).role || ""),
        created_at: (r as { created_at?: string }).created_at || null,
      });
    }
    return json(req, 200, { ok: true, members });
  }

  // invite_user
  const organizationId = String(payload.organizationId || "").trim();
  const email = normEmail(payload.email);
  const roleRaw = String(payload.role || "member").trim();
  const role = roleRaw === "admin" || roleRaw === "member" || roleRaw === "viewer" ? roleRaw : "member";
  if (!organizationId) return json(req, 400, { error: "organizationId is required" });
  if (!email) return json(req, 400, { error: "email is required" });
  if (role === "viewer" || role === "member" || role === "admin") {
    // ok
  } else {
    return json(req, 400, { error: "Invalid role" });
  }

  // TEMP provisioning: if user doesn't exist, create with a random temporary password (returned to developer).
  // If user exists, add membership only and do NOT reset their password (supports multi-org users).
  let temporaryPassword: string | null = null;

  // Create or fetch user id.
  let targetUserId: string | null = null;
  try {
    const { data: existing } = await admin.auth.admin.getUserByEmail(email);
    targetUserId = existing?.user?.id || null;
  } catch (_) {}

  if (!targetUserId) {
    temporaryPassword = generateTempPassword15();
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { provisioned_by: callerEmail },
    });
    if (cErr) return json(req, 400, { error: cErr.message });
    targetUserId = created?.user?.id || null;
  }
  if (!targetUserId) return json(req, 500, { error: "Could not provision user" });

  const { error: memErr } = await admin.from("organization_members").upsert(
    { organization_id: organizationId, user_id: targetUserId, role, created_at: new Date().toISOString() },
    { onConflict: "organization_id,user_id" },
  );
  if (memErr) return json(req, 400, { error: memErr.message });

  if (temporaryPassword) {
    await admin.from("user_security").upsert({ user_id: targetUserId, must_change_password: true });
    await admin.from("organization_provisioning_credentials").insert({
      organization_id: organizationId,
      email,
      kind: "invite_user",
      temporary_password: temporaryPassword,
    });
  }

  return json(req, 200, { ok: true, userId: targetUserId, temporaryPassword });
});

