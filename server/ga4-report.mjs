/**
 * Single boilerplate GA4 Data API (v1beta) report — no per-user customization.
 *
 * Dimensions (fixed order):
 *   sessionSource, sessionMedium, sessionCampaignName,
 *   [sessionGoogleAdsAdGroupName, sessionGoogleAdsKeyword — omitted if the property cannot use Google Ads fields],
 *   sessionManualAdContent, landingPage, date
 *
 * Optional custom dimension (CRM join key): customUser:ga_client_id
 *   → Create in GA4 Admin → Custom definitions → User scope → Parameter name: ga_client_id
 * If the property does not have this dimension yet, we retry without it (clientId will be null).
 *
 * Metrics: sessions, engagedSessions, conversions, totalUsers
 *
 * Swap-in OAuth later: replace BetaAnalyticsDataClient credentials construction with
 * user refresh token / workload identity; this module stays the same.
 */
import { BetaAnalyticsDataClient } from '@google-analytics/data';

/** @param {string} yyyymmdd */
function normalizeDate(yyyymmdd) {
  const s = String(yyyymmdd || '').replace(/-/g, '');
  if (s.length === 8) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return String(yyyymmdd || '');
}

const BASE_DIMENSIONS_WITH_ADS_KEYWORD = [
  { name: 'sessionSource' },
  { name: 'sessionMedium' },
  { name: 'sessionCampaignName' },
  { name: 'sessionGoogleAdsAdGroupName' },
  { name: 'sessionGoogleAdsKeyword' },
  { name: 'sessionManualAdContent' },
  { name: 'landingPage' },
  { name: 'date' },
];

/** Same as above but without Google Ads session fields (some properties return INVALID_ARGUMENT without Ads linking). */
const BASE_DIMENSIONS_NO_ADS_KEYWORD = [
  { name: 'sessionSource' },
  { name: 'sessionMedium' },
  { name: 'sessionCampaignName' },
  { name: 'sessionManualAdContent' },
  { name: 'landingPage' },
  { name: 'date' },
];

const JOIN_DIMENSION = { name: 'customUser:ga_client_id' };

const METRICS = [
  { name: 'sessions' },
  { name: 'engagedSessions' },
  { name: 'conversions' },
  { name: 'totalUsers' },
];

/**
 * Flatten gRPC / google-gax error details (err.message is often just "3 INVALID_ARGUMENT: ").
 * @param {unknown} err
 * @returns {string}
 */
export function formatGoogleDataApiError(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (typeof err === 'string') return err;
  if (err.message) parts.push(String(err.message));
  if (Array.isArray(err.details)) {
    for (const d of err.details) {
      if (typeof d === 'string') {
        parts.push(d);
        continue;
      }
      if (d && typeof d === 'object') {
        if (d.message) parts.push(String(d.message));
        if (Array.isArray(d.fieldViolations)) {
          for (const fv of d.fieldViolations) {
            if (fv && fv.description) parts.push(String(fv.description));
            if (fv && fv.field) parts.push(`(${String(fv.field)})`);
          }
        }
      }
    }
  }
  const out = parts.filter(Boolean).join(' | ').trim();
  return out || String(err);
}

/**
 * Includes transport fields that often contain the real cause when `message` is empty.
 * @param {unknown} err
 * @returns {string}
 */
export function formatGoogleDataApiErrorVerbose(err) {
  const base = formatGoogleDataApiError(err);
  if (!err || typeof err !== 'object') return base;
  const extra = [];
  if (err.code != null) extra.push(`code=${String(err.code)}`);
  if (err.status != null) extra.push(`status=${String(err.status)}`);
  if (err.reason != null) extra.push(`reason=${String(err.reason)}`);
  if (err.note != null) extra.push(`note=${String(err.note)}`);
  try {
    if (Array.isArray(err.errors) && err.errors.length) {
      extra.push(
        'errors=' +
          JSON.stringify(
            err.errors.map((e) => ({
              message: e && e.message,
              reason: e && e.reason,
              domain: e && e.domain,
              location: e && e.location,
              locationType: e && e.locationType,
            }))
          )
      );
    }
  } catch (_) {}
  return [base].concat(extra).filter(Boolean).join(' | ');
}

/**
 * Minimal auth/property verification (does not depend on custom dimensions or Ads-linked fields).
 * @param {object} serviceAccountJson
 * @param {string} propertyId
 * @param {string} startDate
 * @param {string} endDate
 */
export async function runGa4SmokeTest(serviceAccountJson, propertyId, startDate, endDate) {
  const client = new BetaAnalyticsDataClient({ credentials: serviceAccountJson });
  const property = `properties/${propertyId}`;
  try {
    await client.runReport({
      property,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      limit: 1,
    });
  } catch (err) {
    throw new Error(formatGoogleDataApiErrorVerbose(err));
  }
}

/** @param {unknown} err */
function isRetryableDimensionOrRequestLayoutError(err) {
  const code = Number(err && err.code);
  // Do not retry auth / missing resource errors.
  if (code === 7 || code === 16) return false;
  if (code === 5) return false;
  const text = formatGoogleDataApiError(err);
  const u = text.toUpperCase();
  if (u.includes('PERMISSION_DENIED')) return false;
  if (u.includes('NOT_FOUND')) return false;
  if (code === 3 || u.includes('INVALID_ARGUMENT')) return true;
  if (u.includes('CUSTOMUSER:GA_CLIENT_ID') || u.includes('COULD NOT FIND') || u.includes('UNKNOWN DIMENSION')) return true;
  return false;
}

/**
 * @param {string[]} dv
 * @param {boolean} usedGoogleAdsKeyword
 * @param {boolean} usedClientIdDimension
 */
function pickDimensionFields(dv, usedGoogleAdsKeyword, usedClientIdDimension) {
  if (usedGoogleAdsKeyword && usedClientIdDimension) {
    return {
      source: dv[0] || '',
      medium: dv[1] || '',
      campaign: dv[2] || '',
      adGroup: dv[3] || '',
      keyword: dv[4] || '',
      adContent: dv[5] || '',
      landingPage: dv[6] || '',
      dateRaw: dv[7] || '',
      clientIdRaw: dv[8] != null ? dv[8] : null,
    };
  }
  if (usedGoogleAdsKeyword && !usedClientIdDimension) {
    return {
      source: dv[0] || '',
      medium: dv[1] || '',
      campaign: dv[2] || '',
      adGroup: dv[3] || '',
      keyword: dv[4] || '',
      adContent: dv[5] || '',
      landingPage: dv[6] || '',
      dateRaw: dv[7] || '',
      clientIdRaw: null,
    };
  }
  if (!usedGoogleAdsKeyword && usedClientIdDimension) {
    return {
      source: dv[0] || '',
      medium: dv[1] || '',
      campaign: dv[2] || '',
      adGroup: '',
      keyword: '',
      adContent: dv[3] || '',
      landingPage: dv[4] || '',
      dateRaw: dv[5] || '',
      clientIdRaw: dv[6] != null ? dv[6] : null,
    };
  }
  return {
    source: dv[0] || '',
    medium: dv[1] || '',
    campaign: dv[2] || '',
    adGroup: '',
    keyword: '',
    adContent: dv[3] || '',
    landingPage: dv[4] || '',
    dateRaw: dv[5] || '',
    clientIdRaw: null,
  };
}

/**
 * @param {object} serviceAccountJson
 * @param {string} propertyId numeric
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {Promise<{ rows: object[], usedClientIdDimension: boolean, usedGoogleAdsKeywordDimension: boolean }>}
 */
export async function runStandardAttributionReport(serviceAccountJson, propertyId, startDate, endDate) {
  const client = new BetaAnalyticsDataClient({ credentials: serviceAccountJson });
  const property = `properties/${propertyId}`;

  const attempts = [
    { usedGoogleAdsKeyword: true, usedClientIdDimension: true },
    { usedGoogleAdsKeyword: true, usedClientIdDimension: false },
    { usedGoogleAdsKeyword: false, usedClientIdDimension: true },
    { usedGoogleAdsKeyword: false, usedClientIdDimension: false },
  ];

  /** @type {unknown} */
  let response = null;
  let flags = attempts[0];
  let lastErr = null;

  for (const att of attempts) {
    const base = att.usedGoogleAdsKeyword ? BASE_DIMENSIONS_WITH_ADS_KEYWORD : BASE_DIMENSIONS_NO_ADS_KEYWORD;
    const dimensions = att.usedClientIdDimension ? [...base, JOIN_DIMENSION] : base;
    try {
      const [r] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate }],
        dimensions,
        metrics: METRICS,
      });
      response = r;
      flags = att;
      break;
    } catch (err) {
      lastErr = err;
      if (!isRetryableDimensionOrRequestLayoutError(err)) {
        throw new Error(formatGoogleDataApiError(err));
      }
    }
  }

  if (!response) {
    throw new Error(formatGoogleDataApiError(lastErr));
  }

  const rows = [];
  const { usedGoogleAdsKeyword: usedKw, usedClientIdDimension: usedClient } = flags;

  for (const row of response.rows || []) {
    const dv = (row.dimensionValues || []).map((v) => (v && v.value != null ? String(v.value) : ''));
    const mv = (row.metricValues || []).map((v) => (v && v.value != null ? String(v.value) : '0'));

    const mNum = (i) => {
      const n = parseFloat(mv[i] != null ? mv[i] : '0');
      return Number.isFinite(n) ? n : 0;
    };

    const { source, medium, campaign, adGroup, keyword, adContent, landingPage, dateRaw, clientIdRaw } = pickDimensionFields(
      dv,
      usedKw,
      usedClient
    );

    rows.push({
      date: normalizeDate(dateRaw),
      source,
      medium,
      campaign,
      adGroup,
      keyword,
      adContent,
      landingPage,
      sessions: mNum(0),
      engagedSessions: mNum(1),
      conversions: mNum(2),
      totalUsers: mNum(3),
      clientId: clientIdRaw && String(clientIdRaw).trim() ? String(clientIdRaw).trim() : null,
    });
  }

  return {
    rows,
    usedClientIdDimension: usedClient,
    usedGoogleAdsKeywordDimension: usedKw,
  };
}
