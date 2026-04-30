/**
 * Server-side persistence for GA4 connection (service account + property).
 * Never expose credentials to the browser — only this process reads/writes this file.
 *
 * Future: swap to env-only (GA4_PROPERTY_ID + GOOGLE_APPLICATION_CREDENTIALS path)
 * or a secrets manager; same read/write interface can be wrapped.
 */
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CONFIGS_DIR = join(DATA_DIR, 'ga4-configs');
const LEGACY_CONFIG_PATH = join(DATA_DIR, 'ga4-config.json');
export const CONFIG_PATH = CONFIGS_DIR;

/** @typedef {{ propertyId: string, propertyName: string, serviceAccountJson: object, lastSyncedAt: string | null }} Ga4Config */

function sanitizeOrgId(orgId) {
  const s = String(orgId || '').trim();
  if (!/^[a-zA-Z0-9-]{6,80}$/.test(s)) return null;
  return s;
}

function configPathForOrg(orgId) {
  const safe = sanitizeOrgId(orgId);
  if (!safe) return null;
  return join(CONFIGS_DIR, `${safe}.json`);
}

export async function readConfig(orgId) {
  const path = configPathForOrg(orgId);
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o.propertyId !== 'string' || !o.serviceAccountJson) return null;
    return o;
  } catch (e) {
    // One-time compatibility read for legacy single-tenant config.
    if (e && e.code === 'ENOENT') {
      try {
        const rawLegacy = await readFile(LEGACY_CONFIG_PATH, 'utf8');
        const legacy = JSON.parse(rawLegacy);
        if (!legacy || typeof legacy.propertyId !== 'string' || !legacy.serviceAccountJson) return null;
        await writeConfig(orgId, legacy);
        return legacy;
      } catch (le) {
        if (le && le.code === 'ENOENT') return null;
        throw le;
      }
    }
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Public subset for GET /api/ga4/status */
export async function readPublicStatus(orgId) {
  const c = await readConfig(orgId);
  if (!c) {
    return { connected: false, propertyId: null, propertyName: null, lastSyncedAt: null };
  }
  return {
    connected: true,
    propertyId: c.propertyId,
    propertyName: c.propertyName || null,
    lastSyncedAt: c.lastSyncedAt || null,
  };
}

/** @param {Ga4Config} config */
export async function writeConfig(orgId, config) {
  const path = configPathForOrg(orgId);
  if (!path) throw new Error('Invalid organizationId');
  await mkdir(CONFIGS_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
}

export async function clearConfig(orgId) {
  const path = configPathForOrg(orgId);
  if (!path) return;
  try {
    await unlink(path);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
}

export async function updateLastSynced(orgId, iso) {
  const c = await readConfig(orgId);
  if (!c) return;
  c.lastSyncedAt = iso;
  await writeConfig(orgId, c);
}
