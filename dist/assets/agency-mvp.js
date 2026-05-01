/**
 * Lead & Campaign Performance Dashboard — MVP.
 * Lead rows backed by Supabase `attribution_leads` (and CRM rows by `clients`) when signed in;
 * demo workspace writes via Edge `agency-mvp-demo-leads` POST. localStorage is a UI/cache hint only.
 * GA4 Data API runs only on the server (`npm start` / server/ga4-api.mjs). The browser calls /api/ga4/*.
 *
 * Future hooks:
 *   - Internal CRM: same clientId as GA4 ga_client_id; populate leads from POST /api/crm/sync (TBD).
 *   - Salesforce: Lead custom field ga_client_id → join to runtimeGa4Rows (TBD).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'agency-mvp-state:v1';
  var CRM_SOURCE_KEY = 'agency-mvp-crm-source:v1';
  var UPLOAD_LEADS_KEY = 'agency-mvp-uploaded-leads:v1';
  var DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';

  function scopedUploadLeadsKey() {
    return UPLOAD_LEADS_KEY + ':' + activeUserId() + ':' + activeOrgId();
  }

  function loadUploadedPayload() {
    try {
      var raw = localStorage.getItem(scopedUploadLeadsKey());
      if (!raw) return { leads: [], campaigns: [] };
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { leads: parsed, campaigns: [] };
      if (parsed && Array.isArray(parsed.leads)) {
        return {
          leads: parsed.leads,
          campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
        };
      }
      return { leads: [], campaigns: [] };
    } catch (_) {
      return { leads: [], campaigns: [] };
    }
  }

  function loadUploadedLeads() {
    return loadUploadedPayload().leads;
  }

  function persistUploadedLeads(leads, allCampaigns) {
    var up = (leads || []).filter(function (l) {
      return l && (l.recordSource === 'import' || l.recordSource === 'manual');
    });
    var need = {};
    up.forEach(function (l) {
      if (l && l.campaignId) need[l.campaignId] = true;
    });
    var camps = (allCampaigns || []).filter(function (c) {
      return c && need[c.id];
    });
    try {
      if (up.length > 0) {
        localStorage.setItem(
          scopedUploadLeadsKey(),
          JSON.stringify({ leads: up, campaigns: camps })
        );
      } else {
        localStorage.removeItem(scopedUploadLeadsKey());
      }
    } catch (_) {}
  }

  function campaignsReferencedByLeads(leads, allCampaigns) {
    var need = {};
    (leads || []).forEach(function (l) {
      if (l && l.campaignId) need[l.campaignId] = true;
    });
    return (allCampaigns || []).filter(function (c) {
      return c && need[c.id];
    });
  }

  function stateFromUploadedLeadsOnly(prevState) {
    var payload = loadUploadedPayload();
    var up = payload.leads;
    if (!up.length) return emptyState();
    var pool = (payload.campaigns || []).concat((prevState && prevState.campaigns) || []);
    var camps = campaignsReferencedByLeads(up, pool);
    return { campaigns: camps, leads: up };
  }

  var leadModalContext = { lead: null, isNew: false };
  var gaClientIdWizardStep = 0;
  var CHANNELS = ['Google Ads', 'Meta', 'SEO', 'Email', 'Direct', 'Other'];

  /** Last GET /api/ga4/report rows (normalized). Not persisted — refetch via Sync. */
  var runtimeGa4Rows = null;
  var runtimeGa4Meta = { usedClientIdDimension: false, startDate: null, endDate: null };
  /** Mirrors GET /api/ga4/status (no secrets). */
  var ga4ServerConnected = false;
  var ga4StatusSnapshot = { propertyId: null, propertyName: null, lastSyncedAt: null };
  /** Client-side throttle: refetch GA4 report if data missing or older than this (ms). */
  var GA4_STALE_MS = 60 * 60 * 1000;
  var ga4ClientLastFetchAt = 0;
  var ga4ReportInFlight = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatProvisionedOrgHtml(j) {
    var org = (j && j.organization) || {};
    var orgId = org.id || '';
    var orgSlug = org.slug || '';
    var adminEmail = org.admin_email || '';
    var pw = (j && j.temporaryPassword) || '';
    return (
      '<div class="card" style="margin-top:10px;padding:12px 12px;border-radius:12px;border:1px solid var(--border);background:var(--panel);">' +
        '<div class="st" style="margin:0 0 8px 0;">Provisioning details</div>' +
        '<div style="display:grid;gap:8px;font-size:12px;color:var(--text2);">' +
          '<div><span class="kb" style="font-size:11px;padding:2px 8px;border-radius:999px;">Org</span> ' +
            '<code style="font-size:11px;">' + escapeHtml(orgSlug) + '</code>' +
            '<div class="td-sub" style="margin-top:4px;"><code style="font-size:11px;">' + escapeHtml(orgId) + '</code></div>' +
          '</div>' +
          '<div><span class="kb" style="font-size:11px;padding:2px 8px;border-radius:999px;">Admin</span> ' +
            '<span style="color:var(--text);">' + escapeHtml(adminEmail) + '</span></div>' +
          '<div><span class="kb bu" style="font-size:11px;padding:2px 8px;border-radius:999px;">Temp password</span> ' +
            '<code data-temp-pw style="font-size:12px;letter-spacing:0.02em;">' + escapeHtml(pw || '—') + '</code>' +
            '<button type="button" class="btn" data-fetch-temp-pw="1" data-fetch-org-id="' + escapeHtml(orgId) + '" data-fetch-email="' + escapeHtml(adminEmail) + '" style="margin-left:10px;padding:6px 10px;font-size:12px;">Fetch last</button>' +
            '<div style="margin-top:6px;color:var(--text3);font-size:11px;line-height:1.35;">' +
              'Share this once. On first login, they will be prompted to set a new password.' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function formatProvisionedInviteHtml(email, pw) {
    return (
      '<div class="card" style="margin-top:10px;padding:12px 12px;border-radius:12px;border:1px solid var(--border);background:var(--panel);">' +
        '<div class="st" style="margin:0 0 8px 0;">Invite credentials</div>' +
        '<div style="display:grid;gap:8px;font-size:12px;color:var(--text2);">' +
          '<div><span class="kb" style="font-size:11px;padding:2px 8px;border-radius:999px;">Email</span> ' +
            '<span style="color:var(--text);">' + escapeHtml(email) + '</span></div>' +
          '<div><span class="kb bu" style="font-size:11px;padding:2px 8px;border-radius:999px;">Temp password</span> ' +
            '<code data-temp-pw style="font-size:12px;letter-spacing:0.02em;">' + escapeHtml(pw || '—') + '</code>' +
            '<button type="button" class="btn" data-fetch-temp-pw="1" data-fetch-email="' + escapeHtml(email) + '" style="margin-left:10px;padding:6px 10px;font-size:12px;">Fetch last</button>' +
            '<div style="margin-top:6px;color:var(--text3);font-size:11px;line-height:1.35;">' +
              'Share this once. On first login, they will be prompted to set a new password.' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function wireFetchTempPasswordButtons(container) {
    if (!container) return;
    container.querySelectorAll('button[data-fetch-temp-pw="1"]').forEach(function (b) {
      if (b.getAttribute('data-wired') === '1') return;
      b.setAttribute('data-wired', '1');
      b.addEventListener('click', function () {
        var orgId = b.getAttribute('data-fetch-org-id') || '';
        var email = (b.getAttribute('data-fetch-email') || '').trim();
        if (!orgId || !email) return;
        b.disabled = true;
        var prev = b.textContent;
        b.textContent = 'Fetching…';
        fetchDevAdmin({ action: 'get_latest_credentials', organizationId: orgId, email: email })
          .then(function (j) {
            var pw = j && j.temporaryPassword ? String(j.temporaryPassword) : '';
            var code = container.querySelector('code[data-temp-pw]');
            if (code) code.textContent = pw || '—';
          })
          .catch(function () {})
          .finally(function () {
            b.disabled = false;
            b.textContent = prev || 'Fetch last';
          });
      });
    });
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function activeUserId() {
    var u = window.currentUser || null;
    return u && u.id ? String(u.id) : 'guest';
  }

  function activeOrgId() {
    var oid = window.currentOrganizationId;
    return oid && String(oid).trim() ? String(oid).trim() : 'noorg';
  }

  function scopedStorageKey() {
    return STORAGE_KEY + ':' + activeUserId() + ':' + activeOrgId();
  }

  function scopedCrmSourceKey() {
    return CRM_SOURCE_KEY + ':' + activeUserId() + ':' + activeOrgId();
  }

  function isDemoUser() {
    var u = window.currentUser || null;
    var demo = window.DEMO_DASHBOARD_USER_ID || DEMO_USER_ID;
    return !!(u && u.id && String(u.id) === String(demo));
  }

  function loadCrmSource() {
    try {
      var raw = localStorage.getItem(scopedCrmSourceKey());
      var v = String(raw || '').trim().toLowerCase();
      if (v === 'internal' || v === 'salesforce') return v;
    } catch (_) {}
    return 'none';
  }

  function saveCrmSource(v) {
    var next = String(v || '').trim().toLowerCase();
    if (next !== 'internal' && next !== 'salesforce') next = 'none';
    crmSource = next;
    try {
      localStorage.setItem(scopedCrmSourceKey(), crmSource);
    } catch (_) {}
  }

  function apiBase() {
    var m = document.querySelector('meta[name="agency-api-base"]');
    var v = m && m.getAttribute('content');
    if (v != null && String(v).trim() !== '') return String(v).trim().replace(/\/$/, '');
    return '';
  }

  function apiUrl(path) {
    var p = String(path || '');
    if (/^https?:\/\//i.test(p)) return p;
    var b = apiBase();
    return b ? b + p : p;
  }

  function currentOrganizationId() {
    var oid = window.currentOrganizationId;
    return oid && String(oid).trim() ? String(oid).trim() : '';
  }

  function fetchJson(path, opts) {
    return fetch(apiUrl(path), Object.assign({ credentials: 'omit' }, opts || {})).then(function (res) {
      return res.text().then(function (text) {
        var j = null;
        try {
          j = text ? JSON.parse(text) : null;
        } catch (_) {}
        if (!res.ok) {
          var msg = (j && (j.error || j.message)) || text || res.statusText || 'Request failed';
          throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
        return j;
      });
    });
  }

  function fmtMoney(n) {
    if (n == null || n === '' || !isFinite(Number(n))) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) {
      return iso;
    }
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_) {
      return String(iso);
    }
  }

  function defaultGa4Range() {
    var end = new Date();
    var start = new Date();
    start.setDate(end.getDate() - 30);
    var fmt = function (d) {
      return d.toISOString().slice(0, 10);
    };
    return { start: fmt(start), end: fmt(end) };
  }

  function normalizeGaClientId(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (/^\d+\.\d+$/.test(s)) return s;
    var m = s.match(/(\d+\.\d+)$/);
    return m ? m[1] : s;
  }

  /**
   * @param {string|null|undefined} clientId CRM / lead ga_client_id
   * @param {object[]} ga4Report normalized rows from GET /api/ga4/report
   * @returns {object|null} aggregated session row for detail UI
   */
  function getSessionDataForClient(clientId, ga4Report) {
    if (!clientId || !ga4Report || !ga4Report.length) return null;
    var cid = normalizeGaClientId(clientId);
    if (!cid) return null;
    var matches = ga4Report.filter(function (r) {
      return r && normalizeGaClientId(r.clientId) === cid;
    });
    if (!matches.length) return null;
    var best = matches[0];
    var maxS = Number(best.sessions) || 0;
    var agg = {
      date: null,
      source: '',
      medium: '',
      campaign: '',
      adGroup: '',
      keyword: '',
      adContent: '',
      landingPage: '',
      sessions: 0,
      engagedSessions: 0,
      conversions: 0,
      totalUsers: 0,
      clientId: cid,
    };
    matches.forEach(function (r) {
      agg.sessions += Number(r.sessions) || 0;
      agg.engagedSessions += Number(r.engagedSessions) || 0;
      agg.conversions += Number(r.conversions) || 0;
      agg.totalUsers += Number(r.totalUsers) || 0;
      var s = Number(r.sessions) || 0;
      if (s > maxS) {
        maxS = s;
        best = r;
      }
    });
    agg.source = best.source || '';
    agg.medium = best.medium || '';
    agg.campaign = best.campaign || '';
    agg.adGroup = best.adGroup || '';
    agg.keyword = best.keyword || '';
    agg.adContent = best.adContent || '';
    agg.landingPage = best.landingPage || '';
    agg.date = best.date || null;
    return agg;
  }

  window.getSessionDataForClient = getSessionDataForClient;

  function ga4TotalsForCampaignName(campaignName, ga4Report) {
    if (!campaignName || !ga4Report || !ga4Report.length) return { sessions: null, conversions: null };
    var t = String(campaignName).trim().toLowerCase();
    var sessions = 0;
    var conversions = 0;
    var any = false;
    ga4Report.forEach(function (r) {
      if (String(r.campaign || '').trim().toLowerCase() === t) {
        any = true;
        sessions += Number(r.sessions) || 0;
        conversions += Number(r.conversions) || 0;
      }
    });
    if (!any) return { sessions: null, conversions: null };
    return { sessions: sessions, conversions: conversions };
  }

  function migrateState(o) {
    if (!o || !Array.isArray(o.leads)) return;
    o.leads.forEach(function (l) {
      if (l.clientId === undefined) l.clientId = null;
      if (l.recordSource === undefined) l.recordSource = 'manual';
    });
    delete o.crmConnected;
  }

  /**
   * Demo dataset: campaign names and spend tie directly to the companies on Leads / clients
   * (same fictional brands as the main dashboard mock clients where useful).
   */
  function seedState() {
    var cSaaS = uid('camp');
    var cHealth = uid('camp');
    var cRetail = uid('camp');
    var cFinance = uid('camp');
    var cCreative = uid('camp');
    var cBuilt = uid('camp');

    var leads = [
      { id: uid('lead'), name: 'Aurora Analytics', status: 'closed', paymentAmount: 42000, searchKeyword: 'b2b analytics consulting', clientId: '2918473821.1749283019', campaignId: cSaaS, dateAdded: '2026-01-08' },
      { id: uid('lead'), name: 'Juniper Learning', status: 'lead', paymentAmount: null, searchKeyword: 'edtech marketing agency', clientId: '3019283746.1827364510', campaignId: cSaaS, dateAdded: '2026-02-14' },
      { id: uid('lead'), name: 'Brightline Health', status: 'closed', paymentAmount: 51800, searchKeyword: 'patient acquisition campaigns', clientId: '2847362910.1638472910', campaignId: cHealth, dateAdded: '2026-01-22' },
      { id: uid('lead'), name: 'Copper Kettle Co.', status: 'closed', paymentAmount: 19200, searchKeyword: 'restaurant loyalty program ads', clientId: '2736482910.1928374650', campaignId: cRetail, dateAdded: '2026-02-03' },
      { id: uid('lead'), name: 'Evergreen Supply', status: 'lead', paymentAmount: null, searchKeyword: 'retail inventory forecasting software', clientId: '2658392017.1748392017', campaignId: cRetail, dateAdded: '2026-03-01' },
      { id: uid('lead'), name: 'Greenleaf Farms', status: 'closed', paymentAmount: 11800, searchKeyword: 'ag wholesale digital marketing', clientId: '2583746192.1837461928', campaignId: cRetail, dateAdded: '2026-03-18' },
      { id: uid('lead'), name: 'Harborlight Capital', status: 'closed', paymentAmount: 24600, searchKeyword: 'institutional lp reporting tools', clientId: '2473829103.1928374655', campaignId: cFinance, dateAdded: '2026-02-27' },
      { id: uid('lead'), name: 'Driftwood Studio', status: 'closed', paymentAmount: 33500, searchKeyword: 'brand design agency portfolio', clientId: '2391827364.1748392012', campaignId: cCreative, dateAdded: '2026-01-30' },
      { id: uid('lead'), name: 'Inkwell Publishing', status: 'lead', paymentAmount: null, searchKeyword: 'book launch paid social', clientId: '2319283746.1658392014', campaignId: cCreative, dateAdded: '2026-04-02' },
      { id: uid('lead'), name: 'Falcon Mobility', status: 'lead', paymentAmount: null, searchKeyword: 'fleet telematics advertising', clientId: '2238472910.1928374601', campaignId: cBuilt, dateAdded: '2026-03-09' },
      { id: uid('lead'), name: 'Kindred Robotics', status: 'lead', paymentAmount: null, searchKeyword: 'industrial automation leads', clientId: '2158392736.1837461922', campaignId: cBuilt, dateAdded: '2026-03-25' },
      { id: uid('lead'), name: 'Lumen Architecture', status: 'closed', paymentAmount: 68900, searchKeyword: 'architecture firm lead generation', clientId: '2073829183.1748392008', campaignId: cBuilt, dateAdded: '2026-02-11' },
      { id: uid('lead'), name: 'Summit Finance', status: 'lead', paymentAmount: null, searchKeyword: 'fractional cfo marketing', clientId: null, campaignId: null, dateAdded: '2026-04-10' },
    ];
    leads.forEach(function (l) {
      l.recordSource = 'manual';
    });

    var campaigns = [
      { id: cSaaS, name: 'SaaS & analytics — Search (Aurora, Juniper)', channelType: 'Google Ads', spend: 26800, clientIds: leads.filter(function (l) { return l.campaignId === cSaaS; }).map(function (l) { return l.id; }) },
      { id: cHealth, name: 'Healthcare — Patient growth (Brightline)', channelType: 'Meta', spend: 9400, clientIds: leads.filter(function (l) { return l.campaignId === cHealth; }).map(function (l) { return l.id; }) },
      { id: cRetail, name: 'Retail & farms — Performance Max (Copper, Evergreen, Greenleaf)', channelType: 'Google Ads', spend: 15200, clientIds: leads.filter(function (l) { return l.campaignId === cRetail; }).map(function (l) { return l.id; }) },
      { id: cFinance, name: 'Finance — SEO & trust content (Harborlight)', channelType: 'SEO', spend: 7100, clientIds: leads.filter(function (l) { return l.campaignId === cFinance; }).map(function (l) { return l.id; }) },
      { id: cCreative, name: 'Design & media — Social (Driftwood, Inkwell)', channelType: 'Meta', spend: 11900, clientIds: leads.filter(function (l) { return l.campaignId === cCreative; }).map(function (l) { return l.id; }) },
      { id: cBuilt, name: 'Mobility & built env — LinkedIn ABM (Falcon, Kindred, Lumen)', channelType: 'Other', spend: 16400, clientIds: leads.filter(function (l) { return l.campaignId === cBuilt; }).map(function (l) { return l.id; }) },
    ];
    return { campaigns: campaigns, leads: leads };
  }

  /** Deterministic fake GA4 rows so demo campaign cards show sessions/conversions without OAuth. */
  function seedDemoGa4RuntimeRows() {
    if (!isDemoUser() || !state || !state.campaigns || !state.campaigns.length) return;
    var rows = [];
    state.campaigns.forEach(function (c, i) {
      var s = String(c.id || '') + '|' + String(c.name || '');
      var h = 2166136261;
      for (var j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = (h * 16777619) | 0;
      }
      var base = 1400 + (Math.abs(h) % 900);
      rows.push({
        campaign: c.name,
        sessions: base * 3 + i * 380,
        conversions: Math.floor(base / 5) + 18 + i * 4,
        clientId: '',
        source: 'google',
        medium: 'cpc',
      });
    });
    runtimeGa4Rows = rows;
    ga4ClientLastFetchAt = Date.now();
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(scopedStorageKey());
      if (raw) {
        var o = JSON.parse(raw);
        if (o && Array.isArray(o.leads) && Array.isArray(o.campaigns)) {
          migrateState(o);
          persistUploadedLeads(o.leads, o.campaigns);
          return o;
        }
      }
    } catch (_) {}
    return seedState();
  }

  /** Campaign UI + last hydrated snapshot; cloud source of truth is Supabase after save. */
  function saveState() {
    try {
      localStorage.setItem(scopedStorageKey(), JSON.stringify(state));
      persistUploadedLeads(state.leads, state.campaigns);
    } catch (_) {}
  }

  function saveStateWithoutUploadSync() {
    try {
      localStorage.setItem(scopedStorageKey(), JSON.stringify(state));
    } catch (_) {}
  }

  var state = loadState();
  var crmSource = loadCrmSource();

  function emptyState() {
    return { campaigns: [], leads: [] };
  }

  function buildStateFromClients(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var campaignByName = {};
    var campaigns = [];
    var leads = list
      .filter(function (r) {
        if (!r) return false;
        var cid = (r.ga_client_id != null ? r.ga_client_id : '').toString().trim();
        return !!cid;
      })
      .map(function (r) {
      var campaignName = String((r && r.utm_campaign) || '').trim();
      var campaignId = null;
      if (campaignName) {
        var key = campaignName.toLowerCase();
        if (!campaignByName[key]) {
          campaignByName[key] = uid('camp');
          campaigns.push({
            id: campaignByName[key],
            name: campaignName,
            channelType: 'Other',
            spend: 0,
            clientIds: [],
          });
        }
        campaignId = campaignByName[key];
      }
      var statusText = String((r && r.status) || '').trim();
      var statusLc = statusText.toLowerCase();
      var closedLike = statusLc.indexOf('close') !== -1 || statusLc.indexOf('won') !== -1 || statusLc.indexOf('sale') !== -1;
      var amount = r && r.total_revenue != null ? Number(r.total_revenue) : null;
      var dt = (r && r.created_at) || null;
      var nm = String((r && (r.company_name || r.contact_name || r.email)) || '').trim() || 'Lead';
      var cid = (r && r.ga_client_id != null ? r.ga_client_id : null);
      return {
        id: String((r && r.id) || uid('lead')),
        name: nm,
        status: closedLike ? 'closed' : 'lead',
        paymentAmount: closedLike && isFinite(amount) ? amount : null,
        searchKeyword: null,
        clientId: cid != null ? String(cid).trim() : null,
        campaignId: campaignId,
        dateAdded: dt ? String(dt).slice(0, 10) : new Date().toISOString().slice(0, 10),
      };
    });
    return { campaigns: campaigns, leads: leads };
  }

  function seedCampaignsOnly() {
    var s = seedState();
    return s.campaigns.map(function (c) {
      return { id: c.id, name: c.name, channelType: c.channelType, spend: c.spend, clientIds: [] };
    });
  }

  function mvpPackFromAttributionRows(rows) {
    var campaignByName = {};
    var campaigns = [];
    function resolveCamp(name) {
      if (!name || !String(name).trim()) return null;
      var key = String(name).trim().toLowerCase();
      if (!campaignByName[key]) {
        campaignByName[key] = uid('camp');
        campaigns.push({
          id: campaignByName[key],
          name: String(name).trim(),
          channelType: 'Other',
          spend: 0,
          clientIds: [],
        });
      }
      return campaignByName[key];
    }
    var leads = [];
    (rows || []).forEach(function (row) {
      var purchased = row.purchased === true || Number(row.purchase_amount) > 0;
      var utm = String(row.utm_campaign || '').trim();
      var campaignId = resolveCamp(utm);
      var raw = row.raw_import;
      var demoSeed = raw && (raw.mvp_demo === true || raw.mvp_demo === 'true');
      leads.push({
        id: row.id,
        name: String(row.company_name || row.contact_name || 'Lead').trim(),
        status: purchased ? 'closed' : 'lead',
        paymentAmount: purchased ? Number(row.purchase_amount) || null : null,
        searchKeyword: row.search_keyword || null,
        clientId: row.ga_client_id ? String(row.ga_client_id).trim() : null,
        campaignId: campaignId,
        dateAdded: row.submitted_at ? String(row.submitted_at).slice(0, 10) : new Date().toISOString().slice(0, 10),
        recordSource: 'import',
        attributionLeadId: row.id,
        demoFromDb: !!demoSeed,
        _utmCampaign: utm,
      });
    });
    return { campaigns: campaigns, leads: leads };
  }

  function mergeCrmAndAttribution(crmPack, attrPack) {
    var campaigns = (crmPack.campaigns || []).slice();
    var nameToCamp = {};
    campaigns.forEach(function (c) {
      nameToCamp[String(c.name).toLowerCase()] = c;
    });
    (attrPack.campaigns || []).forEach(function (c) {
      var k = String(c.name).toLowerCase();
      if (nameToCamp[k]) {
        var keep = nameToCamp[k];
        attrPack.leads.forEach(function (l) {
          if (l.campaignId === c.id) l.campaignId = keep.id;
        });
      } else {
        nameToCamp[k] = c;
        campaigns.push(c);
      }
    });
    var crmLeads = (crmPack.leads || []).map(function (l) {
      l.recordSource = 'crm';
      return l;
    });
    return {
      campaigns: campaigns,
      leads: crmLeads.concat(attrPack.leads || []),
    };
  }

  function fetchAttributionLeadsForOrg(supabase, orgId) {
    return supabase
      .from('attribution_leads')
      .select(
        'id,submitted_at,company_name,contact_name,utm_campaign,ga_client_id,search_keyword,purchased,purchase_amount,import_source,raw_import'
      )
      .eq('organization_id', orgId)
      .in('import_source', ['csv', 'dashboard', 'form'])
      .order('submitted_at', { ascending: false })
      .limit(2000)
      .then(function (res) {
        if (res.error) throw res.error;
        return mvpPackFromAttributionRows(res.data || []);
      });
  }

  function attachDemoLeadsToSeedCampaigns(leads, seedCampaigns) {
    var nameToId = {};
    seedCampaigns.forEach(function (c) {
      nameToId[String(c.name).toLowerCase()] = c.id;
    });
    leads.forEach(function (l) {
      var u = (l._utmCampaign || '').trim().toLowerCase();
      if (u && nameToId[u]) l.campaignId = nameToId[u];
      else l.campaignId = null;
      delete l._utmCampaign;
    });
    return leads;
  }

  function loadDemoLeadsFromEdge() {
    var base = window.__bizdashSupabaseUrl;
    var key = window.__bizdashSupabaseAnonKey;
    if (!base) return Promise.reject(new Error('no Supabase URL'));
    var headers = {};
    if (key) {
      headers.Authorization = 'Bearer ' + key;
      headers.apikey = key;
    }
    return fetch(base.replace(/\/$/, '') + '/functions/v1/agency-mvp-demo-leads', {
      method: 'GET',
      headers: headers,
    }).then(function (r) {
      return r.text().then(function (text) {
        var j = null;
        try {
          j = text ? JSON.parse(text) : null;
        } catch (_) {}
        if (!r.ok) {
          throw new Error((j && j.error) || text || 'Demo leads fetch failed');
        }
        return j || {};
      });
    }).then(function (j) {
      var rows = (j && j.rows) || [];
      var pack = mvpPackFromAttributionRows(rows);
      return pack.leads;
    });
  }

  function isLikelyUuid(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''));
  }

  function campaignNameForLead(campaignId) {
    if (!campaignId) return null;
    var c = state.campaigns.find(function (x) {
      return x.id === campaignId;
    });
    return c ? String(c.name).trim() : null;
  }

  function submittedAtIsoFromDateField(dateStr) {
    if (!dateStr) return new Date().toISOString();
    var d = new Date(String(dateStr).trim() + 'T12:00:00.000Z');
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  function mvpRecToAttributionPayload(rec) {
    var closed = rec.status === 'closed';
    var pay =
      closed && rec.paymentAmount != null && isFinite(Number(rec.paymentAmount))
        ? Number(rec.paymentAmount)
        : 0;
    return {
      company_name: rec.name ? String(rec.name).trim() : null,
      utm_campaign: campaignNameForLead(rec.campaignId),
      ga_client_id: rec.clientId ? String(rec.clientId).trim() : null,
      search_keyword: rec.searchKeyword ? String(rec.searchKeyword).trim() : null,
      purchased: closed,
      purchase_amount: pay,
      submitted_at: submittedAtIsoFromDateField(rec.dateAdded),
    };
  }

  function persistSignedInAttributionLead(sb, orgId, rec, prev) {
    var payload = mvpRecToAttributionPayload(rec);
    var now = new Date().toISOString();

    if (prev && prev.recordSource === 'crm') {
      return sb
        .from('clients')
        .update({
          ga_client_id: rec.clientId ? String(rec.clientId).trim() : null,
          utm_campaign: campaignNameForLead(rec.campaignId),
        })
        .eq('id', rec.id)
        .eq('organization_id', orgId)
        .then(function (res) {
          if (res.error) throw res.error;
          return rec.id;
        });
    }

    var idLooksDb = isLikelyUuid(rec.id);
    if (idLooksDb && prev && (prev.recordSource === 'import' || prev.recordSource === 'manual')) {
      var body = {
        company_name: payload.company_name,
        contact_name: null,
        utm_campaign: payload.utm_campaign,
        ga_client_id: payload.ga_client_id,
        search_keyword: payload.search_keyword,
        purchased: payload.purchased,
        purchase_amount: payload.purchase_amount,
        submitted_at: payload.submitted_at,
        updated_at: now,
      };
      return sb
        .from('attribution_leads')
        .update(body)
        .eq('id', rec.id)
        .eq('organization_id', orgId)
        .then(function (res) {
          if (res.error) throw res.error;
          return rec.id;
        });
    }

    var ins = {
      organization_id: orgId,
      company_name: payload.company_name,
      contact_name: null,
      submitted_at: payload.submitted_at,
      utm_campaign: payload.utm_campaign,
      ga_client_id: payload.ga_client_id,
      search_keyword: payload.search_keyword,
      purchased: payload.purchased,
      purchase_amount: payload.purchase_amount,
      import_source: 'dashboard',
      raw_import: {},
      updated_at: now,
    };
    return sb
      .from('attribution_leads')
      .insert(ins)
      .select('id')
      .single()
      .then(function (res) {
        if (res.error) throw res.error;
        var nid = res.data && res.data.id;
        if (!nid) throw new Error('No row id from insert');
        return nid;
      });
  }

  function demoMvpEdgeHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var key = window.__bizdashSupabaseAnonKey;
    if (key) {
      headers.Authorization = 'Bearer ' + key;
      headers.apikey = key;
    }
    var writeTok = window.__bizdashDemoMvpWriteToken;
    if (writeTok) headers['X-Demo-Mvp-Token'] = writeTok;
    return headers;
  }

  function demoMvpEdgeUrl() {
    var base = window.__bizdashSupabaseUrl;
    if (!base) return '';
    return base.replace(/\/$/, '') + '/functions/v1/agency-mvp-demo-leads';
  }

  function normalizeCloudSaveError(err) {
    var msg = err && err.message ? String(err.message) : String(err || '');
    if (/Failed to fetch/i.test(msg) || /NetworkError/i.test(msg)) {
      return new Error(
        'Could not reach demo cloud save endpoint. Deploy `agency-mvp-demo-leads` and ensure CORS allows this origin.'
      );
    }
    return err instanceof Error ? err : new Error(msg || 'Cloud save failed');
  }

  function persistDemoMvpWrite(rec, prev) {
    var url = demoMvpEdgeUrl();
    if (!url) return Promise.reject(new Error('Missing Supabase URL'));
    var headers = demoMvpEdgeHeaders();
    var pay = mvpRecToAttributionPayload(rec);
    var closed = rec.status === 'closed';
    var payAmt =
      closed && rec.paymentAmount != null && isFinite(Number(rec.paymentAmount))
        ? Number(rec.paymentAmount)
        : 0;

    var idLooksDb = isLikelyUuid(rec.id);
    if (idLooksDb && prev && (prev.recordSource === 'import' || prev.recordSource === 'manual')) {
      var upd = {
        updates: [
          {
            id: rec.id,
            company_name: rec.name,
            ga_client_id: pay.ga_client_id,
            search_keyword: pay.search_keyword,
            utm_campaign: pay.utm_campaign,
            purchased: closed,
            purchase_amount: payAmt,
            submitted_at: pay.submitted_at,
          },
        ],
      };
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(upd) }).then(function (r) {
        return r.text().then(function (text) {
          var j = null;
          try {
            j = text ? JSON.parse(text) : null;
          } catch (_) {}
          if (!r.ok) throw new Error((j && j.error) || text || 'Demo save failed');
          if (!j || !j.ok) throw new Error((j && j.error) || 'Demo update failed');
          return rec.id;
        });
      }).catch(function (err) {
        throw normalizeCloudSaveError(err);
      });
    }

    var insBody = {
      insert: {
        company_name: rec.name,
        submitted_at: pay.submitted_at,
        utm_campaign: pay.utm_campaign,
        ga_client_id: pay.ga_client_id,
        search_keyword: pay.search_keyword,
        purchased: closed,
        purchase_amount: payAmt,
      },
    };
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(insBody) }).then(function (r) {
      return r.text().then(function (text) {
        var j = null;
        try {
          j = text ? JSON.parse(text) : null;
        } catch (_) {}
        if (!r.ok) throw new Error((j && j.error) || text || 'Demo save failed');
        if (!j || !j.ok || !j.insertId) throw new Error((j && j.error) || 'Demo insert failed');
        return j.insertId;
      });
    }).catch(function (err) {
      throw normalizeCloudSaveError(err);
    });
  }

  function persistDemoMvpDeleteIds(ids) {
    var url = demoMvpEdgeUrl();
    if (!url) return Promise.reject(new Error('Missing Supabase URL'));
    return fetch(url, {
      method: 'POST',
      headers: demoMvpEdgeHeaders(),
      body: JSON.stringify({ deleteIds: ids }),
    }).then(function (r) {
      return r.text().then(function (text) {
        var j = null;
        try {
          j = text ? JSON.parse(text) : null;
        } catch (_) {}
        if (!r.ok) throw new Error((j && j.error) || text || 'Demo delete failed');
        if (!j || !j.ok) throw new Error((j && j.error) || 'Demo delete failed');
      });
    }).catch(function (err) {
      throw normalizeCloudSaveError(err);
    });
  }

  function persistLeadToCloud(rec, prev) {
    if (isDemoUser()) {
      return persistDemoMvpWrite(rec, prev);
    }
    var orgId = currentOrganizationId();
    var sb = window.supabaseClient;
    if (!orgId || !sb) {
      return Promise.reject(new Error('Sign in and pick a workspace to save to the cloud.'));
    }
    return sb.auth.getSession().then(function (sessRes) {
      var sess = sessRes.data && sessRes.data.session;
      if (!sess || !sess.access_token) {
        return Promise.reject(new Error('Session required to save leads to the cloud.'));
      }
      return persistSignedInAttributionLead(sb, orgId, rec, prev);
    });
  }

  function renderAfterHydrate() {
    renderLeadsPage();
    renderCampaignsPage();
    renderConnectionsPage();
  }

  function hydrateStateFromSupabase() {
    var supabase = window.supabaseClient;
    var user = window.currentUser;
    var orgId = window.currentOrganizationId;
    if (!supabase || !user || !orgId || isDemoUser()) {
      return Promise.resolve();
    }
    if (crmSource !== 'internal') {
      return fetchAttributionLeadsForOrg(supabase, orgId)
        .then(function (attrPack) {
          state = {
            campaigns: attrPack.campaigns,
            leads: attrPack.leads,
          };
          syncCampaignClientIds();
          saveState();
        })
        .catch(function (err) {
          console.error('agency-mvp: attribution_leads fetch', err);
          state = stateFromUploadedLeadsOnly(state);
          syncCampaignClientIds();
          saveState();
        });
    }
    return Promise.all([
      supabase
        .from('clients')
        .select('id,created_at,company_name,contact_name,email,status,total_revenue,ga_client_id')
        .eq('organization_id', orgId)
        .not('ga_client_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1000),
      fetchAttributionLeadsForOrg(supabase, orgId),
    ])
      .then(function (results) {
        var crmRes = results[0];
        var attrPack = results[1];
        if (crmRes.error) throw crmRes.error;
        var crmPack = buildStateFromClients((crmRes.data && crmRes.data) || []);
        state = mergeCrmAndAttribution(crmPack, attrPack);
        syncCampaignClientIds();
        saveState();
      })
      .catch(function (err) {
        console.error('agency-mvp: could not hydrate from Supabase', err);
      });
  }

  function refreshAgencyMvpForAuthContext() {
    if (!isDemoUser() && activeUserId() !== 'guest' && activeOrgId() !== 'noorg') {
      state = emptyState();
      saveStateWithoutUploadSync();
      crmSource = loadCrmSource();
      return hydrateStateFromSupabase().then(renderAfterHydrate).catch(function () {});
    }
    // If signed in but no org is selected/allowed (e.g. developer internal mode), do not show demo seed.
    if (!isDemoUser() && activeUserId() !== 'guest' && activeOrgId() === 'noorg') {
      state = emptyState();
      saveStateWithoutUploadSync();
      crmSource = loadCrmSource();
      renderAfterHydrate();
      return Promise.resolve();
    }
    if (isDemoUser()) {
      saveCrmSource('internal');
      crmSource = 'internal';
      state = { campaigns: seedCampaignsOnly(), leads: [] };
      return loadDemoLeadsFromEdge()
        .then(function (demoLeads) {
          state.leads = attachDemoLeadsToSeedCampaigns(demoLeads, state.campaigns);
          syncCampaignClientIds();
          seedDemoGa4RuntimeRows();
          saveState();
          renderAfterHydrate();
        })
        .catch(function (err) {
          console.warn('agency-mvp: demo DB leads unavailable, using local seed', err);
          state = seedState();
          seedDemoGa4RuntimeRows();
          saveState();
          renderAfterHydrate();
        });
    }
    return hydrateStateFromSupabase().then(renderAfterHydrate).catch(function () {});
  }
  window.refreshAgencyMvpForAuthContext = refreshAgencyMvpForAuthContext;

  function syncCampaignClientIds() {
    state.campaigns.forEach(function (c) {
      c.clientIds = state.leads.filter(function (l) { return l.campaignId === c.id; }).map(function (l) { return l.id; });
    });
  }

  function campaignById(id) {
    return state.campaigns.find(function (c) { return c.id === id; }) || null;
  }

  function revenueForCampaign(campId) {
    return state.leads
      .filter(function (l) { return l.campaignId === campId && l.status === 'closed' && l.paymentAmount != null; })
      .reduce(function (sum, l) { return sum + Number(l.paymentAmount); }, 0);
  }

  function roiPct(spend, revenue) {
    var s = Number(spend);
    if (!isFinite(s) || s <= 0) return null;
    var r = Number(revenue);
    if (!isFinite(r)) r = 0;
    return ((r - s) / s) * 100;
  }

  function openModal(id) {
    var m = $(id);
    if (m) m.classList.add('on');
  }

  function closeModal(id) {
    var m = $(id);
    if (m) m.classList.remove('on');
    if (id === 'leadGaClientIdModal') gaClientIdWizardStep = 0;
  }

  function wireModalBackdrop(id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('click', function (e) {
      if (e.target === el) closeModal(id);
    });
  }

  function setMobileTitle(t) {
    var el = $('mobile-title');
    if (el) el.textContent = t;
  }

  function wireSidebarUserMenu() {
    var trigger = $('sb-user-menu');
    var menu = $('sb-user-dropdown');
    var btnSettings = $('btn-profile-settings');
    var btnLinkGoogle = $('btn-link-google');
    var btnLinkGithub = $('btn-link-github');
    var btnDevAdmin = $('btn-dev-admin');
    var btnLogout = $('btn-profile-logout');
    if (!trigger || !menu) return;

    function openMenu() {
      menu.classList.add('on');
      trigger.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
      menu.classList.remove('on');
      trigger.setAttribute('aria-expanded', 'false');
    }
    function toggleMenu() {
      if (menu.classList.contains('on')) closeMenu();
      else openMenu();
    }

    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu();
    });

    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('on')) return;
      if (trigger.contains(e.target) || menu.contains(e.target)) return;
      closeMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    if (btnSettings) {
      btnSettings.addEventListener('click', function () {
        closeMenu();
        alert('Profile settings are coming soon.');
      });
    }

    function wireLinkProvider(btn, providerLabel, provider) {
      if (!btn) return;
      btn.addEventListener('click', function () {
        closeMenu();
        Promise.resolve()
          .then(function () {
            var c = window.supabaseClient;
            if (!c || !c.auth || typeof c.auth.linkIdentity !== 'function') {
              throw new Error('Account linking is not available in this build.');
            }
            return c.auth.linkIdentity({ provider: provider });
          })
          .then(function (res) {
            if (res && res.error) throw res.error;
          })
          .catch(function (err) {
            console.error('linkIdentity error', err);
            alert((providerLabel || 'OAuth') + ' linking failed. ' + String((err && err.message) || err || ''));
          });
      });
    }

    wireLinkProvider(btnLinkGoogle, 'Google', 'google');
    wireLinkProvider(btnLinkGithub, 'GitHub', 'github');

    function openDevAdminModal() {
      var m = $('devAdminModal');
      if (m) m.classList.add('on');
    }

    function closeDevAdminModal() {
      var m = $('devAdminModal');
      if (m) m.classList.remove('on');
    }

    function setDevAdminInternalVisibility(on) {
      try {
        if (on) document.body.classList.add('internal-mode');
        else document.body.classList.remove('internal-mode');
      } catch (_) {}
    }

    function showDevError(id, msg) {
      var el = $(id);
      if (el) el.textContent = msg || '';
    }

    function showDevResult(id, html) {
      var el = $(id);
      if (!el) return;
      if (!html) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
      }
      el.style.display = 'block';
      el.innerHTML = html;
    }

    async function isDeveloper() {
      try {
        var c = window.supabaseClient;
        if (!c || !c.rpc) return false;
        var r = await c.rpc('is_developer');
        if (r && r.error) return false;
        return !!r.data;
      } catch (_) {
        return false;
      }
    }

    async function devAdminCall(payload) {
      return fetchDevAdmin(payload || {});
    }

    function wireDevAdminModal() {
      var closeBtn = $('btn-dev-admin-close');
      if (closeBtn && closeBtn.getAttribute('data-wired') !== '1') {
        closeBtn.setAttribute('data-wired', '1');
        closeBtn.addEventListener('click', function () {
          closeDevAdminModal();
        });
      }

      var btnCreate = $('btn-dev-org-create');
      if (btnCreate && btnCreate.getAttribute('data-wired') !== '1') {
        btnCreate.setAttribute('data-wired', '1');
        btnCreate.addEventListener('click', function () {
          showDevError('dev-org-error', '');
          showDevResult('dev-org-result', '');
          var name = ($('dev-org-name') && $('dev-org-name').value.trim()) || '';
          var slug = ($('dev-org-slug') && $('dev-org-slug').value.trim()) || '';
          var adminEmail = ($('dev-org-admin-email') && $('dev-org-admin-email').value.trim()) || '';
          if (!name || !slug || !adminEmail) {
            showDevError('dev-org-error', 'Name, slug, and admin email are required.');
            return;
          }
          Promise.resolve()
            .then(function () {
              return devAdminCall({ action: 'create_org', name: name, slug: slug, adminEmail: adminEmail });
            })
            .then(function (j) {
              showDevResult('dev-org-result', formatProvisionedOrgHtml(j));
              try {
                if (window.__bizdashMgrRefreshOrgs) window.__bizdashMgrRefreshOrgs();
              } catch (_) {}
            })
            .catch(function (err) {
              showDevError('dev-org-error', String((err && err.message) || err || 'Failed'));
            });
        });
      }
    }

    if (btnDevAdmin) {
      btnDevAdmin.addEventListener('click', function () {
        closeMenu();
        Promise.resolve()
          .then(function () {
            return isDeveloper();
          })
          .then(function (ok) {
            if (!ok) {
              alert('Developer access denied.');
              return;
            }
            setDevAdminInternalVisibility(true);
            wireDevAdminModal();
            openDevAdminModal();
          })
          .catch(function () {
            alert('Developer access denied.');
          });
      });
    }

    if (btnLogout) {
      btnLogout.addEventListener('click', function () {
        closeMenu();
        Promise.resolve()
          .then(function () {
            if (window.supabaseClient && window.supabaseClient.auth && typeof window.supabaseClient.auth.signOut === 'function') {
              return window.supabaseClient.auth.signOut();
            }
          })
          .catch(function () {})
          .finally(function () {
            if (window.__dashboardShowLogin && typeof window.__dashboardShowLogin === 'function') {
              window.__dashboardShowLogin();
            } else {
              var app = $('app-shell');
              var login = $('auth-login-shell');
              if (app) app.classList.remove('on');
              if (login) login.style.display = 'flex';
            }
            window.location.assign('/');
          });
      });
    }
  }

  function refreshGa4Status() {
    var orgId = currentOrganizationId();
    if (!orgId || isDemoUser()) {
      ga4ServerConnected = false;
      ga4StatusSnapshot = { propertyId: null, propertyName: null, lastSyncedAt: null };
      return Promise.resolve({ connected: false });
    }
    return fetchJson('/api/ga4/status?organizationId=' + encodeURIComponent(orgId))
      .then(function (s) {
        ga4ServerConnected = !!(s && s.connected);
        ga4StatusSnapshot.propertyId = s && s.propertyId;
        ga4StatusSnapshot.propertyName = s && s.propertyName;
        ga4StatusSnapshot.lastSyncedAt = s && s.lastSyncedAt;
        return s;
      })
      .catch(function () {
        ga4ServerConnected = false;
        ga4StatusSnapshot = { propertyId: null, propertyName: null, lastSyncedAt: null };
        return { connected: false };
      });
  }

  function refreshGa4Report(startDate, endDate) {
    var orgId = currentOrganizationId();
    if (!orgId || isDemoUser()) return Promise.resolve({ rows: [] });
    var q =
      '?organizationId=' +
      encodeURIComponent(orgId) +
      '&startDate=' +
      encodeURIComponent(startDate) +
      '&endDate=' +
      encodeURIComponent(endDate);
    return fetchJson('/api/ga4/report' + q).then(function (j) {
      runtimeGa4Rows = (j && j.rows) || [];
      runtimeGa4Meta.usedClientIdDimension = !!(j && j.usedClientIdDimension);
      runtimeGa4Meta.startDate = j && j.startDate;
      runtimeGa4Meta.endDate = j && j.endDate;
      ga4ClientLastFetchAt = Date.now();
      return refreshGa4Status().then(function () {
        return j;
      });
    });
  }

  /** When connected, pull a fresh report if we have no rows or local cache is stale (no reconnect). */
  function maybeRefreshGa4IfStale() {
    if (!ga4ServerConnected) return Promise.resolve();
    var now = Date.now();
    var needs = !runtimeGa4Rows || !runtimeGa4Rows.length || now - ga4ClientLastFetchAt >= GA4_STALE_MS;
    if (!needs) return Promise.resolve();
    if (ga4ReportInFlight) return ga4ReportInFlight;
    var r = defaultGa4Range();
    var s = ($('camp-ga4-start') && $('camp-ga4-start').value.trim()) || r.start;
    var e = ($('camp-ga4-end') && $('camp-ga4-end').value.trim()) || r.end;
    ga4ReportInFlight = refreshGa4Report(s, e).finally(function () {
      ga4ReportInFlight = null;
    });
    return ga4ReportInFlight;
  }

  window.nav = function (page, navEl) {
    document.querySelectorAll('.pg').forEach(function (p) {
      p.classList.remove('on');
    });
    var pg = $('page-' + page);
    if (pg) pg.classList.add('on');
    document.querySelectorAll('.sb-nav .ni').forEach(function (n) {
      n.classList.remove('active');
    });
    if (navEl && navEl.classList) navEl.classList.add('active');
    else {
      var match = document.querySelector('.sb-nav .ni[data-nav="' + page + '"]');
      if (match) match.classList.add('active');
    }
    document.body.classList.remove('mobile-nav-open');
    if (page === 'leads') {
      setMobileTitle('Leads & clients');
      renderLeadsPage();
    } else if (page === 'campaigns') {
      setMobileTitle('Campaigns');
      refreshGa4Status()
        .then(function () {
          var tb = $('campaigns-ga4-toolbar');
          if (tb) tb.style.display = ga4ServerConnected ? 'block' : 'none';
          if (ga4ServerConnected) {
            var r = defaultGa4Range();
            if ($('camp-ga4-start') && !$('camp-ga4-start').value) $('camp-ga4-start').value = r.start;
            if ($('camp-ga4-end') && !$('camp-ga4-end').value) $('camp-ga4-end').value = r.end;
          }
          return maybeRefreshGa4IfStale();
        })
        .then(function () {
          renderCampaignsPage();
        })
        .catch(function () {
          renderCampaignsPage();
        });
    } else if (page === 'connections') {
      setMobileTitle('Connections');
      refreshGa4Status()
        .then(function () {
          return maybeRefreshGa4IfStale();
        })
        .then(function () {
          renderConnectionsPage();
        })
        .catch(function () {
          renderConnectionsPage();
        });
    } else if (page === 'manager') {
      setMobileTitle('Manage accounts');
      renderManagerAccountsPage();
    }
  };

  function managerSetError(id, msg) {
    var el = $(id);
    if (el) el.textContent = msg || '';
  }

  function managerShowDetail(on) {
    var card = $('mgr-org-detail-card');
    if (card) card.style.display = on ? 'block' : 'none';
  }

  function fetchDevAdmin(payload) {
    var c = window.supabaseClient;
    if (!c || !c.auth) return Promise.reject(new Error('No session.'));
    return c.auth.getSession().then(function (s) {
      var token = s && s.data && s.data.session && s.data.session.access_token;
      if (!token) throw new Error('No session.');
      var base = (window.__bizdashSupabaseUrl || '').replace(/\/$/, '');
      var anon = window.__bizdashSupabaseAnonKey || '';
      if (!base || !anon) throw new Error('Missing Supabase config.');
      return fetchJson(base + '/functions/v1/dev-admin', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          apikey: anon,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload || {}),
      });
    });
  }

  function renderManagerAccountsPage() {
    var btnRefresh = $('btn-mgr-refresh');
    var btnOpen = $('btn-mgr-open-admin');
    var body = $('mgr-orgs-tbody');
    var err = $('mgr-orgs-error');
    if (err) err.textContent = '';
    if (body) body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">Loading…</td></tr>';

    function loadOrgs() {
      managerSetError('mgr-orgs-error', '');
      if (body) body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">Loading…</td></tr>';
      return fetchDevAdmin({ action: 'list_runway_orgs' })
        .then(function (j) {
          var rows = (j && j.organizations) || [];
          if (!body) return;
          if (!rows.length) {
            body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">No Runway organizations yet.</td></tr>';
            return;
          }
          body.innerHTML = rows.map(function (o) {
            var id = escapeHtml(o.id);
            var nm = escapeHtml(o.name || '');
            var sl = escapeHtml(o.slug || '');
            var ae = escapeHtml(o.admin_email || '');
            var mc = typeof o.member_count === 'number' ? String(o.member_count) : escapeHtml(o.member_count || '');
            var needsOnboarding = o && o.onboarding_completed === false;
            var tag = needsOnboarding
              ? '<span class="pill" style="margin-left:8px;background:rgba(245, 158, 11, .16);border-color:rgba(245, 158, 11, .35);color:#f59e0b;">Onboarding</span>'
              : '';
            return (
              '<tr>' +
              '<td class="tdp">' + nm + tag + '<span class="td-sub"><code style="font-size:11px;">' + id + '</code></span></td>' +
              '<td><code style="font-size:11px;">/' + sl + '</code></td>' +
              '<td>' + ae + '</td>' +
              '<td>' + mc + '</td>' +
              '<td style="white-space:nowrap;display:flex;gap:8px;justify-content:flex-end;">' +
                '<button type="button" class="btn" data-org-id="' + id + '" data-org-name="' + nm + '">View</button>' +
                '<button type="button" class="btn btn-p" data-invite-org-id="' + id + '" data-invite-org-name="' + nm + '">Invite</button>' +
              '</td>' +
              '</tr>'
            );
          }).join('');
          body.querySelectorAll('button[data-org-id]').forEach(function (b) {
            b.addEventListener('click', function () {
              var orgId = b.getAttribute('data-org-id') || '';
              var orgName = b.getAttribute('data-org-name') || 'Organization';
              openManagerOrgDetail(orgId, orgName);
            });
          });
          body.querySelectorAll('button[data-invite-org-id]').forEach(function (b) {
            b.addEventListener('click', function () {
              openManagerInviteModal(
                b.getAttribute('data-invite-org-id') || '',
                b.getAttribute('data-invite-org-name') || 'Organization'
              );
            });
          });
        })
        .catch(function (e) {
          managerSetError('mgr-orgs-error', String((e && e.message) || e || 'Failed'));
          if (body) body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">—</td></tr>';
        });
    }

    try {
      window.__bizdashMgrRefreshOrgs = function () {
        return loadOrgs();
      };
    } catch (_) {}

    function openManagerOrgDetail(orgId, orgName) {
      managerShowDetail(true);
      managerSetError('mgr-org-detail-error', '');
      var title = $('mgr-org-detail-title');
      if (title) title.textContent = orgName || 'Organization';
      var tb = $('mgr-org-members-tbody');
      if (tb) tb.innerHTML = '<tr><td colspan="3" style="color:var(--text3);padding:14px 16px;">Loading…</td></tr>';
      fetchDevAdmin({ action: 'org_members', organizationId: orgId })
        .then(function (j) {
          var rows = (j && j.members) || [];
          if (!tb) return;
          if (!rows.length) {
            tb.innerHTML = '<tr><td colspan="3" style="color:var(--text3);padding:14px 16px;">No members.</td></tr>';
            return;
          }
          tb.innerHTML = rows.map(function (m) {
            return '<tr><td>' + escapeHtml(m.email || '') + '</td><td>' + escapeHtml(m.role || '') + '</td><td>' + escapeHtml(m.created_at || '') + '</td></tr>';
          }).join('');
        })
        .catch(function (e) {
          managerSetError('mgr-org-detail-error', String((e && e.message) || e || 'Failed'));
          if (tb) tb.innerHTML = '<tr><td colspan="3" style="color:var(--text3);padding:14px 16px;">—</td></tr>';
        });
    }

    function openManagerInviteModal(orgId, orgName) {
      var m = $('mgrInviteModal');
      if (!m) return;
      var hid = $('mgr-invite-org-id');
      var lbl = $('mgr-invite-org-label');
      var email = $('mgr-invite-email');
      var role = $('mgr-invite-role');
      var err = $('mgr-invite-error');
      var res = $('mgr-invite-result');
      if (hid) hid.value = orgId || '';
      if (lbl) lbl.value = orgName || '';
      if (email) email.value = '';
      if (role) role.value = 'member';
      if (err) err.textContent = '';
      if (res) { res.style.display = 'none'; res.innerHTML = ''; }
      m.classList.add('on');
    }

    function closeManagerInviteModal() {
      var m = $('mgrInviteModal');
      if (m) m.classList.remove('on');
    }

    if (btnRefresh && btnRefresh.getAttribute('data-wired') !== '1') {
      btnRefresh.setAttribute('data-wired', '1');
      btnRefresh.addEventListener('click', function () { loadOrgs(); });
    }
    if (btnOpen && btnOpen.getAttribute('data-wired') !== '1') {
      btnOpen.setAttribute('data-wired', '1');
      btnOpen.addEventListener('click', function () {
        var m = $('devAdminModal');
        if (m) m.classList.add('on');
        // Ensure modal buttons are wired even if opened from this page.
        wireDevAdminCreateOrgOnly();
      });
    }
    var btnClose = $('btn-mgr-org-detail-close');
    if (btnClose && btnClose.getAttribute('data-wired') !== '1') {
      btnClose.setAttribute('data-wired', '1');
      btnClose.addEventListener('click', function () { managerShowDetail(false); });
    }

    var btnInviteClose = $('btn-mgr-invite-close');
    if (btnInviteClose && btnInviteClose.getAttribute('data-wired') !== '1') {
      btnInviteClose.setAttribute('data-wired', '1');
      btnInviteClose.addEventListener('click', function () { closeManagerInviteModal(); });
    }

    var btnInviteGo = $('btn-mgr-invite-generate');
    if (btnInviteGo && btnInviteGo.getAttribute('data-wired') !== '1') {
      btnInviteGo.setAttribute('data-wired', '1');
      btnInviteGo.addEventListener('click', function () {
        managerSetError('mgr-invite-error', '');
        var orgId = ($('mgr-invite-org-id') && $('mgr-invite-org-id').value.trim()) || '';
        var email = ($('mgr-invite-email') && $('mgr-invite-email').value.trim()) || '';
        var role = ($('mgr-invite-role') && $('mgr-invite-role').value) || 'member';
        if (!orgId || !email) {
          managerSetError('mgr-invite-error', 'Email is required.');
          return;
        }
        fetchDevAdmin({ action: 'invite_user', organizationId: orgId, email: email, role: role })
          .then(function (j) {
            var pw = j.temporaryPassword || '';
            var out = formatProvisionedInviteHtml(email, pw);
            var box = $('mgr-invite-result');
            if (box) { box.style.display = 'block'; box.innerHTML = out; wireFetchTempPasswordButtons(box); }
            try {
              if (window.__bizdashMgrRefreshOrgs) window.__bizdashMgrRefreshOrgs();
            } catch (_) {}
          })
          .catch(function (e) {
            managerSetError('mgr-invite-error', String((e && e.message) || e || 'Failed'));
          });
      });
    }

    managerShowDetail(false);
    // Ensure modals are wired when landing on page.
    wireDevAdminCreateOrgOnly();
    loadOrgs();
  }

  function wireDevAdminCreateOrgOnly() {
    var closeBtn = $('btn-dev-admin-close');
    if (closeBtn && closeBtn.getAttribute('data-wired-manager') !== '1') {
      closeBtn.setAttribute('data-wired-manager', '1');
      closeBtn.addEventListener('click', function () {
        var m = $('devAdminModal');
        if (m) m.classList.remove('on');
      });
    }

    var btnCreate = $('btn-dev-org-create');
    if (btnCreate && btnCreate.getAttribute('data-wired-manager') !== '1') {
      btnCreate.setAttribute('data-wired-manager', '1');
      btnCreate.addEventListener('click', function () {
        managerSetError('dev-org-error', '');
        var res = $('dev-org-result');
        if (res) { res.style.display = 'none'; res.innerHTML = ''; }
        var name = ($('dev-org-name') && $('dev-org-name').value.trim()) || '';
        var slug = ($('dev-org-slug') && $('dev-org-slug').value.trim()) || '';
        var adminEmail = ($('dev-org-admin-email') && $('dev-org-admin-email').value.trim()) || '';
        if (!name || !slug || !adminEmail) {
          managerSetError('dev-org-error', 'Name, slug, and admin email are required.');
          return;
        }
        Promise.resolve()
          .then(function () {
            // Quick client-side slug check (friendly error before POST).
            try {
              var c = window.supabaseClient;
              if (!c || !c.rpc) return { taken: false };
              return c.rpc('organization_public_by_slug', { sl: String(slug).trim().toLowerCase() }).then(function (r) {
                if (r && r.data && r.data.length) return { taken: true };
                return { taken: false };
              }).catch(function () { return { taken: false }; });
            } catch (_) {
              return { taken: false };
            }
          })
          .then(function (chk) {
            if (chk && chk.taken) {
              managerSetError('dev-org-error', 'That slug is already in use. Choose a different slug.');
              throw new Error('slug_taken');
            }
            return fetchDevAdmin({ action: 'create_org', name: name, slug: slug, adminEmail: adminEmail });
          })
          .then(function (j) {
            var box = $('dev-org-result');
            if (box) {
              box.style.display = 'block';
              box.innerHTML = formatProvisionedOrgHtml(j);
              wireFetchTempPasswordButtons(box);
            }
            try {
              if (window.__bizdashMgrRefreshOrgs) window.__bizdashMgrRefreshOrgs();
            } catch (_) {}
            try {
              var m = $('devAdminModal');
              if (m) m.classList.remove('on');
            } catch (_) {}
          })
          .catch(function (e) {
            var msg = String((e && e.message) || e || 'Failed');
            if (msg === 'slug_taken') return;
            // Nicer errors for common DB constraint failures.
            if (msg.indexOf('organizations_slug_key') !== -1 || msg.toLowerCase().indexOf('duplicate') !== -1) {
              msg = 'That slug is already in use. Choose a different slug.';
            }
            managerSetError('dev-org-error', msg);
          });
      });
    }

    var btnPick = $('btn-dev-org-pick-compass');
    if (btnPick && btnPick.getAttribute('data-wired-manager') !== '1') {
      btnPick.setAttribute('data-wired-manager', '1');
      btnPick.addEventListener('click', function () {
        managerSetError('dev-org-error', '');
        openCompassOrgPicker();
      });
    }

    // Live slug availability check with taken/available indicator.
    (function wireSlugAvailability() {
      var input = $('dev-org-slug');
      var status = $('dev-org-slug-status');
      var createBtn = $('btn-dev-org-create');
      if (!input || !status || !createBtn) return;
      if (input.getAttribute('data-wired-slug') === '1') return;
      input.setAttribute('data-wired-slug', '1');

      var timer = null;
      var last = '';
      var setState = function (state, msg) {
        status.textContent = msg || '';
        status.style.color =
          state === 'ok' ? '#22c55e' :
          state === 'bad' ? 'var(--red)' :
          'var(--text3)';
        createBtn.disabled = state !== 'ok';
      };

      var check = function () {
        var slug = String(input.value || '').trim().toLowerCase();
        if (!slug) { setState('idle', ''); return; }
        if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
          setState('bad', 'Use 2–63 chars: lowercase letters, numbers, and hyphens.');
          return;
        }
        setState('idle', 'Checking availability…');
        last = slug;
        try {
          var c = window.supabaseClient;
          if (!c || !c.rpc) { setState('idle', ''); return; }
          c.rpc('organization_public_by_slug', { sl: slug }).then(function (r) {
            if (String(input.value || '').trim().toLowerCase() !== last) return;
            if (r && r.data && r.data.length) {
              setState('bad', 'Slug is already taken.');
            } else {
              setState('ok', 'Slug is available.');
            }
          }).catch(function () {
            if (String(input.value || '').trim().toLowerCase() !== last) return;
            setState('idle', '');
          });
        } catch (_) {
          setState('idle', '');
        }
      };

      input.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, 350);
        // Disable while typing until we have a positive check.
        createBtn.disabled = true;
      });

      // On open, run once.
      setTimeout(check, 0);
    })();
  }

  function openCompassOrgPicker() {
    var m = $('mgrCompassModal');
    var body = $('mgr-compass-tbody');
    var err = $('mgr-compass-error');
    var search = $('mgr-compass-search');
    var cache = (window.__bizdashCompassMemberCache = window.__bizdashCompassMemberCache || {});
    if (err) err.textContent = '';
    if (body) body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">Loading…</td></tr>';
    if (search) search.value = '';
    if (m) m.classList.add('on');

    fetchDevAdmin({ action: 'list_compass_orgs_without_runway' })
      .then(function (j) {
        var rows = (j && j.organizations) || [];
        if (!body) return;
        if (!rows.length) {
          body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">No Compass-only organizations found.</td></tr>';
          return;
        }
        var allRows = rows.slice();

        function render(list) {
          body.innerHTML = list.map(function (o) {
            var id = escapeHtml(o.id);
            var nmRaw = String(o.name || '');
            var slRaw = String(o.slug || '');
            var aeRaw = String(o.admin_email || '');
            var nm = escapeHtml(nmRaw);
            var sl = escapeHtml(slRaw);
            var ae = escapeHtml(aeRaw);
            var mc = typeof o.member_count === 'number' ? String(o.member_count) : escapeHtml(o.member_count || '');
            return (
              '<tr>' +
                '<td class="tdp" title="' + nm + '" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + nm + '</td>' +
                '<td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><code style="font-size:11px;">/' + sl + '</code></td>' +
                '<td title="' + ae + '" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + ae + '</td>' +
                '<td>' +
                  '<span class="kb" data-members-org="' + id + '" style="font-size:11px;padding:4px 10px;border-radius:999px;cursor:default;">' +
                    mc +
                  '</span>' +
                '</td>' +
                '<td style="white-space:nowrap;text-align:right;">' +
                  '<button type="button" class="btn btn-p" data-compass-enable-id="' + id + '">Enable Runway</button>' +
                '</td>' +
              '</tr>'
            );
          }).join('');

          wireMembersTooltip();
          wireEnableButtons();
        }

        function getTipEl() {
          var el = document.getElementById('mgrMembersTipFloat');
          if (el) return el;
          el = document.createElement('div');
          el.id = 'mgrMembersTipFloat';
          el.style.position = 'fixed';
          el.style.display = 'none';
          el.style.minWidth = '260px';
          el.style.maxWidth = '420px';
          el.style.zIndex = '9999';
          el.style.background = 'var(--panel)';
          el.style.border = '1px solid var(--border)';
          el.style.borderRadius = '12px';
          el.style.padding = '10px 10px';
          el.style.boxShadow = '0 16px 40px rgba(0,0,0,.22)';
          el.style.color = 'var(--text2)';
          el.style.fontSize = '12px';
          el.style.lineHeight = '1.45';
          document.body.appendChild(el);
          return el;
        }

        function wireMembersTooltip() {
          body.querySelectorAll('[data-members-org]').forEach(function (chip) {
            var orgId = chip.getAttribute('data-members-org') || '';
            if (!orgId) return;
            var tipEl = getTipEl();
            var show = function () {
              var r = chip.getBoundingClientRect();
              tipEl.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 440)) + 'px';
              tipEl.style.top = Math.min(window.innerHeight - 40, r.bottom + 10) + 'px';
              tipEl.style.display = 'block';
              if (cache[orgId] && cache[orgId].html) {
                tipEl.innerHTML = cache[orgId].html;
                return;
              }
              tipEl.textContent = 'Loading…';
              fetchDevAdmin({ action: 'org_members', organizationId: orgId })
                .then(function (j2) {
                  var ms = (j2 && j2.members) || [];
                  var emails = ms
                    .map(function (m) { return (m && m.email) ? String(m.email) : ''; })
                    .filter(function (s) { return s && s.trim(); });
                  var html = '<div style="font-weight:600;color:var(--text);margin-bottom:6px;">Members</div>' +
                    (emails.length
                      ? '<div style="display:grid;gap:4px;">' + emails.map(function (e) {
                          return '<div style="font-family:var(--font-mono);font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(e) + '</div>';
                        }).join('') + '</div>'
                      : '<div style="color:var(--text3);">No members found.</div>');
                  cache[orgId] = { html: html };
                  tipEl.innerHTML = html;
                })
                .catch(function (e) {
                  tipEl.textContent = String((e && e.message) || e || 'Failed');
                });
            };
            var hide = function () { tipEl.style.display = 'none'; };
            chip.addEventListener('mouseenter', show);
            chip.addEventListener('mouseleave', hide);
          });
        }

        function wireEnableButtons() {
          body.querySelectorAll('button[data-compass-enable-id]').forEach(function (b) {
            b.addEventListener('click', function () {
              var orgId = b.getAttribute('data-compass-enable-id') || '';
              if (!orgId) return;
              if (err) err.textContent = '';
              b.disabled = true;
              b.textContent = 'Enabling…';
              fetchDevAdmin({ action: 'enable_runway_for_org', organizationId: orgId })
                .then(function () {
                  closeCompassOrgPicker();
                  try {
                    if (window.__bizdashMgrRefreshOrgs) window.__bizdashMgrRefreshOrgs();
                  } catch (_) {}
                })
                .catch(function (e) {
                  b.disabled = false;
                  b.textContent = 'Enable Runway';
                  if (err) err.textContent = String((e && e.message) || e || 'Failed');
                });
            });
          });
        }

        function applyFilter() {
          var q = (search && search.value ? String(search.value) : '').trim().toLowerCase();
          if (!q) { render(allRows); return; }
          var filtered = allRows.filter(function (o) {
            var nm = String(o.name || '').toLowerCase();
            var sl = String(o.slug || '').toLowerCase();
            var ae = String(o.admin_email || '').toLowerCase();
            return nm.indexOf(q) !== -1 || sl.indexOf(q) !== -1 || ae.indexOf(q) !== -1;
          });
          render(filtered);
        }

        if (search && search.getAttribute('data-wired') !== '1') {
          search.setAttribute('data-wired', '1');
          search.addEventListener('input', function () { applyFilter(); });
        }

        render(allRows);

      })
      .catch(function (e) {
        if (err) err.textContent = String((e && e.message) || e || 'Failed');
        if (body) body.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:14px 16px;">—</td></tr>';
      });
  }

  function closeCompassOrgPicker() {
    var m = $('mgrCompassModal');
    if (m) m.classList.remove('on');
  }

  (function wireCompassPickerModal() {
    var btn = $('btn-mgr-compass-close');
    if (btn && btn.getAttribute('data-wired') !== '1') {
      btn.setAttribute('data-wired', '1');
      btn.addEventListener('click', function () { closeCompassOrgPicker(); });
    }
  })();

  function statusPill(status) {
    if (status === 'closed') {
      return '<span class="kb bu" style="font-size:11px;padding:4px 10px;border-radius:999px;">Closed sale</span>';
    }
    return '<span class="kb bn" style="font-size:11px;padding:4px 10px;border-radius:999px;">Lead</span>';
  }

  function renderLeadsPage() {
    var usingSource = isDemoUser() || crmSource === 'internal' || crmSource === 'salesforce';
    if (!usingSource) {
      var emptyNoSrc = $('leads-empty');
      var tableNoSrc = $('leads-table');
      var tbNoSrc = $('leads-tbody');
      if (tbNoSrc) tbNoSrc.innerHTML = '';
      if (tableNoSrc) tableNoSrc.style.display = 'none';
      if (emptyNoSrc) {
        emptyNoSrc.style.display = 'block';
        emptyNoSrc.innerHTML = 'No CRM source connected. Open <strong>Connections</strong> and link Internal CRM or Salesforce.';
      }
      return;
    }
    if (crmSource === 'salesforce') {
      var emptySf = $('leads-empty');
      var tableSf = $('leads-table');
      var tbSf = $('leads-tbody');
      if (tbSf) tbSf.innerHTML = '';
      if (tableSf) tableSf.style.display = 'none';
      if (emptySf) {
        emptySf.style.display = 'block';
        emptySf.innerHTML = 'Salesforce source selected. Sync adapter is not enabled yet, so no leads are shown.';
      }
      return;
    }

    syncCampaignClientIds();
    var statusF = ($('lead-filter-status') && $('lead-filter-status').value) || 'all';
    var campF = ($('lead-filter-campaign') && $('lead-filter-campaign').value) || 'all';
    var from = ($('lead-filter-from') && $('lead-filter-from').value) || '';
    var to = ($('lead-filter-to') && $('lead-filter-to').value) || '';

    var selCamp = $('lead-filter-campaign');
    if (selCamp) {
      var prev = selCamp.value;
      selCamp.innerHTML = '<option value="all">All campaigns</option>' +
        state.campaigns.map(function (c) {
          return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
        }).join('');
      selCamp.value = state.campaigns.some(function (c) { return c.id === prev; }) ? prev : campF === 'all' ? 'all' : campF;
    }

    var rows = state.leads.filter(function (l) {
      if (statusF !== 'all' && l.status !== statusF) return false;
      if (campF !== 'all' && l.campaignId !== campF) return false;
      if (from && String(l.dateAdded) < from) return false;
      if (to && String(l.dateAdded) > to) return false;
      return true;
    });

    var tb = $('leads-tbody');
    var empty = $('leads-empty');
    var table = $('leads-table');
    if (!tb) return;
    if (!rows.length) {
      tb.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (empty) empty.innerHTML = 'No attributed clients found yet. Internal CRM mode only includes <code style="font-size:11px;">clients</code> rows with a non-empty <code style="font-size:11px;">ga_client_id</code> in this workspace.';
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';
    tb.innerHTML = rows
      .map(function (l) {
        return (
          '<tr data-lead-id="' +
          escapeHtml(l.id) +
          '"><td class="tdp">' +
          escapeHtml(l.name) +
          '</td><td>' +
          statusPill(l.status) +
          '</td><td>' +
          escapeHtml(l.status === 'closed' ? fmtMoney(l.paymentAmount) : '—') +
          '</td><td>' +
          escapeHtml(l.searchKeyword || '') +
          '</td><td style="font-size:12px;max-width:140px;" class="td-truncate" title="' +
          escapeHtml(l.clientId || '') +
          '">' +
          escapeHtml(l.clientId || '') +
          '</td><td><select class="fi lead-campaign-select" data-lead-id="' +
          escapeHtml(l.id) +
          '" style="min-width:160px;font-size:13px;padding:6px 8px;">' +
          '<option value="">— Unassigned —</option>' +
          state.campaigns
            .map(function (c) {
              return (
                '<option value="' +
                escapeHtml(c.id) +
                '"' +
                (l.campaignId === c.id ? ' selected' : '') +
                '>' +
                escapeHtml(c.name) +
                '</option>'
              );
            })
            .join('') +
          '</select></td><td>' +
          escapeHtml(fmtDate(l.dateAdded)) +
          '</td><td><button type="button" class="btn btn-lead-edit" data-lead-id="' +
          escapeHtml(l.id) +
          '">Edit</button></td></tr>'
        );
      })
      .join('');

    tb.querySelectorAll('.lead-campaign-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-lead-id');
        var lead = state.leads.find(function (x) { return x.id === id; });
        if (!lead) return;
        lead.campaignId = sel.value || null;
        syncCampaignClientIds();
        saveState();
        renderCampaignsPage();
      });
    });
    tb.querySelectorAll('.btn-lead-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openLeadModal(btn.getAttribute('data-lead-id'));
      });
    });
  }

  function renderCampaignsPage() {
    syncCampaignClientIds();
    var wrap = $('campaigns-grid');
    if (!wrap) return;
    wrap.innerHTML = state.campaigns
      .map(function (c) {
        var rev = revenueForCampaign(c.id);
        var leadsN = state.leads.filter(function (l) { return l.campaignId === c.id; }).length;
        var closedN = state.leads.filter(function (l) {
          return l.campaignId === c.id && l.status === 'closed';
        }).length;
        var roi = roiPct(c.spend, rev);
        var roiStr = roi == null ? '—' : roi.toFixed(1) + '%';
        var g = ga4TotalsForCampaignName(c.name, runtimeGa4Rows || []);
        var showGa4Metrics = ga4ServerConnected || isDemoUser();
        var ga4S = showGa4Metrics && g.sessions != null ? String(g.sessions) : '—';
        var ga4C = showGa4Metrics && g.conversions != null ? String(g.conversions) : '—';
        var connectHint =
          !isDemoUser() && !ga4ServerConnected && (!runtimeGa4Rows || !runtimeGa4Rows.length)
            ? '<div class="ss" style="margin-top:8px;"><button type="button" class="btn btn-campaign-ga4-link" style="font-size:11px;padding:5px 10px;">Connect GA4</button></div>'
            : '';
        return (
          '<div class="card" data-campaign-id="' +
          escapeHtml(c.id) +
          '">' +
          '<div class="sh" style="margin-bottom:12px;align-items:flex-start;"><div><div class="st">' +
          escapeHtml(c.name) +
          '</div><div class="ss">' +
          escapeHtml(c.channelType) +
          ' · Spend ' +
          fmtMoney(c.spend) +
          '</div></div><button type="button" class="btn btn-campaign-edit" data-campaign-id="' +
          escapeHtml(c.id) +
          '">Edit</button></div>' +
          '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;font-size:13px;color:var(--text2);">' +
          '<div><span style="color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">Revenue</span><div style="font-weight:600;color:var(--text);margin-top:4px;">' +
          fmtMoney(rev) +
          '</div></div>' +
          '<div><span style="color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">ROI</span><div style="font-weight:600;color:var(--text);margin-top:4px;">' +
          roiStr +
          '</div></div>' +
          '<div><span style="color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">Leads</span><div style="font-weight:600;color:var(--text);margin-top:4px;">' +
          leadsN +
          '</div></div>' +
          '<div><span style="color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">Closed</span><div style="font-weight:600;color:var(--text);margin-top:4px;">' +
          closedN +
          '</div></div>' +
          '<div><span style="color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">GA4 Sessions</span><div style="font-weight:600;color:var(--text);margin-top:4px;">' +
          ga4S +
          '</div></div>' +
          '<div><span style="color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">GA4 Conversions</span><div style="font-weight:600;color:var(--text);margin-top:4px;">' +
          ga4C +
          '</div></div>' +
          '</div>' +
          connectHint +
          '</div>'
        );
      })
      .join('');

    wrap.querySelectorAll('.btn-campaign-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openCampaignModal(btn.getAttribute('data-campaign-id'));
      });
    });
    wrap.querySelectorAll('.btn-campaign-ga4-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.nav('connections', document.querySelector('.sb-nav .ni[data-nav="connections"]'));
      });
    });
  }

  function renderConnectionsPage() {
    var crmDot = $('conn-crm-dot');
    var crmStatus = $('conn-crm-status');
    var sfDot = $('conn-sf-dot');
    var sfStatus = $('conn-sf-status');
    if (crmDot) crmDot.style.background = crmSource === 'internal' ? 'var(--green)' : 'var(--neutral)';
    if (crmStatus) crmStatus.textContent = crmSource === 'internal' ? 'Connected (Internal CRM)' : 'Not connected';
    if (sfDot) sfDot.style.background = crmSource === 'salesforce' ? 'var(--green)' : 'var(--neutral)';
    if (sfStatus) sfStatus.textContent = crmSource === 'salesforce' ? 'Selected (Salesforce)' : 'Not connected';

    var a = $('conn-ga4-state-a');
    var b = $('conn-ga4-state-b');
    if (!a || !b) return;
    if (ga4ServerConnected) {
      a.style.display = 'none';
      b.style.display = 'block';
      var label = ga4StatusSnapshot.propertyName || 'GA4 property';
      var pid = ga4StatusSnapshot.propertyId || '';
      $('conn-ga4-prop-label').textContent = label + ' · Property ID ' + pid;
      $('conn-ga4-last-sync').textContent = fmtDateTime(ga4StatusSnapshot.lastSyncedAt);
    } else {
      a.style.display = 'block';
      b.style.display = 'none';
      if ($('conn-ga4-connect-err')) $('conn-ga4-connect-err').textContent = '';
    }
  }

  function updateLeadSourceFooter(lead, isNew) {
    var el = $('lead-source-attribution-body');
    if (!el) return;
    if (isNew || !lead) {
      el.innerHTML =
        '<span style="color:var(--text3);">New rows are saved in Runway. CSV uploads go to <code style="font-size:11px;">attribution_leads</code> in your workspace (not primary CRM clients).</span>';
      return;
    }
    if (lead.demoFromDb) {
      el.innerHTML =
        '<span style="font-weight:600;color:var(--text);">Demo dataset</span> — loaded from the database for this preview. Same table as live CSV imports; not your CRM <code style="font-size:11px;">clients</code> table.';
      return;
    }
    if (lead.recordSource === 'crm') {
      var crmMsg =
        '<span style="font-weight:600;color:var(--text);">Auto-synced from Internal CRM</span> — name, status, revenue, dates, and keywords from the database are locked. Campaign below is Runway attribution only.';
      var crmSession = getSessionDataForClient(lead.clientId, runtimeGa4Rows || []);
      if (!crmSession) {
        el.innerHTML = crmMsg;
        return;
      }
      el.innerHTML =
        crmMsg +
        '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;line-height:1.5;">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:4px;">GA4 attribution snapshot</div>' +
        '<div>Source / Medium: <strong style="color:var(--text);">' +
        escapeHtml((crmSession.source || '—') + ' / ' + (crmSession.medium || '—')) +
        '</strong></div>' +
        '<div>Campaign: <strong style="color:var(--text);">' + escapeHtml(crmSession.campaign || '—') + '</strong></div>' +
        '<div>Ad group: <strong style="color:var(--text);">' + escapeHtml(crmSession.adGroup || '—') + '</strong></div>' +
        '<div>Ad / content: <strong style="color:var(--text);">' + escapeHtml(crmSession.adContent || '—') + '</strong></div>' +
        '<div>Keyword: <strong style="color:var(--text);">' + escapeHtml(crmSession.keyword || '—') + '</strong></div>' +
        '<div>Landing page: <strong style="color:var(--text);">' + escapeHtml(crmSession.landingPage || '—') + '</strong></div>' +
        '<div style="color:var(--text3);margin-top:4px;">Matched by ga_client_id <code style="font-size:11px;">' +
        escapeHtml(crmSession.clientId || '') +
        '</code></div>' +
        '</div>';
      return;
    }
    if (lead.recordSource === 'import') {
      var impMsg =
        '<span style="font-weight:600;color:var(--text);">Attribution import</span> — stored in <code style="font-size:11px;">attribution_leads</code> (or local only if offline / not signed in). Editable; CRM sync will not restore deleted rows.';
      var impSession = getSessionDataForClient(lead.clientId, runtimeGa4Rows || []);
      if (!impSession) {
        el.innerHTML = impMsg;
        return;
      }
      el.innerHTML =
        impMsg +
        '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;line-height:1.5;">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:4px;">GA4 attribution snapshot</div>' +
        '<div>Source / Medium: <strong style="color:var(--text);">' +
        escapeHtml((impSession.source || '—') + ' / ' + (impSession.medium || '—')) +
        '</strong></div>' +
        '<div>Campaign: <strong style="color:var(--text);">' + escapeHtml(impSession.campaign || '—') + '</strong></div>' +
        '<div>Ad group: <strong style="color:var(--text);">' + escapeHtml(impSession.adGroup || '—') + '</strong></div>' +
        '<div>Ad / content: <strong style="color:var(--text);">' + escapeHtml(impSession.adContent || '—') + '</strong></div>' +
        '<div>Keyword: <strong style="color:var(--text);">' + escapeHtml(impSession.keyword || '—') + '</strong></div>' +
        '<div>Landing page: <strong style="color:var(--text);">' + escapeHtml(impSession.landingPage || '—') + '</strong></div>' +
        '<div style="color:var(--text3);margin-top:4px;">Matched by ga_client_id <code style="font-size:11px;">' +
        escapeHtml(impSession.clientId || '') +
        '</code></div>' +
        '</div>';
      return;
    }
    var msg =
      '<span style="font-weight:600;color:var(--text);">Added in Runway</span> — editable. Cloud rows live in <code style="font-size:11px;">attribution_leads</code> when signed in.';
    var sess = getSessionDataForClient(lead.clientId, runtimeGa4Rows || []);
    if (!sess) {
      el.innerHTML = msg;
      return;
    }
    el.innerHTML =
      msg +
      '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;line-height:1.5;">' +
      '<div style="font-weight:600;color:var(--text);margin-bottom:4px;">GA4 attribution snapshot</div>' +
      '<div>Source / Medium: <strong style="color:var(--text);">' +
      escapeHtml((sess.source || '—') + ' / ' + (sess.medium || '—')) +
      '</strong></div>' +
      '<div>Campaign: <strong style="color:var(--text);">' + escapeHtml(sess.campaign || '—') + '</strong></div>' +
      '<div>Ad group: <strong style="color:var(--text);">' + escapeHtml(sess.adGroup || '—') + '</strong></div>' +
      '<div>Ad / content: <strong style="color:var(--text);">' + escapeHtml(sess.adContent || '—') + '</strong></div>' +
      '<div>Keyword: <strong style="color:var(--text);">' + escapeHtml(sess.keyword || '—') + '</strong></div>' +
      '<div>Landing page: <strong style="color:var(--text);">' + escapeHtml(sess.landingPage || '—') + '</strong></div>' +
      '<div style="color:var(--text3);margin-top:4px;">Matched by ga_client_id <code style="font-size:11px;">' +
      escapeHtml(sess.clientId || '') +
      '</code></div>' +
      '</div>';
  }

  function applyLeadModalFieldLocks(lead, isNew) {
    var locked = !isNew && lead && lead.recordSource === 'crm';
    ['lead-field-name', 'lead-field-keyword', 'lead-field-date'].forEach(function (id) {
      var n = $(id);
      if (n) {
        n.readOnly = !!locked;
        n.style.opacity = locked ? '0.88' : '';
      }
    });
    var st = $('lead-field-status');
    if (st) {
      st.disabled = !!locked;
      st.style.opacity = locked ? '0.88' : '';
    }
    var pay = $('lead-field-payment');
    if (pay) {
      pay.readOnly = !!locked;
      pay.style.opacity = locked ? '0.88' : '';
    }
    var cid = $('lead-field-clientid');
    var btnCh = $('btn-lead-change-clientid');
    if (cid) {
      if (isNew) {
        cid.readOnly = false;
        cid.style.opacity = '';
        if (btnCh) btnCh.style.display = 'none';
      } else {
        cid.readOnly = true;
        cid.style.opacity = '';
        if (btnCh) btnCh.style.display = 'inline-block';
      }
    }
    var del = $('btn-lead-delete');
    if (del) {
      var canDel =
        !isNew &&
        lead &&
        (lead.recordSource === 'import' || lead.recordSource === 'manual') &&
        !lead.demoFromDb;
      del.style.display = canDel ? 'inline-block' : 'none';
    }
  }

  function closeGaClientIdWizard() {
    gaClientIdWizardStep = 0;
    closeModal('leadGaClientIdModal');
  }

  function renderGaClientIdWizardStep() {
    var title = $('lead-gaid-title');
    var body = $('lead-gaid-step-content');
    var wrap = $('lead-gaid-input-wrap');
    var back = $('lead-gaid-btn-back');
    var primary = $('lead-gaid-btn-primary');
    if (!title || !body || !wrap || !back || !primary) return;
    if (gaClientIdWizardStep === 1) {
      title.textContent = 'Change GA4 Client ID?';
      body.innerHTML =
        'Changing this ID can break <strong>attribution</strong> if it no longer matches GA4 or your CRM. Sessions, conversions, and joins may point at the wrong record.';
      wrap.style.display = 'none';
      back.style.display = 'none';
      primary.textContent = 'Continue';
      return;
    }
    if (gaClientIdWizardStep === 2) {
      title.textContent = 'New Client ID';
      body.innerHTML = 'Enter the <code style="font-size:11px;">ga_client_id</code> to store on this lead.';
      wrap.style.display = 'block';
      var inp = $('lead-gaid-input');
      if (inp) {
        inp.value = ($('lead-field-clientid') && $('lead-field-clientid').value) || '';
        setTimeout(function () {
          inp.focus();
        }, 50);
      }
      back.style.display = 'inline-block';
      primary.textContent = 'Confirm';
      return;
    }
  }

  function openGaClientIdWizard() {
    gaClientIdWizardStep = 1;
    renderGaClientIdWizardStep();
    openModal('leadGaClientIdModal');
  }

  function openLeadModal(leadId) {
    var isNew = !leadId;
    var lead = isNew
      ? { name: '', status: 'lead', paymentAmount: null, searchKeyword: '', clientId: null, campaignId: null, dateAdded: new Date().toISOString().slice(0, 10), recordSource: 'manual' }
      : state.leads.find(function (l) { return l.id === leadId; });
    if (!lead) return;
    leadModalContext = { lead: lead, isNew: isNew };
    $('lead-modal-title').textContent = isNew ? 'Add lead / client' : 'Edit lead / client';
    $('lead-edit-id').value = isNew ? '' : lead.id;
    $('lead-field-name').value = lead.name || '';
    $('lead-field-status').value = lead.status || 'lead';
    $('lead-field-payment').value = lead.paymentAmount != null ? lead.paymentAmount : '';
    $('lead-field-keyword').value = lead.searchKeyword || '';
    $('lead-field-clientid').value = lead.clientId != null ? lead.clientId : '';
    $('lead-field-date').value = lead.dateAdded || '';
    var cs = $('lead-field-campaign');
    cs.innerHTML = '<option value="">— Unassigned —</option>' + state.campaigns.map(function (c) {
      return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
    }).join('');
    cs.value = lead.campaignId || '';
    cs.disabled = false;
    cs.style.opacity = '';
    $('lead-payment-wrap').style.display = lead.status === 'closed' ? 'block' : 'none';
    updateLeadSourceFooter(lead, isNew);
    applyLeadModalFieldLocks(lead, isNew);
    openModal('leadClientModal');
    if (!isDemoUser()) {
      maybeRefreshGa4IfStale()
        .then(function () {
          if (leadModalContext && leadModalContext.lead && $('leadClientModal') && $('leadClientModal').classList.contains('on')) {
            updateLeadSourceFooter(leadModalContext.lead, !!leadModalContext.isNew);
          }
        })
        .catch(function () {});
    }
  }

  function openCampaignModal(campaignId) {
    var isNew = !campaignId;
    var c = isNew ? { name: '', channelType: 'Google Ads', spend: 0 } : state.campaigns.find(function (x) { return x.id === campaignId; });
    if (!c) return;
    $('campaign-mvp-title').textContent = isNew ? 'Add campaign' : 'Edit campaign';
    $('campaign-mvp-edit-id').value = isNew ? '' : c.id;
    $('campaign-mvp-name').value = c.name || '';
    $('campaign-mvp-channel').innerHTML = CHANNELS.map(function (ch) {
      return '<option value="' + escapeHtml(ch) + '"' + (c.channelType === ch ? ' selected' : '') + '>' + escapeHtml(ch) + '</option>';
    }).join('');
    $('campaign-mvp-spend').value = c.spend != null ? c.spend : '';
    openModal('campaignMvpModal');
  }

  function parseCsv(text) {
    var rows = [];
    var i = 0;
    var cur = [];
    var cell = '';
    var inQ = false;
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        cell += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (ch === ',') {
        cur.push(cell);
        cell = '';
        i++;
        continue;
      }
      if (ch === '\r') {
        i++;
        continue;
      }
      if (ch === '\n') {
        cur.push(cell);
        rows.push(cur);
        cur = [];
        cell = '';
        i++;
        continue;
      }
      cell += ch;
      i++;
    }
    cur.push(cell);
    rows.push(cur);
    while (rows.length && rows[rows.length - 1].every(function (x) { return String(x).trim() === ''; })) {
      rows.pop();
    }
    return rows;
  }

  var importCtx = { headers: [], rows: [], mapping: {} };

  function resetImportWizard() {
    importCtx = { headers: [], rows: [], mapping: {} };
    $('csv-import-step1').style.display = 'block';
    $('csv-import-step2').style.display = 'none';
    $('csv-import-step3').style.display = 'none';
    $('csv-import-step3').style.flexDirection = '';
    $('csv-import-file').value = '';
    $('csv-import-paste').value = '';
    $('csv-import-next').textContent = 'Next';
    $('csv-import-next').style.display = 'inline-block';
    $('csv-import-back').style.display = 'none';
    $('csv-import-commit').style.display = 'none';
  }

  function fillMappingSelects() {
    var keys = ['name', 'status', 'payment', 'keyword', 'campaign', 'dateAdded'];
    keys.forEach(function (key) {
      var sel = $('map-' + key);
      if (!sel) return;
      var opts = '<option value="">— Skip —</option>';
      importCtx.headers.forEach(function (h, idx) {
        opts += '<option value="' + idx + '">' + escapeHtml(h) + '</option>';
      });
      sel.innerHTML = opts;
      var guess = importCtx.headers.findIndex(function (h) {
        var t = String(h).toLowerCase();
        if (key === 'name') return /name|company|client|account/i.test(t);
        if (key === 'status') return /status|stage|state/i.test(t);
        if (key === 'payment') return /payment|amount|revenue|value|deal/i.test(t);
        if (key === 'keyword') return /keyword|search|query/i.test(t);
        if (key === 'campaign') return /campaign|utm|program/i.test(t);
        if (key === 'dateAdded') return /date|added|created/i.test(t);
        return false;
      });
      sel.value = guess >= 0 ? String(guess) : '';
    });
  }

  function buildPreviewRows() {
    var m = {
      name: $('map-name').value,
      status: $('map-status').value,
      payment: $('map-payment').value,
      keyword: $('map-keyword').value,
      campaign: $('map-campaign').value,
      dateAdded: $('map-dateAdded').value,
    };
    function col(row, idx) {
      if (idx === '' || idx == null) return '';
      var i = parseInt(idx, 10);
      return row[i] != null ? String(row[i]).trim() : '';
    }
    var preview = [];
    for (var r = 0; r < Math.min(8, importCtx.rows.length); r++) {
      var row = importCtx.rows[r];
      var name = col(row, m.name) || '—';
      var st = col(row, m.status).toLowerCase();
      var status = st.indexOf('close') !== -1 || st === 'won' || st === 'sold' ? 'closed' : 'lead';
      var payRaw = col(row, m.payment).replace(/[$,]/g, '');
      var pay = payRaw ? parseFloat(payRaw) : null;
      if (status !== 'closed') pay = null;
      preview.push({ name: name, status: status, payment: pay, keyword: col(row, m.keyword), campaign: col(row, m.campaign), dateAdded: col(row, m.dateAdded) });
    }
    return preview;
  }

  function renderImportPreview() {
    var prev = buildPreviewRows();
    var tb = $('csv-import-preview-body');
    tb.innerHTML = prev
      .map(function (p) {
        return (
          '<tr><td>' +
          escapeHtml(p.name) +
          '</td><td>' +
          escapeHtml(p.status) +
          '</td><td>' +
          escapeHtml(p.payment != null ? fmtMoney(p.payment) : '—') +
          '</td><td>' +
          escapeHtml(p.keyword) +
          '</td><td>' +
          escapeHtml(p.campaign) +
          '</td><td>' +
          escapeHtml(p.dateAdded) +
          '</td></tr>'
        );
      })
      .join('');
  }

  function resolveCampaignByName(name) {
    if (!name || !String(name).trim()) return null;
    var t = String(name).trim().toLowerCase();
    var c = state.campaigns.find(function (x) { return x.name.toLowerCase() === t; });
    if (c) return c.id;
    var nc = { id: uid('camp'), name: String(name).trim(), channelType: 'Other', spend: 0, clientIds: [] };
    state.campaigns.push(nc);
    return nc.id;
  }

  function commitImport() {
    var m = {
      name: $('map-name').value,
      status: $('map-status').value,
      payment: $('map-payment').value,
      keyword: $('map-keyword').value,
      campaign: $('map-campaign').value,
      dateAdded: $('map-dateAdded').value,
    };
    if (!m.name) {
      alert('Please map a column to Name.');
      return;
    }
    function col(row, idx) {
      if (idx === '' || idx == null) return '';
      var i = parseInt(idx, 10);
      return row[i] != null ? String(row[i]).trim() : '';
    }
    var bulkRows = [];
    var localLeads = [];
    importCtx.rows.forEach(function (row) {
      var name = col(row, m.name);
      if (!name) return;
      var st = col(row, m.status).toLowerCase();
      var status = st.indexOf('close') !== -1 || st === 'won' || st === 'sold' ? 'closed' : 'lead';
      var payRaw = col(row, m.payment).replace(/[$,]/g, '');
      var pay = payRaw ? parseFloat(payRaw) : null;
      if (status !== 'closed') pay = null;
      var campName = col(row, m.campaign);
      var campaignId = resolveCampaignByName(campName);
      var dateAdded = col(row, m.dateAdded) || new Date().toISOString().slice(0, 10);
      var campObj = campaignById(campaignId);
      var utmCampaign = campObj ? campObj.name : String(campName || '').trim();
      bulkRows.push({
        companyName: name,
        utmCampaign: utmCampaign,
        searchKeyword: col(row, m.keyword) || '',
        purchased: status === 'closed',
        purchaseAmount: status === 'closed' && pay != null ? pay : 0,
        submittedAt: dateAdded,
        gaClientId: '',
        mvpCampaignId: campaignId,
      });
      localLeads.push({
        id: uid('lead'),
        name: name,
        status: status,
        paymentAmount: pay,
        searchKeyword: col(row, m.keyword) || null,
        clientId: null,
        campaignId: campaignId,
        dateAdded: dateAdded,
        recordSource: 'import',
      });
    });
    var added = bulkRows.length;
    if (!added) {
      alert('No rows to import.');
      return;
    }

    function applyLocalFallback() {
      localLeads.forEach(function (l) {
        state.leads.push(l);
      });
      syncCampaignClientIds();
      saveState();
      closeModal('connectionsCsvModal');
      resetImportWizard();
      window.nav('leads', null);
      renderLeadsPage();
      renderCampaignsPage();
      alert('Imported ' + added + ' row(s) locally (cloud save unavailable).');
    }

    var supabase = window.supabaseClient;
    var orgId = currentOrganizationId();
    if (!supabase || !orgId || isDemoUser()) {
      applyLocalFallback();
      return;
    }

    supabase.auth.getSession().then(function (sessRes) {
      var sess = sessRes.data && sessRes.data.session;
      if (!sess || !sess.access_token) {
        applyLocalFallback();
        return;
      }
      return supabase.functions.invoke('attribution-leads-import-bulk', {
        body: { organizationId: orgId, rows: bulkRows, importSource: 'csv' },
        headers: { Authorization: 'Bearer ' + sess.access_token },
      }).then(function (res) {
        if (res.error) throw res.error;
        var d = res.data || {};
        if (!d.ok) throw new Error(String(d.error || 'Import failed'));
        return hydrateStateFromSupabase();
      }).then(function () {
        closeModal('connectionsCsvModal');
        resetImportWizard();
        window.nav('leads', null);
        renderAfterHydrate();
        alert('Imported ' + added + ' row(s) to attribution_leads.');
      }).catch(function (err) {
        console.error('agency-mvp: CSV cloud import', err);
        applyLocalFallback();
      });
    });
  }

  function init() {
    wireModalBackdrop('leadClientModal');
    wireModalBackdrop('leadGaClientIdModal');
    wireModalBackdrop('campaignMvpModal');
    wireModalBackdrop('connectionsCsvModal');
    wireModalBackdrop('stubFeatureModal');
    wireSidebarUserMenu();

    $('stubFeatureOk').addEventListener('click', function () {
      closeModal('stubFeatureModal');
    });

    $('btn-add-lead').addEventListener('click', function () {
      openLeadModal(null);
    });
    $('btn-add-campaign').addEventListener('click', function () {
      openCampaignModal(null);
    });

    $('lead-field-status').addEventListener('change', function () {
      $('lead-payment-wrap').style.display = $('lead-field-status').value === 'closed' ? 'block' : 'none';
    });

    $('btn-lead-change-clientid').addEventListener('click', function () {
      openGaClientIdWizard();
    });

    $('lead-gaid-btn-cancel').addEventListener('click', function () {
      closeGaClientIdWizard();
    });
    $('lead-gaid-btn-back').addEventListener('click', function () {
      if (gaClientIdWizardStep === 2) {
        gaClientIdWizardStep = 1;
        renderGaClientIdWizardStep();
      }
    });
    $('lead-gaid-btn-primary').addEventListener('click', function () {
      if (gaClientIdWizardStep === 1) {
        gaClientIdWizardStep = 2;
        renderGaClientIdWizardStep();
        return;
      }
      if (gaClientIdWizardStep === 2) {
        var v = ($('lead-gaid-input') && $('lead-gaid-input').value.trim()) || '';
        if ($('lead-field-clientid')) $('lead-field-clientid').value = v;
        closeGaClientIdWizard();
      }
    });

    $('btn-lead-save').addEventListener('click', function () {
      var id = $('lead-edit-id').value;
      var prev = id ? state.leads.find(function (l) { return l.id === id; }) : null;
      var name = $('lead-field-name').value.trim();
      if (!name) {
        alert('Name is required.');
        return;
      }
      var status = $('lead-field-status').value;
      var payStr = $('lead-field-payment').value.trim();
      var paymentAmount = status === 'closed' && payStr ? parseFloat(payStr) : null;
      if (status === 'closed' && payStr && !isFinite(paymentAmount)) {
        alert('Enter a valid payment amount for closed sales.');
        return;
      }
      var campaignId = $('lead-field-campaign').value || null;
      var clientIdVal = $('lead-field-clientid').value.trim() || null;
      var rec = {
        id: id || uid('lead'),
        name: name,
        status: status,
        paymentAmount: paymentAmount,
        searchKeyword: $('lead-field-keyword').value.trim() || null,
        clientId: clientIdVal,
        campaignId: campaignId,
        dateAdded: $('lead-field-date').value || new Date().toISOString().slice(0, 10),
        recordSource: prev && prev.recordSource ? prev.recordSource : 'manual',
      };
      if (prev && prev.recordSource === 'crm') {
        rec.name = prev.name;
        rec.status = prev.status;
        rec.paymentAmount = prev.paymentAmount;
        rec.searchKeyword = prev.searchKeyword;
        rec.dateAdded = prev.dateAdded;
        rec.recordSource = 'crm';
        rec.clientId = clientIdVal;
        rec.campaignId = campaignId;
      }
      if (!id) {
        rec.recordSource = 'manual';
      }
      if (prev && prev.demoFromDb) {
        rec.demoFromDb = true;
      }

      var btn = $('btn-lead-save');
      if (btn) btn.disabled = true;
      persistLeadToCloud(rec, prev || null)
        .then(function (newId) {
          if (newId && String(newId) !== String(rec.id)) {
            rec.id = String(newId);
            if (rec.attributionLeadId == null && isLikelyUuid(rec.id)) {
              rec.attributionLeadId = rec.id;
            }
          }
          if (id) {
            var ix = state.leads.findIndex(function (l) {
              return l.id === id;
            });
            if (ix >= 0) state.leads[ix] = rec;
          } else {
            state.leads.push(rec);
          }
          syncCampaignClientIds();
          saveState();
          closeModal('leadClientModal');
          renderLeadsPage();
          renderCampaignsPage();
        })
        .catch(function (err) {
          console.error('agency-mvp: persist lead', err);
          alert(err.message || String(err));
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    });
    $('btn-lead-cancel').addEventListener('click', function () {
      closeModal('leadClientModal');
    });

    $('btn-lead-delete').addEventListener('click', function () {
      var id = $('lead-edit-id').value;
      if (!id) return;
      var prev = state.leads.find(function (l) { return l.id === id; });
      if (!prev || (prev.recordSource !== 'import' && prev.recordSource !== 'manual')) return;
      if (!confirm('Delete this record from Runway? This cannot be undone.')) return;
      function removeFromUi() {
        state.leads = state.leads.filter(function (l) {
          return l.id !== id;
        });
        syncCampaignClientIds();
        saveState();
        closeModal('leadClientModal');
        renderLeadsPage();
        renderCampaignsPage();
      }
      var orgId = currentOrganizationId();
      var sb = window.supabaseClient;
      if (isDemoUser()) {
        if (!isLikelyUuid(id)) {
          removeFromUi();
          return;
        }
        persistDemoMvpDeleteIds([id])
          .then(function () {
            removeFromUi();
          })
          .catch(function (e) {
            alert(e.message || String(e));
          });
        return;
      }
      if (sb && orgId && (prev.recordSource === 'import' || prev.recordSource === 'manual')) {
        if (!isLikelyUuid(id)) {
          removeFromUi();
          return;
        }
        sb.auth.getSession().then(function (sessRes) {
          var sess = sessRes.data && sessRes.data.session;
          if (!sess || !sess.access_token) {
            removeFromUi();
            return;
          }
          sb.from('attribution_leads')
            .delete()
            .eq('id', id)
            .eq('organization_id', orgId)
            .then(function (res) {
              if (res.error) console.error('agency-mvp: delete attribution_lead', res.error);
              removeFromUi();
            });
        });
        return;
      }
      removeFromUi();
    });

    $('btn-campaign-mvp-save').addEventListener('click', function () {
      var id = $('campaign-mvp-edit-id').value;
      var name = $('campaign-mvp-name').value.trim();
      if (!name) {
        alert('Campaign name is required.');
        return;
      }
      var spend = parseFloat($('campaign-mvp-spend').value);
      if (!isFinite(spend) || spend < 0) spend = 0;
      var channelType = $('campaign-mvp-channel').value;
      if (id) {
        var c = state.campaigns.find(function (x) { return x.id === id; });
        if (c) {
          c.name = name;
          c.channelType = channelType;
          c.spend = spend;
        }
      } else {
        state.campaigns.push({ id: uid('camp'), name: name, channelType: channelType, spend: spend, clientIds: [] });
      }
      syncCampaignClientIds();
      saveState();
      closeModal('campaignMvpModal');
      renderCampaignsPage();
      renderLeadsPage();
    });
    $('btn-campaign-mvp-cancel').addEventListener('click', function () {
      closeModal('campaignMvpModal');
    });

    $('btn-camp-ga4-apply').addEventListener('click', function () {
      var s = $('camp-ga4-start') && $('camp-ga4-start').value;
      var e = $('camp-ga4-end') && $('camp-ga4-end').value;
      if (!s || !e) {
        alert('Choose a date range.');
        return;
      }
      refreshGa4Report(s, e)
        .then(function () {
          renderCampaignsPage();
        })
        .catch(function (err) {
          alert(err.message || String(err));
        });
    });

    $('btn-ga4-connect').addEventListener('click', function () {
      var errEl = $('conn-ga4-connect-err');
      if (errEl) errEl.textContent = '';
      var propertyId = ($('conn-ga4-property-id') && $('conn-ga4-property-id').value.trim()) || '';
      var file = $('conn-ga4-sa-file') && $('conn-ga4-sa-file').files && $('conn-ga4-sa-file').files[0];
      var paste = ($('conn-ga4-sa-paste') && $('conn-ga4-sa-paste').value.trim()) || '';

      function doConnect(jsonText) {
        var cred;
        try {
          cred = JSON.parse(jsonText);
        } catch (e) {
          if (errEl) errEl.textContent = 'Invalid JSON.';
          return;
        }
        fetchJson('/api/ga4/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: currentOrganizationId(), propertyId: propertyId, credentials: cred }),
        })
          .then(function (j) {
            if (!j || !j.success) {
              if (errEl) errEl.textContent = (j && j.error) || 'Connect failed';
              return;
            }
            return refreshGa4Status().then(function () {
              return refreshGa4Report(
                ($('camp-ga4-start') && $('camp-ga4-start').value) || defaultGa4Range().start,
                ($('camp-ga4-end') && $('camp-ga4-end').value) || defaultGa4Range().end
              );
            }).then(function () {
              renderConnectionsPage();
              renderCampaignsPage();
              if ($('conn-ga4-sa-paste')) $('conn-ga4-sa-paste').value = '';
              if ($('conn-ga4-sa-file')) $('conn-ga4-sa-file').value = '';
            });
          })
          .catch(function (e) {
            if (errEl) errEl.textContent = e.message || String(e);
          });
      }

      if (file) {
        var fr = new FileReader();
        fr.onload = function () {
          doConnect(fr.result || '');
        };
        fr.readAsText(file);
      } else if (paste) {
        doConnect(paste);
      } else {
        if (errEl) errEl.textContent = 'Upload a service account JSON file or paste its contents.';
      }
    });

    $('btn-ga4-sync-now').addEventListener('click', function () {
      var r = defaultGa4Range();
      var s = ($('camp-ga4-start') && $('camp-ga4-start').value) || r.start;
      var e = ($('camp-ga4-end') && $('camp-ga4-end').value) || r.end;
      refreshGa4Report(s, e)
        .then(function () {
          renderConnectionsPage();
          renderCampaignsPage();
        })
        .catch(function (err) {
          alert(err.message || String(err));
        });
    });

    $('btn-ga4-disconnect').addEventListener('click', function () {
      fetchJson('/api/ga4/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: currentOrganizationId(), disconnect: true }),
      })
        .then(function () {
          runtimeGa4Rows = null;
          ga4ClientLastFetchAt = 0;
          return refreshGa4Status();
        })
        .then(function () {
          renderConnectionsPage();
          renderCampaignsPage();
          var tb = $('campaigns-ga4-toolbar');
          if (tb) tb.style.display = 'none';
        })
        .catch(function (err) {
          alert(err.message || String(err));
        });
    });

    var crmInternalBtn = $('btn-crm-connect-internal');
    if (crmInternalBtn) {
      crmInternalBtn.addEventListener('click', function () {
        saveCrmSource('internal');
        hydrateStateFromSupabase().then(function () {
          renderConnectionsPage();
          renderLeadsPage();
          renderCampaignsPage();
        });
      });
    }
    var crmSalesforceBtn = $('btn-crm-connect-salesforce');
    if (crmSalesforceBtn) {
      crmSalesforceBtn.addEventListener('click', function () {
        saveCrmSource('salesforce');
        state = stateFromUploadedLeadsOnly(state);
        saveState();
        renderConnectionsPage();
        renderLeadsPage();
        renderCampaignsPage();
      });
    }
    var crmDisconnectBtn = $('btn-crm-disconnect');
    if (crmDisconnectBtn) {
      crmDisconnectBtn.addEventListener('click', function () {
        saveCrmSource('none');
        state = stateFromUploadedLeadsOnly(state);
        saveState();
        renderConnectionsPage();
        renderLeadsPage();
        renderCampaignsPage();
      });
    }

    ['lead-filter-status', 'lead-filter-campaign', 'lead-filter-from', 'lead-filter-to'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', renderLeadsPage);
      if (el && el.tagName === 'INPUT') el.addEventListener('input', renderLeadsPage);
    });

    $('btn-conn-csv-open').addEventListener('click', function () {
      resetImportWizard();
      openModal('connectionsCsvModal');
    });

    $('csv-import-next').addEventListener('click', function () {
      var step1 = $('csv-import-step1');
      var step2 = $('csv-import-step2');
      var step3 = $('csv-import-step3');
      if (step1.style.display !== 'none') {
        var file = $('csv-import-file').files && $('csv-import-file').files[0];
        var paste = $('csv-import-paste').value.trim();
        var textP = new Promise(function (res) {
          if (file) {
            var fr = new FileReader();
            fr.onload = function () {
              res(fr.result || '');
            };
            fr.readAsText(file);
          } else {
            res(paste);
          }
        });
        textP.then(function (text) {
          if (!text || !String(text).trim()) {
            alert('Paste CSV text or choose a file.');
            return;
          }
          var rows = parseCsv(String(text).replace(/^\uFEFF/, ''));
          if (!rows.length) {
            alert('No rows found.');
            return;
          }
          importCtx.headers = rows[0].map(function (h) { return String(h).trim(); });
          importCtx.rows = rows.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
          if (!importCtx.rows.length) {
            alert('No data rows after the header.');
            return;
          }
          fillMappingSelects();
          step1.style.display = 'none';
          step2.style.display = 'block';
          $('csv-import-back').style.display = 'inline-block';
          $('csv-import-next').textContent = 'Preview';
        });
        return;
      }
      if (step2.style.display !== 'none') {
        if (!$('map-name').value) {
          alert('Map the Name column.');
          return;
        }
        step2.style.display = 'none';
        step3.style.display = 'flex';
        step3.style.flexDirection = 'column';
        renderImportPreview();
        $('csv-import-next').style.display = 'none';
        $('csv-import-commit').style.display = 'inline-block';
        return;
      }
    });

    $('csv-import-back').addEventListener('click', function () {
      var step1 = $('csv-import-step1');
      var step2 = $('csv-import-step2');
      var step3 = $('csv-import-step3');
      if (step3.style.display !== 'none') {
        step3.style.display = 'none';
        step3.style.flexDirection = '';
        step2.style.display = 'block';
        $('csv-import-next').style.display = 'inline-block';
        $('csv-import-commit').style.display = 'none';
        return;
      }
      if (step2.style.display !== 'none') {
        step2.style.display = 'none';
        step1.style.display = 'block';
        $('csv-import-back').style.display = 'none';
        $('csv-import-next').textContent = 'Next';
      }
    });

    $('csv-import-cancel').addEventListener('click', function () {
      closeModal('connectionsCsvModal');
      resetImportWizard();
    });

    $('csv-import-commit').addEventListener('click', commitImport);

    ['map-name', 'map-status', 'map-payment', 'map-keyword', 'map-campaign', 'map-dateAdded'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', renderImportPreview);
    });

    Promise.resolve()
      .then(function () {
        return hydrateStateFromSupabase();
      })
      .then(function () {
        if (isDemoUser()) {
          saveCrmSource('internal');
          crmSource = 'internal';
          seedDemoGa4RuntimeRows();
        }
        renderLeadsPage();
        renderCampaignsPage();
        renderConnectionsPage();
      })
      .catch(function () {})
      .then(function () {
        return refreshGa4Status();
      })
      .then(function () {
        if (ga4ServerConnected) {
          var r = defaultGa4Range();
          if ($('camp-ga4-start')) {
            if (!$('camp-ga4-start').value) $('camp-ga4-start').value = r.start;
            if (!$('camp-ga4-end').value) $('camp-ga4-end').value = r.end;
          }
          return refreshGa4Report(
            ($('camp-ga4-start') && $('camp-ga4-start').value) || r.start,
            ($('camp-ga4-end') && $('camp-ga4-end').value) || r.end
          );
        }
      })
      .catch(function () {})
      .then(function () {
        window.nav('leads', document.querySelector('.sb-nav .ni[data-nav="leads"]'));
      });

    var ga4VisTimer = null;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (ga4VisTimer) clearTimeout(ga4VisTimer);
      ga4VisTimer = setTimeout(function () {
        refreshGa4Status()
          .then(function () {
            return maybeRefreshGa4IfStale();
          })
          .then(function () {
            renderCampaignsPage();
            renderConnectionsPage();
            var pg = document.querySelector('.pg.on');
            if (pg && pg.id === 'page-leads') renderLeadsPage();
          })
          .catch(function () {});
      }, 1500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
