import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }

  let token = "";
  try {
    const body = (await req.json()) as { token?: string };
    token = String(body.token || "").trim();
  } catch {
    return json(req, 400, { error: "Invalid JSON" });
  }
  if (!token) return json(req, 400, { error: "token is required" });

  const jwt = authHeader.slice("Bearer ".length);
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  // Pass JWT explicitly — server-side clients have no session state.
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user?.email) {
    return json(req, 401, { error: "Invalid session" });
  }
  const user = userData.user;
  const emailLower = user.email.trim().toLowerCase();

  const { data: inv, error: invErr } = await admin
    .from("organization_invitations")
    .select("id, organization_id, email, role, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle();

  if (invErr || !inv) {
    return json(req, 404, { error: "Invitation not found" });
  }
  const row = inv as {
    id: string;
    organization_id: string;
    email: string;
    role: string;
    expires_at: string;
    accepted_at: string | null;
  };
  if (row.accepted_at) {
    return json(req, 400, { error: "Invitation already used" });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return json(req, 400, { error: "Invitation expired" });
  }
  if (row.email.trim().toLowerCase() !== emailLower) {
    return json(req, 403, { error: "Signed in as a different email than the invite" });
  }

  const { error: memErr } = await admin.from("organization_members").upsert(
    {
      organization_id: row.organization_id,
      user_id: user.id,
      role: row.role,
      created_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,user_id" },
  );
  if (memErr) {
    return json(req, 400, { error: memErr.message });
  }

  await admin
    .from("organization_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", row.id);

  const { data: org } = await admin.from("organizations").select("slug").eq("id", row.organization_id).maybeSingle();
  const slug = (org as { slug?: string } | null)?.slug || "";

  return json(req, 200, { ok: true, organizationId: row.organization_id, slug });
});
