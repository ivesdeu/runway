/**
 * Browser CORS for the static dashboard.
 *
 * - Always allow localhost dev ports.
 * - Allow comma-separated extra origins via DASHBOARD_ALLOWED_ORIGINS (e.g. custom apex domain).
 * - Allow common managed HTTPS hosts (Netlify/Vercel/etc.) so previews work without secrets.
 *
 * Endpoints still require a valid Supabase JWT; this only fixes browser preflight (OPTIONS).
 */
function parseAllowedOrigins(): Set<string> {
  const set = new Set<string>();
  set.add("http://localhost:5173");
  set.add("http://127.0.0.1:5173");
  set.add("http://localhost:4173");
  set.add("http://127.0.0.1:4173");
  const raw = Deno.env.get("DASHBOARD_ALLOWED_ORIGINS") ?? "";
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t) set.add(t);
  }
  return set;
}

/** True when Origin is a normal https dashboard host we expect in the wild. */
function isCommonManagedHttpsOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    const h = u.hostname;
    return (
      h.endsWith(".netlify.app") ||
      h.endsWith(".vercel.app") ||
      h.endsWith(".cloudflarepages.dev") ||
      h.endsWith(".pages.dev") ||
      h.endsWith(".github.io") ||
      h.endsWith(".lovable.app")
    );
  } catch {
    return false;
  }
}

function shouldReflectOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = parseAllowedOrigins();
  if (allowed.has(origin)) return true;
  if (isCommonManagedHttpsOrigin(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (origin && shouldReflectOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}
