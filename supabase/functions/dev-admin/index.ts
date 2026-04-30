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

type Action = "create_org" | "invite_user" | "list_orgs" | "org_members";

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
  if (action !== "create_org" && action !== "invite_user" && action !== "list_orgs" && action !== "org_members") {
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
  // - Preferred: `developer_accounts` allowlist
  // - Fallback: hard allow `contact@ivesdeu.com` so dev tools work even before migrations are applied.
  let isDev = callerEmail === "contact@ivesdeu.com";
  try {
    const { data: devRow, error: devErr } = await admin
      .from("developer_accounts")
      .select("email")
      .eq("email", callerEmail)
      .maybeSingle();
    if (!devErr && devRow) isDev = true;
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
      .select("id, slug, name, admin_email, created_at")
      .single();
    if (orgErr) return json(req, 400, { error: orgErr.message });

    // Provision initial admin user with a temporary password.
    const temporaryPassword = generateTempPassword15();

    let targetUserId: string | null = null;
    try {
      const { data: existing } = await admin.auth.admin.getUserByEmail(adminEmail);
      targetUserId = existing?.user?.id || null;
    } catch (_) {}

    if (!targetUserId) {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: adminEmail,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { provisioned_by: callerEmail },
      });
      if (cErr) return json(req, 400, { error: cErr.message });
      targetUserId = created?.user?.id || null;
    } else {
      const { error: uErr } = await admin.auth.admin.updateUserById(targetUserId, { password: temporaryPassword });
      if (uErr) return json(req, 400, { error: uErr.message });
    }

    if (!targetUserId) return json(req, 500, { error: "Could not provision admin user" });

    const { error: memErr } = await admin.from("organization_members").upsert(
      { organization_id: orgIns.id, user_id: targetUserId, role: "admin", created_at: new Date().toISOString() },
      { onConflict: "organization_id,user_id" },
    );
    if (memErr) return json(req, 400, { error: memErr.message });

    await admin.from("user_security").upsert({ user_id: targetUserId, must_change_password: true });

    return json(req, 200, { ok: true, organization: orgIns, userId: targetUserId, temporaryPassword });
  }

  if (action === "list_orgs") {
    const { data: orgs, error } = await admin
      .from("organizations")
      .select("id, slug, name, admin_email, created_at")
      .order("created_at", { ascending: false });
    if (error) return json(req, 400, { error: error.message });

    const ids = (orgs || []).map((o) => (o as { id: string }).id);
    const memberCounts: Record<string, number> = {};
    if (ids.length) {
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
    }

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

  // TEMP provisioning: create user with a random temporary password (returned to developer).
  // Immediately add org membership so the account can log in and access the workspace.
  const temporaryPassword = generateTempPassword15();

  // Create or fetch user id.
  let targetUserId: string | null = null;
  try {
    const { data: existing } = await admin.auth.admin.getUserByEmail(email);
    targetUserId = existing?.user?.id || null;
  } catch (_) {}

  if (!targetUserId) {
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { provisioned_by: callerEmail },
    });
    if (cErr) return json(req, 400, { error: cErr.message });
    targetUserId = created?.user?.id || null;
  } else {
    const { error: uErr } = await admin.auth.admin.updateUserById(targetUserId, { password: temporaryPassword });
    if (uErr) return json(req, 400, { error: uErr.message });
  }
  if (!targetUserId) return json(req, 500, { error: "Could not provision user" });

  const { error: memErr } = await admin.from("organization_members").upsert(
    { organization_id: organizationId, user_id: targetUserId, role, created_at: new Date().toISOString() },
    { onConflict: "organization_id,user_id" },
  );
  if (memErr) return json(req, 400, { error: memErr.message });

  await admin.from("user_security").upsert({ user_id: targetUserId, must_change_password: true });

  return json(req, 200, { ok: true, userId: targetUserId, temporaryPassword });
});

