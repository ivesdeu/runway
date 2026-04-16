import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

type Action =
  | "list"
  | "add"
  | "update_role"
  | "remove"
  | "invite"
  | "pending_invites"
  | "revoke_invite";

const ROLES = new Set(["owner", "admin", "member", "viewer"]);

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function isOrgAdmin(role: string | undefined) {
  return role === "owner" || role === "admin";
}

async function getCallerMembership(
  userClient: ReturnType<typeof createClient>,
  orgId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const { data, error } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return { role: String((data as { role?: string }).role || "") };
}

async function findUserIdByEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (let i = 0; i < 20; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === normalized);
    if (hit?.id) return hit.id;
    if (users.length < perPage) break;
    page++;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(req, 500, { error: "Missing Supabase env vars" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const accessToken = authHeader.slice(7).trim();
  if (!accessToken) {
    return json(req, 401, { error: "Missing Authorization" });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(req, 400, { error: "Invalid JSON" });
  }

  const action = String(payload.action || "");
  const organizationId = String(payload.organizationId || "").trim();
  if (!organizationId) {
    return json(req, 400, { error: "organizationId is required" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  // Edge has no persisted auth session; getUser() without args can fail. Pass the access JWT explicitly.
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return json(req, 401, { error: userErr?.message || "Invalid session" });
  }
  const user = userData.user;

  const membership = await getCallerMembership(userClient, organizationId, user.id);
  if (!membership) {
    return json(req, 403, { error: "Not a member of this organization" });
  }

  const callerRole = membership.role;

  if (action === "list") {
    const { data: rows, error } = await userClient
      .from("organization_members")
      .select("user_id, role, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true });
    if (error) return json(req, 500, { error: error.message });
    const members: { user_id: string; email: string | null; role: string; created_at?: string }[] = [];
    for (const row of rows || []) {
      const uid = String((row as { user_id?: string }).user_id || "");
      if (!uid) continue;
      let email: string | null = null;
      try {
        const { data: u, error: gu } = await admin.auth.admin.getUserById(uid);
        if (!gu && u?.user?.email) email = u.user.email;
      } catch {
        email = null;
      }
      members.push({
        user_id: uid,
        email,
        role: String((row as { role?: string }).role || ""),
        created_at: (row as { created_at?: string }).created_at,
      });
    }
    return json(req, 200, {
      ok: true,
      members,
      canManage: isOrgAdmin(callerRole),
      yourRole: callerRole,
    });
  }

  if (!isOrgAdmin(callerRole)) {
    return json(req, 403, { error: "Only workspace admins can do that" });
  }

  if (action === "add") {
    const email = String(payload.email || "").trim().toLowerCase();
    const role = String(payload.role || "member");
    if (!email || !ROLES.has(role) || role === "owner") {
      return json(req, 400, { error: "Valid email and role (admin, member, viewer) required; use promote for owner." });
    }
    let targetId: string;
    try {
      const found = await findUserIdByEmail(admin, email);
      if (!found) return json(req, 404, { error: "No user with that email. Use invite to send a link instead." });
      targetId = found;
    } catch (e) {
      return json(req, 500, { error: e instanceof Error ? e.message : "Lookup failed" });
    }
    const { error: insErr } = await userClient.from("organization_members").upsert(
      {
        organization_id: organizationId,
        user_id: targetId,
        role,
        created_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id" },
    );
    if (insErr) return json(req, 400, { error: insErr.message });
    return json(req, 200, { ok: true });
  }

  if (action === "update_role") {
    const targetUserId = String(payload.userId || "").trim();
    const role = String(payload.role || "").trim();
    if (!targetUserId || !ROLES.has(role)) {
      return json(req, 400, { error: "userId and valid role required" });
    }
    if (callerRole !== "owner" && role === "owner") {
      return json(req, 403, { error: "Only an owner can assign the owner role" });
    }
    const { error: upErr } = await userClient
      .from("organization_members")
      .update({ role })
      .eq("organization_id", organizationId)
      .eq("user_id", targetUserId);
    if (upErr) return json(req, 400, { error: upErr.message });
    return json(req, 200, { ok: true });
  }

  if (action === "remove") {
    const targetUserId = String(payload.userId || "").trim();
    if (!targetUserId) return json(req, 400, { error: "userId required" });
    if (targetUserId === user.id) {
      return json(req, 400, { error: "Use another admin to remove your membership" });
    }
    const { data: deletedRows, error: delErr } = await userClient
      .from("organization_members")
      .delete()
      .eq("organization_id", organizationId)
      .eq("user_id", targetUserId)
      .select("user_id");
    if (delErr) return json(req, 400, { error: delErr.message });
    if (!deletedRows?.length) {
      return json(req, 404, {
        error: "No membership was removed. They may have already left, or your role cannot remove this member.",
      });
    }
    return json(req, 200, { ok: true });
  }

  if (action === "invite") {
    const email = String(payload.email || "").trim().toLowerCase();
    let role = String(payload.role || "member").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(req, 400, { error: "Valid email required" });
    }
    if (!ROLES.has(role)) role = "member";
    if (role === "owner") {
      return json(req, 400, { error: "Cannot invite as owner; promote after they join." });
    }
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: invErr } = await admin.from("organization_invitations").insert({
      organization_id: organizationId,
      email,
      role,
      token,
      invited_by: user.id,
      expires_at: expiresAt,
    });
    if (invErr) {
      if (/duplicate|unique/i.test(invErr.message)) {
        return json(req, 409, { error: "An open invitation already exists for that email." });
      }
      return json(req, 400, { error: invErr.message });
    }
    const appBase = (Deno.env.get("APP_BASE_URL") || "http://localhost:5173").replace(/\/$/, "");
    const inviteUrl = `${appBase}/?invite=${encodeURIComponent(token)}`;
    return json(req, 200, { ok: true, inviteUrl, token, expiresAt });
  }

  if (action === "pending_invites") {
    const { data: invs, error } = await admin
      .from("organization_invitations")
      .select("id, email, role, expires_at, created_at")
      .eq("organization_id", organizationId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false });
    if (error) return json(req, 500, { error: error.message });
    return json(req, 200, { ok: true, invitations: invs || [] });
  }

  if (action === "revoke_invite") {
    const inviteId = String(payload.inviteId || "").trim();
    if (!inviteId) return json(req, 400, { error: "inviteId required" });
    const { error } = await admin
      .from("organization_invitations")
      .delete()
      .eq("id", inviteId)
      .eq("organization_id", organizationId)
      .is("accepted_at", null);
    if (error) return json(req, 400, { error: error.message });
    return json(req, 200, { ok: true });
  }

  return json(req, 400, { error: "Unknown action" });
});
