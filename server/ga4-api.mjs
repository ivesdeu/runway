/**
 * Minimal Express API for GA4 Data API — credentials stay server-side only.
 *
 * Endpoints:
 *   POST /api/ga4/connect  — { organizationId, propertyId, credentials } | { organizationId, disconnect: true }
 *   GET  /api/ga4/status
 *   GET  /api/ga4/report   — ?organizationId=&startDate=&endDate= (YYYY-MM-DD), default last 30 days
 *
 * Static hosting: serves repo root + ./public so one process can run dashboard + API.
 *
 * Auth note: GA4 Data API `runReport` is documented to require OAuth scopes or a
 * service account — not "Measurement ID + Measurement Protocol secret" (those
 * are write-only). A bare Google Cloud "API key" query param is not a supported
 * substitute for private property reads in Google's current docs.
 *
 * Future integration slots:
 *   - POST /api/crm/sync — will push { name, email, leadStatus, clientId, campaignId, keyword }
 *   - POST /api/salesforce/connect — OAuth + REST; join on Lead.custom ga_client_id
 */
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GoogleAuth } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';
import {
  readConfig,
  writeConfig,
  clearConfig,
  readPublicStatus,
  updateLastSynced,
  CONFIG_PATH,
} from './ga4-store.mjs';
import { runStandardAttributionReport, runGa4SmokeTest, formatGoogleDataApiErrorVerbose } from './ga4-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

const DEV_EMAIL = 'contact@ivesdeu.com';

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function envOrNull(k) {
  const v = process.env[k];
  return v && String(v).trim() ? String(v).trim() : null;
}

function requireSupabaseEnv(res) {
  const url = envOrNull('SUPABASE_URL') || envOrNull('VITE_SUPABASE_URL');
  const anon = envOrNull('SUPABASE_ANON_KEY') || envOrNull('VITE_SUPABASE_ANON_KEY');
  const service = envOrNull('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anon || !service) {
    res.status(500).json({
      ok: false,
      error:
        'Missing server env: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY), SUPABASE_SERVICE_ROLE_KEY. Set them and restart the API server.',
    });
    return null;
  }
  return { url, anon, service };
}

async function requireDeveloper(req, res) {
  const env = requireSupabaseEnv(res);
  if (!env) return null;

  const authHeader = String(req.headers.authorization || '').trim();
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ ok: false, error: 'Missing Authorization bearer token' });
    return null;
  }

  const userClient = createClient(env.url, env.anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ ok: false, error: 'Invalid session' });
    return null;
  }

  const email = normalizeEmail(data.user.email);
  if (email !== DEV_EMAIL) {
    res.status(403).json({ ok: false, error: 'Developer access only' });
    return null;
  }

  const adminClient = createClient(env.url, env.service, { auth: { persistSession: false, autoRefreshToken: false } });
  return { adminClient, user: data.user };
}

function generateTempPassword() {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const all = lower + upper + digits;

  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  const chars = [pick(lower), pick(upper), pick(digits)];
  while (chars.length < 15) chars.push(pick(all));

  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

app.post('/api/manager', async (req, res) => {
  try {
    const ctx = await requireDeveloper(req, res);
    if (!ctx) return;

    const action = String(req.body?.action || '').trim();
    const admin = ctx.adminClient;

    if (action === 'list_orgs') {
      const { data, error } = await admin
        .from('organizations')
        .select('id,name,slug,admin_email,created_at,organization_members(count)')
        .order('created_at', { ascending: false });
      if (error) return res.status(400).json({ ok: false, error: error.message });

      const orgs = (data || []).map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        admin_email: o.admin_email,
        created_at: o.created_at,
        member_count:
          Array.isArray(o.organization_members) && o.organization_members[0] ? o.organization_members[0].count : 0,
      }));
      return res.json({ ok: true, orgs });
    }

    if (action === 'org_members') {
      const organizationId = String(req.body?.organizationId || '').trim();
      if (!organizationId) return res.status(400).json({ ok: false, error: 'organizationId is required' });

      const { data, error } = await admin
        .from('organization_members')
        .select('user_id,role,created_at,profiles:profiles(email,full_name)')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: true });
      if (error) return res.status(400).json({ ok: false, error: error.message });

      const members = (data || []).map((m) => ({
        user_id: m.user_id,
        role: m.role,
        created_at: m.created_at,
        email: m.profiles?.email || null,
        full_name: m.profiles?.full_name || null,
      }));
      return res.json({ ok: true, members });
    }

    if (action === 'create_org') {
      const name = String(req.body?.name || '').trim();
      const slug = String(req.body?.slug || '').trim();
      const adminEmail = normalizeEmail(req.body?.adminEmail);
      if (!name) return res.status(400).json({ ok: false, error: 'Organization name is required' });
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(slug)) {
        return res.status(400).json({ ok: false, error: 'Slug must be lowercase (a-z0-9-), 3–63 chars.' });
      }
      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(adminEmail)) {
        return res.status(400).json({ ok: false, error: 'Admin email is invalid' });
      }

      const { data: org, error: orgErr } = await admin
        .from('organizations')
        .insert({ name, slug, admin_email: adminEmail })
        .select('id,name,slug,admin_email')
        .single();
      if (orgErr) return res.status(400).json({ ok: false, error: orgErr.message });

      const tempPassword = generateTempPassword();

      // Try to find existing auth user by email; if not found, create.
      let userId = null;
      const { data: usersRes, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (!listErr && usersRes?.users) {
        const match = usersRes.users.find((u) => normalizeEmail(u.email) === adminEmail);
        if (match) userId = match.id;
      }

      if (!userId) {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email: adminEmail,
          password: tempPassword,
          email_confirm: true,
          user_metadata: { provisioned_by: DEV_EMAIL },
        });
        if (createErr) return res.status(400).json({ ok: false, error: createErr.message });
        userId = created.user.id;
      } else {
        const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password: tempPassword });
        if (updateErr) return res.status(400).json({ ok: false, error: updateErr.message });
      }

      const { error: memberErr } = await admin
        .from('organization_members')
        .upsert({ organization_id: org.id, user_id: userId, role: 'admin' }, { onConflict: 'organization_id,user_id' });
      if (memberErr) return res.status(400).json({ ok: false, error: memberErr.message });

      const { error: secErr } = await admin
        .from('user_security')
        .upsert({ user_id: userId, must_change_password: true }, { onConflict: 'user_id' });
      if (secErr) return res.status(400).json({ ok: false, error: secErr.message });

      return res.json({ ok: true, organization: org, userId, temporaryPassword: tempPassword });
    }

    if (action === 'invite_user') {
      const organizationId = String(req.body?.organizationId || '').trim();
      const email = normalizeEmail(req.body?.email);
      const role = String(req.body?.role || 'member').trim() || 'member';
      if (!organizationId) return res.status(400).json({ ok: false, error: 'organizationId is required' });
      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Email is invalid' });
      if (role !== 'admin' && role !== 'member') return res.status(400).json({ ok: false, error: 'Role must be admin or member' });

      const tempPassword = generateTempPassword();

      let userId = null;
      const { data: usersRes, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (!listErr && usersRes?.users) {
        const match = usersRes.users.find((u) => normalizeEmail(u.email) === email);
        if (match) userId = match.id;
      }

      if (!userId) {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
          user_metadata: { provisioned_by: DEV_EMAIL },
        });
        if (createErr) return res.status(400).json({ ok: false, error: createErr.message });
        userId = created.user.id;
      } else {
        const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password: tempPassword });
        if (updateErr) return res.status(400).json({ ok: false, error: updateErr.message });
      }

      const { error: memberErr } = await admin
        .from('organization_members')
        .upsert({ organization_id: organizationId, user_id: userId, role }, { onConflict: 'organization_id,user_id' });
      if (memberErr) return res.status(400).json({ ok: false, error: memberErr.message });

      const { error: secErr } = await admin
        .from('user_security')
        .upsert({ user_id: userId, must_change_password: true }, { onConflict: 'user_id' });
      if (secErr) return res.status(400).json({ ok: false, error: secErr.message });

      return res.json({ ok: true, userId, email, role, temporaryPassword: tempPassword });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || 'manager api failed' });
  }
});

function isValidPropertyId(id) {
  return /^\d{6,}$/.test(String(id || '').trim());
}

function getOrganizationId(req) {
  const v = String((req.body && req.body.organizationId) || req.query.organizationId || '').trim();
  if (!/^[a-zA-Z0-9-]{6,80}$/.test(v)) return null;
  return v;
}

function assertServiceAccount(obj) {
  if (!obj || typeof obj !== 'object') return 'credentials must be a JSON object';
  if (!obj.client_email || typeof obj.client_email !== 'string') return 'missing client_email';
  if (!obj.private_key || typeof obj.private_key !== 'string') return 'missing private_key';
  return null;
}

async function fetchPropertyDisplayName(propertyId, credentials) {
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) throw new Error('Could not obtain access token for Admin API');

  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Admin API ${res.status}: ${t.slice(0, 400)}`);
  }
  const j = await res.json();
  return j.displayName || j.name || `Property ${propertyId}`;
}

app.get('/api/ga4/status', async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return res.status(400).json({ error: 'organizationId is required' });
    const s = await readPublicStatus(organizationId);
    res.json(s);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'status failed' });
  }
});

app.post('/api/ga4/connect', async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return res.status(400).json({ success: false, error: 'organizationId is required' });

    if (req.body && req.body.disconnect === true) {
      await clearConfig(organizationId);
      return res.json({ success: true, disconnected: true });
    }

    const propertyId = String(req.body?.propertyId || '').trim();
    const credentials = req.body?.credentials;

    if (!isValidPropertyId(propertyId)) {
      return res.status(400).json({ success: false, error: 'Invalid GA4 Property ID (digits only, e.g. 123456789).' });
    }

    const err = assertServiceAccount(credentials);
    if (err) {
      return res.status(400).json({ success: false, error: err });
    }

    const saEmail = String(credentials.client_email || '').trim();
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7);
    const fmt = (d) => d.toISOString().slice(0, 10);

    // Validate with a minimal Data API query first. This avoids false negatives caused by
    // optional attribution dimensions that may be unsupported on some properties.
    try {
      await runGa4SmokeTest(credentials, propertyId, fmt(start), fmt(end));
    } catch (e) {
      const detail = formatGoogleDataApiErrorVerbose(e);
      return res.status(400).json({
        success: false,
        error:
          'Could not read GA4 data for this Property ID. Confirm the ID is the numeric GA4 property (not a Measurement ID). ' +
          'In GA4 → Admin → Property access management, invite ' +
          (saEmail ? `this service account (${saEmail}) ` : 'the service account from your JSON ') +
          'with Viewer or Analyst on this property. In Google Cloud (the project that owns the service account) enable the Google Analytics Data API (APIs & Services → Library). ' +
          detail,
      });
    }

    let propertyName = `Property ${propertyId}`;
    try {
      propertyName = await fetchPropertyDisplayName(propertyId, credentials);
    } catch (e) {
      console.warn('GA4 connect: Admin API display name skipped (connection still works):', e.message || e);
    }

    await writeConfig(organizationId, {
      propertyId,
      propertyName,
      serviceAccountJson: credentials,
      lastSyncedAt: null,
    });

    res.json({ success: true, propertyName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message || 'connect failed' });
  }
});

app.get('/api/ga4/report', async (req, res) => {
  try {
    const organizationId = getOrganizationId(req);
    if (!organizationId) return res.status(400).json({ error: 'organizationId is required' });
    const c = await readConfig(organizationId);
    if (!c || !c.serviceAccountJson) {
      return res.status(400).json({ error: 'GA4 not connected' });
    }

    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);
    const fmt = (d) => d.toISOString().slice(0, 10);

    let startDate = String(req.query.startDate || '').trim();
    let endDate = String(req.query.endDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) startDate = fmt(start);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) endDate = fmt(end);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'startDate must be on or before endDate' });
    }

    const { rows, usedClientIdDimension, usedGoogleAdsKeywordDimension } = await runStandardAttributionReport(
      c.serviceAccountJson,
      c.propertyId,
      startDate,
      endDate
    );

    await updateLastSynced(organizationId, new Date().toISOString());

    res.json({ rows, usedClientIdDimension, usedGoogleAdsKeywordDimension, startDate, endDate });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'report failed' });
  }
});

app.use(express.static(join(ROOT, 'public')));
app.use(express.static(ROOT));

app.listen(PORT, () => {
  console.log(`GA4 API + static → http://127.0.0.1:${PORT}`);
  console.log(`Config directory (per-org): ${CONFIG_PATH}`);
});
