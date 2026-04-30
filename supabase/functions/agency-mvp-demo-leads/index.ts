import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";

/** Matches seed migration org id (runway-demo workspace). */
const DEMO_ORG_ID = "00000000-0000-4000-b000-000000000001";

const MAX_UPDATES_PER_REQUEST = 12;
const MAX_STR = 2000;

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function trimStr(v: unknown, max: number): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function optionalBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return Boolean(v);
}

function optionalNum(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(req, 500, { error: "Missing Supabase env." });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("attribution_leads")
      .select(
        "id,submitted_at,company_name,contact_name,utm_campaign,ga_client_id,search_keyword,purchased,purchase_amount,import_source,raw_import"
      )
      .eq("organization_id", DEMO_ORG_ID)
      .contains("raw_import", { mvp_demo: true })
      .order("submitted_at", { ascending: true });

    if (error) {
      return json(req, 400, { error: error.message || "Query failed." });
    }
    return json(req, 200, { rows: data ?? [] });
  }

  if (req.method === "POST") {
    const writeToken = Deno.env.get("DEMO_MVP_WRITE_TOKEN");
    if (writeToken && writeToken.length > 0) {
      const sent = req.headers.get("x-demo-mvp-token") || "";
      if (sent !== writeToken) {
        return json(req, 401, { error: "Invalid demo write token." });
      }
    }

    let body: {
      updates?: Record<string, unknown>[];
      insert?: Record<string, unknown>;
      deleteIds?: string[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(req, 400, { error: "Invalid JSON." });
    }

    const updates = Array.isArray(body.updates) ? body.updates : [];
    const hasInsert = body.insert && typeof body.insert === "object" && !Array.isArray(body.insert);
    const deleteIds = Array.isArray(body.deleteIds)
      ? body.deleteIds.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (updates.length === 0 && !hasInsert && deleteIds.length === 0) {
      return json(req, 400, { error: "Provide updates, insert, and/or deleteIds." });
    }
    if (updates.length > MAX_UPDATES_PER_REQUEST) {
      return json(req, 400, { error: `At most ${MAX_UPDATES_PER_REQUEST} updates per request.` });
    }
    if (deleteIds.length > 8) {
      return json(req, 400, { error: "At most 8 deletes per request." });
    }

    const now = new Date().toISOString();
    const results: { id: string; ok: boolean; error?: string }[] = [];
    const deleteResults: { id: string; ok: boolean; error?: string }[] = [];

    for (const delId of deleteIds) {
      const { data: drow, error: dselErr } = await admin
        .from("attribution_leads")
        .select("id, raw_import")
        .eq("id", delId)
        .eq("organization_id", DEMO_ORG_ID)
        .maybeSingle();
      if (dselErr) {
        deleteResults.push({ id: delId, ok: false, error: dselErr.message });
        continue;
      }
      const draw = drow?.raw_import as Record<string, unknown> | undefined;
      if (!drow || draw?.mvp_demo !== true) {
        deleteResults.push({ id: delId, ok: false, error: "not a demo row" });
        continue;
      }
      const { error: delErr } = await admin.from("attribution_leads").delete().eq("id", delId).eq("organization_id", DEMO_ORG_ID);
      if (delErr) {
        deleteResults.push({ id: delId, ok: false, error: delErr.message });
      } else {
        deleteResults.push({ id: delId, ok: true });
      }
    }

    for (const u of updates as Record<string, unknown>[]) {
      const id = typeof u.id === "string" ? u.id.trim() : "";
      if (!id) {
        results.push({ id: "", ok: false, error: "missing id" });
        continue;
      }

      const { data: row, error: selErr } = await admin
        .from("attribution_leads")
        .select("id, raw_import")
        .eq("id", id)
        .eq("organization_id", DEMO_ORG_ID)
        .maybeSingle();

      if (selErr) {
        results.push({ id, ok: false, error: selErr.message });
        continue;
      }
      const raw = row?.raw_import as Record<string, unknown> | undefined;
      if (!row || raw?.mvp_demo !== true) {
        results.push({ id, ok: false, error: "not a demo row" });
        continue;
      }

      const patch: Record<string, unknown> = { updated_at: now };

      const cn = u.company_name !== undefined ? trimStr(u.company_name, MAX_STR) : undefined;
      if (cn !== undefined) patch.company_name = cn;

      const g = u.ga_client_id !== undefined ? trimStr(u.ga_client_id, 256) : undefined;
      if (g !== undefined) patch.ga_client_id = g;

      const sk = u.search_keyword !== undefined ? trimStr(u.search_keyword, MAX_STR) : undefined;
      if (sk !== undefined) patch.search_keyword = sk;

      const utm = u.utm_campaign !== undefined ? trimStr(u.utm_campaign, MAX_STR) : undefined;
      if (utm !== undefined) patch.utm_campaign = utm;

      const pur = optionalBool(u.purchased);
      if (pur !== undefined) patch.purchased = pur;

      const pam = optionalNum(u.purchase_amount);
      if (pam !== undefined) patch.purchase_amount = pam;

      if (u.submitted_at !== undefined) {
        const s = String(u.submitted_at).trim();
        if (s) {
          const d = new Date(s);
          if (!Number.isNaN(d.getTime())) patch.submitted_at = d.toISOString();
        }
      }

      const { error: upErr } = await admin.from("attribution_leads").update(patch).eq("id", id).eq("organization_id", DEMO_ORG_ID);

      if (upErr) {
        results.push({ id, ok: false, error: upErr.message });
      } else {
        results.push({ id, ok: true });
      }
    }

    const failed = results.filter((r) => !r.ok);
    const failedDeletes = deleteResults.filter((r) => !r.ok);

    let insertId: string | undefined;
    if (body.insert && typeof body.insert === "object" && !Array.isArray(body.insert)) {
      const ins = body.insert as Record<string, unknown>;
      const name = trimStr(ins.company_name, MAX_STR) || trimStr(ins.name, MAX_STR);
      if (!name) {
        return json(req, 400, {
          error: "insert.company_name is required.",
          ok: false,
          results,
          deleteResults,
          insertId: null,
        });
      }
      const row = {
        organization_id: DEMO_ORG_ID,
        import_source: "dashboard" as const,
        raw_import: { mvp_demo: true } as Record<string, unknown>,
        company_name: name,
        contact_name: trimStr(ins.contact_name, MAX_STR),
        submitted_at: (() => {
          const s = String(ins.submitted_at ?? ins.dateAdded ?? "").trim();
          if (s) {
            const d = new Date(s);
            if (!Number.isNaN(d.getTime())) return d.toISOString();
          }
          return now;
        })(),
        utm_campaign: trimStr(ins.utm_campaign, MAX_STR),
        ga_client_id: trimStr(ins.ga_client_id, 256),
        search_keyword: trimStr(ins.search_keyword, MAX_STR),
        purchased: Boolean(ins.purchased),
        purchase_amount: Math.max(0, optionalNum(ins.purchase_amount) ?? 0),
        updated_at: now,
      };
      const { data: created, error: insErr } = await admin.from("attribution_leads").insert(row).select("id").maybeSingle();
      if (insErr) {
        return json(req, 400, { ok: false, error: insErr.message, results, deleteResults, insertId: null });
      }
      insertId = created?.id;
    }

    const allOk =
      failed.length === 0 && failedDeletes.length === 0 && (!hasInsert || !!insertId);
    return json(req, allOk ? 200 : 400, {
      ok: allOk,
      results,
      deleteResults,
      insertId: insertId ?? null,
    });
  }

  return json(req, 405, { error: "Use GET or POST." });
});
