// financial-core.js
// Standalone financial data layer: transactions are the single source of truth.

(function () {
  'use strict';

  // Supabase client/user (set by supabase-auth.js when available)
  var supabase = window.supabaseClient || null;
  var currentUser = window.currentUser || null;

  var STORAGE_KEY = 'transactions:v1';
  // Ids the user deleted locally; applied after remote merge so a row does not reappear in the ledger (expenses + transaction log) if the server delete lags or fails once.
  var TX_DELETED_IDS_KEY = 'tx-deleted-ids:v1';

  function storageKey(suffix) {
    var activeUser = window.currentUser || currentUser;
    var scopeUser = activeUser && activeUser.id ? String(activeUser.id) : 'guest';
    var oid = window.currentOrganizationId;
    var scopeOrg = oid && String(oid).trim() ? String(oid).trim() : 'noorg';
    return 'bizdash:' + scopeUser + ':' + scopeOrg + ':' + suffix;
  }

  function loadDeletedTxIdMap() {
    try {
      var raw = localStorage.getItem(storageKey(TX_DELETED_IDS_KEY));
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function saveDeletedTxIdMap(map) {
    try {
      localStorage.setItem(storageKey(TX_DELETED_IDS_KEY), JSON.stringify(map || {}));
    } catch (_) {}
  }

  function markTransactionsDeletedLocally(ids) {
    if (!ids || !ids.length) return;
    var m = loadDeletedTxIdMap();
    var ts = Date.now();
    ids.forEach(function (id) {
      if (id) m[id] = ts;
    });
    saveDeletedTxIdMap(m);
  }

  function pruneDeletedTxMarksAbsentFromRemote(remoteList) {
    var remoteIds = {};
    (remoteList || []).forEach(function (r) {
      if (r && r.id) remoteIds[r.id] = true;
    });
    var m = loadDeletedTxIdMap();
    var changed = false;
    Object.keys(m).forEach(function (id) {
      if (!remoteIds[id]) {
        delete m[id];
        changed = true;
      }
    });
    if (changed) saveDeletedTxIdMap(m);
  }

  function omitLocallyDeletedTransactions(list) {
    var m = loadDeletedTxIdMap();
    return (list || []).filter(function (tx) {
      return tx && tx.id && !m[tx.id];
    });
  }

  // ---------- Data model ----------

  function loadTransactions() {
    try {
      var raw = localStorage.getItem(storageKey(STORAGE_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveTransactions(list) {
    try {
      localStorage.setItem(storageKey(STORAGE_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
  }

  /** UUID shape Postgres accepts (any version nibble); looser than isUuid(). */
  function isUuidForDb(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim());
  }

  function buildClientMetadata(client) {
    var out = {};
    if (client.custTabRevenue != null && isFinite(Number(client.custTabRevenue))) {
      out.custTabRevenue = Math.max(0, Number(client.custTabRevenue));
    }
    if (client.custTabAllocatedCost != null && isFinite(Number(client.custTabAllocatedCost))) {
      out.custTabAllocatedCost = Math.max(0, Number(client.custTabAllocatedCost));
    }
    [
      'salutation',
      'firstName',
      'lastName',
      'title',
      'reportsTo',
      'description',
      'owner',
      'accountName',
      'mailingCountry',
      'mailingStreet',
      'mailingCity',
      'mailingState',
      'mailingZip',
    ].forEach(function (k) {
      var v = client && client[k] != null ? String(client[k]).trim() : '';
      if (v) out[k] = v;
    });
    if (client && client.emailOptOut === true) out.emailOptOut = true;
    return Object.keys(out).length ? out : null;
  }

  function applyClientMetadata(client, meta) {
    var out = Object.assign({}, client);
    delete out.custTabRevenue;
    delete out.custTabAllocatedCost;
    if (!meta || typeof meta !== 'object') return out;
    if (meta.custTabRevenue != null && isFinite(Number(meta.custTabRevenue))) {
      out.custTabRevenue = Math.max(0, Number(meta.custTabRevenue));
    }
    if (meta.custTabAllocatedCost != null && isFinite(Number(meta.custTabAllocatedCost))) {
      out.custTabAllocatedCost = Math.max(0, Number(meta.custTabAllocatedCost));
    }
    [
      'salutation',
      'firstName',
      'lastName',
      'title',
      'reportsTo',
      'description',
      'owner',
      'accountName',
      'mailingCountry',
      'mailingStreet',
      'mailingCity',
      'mailingState',
      'mailingZip',
    ].forEach(function (k) {
      if (meta[k] != null) out[k] = String(meta[k]);
    });
    if (meta.emailOptOut === true) out.emailOptOut = true;
    return out;
  }

  function buildClientDbPayload(client, userId) {
    var rev = Number(client.totalRevenue);
    if (!isFinite(rev)) rev = 0;
    var createdIso;
    try {
      var d = client.createdAt != null ? new Date(client.createdAt) : new Date();
      createdIso = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    } catch (_) {
      createdIso = new Date().toISOString();
    }
    var row = {
      id: client.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      company_name: client.companyName,
      contact_name: client.contactName,
      status: client.status,
      industry: client.industry,
      email: client.email,
      phone: client.phone,
      notes: client.notes,
      birthday: client.birthday || null,
      communication_style: client.communicationStyle || null,
      preferred_channel: client.preferredChannel || null,
      last_touch_at: client.lastTouchAt || null,
      next_follow_up_at: client.nextFollowUpAt || null,
      relationship_notes: client.relationshipNotes || null,
      total_revenue: rev,
      created_at: createdIso,
      is_retainer: client.retainer === true,
      pipeline_id: client.pipelineId || null,
      pipeline_stage_id: client.pipelineStageId || null,
    };
    var cmeta = buildClientMetadata(client);
    row.metadata = cmeta || {};
    return row;
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // RFC4122-ish fallback for older browsers.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /** Login “View Demo” uses this id so data is isolated from real accounts in localStorage. */
  var DEMO_DASHBOARD_USER_ID = '00000000-0000-4000-8000-000000000001';
  function isDemoDashboardUser() {
    var u = window.currentUser || currentUser;
    return !!(u && u.id === DEMO_DASHBOARD_USER_ID);
  }
  window.DEMO_DASHBOARD_USER_ID = DEMO_DASHBOARD_USER_ID;

  /** Active workspace (set by supabase-auth.js from URL slug + membership). */
  function getCurrentOrgId() {
    var id = window.currentOrganizationId;
    return id && String(id).trim() ? String(id).trim() : null;
  }
  window.bizDashGetCurrentOrgId = getCurrentOrgId;

  /** When set, initDataFromSupabase skips backfill uploads (used with screenshot/mock flows). */
  var SCREENSHOT_NO_CLOUD_KEY = 'bizdash_screenshot_no_cloud';
  function setScreenshotNoCloudUpload(on) {
    try {
      if (on) sessionStorage.setItem(SCREENSHOT_NO_CLOUD_KEY, '1');
      else sessionStorage.removeItem(SCREENSHOT_NO_CLOUD_KEY);
    } catch (_) {}
  }
  function isScreenshotNoCloudUpload() {
    try {
      return sessionStorage.getItem(SCREENSHOT_NO_CLOUD_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  var state = {
    transactions: [],
    filter: { mode: 'all', start: null, end: null }, // all | month | range
    computed: null,
  };

  // ---------- Clients store ----------

  var CLIENTS_KEY = 'clients:v1';
  var CUSTOMERS_COLUMNS_PREFS_KEY = 'customers-columns:v1';
  var CUSTOMERS_COLUMN_DEFS = [
    { id: 'company', label: 'Company', index: 1 },
    { id: 'contact', label: 'Contact', index: 2 },
    { id: 'email', label: 'Email', index: 3 },
    { id: 'phone', label: 'Phone', index: 4 },
    { id: 'preferred', label: 'Preferred', index: 5 },
    { id: 'style', label: 'Style', index: 6 },
    { id: 'status', label: 'Status', index: 7 },
    { id: 'projects', label: 'Projects', index: 8 },
    { id: 'revenue', label: 'Revenue', index: 9 },
    { id: 'allocated', label: 'Allocated cost', index: 10 },
    { id: 'profit', label: 'Profit', index: 11 },
    { id: 'margin', label: 'Margin', index: 12 },
    { id: 'roi', label: 'ROI', index: 13 },
    { id: 'actions', label: 'Actions', index: 14, locked: true },
  ];

  function defaultCustomersColumnPrefs() {
    var prefs = {};
    CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
      prefs[col.id] = true;
    });
    return prefs;
  }

  function loadCustomersColumnPrefs() {
    var defaults = defaultCustomersColumnPrefs();
    try {
      var raw = localStorage.getItem(storageKey(CUSTOMERS_COLUMNS_PREFS_KEY));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return defaults;
      CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
        if (col.locked) return;
        if (Object.prototype.hasOwnProperty.call(parsed, col.id)) {
          defaults[col.id] = parsed[col.id] !== false;
        }
      });
      defaults.actions = true;
      return defaults;
    } catch (_) {
      return defaults;
    }
  }

  function saveCustomersColumnPrefs(prefs) {
    try {
      localStorage.setItem(storageKey(CUSTOMERS_COLUMNS_PREFS_KEY), JSON.stringify(prefs || defaultCustomersColumnPrefs()));
    } catch (_) {}
  }

  function loadClients() {
    try {
      var raw = localStorage.getItem(storageKey(CLIENTS_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveClients(list) {
    try {
      localStorage.setItem(storageKey(CLIENTS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var clients = [];
  /** In-memory payload for Advisor “add to CRM” flows (set via window.bizDashSetAdvisorContactContext). */
  var advisorContactContext = null;
  var customersColumnPrefs = loadCustomersColumnPrefs();
  var crmEvents = [];
  var weeklySummaries = [];

  // Project statuses (for Manage statuses modal)
  var STATUS_KEY = 'project-statuses:v1';

  function loadStatuses() {
    try {
      var raw = localStorage.getItem(storageKey(STATUS_KEY));
      if (!raw) {
        return ['Not started', 'In progress', 'Blocked', 'Complete'];
      }
      var arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? arr : ['Not started', 'In progress', 'Blocked', 'Complete'];
    } catch (_) {
      return ['Not started', 'In progress', 'Blocked', 'Complete'];
    }
  }

  function saveStatuses(list) {
    try {
      localStorage.setItem(storageKey(STATUS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var projectStatuses = loadStatuses();

  // Projects store
  var PROJECTS_KEY = 'projects:v1';

  function loadProjects() {
    try {
      var raw = localStorage.getItem(storageKey(PROJECTS_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveProjects(list) {
    try {
      localStorage.setItem(storageKey(PROJECTS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var projects = [];

  // Invoices store
  var INVOICES_KEY = 'invoices:v1';

  function loadInvoices() {
    try {
      var raw = localStorage.getItem(storageKey(INVOICES_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveInvoices(list) {
    try {
      localStorage.setItem(storageKey(INVOICES_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var invoices = [];

  // Marketing campaigns (local only)
  var CAMPAIGNS_KEY = 'campaigns:v1';

  var CAMPAIGN_STATUS_PIPELINE = 'pipeline';
  var CAMPAIGN_STATUS_WON = 'won';
  var CAMPAIGN_STATUS_LOST = 'lost';

  function normalizeCampaign(c) {
    if (!c || typeof c !== 'object') return null;
    var next = Object.assign({}, c);
    if (!next.status || [CAMPAIGN_STATUS_PIPELINE, CAMPAIGN_STATUS_WON, CAMPAIGN_STATUS_LOST].indexOf(next.status) === -1) {
      next.status = CAMPAIGN_STATUS_PIPELINE;
    }
    next.pipelineValue = Math.max(0, Number(next.pipelineValue) || 0);
    return next;
  }

  function loadCampaigns() {
    try {
      var raw = localStorage.getItem(storageKey(CAMPAIGNS_KEY));
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeCampaign).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function saveCampaigns(list) {
    try {
      localStorage.setItem(storageKey(CAMPAIGNS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var campaigns = [];

  // Timesheet entries (local)
  var TIMESHEET_KEY = 'timesheet:v1';

  function loadTimesheetEntries() {
    try {
      var raw = localStorage.getItem(storageKey(TIMESHEET_KEY));
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveTimesheetEntries(list) {
    try {
      localStorage.setItem(storageKey(TIMESHEET_KEY), JSON.stringify(Array.isArray(list) ? list : []));
    } catch (_) {}
  }

  var timesheetEntries = loadTimesheetEntries();
  /** Monday YYYY-MM-DD for timesheet week filter (ISO week starting Monday). */
  var timesheetWeekMondayYmd = null;
  /** 'week' | 'month' | 'quarter' | 'all' */
  var timesheetPeriodMode = 'week';
  /** Calendar month anchor YYYY-MM (first day of month). */
  var timesheetMonthYm = null;
  var timesheetQuarterYear = null;
  /** 1–4 */
  var timesheetQuarterQ = null;

  // ---------- Timesheet entries (Supabase) ----------
  function mapTimesheetRow(row) {
    var w = row.weekdays;
    if (typeof w === 'string') {
      try { w = JSON.parse(w); } catch (_) { w = []; }
    }
    if (!Array.isArray(w)) w = [];
    return {
      id: row.id,
      date: row.date ? String(row.date).slice(0, 10) : '',
      account: row.account || '',
      project: row.project || '',
      task: row.task || '',
      activityCode: row.activity_code || '',
      minutes: Math.max(0, Number(row.minutes) || 0),
      billable: row.billable !== false,
      notes: row.notes || '',
      externalNote: row.external_note || '',
      weekdays: w.map(function (n) { return Number(n); }).filter(function (n) { return !isNaN(n); }),
      createdAt: row.created_at || null,
    };
  }

  function timesheetRowForDb(entry, userId) {
    return {
      id: entry.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      date: entry.date || null,
      account: entry.account || '',
      project: entry.project || '',
      task: entry.task || '',
      activity_code: entry.activityCode || '',
      minutes: Math.max(0, Number(entry.minutes) || 0),
      billable: entry.billable !== false,
      notes: entry.notes || '',
      external_note: entry.externalNote || '',
      weekdays: Array.isArray(entry.weekdays) ? entry.weekdays : [],
      created_at: entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString(),
    };
  }

  async function persistTimesheetEntryToSupabase(entry) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !entry || !entry.id) return;
    try {
      var result = await supabase.from('timesheet_entries').upsert(timesheetRowForDb(entry, currentUser.id), { onConflict: 'id' });
      if (result.error) console.error('upsert timesheet entry error', result.error);
    } catch (err) {
      console.error('persistTimesheetEntryToSupabase error', err);
    }
  }

  async function deleteTimesheetEntryRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !id) return;
    try {
      await supabase.from('timesheet_entries').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteTimesheetEntryRemote error', err);
    }
  }

  async function fetchTimesheetEntriesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadTimesheetEntries();
    try {
      var result = await supabase.from('timesheet_entries').select('*').eq('organization_id', getCurrentOrgId()).order('date', { ascending: false });
      if (result.error) {
        console.error('load timesheet_entries error', result.error);
        return loadTimesheetEntries();
      }
      var rows = result.data || [];
      return rows.map(mapTimesheetRow);
    } catch (err) {
      console.error('fetchTimesheetEntriesFromSupabase error', err);
      return loadTimesheetEntries();
    }
  }

  async function uploadTimesheetEntriesToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = list.map(function (e) { return timesheetRowForDb(e, currentUser.id); });
      var result = await supabase.from('timesheet_entries').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert timesheet_entries error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadTimesheetEntriesToSupabase error', err);
      return false;
    }
  }

  // ---------- Budgets store ----------

  var BUDGETS_KEY = 'budgets:v1';
  var BUDGET_MONTHS_KEY = 'budget_months:v1';

  function loadBudgets() {
    try {
      var raw = localStorage.getItem(storageKey(BUDGETS_KEY));
      var b = raw ? JSON.parse(raw) : {};
      return {
        lab: Math.max(0, Number(b.lab) || 0),
        sw:  Math.max(0, Number(b.sw)  || 0),
        ads: Math.max(0, Number(b.ads) || 0),
        oth: Math.max(0, Number(b.oth) || 0),
      };
    } catch (_) {
      return { lab: 0, sw: 0, ads: 0, oth: 0 };
    }
  }

  function loadBudgetMonthSnapshots() {
    try {
      var raw = localStorage.getItem(storageKey(BUDGET_MONTHS_KEY));
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function budgetSnapshotTotal(s) {
    if (!s || typeof s !== 'object') return 0;
    return Math.max(0, Number(s.lab) || 0) + Math.max(0, Number(s.sw) || 0) +
      Math.max(0, Number(s.ads) || 0) + Math.max(0, Number(s.oth) || 0);
  }

  function saveBudgetMonthSnapshotsToStorage(snaps) {
    try {
      localStorage.setItem(storageKey(BUDGET_MONTHS_KEY), JSON.stringify(snaps && typeof snaps === 'object' ? snaps : {}));
    } catch (_) {}
  }

  function saveBudgets(b) {
    var payload = {
      lab: Math.max(0, Number(b.lab) || 0),
      sw:  Math.max(0, Number(b.sw)  || 0),
      ads: Math.max(0, Number(b.ads) || 0),
      oth: Math.max(0, Number(b.oth) || 0),
    };
    try {
      localStorage.setItem(storageKey(BUDGETS_KEY), JSON.stringify(payload));
    } catch (_) {}
    try {
      var snaps = loadBudgetMonthSnapshots();
      var now = new Date();
      var mk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      snaps[mk] = {
        lab: payload.lab,
        sw: payload.sw,
        ads: payload.ads,
        oth: payload.oth,
        savedAt: new Date().toISOString(),
      };
      saveBudgetMonthSnapshotsToStorage(snaps);
    } catch (_) {}
  }

  var budgets = loadBudgets();

  function getInvoiceByIncomeTxId(txId) {
    return invoices.find(function (inv) { return inv.incomeTxId === txId; }) || null;
  }

  function nextInvoiceNumber() {
    var max = 0;
    invoices.forEach(function (inv) {
      var m = String(inv.number || '').match(/(\d+)$/);
      if (!m) return;
      var n = parseInt(m[1], 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return 'INV-' + String(max + 1).padStart(4, '0');
  }

  // ---------- Shared helpers ----------

  function buildTransactionMetadata(tx) {
    var m = {};
    if (tx.title) m.title = tx.title;
    if (tx.vendor) m.vendor = tx.vendor;
    if (tx.notes) m.notes = tx.notes;
    if (tx.source) m.source = tx.source;
    if (tx.recurrence && typeof tx.recurrence === 'object') m.recurrence = tx.recurrence;
    if (tx.recurrenceSeriesId) m.recurrenceSeriesId = tx.recurrenceSeriesId;
    if (tx.expenseRecurringLead === true) m.expenseRecurringLead = true;
    if (tx.expenseRecurrenceInstance === true) m.expenseRecurrenceInstance = true;
    if (tx.recurring === true) m.recurring = true;
    if (tx.incomeCategoryLabel && String(tx.incomeCategoryLabel).trim()) {
      m.incomeCategoryLabel = String(tx.incomeCategoryLabel).trim();
    }
    if (tx.importBatchId && String(tx.importBatchId).trim()) m.importBatchId = String(tx.importBatchId).trim();
    if (tx.importSource && String(tx.importSource).trim()) m.importSource = String(tx.importSource).trim();
    if (tx.externalId != null && String(tx.externalId).trim()) m.externalId = String(tx.externalId).trim();
    if (tx.rawMemo != null && String(tx.rawMemo).trim()) m.rawMemo = String(tx.rawMemo).trim();
    return Object.keys(m).length ? m : null;
  }

  function applyTransactionMetadata(tx, meta) {
    if (!meta || typeof meta !== 'object') return tx;
    var out = Object.assign({}, tx);
    if (meta.title != null) out.title = meta.title;
    if (meta.vendor != null) out.vendor = meta.vendor;
    if (meta.notes != null) out.notes = meta.notes;
    if (meta.source != null) out.source = meta.source;
    if (meta.recurrence != null) out.recurrence = meta.recurrence;
    if (meta.recurrenceSeriesId != null) out.recurrenceSeriesId = meta.recurrenceSeriesId;
    if (meta.expenseRecurringLead === true) out.expenseRecurringLead = true;
    if (meta.expenseRecurrenceInstance === true) out.expenseRecurrenceInstance = true;
    if (meta.recurring === true) out.recurring = true;
    if (meta.incomeCategoryLabel != null && String(meta.incomeCategoryLabel).trim()) {
      out.incomeCategoryLabel = String(meta.incomeCategoryLabel).trim();
    }
    if (meta.importBatchId != null && String(meta.importBatchId).trim()) out.importBatchId = String(meta.importBatchId).trim();
    if (meta.importSource != null && String(meta.importSource).trim()) out.importSource = String(meta.importSource).trim();
    if (meta.externalId != null && String(meta.externalId).trim()) out.externalId = String(meta.externalId).trim();
    if (meta.rawMemo != null && String(meta.rawMemo).trim()) out.rawMemo = String(meta.rawMemo).trim();
    return out;
  }

  // Match Supabase `transactions` table + optional columns (see supabase/dashboard_sync.sql).
  function transactionRowForDb(tx, userId) {
    var line = tx.description || tx.title || tx.note || null;
    if (!line && (tx.vendor || tx.notes)) {
      line = [tx.title, tx.vendor, tx.notes].filter(function (s) { return s && String(s).trim(); }).join(' · ') || null;
    }
    var meta = buildTransactionMetadata(tx);
    var row = {
      id: tx.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      date: tx.date,
      category: tx.category,
      amount: tx.amount,
      description: line,
      client_id: tx.clientId || null,
      project_id: tx.projectId || null,
      other_label: tx.otherLabel || null,
      other_type: tx.otherType || null,
      note: tx.note || null,
    };
    if (meta) row.metadata = meta;
    return row;
  }

  async function persistTransactionToSupabase(tx) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      // Still keep local cache in sync.
      saveTransactions(state.transactions);
      return;
    }
    if (!getCurrentOrgId()) {
      saveTransactions(state.transactions);
      return;
    }

    var payload = transactionRowForDb(tx, currentUser.id);

    try {
      var result = await supabase
        .from('transactions')
        .upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('upsert transaction error', result.error);
      }
    } catch (err) {
      console.error('persistTransactionToSupabase error', err);
    }
  }

  async function deleteTransactionRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      saveTransactions(state.transactions);
      return;
    }
    if (!getCurrentOrgId()) {
      saveTransactions(state.transactions);
      return;
    }
    try {
      var result = await supabase
        .from('transactions')
        .delete()
        .eq('id', id)
        .eq('organization_id', getCurrentOrgId());
      if (result.error) {
        console.error('delete transaction error', result.error);
      }
    } catch (err) {
      console.error('deleteTransactionRemote error', err);
    }
  }

  /** Last PostgREST/Supabase error from client persist (for user-facing alerts). */
  var persistClientLastError = '';

  function formatSupabaseErr(err) {
    if (!err) return '';
    var parts = [err.message, err.details, err.hint].filter(Boolean);
    return parts.join(' — ') || JSON.stringify(err);
  }

  /**
   * @param {'insert'|'update'} writeMode insert = new row only (avoids upsert RLS quirks); update = existing row
   * @returns {Promise<'skipped'|'ok'|'error'>}
   */
  async function persistClientToSupabase(client, writeMode) {
    persistClientLastError = '';
    if (isDemoDashboardUser()) return 'skipped';
    supabase = window.supabaseClient || supabase;
    if (!supabase) {
      persistClientLastError = 'Supabase client is not loaded.';
      return 'skipped';
    }

    var sessionRes;
    try {
      sessionRes = await supabase.auth.getSession();
    } catch (e) {
      console.error('getSession before client persist', e);
      persistClientLastError = String(e && e.message ? e.message : e);
      return 'skipped';
    }
    var session = sessionRes && sessionRes.data && sessionRes.data.session;
    if (!session || !session.user) {
      persistClientLastError = 'No active session. Sign in again.';
      currentUser = null;
      window.currentUser = null;
      return 'skipped';
    }
    currentUser = session.user;
    window.currentUser = session.user;

    if (!getCurrentOrgId()) {
      persistClientLastError = 'No workspace in this URL. Use your organization link (path starts with your org slug).';
      return 'skipped';
    }

    if (!client || !isUuidForDb(client.id)) {
      persistClientLastError = 'Invalid client id.';
      return 'skipped';
    }

    var payload = buildClientDbPayload(client, currentUser.id);
    var mode = writeMode === 'update' ? 'update' : 'insert';

    async function runWrite(body) {
      if (mode === 'insert') {
        return await supabase.from('clients').insert(body).select('id');
      }
      var bodyNoId = Object.assign({}, body);
      delete bodyNoId.id;
      return await supabase
        .from('clients')
        .update(bodyNoId)
        .eq('id', client.id)
        .eq('organization_id', getCurrentOrgId())
        .select('id');
    }

    try {
      var body = Object.assign({}, payload);
      var result;
      // Older DBs can be missing multiple optional client columns; allow enough retries
      // to progressively strip unsupported fields and still save core edits.
      var maxAttempts = 14;
      for (var attempt = 0; attempt < maxAttempts; attempt++) {
        result = await runWrite(body);
        if (!result.error) {
          if (mode === 'update' && (!result.data || !result.data.length)) {
            persistClientLastError = 'No row updated. Check that this client belongs to your account and RLS policies allow updates.';
            return 'error';
          }
          return 'ok';
        }
        console.error('persist client error', result.error);
        var errStr = JSON.stringify(result.error || {});
        var errLower = errStr.toLowerCase();
        var changed = false;
        var missingColMatch = errLower.match(/could not find the '([^']+)' column/);
        if (missingColMatch && missingColMatch[1]) {
          var missingCol = missingColMatch[1];
          if (Object.prototype.hasOwnProperty.call(body, missingCol)) {
            delete body[missingCol];
            changed = true;
          }
        }
        if (!changed && (/industry|schema cache|could not find.*column/i.test(errStr)) && Object.prototype.hasOwnProperty.call(body, 'industry')) {
          delete body.industry;
          changed = true;
          console.warn('bizdash: retrying client persist without industry — run ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS industry text;');
        }
        if (!changed && /is_retainer/i.test(errStr) && Object.prototype.hasOwnProperty.call(body, 'is_retainer')) {
          delete body.is_retainer;
          changed = true;
        }
        if (!changed && (/metadata|schema cache|could not find.*column/i.test(errStr)) && Object.prototype.hasOwnProperty.call(body, 'metadata')) {
          delete body.metadata;
          changed = true;
          console.warn('bizdash: retrying client persist without metadata — run ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT \'{}\'::jsonb;');
        }
        if (!changed && (/pipeline_id|pipeline_stage_id|schema|could not find.*column/i.test(errStr))) {
          if (Object.prototype.hasOwnProperty.call(body, 'pipeline_id')) {
            delete body.pipeline_id;
            changed = true;
          }
          if (!changed && Object.prototype.hasOwnProperty.call(body, 'pipeline_stage_id')) {
            delete body.pipeline_stage_id;
            changed = true;
          }
        }
        if (!changed) {
          ['birthday', 'communication_style', 'preferred_channel', 'last_touch_at', 'next_follow_up_at', 'relationship_notes'].some(function (col) {
            if (changed) return true;
            if (errLower.indexOf(col) !== -1 && Object.prototype.hasOwnProperty.call(body, col)) {
              delete body[col];
              changed = true;
              return true;
            }
            return false;
          });
        }
        if (!changed) {
          persistClientLastError = formatSupabaseErr(result.error);
          return 'error';
        }
      }
      persistClientLastError = formatSupabaseErr(result.error);
      return 'error';
    } catch (err) {
      console.error('persistClientToSupabase error', err);
      persistClientLastError = String(err && err.message ? err.message : err);
      return 'error';
    }
  }

  var ADVISOR_CTX_MAX = {
    id: 80,
    source: 120,
    companyName: 200,
    contactName: 200,
    email: 320,
    phone: 80,
    notes: 4000,
    receivedAt: 40,
  };

  function sliceField(s, max) {
    var t = String(s == null ? '' : s).trim();
    return t.length > max ? t.slice(0, max) : t;
  }

  function normalizeAdvisorContactContext(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var out = {
      id: sliceField(obj.id, ADVISOR_CTX_MAX.id) || null,
      source: sliceField(obj.source, ADVISOR_CTX_MAX.source) || null,
      companyName: sliceField(obj.companyName, ADVISOR_CTX_MAX.companyName) || null,
      contactName: sliceField(obj.contactName, ADVISOR_CTX_MAX.contactName) || null,
      email: sliceField(obj.email, ADVISOR_CTX_MAX.email) || null,
      phone: sliceField(obj.phone, ADVISOR_CTX_MAX.phone) || null,
      notes: sliceField(obj.notes, ADVISOR_CTX_MAX.notes) || null,
      receivedAt: sliceField(obj.receivedAt, ADVISOR_CTX_MAX.receivedAt) || null,
    };
    var has = !!(out.id || out.source || out.companyName || out.contactName || out.email || out.phone || out.notes || out.receivedAt);
    return has ? out : null;
  }

  /**
   * Build a new in-memory client row from a CRM draft (Advisor proposal or contact context).
   * @returns {object|null} null if company name missing
   */
  function buildNewClientObjectFromDraft(draft) {
    var d = draft || {};
    var company = sliceField(d.companyName, ADVISOR_CTX_MAX.companyName);
    if (!company) return null;
    var firstName = sliceField(d.firstName, 120);
    var lastName = sliceField(d.lastName, 120);
    var contactName = sliceField(d.contactName, ADVISOR_CTX_MAX.contactName);
    if (!contactName && (firstName || lastName)) {
      contactName = [firstName, lastName].filter(Boolean).join(' ');
    }
    var client = {
      id: uuid(),
      companyName: company,
      contactName: contactName,
      status: sliceField(d.status, 120) || 'Lead',
      industry: sliceField(d.industry, 120),
      email: sliceField(d.email, ADVISOR_CTX_MAX.email),
      phone: sliceField(d.phone, ADVISOR_CTX_MAX.phone),
      notes: sliceField(d.notes, ADVISOR_CTX_MAX.notes),
      birthday: d.birthday ? String(d.birthday).slice(0, 32) : '',
      preferredChannel: sliceField(d.preferredChannel, 120),
      communicationStyle: sliceField(d.communicationStyle, 120),
      lastTouchAt: d.lastTouchAt ? String(d.lastTouchAt).slice(0, 32) : '',
      nextFollowUpAt: d.nextFollowUpAt ? String(d.nextFollowUpAt).slice(0, 32) : '',
      relationshipNotes: sliceField(d.relationshipNotes, 2000),
      salutation: sliceField(d.salutation, 80),
      firstName: firstName,
      lastName: lastName,
      title: sliceField(d.title, 160),
      reportsTo: sliceField(d.reportsTo, 160),
      description: sliceField(d.description, 4000),
      owner: sliceField(d.owner, 160),
      accountName: company,
      mailingCountry: sliceField(d.mailingCountry, 120),
      mailingStreet: sliceField(d.mailingStreet, 400),
      mailingCity: sliceField(d.mailingCity, 120),
      mailingState: sliceField(d.mailingState, 80),
      mailingZip: sliceField(d.mailingZip, 32),
      emailOptOut: d.emailOptOut === true,
      totalRevenue: 0,
      createdAt: Date.now(),
      retainer: !!d.retainer,
    };
    if (d.pipelineId && d.pipelineStageId) {
      client.pipelineId = d.pipelineId;
      client.pipelineStageId = d.pipelineStageId;
    }
    return client;
  }

  async function deleteClientRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      saveClients(clients);
      return;
    }
    try {
      var result = await supabase
        .from('clients')
        .delete()
        .eq('id', id)
        .eq('organization_id', getCurrentOrgId());
      if (result.error) {
        console.error('delete client error', result.error);
      }
    } catch (err) {
      console.error('deleteClientRemote error', err);
    }
  }

  // Load data from Supabase (or fall back to localStorage) for the signed-in user.

  function normalizeLocalIdsForSupabase() {
    var changed = false;
    var clientIdMap = {};
    var txIdMap = {};
    var projectIdMap = {};

    clients = (clients || []).map(function (c) {
      var oldId = c && c.id;
      if (isUuidForDb(oldId)) return c;
      var newId = uuid();
      clientIdMap[oldId || ''] = newId;
      changed = true;
      return Object.assign({}, c, { id: newId });
    });

    projects = (projects || []).map(function (p) {
      if (!p) return p;
      var next = Object.assign({}, p);
      if (next.clientId && clientIdMap[next.clientId]) {
        next.clientId = clientIdMap[next.clientId];
        changed = true;
      }
      var oldPid = p.id;
      if (!isUuidForDb(oldPid)) {
        var newPid = uuid();
        projectIdMap[oldPid || ''] = newPid;
        next.id = newPid;
        changed = true;
      }
      return next;
    });

    state.transactions = (state.transactions || []).map(function (tx) {
      var oldTxId = tx && tx.id;
      var next = Object.assign({}, tx);
      if (!isUuidForDb(oldTxId)) {
        var newTxId = uuid();
        txIdMap[oldTxId || ''] = newTxId;
        next.id = newTxId;
        changed = true;
      }
      if (next.clientId && clientIdMap[next.clientId]) {
        next.clientId = clientIdMap[next.clientId];
        changed = true;
      }
      if (next.projectId && projectIdMap[next.projectId]) {
        next.projectId = projectIdMap[next.projectId];
        changed = true;
      }
      return next;
    });

    invoices = (invoices || []).map(function (inv) {
      if (!inv) return inv;
      var next = Object.assign({}, inv);
      if (!isUuidForDb(next.id)) {
        next.id = uuid();
        changed = true;
      }
      if (next.incomeTxId && txIdMap[next.incomeTxId]) {
        next.incomeTxId = txIdMap[next.incomeTxId];
        changed = true;
      }
      return next;
    });

    campaigns = (campaigns || []).map(function (c) {
      if (!c) return c;
      if (isUuidForDb(c.id)) return c;
      changed = true;
      return Object.assign({}, c, { id: uuid() });
    });

    if (changed) {
      saveTransactions(state.transactions);
      saveClients(clients);
      saveProjects(projects);
      saveInvoices(invoices);
      saveCampaigns(campaigns);
    }
  }

  async function uploadTransactionsToSupabase(list) {
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    var payload = list.map(function (tx) {
      return transactionRowForDb(tx, currentUser.id);
    });
    try {
      var result = await supabase.from('transactions').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert transactions error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadTransactionsToSupabase error', err);
      return false;
    }
  }

  async function uploadClientsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    var validClients = list.filter(function (c) {
      return c && isUuidForDb(c.id);
    });
    if (!validClients.length) return false;
    var payload = validClients.map(function (client) {
      return buildClientDbPayload(client, currentUser.id);
    });
    try {
      var result = await supabase.from('clients').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert clients error', result.error);
        var errStr = JSON.stringify(result.error || {});
        if (/is_retainer|schema|column/i.test(errStr)) {
          var payload2 = payload.map(function (row) {
            var copy = Object.assign({}, row);
            delete copy.is_retainer;
            return copy;
          });
          var result2 = await supabase.from('clients').upsert(payload2, { onConflict: 'id' });
          if (result2.error) {
            console.error('bulk upsert clients (no is_retainer) error', result2.error);
            return false;
          }
          return true;
        }
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadClientsToSupabase error', err);
      return false;
    }
  }

  function mergeRemoteWithLocalOrphans(localList, remoteRows, mapRow) {
    var remoteMapped = (remoteRows || []).map(mapRow);
    var rid = {};
    remoteMapped.forEach(function (x) {
      if (x && x.id) rid[x.id] = true;
    });
    var out = remoteMapped.slice();
    (localList || []).forEach(function (x) {
      if (x && x.id && !rid[x.id]) out.push(x);
    });
    return out;
  }

  function parseJsonbLoose(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch (_) {
        return null;
      }
    }
    return val;
  }

  function normalizeCaseStudyStrategyFromDb(raw) {
    var v = parseJsonbLoose(raw);
    if (v == null) return [];
    if (typeof v === 'string' && v.trim()) return [{ title: '', body: v.trim() }];
    if (!Array.isArray(v)) return [];
    if (!v.length) return [];
    if (typeof v[0] === 'string') {
      return v.map(function (s) {
        return { title: '', body: String(s || '') };
      }).filter(function (x) {
        return x.body;
      });
    }
    return v.map(function (it) {
      if (!it || typeof it !== 'object') return { title: '', body: '' };
      return { title: String(it.title || ''), body: String(it.body || '') };
    }).filter(function (x) {
      return x.title || x.body;
    });
  }

  function normalizeCaseStudyResultsFromDb(raw) {
    var v = parseJsonbLoose(raw);
    if (v == null) return [];
    if (Array.isArray(v)) {
      return v.map(function (x) {
        return String(x == null ? '' : x).trim();
      }).filter(Boolean);
    }
    if (typeof v === 'string' && v.trim()) {
      return v.split(/\n+/).map(function (s) {
        return s.trim();
      }).filter(Boolean);
    }
    return [];
  }

  function projectHasCaseStudyViewable(p) {
    if (!p) return false;
    if (p.caseStudyPublished) return true;
    if (p.caseStudyCategory && String(p.caseStudyCategory).trim()) return true;
    if (p.caseStudyChallenge && String(p.caseStudyChallenge).trim()) return true;
    var st = p.caseStudyStrategy;
    if (Array.isArray(st) && st.some(function (x) {
      return x && (String(x.title || '').trim() || String(x.body || '').trim());
    })) return true;
    var rs = p.caseStudyResults;
    if (Array.isArray(rs) && rs.some(function (s) {
      return String(s || '').trim();
    })) return true;
    return false;
  }

  function appendCaseStudyStrategyRow(title, body) {
    var list = $('case-study-strategy-list');
    if (!list) return;
    var wrap = document.createElement('div');
    wrap.className = 'case-strategy-row';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--border);border-radius:var(--rl);background:var(--bg);';
    wrap.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
        '<span style="font-size:12px;font-weight:600;color:var(--text2);">Strategy point</span>' +
        '<button type="button" class="btn case-strategy-remove" style="color:var(--red);">Remove</button>' +
      '</div>' +
      '<input class="fi cs-strat-title" type="text" placeholder="Title (optional)" />' +
      '<textarea class="fi cs-strat-body" rows="2" style="min-height:48px;resize:vertical;" placeholder="Body"></textarea>';
    list.appendChild(wrap);
    var ti = wrap.querySelector('.cs-strat-title');
    var bd = wrap.querySelector('.cs-strat-body');
    if (ti) ti.value = title || '';
    if (bd) bd.value = body || '';
  }

  function clearCaseStudyForm() {
    var pub = $('project-case-study-published');
    if (pub) pub.checked = false;
    if ($('project-case-study-category')) $('project-case-study-category').value = '';
    if ($('project-case-study-challenge')) $('project-case-study-challenge').value = '';
    if ($('project-case-study-strategy-plain')) $('project-case-study-strategy-plain').value = '';
    if ($('project-case-study-results')) $('project-case-study-results').value = '';
    var list = $('case-study-strategy-list');
    if (list) list.innerHTML = '';
  }

  function fillCaseStudyForm(p) {
    clearCaseStudyForm();
    if (!p) return;
    if ($('project-case-study-published')) $('project-case-study-published').checked = !!p.caseStudyPublished;
    if ($('project-case-study-category')) $('project-case-study-category').value = p.caseStudyCategory || '';
    if ($('project-case-study-challenge')) $('project-case-study-challenge').value = p.caseStudyChallenge || '';
    var strat = Array.isArray(p.caseStudyStrategy) ? p.caseStudyStrategy : [];
    var meaningful = strat.filter(function (x) {
      return x && (String(x.title || '').trim() || String(x.body || '').trim());
    });
    if (meaningful.length === 1 && !String(meaningful[0].title || '').trim() && String(meaningful[0].body || '').trim()) {
      if ($('project-case-study-strategy-plain')) $('project-case-study-strategy-plain').value = meaningful[0].body;
    } else {
      meaningful.forEach(function (x) {
        appendCaseStudyStrategyRow(x.title || '', x.body || '');
      });
    }
    var res = Array.isArray(p.caseStudyResults) ? p.caseStudyResults : [];
    if ($('project-case-study-results')) $('project-case-study-results').value = res.join('\n');
  }

  function readCaseStudyFromUi() {
    var published = !!($('project-case-study-published') && $('project-case-study-published').checked);
    var category = ($('project-case-study-category') && $('project-case-study-category').value || '').trim();
    var challenge = ($('project-case-study-challenge') && $('project-case-study-challenge').value || '').trim();
    var resultsRaw = ($('project-case-study-results') && $('project-case-study-results').value || '').trim();
    var results = resultsRaw ? resultsRaw.split(/\n+/).map(function (s) {
      return s.trim();
    }).filter(Boolean) : [];
    var items = [];
    var list = document.querySelectorAll('#case-study-strategy-list .case-strategy-row');
    list.forEach(function (row) {
      var t = row.querySelector('.cs-strat-title');
      var b = row.querySelector('.cs-strat-body');
      var title = t ? t.value.trim() : '';
      var body = b ? b.value.trim() : '';
      if (title || body) items.push({ title: title, body: body });
    });
    if (!items.length) {
      var plain = ($('project-case-study-strategy-plain') && $('project-case-study-strategy-plain').value || '').trim();
      if (plain) items = [{ title: '', body: plain }];
    }
    return {
      caseStudyPublished: published,
      caseStudyCategory: category || null,
      caseStudyChallenge: challenge || null,
      caseStudyStrategy: items,
      caseStudyResults: results,
    };
  }

  // ---------- Projects (Supabase) ----------
  function mapProjectRow(row) {
    return {
      id: row.id,
      clientId: row.client_id || null,
      name: row.name || '',
      status: row.status || '',
      type: row.type || '',
      startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : '',
      value: Number(row.value || 0),
      description: row.description || '',
      notes: row.notes || '',
      satisfaction: row.satisfaction != null && row.satisfaction !== '' ? Number(row.satisfaction) : null,
      archived: !!row.archived,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      caseStudyPublished: !!row.case_study_published,
      caseStudyChallenge: row.case_study_challenge || '',
      caseStudyStrategy: normalizeCaseStudyStrategyFromDb(row.case_study_strategy),
      caseStudyResults: normalizeCaseStudyResultsFromDb(row.case_study_results),
      caseStudyCategory: row.case_study_category || '',
    };
  }

  function projectRowForDb(p, userId) {
    var strat = Array.isArray(p.caseStudyStrategy) ? p.caseStudyStrategy : [];
    var res = Array.isArray(p.caseStudyResults) ? p.caseStudyResults : [];
    return {
      id: p.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      client_id: p.clientId || null,
      name: p.name || '',
      status: p.status || '',
      type: p.type || '',
      start_date: p.startDate || null,
      due_date: p.dueDate || null,
      value: p.value || 0,
      description: p.description || '',
      notes: p.notes || '',
      satisfaction: p.satisfaction != null && !isNaN(p.satisfaction) ? p.satisfaction : null,
      archived: !!p.archived,
      created_at: p.createdAt ? new Date(p.createdAt).toISOString() : new Date().toISOString(),
      case_study_published: !!p.caseStudyPublished,
      case_study_challenge: p.caseStudyChallenge || null,
      case_study_strategy: strat,
      case_study_results: res,
      case_study_category: p.caseStudyCategory || null,
    };
  }

  async function persistProjectToSupabase(p) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !p || !p.id) return;
    try {
      var result = await supabase.from('projects').upsert(projectRowForDb(p, currentUser.id), { onConflict: 'id' });
      if (result.error) console.error('upsert project error', result.error);
    } catch (err) {
      console.error('persistProjectToSupabase error', err);
    }
  }

  async function deleteProjectRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !id) return;
    try {
      await supabase.from('projects').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteProjectRemote error', err);
    }
  }

  async function fetchProjectsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadProjects();
    try {
      var result = await supabase.from('projects').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: true });
      if (result.error) {
        console.error('load projects error', result.error);
        return loadProjects();
      }
      var rows = result.data || [];
      return rows.map(mapProjectRow);
    } catch (err) {
      console.error('fetchProjectsFromSupabase error', err);
      return loadProjects();
    }
  }

  async function uploadProjectsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = list.map(function (p) { return projectRowForDb(p, currentUser.id); });
      var result = await supabase.from('projects').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert projects error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadProjectsToSupabase error', err);
      return false;
    }
  }

  // ---------- Invoices (Supabase) ----------
  function mapInvoiceRow(row) {
    return {
      id: row.id,
      incomeTxId: row.income_tx_id,
      number: row.number || '',
      dateIssued: row.date_issued ? String(row.date_issued).slice(0, 10) : '',
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : '',
      amount: Number(row.amount || 0),
      status: row.status || 'sent',
      paidAt: row.paid_at ? String(row.paid_at).slice(0, 10) : null,
      stripeCheckoutSessionId: row.stripe_checkout_session_id || null,
      stripePaymentIntentId: row.stripe_payment_intent_id || null,
      stripeCustomerId: row.stripe_customer_id || null,
      stripeStatus: row.stripe_status || null,
    };
  }

  function invoiceRowForDb(inv, userId) {
    return {
      id: inv.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      income_tx_id: inv.incomeTxId,
      number: inv.number,
      date_issued: inv.dateIssued,
      due_date: inv.dueDate,
      amount: inv.amount,
      status: inv.status || 'sent',
      paid_at: inv.paidAt || null,
      stripe_checkout_session_id: inv.stripeCheckoutSessionId || null,
      stripe_payment_intent_id: inv.stripePaymentIntentId || null,
      stripe_customer_id: inv.stripeCustomerId || null,
      stripe_status: inv.stripeStatus || null,
    };
  }

  async function startStripeCheckoutForInvoice(inv) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !inv || !inv.id) {
      alert('Sign in first to start Stripe Checkout.');
      return;
    }
    try {
      var res = await supabase.functions.invoke('create-stripe-checkout-session', {
        body: {
          invoiceId: inv.id,
          organizationId: getCurrentOrgId(),
          successUrl: window.location.origin + window.location.pathname + '?payment=success',
          cancelUrl: window.location.origin + window.location.pathname + '?payment=cancel',
        },
      });
      if (res.error) {
        alert('Stripe checkout failed: ' + (res.error.message || 'Unknown error'));
        return;
      }
      var payload = res.data || {};
      if (!payload.url) {
        alert('Stripe checkout failed: no redirect URL returned.');
        return;
      }
      window.location.href = payload.url;
    } catch (err) {
      console.error('startStripeCheckoutForInvoice error', err);
      alert('Stripe checkout failed. Check console and edge function logs.');
    }
  }

  async function persistInvoiceToSupabase(inv) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !inv || !inv.id) return;
    try {
      var result = await supabase.from('invoices').upsert(invoiceRowForDb(inv, currentUser.id), { onConflict: 'id' });
      if (result.error) console.error('upsert invoice error', result.error);
    } catch (err) {
      console.error('persistInvoiceToSupabase error', err);
    }
  }

  async function deleteInvoiceRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !id) return;
    try {
      await supabase.from('invoices').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteInvoiceRemote error', err);
    }
  }

  async function fetchInvoicesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadInvoices();
    try {
      var result = await supabase.from('invoices').select('*').eq('organization_id', getCurrentOrgId()).order('date_issued', { ascending: false });
      if (result.error) {
        console.error('load invoices error', result.error);
        return loadInvoices();
      }
      var rows = result.data || [];
      return rows.map(mapInvoiceRow);
    } catch (err) {
      console.error('fetchInvoicesFromSupabase error', err);
      return loadInvoices();
    }
  }

  async function uploadInvoicesToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = list.map(function (inv) { return invoiceRowForDb(inv, currentUser.id); });
      var result = await supabase.from('invoices').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert invoices error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadInvoicesToSupabase error', err);
      return false;
    }
  }

  // ---------- Campaigns (Supabase) ----------
  function mapCampaignRow(row) {
    var st = row.status;
    if ([CAMPAIGN_STATUS_PIPELINE, CAMPAIGN_STATUS_WON, CAMPAIGN_STATUS_LOST].indexOf(st) === -1) st = CAMPAIGN_STATUS_PIPELINE;
    return {
      id: row.id,
      name: row.name || '',
      channel: row.channel || '',
      startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
      notes: row.notes || '',
      pipelineValue: Math.max(0, Number(row.pipeline_value || 0)),
      status: st,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    };
  }

  function campaignRowForDb(c, userId) {
    var n = normalizeCampaign(c);
    if (!n) return null;
    return {
      id: n.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      name: n.name || '',
      channel: n.channel || '',
      start_date: n.startDate || null,
      notes: n.notes || '',
      pipeline_value: n.pipelineValue || 0,
      status: n.status || CAMPAIGN_STATUS_PIPELINE,
      created_at: n.createdAt ? new Date(n.createdAt).toISOString() : new Date().toISOString(),
    };
  }

  async function persistCampaignToSupabase(c) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !c || !c.id) return;
    var row = campaignRowForDb(c, currentUser.id);
    if (!row) return;
    try {
      var result = await supabase.from('campaigns').upsert(row, { onConflict: 'id' });
      if (result.error) console.error('upsert campaign error', result.error);
    } catch (err) {
      console.error('persistCampaignToSupabase error', err);
    }
  }

  async function deleteCampaignRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !id) return;
    try {
      await supabase.from('campaigns').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteCampaignRemote error', err);
    }
  }

  async function fetchCampaignsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadCampaigns();
    try {
      var result = await supabase.from('campaigns').select('*').eq('organization_id', getCurrentOrgId()).order('start_date', { ascending: false });
      if (result.error) {
        console.error('load campaigns error', result.error);
        return loadCampaigns();
      }
      var rows = result.data || [];
      return rows.map(mapCampaignRow);
    } catch (err) {
      console.error('fetchCampaignsFromSupabase error', err);
      return loadCampaigns();
    }
  }

  async function uploadCampaignsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = [];
      list.forEach(function (c) {
        var row = campaignRowForDb(normalizeCampaign(c) || c, currentUser.id);
        if (row) payload.push(row);
      });
      if (!payload.length) return true;
      var result = await supabase.from('campaigns').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert campaigns error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadCampaignsToSupabase error', err);
      return false;
    }
  }

  // ---------- App settings (custom project status labels) ----------
  async function fetchAppSettingsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return null;
    try {
      var result = await supabase.from('app_settings').select('*').eq('organization_id', getCurrentOrgId()).maybeSingle();
      if (result.error) {
        console.error('load app_settings error', result.error);
        return null;
      }
      return result.data;
    } catch (err) {
      console.error('fetchAppSettingsFromSupabase error', err);
      return null;
    }
  }

  function collectDashboardSettingsForCloud() {
    function gid(id) {
      return document.getElementById(id);
    }
    function val(id) {
      var el = gid(id);
      return el ? String(el.value || '').trim() : '';
    }
    function numEl(id, def) {
      var el = gid(id);
      var n = el ? parseFloat(el.value) : NaN;
      return isNaN(n) ? def : n;
    }
    var curEl = gid('setting-currency');
    var fiscalEl = gid('setting-fiscal');
    var brandImg = gid('sb-brand-img');
    return {
      business: {
        name: val('setting-name'),
        owner: val('setting-owner'),
        email: val('setting-email'),
        phone: val('setting-phone'),
        address: val('setting-address'),
        period: val('setting-period'),
        accent: parseAccentHexOrNull(val('setting-accent-hex')) || normalizeHexColor(val('setting-accent'), '#e8501a'),
        terms: Math.max(0, Math.round(numEl('setting-terms', 30))),
        tax: Math.max(0, numEl('setting-tax', 0)),
        currency: curEl && curEl.value ? curEl.value : 'USD',
        fiscal: fiscalEl && fiscalEl.value ? fiscalEl.value : 'January',
        logo_light_url: brandImg && brandImg.getAttribute('data-logo-light') ? String(brandImg.getAttribute('data-logo-light')) : '',
        logo_dark_url: brandImg && brandImg.getAttribute('data-logo-dark') ? String(brandImg.getAttribute('data-logo-dark')) : '',
        tagline: val('setting-tagline'),
        ownerRole: val('setting-owner-role'),
      },
      budgets: {
        lab: Math.max(0, Number(budgets.lab) || 0),
        sw: Math.max(0, Number(budgets.sw) || 0),
        ads: Math.max(0, Number(budgets.ads) || 0),
        oth: Math.max(0, Number(budgets.oth) || 0),
      },
      budgetMonths: loadBudgetMonthSnapshots(),
    };
  }

  function refreshSettingsBudgetInputsFromState() {
    ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
      var el = document.getElementById('budget-input-' + k);
      if (el) el.value = budgets[k] > 0 ? String(budgets[k]) : '';
    });
  }

  function mergeDashboardSettingsForPersist(prevDash, nextDash) {
    if (!prevDash || typeof prevDash !== 'object') return nextDash;
    var pb = prevDash.business && typeof prevDash.business === 'object' ? prevDash.business : {};
    var nb = nextDash.business && typeof nextDash.business === 'object' ? nextDash.business : {};
    var mergedBusiness = Object.assign({}, pb);
    ['name', 'owner', 'ownerRole', 'email', 'phone', 'address', 'period', 'accent', 'currency', 'fiscal', 'logo_light_url', 'logo_dark_url', 'tagline'].forEach(function (k) {
      var nv = nb[k];
      if (nv != null && String(nv).trim()) mergedBusiness[k] = nv;
    });
    mergedBusiness.terms = nb.terms != null ? nb.terms : pb.terms != null ? pb.terms : 30;
    mergedBusiness.tax = nb.tax != null ? nb.tax : pb.tax != null ? pb.tax : 0;
    return {
      business: mergedBusiness,
      budgets: nextDash.budgets && typeof nextDash.budgets === 'object' ? nextDash.budgets : { lab: 0, sw: 0, ads: 0, oth: 0 },
      budgetMonths: Object.assign({}, prevDash.budgetMonths || {}, nextDash.budgetMonths || {}),
    };
  }

  async function applyDashboardSettingsFromCloud(raw) {
    if (raw == null || typeof raw !== 'object') return;
    if (!raw.business && !raw.budgets && !raw.budgetMonths) return;
    var biz = raw.business;
    if (biz && typeof biz === 'object') {
      function gid(id) {
        return document.getElementById(id);
      }
      function setv(id, v) {
        var el = gid(id);
        if (!el || v == null) return;
        el.value = v;
      }
      if (biz.name != null) setv('setting-name', biz.name);
      if (biz.owner != null) setv('setting-owner', biz.owner);
      if (biz.email != null) setv('setting-email', biz.email);
      if (biz.phone != null) setv('setting-phone', biz.phone);
      if (biz.address != null) setv('setting-address', biz.address);
      if (biz.period != null) setv('setting-period', biz.period);
      if (biz.accent) {
        var accentNorm = normalizeHexColor(biz.accent, '#e8501a');
        setv('setting-accent', accentNorm);
        setv('setting-accent-hex', accentNorm);
      }
      if (biz.terms != null) setv('setting-terms', String(biz.terms));
      if (biz.tax != null) setv('setting-tax', String(biz.tax));
      var cur = gid('setting-currency');
      if (cur && biz.currency) cur.value = biz.currency;
      var fis = gid('setting-fiscal');
      if (fis && biz.fiscal) fis.value = biz.fiscal;
      if (biz.accent) applyAccentBranding(normalizeHexColor(biz.accent, '#e8501a'));
      var lightSigned = await resolveBrandLogoStorageUrl(biz.logo_light_url || '');
      var darkSigned = await resolveBrandLogoStorageUrl(biz.logo_dark_url || '');
      applyBrandLogo(lightSigned, darkSigned);
      if (biz.ownerRole != null) setv('setting-owner-role', String(biz.ownerRole));
      if (biz.tagline != null) setv('setting-tagline', String(biz.tagline));
      var tagEl = gid('dash-brand-tagline');
      if (tagEl) {
        var tgs = biz.tagline != null ? String(biz.tagline).trim() : '';
        if (tgs) {
          tagEl.textContent = tgs;
          tagEl.style.display = 'block';
        } else {
          tagEl.textContent = '';
          tagEl.style.display = 'none';
        }
      }
    }
    if (raw.budgets && typeof raw.budgets === 'object') {
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        if (raw.budgets[k] == null) return;
        budgets[k] = Math.max(0, Number(raw.budgets[k]) || 0);
      });
      try {
        localStorage.setItem(
          storageKey(BUDGETS_KEY),
          JSON.stringify({
            lab: budgets.lab,
            sw: budgets.sw,
            ads: budgets.ads,
            oth: budgets.oth,
          })
        );
      } catch (_) {}
    }
    if (raw.budgetMonths && typeof raw.budgetMonths === 'object') {
      saveBudgetMonthSnapshotsToStorage(raw.budgetMonths);
    }
    refreshSettingsBudgetInputsFromState();
  }

  function normalizeHexColor(hex, fallback) {
    var s = String(hex || '').trim();
    if (!s) return fallback;
    if (s[0] !== '#') s = '#' + s;
    var m3 = s.match(/^#([0-9a-fA-F]{3})$/);
    if (m3) {
      var h = m3[1];
      return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    var m6 = s.match(/^#([0-9a-fA-F]{6})$/);
    if (m6) return '#' + m6[1].toLowerCase();
    return fallback;
  }

  /** Valid #rgb / #rrggbb only; otherwise null (use when empty string must not fall back to a default). */
  function parseAccentHexOrNull(raw) {
    var n = normalizeHexColor(raw, '');
    return n && n.length === 7 ? n : null;
  }

  function hexToRgb(hex) {
    var n = normalizeHexColor(hex, '');
    if (!n || n.length !== 7) return null;
    return {
      r: parseInt(n.slice(1, 3), 16),
      g: parseInt(n.slice(3, 5), 16),
      b: parseInt(n.slice(5, 7), 16),
    };
  }

  function darkenHex(hex, factor) {
    var rgb = hexToRgb(hex);
    if (!rgb) return hex;
    var f = Math.max(0, Math.min(1, Number(factor) || 0));
    var r = Math.max(0, Math.min(255, Math.round(rgb.r * (1 - f))));
    var g = Math.max(0, Math.min(255, Math.round(rgb.g * (1 - f))));
    var b = Math.max(0, Math.min(255, Math.round(rgb.b * (1 - f))));
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function applyBrandLogo(lightUrl, darkUrl) {
    var img = document.getElementById('sb-brand-img');
    if (!img) return;
    var light = String(lightUrl || '').trim();
    var dark = String(darkUrl || '').trim();
    var nextSrc = light || dark;
    if (nextSrc) img.src = nextSrc;
    if (light) img.setAttribute('data-logo-light', light);
    if (dark) img.setAttribute('data-logo-dark', dark);
  }

  /** Signed URL lifetime for private brand-assets bucket (see supabase/brand_assets_org_rls.sql). */
  var BRAND_LOGO_SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7;

  function brandAssetPathFromStoredUrl(url) {
    var s = String(url || '').trim();
    if (!s) return null;
    var markers = ['/storage/v1/object/public/brand-assets/', '/storage/v1/object/sign/brand-assets/'];
    for (var mi = 0; mi < markers.length; mi++) {
      var idx = s.indexOf(markers[mi]);
      if (idx === -1) continue;
      var rest = s.slice(idx + markers[mi].length);
      var qIdx = rest.indexOf('?');
      if (qIdx !== -1) rest = rest.slice(0, qIdx);
      try {
        return decodeURIComponent(rest);
      } catch (e) {
        return rest;
      }
    }
    return null;
  }

  async function resolveBrandLogoStorageUrl(url) {
    var raw = String(url || '').trim();
    if (!raw) return '';
    supabase = window.supabaseClient || supabase;
    if (!supabase) return raw;
    var path = brandAssetPathFromStoredUrl(raw);
    if (!path) return raw;
    try {
      var signed = await supabase.storage.from('brand-assets').createSignedUrl(path, BRAND_LOGO_SIGNED_URL_TTL_SEC);
      if (signed.error || !signed.data || !signed.data.signedUrl) return raw;
      return signed.data.signedUrl;
    } catch (err) {
      return raw;
    }
  }

  /** Re-skin live charts when branding changes (without waiting for a full rerender). */
  function syncBrandingAcrossCharts() {
    function expenseColorForLabel(label) {
      if (label === 'Labor') return CHART_EXPENSE_LABOR;
      if (label === 'Software') return CHART_EXPENSE_SOFTWARE;
      if (label === 'Advertising') return CHART_EXPENSE_ADVERTISING;
      if (label === 'Other') return CHART_EXPENSE_GRAY;
      return CHART_PALETTE_REST[0];
    }
    if (revExpChart && revExpChart.data && revExpChart.data.datasets) {
      if (revExpChart.data.datasets[0]) syncBrandedRevenueBarDataset(revExpChart.data.datasets[0]);
      if (revExpChart.data.datasets[1]) syncMutedExpenseBarDataset(revExpChart.data.datasets[1]);
      revExpChart.update('none');
    }
    if (expenseChart && expenseChart.data && expenseChart.data.datasets && expenseChart.data.datasets[0]) {
      var expLabels = expenseChart.data.labels || [];
      if (expLabels.length === 1 && expLabels[0] === 'No expense data') {
        expenseChart.data.datasets[0].backgroundColor = [CHART_EMPTY];
      } else {
        expenseChart.data.datasets[0].backgroundColor = expLabels.map(expenseColorForLabel);
      }
      expenseChart.update('none');
    }
    if (revTrendChart && revTrendChart.data && revTrendChart.data.datasets && revTrendChart.data.datasets[0]) {
      syncBrandedRevenueLineDataset(revTrendChart.data.datasets[0]);
      revTrendChart.update('none');
    }
    if (insTrendChart && insTrendChart.data && insTrendChart.data.datasets && insTrendChart.data.datasets[0]) {
      syncBrandedRevenueLineDataset(insTrendChart.data.datasets[0]);
      insTrendChart.update('none');
    }
    if (retTrendChart && retTrendChart.data && retTrendChart.data.datasets && retTrendChart.data.datasets[0]) {
      syncBrandedRevenueLineDataset(retTrendChart.data.datasets[0]);
      retTrendChart.update('none');
    }
    if (projMonthlyChart && projMonthlyChart.data && projMonthlyChart.data.datasets && projMonthlyChart.data.datasets[0]) {
      projMonthlyChart.data.datasets[0].backgroundColor = CHART_ORANGE;
      projMonthlyChart.update('none');
    }
    if (verticalChart && verticalChart.data && verticalChart.data.datasets && verticalChart.data.datasets[0]) {
      var vLabels = verticalChart.data.labels || [];
      verticalChart.data.datasets[0].backgroundColor = vLabels.length && vLabels[0] !== 'No data' ? chartMultiColors(vLabels.length) : [CHART_EMPTY];
      verticalChart.update('none');
    }
    if (leadSourceChart && leadSourceChart.data && leadSourceChart.data.datasets && leadSourceChart.data.datasets[0]) {
      var lLabels = leadSourceChart.data.labels || [];
      leadSourceChart.data.datasets[0].backgroundColor = lLabels.length ? chartMultiColors(lLabels.length) : [CHART_EMPTY];
      leadSourceChart.update('none');
    }
  }

  function applyAccentBranding(accentHex) {
    var accent = normalizeHexColor(accentHex, '#e8501a');
    var rgb = hexToRgb(accent);
    if (!rgb) return;
    var root = document.documentElement;
    if (!root || !root.style) return;
    root.style.setProperty('--coral', accent);
    root.style.setProperty('--coral2', darkenHex(accent, 0.1));
    root.style.setProperty('--coral-bg', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.08)');
    root.style.setProperty('--coral-border-soft', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.14)');
    root.style.setProperty('--coral-border-mid', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.18)');
    root.style.setProperty('--coral-border-strong', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.2)');
    root.style.setProperty('--coral-border-focus', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.35)');

    // Chart "branding kit" derived from accent (revenue line, bars, doughnut slices, spend borders).
    CHART_ORANGE = accent;
    CHART_ORANGE_FILL = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.1)';
    CHART_ORANGE_FILL_BAR = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.32)';
    CHART_ORANGE_BORDER_BAR = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.45)';
    CHART_EXPENSE_LABOR = accent;
    CHART_EXPENSE_SOFTWARE = darkenHex(accent, 0.08);
    // Keep one non-accent category color for stronger visual separation in 2-slice doughnuts.
    CHART_EXPENSE_ADVERTISING = '#475569';
    CHART_VENDOR_PAL = [CHART_ORANGE, '#71717a', '#64748b', '#a1a1aa', '#94a3b8', '#78716c', '#d4d4d8', '#cbd5e1'];
    syncBrandingAcrossCharts();
  }

  async function persistAppSettingsToSupabase(opts) {
    opts = opts || {};
    var includeDashboard = opts.includeDashboard !== false;
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return;
    if (isDemoDashboardUser()) return;
    try {
      var dash = includeDashboard ? collectDashboardSettingsForCloud() : null;
      var existingSettings = null;
      try {
        existingSettings = await fetchAppSettingsFromSupabase();
        if (includeDashboard && existingSettings && existingSettings.dashboard_settings) {
          dash = mergeDashboardSettingsForPersist(existingSettings.dashboard_settings, dash);
        }
      } catch (_) {}
      if (!includeDashboard) {
        dash = existingSettings && existingSettings.dashboard_settings ? existingSettings.dashboard_settings : {};
      }
      var result = await supabase.from('app_settings').upsert(
        {
          organization_id: getCurrentOrgId(),
          project_statuses: projectStatuses,
          dashboard_settings: dash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' }
      );
      if (result.error) {
        console.error('upsert app_settings error', result.error);
        var errStr = JSON.stringify(result.error || {});
        if (/dashboard_settings|schema|column|42703/i.test(errStr)) {
          console.warn(
            'bizdash: add column dashboard_settings to app_settings — run supabase/add_app_settings_dashboard_settings.sql in the Supabase SQL editor.'
          );
        }
      }
    } catch (err) {
      console.error('persistAppSettingsToSupabase error', err);
    }
  }

  function mapTransactionRow(row) {
    var metaRaw = row.metadata;
    var meta = typeof metaRaw === 'string' ? (function () {
      try { return JSON.parse(metaRaw); } catch (_) { return null; }
    })() : metaRaw;
    var tx = {
      id: row.id,
      userId: row.user_id,
      date: row.date,
      category: row.category,
      amount: Number(row.amount || 0),
      description: row.description || row.note || '',
      note: row.note || row.description || '',
      clientId: row.client_id || null,
      projectId: row.project_id || null,
      otherLabel: row.other_label || '',
      otherType: row.other_type || '',
      source: row.source || '',
      createdAt: row.created_at || null,
    };
    return applyTransactionMetadata(tx, meta);
  }

  async function fetchTransactionsFromSupabase() {
    // If Supabase or user is not ready, fall back to local cache.
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) {
      return loadTransactions();
    }

    try {
      var result = await supabase
        .from('transactions')
        .select('*')
        .eq('organization_id', getCurrentOrgId())
        .order('date', { ascending: false });

      if (result.error) {
        console.error('load transactions error', result.error);
        return loadTransactions();
      }

      var rows = result.data || [];

      return rows.map(mapTransactionRow);
    } catch (err) {
      console.error('fetchTransactionsFromSupabase error', err);
      return loadTransactions();
    }
  }

  function mapClientRow(row) {
    var st = row.status || '';
    var fromStatus = st.toLowerCase().indexOf('retain') !== -1;
    var ex = row.is_retainer;
    var retainer = ex === true || ex === false ? ex : fromStatus;
    var metaRaw = row.metadata;
    var meta = typeof metaRaw === 'string'
      ? (function () {
        try {
          return JSON.parse(metaRaw);
        } catch (_) {
          return null;
        }
      })()
      : metaRaw;
    var base = {
      id: row.id,
      companyName: row.company_name || '',
      contactName: row.contact_name || '',
      status: st,
      industry: row.industry || '',
      email: row.email || '',
      phone: row.phone || '',
      notes: row.notes || '',
      birthday: row.birthday ? String(row.birthday).slice(0, 10) : '',
      communicationStyle: row.communication_style || '',
      preferredChannel: row.preferred_channel || '',
      lastTouchAt: row.last_touch_at ? String(row.last_touch_at).slice(0, 10) : '',
      nextFollowUpAt: row.next_follow_up_at ? String(row.next_follow_up_at).slice(0, 10) : '',
      relationshipNotes: row.relationship_notes || '',
      totalRevenue: Number(row.total_revenue || 0),
      createdAt: row.created_at || null,
      retainer: retainer,
      pipelineId: row.pipeline_id || null,
      pipelineStageId: row.pipeline_stage_id || null,
    };
    return applyClientMetadata(base, meta);
  }

  function mapCrmEventRow(row) {
    return {
      id: row.id,
      clientId: row.client_id || null,
      kind: row.kind || 'note',
      title: row.title || '',
      details: row.details && typeof row.details === 'object' ? row.details : {},
      eventAt: row.event_at || row.created_at || new Date().toISOString(),
    };
  }

  async function fetchCrmEventsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || crmEventsTableUnavailable) return [];
    try {
      var res = await supabase.from('crm_events').select('*').eq('organization_id', getCurrentOrgId()).order('event_at', { ascending: false }).limit(50);
      if (res.error) {
        if (res.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(res.error.message || ''))) {
          crmEventsTableUnavailable = true;
        }
        return [];
      }
      return (res.data || []).map(mapCrmEventRow);
    } catch (_) {
      return [];
    }
  }

  async function fetchWeeklySummariesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || weeklySummariesTableUnavailable) return [];
    try {
      var res = await supabase.from('weekly_summaries').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: false }).limit(12);
      if (res.error) {
        if (res.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(res.error.message || ''))) {
          weeklySummariesTableUnavailable = true;
        }
        return [];
      }
      return res.data || [];
    } catch (_) {
      return [];
    }
  }

  async function addCrmEvent(kind, title, details, clientId, idempotencyKey) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return;
    var payloadDetails = details && typeof details === 'object' ? Object.assign({}, details) : {};
    if (idempotencyKey) {
      var exists = crmEvents.some(function (ev) { return ev && ev.details && ev.details.idempotencyKey === idempotencyKey; });
      if (exists) return;
      payloadDetails.idempotencyKey = idempotencyKey;
    }
    var payload = {
      id: uuid(),
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      client_id: clientId || null,
      kind: kind || 'note',
      title: title || 'Activity',
      details: payloadDetails,
      event_at: new Date().toISOString(),
    };
    try {
      var res = await supabase.from('crm_events').insert(payload);
      if (!res.error) crmEvents.unshift(mapCrmEventRow(payload));
      else if (res.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(res.error.message || ''))) crmEventsTableUnavailable = true;
    } catch (_) {}
  }

  // ---------- Workflow automation (schema v1; see supabase/workflow_automation.sql) ----------
  // trigger: { v:1, type: 'client.stage_entered'|'client.status_changed'|'activity.created'|'campaign.status_changed', ... }
  // actions: [{ type: 'set_client_stage'|'set_client_field'|'create_task'|'add_crm_event'|'notify_external', ... }]
  var wfPipelines = [];
  var wfStages = [];
  var wfRules = [];
  var wfTasks = [];
  var wfSchemaUnavailable = false;
  var crmEventsTableUnavailable = false;
  var weeklySummariesTableUnavailable = false;
  var wfDispatchDepth = 0;
  var WF_MAX_ACTIONS = 8;
  var WF_TRIGGER_TYPES = {
    CLIENT_STAGE_ENTERED: 'client.stage_entered',
    CLIENT_STATUS_CHANGED: 'client.status_changed',
    ACTIVITY_CREATED: 'activity.created',
    CAMPAIGN_STATUS_CHANGED: 'campaign.status_changed',
  };

  function wfStageSlugById(stageId) {
    if (!stageId) return '';
    var s = wfStages.find(function (x) { return x.id === stageId; });
    return s ? String(s.slug || '') : '';
  }

  function wfDefaultClientPipelineId() {
    var def = wfPipelines.find(function (p) { return p.entity === 'client' && p.is_default; });
    if (def) return def.id;
    var any = wfPipelines.find(function (p) { return p.entity === 'client'; });
    return any ? any.id : null;
  }

  function wfStagesForPipeline(pid) {
    if (!pid) return [];
    return wfStages.filter(function (s) { return s.pipelineId === pid; }).sort(function (a, b) {
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  }

  function wfFillClientPipelineSelect(selEl, client) {
    if (!selEl) return;
    function escOpt(t) {
      return String(t || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    }
    var pid = (client && client.pipelineId) || wfDefaultClientPipelineId();
    var stages = wfStagesForPipeline(pid);
    selEl.innerHTML = '<option value="">— None —</option>' +
      stages.map(function (s) {
        return '<option value="' + String(s.id).replace(/"/g, '&quot;') + '">' + escOpt(s.label) + '</option>';
      }).join('');
    if (client && client.pipelineStageId) selEl.value = client.pipelineStageId;
    else selEl.value = '';
  }

  function mapWorkspaceTaskRow(row) {
    return {
      id: row.id,
      title: row.title || '',
      body: row.body || '',
      status: row.status || 'open',
      dueAt: row.due_at || null,
      clientId: row.client_id || null,
      campaignId: row.campaign_id || null,
      createdBy: row.created_by || 'user',
      workflowRunId: row.workflow_run_id || null,
    };
  }

  async function wfRefreshFromSupabase() {
    wfPipelines = [];
    wfStages = [];
    wfRules = [];
    wfTasks = [];
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || isDemoDashboardUser() || wfSchemaUnavailable) return;
    try {
      var pr = await supabase.from('pipelines').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: true });
      if (pr && pr.error && (pr.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(pr.error.message || '')))) {
        wfSchemaUnavailable = true;
        return;
      }
      wfPipelines = pr.error ? [] : (pr.data || []).map(function (r) {
        return { id: r.id, name: r.name, entity: r.entity, isDefault: !!r.is_default };
      });
      var sr = await supabase.from('pipeline_stages').select('*').eq('organization_id', getCurrentOrgId()).order('sort_order', { ascending: true });
      wfStages = sr.error ? [] : (sr.data || []).map(function (r) {
        return { id: r.id, pipelineId: r.pipeline_id, label: r.label, slug: r.slug, sortOrder: r.sort_order || 0, color: r.color || '' };
      });
      var rr = await supabase.from('workflow_rules').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: true });
      wfRules = rr.error ? [] : (rr.data || []).map(function (r) {
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled !== false,
          pipelineId: r.pipeline_id || null,
          trigger: typeof r.trigger === 'object' && r.trigger ? r.trigger : {},
          actions: Array.isArray(r.actions) ? r.actions : [],
        };
      });
      var tr = await supabase.from('workspace_tasks').select('*').eq('organization_id', getCurrentOrgId()).order('due_at', { ascending: true }).limit(200);
      wfTasks = tr.error ? [] : (tr.data || []).map(mapWorkspaceTaskRow);
    } catch (e) {
      console.warn('wfRefreshFromSupabase', e);
    }
  }

  function wfValidateRule(rule) {
    var errs = [];
    if (!rule || typeof rule !== 'object') return { ok: false, errors: ['invalid rule'] };
    var tr = rule.trigger || {};
    if (tr.v !== 1) errs.push('trigger.v must be 1');
    var tt = tr.type;
    var okT = [
      WF_TRIGGER_TYPES.CLIENT_STAGE_ENTERED,
      WF_TRIGGER_TYPES.CLIENT_STATUS_CHANGED,
      WF_TRIGGER_TYPES.ACTIVITY_CREATED,
      WF_TRIGGER_TYPES.CAMPAIGN_STATUS_CHANGED,
    ];
    if (!tt || okT.indexOf(tt) === -1) errs.push('trigger.type must be a supported v1 type');
    var acts = rule.actions;
    if (!Array.isArray(acts)) errs.push('actions must be an array');
    else if (acts.length > WF_MAX_ACTIONS) errs.push('at most ' + WF_MAX_ACTIONS + ' actions');
    else {
      var okActs = {
        set_client_stage: 1,
        set_client_field: 1,
        create_task: 1,
        add_crm_event: 1,
        notify_external: 1,
      };
      acts.forEach(function (a, i) {
        if (!a || typeof a !== 'object' || !a.type) errs.push('action ' + i + ' needs type');
        else if (!okActs[a.type]) errs.push('action ' + i + ' unknown type ' + a.type);
      });
    }
    return { ok: !errs.length, errors: errs };
  }

  function wfMatchTrigger(rule, evt) {
    var t = rule.trigger || {};
    if (t.v !== 1) return false;
    if (evt.kind === 'client_updated' && t.type === WF_TRIGGER_TYPES.CLIENT_STAGE_ENTERED) {
      if (!evt.after) return false;
      var prev = evt.before ? evt.before.pipelineStageId : null;
      var next = evt.after.pipelineStageId || null;
      if (prev === next) return false;
      if (t.stage_slug && wfStageSlugById(next) !== t.stage_slug) return false;
      if (t.from_slug && wfStageSlugById(prev) !== t.from_slug) return false;
      if (rule.pipelineId && evt.after.pipelineId && rule.pipelineId !== evt.after.pipelineId) return false;
      return true;
    }
    if (evt.kind === 'client_updated' && t.type === WF_TRIGGER_TYPES.CLIENT_STATUS_CHANGED) {
      if (!evt.after) return false;
      var bs = (evt.before && evt.before.status) || '';
      var as = evt.after.status || '';
      if (bs === as) return false;
      if (t.status_contains && as.toLowerCase().indexOf(String(t.status_contains).toLowerCase()) === -1) return false;
      return true;
    }
    if (evt.kind === 'activity_created' && t.type === WF_TRIGGER_TYPES.ACTIVITY_CREATED) {
      if (!evt.activity) return false;
      if (t.activity_type && evt.activity.activity_type !== t.activity_type) return false;
      return true;
    }
    if (evt.kind === 'campaign_updated' && t.type === WF_TRIGGER_TYPES.CAMPAIGN_STATUS_CHANGED) {
      if (!evt.after) return false;
      var bs2 = evt.before && evt.before.status;
      var as2 = evt.after.status;
      if (bs2 === as2) return false;
      if (t.status && evt.after.status !== t.status) return false;
      return true;
    }
    return false;
  }

  function wfIdempotencyKey(rule, evt) {
    var day = new Date().toISOString().slice(0, 10);
    if (evt.kind === 'client_updated') {
      return rule.id + ':client:' + (evt.after && evt.after.id) + ':' + String(evt.after && evt.after.pipelineStageId || '') + ':' + day;
    }
    if (evt.kind === 'activity_created' && evt.activity && evt.activity.id) {
      return rule.id + ':activity:' + evt.activity.id;
    }
    if (evt.kind === 'campaign_updated') {
      return rule.id + ':campaign:' + (evt.after && evt.after.id) + ':' + String(evt.after && evt.after.status || '') + ':' + day;
    }
    return rule.id + ':misc:' + day + ':' + String(Math.random()).slice(2, 10);
  }

  function wfCloneClientForWorkflow(c) {
    if (!c) return null;
    try {
      return JSON.parse(JSON.stringify(c));
    } catch (_) {
      return null;
    }
  }

  function wfCloneCampaign(c) {
    if (!c) return null;
    try {
      return JSON.parse(JSON.stringify(c));
    } catch (_) {
      return null;
    }
  }

  async function wfTryInsertWorkflowRun(ruleId, idempotencyKey, triggerPayload) {
    var rid = uuid();
    var row = {
      id: rid,
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      rule_id: ruleId,
      idempotency_key: idempotencyKey,
      trigger_payload: triggerPayload,
      status: 'running',
    };
    try {
      var res = await supabase.from('workflow_runs').insert(row);
      if (res.error) {
        var es = JSON.stringify(res.error || {});
        if (/duplicate|23505|unique/i.test(es)) return null;
        console.error('workflow_runs insert', res.error);
        return null;
      }
      return rid;
    } catch (e) {
      console.error('workflow_runs insert', e);
      return null;
    }
  }

  async function wfUpdateWorkflowRun(runId, status, errMsg) {
    if (!runId) return;
    try {
      await supabase.from('workflow_runs').update({ status: status, error: errMsg || null }).eq('id', runId).eq('organization_id', getCurrentOrgId());
    } catch (_) {}
  }

  async function wfInsertOutboxStub(channel, payload) {
    try {
      await supabase.from('workflow_outbox').insert({
        id: uuid(),
        user_id: currentUser.id,
        organization_id: getCurrentOrgId(),
        channel: channel || 'stub',
        payload: payload || {},
      });
    } catch (_) {}
  }

  function wfFindStageBySlug(pipelineId, slug) {
    return wfStages.find(function (s) {
      return s.pipelineId === pipelineId && s.slug === slug;
    });
  }

  async function wfExecuteActions(rule, evt, runId) {
    var acts = Array.isArray(rule.actions) ? rule.actions : [];
    var err = '';
    try {
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        if (!a || !a.type) continue;
        if (a.type === 'set_client_stage') {
          var client = evt.kind === 'client_updated' && evt.after ? evt.after : evt.client;
          if (!client || !client.id) continue;
          var pid = rule.pipelineId || client.pipelineId || wfDefaultClientPipelineId();
          if (!pid || !a.stage_slug) continue;
          var st = wfFindStageBySlug(pid, a.stage_slug);
          if (!st) continue;
          clients = clients.map(function (c) {
            if (c.id !== client.id) return c;
            var n = Object.assign({}, c, { pipelineId: pid, pipelineStageId: st.id, status: st.label });
            return n;
          });
          var updated = clients.find(function (c) { return c.id === client.id; });
          saveClients(clients);
          if (updated) await persistClientToSupabase(updated, 'update');
        } else if (a.type === 'set_client_field') {
          var fld = String(a.field || '').trim();
          var allowed = { status: 1, notes: 1, nextFollowUpAt: 1 };
          if (!allowed[fld]) continue;
          var cid = (evt.after && evt.after.id) || (evt.client && evt.client.id);
          if (!cid) continue;
          var val = a.value != null ? String(a.value) : '';
          clients = clients.map(function (c) {
            if (c.id !== cid) return c;
            var n = Object.assign({}, c);
            if (fld === 'notes' && a.append) {
              n.notes = (n.notes || '') + (n.notes ? '\n' : '') + val;
            } else {
              n[fld] = val;
            }
            return n;
          });
          var u2 = clients.find(function (c) { return c.id === cid; });
          saveClients(clients);
          if (u2) await persistClientToSupabase(u2, 'update');
        } else if (a.type === 'create_task') {
          var title = String(a.title || 'Follow up').slice(0, 500);
          var dueDays = Math.max(0, Math.min(365, parseInt(a.due_days, 10) || 0));
          var due = new Date();
          due.setDate(due.getDate() + dueDays);
          var cliId = (evt.after && evt.after.id) || (evt.client && evt.client.id) || null;
          var taskRow = {
            id: uuid(),
            user_id: currentUser.id,
            organization_id: getCurrentOrgId(),
            title: title,
            body: String(a.body || ''),
            status: 'open',
            due_at: due.toISOString(),
            client_id: cliId,
            campaign_id: evt.after && evt.kind === 'campaign_updated' ? evt.after.id : null,
            created_by: 'workflow',
            workflow_run_id: runId,
          };
          var ins = await supabase.from('workspace_tasks').insert(taskRow);
          if (!ins.error) wfTasks.push(mapWorkspaceTaskRow(taskRow));
        } else if (a.type === 'add_crm_event') {
          var k = String(a.kind || 'workflow').slice(0, 40);
          var ttl = String(a.title || rule.name || 'Workflow').slice(0, 200);
          await addCrmEvent(k, ttl, { ruleId: rule.id, runId: runId }, evt.after && evt.after.id || evt.client && evt.client.id || null, 'wf:' + runId + ':' + i);
        } else if (a.type === 'notify_external') {
          await wfInsertOutboxStub(a.channel || 'stub', { ruleId: rule.id, runId: runId, message: a.message || '' });
          await addCrmEvent('workflow', 'External notify (stub): ' + String(a.message || 'queued').slice(0, 120), { channel: a.channel }, evt.after && evt.after.id || null, 'wf-out:' + runId + ':' + i);
        }
      }
      await wfUpdateWorkflowRun(runId, 'success', null);
    } catch (e) {
      err = String(e && e.message ? e.message : e);
      await wfUpdateWorkflowRun(runId, 'error', err);
    }
  }

  async function runWorkflowDispatch(evt) {
    if (!evt || !evt.kind) return;
    if (wfDispatchDepth > 0) return;
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || isDemoDashboardUser()) return;
    await wfRefreshFromSupabase();
    if (!wfRules.length) return;
    wfDispatchDepth++;
    try {
      for (var ri = 0; ri < wfRules.length; ri++) {
        var rule = wfRules[ri];
        if (!rule || !rule.enabled) continue;
        var v = wfValidateRule(rule);
        if (!v.ok) continue;
        if (!wfMatchTrigger(rule, evt)) continue;
        var idem = wfIdempotencyKey(rule, evt);
        var runId = await wfTryInsertWorkflowRun(rule.id, idem, evt);
        if (!runId) continue;
        await wfExecuteActions(rule, evt, runId);
      }
    } finally {
      wfDispatchDepth--;
    }
  }

  async function wfCreateDefaultClientPipeline() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return { ok: false, error: 'Sign in required' };
    await wfRefreshFromSupabase();
    if (wfPipelines.some(function (p) { return p.entity === 'client'; })) {
      return { ok: false, error: 'You already have a client pipeline. Delete stages in Supabase or reuse it.' };
    }
    var pid = uuid();
    var insP = await supabase.from('pipelines').insert({
      id: pid,
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      name: 'Sales',
      entity: 'client',
      is_default: true,
    });
    if (insP.error) return { ok: false, error: formatSupabaseErr(insP.error) };
    var stages = [
      { label: 'Lead', slug: 'lead', sort: 0 },
      { label: 'Qualified', slug: 'qualified', sort: 1 },
      { label: 'Customer', slug: 'customer', sort: 2 },
    ];
    for (var i = 0; i < stages.length; i++) {
      var st = stages[i];
      await supabase.from('pipeline_stages').insert({
        id: uuid(),
        pipeline_id: pid,
        user_id: currentUser.id,
        organization_id: getCurrentOrgId(),
        label: st.label,
        slug: st.slug,
        sort_order: st.sort,
      });
    }
    await wfRefreshFromSupabase();
    return { ok: true };
  }

  async function wfInsertActivity(clientId, activityType, notes, occurredAt) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !clientId || !getCurrentOrgId()) return null;
    var row = {
      id: uuid(),
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      client_id: clientId,
      activity_type: activityType || 'meeting',
      notes: notes || '',
      occurred_at: occurredAt || new Date().toISOString(),
    };
    try {
      var res = await supabase.from('crm_activities').insert(row).select('id');
      if (res.error || !res.data || !res.data.length) {
        if (res.error) console.error('crm_activities insert', res.error);
        return null;
      }
      return Object.assign({}, row, { id: res.data[0].id, activity_type: row.activity_type });
    } catch (e) {
      console.error('crm_activities insert', e);
      return null;
    }
  }

  async function wfUpsertRuleToSupabase(rule) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return { ok: false, error: 'Sign in required' };
    var v = wfValidateRule(rule);
    if (!v.ok) return { ok: false, error: v.errors.join('; ') };
    var row = {
      id: rule.id || uuid(),
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      name: rule.name || 'Rule',
      enabled: rule.enabled !== false,
      pipeline_id: rule.pipelineId || null,
      trigger: rule.trigger,
      actions: rule.actions,
      updated_at: new Date().toISOString(),
    };
    try {
      var res = await supabase.from('workflow_rules').upsert(row, { onConflict: 'id' });
      if (res.error) return { ok: false, error: formatSupabaseErr(res.error) };
      await wfRefreshFromSupabase();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  async function wfDeleteRuleById(ruleId) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !ruleId) return;
    try {
      await supabase.from('workflow_rules').delete().eq('id', ruleId).eq('organization_id', getCurrentOrgId());
      await wfRefreshFromSupabase();
    } catch (_) {}
  }

  async function wfSeedExampleMeetingRule() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      alert('Sign in to create automation rules.');
      return;
    }
    await wfRefreshFromSupabase();
    var pid = wfDefaultClientPipelineId();
    if (!pid) {
      alert('Create a default client pipeline first (button above).');
      return;
    }
    if (!wfFindStageBySlug(pid, 'qualified')) {
      alert('Default pipeline must include a stage with slug \"qualified\" (included in the default template).');
      return;
    }
    var r = {
      id: uuid(),
      name: 'Meeting logged → Qualified + follow-up task',
      enabled: true,
      pipelineId: pid,
      trigger: { v: 1, type: WF_TRIGGER_TYPES.ACTIVITY_CREATED, activity_type: 'meeting' },
      actions: [
        { type: 'set_client_stage', stage_slug: 'qualified' },
        { type: 'create_task', title: 'Follow up after meeting', due_days: 2, body: 'Created by workflow automation' },
        { type: 'add_crm_event', kind: 'workflow', title: 'Post-meeting automation ran' },
      ],
    };
    var out = await wfUpsertRuleToSupabase(r);
    if (!out.ok) alert(out.error || 'Could not save rule');
    else renderAutomationSettings();
  }

  function renderAutomationSettings() {
    var host = $('wf-automation-dynamic');
    if (!host) return;
    var pline = wfPipelines.filter(function (p) { return p.entity === 'client'; }).map(function (p) {
      return '<li style="margin:4px 0;">' + esc(p.name) + ' · ' + wfStages.filter(function (s) { return s.pipelineId === p.id; }).length + ' stages</li>';
    }).join('');
    var rules = wfRules.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:10px;">' +
        '<div style="min-width:0;"><div style="font-weight:600;font-size:13px;">' + esc(r.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text3);">' + (r.enabled ? 'On' : 'Off') + ' · ' + esc((r.trigger && r.trigger.type) || '') + '</div></div>' +
        '<button type="button" class="btn" data-wf-del-rule="' + esc(r.id) + '" style="color:var(--red);">Delete</button></div>';
    }).join('');
    host.innerHTML =
      '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Client pipelines</div>' +
      (pline ? '<ul style="margin:0 0 14px 18px;padding:0;">' + pline + '</ul>' : '<p style="font-size:12px;color:var(--text3);">No client pipeline yet.</p>') +
      '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Rules (' + wfRules.length + ')</div>' +
      (rules || '<p style="font-size:12px;color:var(--text3);">No rules yet.</p>');
  }

  function renderTasksPage() {
    var body = $('wf-tasks-tbody');
    if (!body) return;
    var open = wfTasks.filter(function (t) { return t.status === 'open'; });
    if (!open.length) {
      body.innerHTML = '<tr><td colspan="4" style="font-size:13px;color:var(--text3);padding:12px;">No open tasks. Workflows can create tasks when triggers fire.</td></tr>';
      return;
    }
    body.innerHTML = open.map(function (t) {
      var cl = t.clientId ? (clients.find(function (c) { return c.id === t.clientId; }) || {}) : {};
      var cn = cl.companyName || '—';
      var due = t.dueAt ? String(t.dueAt).slice(0, 10) : '—';
      return '<tr>' +
        '<td style="font-size:13px;">' + esc(t.title) + '</td>' +
        '<td style="font-size:12px;color:var(--text3);">' + esc(cn) + '</td>' +
        '<td style="font-size:12px;">' + esc(due) + '</td>' +
        '<td><button type="button" class="btn" data-wf-task-done="' + esc(t.id) + '">Done</button></td>' +
      '</tr>';
    }).join('');
  }

  function wireWorkflowAutomation() {
    var dyn = $('wf-automation-dynamic');
    if (dyn && dyn.getAttribute('data-wf-wired') !== '1') {
      dyn.setAttribute('data-wf-wired', '1');
      dyn.addEventListener('click', async function (ev) {
        var del = ev.target.closest('[data-wf-del-rule]');
        if (del) {
          var rid = del.getAttribute('data-wf-del-rule');
          if (rid && confirm('Delete this rule?')) {
            await wfDeleteRuleById(rid);
            renderAutomationSettings();
          }
        }
      });
    }
    var btnP = $('btn-wf-create-pipeline');
    if (btnP && btnP.getAttribute('data-wf-wired') !== '1') {
      btnP.setAttribute('data-wf-wired', '1');
      btnP.addEventListener('click', async function () {
        var r = await wfCreateDefaultClientPipeline();
        if (!r.ok) alert(r.error || 'Could not create pipeline');
        await wfRefreshFromSupabase();
        renderAutomationSettings();
      });
    }
    var btnS = $('btn-wf-seed-rule');
    if (btnS && btnS.getAttribute('data-wf-wired') !== '1') {
      btnS.setAttribute('data-wf-wired', '1');
      btnS.addEventListener('click', function () {
        wfSeedExampleMeetingRule();
      });
    }
    var tasksTable = $('wf-tasks-table');
    if (tasksTable && tasksTable.getAttribute('data-wf-wired') !== '1') {
      tasksTable.setAttribute('data-wf-wired', '1');
      tasksTable.addEventListener('click', async function (ev) {
        var b = ev.target.closest('[data-wf-task-done]');
        if (!b) return;
        var tid = b.getAttribute('data-wf-task-done');
        supabase = window.supabaseClient || supabase;
        currentUser = window.currentUser || currentUser;
        if (!supabase || !currentUser || !tid) return;
        await supabase.from('workspace_tasks').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', tid).eq('organization_id', getCurrentOrgId());
        await wfRefreshFromSupabase();
        renderTasksPage();
      });
    }
  }

  /**
   * Merge remote clients (source of truth for ids present on server) with local-only rows
   * so devices that never received a row still upload it. Preserve explicit retainer checkbox from local when ids match.
   */
  function mergeClientsPreserveRetainer(prevList, remoteList) {
    var prevById = {};
    (prevList || []).forEach(function (c) {
      if (c && c.id) prevById[c.id] = c;
    });
    var onServer = {};
    var out = (remoteList || []).map(function (c) {
      if (!c || !c.id) return null;
      onServer[c.id] = true;
      var prev = prevById[c.id];
      var next = Object.assign({}, c);
      if (prev && typeof prev.retainer === 'boolean') next.retainer = prev.retainer;
      return next;
    }).filter(Boolean);
    (prevList || []).forEach(function (c) {
      if (c && c.id && !onServer[c.id]) {
        out.push(Object.assign({}, c));
      }
    });
    return out;
  }

  function clientIsRetainer(c) {
    if (!c) return false;
    if (c.retainer === true) return true;
    return (c.status || '').toLowerCase().indexOf('retain') !== -1;
  }

  var TX_RECURRENCE_KEYS = ['recurrence', 'recurrenceSeriesId', 'expenseRecurringLead', 'expenseRecurrenceInstance', 'recurring'];

  function remoteHasExpenseRecurrenceMeta(t) {
    if (!t) return false;
    if (t.recurrenceSeriesId) return true;
    if (t.expenseRecurringLead === true || t.expenseRecurrenceInstance === true) return true;
    if (t.recurrence && typeof t.recurrence === 'object' && Object.keys(t.recurrence).length) return true;
    if (t.recurring === true) return true;
    return false;
  }

  function mergeTransactionsPreserveRecurrence(prevList, remoteList) {
    var prevById = {};
    (prevList || []).forEach(function (t) {
      if (t && t.id) prevById[t.id] = t;
    });
    function textMissing(v) {
      return v == null || !String(v).trim();
    }
    return (remoteList || []).map(function (t) {
      var p = prevById[t.id];
      if (!p) return t;
      var next = Object.assign({}, t);
      if (textMissing(next.title) && !textMissing(p.title)) next.title = p.title;
      if (textMissing(next.vendor) && !textMissing(p.vendor)) next.vendor = p.vendor;
      if (textMissing(next.notes) && !textMissing(p.notes)) next.notes = p.notes;
      if (textMissing(next.source) && !textMissing(p.source)) next.source = p.source;
      if (textMissing(next.incomeCategoryLabel) && !textMissing(p.incomeCategoryLabel)) {
        next.incomeCategoryLabel = p.incomeCategoryLabel;
      }
      // Prefer cloud copy for recurring metadata so a stale local row cannot wipe synced fields.
      if (!remoteHasExpenseRecurrenceMeta(t)) {
        TX_RECURRENCE_KEYS.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(p, k)) next[k] = p[k];
        });
      }
      return next;
    });
  }

  async function fetchClientsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) {
      return loadClients();
    }

    try {
      var result = await supabase
        .from('clients')
        .select('*')
        .eq('organization_id', getCurrentOrgId())
        .order('created_at', { ascending: true });

      if (result.error) {
        console.error('load clients error', result.error);
        return loadClients();
      }

      var rows = result.data || [];

      return rows.map(mapClientRow);
    } catch (err) {
      console.error('fetchClientsFromSupabase error', err);
      return loadClients();
    }
  }

  function populateProjectClientOptions() {
    var select = $('project-client');
    if (!select) return;
    var opts = ['<option value="">— None —</option>'];
    clients.forEach(function (c) {
      opts.push('<option value="' + (c.id || '') + '">' + (c.companyName || 'Untitled client') + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  function populateProjectStatusOptions() {
    var select = $('project-status');
    if (!select) return;
    var opts = ['<option value="">— Select status —</option>'];
    projectStatuses.forEach(function (label) {
      opts.push('<option value="' + label + '">' + label + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  /** Options HTML for the inline status select in Active Projects (same labels as the modal). */
  function buildProjectRowStatusOptionsHtml(currentStatus) {
    var cur = String(currentStatus || '').trim();
    var opts = [];
    var seen = {};
    if (!cur) {
      opts.push('<option value="" selected>—</option>');
    }
    projectStatuses.forEach(function (label) {
      seen[label] = true;
      var selected = label === cur ? ' selected' : '';
      opts.push('<option value="' + esc(label) + '"' + selected + '>' + esc(label) + '</option>');
    });
    if (cur && !seen[cur]) {
      opts.unshift('<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>');
    }
    return opts.join('');
  }

  function populateIncomeClientOptions() {
    var incOpts = ['<option value="">— None —</option>'];
    var expOpts = ['<option value="">— None (unallocated) —</option>'];
    clients.forEach(function (c) {
      var o = '<option value="' + (c.id || '') + '">' + (c.companyName || 'Untitled client') + '</option>';
      incOpts.push(o);
      expOpts.push(o);
    });
    var inc = $('income-client');
    if (inc) inc.innerHTML = incOpts.join('');
    var exp = $('expense-client');
    if (exp) exp.innerHTML = expOpts.join('');
  }

  function populateIncomeProjectOptions() {
    var select = $('income-project');
    if (!select) return;
    var opts = ['<option value="">— None —</option>'];
    projects.forEach(function (p) {
      opts.push('<option value="' + (p.id || '') + '">' + (p.name || 'Untitled project') + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  // ---------- Date helpers ----------

  function parseDate(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function isWithinRange(dateStr, filter) {
    if (filter.mode === 'all') return true;
    var d = parseDate(dateStr);
    if (!d) return false;
    if (filter.mode === 'month') {
      var now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
    if (filter.mode === 'range') {
      var start = filter.start ? parseDate(filter.start) : null;
      var end = filter.end ? parseDate(filter.end) : null;
      if (start && d < start) return false;
      if (end) {
        var endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
        if (d > endDay) return false;
      }
      return true;
    }
    return true;
  }

  /** Month, day, and full year for chart labels/tooltips (avoids "Mar 26" reading as month + day when 26 is the year). */
  function chartPointDateLabel(isoDateStr, fallbackYear, fallbackMonthIndex0) {
    var d = isoDateStr ? parseDate(isoDateStr) : null;
    if (!d || isNaN(d.getTime())) {
      d = new Date(fallbackYear, fallbackMonthIndex0, 1);
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------- Compute ----------

  /** True for series lead, generated instances, or legacy recurring flag (metadata round-trips). */
  function isFixedRecurringExpense(tx) {
    return !!(tx && (tx.expenseRecurringLead === true || tx.expenseRecurrenceInstance === true || tx.recurring === true));
  }

  function compute(filter) {
    var txs = state.transactions.slice().filter(function (tx) {
      return isWithinRange(tx.date, filter);
    });

    var revenueByCat = { svc: 0, ret: 0 };
    var expenseByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    var expenseFixedTotal = 0;
    var expenseVariableTotal = 0;

    txs.forEach(function (tx) {
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      switch (tx.category) {
        case 'svc':
        case 'ret':
          revenueByCat[tx.category] += amt;
          break;
        case 'lab':
        case 'sw':
        case 'ads':
        case 'oth':
          expenseByCat[tx.category] += amt;
          if (isFixedRecurringExpense(tx)) expenseFixedTotal += amt;
          else expenseVariableTotal += amt;
          break;
        case 'own':
          // Owner equity injection: tracked in ledger but excluded from revenue / expense / net.
          break;
      }
    });

    var revenueTotal = revenueByCat.svc + revenueByCat.ret;
    var expenseTotal = expenseByCat.lab + expenseByCat.sw + expenseByCat.ads + expenseByCat.oth;
    var net = revenueTotal - expenseTotal;
    // Gross profit / gross margin use labor (delivery) only as COGS; netProfit is after all expense buckets—do not conflate.
    var cogsTotal = expenseByCat.lab;
    var grossProfit = revenueTotal - cogsTotal;
    var grossMarginPct = revenueTotal > 0.01 ? (grossProfit / revenueTotal) * 100 : null;

    return {
      filter: filter,
      txs: txs.sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      }),
      revenueByCat: revenueByCat,
      expenseByCat: expenseByCat,
      revenueTotal: revenueTotal,
      expenseTotal: expenseTotal,
      expenseFixedTotal: expenseFixedTotal,
      expenseVariableTotal: expenseVariableTotal,
      cogsTotal: cogsTotal,
      grossProfit: grossProfit,
      grossMarginPct: grossMarginPct,
      netProfit: net,
    };
  }

  /** YYYY-MM-DD bounds for the dashboard period selector (month = full calendar month). */
  function dashboardCurrentYmdBounds(filter) {
    if (!filter || filter.mode === 'all') return null;
    if (filter.mode === 'month') {
      var now = new Date();
      var y = now.getFullYear();
      var m = now.getMonth();
      var s = new Date(y, m, 1, 12, 0, 0, 0);
      var e = new Date(y, m + 1, 0, 12, 0, 0, 0);
      return { start: dateYMD(s), end: dateYMD(e) };
    }
    if (filter.mode === 'range' && filter.start && filter.end) {
      return { start: filter.start, end: filter.end };
    }
    return null;
  }

  /** Prior period for MoM / PoP: previous calendar month, or equal-length window before custom range. */
  function dashboardPriorYmdBounds(filter) {
    if (!filter || filter.mode === 'all') return null;
    if (filter.mode === 'month') {
      var now = new Date();
      var firstThis = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0);
      var lastPrev = new Date(firstThis.getTime());
      lastPrev.setDate(0);
      var firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1, 12, 0, 0, 0);
      return { start: dateYMD(firstPrev), end: dateYMD(lastPrev) };
    }
    if (filter.mode === 'range' && filter.start && filter.end) {
      return spendPriorRange(filter.start, filter.end);
    }
    return null;
  }

  function computeForYmdRange(start, end) {
    return compute({ mode: 'range', start: start, end: end });
  }

  // ---------- DOM helpers ----------

  function $(id) {
    return document.getElementById(id);
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function animateRollout(panel, show, immediate) {
    if (!panel) return;
    if (prefersReducedMotion() || immediate) {
      panel.classList.toggle('on', !!show);
      panel.style.display = show ? 'block' : 'none';
      panel.style.height = show ? 'auto' : '0px';
      return;
    }
    panel.style.display = 'block';
    panel.style.overflow = 'hidden';
    var startH = panel.getBoundingClientRect().height;
    var endH = show ? panel.scrollHeight : 0;
    panel.style.height = String(startH) + 'px';
    panel.getBoundingClientRect();
    panel.classList.toggle('on', !!show);
    panel.style.height = String(endH) + 'px';
    var onDone = function () {
      panel.removeEventListener('transitionend', onDone);
      if (show) panel.style.height = 'auto';
      else panel.style.display = 'none';
    };
    panel.addEventListener('transitionend', onDone);
  }

  function stagePageMotion(container) {
    if (!container || prefersReducedMotion()) return;
    var selectors = '.ph, .kg .kc, .card, .ts-kpi, .bva-row, .dt tbody tr';
    var nodes = container.querySelectorAll(selectors);
    var cap = Math.min(nodes.length, 22);
    for (var i = 0; i < cap; i += 1) {
      var node = nodes[i];
      node.classList.remove('motion-in');
      node.classList.add('motion-item');
      node.style.setProperty('--motion-delay', String(Math.min(i * 28, 280)) + 'ms');
      void node.offsetWidth;
      node.classList.add('motion-in');
    }
  }

  function setKpiBadge(id, text, tone) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    var t = tone === 'up' ? 'bu' : tone === 'down' ? 'bd' : 'bn';
    el.className = 'kb ' + t;
  }

  /** tone: 'up' | 'down' | 'neutral' for badge coloring. */
  function formatDashboardKpiDelta(currentVal, priorVal, metric) {
    var cur = +currentVal || 0;
    var pri = +priorVal || 0;
    var eps = 0.005;
    if (Math.abs(pri) < eps && Math.abs(cur) < eps) {
      return { text: '—', tone: 'neutral' };
    }
    if (Math.abs(pri) < eps) {
      if (metric === 'revenue' || metric === 'profit') {
        return { text: 'New', tone: 'up' };
      }
      if (metric === 'expense') {
        return { text: 'New', tone: 'down' };
      }
      return { text: 'New', tone: 'neutral' };
    }
    var delta = cur - pri;
    var pct = (delta / pri) * 100;
    var arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    var absPct = Math.abs(pct);
    var pctStr = absPct >= 100 ? String(Math.round(pct)) : String(Math.round(pct * 10) / 10);
    if (pctStr.indexOf('.') !== -1) {
      pctStr = pctStr.replace(/\.0$/, '');
    }
    var text = arrow + ' ' + pctStr + '%';
    var up = cur > pri;
    var down = cur < pri;
    if (!up && !down) return { text: text, tone: 'neutral' };
    if (metric === 'expense') {
      return { text: text, tone: up ? 'down' : 'up' };
    }
    return { text: text, tone: up ? 'up' : 'down' };
  }

  /** Compare gross margin % vs prior period; delta in percentage points (higher margin = up). */
  function formatGrossMarginDeltaPctPoints(currentPct, priorPct) {
    var cur = currentPct;
    var pri = priorPct;
    if (cur == null || isNaN(cur)) {
      return { text: '—', tone: 'neutral' };
    }
    if (pri == null || isNaN(pri)) {
      return { text: '—', tone: 'neutral' };
    }
    var delta = cur - pri;
    var eps = 0.05;
    if (Math.abs(delta) < eps) {
      return { text: '→ 0 pts', tone: 'neutral' };
    }
    var arrow = delta > 0 ? '↑' : '↓';
    var pts = Math.abs(delta);
    var ptsStr = String(Math.round(pts * 10) / 10);
    if (ptsStr.indexOf('.') !== -1) ptsStr = ptsStr.replace(/\.0$/, '');
    return {
      text: arrow + ' ' + ptsStr + ' pts',
      tone: delta > 0 ? 'up' : 'down',
    };
  }

  function fmtCurrency(n) {
    var v = Math.round(n);
    return '$' + v.toLocaleString();
  }

  function fmtCurrencyPrecise(n) {
    var v = Number(n || 0);
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDateDisplay(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US');
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Charts ----------

var expenseChart = null;
var revExpChart = null;
var projTypeChart = null;
var projMonthlyChart = null;
var revTrendChart = null;
var verticalChart = null;
var leadSourceChart = null;
var spendTrendChart = null;
var spendReportTooltipTitles = [];
var spendReportCsvPayload = null;
var spendReportUi = {
  slice: 'category',
  range: '90d',
  interval: 'weekly',
  chartType: 'line',
  tab: 'all',
  q: '',
  costType: 'all',
};
var INCOME_POWER_PREFS_KEY = 'income-power-prefs:v1';
var INCOME_TREND_RANGE_KEY = 'income-trend-range:v1';
var incomeTrendRange = '90d';
var incomePowerColumns = [
  { id: 'date', label: 'Date', type: 'date' },
  { id: 'source', label: 'Source', type: 'text' },
  { id: 'client', label: 'Client', type: 'text' },
  { id: 'project', label: 'Project', type: 'text' },
  { id: 'category', label: 'Category', type: 'enum' },
  { id: 'amount', label: 'Amount', type: 'number' },
  { id: 'invoice', label: 'Invoice', type: 'enum' },
];
var incomePowerState = {
  search: '',
  filters: [],
  visible: { date: true, source: true, client: true, project: true, category: true, amount: true, invoice: true },
  selected: {},
};

  function loadIncomePowerPrefs() {
    try {
      var raw = localStorage.getItem(storageKey(INCOME_POWER_PREFS_KEY));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.search === 'string') incomePowerState.search = parsed.search;
      if (Array.isArray(parsed.filters)) incomePowerState.filters = parsed.filters.slice(0, 6);
      if (parsed.visible && typeof parsed.visible === 'object') {
        incomePowerColumns.forEach(function (col) {
          if (Object.prototype.hasOwnProperty.call(parsed.visible, col.id)) {
            incomePowerState.visible[col.id] = parsed.visible[col.id] !== false;
          }
        });
      }
    } catch (_) {}
  }

  function loadIncomeTrendRange() {
    try {
      var raw = localStorage.getItem(storageKey(INCOME_TREND_RANGE_KEY));
      if (raw === '30d' || raw === '90d' || raw === 'ytd' || raw === 'all') incomeTrendRange = raw;
    } catch (_) {}
  }

  function saveIncomeTrendRange() {
    try {
      localStorage.setItem(storageKey(INCOME_TREND_RANGE_KEY), incomeTrendRange);
    } catch (_) {}
  }

  function saveIncomePowerPrefs() {
    try {
      localStorage.setItem(storageKey(INCOME_POWER_PREFS_KEY), JSON.stringify({
        search: incomePowerState.search || '',
        filters: incomePowerState.filters || [],
        visible: incomePowerState.visible || {},
      }));
    } catch (_) {}
  }

  // Light UI chart theme: primary series follow Settings accent; muted grays for secondary series.
  var CHART_ORANGE = '#e8501a';
  var CHART_ORANGE_FILL = 'rgba(232, 80, 26, 0.1)';
  var CHART_ORANGE_FILL_BAR = 'rgba(232, 80, 26, 0.32)';
  var CHART_ORANGE_BORDER_BAR = 'rgba(232, 80, 26, 0.45)';
  var CHART_EMPTY = '#e4e4e7';
  var CHART_TICK = '#71717a';
  var CHART_GRID = 'rgba(0, 0, 0, 0.04)';
  var CHART_EXPENSE_GRAY = '#d4d4d8';
  /** Expense doughnut / budget bars: accent + stepped shades (updated in applyAccentBranding). */
  var CHART_EXPENSE_LABOR = CHART_ORANGE;
  var CHART_EXPENSE_SOFTWARE = darkenHex(CHART_ORANGE, 0.08);
  var CHART_EXPENSE_ADVERTISING = '#475569';
  var CHART_PALETTE_REST = ['#71717a', '#a1a1aa', '#d4d4d8', '#e4e4e7', '#52525b', '#94a3b8'];
  var CHART_VENDOR_PAL = [CHART_ORANGE, '#71717a', '#64748b', '#a1a1aa', '#94a3b8', '#78716c', '#d4d4d8', '#cbd5e1'];

  function chartMultiColors(count) {
    var c = [];
    for (var i = 0; i < count; i++) {
      c.push(i === 0 ? CHART_ORANGE : CHART_PALETTE_REST[(i - 1) % CHART_PALETTE_REST.length]);
    }
    return c;
  }

  /** Re-apply current branding kit to a revenue-style line dataset (Chart.js caches colors on first create). */
  function syncBrandedRevenueLineDataset(ds) {
    if (!ds) return;
    ds.borderColor = CHART_ORANGE;
    ds.backgroundColor = CHART_ORANGE_FILL;
    ds.pointBackgroundColor = CHART_ORANGE;
    ds.pointHoverBackgroundColor = CHART_ORANGE;
  }

  /** Keep branded bar fills in sync after live accent changes as well as on initial render. */
  function syncBrandedRevenueBarDataset(ds) {
    if (!ds) return;
    ds.backgroundColor = CHART_ORANGE;
    ds.hoverBackgroundColor = CHART_ORANGE;
  }

  function syncMutedExpenseBarDataset(ds) {
    if (!ds) return;
    ds.backgroundColor = CHART_EXPENSE_GRAY;
    ds.hoverBackgroundColor = CHART_EXPENSE_GRAY;
  }

  function renderExpenseChart(c) {
    var canvas = document.getElementById('cExp');
    if (!canvas || !window.Chart) return;

    var labels = [];
    var data = [];

    var map = [
      ['Labor', c.expenseByCat.lab],
      ['Software', c.expenseByCat.sw],
      ['Advertising', c.expenseByCat.ads],
      ['Other', c.expenseByCat.oth],
    ].filter(function (x) { return x[1] > 0.01; });

    function expenseBreakdownSliceColor(label) {
      switch (label) {
        case 'Labor': return CHART_EXPENSE_LABOR;
        case 'Software': return CHART_EXPENSE_SOFTWARE;
        case 'Advertising': return CHART_EXPENSE_ADVERTISING;
        case 'Other': return CHART_EXPENSE_GRAY;
        default: return CHART_PALETTE_REST[0];
      }
    }

    var colors = [];
    if (map.length === 0) {
      labels = ['No expense data'];
      data = [1];
    } else {
      map.forEach(function (pair) {
        labels.push(pair[0]);
        data.push(pair[1]);
        colors.push(expenseBreakdownSliceColor(pair[0]));
      });
    }

    if (!expenseChart) {
      expenseChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: map.length === 0 ? [CHART_EMPTY] : colors,
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: { legend: { display: false } },
        },
      });
    } else {
      expenseChart.data.labels = labels;
      expenseChart.data.datasets[0].data = data;
      expenseChart.data.datasets[0].backgroundColor = map.length === 0 ? [CHART_EMPTY] : colors;
      expenseChart.update('none');
    }

    var leg = $('exp-leg');
    if (!leg) return;
    if (map.length === 0 || c.expenseTotal < 0.01) {
      leg.innerHTML = '<div style="font-size:12px;color:var(--text3);">No expense breakdown yet</div>';
      return;
    }
    leg.innerHTML = map.map(function (pair, idx) {
      var pct = Math.round(pair[1] / c.expenseTotal * 100);
      var color = colors[idx];
      return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">' +
        '<span style="display:flex;align-items:center;gap:7px;color:var(--text2);">' +
        '<span style="width:9px;height:9px;border-radius:2px;background:' + color + ';display:inline-block;flex-shrink:0;"></span>' +
        pair[0] + '</span>' +
        '<span style="color:var(--text);font-weight:500;">' + pct + '%</span>' +
        '</div>';
    }).join('');
  }

  function renderRevenueVsExpenses(c) {
    var canvas = document.getElementById('cRevExp');
    if (!canvas || !window.Chart) return;

    var revTotal = c.revenueTotal || 0;
    var expTotal = c.expenseTotal || 0;

    if (revTotal < 0.01 && expTotal < 0.01) {
      if (revExpChart) {
        revExpChart.data.labels = [];
        revExpChart.data.datasets[0].data = [];
        revExpChart.data.datasets[1].data = [];
        revExpChart.update('none');
      }
      return;
    }

    // Single x category so both bars group side-by-side (not one bar per axis slot).
    var labels = [''];
    var revData = [revTotal];
    var expData = [expTotal];

    if (!revExpChart) {
      revExpChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Revenue',
              data: revData,
              backgroundColor: CHART_ORANGE,
              hoverBackgroundColor: CHART_ORANGE,
              borderRadius: 4,
            },
            {
              label: 'Expenses',
              data: expData,
              backgroundColor: CHART_EXPENSE_GRAY,
              hoverBackgroundColor: CHART_EXPENSE_GRAY,
              borderRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: 'bottom' },
          },
          datasets: {
            bar: {
              categoryPercentage: 0.45,
              barPercentage: 0.9,
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { display: false },
            },
            y: {
              grid: { color: 'rgba(0,0,0,0.05)' },
              ticks: {
                color: CHART_TICK,
                font: { size: 11 },
                callback: function (v) { return '$' + v.toLocaleString(); },
              },
            },
          },
        },
      });
    } else {
      revExpChart.data.labels = labels;
      revExpChart.data.datasets[0].data = revData; // Revenue
      revExpChart.data.datasets[1].data = expData; // Expenses
      syncBrandedRevenueBarDataset(revExpChart.data.datasets[0]);
      syncMutedExpenseBarDataset(revExpChart.data.datasets[1]);
      revExpChart.update('none');
    }
  }

  // ---------- Render ----------

  function renderKPIs(c) {
    setText('kpi-rev', fmtCurrency(c.revenueTotal));
    setText('kpi-exp', fmtCurrency(c.expenseTotal));
    setText('kpi-pft', fmtCurrency(c.netProfit));

    function monthlyizedRetainerRevenueForWindow(startYmd, endYmd) {
      var txs = state.transactions || [];
      var retTxs = txs.filter(function (tx) {
        if (tx.category !== 'ret' || !tx.date) return false;
        var d = parseYMD(tx.date);
        if (isNaN(d.getTime())) return false;
        if (startYmd && tx.date < startYmd) return false;
        if (endYmd && tx.date > endYmd) return false;
        return true;
      });
      if (!retTxs.length) return 0;
      var total = retTxs.reduce(function (sum, tx) { return sum + (+tx.amount || 0); }, 0);
      var months = {};
      retTxs.forEach(function (tx) {
        months[String(tx.date).slice(0, 7)] = true;
      });
      var monthCount = Object.keys(months).length || 1;
      return total / monthCount;
    }

    var curBounds = dashboardCurrentYmdBounds(c.filter || state.filter);
    var mrr = monthlyizedRetainerRevenueForWindow(
      curBounds ? curBounds.start : null,
      curBounds ? curBounds.end : null
    );
    setText('kpi-gm', fmtCurrency(mrr));
    var gmEl = $('kpi-gm');
    if (gmEl) gmEl.style.color = '';

    var expSplit = $('kpi-exp-split');
    if (expSplit) {
      var fx = Number(c.expenseFixedTotal || 0);
      var vr = Number(c.expenseVariableTotal || 0);
      if (fx < 0.01 && vr < 0.01) {
        expSplit.textContent = '';
      } else {
        expSplit.textContent = 'Fixed ' + fmtCurrencyPrecise(fx) + ' · One-time ' + fmtCurrencyPrecise(vr);
      }
    }

    var pftEl = $('kpi-pft');
    if (pftEl) {
      pftEl.style.color = c.netProfit < 0 ? 'var(--red)' : '';
    }

    var sub = $('dash-subtitle');
    var filt = c.filter || state.filter;
    var priorB = dashboardPriorYmdBounds(filt);
    if (!priorB) {
      setKpiBadge('kpi-rev-badge', '—', 'neutral');
      setKpiBadge('kpi-exp-badge', '—', 'neutral');
      setKpiBadge('kpi-pft-badge', '—', 'neutral');
      setKpiBadge('kpi-gm-badge', '—', 'neutral');
      if (sub) sub.textContent = filt && filt.mode === 'all' ? 'All-time — no prior period to compare' : '—';
      return;
    }

    var curB = dashboardCurrentYmdBounds(filt);
    var priorC = computeForYmdRange(priorB.start, priorB.end);
    var dRev = formatDashboardKpiDelta(c.revenueTotal, priorC.revenueTotal, 'revenue');
    var dExp = formatDashboardKpiDelta(c.expenseTotal, priorC.expenseTotal, 'expense');
    var dPft = formatDashboardKpiDelta(c.netProfit, priorC.netProfit, 'profit');
    var curMrr = monthlyizedRetainerRevenueForWindow(curB ? curB.start : null, curB ? curB.end : null);
    var priorMrr = monthlyizedRetainerRevenueForWindow(priorB.start, priorB.end);
    var dGm = formatDashboardKpiDelta(curMrr, priorMrr, 'revenue');
    setKpiBadge('kpi-rev-badge', dRev.text, dRev.tone);
    setKpiBadge('kpi-exp-badge', dExp.text, dExp.tone);
    setKpiBadge('kpi-pft-badge', dPft.text, dPft.tone);
    setKpiBadge('kpi-gm-badge', dGm.text, dGm.tone);

    if (sub) {
      if (filt.mode === 'month') {
        var pm = parseYMD(priorB.start);
        sub.textContent = isNaN(pm.getTime())
          ? 'Compared to prior month'
          : 'vs ' + pm.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      } else {
        sub.textContent = 'vs ' + fmtDateDisplay(priorB.start) + ' – ' + fmtDateDisplay(priorB.end);
      }
    }
  }

  function renderIncomeStatement(c) {
    var ops = $('dashboard-ops-statement');
    var legacy = $('dashboard-legacy-statement');
    if (ops) ops.style.display = 'block';
    if (legacy) legacy.style.display = 'none';

    var revLines = $('dashboard-revenue-lines');
    var expLines = $('dashboard-expense-lines');

    if (revLines) {
      var revMap = [
        ['Services', c.revenueByCat.svc],
        ['Retainers', c.revenueByCat.ret],
      ].filter(function (x) { return x[1] > 0.01; });
      revLines.innerHTML = revMap.length ? revMap.map(function (pair) {
        return '<div class="fr"><span class="lbl">' + pair[0] + '</span><span class="val pos">' + fmtCurrency(pair[1]) + '</span></div>';
      }).join('') : '<div class="fr"><span class="lbl">(none)</span><span class="val">$0</span></div>';
    }

    if (expLines) {
      var expMap = [
        ['Software & Tools', c.expenseByCat.sw],
        ['Advertising', c.expenseByCat.ads],
        ['Other', c.expenseByCat.oth],
      ].filter(function (x) { return x[1] > 0.01; });
      expLines.innerHTML = expMap.length ? expMap.map(function (pair) {
        return '<div class="fr"><span class="lbl">' + pair[0] + '</span><span class="val neg">−' + fmtCurrency(pair[1]) + '</span></div>';
      }).join('') : '<div class="fr"><span class="lbl">(none)</span><span class="val neg">−$0</span></div>';
    }

    setText('f-gro', fmtCurrency(c.revenueTotal));
    var fcogs = $('f-cogs-lab');
    if (fcogs) {
      fcogs.textContent = '−' + fmtCurrency(c.cogsTotal || 0);
    }
    var fgp = $('f-gp');
    if (fgp) {
      fgp.textContent = fmtCurrency(c.grossProfit);
      fgp.className = 'val ' + (c.grossProfit >= 0 ? 'pos' : 'neg');
    }
    var fgmp = $('f-gmpct');
    if (fgmp) {
      if (c.grossMarginPct != null && !isNaN(c.grossMarginPct)) {
        fgmp.textContent =
          (Math.round(c.grossMarginPct * 10) / 10).toLocaleString('en-US', {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          }) + '%';
        fgmp.className = 'val ' + (c.grossMarginPct >= 0 ? 'pos' : 'neg');
      } else {
        fgmp.textContent = '—';
        fgmp.className = 'val';
      }
    }
    var fnet = $('f-net');
    if (fnet) {
      fnet.textContent = fmtCurrency(c.netProfit);
      fnet.className = 'val ' + (c.netProfit >= 0 ? 'pos' : 'neg');
    }
  }

  function renderTransactionLog(c) {
    var tbody = $('transaction-log-body');
    var empty = $('transaction-log-empty');
    var table = $('transaction-log-table');
    if (!tbody) return;
    if (c.txs.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    tbody.innerHTML = c.txs.map(function (tx) {
      var d = tx.date ? tx.date : '—';
      var catLabel;
      if (tx.category === 'svc' || tx.category === 'ret') {
        catLabel = displayIncomeCategory(tx);
      } else {
        catLabel = {
          own: 'Owner investment',
          lab: 'Labor',
          sw: 'Software',
          ads: 'Ads',
          oth: 'Other',
        }[tx.category] || tx.category || '—';
      }
      var isInflow = tx.category === 'svc' || tx.category === 'ret' || tx.category === 'own';
      var isOutflow = tx.category === 'lab' || tx.category === 'sw' || tx.category === 'ads' || tx.category === 'oth';
      var amountNumber = Math.abs(Number(tx.amount || 0));
      var amountSign = (isOutflow || (!isInflow && Number(tx.amount || 0) < 0)) ? '-' : '+';
      var amountColor = amountSign === '-' ? 'var(--red)' : 'var(--green)';
      return '<tr>' +
        '<td>' + d + '</td>' +
        '<td>' + catLabel + '</td>' +
        '<td class="tdp" style="color:' + amountColor + ' !important;">' + amountSign + fmtCurrency(amountNumber) + '</td>' +
        '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (tx.description || '') + '">' + (tx.description || '—') + '</td>' +
        '<td style="white-space:nowrap;"><button type="button" class="btn" data-tx-del="' + tx.id + '" style="color:var(--red);">Delete</button></td>' +
        '</tr>';
    }).join('');
  }

  function renderExpensesTable(c) {
    var tbody = $('expenses-tbody');
    var empty = $('expenses-empty');
    var table = $('expenses-table');
    if (!tbody) return;

    var expenseTxs = c.txs.filter(function (tx) {
      return ['lab','sw','ads','oth'].indexOf(tx.category) !== -1;
    });

    if (expenseTxs.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    tbody.innerHTML = expenseTxs.map(function (tx) {
      var label = {
        lab: 'Labor',
        sw: 'Software',
        ads: 'Advertising',
        oth: 'Other',
      }[tx.category] || tx.category || 'Expense';
      var titleText = (tx.title && String(tx.title).trim()) || (tx.description && String(tx.description).trim()) || '—';
      var vendorText = (tx.vendor && String(tx.vendor).trim()) || '—';
      var clientCell = clientCompanyNameById(tx.clientId) || '—';
      return '<tr>' +
        '<td>' + (tx.date || '—') + '</td>' +
        '<td class="tdp">' + titleText + '</td>' +
        '<td>' + label + '</td>' +
        '<td>' + fmtCurrency(tx.amount) + '</td>' +
        '<td>' + vendorText + '</td>' +
        '<td>' + esc(clientCell) + '</td>' +
        '<td>' + (tx.expenseRecurringLead ? '<span class="pl pg-c">Series</span>' : tx.expenseRecurrenceInstance ? '<span class="pl pg-c">Yes</span>' : 'No') + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button type="button" class="btn" data-exp-edit="' + tx.id + '" style="margin-right:6px;">Edit</button>' +
          '<button type="button" class="btn" data-exp-del="' + tx.id + '" style="color:var(--red);">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  function renderBudgetVsActual() {
    var container = document.getElementById('budget-vs-actual');
    if (!container) return;

    var now = new Date();
    var monthLabelEl = document.getElementById('bva-month-label');
    if (monthLabelEl) {
      monthLabelEl.textContent = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    var thisMonthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    var allTxs = state.transactions || [];
    var actualByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    allTxs.forEach(function (tx) {
      if (!tx.date) return;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return;
      var monthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (monthKey !== thisMonthKey) return;
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (actualByCat.hasOwnProperty(tx.category)) actualByCat[tx.category] += amt;
    });

    var catLabels = { lab: 'Labor', sw: 'Software & Tools', ads: 'Advertising', oth: 'Other' };
    var catColors = {
      lab: CHART_EXPENSE_LABOR,
      sw: CHART_EXPENSE_SOFTWARE,
      ads: CHART_EXPENSE_ADVERTISING,
      oth: CHART_EXPENSE_GRAY,
    };

    var hasAnyBudget = (budgets.lab + budgets.sw + budgets.ads + budgets.oth) > 0;
    var totalBudget = budgets.lab + budgets.sw + budgets.ads + budgets.oth;
    var totalActual = actualByCat.lab + actualByCat.sw + actualByCat.ads + actualByCat.oth;

    var monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (!hasAnyBudget) {
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
          '<div>' +
            '<div style="font-size:13px;color:var(--text2);line-height:1.5;">' +
              'No monthly budgets set yet. ' +
              '<a href="#" onclick="window.nav(\'settings\');return false;" style="color:var(--coral);text-decoration:none;font-weight:500;">Set budgets in Settings →</a>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text3);">' + monthLabel + ' · ' + fmtCurrency(totalActual) + ' spent</div>' +
        '</div>';
      return;
    }

    var rows = ['lab', 'sw', 'ads', 'oth'].map(function (k) {
      var budget = budgets[k];
      var actual = actualByCat[k];
      if (budget < 0.01 && actual < 0.01) return '';

      var pct = budget > 0 ? Math.min(actual / budget * 100, 100) : 0;
      var overPct = budget > 0 ? actual / budget * 100 : 0;
      var remaining = budget - actual;

      var barColor = overPct >= 100 ? 'var(--red)' : overPct >= 80 ? 'var(--amber)' : catColors[k];
      var remainingColor = remaining < 0 ? 'var(--red)' : remaining < budget * 0.2 ? 'var(--amber)' : 'var(--green)';
      var remainingLabel = remaining >= 0 ? fmtCurrencyPrecise(remaining) + ' left' : fmtCurrencyPrecise(Math.abs(remaining)) + ' over';

      var statusBadge = '';
      if (budget > 0) {
        if (overPct >= 100) {
          statusBadge = '<span class="pl pg-r" style="font-size:10px;">Over</span>';
        } else if (overPct >= 80) {
          statusBadge = '<span class="pl pg-a" style="font-size:10px;">' + Math.round(overPct) + '%</span>';
        }
      }

      return '<div class="bva-row">' +
        '<div class="bva-label">' +
          '<span class="bva-dot" style="background:' + catColors[k] + ';"></span>' +
          '<span>' + catLabels[k] + '</span>' +
          statusBadge +
        '</div>' +
        '<div class="bva-nums">' +
          '<span class="bva-actual">' + fmtCurrency(actual) + '</span>' +
          '<span class="bva-sep">of</span>' +
          '<span class="bva-budget">' + fmtCurrency(budget) + '</span>' +
        '</div>' +
        '<div class="bva-bar-wrap">' +
          '<div class="pb" style="height:6px;flex:1;">' +
            '<div class="pf" style="width:' + pct.toFixed(1) + '%;background:' + barColor + ';height:100%;"></div>' +
          '</div>' +
          '<span class="bva-remaining" style="color:' + remainingColor + ';">' + remainingLabel + '</span>' +
        '</div>' +
      '</div>';
    }).filter(Boolean).join('');

    var totalPct = totalBudget > 0 ? Math.min(totalActual / totalBudget * 100, 100) : 0;
    var totalRemaining = totalBudget - totalActual;
    var totalBarColor = totalPct >= 100 ? 'var(--red)' : totalPct >= 80 ? 'var(--amber)' : 'var(--green)';
    var totalRemainingColor = totalRemaining < 0 ? 'var(--red)' : totalRemaining < totalBudget * 0.2 ? 'var(--amber)' : 'var(--green)';
    var totalRemainingLabel = totalRemaining >= 0 ? fmtCurrencyPrecise(totalRemaining) + ' left' : fmtCurrencyPrecise(Math.abs(totalRemaining)) + ' over';

    var totalRow = '<div class="bva-row bva-total">' +
      '<div class="bva-label"><span>Total</span></div>' +
      '<div class="bva-nums">' +
        '<span class="bva-actual">' + fmtCurrency(totalActual) + '</span>' +
        '<span class="bva-sep">of</span>' +
        '<span class="bva-budget">' + fmtCurrency(totalBudget) + '</span>' +
      '</div>' +
      '<div class="bva-bar-wrap">' +
        '<div class="pb" style="height:6px;flex:1;">' +
          '<div class="pf" style="width:' + totalPct.toFixed(1) + '%;background:' + totalBarColor + ';height:100%;"></div>' +
        '</div>' +
        '<span class="bva-remaining" style="color:' + totalRemainingColor + ';">' + totalRemainingLabel + '</span>' +
      '</div>' +
    '</div>';

    container.innerHTML = rows + totalRow;
  }

  var SPEND_EXP_CATS = ['lab', 'sw', 'ads', 'oth'];

  function spendCategoryPillMeta(catKey) {
    var m = {
      lab: { label: 'Labor', color: CHART_EXPENSE_LABOR },
      sw: { label: 'Software', color: CHART_EXPENSE_SOFTWARE },
      ads: { label: 'Advertising', color: CHART_EXPENSE_ADVERTISING },
      oth: { label: 'Other', color: CHART_EXPENSE_GRAY },
    };
    return m[catKey] || { label: String(catKey), color: CHART_EXPENSE_GRAY };
  }

  function spendStartOfWeekMonday(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    var day = x.getDay();
    var diff = (day + 6) % 7;
    x.setDate(x.getDate() - diff);
    return x;
  }

  function spendEnumerateBuckets(rangeStart, rangeEnd, interval) {
    var keys = [];
    var shortLabels = [];
    var titles = [];
    var rs = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate(), 12, 0, 0, 0);
    var re = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), 12, 0, 0, 0);
    if (interval === 'daily') {
      var cur = new Date(rs);
      while (cur <= re) {
        var k = dateYMD(cur);
        keys.push(k);
        shortLabels.push(cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        titles.push(cur.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }));
        cur.setDate(cur.getDate() + 1);
      }
    } else if (interval === 'weekly') {
      var w0 = spendStartOfWeekMonday(rs);
      var curW = new Date(w0);
      while (curW <= re) {
        var wk = dateYMD(curW);
        keys.push(wk);
        var wEnd = new Date(curW);
        wEnd.setDate(wEnd.getDate() + 6);
        shortLabels.push(curW.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        titles.push('Week of ' + curW.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
          ' – ' + wEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
        curW.setDate(curW.getDate() + 7);
      }
    } else {
      var curM = new Date(rs.getFullYear(), rs.getMonth(), 1, 12, 0, 0, 0);
      var endM = new Date(re.getFullYear(), re.getMonth(), 1, 12, 0, 0, 0);
      while (curM <= endM) {
        var mk = curM.getFullYear() + '-' + String(curM.getMonth() + 1).padStart(2, '0');
        keys.push(mk);
        shortLabels.push(curM.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }));
        titles.push(curM.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
        curM.setMonth(curM.getMonth() + 1);
      }
    }
    return { keys: keys, shortLabels: shortLabels, titles: titles };
  }

  function spendTxBucketKey(txDateStr, interval) {
    var d = parseYMD(txDateStr);
    if (isNaN(d.getTime())) return null;
    if (interval === 'daily') return dateYMD(d);
    if (interval === 'weekly') return dateYMD(spendStartOfWeekMonday(d));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function spendResolveRange(mode, expenseTxs) {
    var now = new Date();
    now.setHours(12, 0, 0, 0);
    var today = dateYMD(now);
    var start;
    var end = today;
    if (mode === 'month') {
      start = dateYMD(new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0));
    } else if (mode === '30d') {
      var s30 = new Date(now);
      s30.setDate(s30.getDate() - 29);
      start = dateYMD(s30);
    } else if (mode === '90d') {
      var s90 = new Date(now);
      s90.setDate(s90.getDate() - 89);
      start = dateYMD(s90);
    } else if (mode === 'ytd') {
      start = dateYMD(new Date(now.getFullYear(), 0, 1, 12, 0, 0, 0));
    } else {
      var minD = null;
      var maxD = null;
      expenseTxs.forEach(function (tx) {
        var d = parseYMD(tx.date);
        if (isNaN(d.getTime())) return;
        if (!minD || d < minD) minD = d;
        if (!maxD || d > maxD) maxD = d;
      });
      if (!minD) {
        start = today;
        end = today;
      } else {
        start = dateYMD(minD);
        end = maxD && parseYMD(maxD) > parseYMD(today) ? dateYMD(maxD) : today;
      }
    }
    return { start: start, end: end, startDate: parseYMD(start), endDate: parseYMD(end) };
  }

  function spendPriorRange(startStr, endStr) {
    var a = parseYMD(startStr);
    var b = parseYMD(endStr);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return { start: startStr, end: endStr };
    var days = Math.max(1, Math.round((b - a) / 86400000) + 1);
    var pe = new Date(a);
    pe.setDate(pe.getDate() - 1);
    var ps = new Date(pe);
    ps.setDate(ps.getDate() - (days - 1));
    return { start: dateYMD(ps), end: dateYMD(pe) };
  }

  function spendFormatKpiSplit(n) {
    var v = Number(n || 0);
    var s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var dot = s.lastIndexOf('.');
    if (dot === -1) {
      return '<span class="spend-kpi-dollars">$' + esc(s) + '</span>';
    }
    return '<span class="spend-kpi-dollars">$' + esc(s.slice(0, dot)) + '</span>' +
      '<span class="spend-kpi-cents">' + esc(s.slice(dot)) + '</span>';
  }

  function spendMatchesQuery(tx, q) {
    if (!q) return true;
    var hay = [tx.title, tx.vendor, tx.description, tx.note, tx.notes].map(function (x) {
      return String(x || '').toLowerCase();
    }).join(' ');
    return hay.indexOf(q) !== -1;
  }

  function spendMatchesSpendTab(tx, tab, pillDefs) {
    if (tab === 'all') return true;
    if (tab.indexOf('cat:') === 0) return tx.category === tab.slice(4);
    if (tab.indexOf('ven:') === 0) {
      var want = tab.slice(4);
      if (want === '__other__') {
        var topSet = {};
        pillDefs.forEach(function (p) {
          if (p.id.indexOf('ven:') === 0 && p.id !== 'ven:__other__') topSet[p.id.slice(4)] = true;
        });
        var v = (tx.vendor && String(tx.vendor).trim()) || '—';
        return !topSet[v];
      }
      var vv = (tx.vendor && String(tx.vendor).trim()) || '—';
      return vv === want;
    }
    if (tab.indexOf('cli:') === 0) {
      var wantC = tab.slice(4);
      if (wantC === '__other__') {
        var topSetC = {};
        pillDefs.forEach(function (p) {
          if (p.id.indexOf('cli:') === 0 && p.id !== 'cli:__other__') topSetC[p.id.slice(4)] = true;
        });
        var txKeyC = tx.clientId ? String(tx.clientId) : '__unallocated__';
        return !topSetC[txKeyC];
      }
      var txKey = tx.clientId ? String(tx.clientId) : '__unallocated__';
      return txKey === wantC;
    }
    return true;
  }

  function spendVendorAggregateKey(tx) {
    return (tx.vendor && String(tx.vendor).trim()) || '—';
  }

  function spendVendorDisplayLabel(key) {
    return key === '—' ? 'No vendor' : key;
  }

  function spendRankVendors(expenseTxsInRange) {
    var tot = {};
    expenseTxsInRange.forEach(function (tx) {
      var k = spendVendorAggregateKey(tx);
      tot[k] = (tot[k] || 0) + (+tx.amount || 0);
    });
    return Object.keys(tot).map(function (k) {
      return { key: k, total: tot[k] };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function renderSpendTopVendors(inRange, rangeMode, re) {
    var sumEl = document.getElementById('spend-top-vendors-summary');
    var listEl = document.getElementById('spend-top-vendors-list');
    if (!sumEl || !listEl) return;

    var periodDen = inRange.reduce(function (a, tx) { return a + (+tx.amount || 0); }, 0);
    if (!inRange.length || periodDen < 0.01) {
      sumEl.innerHTML = '<span class="spend-top-vendors-empty">No spend recorded in this period.</span>';
      listEl.innerHTML = '';
      return;
    }

    var ranked = spendRankVendors(inRange).filter(function (r) { return r.total > 0.01; });
    var topN = 10;
    var rows = ranked.slice(0, topN);

    var narrPrefix = '';
    if (rangeMode === 'month') {
      narrPrefix = 'In ' + re.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else if (rangeMode === '30d') {
      narrPrefix = 'Over the last 30 days';
    } else if (rangeMode === '90d') {
      narrPrefix = 'Over the last 90 days';
    } else if (rangeMode === 'ytd') {
      narrPrefix = 'Year to date';
    } else {
      narrPrefix = 'All time';
    }

    var narr = ranked.slice(0, 3);
    var narrHtml = '';
    if (narr.length === 1) {
      var d0 = spendVendorDisplayLabel(narr[0].key);
      narrHtml = esc(narrPrefix) + ', you spent <strong>' + esc(fmtCurrency(narr[0].total)) + '</strong> with ' + esc(d0) + '.';
    } else if (narr.length === 2) {
      var d0a = spendVendorDisplayLabel(narr[0].key);
      var d1a = spendVendorDisplayLabel(narr[1].key);
      narrHtml = esc(narrPrefix) + ', you spent <strong>' + esc(fmtCurrency(narr[0].total)) + '</strong> with ' + esc(d0a) +
        ' and <strong>' + esc(fmtCurrency(narr[1].total)) + '</strong> with ' + esc(d1a) + '.';
    } else if (narr.length >= 3) {
      var d0b = spendVendorDisplayLabel(narr[0].key);
      var d1b = spendVendorDisplayLabel(narr[1].key);
      var d2b = spendVendorDisplayLabel(narr[2].key);
      narrHtml = esc(narrPrefix) + ', you spent <strong>' + esc(fmtCurrency(narr[0].total)) + '</strong> with ' + esc(d0b) +
        ', <strong>' + esc(fmtCurrency(narr[1].total)) + '</strong> with ' + esc(d1b) +
        ', and <strong>' + esc(fmtCurrency(narr[2].total)) + '</strong> with ' + esc(d2b) + '.';
    }
    sumEl.innerHTML = narrHtml;

    listEl.innerHTML = rows.map(function (r, i) {
      var pct = periodDen > 0 ? Math.round((r.total / periodDen) * 1000) / 10 : 0;
      var pctStr = (pct % 1 === 0 ? String(Math.round(pct)) : pct.toFixed(1)) + '%';
      var label = spendVendorDisplayLabel(r.key);
      var barW = periodDen > 0 ? Math.min(100, Math.round((r.total / periodDen) * 1000) / 10) : 0;
      return '<div class="spend-tv-row">' +
        '<span class="spend-tv-rank">' + (i + 1) + '</span>' +
        '<span class="spend-tv-name" title="' + esc(label) + '">' + esc(label) + '</span>' +
        '<span class="spend-tv-amt">' + esc(fmtCurrency(r.total)) + '</span>' +
        '<span class="spend-tv-pct">' + esc(pctStr) + '</span>' +
        '<div class="spend-tv-bar" aria-hidden="true"><div class="spend-tv-bar-fill" style="width:' + barW + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  function renderSpendingReport() {
    var slice = spendReportUi.slice;
    var rangeMode = spendReportUi.range;
    var interval = spendReportUi.interval;
    var chartType = spendReportUi.chartType;
    var tab = spendReportUi.tab;
    var q = (spendReportUi.q || '').trim().toLowerCase();

    var allExpense = (state.transactions || []).filter(function (tx) {
      return SPEND_EXP_CATS.indexOf(tx.category) !== -1 && (+tx.amount || 0) > 0;
    });

    var range = spendResolveRange(rangeMode, allExpense);
    var rs = range.startDate;
    var re = range.endDate;
    if (isNaN(rs.getTime()) || isNaN(re.getTime())) {
      var sumBad = document.getElementById('spend-top-vendors-summary');
      var listBad = document.getElementById('spend-top-vendors-list');
      if (sumBad) sumBad.innerHTML = '';
      if (listBad) listBad.innerHTML = '';
      return;
    }

    var inRange = allExpense.filter(function (tx) {
      if (!tx.date) return false;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return false;
      return d >= rs && d <= re;
    });

    renderSpendTopVendors(inRange, rangeMode, re);

    var canvas = document.getElementById('cSpendTrend');
    if (!canvas || !window.Chart) return;

    var missingDates = allExpense.filter(function (tx) { return !tx.date || isNaN(parseYMD(tx.date).getTime()); }).length;
    if (missingDates) {
      console.warn('Spending chart: ' + missingDates + ' expense row(s) have no valid date and are omitted from the series.');
    }

    var forPills = inRange.filter(function (tx) { return spendMatchesQuery(tx, q); });

    var pillsEl = document.getElementById('spend-pills');
    var pillsLbl = document.getElementById('spend-pills-lbl');
    if (pillsLbl) {
      if (slice === 'vendor') pillsLbl.textContent = 'Vendor';
      else if (slice === 'client') pillsLbl.textContent = 'Client';
      else pillsLbl.textContent = 'Category';
    }

    var pillDefs = [{ id: 'all', label: 'All', color: 'var(--text)' }];
    if (slice === 'category') {
      SPEND_EXP_CATS.forEach(function (k) {
        var has = forPills.some(function (tx) { return tx.category === k; });
        if (has) {
          var catMeta = spendCategoryPillMeta(k);
          pillDefs.push({ id: 'cat:' + k, label: catMeta.label, color: catMeta.color });
        }
      });
    } else if (slice === 'client') {
      var cliTot = {};
      forPills.forEach(function (tx) {
        var ck = tx.clientId ? String(tx.clientId) : '__unallocated__';
        cliTot[ck] = (cliTot[ck] || 0) + (+tx.amount || 0);
      });
      var cliList = Object.keys(cliTot).sort(function (a, b) { return cliTot[b] - cliTot[a]; });
      var maxC = 12;
      var topC = cliList.slice(0, maxC);
      var restC = cliList.slice(maxC);
      var PALc = CHART_VENDOR_PAL;
      topC.forEach(function (k, i) {
        var label = k === '__unallocated__' ? 'Unallocated' : (clientCompanyNameById(k) || 'Unknown client');
        pillDefs.push({ id: 'cli:' + k, label: label, color: PALc[i % PALc.length] });
      });
      if (restC.length) pillDefs.push({ id: 'cli:__other__', label: 'Other', color: CHART_EXPENSE_GRAY });
    } else {
      var venTot = {};
      forPills.forEach(function (tx) {
        var v = (tx.vendor && String(tx.vendor).trim()) || '—';
        venTot[v] = (venTot[v] || 0) + (+tx.amount || 0);
      });
      var venList = Object.keys(venTot).sort(function (a, b) { return venTot[b] - venTot[a]; });
      var maxV = 12;
      var top = venList.slice(0, maxV);
      var rest = venList.slice(maxV);
      var PAL = CHART_VENDOR_PAL;
      top.forEach(function (v, i) {
        pillDefs.push({ id: 'ven:' + v, label: v, color: PAL[i % PAL.length] });
      });
      if (rest.length) pillDefs.push({ id: 'ven:__other__', label: 'Other', color: CHART_EXPENSE_GRAY });
    }

    var tabOk = pillDefs.some(function (p) { return p.id === tab; });
    if (!tabOk) tab = 'all';
    spendReportUi.tab = tab;

    if (pillsEl) {
      pillsEl.innerHTML = pillDefs.map(function (p) {
        var on = p.id === tab ? ' on' : '';
        var dot = '<span class="spend-pill-dot" style="background:' + p.color + ';"></span>';
        return '<button type="button" class="spend-pill' + on + '" data-spend-tab="' + esc(p.id) + '">' + dot + esc(p.label) + '</button>';
      }).join('');
    }

    var filtered = forPills.filter(function (tx) {
      return spendMatchesSpendTab(tx, tab, pillDefs);
    });

    var costType = spendReportUi.costType || 'all';
    if (costType !== 'all' && costType !== 'fixed' && costType !== 'variable') costType = 'all';

    var enumed = spendEnumerateBuckets(rs, re, interval);
    var keys = enumed.keys;
    var shortLabels = enumed.shortLabels;
    spendReportTooltipTitles = enumed.titles.slice();

    var sumsFixed = {};
    var sumsVar = {};
    keys.forEach(function (k) {
      sumsFixed[k] = 0;
      sumsVar[k] = 0;
    });

    var useIndexAxis = filtered.length > 0 && filtered.every(function (tx) {
      return !tx.date || isNaN(parseYMD(tx.date).getTime());
    });

    if (!useIndexAxis) {
      filtered.forEach(function (tx) {
        var bk = spendTxBucketKey(tx.date, interval);
        if (!bk || !sumsFixed.hasOwnProperty(bk)) return;
        var amt = +tx.amount || 0;
        if (isFixedRecurringExpense(tx)) sumsFixed[bk] += amt;
        else sumsVar[bk] += amt;
      });
    } else {
      keys = filtered.map(function (_, i) { return 'i' + i; });
      shortLabels = filtered.map(function (_, i) { return 'Entry ' + (i + 1); });
      spendReportTooltipTitles = filtered.map(function (tx) {
        return (tx.title || tx.vendor || tx.description || 'Expense') + ' · ' + (tx.date || 'no date');
      });
      sumsFixed = {};
      sumsVar = {};
      filtered.forEach(function (tx, i) {
        var k = 'i' + i;
        var amt = +tx.amount || 0;
        if (isFixedRecurringExpense(tx)) sumsFixed[k] = amt;
        else sumsVar[k] = amt;
      });
    }

    if (!keys.length) {
      keys = ['_empty'];
      shortLabels = ['—'];
      spendReportTooltipTitles = ['No data in range'];
      sumsFixed = { _empty: 0 };
      sumsVar = { _empty: 0 };
    }

    var round2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
    var dataValsFixed = keys.map(function (k) { return round2(sumsFixed[k] || 0); });
    var dataValsVar = keys.map(function (k) { return round2(sumsVar[k] || 0); });
    var dataValsTotal = keys.map(function (_, i) { return round2(dataValsFixed[i] + dataValsVar[i]); });

    var periodTotalFixed = dataValsFixed.reduce(function (a, b) { return a + b; }, 0);
    var periodTotalVar = dataValsVar.reduce(function (a, b) { return a + b; }, 0);
    var periodTotalAll = periodTotalFixed + periodTotalVar;

    var dataVals;
    if (costType === 'fixed') dataVals = dataValsFixed;
    else if (costType === 'variable') dataVals = dataValsVar;
    else dataVals = dataValsTotal;

    var periodTotal;
    if (costType === 'fixed') periodTotal = periodTotalFixed;
    else if (costType === 'variable') periodTotal = periodTotalVar;
    else periodTotal = periodTotalAll;

    var pr = spendPriorRange(range.start, range.end);
    var priorTxs = allExpense.filter(function (tx) {
      if (!tx.date) return false;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return false;
      return d >= parseYMD(pr.start) && d <= parseYMD(pr.end);
    }).filter(function (tx) { return spendMatchesQuery(tx, q); }).filter(function (tx) {
      return spendMatchesSpendTab(tx, tab, pillDefs);
    });

    var priorTotalFixed = 0;
    var priorTotalVar = 0;
    var priorTotalAll = 0;
    var priorTotal = 0;
    if (!useIndexAxis) {
      var pEnumPrior = spendEnumerateBuckets(parseYMD(pr.start), parseYMD(pr.end), interval);
      var priorSumsF = {};
      var priorSumsV = {};
      pEnumPrior.keys.forEach(function (k) {
        priorSumsF[k] = 0;
        priorSumsV[k] = 0;
      });
      priorTxs.forEach(function (tx) {
        var bk = spendTxBucketKey(tx.date, interval);
        if (!bk || !priorSumsF.hasOwnProperty(bk)) return;
        var amt = +tx.amount || 0;
        if (isFixedRecurringExpense(tx)) priorSumsF[bk] += amt;
        else priorSumsV[bk] += amt;
      });
      priorTotalFixed = pEnumPrior.keys.reduce(function (a, k) { return a + (priorSumsF[k] || 0); }, 0);
      priorTotalVar = pEnumPrior.keys.reduce(function (a, k) { return a + (priorSumsV[k] || 0); }, 0);
      priorTotalAll = priorTotalFixed + priorTotalVar;
      if (costType === 'fixed') priorTotal = priorTotalFixed;
      else if (costType === 'variable') priorTotal = priorTotalVar;
      else priorTotal = priorTotalAll;
    }

    var kpiPrimaryLbl = document.getElementById('spend-kpi-primary-lbl');
    var kpiSecondaryLbl = document.getElementById('spend-kpi-secondary-lbl');
    var kpiPrimaryVal = document.getElementById('spend-kpi-primary-val');
    var kpiSecondaryVal = document.getElementById('spend-kpi-secondary-val');
    var kpiPrimaryBrk = document.getElementById('spend-kpi-primary-brk');
    var kpiSecondaryBrk = document.getElementById('spend-kpi-secondary-brk');

    var basePeriodLbl;
    if (rangeMode === 'month') {
      basePeriodLbl = re.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ' spend';
    } else if (rangeMode === '30d') {
      basePeriodLbl = 'Last 30 days spend';
    } else if (rangeMode === '90d') {
      basePeriodLbl = 'Last 90 days spend';
    } else if (rangeMode === 'ytd') {
      basePeriodLbl = 'Year-to-date spend';
    } else {
      basePeriodLbl = 'All-time spend';
    }

    if (kpiPrimaryLbl) {
      if (costType === 'fixed') kpiPrimaryLbl.textContent = basePeriodLbl + ' (fixed recurring)';
      else if (costType === 'variable') kpiPrimaryLbl.textContent = basePeriodLbl + ' (one-time)';
      else kpiPrimaryLbl.textContent = basePeriodLbl;
    }
    if (kpiSecondaryLbl) {
      if (costType === 'fixed') {
        kpiSecondaryLbl.textContent = 'Prior period (fixed) · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
      } else if (costType === 'variable') {
        kpiSecondaryLbl.textContent = 'Prior period (one-time) · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
      } else {
        kpiSecondaryLbl.textContent = 'Prior period · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
      }
    }
    if (kpiPrimaryVal) kpiPrimaryVal.innerHTML = spendFormatKpiSplit(periodTotal);
    if (kpiSecondaryVal) kpiSecondaryVal.innerHTML = spendFormatKpiSplit(priorTotal);

    if (kpiPrimaryBrk) {
      if (costType === 'all' && !useIndexAxis) {
        kpiPrimaryBrk.textContent = 'Fixed ' + fmtCurrencyPrecise(periodTotalFixed) + ' · One-time ' + fmtCurrencyPrecise(periodTotalVar);
        kpiPrimaryBrk.style.display = 'block';
      } else {
        kpiPrimaryBrk.textContent = '';
        kpiPrimaryBrk.style.display = 'none';
      }
    }
    if (kpiSecondaryBrk) {
      if (costType === 'all' && !useIndexAxis) {
        kpiSecondaryBrk.textContent = 'Fixed ' + fmtCurrencyPrecise(priorTotalFixed) + ' · One-time ' + fmtCurrencyPrecise(priorTotalVar);
        kpiSecondaryBrk.style.display = 'block';
      } else {
        kpiSecondaryBrk.textContent = '';
        kpiSecondaryBrk.style.display = 'none';
      }
    }

    spendReportCsvPayload = {
      labels: shortLabels.slice(),
      titles: spendReportTooltipTitles.slice(),
      costType: costType,
      values: dataVals.slice(),
      valuesFixed: dataValsFixed.slice(),
      valuesVariable: dataValsVar.slice(),
    };

    var avgRef = dataVals.length ? dataVals.reduce(function (a, b) { return a + b; }, 0) / dataVals.length : 0;
    avgRef = Math.round(avgRef * 100) / 100;
    var refLine = keys.map(function () { return avgRef; });

    var gridMuted = CHART_GRID;
    var axisTick = CHART_TICK;
    var lineStroke = CHART_ORANGE;
    var lineFill = CHART_ORANGE_FILL;
    var lineVarStroke = '#52525b';
    var lineVarFill = 'rgba(82, 82, 91, 0.12)';
    var refStroke = 'rgba(0,0,0,0.12)';

    if (spendTrendChart) {
      spendTrendChart.destroy();
      spendTrendChart = null;
    }

    var stackedMode = costType === 'all';
    var commonPlugins = {
      legend: {
        display: stackedMode,
        position: 'bottom',
        labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, color: axisTick },
      },
      tooltip: {
        backgroundColor: '#ffffff',
        titleColor: '#0a0a0a',
        bodyColor: '#52525b',
        borderColor: 'rgba(0,0,0,0.08)',
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        displayColors: true,
        filter: function (item) {
          if (stackedMode) return item.datasetIndex <= 1;
          return item.datasetIndex === 0;
        },
        callbacks: {
          title: function (items) {
            var i = items[0].dataIndex;
            return spendReportTooltipTitles[i] || shortLabels[i] || '';
          },
          label: function (ctx) {
            var y = ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed;
            return (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + fmtCurrencyPrecise(y);
          },
          footer: function (items) {
            if (!stackedMode || !items.length) return '';
            var i = items[0].dataIndex;
            var t = round2((dataValsFixed[i] || 0) + (dataValsVar[i] || 0));
            return 'Total: ' + fmtCurrencyPrecise(t);
          },
        },
      },
    };

    var commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { display: true, color: gridMuted, lineWidth: 1, drawTicks: false },
          ticks: { color: axisTick, font: { size: 11 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
          border: { display: false },
        },
        y: {
          stacked: stackedMode,
          grid: { display: false },
          ticks: {
            color: axisTick,
            font: { size: 11 },
            callback: function (v) { return '$' + Number(v).toLocaleString(); },
          },
          border: { display: false },
        },
      },
    };

    if (chartType === 'bar') {
      var barDatasets;
      if (stackedMode) {
        barDatasets = [
          {
            type: 'bar',
            label: 'Fixed (recurring)',
            data: dataValsFixed,
            stack: 'spend',
            backgroundColor: CHART_ORANGE_FILL_BAR,
            borderColor: CHART_ORANGE_BORDER_BAR,
            borderWidth: 1,
            borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 },
            order: 3,
          },
          {
            type: 'bar',
            label: 'One-time',
            data: dataValsVar,
            stack: 'spend',
            backgroundColor: 'rgba(82, 82, 91, 0.28)',
            borderColor: 'rgba(63,63,70,0.45)',
            borderWidth: 1,
            borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
            order: 3,
          },
          {
            type: 'line',
            label: 'Average',
            data: refLine,
            borderColor: refStroke,
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0,
            order: 1,
          },
        ];
      } else {
        barDatasets = [
          {
            type: 'bar',
            label: 'Spend',
            data: dataVals,
            backgroundColor: CHART_ORANGE_FILL_BAR,
            borderColor: CHART_ORANGE_BORDER_BAR,
            borderWidth: 1,
            borderRadius: 4,
            order: 2,
          },
          {
            type: 'line',
            label: 'Average',
            data: refLine,
            borderColor: refStroke,
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0,
            order: 1,
          },
        ];
      }
      spendTrendChart = new Chart(canvas, {
        type: 'bar',
        data: { labels: shortLabels, datasets: barDatasets },
        options: Object.assign({ plugins: commonPlugins }, commonOptions),
      });
    } else {
      var lineDatasets;
      if (stackedMode) {
        lineDatasets = [
          {
            type: 'line',
            label: 'Fixed (recurring)',
            data: dataValsFixed,
            stack: 'spend',
            borderColor: lineStroke,
            backgroundColor: lineFill,
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: CHART_ORANGE,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            order: 3,
          },
          {
            type: 'line',
            label: 'One-time',
            data: dataValsVar,
            stack: 'spend',
            borderColor: lineVarStroke,
            backgroundColor: lineVarFill,
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: lineVarStroke,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            order: 3,
          },
          {
            type: 'line',
            label: 'Average',
            data: refLine,
            borderColor: refStroke,
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0,
            order: 1,
          },
        ];
      } else {
        lineDatasets = [
          {
            type: 'line',
            label: 'Spend',
            data: dataVals,
            borderColor: lineStroke,
            backgroundColor: lineFill,
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: CHART_ORANGE,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            order: 2,
          },
          {
            type: 'line',
            label: 'Average',
            data: refLine,
            borderColor: refStroke,
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0,
            order: 1,
          },
        ];
      }
      spendTrendChart = new Chart(canvas, {
        type: 'line',
        data: { labels: shortLabels, datasets: lineDatasets },
        options: Object.assign({ plugins: commonPlugins }, commonOptions),
      });
    }

    var lineBtn = document.getElementById('spend-chart-line');
    var barBtn = document.getElementById('spend-chart-bar');
    if (lineBtn) lineBtn.classList.toggle('on', chartType === 'line');
    if (barBtn) barBtn.classList.toggle('on', chartType === 'bar');
  }

  function wireSettingsSave() {
    // Populate budget inputs from saved state
    function populateBudgetInputs() {
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        var el = document.getElementById('budget-input-' + k);
        if (el && budgets[k] > 0) el.value = budgets[k];
      });
    }
    populateBudgetInputs();
    var accentInput = document.getElementById('setting-accent');
    var accentHexInput = document.getElementById('setting-accent-hex');
    if (accentInput) {
      function accentHexNow() {
        return parseAccentHexOrNull(accentHexInput && accentHexInput.value) || normalizeHexColor(accentInput.value, '#e8501a');
      }
      function syncAccentFieldsAndApply(hex) {
        var h = normalizeHexColor(hex, '#e8501a');
        accentInput.value = h;
        if (accentHexInput) accentHexInput.value = h;
        applyAccentBranding(h);
        if (state.computed) {
          renderAll();
          renderProjects();
        }
      }
      if (accentHexInput && !accentHexInput.value.trim()) {
        accentHexInput.value = normalizeHexColor(accentInput.value, '#e8501a');
      }
      syncAccentFieldsAndApply(accentHexNow());
      accentInput.addEventListener('input', function () {
        syncAccentFieldsAndApply(normalizeHexColor(accentInput.value, '#e8501a'));
      });
      accentInput.addEventListener('change', function () {
        syncAccentFieldsAndApply(normalizeHexColor(accentInput.value, '#e8501a'));
      });
      if (accentHexInput) {
        accentHexInput.addEventListener('input', function () {
          var p = parseAccentHexOrNull(accentHexInput.value);
          if (p) syncAccentFieldsAndApply(p);
        });
        accentHexInput.addEventListener('change', function () {
          var p = parseAccentHexOrNull(accentHexInput.value);
          if (p) {
            syncAccentFieldsAndApply(p);
          } else {
            syncAccentFieldsAndApply(normalizeHexColor(accentInput.value, '#e8501a'));
          }
        });
      }
    }

    function readBudgetInputsIntoState() {
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        var el = document.getElementById('budget-input-' + k);
        if (el) budgets[k] = Math.max(0, parseFloat(el.value) || 0);
      });
    }

    async function syncBudgetsNow() {
      readBudgetInputsIntoState();
      saveBudgets(budgets);
      recomputeAndRender();
      await persistAppSettingsToSupabase({ includeDashboard: true });
    }

    async function uploadBrandLogoInput(inputId, variant) {
      var input = document.getElementById(inputId);
      if (!input || !input.files || !input.files.length) return '';
      supabase = window.supabaseClient || supabase;
      currentUser = window.currentUser || currentUser;
      if (!supabase || !currentUser) return '';
      var file = input.files[0];
      var ext = (String(file.name || '').split('.').pop() || 'png').toLowerCase();
      var path = (getCurrentOrgId() || currentUser.id) + '/' + variant + '-' + Date.now() + '.' + ext;
      var upload = await supabase.storage.from('brand-assets').upload(path, file, { upsert: true, cacheControl: '3600' });
      if (upload.error) throw upload.error;
      var signed = await supabase.storage.from('brand-assets').createSignedUrl(path, BRAND_LOGO_SIGNED_URL_TTL_SEC);
      if (signed.error) throw signed.error;
      return signed.data && signed.data.signedUrl ? signed.data.signedUrl : '';
    }

    function wireLogoPreviewInput(inputId, variant) {
      var input = document.getElementById(inputId);
      if (!input) return;
      input.addEventListener('change', function () {
        if (!input.files || !input.files.length) return;
        var file = input.files[0];
        if (!file || String(file.type || '').indexOf('image/') !== 0) return;
        var previewUrl = URL.createObjectURL(file);
        if (variant === 'light') applyBrandLogo(previewUrl, '');
        else applyBrandLogo('', previewUrl);
      });
    }

    wireLogoPreviewInput('setting-logo-light', 'light');
    wireLogoPreviewInput('setting-logo-dark', 'dark');

    ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
      var el = document.getElementById('budget-input-' + k);
      if (!el) return;
      el.addEventListener('change', function () {
        syncBudgetsNow();
      });
    });

    var saveBtn = document.getElementById('btn-save-settings');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var brandImg = document.getElementById('sb-brand-img');
        var lightUrl = brandImg && brandImg.getAttribute('data-logo-light') ? String(brandImg.getAttribute('data-logo-light')) : '';
        var darkUrl = brandImg && brandImg.getAttribute('data-logo-dark') ? String(brandImg.getAttribute('data-logo-dark')) : '';
        try {
          var nextLight = await uploadBrandLogoInput('setting-logo-light', 'light');
          var nextDark = await uploadBrandLogoInput('setting-logo-dark', 'dark');
          if (nextLight) lightUrl = nextLight;
          if (nextDark) darkUrl = nextDark;
        } catch (e) {
          console.warn('brand logo upload failed', e);
          alert('Logo upload failed. Check brand-assets storage bucket and policies, then try again.');
        }
        applyBrandLogo(lightUrl, darkUrl);
        await syncBudgetsNow();
        // Brief visual confirmation
        var orig = saveBtn.textContent;
        saveBtn.textContent = 'Saved!';
        setTimeout(function () { saveBtn.textContent = orig; }, 1400);
      });
    }
  }

  function wireSpendingReport() {
    function syncFromDom() {
      var sl = document.getElementById('spend-slice');
      var rg = document.getElementById('spend-range');
      var iv = document.getElementById('spend-interval');
      var ct = document.getElementById('spend-cost-type');
      if (sl) spendReportUi.slice = sl.value || 'category';
      if (rg) spendReportUi.range = rg.value || '90d';
      if (iv) spendReportUi.interval = iv.value || 'weekly';
      if (ct) spendReportUi.costType = ct.value || 'all';
    }

    var sliceEl = document.getElementById('spend-slice');
    var rangeEl = document.getElementById('spend-range');
    var intEl = document.getElementById('spend-interval');
    var costTypeEl = document.getElementById('spend-cost-type');
    var qEl = document.getElementById('spend-filter-q');
    if (sliceEl) {
      sliceEl.addEventListener('change', function () {
        syncFromDom();
        spendReportUi.tab = 'all';
        if (state.computed) renderSpendingReport();
      });
    }
    if (rangeEl) {
      rangeEl.addEventListener('change', function () {
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    if (intEl) {
      intEl.addEventListener('change', function () {
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    if (costTypeEl) {
      costTypeEl.addEventListener('change', function () {
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    if (qEl) {
      var t = null;
      qEl.addEventListener('input', function () {
        spendReportUi.q = qEl.value || '';
        clearTimeout(t);
        t = setTimeout(function () {
          if (state.computed) renderSpendingReport();
        }, 160);
      });
    }

    var pillHost = document.getElementById('spend-pills');
    if (pillHost) {
      pillHost.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-spend-tab]');
        if (!btn) return;
        spendReportUi.tab = btn.getAttribute('data-spend-tab') || 'all';
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }

    var lineB = document.getElementById('spend-chart-line');
    if (lineB) {
      lineB.addEventListener('click', function () {
        spendReportUi.chartType = 'line';
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    var barB = document.getElementById('spend-chart-bar');
    if (barB) {
      barB.addEventListener('click', function () {
        spendReportUi.chartType = 'bar';
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }

    var dl = document.getElementById('spend-download');
    if (dl) {
      dl.addEventListener('click', function () {
        var p = spendReportCsvPayload;
        if (!p || !p.labels || !p.labels.length) return;
        var rows;
        if (p.costType === 'all' && p.valuesFixed && p.valuesVariable) {
          rows = ['Period,Fixed recurring,One-time,Total'];
          for (var i = 0; i < p.labels.length; i++) {
            var lab = String(p.titles && p.titles[i] != null ? p.titles[i] : p.labels[i]).replace(/"/g, '""');
            var f = p.valuesFixed[i] != null ? p.valuesFixed[i] : 0;
            var v = p.valuesVariable[i] != null ? p.valuesVariable[i] : 0;
            var tot = Math.round((Number(f) + Number(v)) * 100) / 100;
            rows.push('"' + lab + '",' + f + ',' + v + ',' + tot);
          }
        } else {
          rows = ['Period,Amount'];
          for (var j = 0; j < p.labels.length; j++) {
            var lab2 = String(p.titles && p.titles[j] != null ? p.titles[j] : p.labels[j]).replace(/"/g, '""');
            rows.push('"' + lab2 + '",' + (p.values[j] != null ? p.values[j] : 0));
          }
        }
        var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'spending-report.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    syncFromDom();
  }

  function buildWeeklySummaryText(kind) {
    var c = state.computed || compute({ mode: 'all', start: null, end: null });
    var openInvoices = invoices.filter(function (i) { return i && i.status !== 'paid'; }).length;
    var doneProjects = projects.filter(function (p) { return p && String(p.status || '').toLowerCase().indexOf('complete') !== -1; }).length;
    var prefix = kind === 'monday' ? 'Monday summary' : 'Friday recap';
    return prefix + ': Revenue ' + fmtCurrency(c.revenueTotal || 0) + ', expenses ' + fmtCurrency(c.expenseTotal || 0) + ', open invoices ' + openInvoices + ', delivered projects ' + doneProjects + '.';
  }

  function wirePersonableActions() {
    var dash = $('page-dashboard');
    if (dash && dash.getAttribute('data-crm-wire') !== '1') {
      dash.setAttribute('data-crm-wire', '1');
      dash.addEventListener('click', async function (ev) {
        var done = ev.target.closest('[data-suggestion-done]');
        if (done) {
          done.disabled = true;
          await addCrmEvent('suggestion_done', 'Follow-up suggestion completed', {}, null, 'suggestion:' + Date.now() + ':' + done.getAttribute('data-suggestion-done'));
          renderPersonableCards();
          return;
        }
      });
    }

    async function handleSummary(kind) {
      var txt = buildWeeklySummaryText(kind);
      var today = dateYMD(new Date());
      supabase = window.supabaseClient || supabase;
      currentUser = window.currentUser || currentUser;
      if (supabase && currentUser && getCurrentOrgId()) {
        try {
          await supabase.from('weekly_summaries').upsert({
            id: uuid(),
            user_id: currentUser.id,
            organization_id: getCurrentOrgId(),
            summary_type: kind,
            summary_date: today,
            payload: { text: txt },
            created_at: new Date().toISOString(),
          }, { onConflict: 'organization_id,summary_type,summary_date' });
        } catch (_) {}
      }
      weeklySummaries.unshift({ summary_type: kind, summary_date: today, payload: { text: txt } });
      await addCrmEvent('weekly_summary', kind === 'monday' ? 'Monday summary generated' : 'Friday recap generated', { text: txt }, null, 'weekly:' + kind + ':' + today);
      renderPersonableCards();
    }

    var mon = $('btn-generate-monday');
    if (mon) mon.addEventListener('click', function () { handleSummary('monday'); });
    var fri = $('btn-generate-friday');
    if (fri) fri.addEventListener('click', function () { handleSummary('friday'); });
  }

  function renderDashAR() {
    var empty = $('dash-ar-empty');
    var table = $('dash-ar-table');
    var tbody = $('dash-ar-body');
    if (!tbody) return;

    var now = new Date();
    var nowTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    var outstanding = invoices.filter(function (inv) {
      return inv.status !== 'paid' && (+inv.amount || 0) > 0;
    }).sort(function (a, b) {
      return (a.dueDate || '').localeCompare(b.dueDate || '');
    });

    if (!outstanding.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      setText('kpi-ar', '$0');
      setKpiBadge('kpi-ar-badge', '—', 'neutral');
      var arBadge0 = $('kpi-ar-badge');
      if (arBadge0) {
        arBadge0.title = 'Outstanding AR is a snapshot; comparing to a prior period would require saved history.';
      }
      return;
    }

    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    var total = 0;
    tbody.innerHTML = outstanding.map(function (inv) {
      var amt = +inv.amount || 0;
      total += amt;

      var clientName = '—';
      var tx = state.transactions && state.transactions.find(function (t) { return t.id === inv.incomeTxId; });
      if (tx && tx.clientId) {
        var cl = clients.find(function (c) { return c.id === tx.clientId; });
        if (cl) clientName = esc(cl.companyName || cl.contactName || '—');
      }
      if (clientName === '—' && inv.clientName) clientName = esc(inv.clientName);

      var dueStr = inv.dueDate || '—';
      var statusLabel = inv.status === 'sent' ? 'Sent' : inv.status === 'draft' ? 'Draft' : (inv.status || 'Unpaid');
      var statusClass = inv.status === 'sent' ? 'pg-b' : 'pg-a';

      var overdue = '';
      if (inv.dueDate) {
        var dueTs = new Date(inv.dueDate).getTime();
        if (!isNaN(dueTs) && dueTs < nowTs) {
          var days = Math.floor((nowTs - dueTs) / (1000 * 60 * 60 * 24));
          overdue = ' <span class="pl pg-r" style="font-size:10px;">' + days + 'd overdue</span>';
        }
      }

      return '<tr>' +
        '<td class="tdp">' + clientName + (inv.number ? '<br><span class="td-sub">' + esc(inv.number) + '</span>' : '') + '</td>' +
        '<td>' + fmtCurrency(amt) + '</td>' +
        '<td>' + esc(dueStr) + overdue + '</td>' +
        '<td><span class="pl ' + statusClass + '">' + esc(statusLabel) + '</span></td>' +
        '</tr>';
    }).join('');

    setText('kpi-ar', fmtCurrency(total));
    setKpiBadge('kpi-ar-badge', '—', 'neutral');
    var arBadge = $('kpi-ar-badge');
    if (arBadge) {
      arBadge.title = 'Outstanding AR is a snapshot; comparing to a prior period would require saved history.';
    }
  }

  function renderAll() {
    var c = state.computed;
    if (!c) return;
    renderKPIs(c);
    renderExpenseChart(c);
    renderIncomeStatement(c);
    renderTransactionLog(c);
    renderExpensesTable(c);
    renderBudgetVsActual();
    renderSpendingReport();
    renderRevenueVsExpenses(c);
    renderIncomeSection(c);
    renderRevenueByVertical(c);
    renderInsights();
    renderMarketing();
    renderDashAR();
    renderClients();
    renderRetention();
    renderTimesheet();
    renderPersonableCards();
    var pgTasks = document.getElementById('page-tasks');
    if (pgTasks && pgTasks.classList.contains('on')) renderTasksPage();
    var pgSet = document.getElementById('page-settings');
    if (pgSet && pgSet.classList.contains('on')) renderAutomationSettings();
  }

  function renderPersonableCards() {
    var now = new Date();
    var hh = now.getHours();
    var sal = hh < 12 ? 'Good morning' : (hh < 18 ? 'Good afternoon' : 'Good evening');
    var owner = ($('setting-owner') && $('setting-owner').value ? $('setting-owner').value.trim() : '') || 'there';
    setText('crm-welcome', sal + ', ' + owner.split(' ')[0]);
    setText('crm-local-date', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));

    var tgIn = $('setting-tagline');
    var tagOut = $('dash-brand-tagline');
    if (tagOut && tgIn) {
      var tgx = String(tgIn.value || '').trim();
      if (tgx) {
        tagOut.textContent = tgx;
        tagOut.style.display = 'block';
      } else {
        tagOut.textContent = '';
        tagOut.style.display = 'none';
      }
    }

    var reminders = [];
    clients.forEach(function (c) {
      if (!c || !c.lastTouchAt) return;
      var d = new Date(c.lastTouchAt + 'T12:00:00');
      if (isNaN(d.getTime())) return;
      var days = Math.floor((now - d) / 86400000);
      if (days >= 30) reminders.push({ client: c, text: days + ' days since last outreach' });
    });
    var remEl = $('crm-reminders-list');
    if (remEl) {
      remEl.innerHTML = reminders.length ? reminders.slice(0, 6).map(function (r) {
        return '<div class="kb bn" style="padding:8px 10px;background:var(--bg2);">' + esc(r.client.companyName || 'Client') + ': ' + esc(r.text) + '</div>';
      }).join('') : '<div style="font-size:13px;color:var(--text3);">No overdue follow-ups right now.</div>';
    }

    var suggestions = [];
    clients.forEach(function (c) {
      if (!c) return;
      if (c.lastTouchAt) {
        var daysSince = Math.floor((now - new Date(c.lastTouchAt + 'T12:00:00')) / 86400000);
        if (daysSince > 30) suggestions.push({ c: c, text: 'Send a quick check-in via ' + (c.preferredChannel || 'email') + '.' });
      }
      var overdue = invoices.some(function (inv) { return inv && inv.status !== 'paid' && inv.dueDate && (new Date(inv.dueDate) < now); });
      if (overdue && c.preferredChannel) suggestions.push({ c: c, text: 'Overdue invoice: follow up on ' + c.preferredChannel + '.' });
      var completed = projects.some(function (p) { return p && p.clientId === c.id && String(p.status || '').toLowerCase().indexOf('complete') !== -1; });
      if (completed) suggestions.push({ c: c, text: 'Ask for a testimonial for the delivered project.' });
    });
    var sugEl = $('crm-suggestions-list');
    if (sugEl) {
      sugEl.innerHTML = suggestions.length ? suggestions.slice(0, 5).map(function (s, idx) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:10px;">' +
          '<div style="font-size:13px;color:var(--text2);"><strong style="color:var(--text);">' + esc(s.c.companyName || 'Client') + '</strong> - ' + esc(s.text) + '</div>' +
          '<button type="button" class="btn" data-suggestion-done="' + idx + '">Done</button>' +
        '</div>';
      }).join('') : '<div style="font-size:13px;color:var(--text3);">No suggestions for now.</div>';
    }

    var milestones = [];
    var firstPaid = invoices.filter(function (x) { return x && x.status === 'paid'; }).sort(function (a, b) { return String(a.paidAt || '').localeCompare(String(b.paidAt || '')); })[0];
    if (firstPaid) {
      milestones.push('First paid invoice: #' + (firstPaid.number || '—'));
      addCrmEvent('milestone', 'First paid invoice', { invoiceNumber: firstPaid.number || '' }, null, 'milestone:first-paid');
    }
    var monthMap = {};
    (state.transactions || []).forEach(function (tx) {
      if (!tx || (tx.category !== 'svc' && tx.category !== 'ret') || !tx.date) return;
      var ym = tx.date.slice(0, 7);
      monthMap[ym] = (monthMap[ym] || 0) + (Number(tx.amount) || 0);
    });
    var bestMonth = Object.keys(monthMap).sort(function (a, b) { return monthMap[b] - monthMap[a]; })[0];
    if (bestMonth) {
      milestones.push('Best month: ' + bestMonth + ' (' + fmtCurrency(monthMap[bestMonth]) + ')');
      addCrmEvent('milestone', 'Best revenue month', { month: bestMonth, revenue: monthMap[bestMonth] }, null, 'milestone:best-month:' + bestMonth);
    }
    if (projects.some(function (p) { return p && String(p.status || '').toLowerCase().indexOf('complete') !== -1; })) {
      milestones.push('Project delivered');
      addCrmEvent('milestone', 'Project delivered', {}, null, 'milestone:project-delivered');
    }
    var milEl = $('crm-milestones-list');
    if (milEl) milEl.innerHTML = milestones.length ? milestones.map(function (m) { return '<div class="kb bn" style="padding:8px 10px;background:var(--bg2);">' + esc(m) + '</div>'; }).join('') : '<div style="font-size:13px;color:var(--text3);">No milestones yet.</div>';

    var evEl = $('crm-events-timeline');
    if (evEl) {
      evEl.innerHTML = crmEvents.length ? crmEvents.slice(0, 8).map(function (ev) {
        var when = ev.eventAt ? new Date(ev.eventAt).toLocaleDateString() : '—';
        return '<div style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;"><div style="font-size:12px;color:var(--text3);">' + esc(when) + ' • ' + esc(ev.kind || 'event') + '</div><div style="font-size:13px;color:var(--text2);">' + esc(ev.title || '') + '</div></div>';
      }).join('') : '<div style="font-size:13px;color:var(--text3);">No timeline events yet.</div>';
    }

    var latestSummary = $('crm-latest-summary');
    if (latestSummary) {
      if (weeklySummaries.length) {
        var ws = weeklySummaries[0];
        var txt = ws && ws.payload && ws.payload.text ? ws.payload.text : '';
        latestSummary.textContent = txt || 'Latest summary saved.';
      } else {
        latestSummary.textContent = 'No summary generated yet.';
      }
    }
  }

  function renderRevenueByVertical(c) {
    var canvas = document.getElementById('cVert');
    if (!canvas || !window.Chart) return;

    var byVertical = {};
    c.txs.forEach(function (tx) {
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = +tx.amount || 0;
      if (amt <= 0) return;

      var industry = 'Uncategorized';
      if (tx.clientId) {
        var cl = clients.find(function (cc) { return cc.id === tx.clientId; });
        if (cl && cl.industry && cl.industry.trim()) {
          industry = cl.industry.trim();
        }
      }
      byVertical[industry] = (byVertical[industry] || 0) + amt;
    });

    var labels = Object.keys(byVertical);
    var data = labels.map(function (k) { return byVertical[k]; });

    if (!labels.length) {
      labels = ['No data'];
      data = [1];
    }

    var sliceColors = labels[0] === 'No data' ? [CHART_EMPTY] : chartMultiColors(labels.length);

    if (!verticalChart) {
      verticalChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: sliceColors,
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '60%',
          plugins: { legend: { display: true, position: 'bottom' } },
        },
      });
    } else {
      verticalChart.data.labels = labels;
      verticalChart.data.datasets[0].data = data;
      verticalChart.data.datasets[0].backgroundColor = sliceColors;
      verticalChart.update('none');
    }
  }

  // ---------- Insights ----------

  var insTrendChart = null;
  var retTrendChart = null;

  function monthKeyShift(ym, deltaMonths) {
    var y = parseInt(String(ym || '').slice(0, 4), 10);
    var m = parseInt(String(ym || '').slice(5, 7), 10);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return null;
    var d = new Date(y, m - 1 + deltaMonths, 1, 12, 0, 0, 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function computeRetentionMetrics() {
    var allTxs = state.transactions || [];
    var totalClients = clients.length;
    var retainerClients = clients.filter(clientIsRetainer);
    var retentionRatePct = totalClients > 0 ? (retainerClients.length / totalClients) * 100 : null;

    var revenueByClient = {};
    allTxs.forEach(function (tx) {
      if (!tx || !tx.clientId || !tx.date) return;
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = Number(tx.amount || 0);
      if (!isFinite(amt) || amt <= 0) return;
      revenueByClient[tx.clientId] = (revenueByClient[tx.clientId] || 0) + amt;
    });
    var lifetimeRevenueTotal = clients.reduce(function (sum, c) {
      return sum + (revenueByClient[c.id] || 0);
    }, 0);
    // Denominator = all clients for stable KPI behavior across account sizes.
    var avgClientLtv = totalClients > 0 ? (lifetimeRevenueTotal / totalClients) : 0;

    var today = new Date();
    var todayYmd = dateYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12));
    var churnedThisMonth = clients.filter(function (c) {
      if (!c || clientIsRetainer(c)) return false;
      var incomeTxs = allTxs.filter(function (tx) {
        return tx && tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
      });
      if (!incomeTxs.length) return false;
      var latestDate = incomeTxs.map(function (tx) { return tx.date; }).sort().pop();
      var diff = (parseYMD(todayYmd) - parseYMD(latestDate)) / 86400000;
      return diff >= 60;
    }).length;

    return {
      totalClients: totalClients,
      retainerClients: retainerClients,
      retentionRatePct: retentionRatePct,
      avgClientLtv: avgClientLtv,
      churnedThisMonth: churnedThisMonth,
      revenueByClient: revenueByClient,
      todayYmd: todayYmd,
    };
  }

  function computeRetentionTrendSeries(lookbackMonths) {
    var monthsBack = Math.max(3, Number(lookbackMonths) || 6);
    var now = new Date();
    var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var allTxs = state.transactions || [];
    var out = [];
    for (var i = monthsBack - 1; i >= 0; i--) {
      var mk = monthKeyShift(currentMonth, -i);
      if (!mk) continue;
      var activeById = {};
      allTxs.forEach(function (tx) {
        if (!tx || !tx.clientId || !tx.date) return;
        if (tx.date.slice(0, 7) !== mk) return;
        if (tx.category !== 'svc' && tx.category !== 'ret') return;
        var amt = Number(tx.amount || 0);
        if (!isFinite(amt) || amt <= 0) return;
        activeById[tx.clientId] = true;
      });
      var activeClients = clients.filter(function (c) { return c && c.id && activeById[c.id]; });
      var activeRetainers = activeClients.filter(clientIsRetainer).length;
      var pct = activeClients.length ? (activeRetainers / activeClients.length) * 100 : 0;
      out.push({ month: mk, pct: pct });
    }
    return out;
  }

  function renderRetention() {
    var m = computeRetentionMetrics();
    if (m.retentionRatePct == null) {
      setText('ret-kpi-1', '—');
      setText('ret-kpi-1b', 'no clients');
    } else {
      setText('ret-kpi-1', m.retentionRatePct.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + '%');
      setText('ret-kpi-1b', m.retainerClients.length + ' of ' + m.totalClients + ' on retainer');
    }
    setText('ret-kpi-2', fmtCurrency(m.avgClientLtv));
    setText('ret-kpi-2b', 'lifetime avg (all clients)');
    setText('ret-kpi-3', String(m.churnedThisMonth));
    setText('ret-kpi-3b', 'no activity 60d+');

    var listEl = $('retainers-list');
    var emptyEl = $('retainers-empty');
    if (listEl && emptyEl) {
      if (!m.retainerClients.length) {
        emptyEl.style.display = 'block';
        listEl.style.display = 'none';
        listEl.innerHTML = '';
      } else {
        emptyEl.style.display = 'none';
        listEl.style.display = 'flex';
        listEl.innerHTML = m.retainerClients
          .slice()
          .sort(function (a, b) {
            var ar = m.revenueByClient[a.id] || 0;
            var br = m.revenueByClient[b.id] || 0;
            return br - ar;
          })
          .map(function (c) {
            var rev = m.revenueByClient[c.id] || 0;
            var status = c.status ? esc(c.status) : 'Retainer';
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">' +
              '<div style="min-width:0;">' +
                '<div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.companyName || c.contactName || 'Client') + '</div>' +
                '<div style="font-size:11px;color:var(--text3);margin-top:2px;">' + status + '</div>' +
              '</div>' +
              '<div style="font-size:12px;font-weight:600;color:var(--text2);font-variant-numeric:tabular-nums;padding-left:10px;">' + fmtCurrency(rev) + '</div>' +
            '</div>';
          }).join('');
      }
    }

    var trendSeries = computeRetentionTrendSeries(6);
    var trendCanvas = document.getElementById('cRet');
    if (trendCanvas && window.Chart) {
      var labels = trendSeries.map(function (p) { return fmtMonthLabel(p.month); });
      var values = trendSeries.map(function (p) { return Math.round(p.pct * 10) / 10; });
      if (!retTrendChart) {
        retTrendChart = new Chart(trendCanvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Retention %',
              data: values,
              borderColor: CHART_ORANGE,
              backgroundColor: CHART_ORANGE_FILL,
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: CHART_ORANGE,
              pointHoverBackgroundColor: CHART_ORANGE,
              fill: true,
              tension: 0.3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: CHART_TICK, font: { size: 11 } } },
              y: {
                min: 0,
                max: 100,
                grid: { color: CHART_GRID },
                ticks: {
                  color: CHART_TICK,
                  font: { size: 11 },
                  callback: function (v) { return v + '%'; },
                },
              },
            },
          },
        });
      } else {
        retTrendChart.data.labels = labels;
        retTrendChart.data.datasets[0].data = values;
        syncBrandedRevenueLineDataset(retTrendChart.data.datasets[0]);
        retTrendChart.update('none');
      }
    }
  }

  function computeMonthlyRevenueSeries() {
    var byMonth = {};
    (state.transactions || []).forEach(function (tx) {
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = +tx.amount || 0;
      if (amt <= 0 || !tx.date) return;
      var key = tx.date.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + amt;
    });
    var keys = Object.keys(byMonth).sort();
    return keys.map(function (k) { return { month: k, revenue: byMonth[k] }; });
  }

  function computeMonthlyExpenseSeries() {
    var byMonth = {};
    (state.transactions || []).forEach(function (tx) {
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
      var amt = +tx.amount || 0;
      if (amt <= 0 || !tx.date) return;
      var key = tx.date.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + amt;
    });
    var keys = Object.keys(byMonth).sort();
    return keys.map(function (k) { return { month: k, expense: byMonth[k] }; });
  }

  function linearForecastValues(ys) {
    var n = ys.length;
    if (n < 2) return null;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += i;
      sumY += ys[i];
      sumXY += i * ys[i];
      sumXX += i * i;
    }
    var denom = n * sumXX - sumX * sumX;
    if (!denom) return null;
    var slope = (n * sumXY - sumX * sumY) / denom;
    var intercept = (sumY - slope * sumX) / n;
    return { slope: slope, intercept: intercept, nextValue: Math.max(0, slope * n + intercept) };
  }

  function linearForecast(series) {
    if (!series || series.length < 2) return null;
    return linearForecastValues(series.map(function (s) { return s.revenue; }));
  }

  function fmtMonthLabel(ym) {
    var parts = ym.split('-');
    var d = new Date(+parts[0], +parts[1] - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function nextMonthLabel(ym) {
    var parts = ym.split('-');
    var d = new Date(+parts[0], +parts[1], 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  /** First and last YYYY-MM with positive svc/ret or expense amounts. */
  function insightTransactionMonthBounds(txs) {
    var min = null;
    var max = null;
    (txs || []).forEach(function (tx) {
      if (!tx.date) return;
      var k = tx.date.slice(0, 7);
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      var inc = tx.category === 'svc' || tx.category === 'ret';
      var exp = ['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) !== -1;
      if (!inc && !exp) return;
      if (!min || k < min) min = k;
      if (!max || k > max) max = k;
    });
    return min && max ? { min: min, max: max } : null;
  }

  /**
   * Dense calendar months from first to last insight-related transaction month (inclusive),
   * with zero-filled gaps so walk-forward trend matches calendar periods.
   */
  function buildDenseRevExpSeries(txs) {
    var b = insightTransactionMonthBounds(txs);
    if (!b) return null;
    var months = [];
    var y = +b.min.split('-')[0];
    var m = +b.min.split('-')[1];
    var yEnd = +b.max.split('-')[0];
    var mEnd = +b.max.split('-')[1];
    while (y < yEnd || (y === yEnd && m <= mEnd)) {
      months.push(y + '-' + String(m).padStart(2, '0'));
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    if (months.length < 3) return null;
    var revBy = {};
    var expBy = {};
    (txs || []).forEach(function (tx) {
      if (!tx.date) return;
      var k = tx.date.slice(0, 7);
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (tx.category === 'svc' || tx.category === 'ret') revBy[k] = (revBy[k] || 0) + amt;
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) !== -1) expBy[k] = (expBy[k] || 0) + amt;
    });
    return {
      months: months,
      revenue: months.map(function (mk) { return revBy[mk] || 0; }),
      expense: months.map(function (mk) { return expBy[mk] || 0; }),
    };
  }

  /** For each closed month at index i>=2: OLS on prior months predicts values[i]. */
  function walkForwardTrendAccuracy(months, values, thisMonthKey) {
    var out = [];
    for (var i = 2; i < months.length; i++) {
      if (months[i] >= thisMonthKey) continue;
      var lf = linearForecastValues(values.slice(0, i));
      if (!lf) continue;
      var pred = lf.nextValue;
      var act = values[i];
      out.push({ month: months[i], forecast: pred, actual: act, delta: act - pred });
    }
    return out;
  }

  function fmtInsightAccDelta(d, invertGood) {
    var good = invertGood ? d < 0 : d > 0;
    var col = Math.abs(d) < 0.005 ? 'var(--text3)' : good ? 'var(--green)' : 'var(--red)';
    var sign = d > 0 ? '+' : '';
    return '<span style="color:' + col + ';font-weight:500;font-variant-numeric:tabular-nums;">' + sign + fmtCurrency(d) + '</span>';
  }

  /** When forecast > 0: round((actual - forecast) / forecast * 100). */
  function fmtInsightAccPctCell(forecast, actual, invertGood) {
    if (!forecast || forecast <= 0) {
      return '<td style="color:var(--text3);font-size:13px;">—</td>';
    }
    var pct = Math.round(((actual - forecast) / forecast) * 100);
    var good = invertGood ? pct < 0 : pct > 0;
    var col = pct === 0 ? 'var(--text3)' : good ? 'var(--green)' : 'var(--red)';
    var sign = pct > 0 ? '+' : '';
    return '<td style="color:' + col + ';font-weight:500;font-variant-numeric:tabular-nums;">' + sign + pct + '%</td>';
  }

  function renderInsightsForecastAccuracy(allTxs, thisMonthKey) {
    var wrap = document.getElementById('ins-forecast-accuracy');
    if (!wrap) return;
    var dense = buildDenseRevExpSeries(allTxs);
    if (!dense) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;line-height:1.5;">' +
        'Need more history: at least three calendar months with revenue or expense activity. Each row backtests the same linear trend model as Outlook (walk-forward).</p>';
      return;
    }
    var revAcc = walkForwardTrendAccuracy(dense.months, dense.revenue, thisMonthKey);
    var expAcc = walkForwardTrendAccuracy(dense.months, dense.expense, thisMonthKey);
    var keySet = {};
    revAcc.forEach(function (r) { keySet[r.month] = true; });
    expAcc.forEach(function (r) { keySet[r.month] = true; });
    var keys = Object.keys(keySet).sort();
    if (!keys.length) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;line-height:1.5;">' +
        'Forecast accuracy rows appear for months that are already closed. After this month ends, the trend vs. actual for it will show here.</p>';
      return;
    }
    var revMap = {};
    revAcc.forEach(function (r) { revMap[r.month] = r; });
    var expMap = {};
    expAcc.forEach(function (r) { expMap[r.month] = r; });
    var tbody = keys.map(function (mk) {
      var rv = revMap[mk];
      var ex = expMap[mk];
      var label = fmtMonthLabel(mk);
      var revCells = rv
        ? '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(rv.forecast) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(rv.actual) + '</td>' +
          '<td>' + fmtInsightAccDelta(rv.delta, false) + '</td>' +
          fmtInsightAccPctCell(rv.forecast, rv.actual, false)
        : '<td colspan="4" style="color:var(--text3);font-size:13px;">—</td>';
      var expCells = ex
        ? '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(ex.forecast) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(ex.actual) + '</td>' +
          '<td>' + fmtInsightAccDelta(ex.delta, true) + '</td>' +
          fmtInsightAccPctCell(ex.forecast, ex.actual, true)
        : '<td colspan="4" style="color:var(--text3);font-size:13px;">—</td>';
      return '<tr><td class="tdp" style="font-weight:500;">' + esc(label) + '</td>' + revCells + expCells + '</tr>';
    }).join('');
    wrap.innerHTML =
      '<p style="font-size:12px;color:var(--text3);margin:0 0 12px;line-height:1.5;">' +
      'Delta = actual − forecast. Err% uses the same basis when forecast &gt; 0. Only completed months; under-spend on expenses is green.</p>' +
      '<div style="overflow-x:auto;">' +
      '<table class="dt" style="margin:0;">' +
      '<thead><tr>' +
      '<th>Month</th>' +
      '<th colspan="4" style="text-align:center;border-left:1px solid var(--border);">Revenue</th>' +
      '<th colspan="4" style="text-align:center;border-left:1px solid var(--border);">Expenses</th>' +
      '</tr>' +
      '<tr>' +
      '<th></th>' +
      '<th style="border-left:1px solid var(--border);">Forecast</th><th>Actual</th><th>Delta</th><th>Err%</th>' +
      '<th style="border-left:1px solid var(--border);">Forecast</th><th>Actual</th><th>Delta</th><th>Err%</th>' +
      '</tr></thead><tbody>' + tbody + '</tbody></table></div>';
  }

  function renderInsightsBudgetAccuracy(allTxs, thisMonthKey) {
    var wrap = document.getElementById('ins-budget-accuracy');
    if (!wrap) return;
    var snaps = loadBudgetMonthSnapshots();
    var snapKeys = Object.keys(snaps).filter(function (k) { return /^\d{4}-\d{2}$/.test(k); }).sort();
    var totalCurrent = budgets.lab + budgets.sw + budgets.ads + budgets.oth;
    var hasAnyBudget = totalCurrent > 0.01;
    var hasSnaps = snapKeys.length > 0;
    if (!hasAnyBudget && !hasSnaps) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;line-height:1.5;">' +
        'Save monthly budgets in Settings to compare <strong>plan vs spend</strong> for closed months. Each save stores that calendar month’s budget snapshot for this table.</p>';
      return;
    }
    var dense = buildDenseRevExpSeries(allTxs);
    var monthSet = {};
    if (dense) {
      dense.months.forEach(function (mk) {
        if (mk < thisMonthKey) monthSet[mk] = true;
      });
    }
    snapKeys.forEach(function (mk) {
      if (mk < thisMonthKey) monthSet[mk] = true;
    });
    var keys = Object.keys(monthSet).sort();
    if (!keys.length) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;">Budget history rows appear once prior months are closed.</p>';
      return;
    }
    var expByMonth = {};
    (allTxs || []).forEach(function (tx) {
      if (!tx.date) return;
      var k = tx.date.slice(0, 7);
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
      expByMonth[k] = (expByMonth[k] || 0) + amt;
    });
    var anyFallback = false;
    var tbody = keys.map(function (mk) {
      var act = expByMonth[mk] || 0;
      var sn = snaps[mk];
      var fromSnap = sn && budgetSnapshotTotal(sn) > 0.005;
      var planned = fromSnap ? budgetSnapshotTotal(sn) : totalCurrent;
      if (!fromSnap && totalCurrent < 0.01 && act < 0.01) return '';
      if (!fromSnap && totalCurrent >= 0.01) anyFallback = true;
      if (planned < 0.01 && act < 0.01) return '';
      var delta = act - planned;
      var deltaHtml = fmtInsightAccDelta(delta, true);
      var planCell = fmtCurrency(planned) + (fromSnap ? '' : ' <span style="color:var(--text3);font-size:11px;font-weight:500;">*</span>');
      return '<tr>' +
        '<td class="tdp" style="font-weight:500;">' + esc(fmtMonthLabel(mk)) + '</td>' +
        '<td style="font-variant-numeric:tabular-nums;">' + planCell + '</td>' +
        '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(act) + '</td>' +
        '<td>' + deltaHtml + '</td>' +
        fmtInsightAccPctCell(planned, act, true) +
      '</tr>';
    }).filter(Boolean).join('');
    if (!tbody) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;">No closed months with budget or spend yet.</p>';
      return;
    }
    var foot = anyFallback
      ? '<p style="font-size:11px;color:var(--text3);margin:10px 0 0;line-height:1.45;">* No snapshot for that month — using your <strong>current</strong> Settings budget total. Save budgets during each month to lock the plan for history.</p>'
      : '';
    wrap.innerHTML =
      '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:8px;">Budget vs actual</div>' +
      '<p style="font-size:12px;color:var(--text3);margin:0 0 10px;line-height:1.5;">Planned spend from saved budget snapshots (or current total). Actual = same expense categories as Budget vs. Actual on the main page.</p>' +
      '<div style="overflow-x:auto;">' +
      '<table class="dt" style="margin:0;">' +
      '<thead><tr><th>Month</th><th>Budget (plan)</th><th>Actual</th><th>Delta</th><th>Err%</th></tr></thead>' +
      '<tbody>' + tbody + '</tbody></table></div>' + foot;
  }

  var INSIGHT_EXPENSE_CATEGORIES = ['lab', 'sw', 'ads', 'oth'];

  function isExpenseCategory(cat) {
    return INSIGHT_EXPENSE_CATEGORIES.indexOf(cat) !== -1;
  }

  /** Lowercase, collapse spaces, strip common corporate suffixes for matching. */
  function normalizeVendorName(v) {
    if (v == null) return '';
    var s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return '';
    s = s.replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function filterExpenseTxsInRange(txs, startYmd, endYmd) {
    return (txs || []).filter(function (tx) {
      if (!tx || !tx.date) return false;
      if (tx.date < startYmd || tx.date > endYmd) return false;
      var amt = +tx.amount || 0;
      if (amt <= 0) return false;
      return isExpenseCategory(tx.category);
    });
  }

  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    var al = a.length;
    var bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    var row = [];
    var i; var j; var prev; var t;
    for (j = 0; j <= bl; j++) row[j] = j;
    for (i = 1; i <= al; i++) {
      prev = row[0];
      row[0] = i;
      for (j = 1; j <= bl; j++) {
        t = row[j];
        row[j] = a.charAt(i - 1) === b.charAt(j - 1) ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = t;
      }
    }
    return row[bl];
  }

  function insightAlertCardHtml(a) {
    var bg = a.type === 'good' ? 'var(--green-bg)' : a.type === 'warn' ? 'var(--amber-bg)' : 'var(--blue-bg)';
    var border = a.type === 'good' ? 'var(--green)' : a.type === 'warn' ? 'var(--amber)' : 'var(--blue)';
    var icon = a.type === 'good' ? '✓' : a.type === 'warn' ? '⚠' : 'ℹ';
    return '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:var(--r);background:' + bg + ';border-left:3px solid ' + border + ';">' +
      '<span style="font-size:14px;line-height:1.4;flex-shrink:0;">' + icon + '</span>' +
      '<span style="font-size:13px;line-height:1.5;color:var(--text);">' + a.msg + '</span>' +
      '</div>';
  }

  function renderInsightsAlertList(items) {
    return (items || []).map(insightAlertCardHtml).join('');
  }

  function renderInsights() {
    var allTxs = state.transactions || [];
    var now = new Date();
    var todayStr = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12));

    // ---- Monthly revenue & expense series ----
    var series = computeMonthlyRevenueSeries();
    var expSeries = computeMonthlyExpenseSeries();
    var last3 = series.slice(-3);
    var avg3 = last3.length ? last3.reduce(function (s, x) { return s + x.revenue; }, 0) / last3.length : 0;
    var thisMonthKey = todayStr.slice(0, 7);
    var thisMonthRev = (series.find(function (s) { return s.month === thisMonthKey; }) || {}).revenue || 0;

    // ---- Expense totals ----
    var expByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    var expLabels = { lab: 'Labor', sw: 'Software & Tools', ads: 'Advertising', oth: 'Other' };
    allTxs.forEach(function (tx) {
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (expByCat.hasOwnProperty(tx.category)) expByCat[tx.category] += amt;
    });
    var expTotal = expByCat.lab + expByCat.sw + expByCat.ads + expByCat.oth;

    // ---- MRR from retainer clients ----
    var retainerClients = clients.filter(clientIsRetainer);
    var mrr = retainerClients.reduce(function (sum, c) {
      var rev = effectiveClientRevenue(c);
      return sum + (rev > 0 ? rev / Math.max(1, series.length) : 0);
    }, 0);

    // ---- Top client ----
    var clientRevs = clients.map(function (c) {
      return { client: c, rev: effectiveClientRevenue(c) };
    }).filter(function (x) { return x.rev > 0; }).sort(function (a, b) { return b.rev - a.rev; });
    var topClient = clientRevs[0] || null;

    // ---- Churn risk: clients with income tx but none in 60 days ----
    var churnRisk = clients.filter(function (c) {
      var incomeTxs = allTxs.filter(function (tx) {
        return tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
      });
      if (!incomeTxs.length) return false;
      var latestDate = incomeTxs.map(function (tx) { return tx.date; }).sort().pop();
      var diff = (parseYMD(todayStr) - parseYMD(latestDate)) / 86400000;
      return diff >= 60;
    });

    // ---- Forecast ----
    var forecast = linearForecast(series);
    var expForecast = linearForecastValues(expSeries.map(function (s) { return s.expense; }));

    // ---- Alerts (revenue vs spending columns) ----
    var wrapEl = document.getElementById('insights-alerts-wrap');
    var rowEl = document.getElementById('insights-alerts-row');
    var revAlertsEl = document.getElementById('insights-alerts-revenue');
    var spendAlertsEl = document.getElementById('insights-alerts-spend');
    var healthyEl = document.getElementById('insights-alerts-healthy');
    var legacyAlertsEl = document.getElementById('insights-alerts');
    var revenueAlerts = [];
    var spendAlerts = [];
    var budgetCatLabels = { lab: 'Labor', sw: 'Software & Tools', ads: 'Advertising', oth: 'Other' };

    // Expense spike vs 3-month avg → spending
    var thisMonthExp = 0;
    allTxs.forEach(function (tx) {
      if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
      var amt = +tx.amount || 0;
      if (expByCat.hasOwnProperty(tx.category) && amt > 0) thisMonthExp += amt;
    });
    var last3Exp = [];
    for (var mi = 1; mi <= 3; mi++) {
      var dExp = new Date(now.getFullYear(), now.getMonth() - mi, 1);
      var mkExp = dExp.getFullYear() + '-' + String(dExp.getMonth() + 1).padStart(2, '0');
      var mExp = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== mkExp) return;
        var amt = +tx.amount || 0;
        if (expByCat.hasOwnProperty(tx.category) && amt > 0) mExp += amt;
      });
      last3Exp.push(mExp);
    }
    var avgExp3 = last3Exp.length ? last3Exp.reduce(function (a, b) { return a + b; }, 0) / last3Exp.length : 0;
    if (avgExp3 > 0 && thisMonthExp > avgExp3 * 1.35) {
      var expPct = Math.round((thisMonthExp / avgExp3 - 1) * 100);
      spendAlerts.push({ type: 'warn', msg: 'Expenses this month are <strong>' + expPct + '% above</strong> your 3-month average (' + fmtCurrency(thisMonthExp) + ' vs avg ' + fmtCurrency(avgExp3) + ').' });
    }

    // Revenue vs avg → revenue
    if (avg3 > 0 && thisMonthRev > 0 && thisMonthRev < avg3 * 0.6) {
      revenueAlerts.push({ type: 'warn', msg: 'Revenue this month (' + fmtCurrency(thisMonthRev) + ') is tracking <strong>below</strong> your 3-month average of ' + fmtCurrency(avg3) + '.' });
    }
    if (avg3 > 0 && thisMonthRev > avg3 * 1.25) {
      var upPct = Math.round((thisMonthRev / avg3 - 1) * 100);
      revenueAlerts.push({ type: 'good', msg: 'Revenue this month is <strong>' + upPct + '% above</strong> your 3-month average — great month!' });
    }
    if (churnRisk.length) {
      revenueAlerts.push({ type: 'warn', msg: churnRisk.length + ' client' + (churnRisk.length > 1 ? 's have' : ' has') + ' had no income in 60+ days: <strong>' + churnRisk.map(function (c) { return esc(c.companyName || c.contactName || 'Unknown'); }).join(', ') + '</strong>.' });
    }
    if (!retainerClients.length && clients.length > 0) {
      revenueAlerts.push({ type: 'info', msg: 'You have no retainer clients yet. Retainers provide predictable monthly revenue.' });
    }

    // Budget alerts → spending
    var hasAnyBudget = (budgets.lab + budgets.sw + budgets.ads + budgets.oth) > 0;
    if (!hasAnyBudget && allTxs.length > 0) {
      spendAlerts.push({ type: 'info', msg: 'No monthly budgets set. <a href="#" onclick="window.nav(\'settings\');return false;" style="color:var(--blue);font-weight:500;text-decoration:none;">Set budgets in Settings</a> to track spending targets.' });
    } else if (hasAnyBudget) {
      var budgetActual = { lab: 0, sw: 0, ads: 0, oth: 0 };
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
        var amtB = +tx.amount || 0;
        if (amtB > 0 && budgetActual.hasOwnProperty(tx.category)) budgetActual[tx.category] += amtB;
      });
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        var bgt = budgets[k];
        var act = budgetActual[k];
        if (bgt < 0.01) return;
        var usedPct = act / bgt * 100;
        if (usedPct >= 100) {
          var overAmt = act - bgt;
          spendAlerts.push({ type: 'warn', msg: '<strong>' + budgetCatLabels[k] + '</strong> is <strong>' + fmtCurrency(overAmt) + ' over budget</strong> this month (budgeted ' + fmtCurrency(bgt) + ', spent ' + fmtCurrency(act) + ').' });
        } else if (usedPct >= 80) {
          var leftAmt = bgt - act;
          spendAlerts.push({ type: 'warn', msg: '<strong>' + budgetCatLabels[k] + '</strong> has used <strong>' + Math.round(usedPct) + '%</strong> of its monthly budget — ' + fmtCurrency(leftAmt) + ' remaining.' });
        }
      });
    }

    // --- Spending nudges: overlap, category spikes, duplicate vendors/charges, recurring ---
    var start90 = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90, 12));
    var start180 = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 180, 12));
    var swByVendor90 = {};
    filterExpenseTxsInRange(allTxs, start90, todayStr).forEach(function (tx) {
      if (tx.category !== 'sw') return;
      var rawV = (tx.vendor && String(tx.vendor).trim()) || '';
      var nk = normalizeVendorName(rawV);
      if (!nk) return;
      var amt = +tx.amount || 0;
      swByVendor90[nk] = (swByVendor90[nk] || 0) + amt;
    });
    var swVendorCount = Object.keys(swByVendor90).filter(function (vk) { return swByVendor90[vk] >= 25; }).length;
    if (swVendorCount >= 3) {
      spendAlerts.push({ type: 'info', msg: 'You have <strong>' + swVendorCount + ' software &amp; tool vendors</strong> with meaningful spend (90d) — review for overlap or duplicate tools.' });
    }

    var prior3Cat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    for (var pci = 1; pci <= 3; pci++) {
      var dPrior = new Date(now.getFullYear(), now.getMonth() - pci, 1);
      var mkPrior = dPrior.getFullYear() + '-' + String(dPrior.getMonth() + 1).padStart(2, '0');
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== mkPrior) return;
        var amtP = +tx.amount || 0;
        if (amtP <= 0 || !prior3Cat.hasOwnProperty(tx.category)) return;
        prior3Cat[tx.category] += amtP;
      });
    }
    ['lab', 'sw', 'ads', 'oth'].forEach(function (ck) {
      var priorAvg = prior3Cat[ck] / 3;
      var thisCat = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey || tx.category !== ck) return;
        var amtC = +tx.amount || 0;
        if (amtC > 0) thisCat += amtC;
      });
      if (priorAvg > 100 && thisCat > priorAvg * 1.5) {
        var catUp = Math.round((thisCat / priorAvg - 1) * 100);
        spendAlerts.push({ type: 'warn', msg: '<strong>' + budgetCatLabels[ck] + '</strong> spend this month is <strong>' + catUp + '% above</strong> your prior 3-month average (' + fmtCurrency(thisCat) + ' vs avg ' + fmtCurrency(priorAvg) + ').' });
      }
    });

    var vendorSpend180 = {};
    var vendorDisplay180 = {};
    filterExpenseTxsInRange(allTxs, start180, todayStr).forEach(function (tx) {
      var raw = (tx.vendor && String(tx.vendor).trim()) || '';
      if (!raw) return;
      var nk = normalizeVendorName(raw);
      if (!nk) return;
      vendorSpend180[nk] = (vendorSpend180[nk] || 0) + (+tx.amount || 0);
      if (!vendorDisplay180[nk]) vendorDisplay180[nk] = raw;
    });
    var normKeys = Object.keys(vendorSpend180).filter(function (k) { return vendorSpend180[k] > 0; });
    var dupPairs = [];
    var pi; var pj;
    for (pi = 0; pi < normKeys.length; pi++) {
      for (pj = pi + 1; pj < normKeys.length; pj++) {
        var ka = normKeys[pi];
        var kb = normKeys[pj];
        if (ka.length < 4 || kb.length < 4) continue;
        if (levenshteinDistance(ka, kb) <= 1) {
          dupPairs.push([vendorDisplay180[ka] || ka, vendorDisplay180[kb] || kb]);
          if (dupPairs.length >= 4) break;
        }
      }
      if (dupPairs.length >= 4) break;
    }
    if (dupPairs.length) {
      var pairStr = dupPairs.slice(0, 3).map(function (pair) {
        return '<strong>' + esc(pair[0]) + '</strong> / <strong>' + esc(pair[1]) + '</strong>';
      }).join('; ');
      spendAlerts.push({ type: 'info', msg: 'Possible duplicate vendor names (similar spelling): ' + pairStr + '.' });
    }

    var dupChargeMap = {};
    allTxs.forEach(function (tx) {
      if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
      var amtD = +tx.amount || 0;
      if (amtD <= 0 || !isExpenseCategory(tx.category)) return;
      var nv = normalizeVendorName(tx.vendor || '');
      if (!nv) nv = normalizeVendorName(tx.title || '');
      if (!nv) return;
      var cents = Math.round(amtD * 100);
      var dk = nv + '\0' + tx.date + '\0' + cents;
      dupChargeMap[dk] = (dupChargeMap[dk] || 0) + 1;
    });
    Object.keys(dupChargeMap).forEach(function (dk) {
      if (dupChargeMap[dk] < 2) return;
      var parts = dk.split('\0');
      spendAlerts.push({ type: 'warn', msg: 'Possible <strong>duplicate expense entries</strong> on ' + esc(parts[1]) + ' (' + esc(parts[0]) + ', same amount) — check your ledger.' });
    });

    var recurringLeads = allTxs.filter(function (t) {
      return t && t.expenseRecurringLead && t.recurrence && t.recurrenceSeriesId && isExpenseCategory(t.category);
    });
    var staleSeriesWarned = {};
    recurringLeads.forEach(function (lead) {
      var sid = lead.recurrenceSeriesId;
      if (staleSeriesWarned[sid]) return;
      var rule = lead.recurrence;
      var endD = rule.endDate && String(rule.endDate).trim();
      if (endD && endD < todayStr) return;
      var seriesDates = [];
      allTxs.forEach(function (t) {
        if (t.recurrenceSeriesId === sid && t.date) seriesDates.push(t.date);
      });
      var latest = seriesDates.length ? seriesDates.sort().pop() : lead.date;
      if (!latest) return;
      var gapDays = (parseYMD(todayStr) - parseYMD(latest)) / 86400000;
      var intervalN = Math.max(1, parseInt(rule.interval, 10) || 1);
      var expectedDays = rule.repeat === 'weekly' ? 7 * intervalN : 30 * intervalN;
      if (gapDays > expectedDays * 1.5) {
        staleSeriesWarned[sid] = true;
        var staleLabel = esc(lead.vendor || lead.title || 'Recurring expense');
        spendAlerts.push({ type: 'warn', msg: 'Recurring expense <strong>' + staleLabel + '</strong> has <strong>no recent charge</strong> in this series — confirm it is still active or update the schedule.' });
      }
    });

    var swRecurringLeads = recurringLeads.filter(function (t) { return t.category === 'sw'; });
    if (swRecurringLeads.length >= 3) {
      spendAlerts.push({ type: 'info', msg: 'You have <strong>' + swRecurringLeads.length + ' active recurring</strong> software &amp; tool subscriptions — worth a periodic audit.' });
    }

    var hasNewLayout = wrapEl && revAlertsEl && spendAlertsEl;
    if (hasNewLayout) {
      if (!revenueAlerts.length && !spendAlerts.length && allTxs.length > 0) {
        if (rowEl) rowEl.style.display = 'none';
        if (healthyEl) healthyEl.innerHTML = insightAlertCardHtml({ type: 'good', msg: 'Everything looks healthy — no anomalies detected.' });
      } else {
        if (rowEl) rowEl.style.display = 'grid';
        if (healthyEl) healthyEl.innerHTML = '';
        revAlertsEl.innerHTML = renderInsightsAlertList(revenueAlerts);
        spendAlertsEl.innerHTML = renderInsightsAlertList(spendAlerts);
      }
    } else if (legacyAlertsEl) {
      var merged = revenueAlerts.concat(spendAlerts);
      if (!merged.length && allTxs.length > 0) merged.push({ type: 'good', msg: 'Everything looks healthy — no anomalies detected.' });
      legacyAlertsEl.innerHTML = renderInsightsAlertList(merged);
    }

    // ---- KPI cards ----
    setText('ins-mrr', fmtCurrency(mrr));
    if (topClient) {
      setText('ins-top-client-rev', fmtCurrency(topClient.rev));
      setText('ins-top-client-name', esc(topClient.client.companyName || topClient.client.contactName || '—'));
    } else {
      setText('ins-top-client-rev', '$0');
      setText('ins-top-client-name', '—');
    }
    setText('ins-avg-monthly', fmtCurrency(avg3));
    setText('ins-churn-count', String(churnRisk.length));

    // ---- Trend badge ----
    if (forecast && series.length >= 2) {
      var lastRev = series[series.length - 1].revenue;
      var trendPct = lastRev > 0 ? Math.round((forecast.slope / lastRev) * 100) : 0;
      var trendBadge = document.getElementById('ins-trend-badge');
      if (trendBadge) {
        trendBadge.textContent = trendPct >= 0 ? '↑ ' + trendPct + '% trend' : '↓ ' + Math.abs(trendPct) + '% trend';
        trendBadge.style.color = trendPct >= 0 ? 'var(--green)' : 'var(--red)';
      }
    }

    // ---- Revenue trend chart ----
    var trendCanvas = document.getElementById('cInsTrend');
    if (trendCanvas && window.Chart) {
      var trendLabels = series.map(function (s) { return fmtMonthLabel(s.month); });
      var trendData = series.map(function (s) { return s.revenue; });
      if (!insTrendChart) {
        insTrendChart = new Chart(trendCanvas, {
          type: 'line',
          data: {
            labels: trendLabels,
            datasets: [{
              label: 'Revenue',
              data: trendData,
              borderColor: CHART_ORANGE,
              backgroundColor: CHART_ORANGE_FILL,
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: CHART_ORANGE,
              pointBorderColor: '#ffffff',
              pointBorderWidth: 2,
              pointHoverBackgroundColor: CHART_ORANGE,
              fill: true,
              tension: 0.35,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: CHART_TICK, font: { size: 11 } } },
              y: { grid: { color: CHART_GRID }, ticks: { color: CHART_TICK, font: { size: 11 }, callback: function (v) { return '$' + v.toLocaleString(); } } },
            },
          },
        });
      } else {
        insTrendChart.data.labels = trendLabels;
        insTrendChart.data.datasets[0].data = trendData;
        syncBrandedRevenueLineDataset(insTrendChart.data.datasets[0]);
        insTrendChart.update('none');
      }
    }

    // ---- Expense breakdown ----
    var expBreakEl = document.getElementById('ins-expense-breakdown');
    if (expBreakEl) {
      var expPairs = Object.keys(expByCat).map(function (k) {
        return [expLabels[k], expByCat[k]];
      }).filter(function (p) { return p[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; });
      if (!expPairs.length) {
        expBreakEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">No expense data yet.</div>';
      } else {
        expBreakEl.innerHTML = expPairs.map(function (p) {
          var pct = expTotal > 0 ? Math.round(p[1] / expTotal * 100) : 0;
          return '<div>' +
            '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">' +
              '<span>' + esc(p[0]) + '</span>' +
              '<span style="font-weight:600;">' + fmtCurrency(p[1]) + ' <span style="font-weight:400;color:var(--text3);">(' + pct + '%)</span></span>' +
            '</div>' +
            '<div style="height:5px;background:var(--bg3);border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;width:' + pct + '%;background:var(--coral);border-radius:3px;"></div>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    }

    // ---- Forecast & run rate card ----
    var forecastEl = document.getElementById('ins-forecast-body');
    if (forecastEl) {
      var dim = daysInMonth(now.getFullYear(), now.getMonth());
      var dom = Math.max(1, now.getDate());
      var mtdExpense = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
        if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
        var a = +tx.amount || 0;
        if (a > 0) mtdExpense += a;
      });
      var projectedEom = mtdExpense > 0 ? (mtdExpense / dom) * dim : 0;

      var paceHtml = '<div id="ins-pace-block" style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);">' +
        '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">This month (pace)</div>';
      if (mtdExpense > 0) {
        paceHtml +=
          '<div style="font-size:13px;color:var(--text2);line-height:1.5;">MTD ' + fmtCurrency(mtdExpense) + ' · At current daily pace, ~<strong style="color:var(--text);">' + fmtCurrency(projectedEom) + '</strong> by month-end</div>' +
          '<div style="font-size:12px;color:var(--text3);margin-top:6px;line-height:1.45;">' + dim + ' days in month · day ' + dom + '.</div>';
      } else {
        paceHtml += '<div style="font-size:13px;color:var(--text3);">No expense recorded this month yet.</div>';
      }
      paceHtml += '</div>';

      var lastRevMonth = series.length ? series[series.length - 1].month : null;
      var lastExpMonth = expSeries.length ? expSeries[expSeries.length - 1].month : null;
      var anchorMonth = lastRevMonth && lastExpMonth
        ? (lastRevMonth > lastExpMonth ? lastRevMonth : lastExpMonth)
        : (lastRevMonth || lastExpMonth);
      var nextLabelCombined = anchorMonth ? nextMonthLabel(anchorMonth) : '';

      var revHtml = '';
      if (forecast && series.length >= 2) {
        var nextLabelRev = nextMonthLabel(series[series.length - 1].month);
        var lastActual = series[series.length - 1].revenue;
        var delta = forecast.nextValue - lastActual;
        var deltaColor = delta >= 0 ? 'var(--green)' : 'var(--red)';
        var deltaSign = delta >= 0 ? '+' : '';
        revHtml =
          '<div id="ins-rev-trend-block" style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">Next month — revenue (trend)</div>' +
            '<div style="font-size:13px;color:var(--text3);margin-bottom:8px;">' + nextLabelRev + '</div>' +
            '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;margin-bottom:6px;">' + fmtCurrency(forecast.nextValue) + '</div>' +
            '<div style="font-size:13px;color:' + deltaColor + ';font-weight:500;">' + deltaSign + fmtCurrency(delta) + ' vs last month</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5;">Linear trend across ' + series.length + ' month' + (series.length > 1 ? 's' : '') + ' of revenue.</div>' +
          '</div>';
      }

      var expHtml = '';
      if (expForecast && expSeries.length >= 2) {
        var nextLabelExp = nextMonthLabel(expSeries[expSeries.length - 1].month);
        var lastExpAmt = expSeries[expSeries.length - 1].expense;
        var expDelta = expForecast.nextValue - lastExpAmt;
        var expDeltaColor = expDelta >= 0 ? 'var(--red)' : 'var(--green)';
        var expDeltaSign = expDelta >= 0 ? '+' : '';
        expHtml =
          '<div id="ins-exp-trend-block" style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">Next month — expense (trend)</div>' +
            '<div style="font-size:13px;color:var(--text3);margin-bottom:8px;">' + nextLabelExp + '</div>' +
            '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;margin-bottom:6px;">' + fmtCurrency(expForecast.nextValue) + '</div>' +
            '<div style="font-size:13px;color:' + expDeltaColor + ';font-weight:500;">' + expDeltaSign + fmtCurrency(expDelta) + ' vs last month</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5;">Linear trend across ' + expSeries.length + ' month' + (expSeries.length > 1 ? 's' : '') + ' of expenses.</div>' +
          '</div>';
      }

      var netHtml = '';
      if (forecast && expForecast && series.length >= 2 && expSeries.length >= 2) {
        var netVal = forecast.nextValue - expForecast.nextValue;
        var netColor = netVal >= 0 ? 'var(--green)' : 'var(--red)';
        netHtml =
          '<div id="ins-net-block">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">Projected net — ' + nextLabelCombined + '</div>' +
            '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;color:' + netColor + ';">' + fmtCurrency(netVal) + '</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5;">Revenue trend minus expense trend (next period).</div>' +
          '</div>';
      } else if ((forecast && series.length >= 2) || (expForecast && expSeries.length >= 2)) {
        netHtml =
          '<div id="ins-net-block" style="font-size:12px;color:var(--text3);line-height:1.5;">Need at least 2 months of both revenue and expense history for a full projected net estimate.</div>';
      }

      var hasRevForecast = forecast && series.length >= 2;
      var hasExpForecast = expForecast && expSeries.length >= 2;
      if (!hasRevForecast && !hasExpForecast && mtdExpense <= 0 && !series.length && !expSeries.length) {
        forecastEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">Add transactions to see pace and trends. Need at least 2 months of history for revenue or expense forecasts.</div>';
      } else if (!hasRevForecast && !hasExpForecast && mtdExpense <= 0) {
        forecastEl.innerHTML = paceHtml +
          '<div style="font-size:13px;color:var(--text3);">Need at least 2 months of revenue or expense history for trend forecasts.</div>';
      } else {
        forecastEl.innerHTML = paceHtml + revHtml + expHtml + netHtml;
      }
    }

    renderInsightsForecastAccuracy(allTxs, thisMonthKey);
    renderInsightsBudgetAccuracy(allTxs, thisMonthKey);

    // ---- Client performance table ----
    var clientsTbody = document.getElementById('ins-clients-tbody');
    var clientsTable = document.getElementById('ins-clients-table');
    var clientsEmpty = document.getElementById('ins-clients-empty');
    if (clientsTbody) {
      var sortedClients = clients.slice().sort(function (a, b) {
        return effectiveClientRevenue(b) - effectiveClientRevenue(a);
      });
      if (!sortedClients.length) {
        if (clientsEmpty) clientsEmpty.style.display = 'block';
        if (clientsTable) clientsTable.style.display = 'none';
      } else {
        if (clientsEmpty) clientsEmpty.style.display = 'none';
        if (clientsTable) clientsTable.style.display = 'table';
        clientsTbody.innerHTML = sortedClients.map(function (c) {
          var rev = effectiveClientRevenue(c);
          var pcount = clientProjectCount(c.id);
          var incomeTxs = allTxs.filter(function (tx) {
            return tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
          });
          var lastDate = incomeTxs.length ? incomeTxs.map(function (tx) { return tx.date; }).sort().pop() : null;
          var daysSince = lastDate ? Math.floor((parseYMD(todayStr) - parseYMD(lastDate)) / 86400000) : null;
          var activityLabel = daysSince === null ? '—' : daysSince === 0 ? 'Today' : daysSince + 'd ago';
          var activityColor = daysSince === null ? 'var(--text3)' : daysSince >= 60 ? 'var(--red)' : daysSince >= 30 ? 'var(--amber)' : 'var(--green)';
          var retainerBadge = clientIsRetainer(c) ? '<span class="pl pg-c">Retainer</span>' : '—';
          var statusBadge = (c.status || '—');
          return '<tr>' +
            '<td class="tdp">' + esc(c.companyName || c.contactName || '—') + '</td>' +
            '<td>' + fmtCurrency(rev) + '</td>' +
            '<td>' + (pcount || '—') + '</td>' +
            '<td>' + retainerBadge + '</td>' +
            '<td style="color:' + activityColor + ';font-weight:500;">' + activityLabel + '</td>' +
            '<td>' + esc(statusBadge) + '</td>' +
          '</tr>';
        }).join('');
      }
    }

    // ---- Churn risk list ----
    var churnList = document.getElementById('ins-churn-list');
    var churnEmpty = document.getElementById('ins-churn-empty');
    if (churnList) {
      if (!churnRisk.length) {
        if (churnEmpty) churnEmpty.style.display = 'block';
        churnList.innerHTML = '';
      } else {
        if (churnEmpty) churnEmpty.style.display = 'none';
        churnList.innerHTML = churnRisk.map(function (c) {
          var incomeTxs = allTxs.filter(function (tx) {
            return tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
          });
          var lastDate = incomeTxs.map(function (tx) { return tx.date; }).sort().pop();
          var daysSince = Math.floor((parseYMD(todayStr) - parseYMD(lastDate)) / 86400000);
          var rev = effectiveClientRevenue(c);
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-radius:var(--r);border:1px solid var(--border);background:var(--bg2);">' +
            '<div>' +
              '<div style="font-weight:600;font-size:14px;">' + esc(c.companyName || c.contactName || '—') + '</div>' +
              '<div style="font-size:12px;color:var(--text3);margin-top:3px;">Last income: ' + fmtDateDisplay(lastDate) + ' · Total revenue: ' + fmtCurrency(rev) + '</div>' +
            '</div>' +
            '<span class="pl pg-r">' + daysSince + 'd inactive</span>' +
          '</div>';
        }).join('');
      }
    }
  }

  function renderLeadSourcesChart(activePipeline) {
    var canvas = document.getElementById('cLead');
    if (!canvas || !window.Chart) return;

    var byChannel = {};
    (activePipeline || []).forEach(function (c) {
      var ch = (c.channel || '').trim() || 'Unspecified';
      byChannel[ch] = (byChannel[ch] || 0) + 1;
    });

    var pairs = Object.keys(byChannel).map(function (k) {
      return [k, byChannel[k]];
    }).sort(function (a, b) { return b[1] - a[1]; });

    var labels = [];
    var data = [];

    if (!pairs.length) {
      labels = ['No active pipeline'];
      data = [1];
    } else {
      pairs.forEach(function (p) {
        labels.push(p[0]);
        data.push(p[1]);
      });
    }

    var bg = !pairs.length ? [CHART_EMPTY] : chartMultiColors(labels.length);

    if (!leadSourceChart) {
      leadSourceChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: bg,
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: { legend: { display: false } },
        },
      });
    } else {
      leadSourceChart.data.labels = labels;
      leadSourceChart.data.datasets[0].data = data;
      leadSourceChart.data.datasets[0].backgroundColor = bg;
      leadSourceChart.update('none');
    }
  }

  var marketingGa4State = {
    orgId: '',
    loading: false,
    loaded: false,
    error: '',
    data: null,
    inFlight: null,
  };

  function setGa4Value(id, value) {
    var el = $(id);
    if (!el) return;
    el.textContent = value;
  }

  function fmtInt(n) {
    var v = Number(n || 0) || 0;
    return v.toLocaleString();
  }

  function renderMarketingGa4Panel() {
    var status = $('marketing-ga4-status');
    var channelsEl = $('marketing-ga4-channels');
    if (!status || !channelsEl) return;

    if (marketingGa4State.loading) {
      status.textContent = 'Loading analytics…';
      status.style.color = 'var(--text3)';
      channelsEl.textContent = '';
      setGa4Value('ga4-users', '—');
      setGa4Value('ga4-sessions', '—');
      setGa4Value('ga4-new-users', '—');
      setGa4Value('ga4-page-views', '—');
      setGa4Value('ga4-conversions', '—');
      return;
    }

    if (marketingGa4State.error) {
      status.textContent = marketingGa4State.error;
      status.style.color = 'var(--red)';
      channelsEl.textContent = '';
      return;
    }

    var payload = marketingGa4State.data || null;
    if (!payload) {
      status.textContent = 'Analytics unavailable.';
      status.style.color = 'var(--text3)';
      channelsEl.textContent = '';
      return;
    }

    if (payload.configured === false) {
      status.textContent = payload.reason || 'GA4 is not configured yet.';
      status.style.color = 'var(--amber)';
      channelsEl.textContent = '';
      return;
    }

    if (payload.error) {
      status.textContent = payload.details ? String(payload.error) + ' ' + String(payload.details) : String(payload.error);
      status.style.color = 'var(--red)';
      channelsEl.textContent = '';
      return;
    }

    var summary = payload.summary || {};
    setGa4Value('ga4-users', fmtInt(summary.users));
    setGa4Value('ga4-sessions', fmtInt(summary.sessions));
    setGa4Value('ga4-new-users', fmtInt(summary.newUsers));
    setGa4Value('ga4-page-views', fmtInt(summary.pageViews));
    setGa4Value('ga4-conversions', fmtInt(summary.conversions));

    status.textContent = 'Connected to GA4';
    status.style.color = 'var(--green)';

    var channels = Array.isArray(payload.channels) ? payload.channels : [];
    if (!channels.length) {
      channelsEl.textContent = 'No channel breakdown available.';
      return;
    }
    channelsEl.innerHTML = channels
      .map(function (c) {
        return (
          '<span style="display:inline-block;margin-right:10px;margin-bottom:6px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--bg3);">' +
          esc(c.source || 'Unknown') + ': ' + fmtInt(c.sessions || 0) +
          '</span>'
        );
      })
      .join('');
  }

  async function loadMarketingGa4() {
    var supabase = window.supabaseClient;
    var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
    if (!supabase || !orgId) {
      marketingGa4State = {
        orgId: orgId || '',
        loading: false,
        loaded: true,
        error: 'Select a workspace to load analytics.',
        data: null,
        inFlight: null,
      };
      renderMarketingGa4Panel();
      return;
    }
    if (marketingGa4State.orgId === orgId && marketingGa4State.loaded) {
      renderMarketingGa4Panel();
      return;
    }
    if (marketingGa4State.inFlight) {
      renderMarketingGa4Panel();
      return marketingGa4State.inFlight;
    }

    marketingGa4State.orgId = orgId;
    marketingGa4State.loading = true;
    marketingGa4State.loaded = false;
    marketingGa4State.error = '';
    marketingGa4State.data = null;
    renderMarketingGa4Panel();

    marketingGa4State.inFlight = (async function () {
      try {
        var sessRes = await supabase.auth.getSession();
        var sess = sessRes && sessRes.data ? sessRes.data.session : null;
        if (!sess || !sess.access_token) {
          marketingGa4State.error = 'Sign in to load analytics.';
          return;
        }
        var res = await supabase.functions.invoke('marketing-ga4', {
          body: { organizationId: orgId },
          headers: { Authorization: 'Bearer ' + sess.access_token },
        });
        if (res.error) {
          marketingGa4State.error = res.error.message || 'Failed to load GA4 analytics.';
          return;
        }
        marketingGa4State.data = res.data || null;
      } catch (err) {
        marketingGa4State.error = String(err && err.message ? err.message : err || 'Failed to load GA4 analytics.');
      } finally {
        marketingGa4State.loading = false;
        marketingGa4State.loaded = true;
        marketingGa4State.inFlight = null;
        renderMarketingGa4Panel();
      }
    })();

    return marketingGa4State.inFlight;
  }

  function renderMarketing() {
    var empty = $('campaigns-empty');
    var pipe = $('marketing-pipeline');
    if (!empty || !pipe) return;

    var activePipeline = campaigns.filter(function (c) {
      return (c.status || CAMPAIGN_STATUS_PIPELINE) === CAMPAIGN_STATUS_PIPELINE;
    });

    if (!campaigns.length) {
      empty.style.display = 'block';
      empty.textContent = 'No campaigns yet. Use + New Campaign to add one.';
      pipe.style.display = 'none';
      pipe.innerHTML = '';
    } else {
      empty.style.display = 'none';
      pipe.style.display = 'flex';
      if (!activePipeline.length) {
        pipe.innerHTML = '<div style="font-size:13px;color:var(--text3);line-height:1.5;padding:8px 0;">No active pipeline. Won or lost campaigns are hidden here—edit a campaign and set status to Pipeline to show it, or add a new campaign.</div>';
      } else {
        pipe.innerHTML = activePipeline.slice().sort(function (a, b) {
          return (b.startDate || '').localeCompare(a.startDate || '');
        }).map(function (c) {
          var val = fmtCurrency(c.pipelineValue || 0);
          return '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg2);">' +
            '<div style="min-width:0;">' +
            '<div style="font-weight:600;font-size:14px;">' + esc(c.name || 'Untitled') + '</div>' +
            '<div style="font-size:12px;color:var(--text2);margin-top:4px;">' + esc(c.channel || '—') + ' · ' + esc(c.startDate || '—') + '</div>' +
            '<div style="font-size:12px;color:var(--text);margin-top:6px;font-weight:500;">' + val + ' pipeline</div>' +
            (c.notes ? '<div style="font-size:12px;color:var(--text3);margin-top:6px;">' + esc(c.notes) + '</div>' : '') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end;">' +
            '<button type="button" class="btn" data-campaign-edit="' + esc(c.id) + '">Edit</button>' +
            '<button type="button" class="btn" data-campaign-del="' + esc(c.id) + '" style="color:var(--red);">Delete</button>' +
            '</div></div>';
        }).join('');
      }
    }

    var now = new Date();
    var monthKey = now.getFullYear() + '-' + now.getMonth();
    var startedThisMonth = campaigns.filter(function (c) {
      if (!c.startDate) return false;
      var d = new Date(c.startDate + 'T12:00:00');
      if (isNaN(d.getTime())) return false;
      return d.getFullYear() + '-' + d.getMonth() === monthKey;
    }).length;
    setText('mkt-kpi-1', String(startedThisMonth));

    var won = campaigns.filter(function (c) { return c.status === CAMPAIGN_STATUS_WON; }).length;
    var lost = campaigns.filter(function (c) { return c.status === CAMPAIGN_STATUS_LOST; }).length;
    var closed = won + lost;
    if (closed < 1) {
      setText('mkt-kpi-2', '—');
    } else {
      setText('mkt-kpi-2', Math.round(won / closed * 100) + '%');
    }

    var pipeSum = activePipeline.reduce(function (acc, c) {
      return acc + (Number(c.pipelineValue) || 0);
    }, 0);
    setText('mkt-kpi-3', fmtCurrency(pipeSum));

    renderLeadSourcesChart(activePipeline);
    renderMarketingGa4Panel();
    loadMarketingGa4();
  }

  function openCampaignModal(editId) {
    var m = $('campaignModal');
    if (!m) return;
    var hid = $('campaign-edit-id');
    if (hid) hid.value = editId || '';
    var titleEl = $('campaign-modal-title');
    if (editId) {
      var camp = campaigns.find(function (c) { return c.id === editId; });
      if (!camp) return;
      if (titleEl) titleEl.textContent = 'Edit campaign';
      if ($('campaign-name')) $('campaign-name').value = camp.name || '';
      if ($('campaign-channel')) $('campaign-channel').value = camp.channel || '';
      if ($('campaign-start')) $('campaign-start').value = camp.startDate || todayISO();
      if ($('campaign-pipeline-value')) $('campaign-pipeline-value').value = camp.pipelineValue != null ? String(camp.pipelineValue) : '';
      if ($('campaign-status')) $('campaign-status').value = camp.status || CAMPAIGN_STATUS_PIPELINE;
      if ($('campaign-notes')) $('campaign-notes').value = camp.notes || '';
    } else {
      if (titleEl) titleEl.textContent = 'New campaign';
      if ($('campaign-name')) $('campaign-name').value = '';
      if ($('campaign-channel')) $('campaign-channel').value = '';
      if ($('campaign-start')) $('campaign-start').value = todayISO();
      if ($('campaign-pipeline-value')) $('campaign-pipeline-value').value = '';
      if ($('campaign-status')) $('campaign-status').value = CAMPAIGN_STATUS_PIPELINE;
      if ($('campaign-notes')) $('campaign-notes').value = '';
    }
    m.classList.add('on');
  }

  function closeCampaignModal() {
    var m = $('campaignModal');
    if (m) m.classList.remove('on');
    var hid = $('campaign-edit-id');
    if (hid) hid.value = '';
  }

  function wireMarketingCampaign() {
    var btn = $('btn-new-campaign');
    var modal = $('campaignModal');
    var btnCancel = $('btn-campaign-cancel');
    var btnSave = $('btn-campaign-save');
    if (btn) btn.addEventListener('click', function () { openCampaignModal(''); });
    if (btnCancel) btnCancel.addEventListener('click', closeCampaignModal);
    if (btnSave) {
      btnSave.addEventListener('click', async function () {
        var name = ($('campaign-name') && $('campaign-name').value || '').trim();
        if (!name) {
          alert('Campaign name is required.');
          return;
        }
        var channel = ($('campaign-channel') && $('campaign-channel').value || '').trim();
        var startDate = ($('campaign-start') && $('campaign-start').value) || todayISO();
        var notes = ($('campaign-notes') && $('campaign-notes').value || '').trim();
        var pipelineVal = Math.max(0, parseFloat(($('campaign-pipeline-value') && $('campaign-pipeline-value').value) || '0') || 0);
        var statusRaw = ($('campaign-status') && $('campaign-status').value) || CAMPAIGN_STATUS_PIPELINE;
        var status = [CAMPAIGN_STATUS_PIPELINE, CAMPAIGN_STATUS_WON, CAMPAIGN_STATUS_LOST].indexOf(statusRaw) === -1
          ? CAMPAIGN_STATUS_PIPELINE
          : statusRaw;
        var existingId = ($('campaign-edit-id') && $('campaign-edit-id').value) || '';
        var savedCampaign = null;
        if (existingId) {
          campaigns = campaigns.map(function (c) {
            if (c.id !== existingId) return c;
            return normalizeCampaign({
              id: c.id,
              name: name,
              channel: channel,
              startDate: startDate,
              notes: notes,
              pipelineValue: pipelineVal,
              status: status,
              createdAt: c.createdAt || Date.now(),
            });
          });
          savedCampaign = campaigns.find(function (c) { return c.id === existingId; }) || null;
        } else {
          var newCamp = normalizeCampaign({
            id: uuid(),
            name: name,
            channel: channel,
            startDate: startDate,
            notes: notes,
            pipelineValue: pipelineVal,
            status: status,
            createdAt: Date.now(),
          });
          campaigns.push(newCamp);
          savedCampaign = newCamp;
        }
        saveCampaigns(campaigns);
        if (savedCampaign) persistCampaignToSupabase(savedCampaign);
        closeCampaignModal();
        renderMarketing();
      });
    }
    if (modal) {
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) closeCampaignModal();
      });
    }
  }

  function openCaseStudyViewModal(projectId) {
    var p = projects.find(function (x) { return x.id === projectId; });
    var modal = $('caseStudyViewModal');
    var body = $('case-study-view-body');
    if (!p || !modal || !body) return;
    var client = p.clientId ? clients.find(function (c) { return c.id === p.clientId; }) : null;
    var clientName = client && client.companyName ? client.companyName : '—';
    var industry = client && client.industry ? client.industry : '—';
    var period = '—';
    if (p.startDate || p.dueDate) {
      period = (p.startDate ? fmtDateDisplay(p.startDate) : '…') + ' – ' + (p.dueDate ? fmtDateDisplay(p.dueDate) : '…');
    }
    var pubBadge = p.caseStudyPublished
      ? '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:rgba(34,197,94,0.15);color:#15803d;font-size:12px;font-weight:600;">Published</span>'
      : '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:var(--bg2);color:var(--text3);font-size:12px;font-weight:600;">Draft</span>';

    var strategyHtml = '';
    (p.caseStudyStrategy || []).forEach(function (item) {
      if (!item || (!String(item.title || '').trim() && !String(item.body || '').trim())) return;
      strategyHtml += '<div style="margin-bottom:14px;">';
      if (String(item.title || '').trim()) {
        strategyHtml += '<div style="font-weight:700;margin-bottom:4px;">' + esc(item.title) + '</div>';
      }
      if (String(item.body || '').trim()) {
        strategyHtml += '<div style="color:var(--text2);white-space:pre-wrap;">' + esc(item.body) + '</div>';
      }
      strategyHtml += '</div>';
    });

    var results = Array.isArray(p.caseStudyResults) ? p.caseStudyResults : [];
    var resultsHtml = '';
    if (results.length) {
      resultsHtml = '<ul style="margin:0;padding-left:1.25em;">' + results.map(function (r) {
        return '<li style="margin-bottom:6px;">' + esc(String(r)) + '</li>';
      }).join('') + '</ul>';
    }

    var cat = (p.caseStudyCategory || '').trim();
    var challenge = (p.caseStudyChallenge || '').trim();

    body.innerHTML =
      '<div style="margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid var(--border);">' +
        '<div style="font-size:20px;font-weight:700;margin-bottom:8px;">' + esc(p.name || 'Project') + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;color:var(--text2);">' +
          '<div><strong style="color:var(--text);">Client</strong> ' + esc(clientName) + '</div>' +
          '<div><strong style="color:var(--text);">Industry</strong> ' + esc(industry) + '</div>' +
          '<div><strong style="color:var(--text);">Work period</strong> ' + esc(period) + '</div>' +
          (p.type ? '<div><strong style="color:var(--text);">Project type</strong> ' + esc(p.type) + '</div>' : '') +
        '</div>' +
        '<div style="margin-top:10px;">' + pubBadge + '</div>' +
      '</div>' +
      (cat ? '<div style="margin-bottom:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:4px;">Case study category</div><div>' + esc(cat) + '</div></div>' : '') +
      (challenge ? '<div style="margin-bottom:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:6px;">The challenge</div><div style="white-space:pre-wrap;color:var(--text2);">' + esc(challenge) + '</div></div>' : '') +
      (strategyHtml ? '<div style="margin-bottom:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:8px;">Our strategy</div>' + strategyHtml + '</div>' : '') +
      (resultsHtml ? '<div style="margin-bottom:8px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:8px;">The results</div>' + resultsHtml + '</div>' : '') +
      (!cat && !challenge && !strategyHtml && !resultsHtml ? '<div style="color:var(--text3);font-size:13px;">No case study copy yet. Use Edit to add challenge, strategy, and results.</div>' : '');

    modal.classList.add('on');
  }

  function closeCaseStudyViewModal() {
    var modal = $('caseStudyViewModal');
    if (modal) modal.classList.remove('on');
  }

  // ---------- Projects rendering ----------

  function renderProjects() {
    var tbody = $('projects-tbody');
    var empty = $('projects-empty');
    var table = $('projects-table');
    if (!tbody) return;

    if (!projects.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
    } else {
      if (empty) empty.style.display = 'none';
      if (table) table.style.display = 'table';
      tbody.innerHTML = projects.map(function (p) {
        var client = clients.find(function (c) { return c.id === p.clientId; });
        var clientName = client ? client.companyName : '—';
        var canView = projectHasCaseStudyViewable(p);
        var pubLabel = p.caseStudyPublished ? 'Yes' : 'No';
        var csCell = '<div style="font-size:12px;line-height:1.4;">' +
          '<div><span style="color:var(--text3);">Pub.</span> <strong>' + pubLabel + '</strong></div>';
        if (canView) {
          csCell += '<button type="button" class="btn" data-project-casestudy="' + esc(p.id) + '" style="margin-top:6px;">View</button>';
        } else {
          csCell += '<div style="margin-top:4px;color:var(--text3);">—</div>';
        }
        csCell += '</div>';
        return '<tr>' +
          '<td class="tdp">' + (p.name || 'Untitled') + '</td>' +
          '<td>' + clientName + '</td>' +
          '<td>' + (p.type || '—') + '</td>' +
          '<td>' + (p.description || '—') + '</td>' +
          '<td>' + (p.dueDate || '—') + '</td>' +
          '<td>' + fmtCurrency(p.value || 0) + '</td>' +
          '<td style="min-width:140px;">' +
            '<select class="fi project-row-status" data-project-status-id="' + esc(p.id) + '" ' +
            'style="width:100%;max-width:200px;box-sizing:border-box;">' +
            buildProjectRowStatusOptionsHtml(p.status) +
            '</select></td>' +
          '<td style="vertical-align:top;">' + csCell + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button type="button" class="btn" data-project-edit="' + p.id + '" style="margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-project-del="' + p.id + '" style="color:var(--red);">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    // Simple KPIs and charts based on projects array
    renderProjectKpisAndCharts();
  }

  // ---------- Income (revenue page) ----------

  function incomeRuleOptionsForColumn(colId) {
    if (colId === 'amount') return ['eq', 'gt', 'gte', 'lt', 'lte', 'between'];
    if (colId === 'date') return ['on', 'after', 'before', 'between'];
    if (colId === 'category' || colId === 'invoice') return ['is', 'not'];
    return ['contains', 'is', 'starts'];
  }

  function incomeCellRaw(row, colId) {
    if (colId === 'amount') return Number(row.amount || 0);
    return row[colId] == null ? '' : String(row[colId]);
  }

  function incomeMatchesRule(row, rule) {
    if (!rule || !rule.column || !rule.op) return true;
    var v = incomeCellRaw(row, rule.column);
    var q = String(rule.value == null ? '' : rule.value).trim();
    var q2 = String(rule.value2 == null ? '' : rule.value2).trim();
    if (!q && rule.op !== 'between') return true;
    if (rule.column === 'amount') {
      var n = Number(v || 0);
      var a = Number(q || 0);
      var b = Number(q2 || 0);
      if (rule.op === 'eq') return n === a;
      if (rule.op === 'gt') return n > a;
      if (rule.op === 'gte') return n >= a;
      if (rule.op === 'lt') return n < a;
      if (rule.op === 'lte') return n <= a;
      if (rule.op === 'between') return n >= Math.min(a, b) && n <= Math.max(a, b);
      return true;
    }
    var sv = String(v || '').toLowerCase();
    var sq = q.toLowerCase();
    if (rule.column === 'date') {
      if (rule.op === 'on') return sv === sq;
      if (rule.op === 'after') return sv >= sq;
      if (rule.op === 'before') return sv <= sq;
      if (rule.op === 'between') {
        var a2 = q.toLowerCase();
        var b2 = q2.toLowerCase();
        if (!a2 || !b2) return true;
        var lo = a2 < b2 ? a2 : b2;
        var hi = a2 < b2 ? b2 : a2;
        return sv >= lo && sv <= hi;
      }
      return true;
    }
    if (rule.op === 'contains') return sv.indexOf(sq) !== -1;
    if (rule.op === 'starts') return sv.indexOf(sq) === 0;
    if (rule.op === 'is') return sv === sq;
    if (rule.op === 'not') return sv !== sq;
    return true;
  }

  function exportIncomeRowsCsv(rows, onlySelected) {
    if (!rows || !rows.length) {
      alert('No rows to export.');
      return;
    }
    var out = ['Date,Source,Client,Project,Category,Amount,Invoice status'];
    rows.forEach(function (r) {
      out.push(
        '"' + String(r.date || '').replace(/"/g, '""') + '",' +
        '"' + String(r.source || '').replace(/"/g, '""') + '",' +
        '"' + String(r.client || '').replace(/"/g, '""') + '",' +
        '"' + String(r.project || '').replace(/"/g, '""') + '",' +
        '"' + String(r.category || '').replace(/"/g, '""') + '",' +
        Number(r.amount || 0) + ',' +
        '"' + String(r.invoice || '').replace(/"/g, '""') + '"'
      );
    });
    var blob = new Blob([out.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = onlySelected ? 'income-selected.csv' : 'income-filtered.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderIncomeSection(c) {
    // Revenue-only transactions, respecting current date filter (c.txs already filtered).
    var revTxs = c.txs.filter(function (tx) {
      return tx.category === 'svc' || tx.category === 'ret';
    });

    var now = new Date();
    var thisMonthKey = now.getFullYear() + '-' + now.getMonth();

    var collectedThisMonth = 0;

    // Group by month for Revenue Trend
    var revByMonth = {};
    var revMonthLatestTxDate = {};

    revTxs.forEach(function (tx) {
      var d = parseDate(tx.date);
      if (!d) return;
      var key = d.getFullYear() + '-' + d.getMonth();
      revByMonth[key] = (revByMonth[key] || 0) + (+tx.amount || 0);
      var ds = (tx.date || '').trim();
      if (ds && (!revMonthLatestTxDate[key] || ds > revMonthLatestTxDate[key])) {
        revMonthLatestTxDate[key] = ds;
      }
      if (key === thisMonthKey) {
        collectedThisMonth += (+tx.amount || 0);
      }
    });

    var invoiceForTx = {};
    revTxs.forEach(function (tx) {
      var inv = getInvoiceByIncomeTxId(tx.id);
      if (inv) invoiceForTx[tx.id] = inv;
    });

    // Outstanding + AR aging from invoices not marked paid
    var nowTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var bucketCurrent = 0;
    var bucket31 = 0;
    var bucket61 = 0;
    var bucket90 = 0;
    var outstandingTotal = 0;
    var sentCount = 0;
    var paidLagDays = 0;
    var paidCount = 0;

    invoices.forEach(function (inv) {
      var amt = +inv.amount || 0;
      if (amt <= 0) return;
      if (inv.status === 'sent' || inv.status === 'paid') sentCount += 1;

      if (inv.status === 'paid') {
        if (inv.paidAt && inv.dateIssued) {
          var paidAt = new Date(inv.paidAt).getTime();
          var issuedAt = new Date(inv.dateIssued).getTime();
          if (!isNaN(paidAt) && !isNaN(issuedAt) && paidAt >= issuedAt) {
            paidLagDays += Math.round((paidAt - issuedAt) / (1000 * 60 * 60 * 24));
            paidCount += 1;
          }
        }
        return;
      }

      outstandingTotal += amt;
      var dueTs = inv.dueDate ? new Date(inv.dueDate).getTime() : nowTs;
      if (isNaN(dueTs)) dueTs = nowTs;
      var daysOverdue = Math.max(0, Math.floor((nowTs - dueTs) / (1000 * 60 * 60 * 24)));
      if (daysOverdue <= 30) bucketCurrent += amt;
      else if (daysOverdue <= 60) bucket31 += amt;
      else if (daysOverdue <= 90) bucket61 += amt;
      else bucket90 += amt;
    });

    var avgDaysToPay = paidCount ? Math.round(paidLagDays / paidCount) : null;

    // KPIs
    setText('rev-kpi-1', fmtCurrency(collectedThisMonth));
    setText('rev-kpi-2', fmtCurrency(outstandingTotal));
    setText('rev-kpi-3', String(sentCount));
    setText('rev-kpi-4', avgDaysToPay == null ? '—' : String(avgDaysToPay));

    // AR section values + bars
    setText('ar-current-amt', fmtCurrency(bucketCurrent));
    setText('ar-31-60-amt', fmtCurrency(bucket31));
    setText('ar-61-90-amt', fmtCurrency(bucket61));
    setText('ar-90-plus-amt', fmtCurrency(bucket90));
    setText('ar-total-outstanding', fmtCurrency(outstandingTotal));
    var denom = outstandingTotal > 0 ? outstandingTotal : 1;
    var barCurrent = $('ar-current-bar');
    var bar31 = $('ar-31-60-bar');
    var bar61 = $('ar-61-90-bar');
    var bar90 = $('ar-90-plus-bar');
    if (barCurrent) barCurrent.style.width = Math.round((bucketCurrent / denom) * 100) + '%';
    if (bar31) bar31.style.width = Math.round((bucket31 / denom) * 100) + '%';
    if (bar61) bar61.style.width = Math.round((bucket61 / denom) * 100) + '%';
    if (bar90) bar90.style.width = Math.round((bucket90 / denom) * 100) + '%';

    // Income entries table (power-table view: column chooser, filters, bulk actions, export)
    var tbody = $('income-tbody');
    var thead = $('income-thead');
    var empty = $('income-empty');
    var table = $('income-table');
    var meta = $('income-power-meta');
    if (tbody) {
      var sourceRows = revTxs.slice().sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      }).map(function (tx) {
        var cl = tx.clientId ? clients.find(function (c2) { return c2.id === tx.clientId; }) : null;
        var pr = tx.projectId ? projects.find(function (p2) { return p2.id === tx.projectId; }) : null;
        var inv2 = invoiceForTx[tx.id] || null;
        return {
          tx: tx,
          id: tx.id,
          date: tx.date || '—',
          source: tx.description || '—',
          client: (cl && cl.companyName) || '—',
          project: (pr && pr.name) || '—',
          category: displayIncomeCategory(tx),
          amount: Number(tx.amount || 0),
          invoice: inv2 ? (inv2.status === 'paid' ? 'Paid' : 'Sent') : 'No invoice',
          invoiceObj: inv2,
        };
      });
      var sourceIdMap = {};
      sourceRows.forEach(function (r) { sourceIdMap[r.id] = true; });
      Object.keys(incomePowerState.selected || {}).forEach(function (sid) {
        if (!sourceIdMap[sid]) delete incomePowerState.selected[sid];
      });
      var q = String(incomePowerState.search || '').trim().toLowerCase();
      var filteredRows = sourceRows.filter(function (row) {
        var textHit = true;
        if (q) {
          var hay = [row.date, row.source, row.client, row.project, row.category, row.invoice]
            .join(' ')
            .toLowerCase();
          textHit = hay.indexOf(q) !== -1;
        }
        if (!textHit) return false;
        return (incomePowerState.filters || []).every(function (rule) {
          return incomeMatchesRule(row, rule);
        });
      });
      if (meta) {
        var selCount = Object.keys(incomePowerState.selected || {}).filter(function (id) { return incomePowerState.selected[id]; }).length;
        meta.textContent = filteredRows.length + ' rows' + (selCount ? ' · ' + selCount + ' selected' : '');
      }
      if (!filteredRows.length) {
        tbody.innerHTML = '';
        if (thead) thead.innerHTML = '<tr><th class="selcol"><input type="checkbox" disabled /></th><th>Results</th><th>Actions</th></tr>';
        if (empty) empty.style.display = 'block';
        if (table) table.style.display = 'none';
      } else {
        if (empty) empty.style.display = 'none';
        if (table) table.style.display = 'table';
        var visibleCols = incomePowerColumns.filter(function (col) { return incomePowerState.visible[col.id] !== false; });
        var allSelected = filteredRows.length > 0 && filteredRows.every(function (r) { return !!incomePowerState.selected[r.id]; });
        if (thead) {
          thead.innerHTML = '<tr>' +
            '<th class="selcol"><input type="checkbox" id="income-power-select-all"' + (allSelected ? ' checked' : '') + ' /></th>' +
            visibleCols.map(function (col) { return '<th>' + esc(col.label) + '</th>'; }).join('') +
            '<th style="width:360px;">Actions</th>' +
            '</tr>';
        }
        tbody.innerHTML = filteredRows.map(function (row) {
          var tx = row.tx;
          var inv = row.invoiceObj;
          var invBadge = inv
            ? ('<span class="pl ' + (inv.status === 'paid' ? 'pg-g' : 'pg-a') + '" style="margin-right:6px;">' + (inv.status === 'paid' ? 'Paid' : 'Sent') + '</span>')
            : '<span class="pl" style="margin-right:6px;background:var(--bg3);color:var(--text3);">No invoice</span>';
          var colCells = visibleCols.map(function (col) {
            if (col.id === 'amount') return '<td class="tdp">' + fmtCurrency(row.amount) + '</td>';
            return '<td>' + esc(row[col.id]) + '</td>';
          }).join('');
          return '<tr>' +
            '<td class="selcol"><input type="checkbox" data-income-select="' + esc(row.id) + '"' + (incomePowerState.selected[row.id] ? ' checked' : '') + ' /></td>' +
            colCells +
            '<td style="white-space:nowrap;">' +
              invBadge +
              (inv
                ? '<button type="button" class="btn" data-income-invoice-edit="' + tx.id + '" style="margin-right:6px;">Edit invoice</button>'
                : '<button type="button" class="btn" data-income-invoice-create="' + tx.id + '" style="margin-right:6px;">Create invoice</button>') +
              (inv ? '<button type="button" class="btn" data-income-invoice-view="' + tx.id + '" style="margin-right:6px;">View invoice</button>' : '') +
              (inv && inv.status !== 'paid' ? '<button type="button" class="btn btn-p" data-income-invoice-pay="' + tx.id + '" style="margin-right:6px;">Pay now</button>' : '') +
              (inv && inv.status !== 'paid' ? '<button type="button" class="btn" data-income-invoice-paid="' + tx.id + '" style="margin-right:6px;">Mark received</button>' : '') +
              '<button type="button" class="btn" data-income-edit="' + tx.id + '" style="margin-right:6px;">Edit</button>' +
              '<button type="button" class="btn" data-income-del="' + tx.id + '" style="color:var(--red);">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('');
      }
      window.__incomePowerFilteredRows = filteredRows;
    }

    // Revenue Trend chart (cRevT)
    var canvas = document.getElementById('cRevT');
    if (canvas && window.Chart) {
      var rangeMode = incomeTrendRange || '90d';
      var hint = $('rev-trend-hint');
      if (hint) {
        hint.textContent = rangeMode === '30d'
          ? 'Past month'
          : (rangeMode === 'ytd' ? 'Year to date' : (rangeMode === 'all' ? 'All time' : 'Last 90 days'));
      }
      var rangeSel = $('rev-trend-range');
      if (rangeSel) rangeSel.value = rangeMode;

      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
      var cutoff = null;
      if (rangeMode === '30d') cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30, 12, 0, 0, 0);
      if (rangeMode === '90d') cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90, 12, 0, 0, 0);
      if (rangeMode === 'ytd') cutoff = new Date(today.getFullYear(), 0, 1, 12, 0, 0, 0);

      var labels = [];
      var data = [];
      if (rangeMode === 'all') {
        // Keep all-time readable by aggregating to month.
        var chartRevByMonth = {};
        var chartMonthLatestTxDate = {};
        revTxs.forEach(function (tx) {
          var d = parseDate(tx.date);
          if (!d) return;
          var key = d.getFullYear() + '-' + d.getMonth();
          chartRevByMonth[key] = (chartRevByMonth[key] || 0) + (+tx.amount || 0);
          var ds = (tx.date || '').trim();
          if (ds && (!chartMonthLatestTxDate[key] || ds > chartMonthLatestTxDate[key])) {
            chartMonthLatestTxDate[key] = ds;
          }
        });
        var monthKeys = Object.keys(chartRevByMonth);
        if (monthKeys.length) {
          monthKeys.sort(function (a, b) {
            var pa = a.split('-').map(Number);
            var pb = b.split('-').map(Number);
            if (pa[0] !== pb[0]) return pa[0] - pb[0];
            return pa[1] - pb[1];
          });
        }
        labels = monthKeys.map(function (key) {
          var parts = key.split('-').map(Number);
          var y = parts[0];
          var m0 = parts[1];
          return chartPointDateLabel(chartMonthLatestTxDate[key], y, m0);
        });
        data = monthKeys.map(function (k) { return chartRevByMonth[k] || 0; });
      } else {
        // For 30d/90d views, show daily totals so entries don't collapse into one monthly point.
        var chartRevByDay = {};
        revTxs.forEach(function (tx) {
          var d = parseDate(tx.date);
          if (!d) return;
          if (cutoff && d < cutoff) return;
          var dayKey = (tx.date || '').slice(0, 10);
          if (!dayKey) return;
          chartRevByDay[dayKey] = (chartRevByDay[dayKey] || 0) + (+tx.amount || 0);
        });
        var dayKeys = Object.keys(chartRevByDay).sort();
        labels = dayKeys.map(function (key) {
          var dd = parseYMD(key);
          if (isNaN(dd.getTime())) return key;
          return dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        data = dayKeys.map(function (k) { return chartRevByDay[k] || 0; });
      }

      if (revTrendChart && revTrendChart.config && revTrendChart.config.type !== 'line') {
        revTrendChart.destroy();
        revTrendChart = null;
      }

      if (!revTrendChart) {
        revTrendChart = new Chart(canvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Revenue',
              data: data,
              borderColor: CHART_ORANGE,
              backgroundColor: CHART_ORANGE_FILL,
              borderWidth: 2,
              fill: true,
              tension: 0.35,
              pointBackgroundColor: CHART_ORANGE,
              pointBorderColor: '#ffffff',
              pointBorderWidth: 2,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointHoverBackgroundColor: CHART_ORANGE,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
              legend: { display: false },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: CHART_TICK, font: { size: 11 } },
              },
              y: {
                beginAtZero: true,
                grid: { color: CHART_GRID },
                ticks: {
                  color: CHART_TICK,
                  font: { size: 11 },
                  callback: function (v) { return '$' + v.toLocaleString(); },
                },
              },
            },
          },
        });
      } else {
        revTrendChart.data.labels = labels;
        revTrendChart.data.datasets[0].data = data;
        syncBrandedRevenueLineDataset(revTrendChart.data.datasets[0]);
        revTrendChart.update('none');
      }
    }
  }

  function renderProjectKpisAndCharts() {
    var totalDelivered = 0;
    var byType = {};
    var byMonth = {};
    var deliverMonthLatestDue = {};
    var totalDurationDays = 0;
    var durationCount = 0;
    var onTimeCount = 0;
    var completedCount = 0;
    var totalSatisfaction = 0;
    var satCount = 0;

    projects.forEach(function (p) {
      var status = (p.status || '').toLowerCase();
      var t = (p.type || 'Other').trim() || 'Other';
      byType[t] = (byType[t] || 0) + 1;

      var due = p.dueDate ? new Date(p.dueDate) : null;
      var start = p.startDate ? new Date(p.startDate) : null;
      if (due && !isNaN(due)) {
        var key = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0');
        byMonth[key] = (byMonth[key] || 0) + 1;
        var dueStr = (p.dueDate || '').trim();
        if (dueStr && (!deliverMonthLatestDue[key] || dueStr > deliverMonthLatestDue[key])) {
          deliverMonthLatestDue[key] = dueStr;
        }
      }

      if (status.indexOf('complete') !== -1) {
        completedCount += 1;
        totalDelivered += 1;
        if (start && !isNaN(start) && due && !isNaN(due)) {
          var days = Math.max(1, Math.round((due - start) / (1000 * 60 * 60 * 24)));
          totalDurationDays += days;
          durationCount += 1;
        }
        // For now treat all completed projects as on-time (no explicit actual completion date field)
        onTimeCount += 1;
      }

      if (typeof p.satisfaction === 'number') {
        totalSatisfaction += p.satisfaction;
        satCount += 1;
      }
    });

    // KPIs
    setText('perf-kpi-1', String(totalDelivered));

    var onTimeRate = completedCount ? Math.round((onTimeCount / completedCount) * 100) : null;
    setText('perf-kpi-2', onTimeRate == null ? '—' : onTimeRate + '%');

    var avgDuration = durationCount ? Math.round(totalDurationDays / durationCount) : null;
    setText('perf-kpi-3', avgDuration == null ? '—' : avgDuration + ' days');

    var avgSat = satCount ? Math.round(totalSatisfaction / satCount) : null;
    setText('perf-kpi-4', avgSat == null ? '—' : avgSat + '/10');

    // Projects by Service Type chart (cSvc)
    var svcCanvas = document.getElementById('cSvc');
    if (svcCanvas && window.Chart) {
      var typeLabels = Object.keys(byType);
      var typeCounts = typeLabels.map(function (k) { return byType[k]; });
      var projLbls = typeLabels.length ? typeLabels : ['No projects'];
      var projData = typeLabels.length ? typeCounts : [1];
      var projBg = typeLabels.length ? chartMultiColors(projLbls.length) : [CHART_EMPTY];
      if (!projTypeChart) {
        projTypeChart = new Chart(svcCanvas, {
          type: 'doughnut',
          data: {
            labels: projLbls,
            datasets: [{
              data: projData,
              backgroundColor: projBg,
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: { legend: { display: true, position: 'bottom' } },
          },
        });
      } else {
        projTypeChart.data.labels = projLbls;
        projTypeChart.data.datasets[0].data = projData;
        projTypeChart.data.datasets[0].backgroundColor = projBg;
        projTypeChart.update('none');
      }
    }

    // Monthly Deliverables chart (cDel)
    var delCanvas = document.getElementById('cDel');
    if (delCanvas && window.Chart) {
      var monthKeys = Object.keys(byMonth);
      if (monthKeys.length) {
        monthKeys.sort();
        if (monthKeys.length > 6) {
          monthKeys = monthKeys.slice(monthKeys.length - 6);
        }
      }
      var monthLabels = monthKeys.map(function (key) {
        var parts = key.split('-').map(Number);
        var y = parts[0];
        var m1 = parts[1];
        return chartPointDateLabel(deliverMonthLatestDue[key], y, m1 - 1);
      });
      var monthCounts = monthKeys.map(function (k) { return byMonth[k] || 0; });

      if (!projMonthlyChart) {
        projMonthlyChart = new Chart(delCanvas, {
          type: 'bar',
          data: {
            labels: monthLabels,
            datasets: [{
              label: 'Deliverables',
              data: monthCounts,
              backgroundColor: CHART_ORANGE,
              borderRadius: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: CHART_TICK, font: { size: 11 } },
              },
              y: {
                grid: { color: CHART_GRID },
                ticks: {
                  color: CHART_TICK,
                  font: { size: 11 },
                  precision: 0,
                },
              },
            },
          },
        });
      } else {
        projMonthlyChart.data.labels = monthLabels;
        projMonthlyChart.data.datasets[0].data = monthCounts;
        projMonthlyChart.data.datasets[0].backgroundColor = CHART_ORANGE;
        projMonthlyChart.update('none');
      }
    }
  }

  // ---------- Clients rendering ----------

  /** Sum of recorded income (svc + ret) for a client from transactions (source of truth for this app). */
  function clientRevenueFromTransactions(clientId) {
    if (!clientId) return 0;
    var sum = 0;
    (state.transactions || []).forEach(function (tx) {
      if (tx.clientId !== clientId) return;
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = +tx.amount || 0;
      if (amt > 0) sum += amt;
    });
    return sum;
  }

  /** Sum of lab/sw/ads/oth tagged to this client (all-time). */
  function clientAllocatedCostFromTransactions(clientId) {
    if (!clientId) return 0;
    var sum = 0;
    (state.transactions || []).forEach(function (tx) {
      if (tx.clientId !== clientId) return;
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
      var amt = +tx.amount || 0;
      if (amt > 0) sum += amt;
    });
    return sum;
  }

  /** Revenue shown on Customers tab: optional manual amount, else sum of linked income. */
  function effectiveClientRevenue(c) {
    if (!c || !c.id) return 0;
    if (c.custTabRevenue != null && isFinite(Number(c.custTabRevenue))) return Math.max(0, Number(c.custTabRevenue));
    return clientRevenueFromTransactions(c.id);
  }

  /** Allocated cost on Customers tab: optional manual amount, else sum of linked expenses. */
  function effectiveClientAllocatedCost(c) {
    if (!c || !c.id) return 0;
    if (c.custTabAllocatedCost != null && isFinite(Number(c.custTabAllocatedCost))) {
      return Math.max(0, Number(c.custTabAllocatedCost));
    }
    return clientAllocatedCostFromTransactions(c.id);
  }

  function clientCompanyNameById(clientId) {
    if (!clientId) return '';
    var c = clients.find(function (x) { return x.id === clientId; });
    return c ? (c.companyName || 'Untitled client') : '';
  }

  function fmtProfitMarginRoi(revenue, cost) {
    var rev = +revenue || 0;
    var cst = +cost || 0;
    var profit = rev - cst;
    var marginStr = rev > 0 ? (profit / rev * 100).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + '%' : '—';
    var roiStr = cst > 0 ? (profit / cst * 100).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + '%' : '—';
    return { profit: profit, marginStr: marginStr, roiStr: roiStr };
  }

  function clientProjectCount(clientId) {
    if (!clientId) return 0;
    return projects.filter(function (p) { return p.clientId === clientId; }).length;
  }

  function computeClientKpis() {
    var total = clients.length;
    var activeRetainers = clients.filter(clientIsRetainer).length;
    var totalRevenue = clients.reduce(function (sum, c) {
      return sum + effectiveClientRevenue(c);
    }, 0);
    var avgValue = total ? totalRevenue / total : 0;
    return {
      total: total,
      activeRetainers: activeRetainers,
      avgValue: avgValue,
    };
  }

  function applyCustomersColumnVisibility() {
    var table = $('customers-table');
    if (!table) return;
    CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
      var show = col.locked ? true : customersColumnPrefs[col.id] !== false;
      var selector = 'thead th:nth-child(' + col.index + '), tbody td:nth-child(' + col.index + ')';
      table.querySelectorAll(selector).forEach(function (cell) {
        cell.style.display = show ? '' : 'none';
      });
    });
  }

  function renderCustomersColumnsPanel() {
    var panel = $('customers-columns-panel');
    if (!panel) return;
    var optionsHtml = CUSTOMERS_COLUMN_DEFS.map(function (col) {
      var checked = col.locked || customersColumnPrefs[col.id] !== false;
      var disabled = col.locked ? ' disabled' : '';
      var label = esc(col.label) + (col.locked ? ' (required)' : '');
      return '<label class="customers-col-opt">' +
        '<input type="checkbox" data-customer-col="' + col.id + '"' + (checked ? ' checked' : '') + disabled + ' />' +
        '<span>' + label + '</span>' +
      '</label>';
    }).join('');
    panel.innerHTML = optionsHtml +
      '<div class="customers-col-actions">' +
        '<button type="button" class="btn" id="btn-customers-columns-reset">Reset columns</button>' +
      '</div>';
  }

  function wireCustomersColumnsPicker() {
    var btn = $('btn-customers-columns');
    var panel = $('customers-columns-panel');
    if (!btn || !panel) return;

    renderCustomersColumnsPanel();
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      panel.classList.toggle('on');
    });
    panel.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    panel.addEventListener('change', function (ev) {
      var input = ev.target;
      if (!input || !input.matches || !input.matches('input[data-customer-col]')) return;
      var colId = input.getAttribute('data-customer-col');
      if (!colId) return;
      var def = CUSTOMERS_COLUMN_DEFS.find(function (c) { return c.id === colId; });
      if (!def || def.locked) return;
      customersColumnPrefs[colId] = input.checked !== false;
      saveCustomersColumnPrefs(customersColumnPrefs);
      applyCustomersColumnVisibility();
    });
    panel.addEventListener('click', function (ev) {
      var resetBtn = ev.target.closest('#btn-customers-columns-reset');
      if (!resetBtn) return;
      customersColumnPrefs = defaultCustomersColumnPrefs();
      saveCustomersColumnPrefs(customersColumnPrefs);
      renderCustomersColumnsPanel();
      applyCustomersColumnVisibility();
    });
    document.addEventListener('click', function () {
      panel.classList.remove('on');
    });
  }

  function renderClients() {
    var tbody = $('customers-tbody');
    var empty = $('customers-empty');
    var table = $('customers-table');
    if (!tbody) return;

    if (!clients.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
    } else {
      if (empty) empty.style.display = 'none';
      if (table) table.style.display = 'table';
      tbody.innerHTML = clients.map(function (c) {
        var rev = effectiveClientRevenue(c);
        var cost = effectiveClientAllocatedCost(c);
        var pr = fmtProfitMarginRoi(rev, cost);
        var profitStyle = 'font-variant-numeric:tabular-nums;';
        if (pr.profit < 0) profitStyle += 'color:var(--red);';
        else if (pr.profit > 0) profitStyle += 'color:var(--green);';
        var pcount = clientProjectCount(c.id);
        var revTitle = c.custTabRevenue != null ? ' title="Custom revenue — edit client to change"' : '';
        var costTitle = c.custTabAllocatedCost != null ? ' title="Custom allocated cost — edit client to change"' : '';
        var companyText = c.companyName || '—';
        var contactText = c.contactName || '—';
        var emailText = c.email || '—';
        var phoneText = c.phone || '—';
        return '<tr>' +
          '<td class="tdp td-truncate" title="' + escAttr(companyText) + '">' + esc(companyText) + '</td>' +
          '<td class="td-truncate" title="' + escAttr(contactText) + '">' + esc(contactText) + '</td>' +
          '<td class="td-truncate" title="' + escAttr(emailText) + '">' + esc(emailText) + '</td>' +
          '<td class="td-truncate" title="' + escAttr(phoneText) + '">' + esc(phoneText) + '</td>' +
          '<td>' + esc(c.preferredChannel || '—') + '</td>' +
          '<td>' + esc(c.communicationStyle || '—') + '</td>' +
          '<td>' + esc(c.status || '—') +
            (clientIsRetainer(c) ? ' <span style="font-size:10px;font-weight:600;color:var(--coral);white-space:nowrap;">Retainer</span>' : '') +
          '</td>' +
          '<td>' + (pcount ? String(pcount) : '—') + '</td>' +
          '<td' + revTitle + ' style="font-variant-numeric:tabular-nums;">' + fmtCurrency(rev) + '</td>' +
          '<td' + costTitle + ' style="font-variant-numeric:tabular-nums;">' + fmtCurrency(cost) + '</td>' +
          '<td class="tdp" style="' + profitStyle + '">' + fmtCurrency(pr.profit) + '</td>' +
          '<td>' + pr.marginStr + '</td>' +
          '<td>' + pr.roiStr + '</td>' +
          '<td style="min-width:120px;">' +
            '<div style="display:flex;gap:6px;flex-wrap:nowrap;">' +
              '<button type="button" class="btn" data-client-edit="' + c.id + '">Edit</button>' +
              '<button type="button" class="btn" data-client-del="' + c.id + '" style="color:var(--red);">Delete</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('');
      applyCustomersColumnVisibility();
    }

    var k = computeClientKpis();
    setText('cust-kpi-1', String(k.total));
    setText('cust-kpi-2', String(k.activeRetainers));
    setText('cust-kpi-3', fmtCurrency(k.avgValue || 0));
  }

  function parseTimeInputToMinutes(raw) {
    var s = String(raw || '').trim();
    if (!s) return NaN;
    var m = s.match(/^(\d{1,2}):([0-5]\d)$/);
    if (!m) return NaN;
    var hh = parseInt(m[1], 10);
    var mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23) return NaN;
    return hh * 60 + mm;
  }

  function formatMinutesToHours(mins) {
    var n = Math.max(0, Number(mins) || 0);
    return (n / 60).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'h';
  }

  function startOfWeekMonday(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    var wd = x.getDay(); // Sun=0..Sat=6
    var delta = wd === 0 ? -6 : 1 - wd;
    x.setDate(x.getDate() + delta);
    return x;
  }

  function calendarQuarterFromDate(d) {
    var m = d.getMonth();
    return { year: d.getFullYear(), q: Math.floor(m / 3) + 1 };
  }

  function shiftMonthYm(ym, deltaMonths) {
    var y = parseInt((ym || '').slice(0, 4), 10);
    var m0 = parseInt((ym || '').slice(5, 7), 10) - 1 + deltaMonths;
    var dt = new Date(y, m0, 1, 12, 0, 0, 0);
    if (isNaN(dt.getTime())) return ym;
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
  }

  function shiftQuarter(year, q, deltaQ) {
    var y = year;
    var qq = q + deltaQ;
    while (qq < 1) {
      qq += 4;
      y -= 1;
    }
    while (qq > 4) {
      qq -= 4;
      y += 1;
    }
    return { year: y, q: qq };
  }

  function timesheetEntryYmd(e) {
    return (e && e.date ? String(e.date) : '').slice(0, 10);
  }

  function timesheetEnsurePeriodAnchors() {
    if (!timesheetWeekMondayYmd) {
      timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
    }
    if (!timesheetMonthYm) {
      var n = new Date();
      timesheetMonthYm = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
    }
    if (timesheetQuarterYear == null || timesheetQuarterQ == null) {
      var cq = calendarQuarterFromDate(new Date());
      timesheetQuarterYear = cq.year;
      timesheetQuarterQ = cq.q;
    }
  }

  /** Monday Date for spreading new entries by weekday checkboxes. */
  function timesheetBaseMondayForNewEntry() {
    timesheetEnsurePeriodAnchors();
    var mode = timesheetPeriodMode || 'week';
    if (mode === 'week') {
      var ymd = timesheetWeekMondayYmd || dateYMD(startOfWeekMonday(new Date()));
      var w = parseYMD(ymd);
      return isNaN(w.getTime()) ? startOfWeekMonday(new Date()) : w;
    }
    if (mode === 'month') {
      var first = parseYMD(timesheetMonthYm + '-01');
      return isNaN(first.getTime()) ? startOfWeekMonday(new Date()) : startOfWeekMonday(first);
    }
    if (mode === 'quarter') {
      var q0 = (timesheetQuarterQ - 1) * 3;
      var first = new Date(timesheetQuarterYear, q0, 1, 12, 0, 0, 0);
      return startOfWeekMonday(first);
    }
    if (mode === 'ytd') {
      var ytd = new Date(new Date().getFullYear(), 0, 1, 12, 0, 0, 0);
      return startOfWeekMonday(ytd);
    }
    return startOfWeekMonday(new Date());
  }

  function renderTimesheet() {
    var empty = $('timesheet-empty');
    var table = $('timesheet-table');
    var tbody = $('timesheet-tbody');
    var logEmpty = $('timesheet-log-empty');
    var logTable = $('timesheet-log-table');
    var logBody = $('timesheet-log-tbody');
    if (!tbody || !logBody) return;

    timesheetEnsurePeriodAnchors();
    var mode = timesheetPeriodMode || 'week';
    var periodSel = $('ts-period-mode');
    if (periodSel) periodSel.value = mode;

    var weekWrap = $('ts-period-week-wrap');
    var monthWrap = $('ts-period-month-wrap');
    var quarterWrap = $('ts-period-quarter-wrap');
    var allWrap = $('ts-period-all-wrap');
    if (weekWrap) weekWrap.style.display = mode === 'week' ? '' : 'none';
    if (monthWrap) monthWrap.style.display = mode === 'month' ? '' : 'none';
    if (quarterWrap) quarterWrap.style.display = mode === 'quarter' ? '' : 'none';
    if (allWrap) allWrap.style.display = (mode === 'all' || mode === 'ytd') ? '' : 'none';
    if (allWrap) allWrap.textContent = mode === 'ytd' ? 'Year to date' : 'All recorded time';

    var allEntries = timesheetEntries || [];
    var filteredEntries;
    if (mode === 'all') {
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds.length === 10;
      });
    } else if (mode === 'week') {
      var wkStartD = parseYMD(timesheetWeekMondayYmd);
      var wkEndD = new Date(wkStartD.getFullYear(), wkStartD.getMonth(), wkStartD.getDate() + 6, 12, 0, 0, 0);
      var weekEndYmd = dateYMD(wkEndD);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= timesheetWeekMondayYmd && ds <= weekEndYmd;
      });
      var weekLabelEl = $('ts-week-label');
      if (weekLabelEl && !isNaN(wkStartD.getTime()) && !isNaN(wkEndD.getTime())) {
        var lo = { month: 'short', day: 'numeric', year: 'numeric' };
        weekLabelEl.textContent =
          wkStartD.toLocaleDateString('en-US', lo) + ' – ' + wkEndD.toLocaleDateString('en-US', lo);
      }
      var thisWeekMon = dateYMD(startOfWeekMonday(new Date()));
      var todayWeekBtn = $('ts-week-today');
      if (todayWeekBtn) todayWeekBtn.hidden = timesheetWeekMondayYmd === thisWeekMon;
    } else if (mode === 'month') {
      var y = parseInt(timesheetMonthYm.slice(0, 4), 10);
      var m0 = parseInt(timesheetMonthYm.slice(5, 7), 10) - 1;
      var monthFirst = new Date(y, m0, 1, 12, 0, 0, 0);
      var monthLast = new Date(y, m0 + 1, 0, 12, 0, 0, 0);
      var monthStartYmd = dateYMD(monthFirst);
      var monthEndYmd = dateYMD(monthLast);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= monthStartYmd && ds <= monthEndYmd;
      });
      var monthLabelEl = $('ts-month-label');
      if (monthLabelEl && !isNaN(monthFirst.getTime())) {
        monthLabelEl.textContent = monthFirst.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      }
      var nowM = new Date();
      var curYm = nowM.getFullYear() + '-' + String(nowM.getMonth() + 1).padStart(2, '0');
      var todayMonthBtn = $('ts-month-today');
      if (todayMonthBtn) todayMonthBtn.hidden = timesheetMonthYm === curYm;
    } else if (mode === 'quarter') {
      var q0m = (timesheetQuarterQ - 1) * 3;
      var qFirst = new Date(timesheetQuarterYear, q0m, 1, 12, 0, 0, 0);
      var qLast = new Date(timesheetQuarterYear, q0m + 3, 0, 12, 0, 0, 0);
      var qStartYmd = dateYMD(qFirst);
      var qEndYmd = dateYMD(qLast);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= qStartYmd && ds <= qEndYmd;
      });
      var quarterLabelEl = $('ts-quarter-label');
      if (quarterLabelEl) {
        quarterLabelEl.textContent = 'Q' + timesheetQuarterQ + ' ' + timesheetQuarterYear;
      }
      var cq = calendarQuarterFromDate(new Date());
      var todayQuarterBtn = $('ts-quarter-today');
      if (todayQuarterBtn) {
        todayQuarterBtn.hidden = timesheetQuarterYear === cq.year && timesheetQuarterQ === cq.q;
      }
    } else {
      var ytdStart = new Date(new Date().getFullYear(), 0, 1, 12, 0, 0, 0);
      var ytdEnd = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12, 0, 0, 0);
      var ytdStartYmd = dateYMD(ytdStart);
      var ytdEndYmd = dateYMD(ytdEnd);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= ytdStartYmd && ds <= ytdEndYmd;
      });
    }

    var byEmp = {};
    var total = 0;
    var bill = 0;
    var non = 0;
    filteredEntries.forEach(function (e) {
      var key = (e.account || '').trim() || '—';
      if (!byEmp[key]) byEmp[key] = { total: 0, billable: 0, nonBillable: 0, entries: 0 };
      var mins = Math.max(0, Number(e.minutes) || 0);
      byEmp[key].total += mins;
      byEmp[key].entries += 1;
      if (e.billable) byEmp[key].billable += mins;
      else byEmp[key].nonBillable += mins;
      total += mins;
      if (e.billable) bill += mins;
      else non += mins;
    });

    var empKeys = Object.keys(byEmp).sort(function (a, b) { return byEmp[b].total - byEmp[a].total; });
    if (!empKeys.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
    } else {
      if (empty) empty.style.display = 'none';
      if (table) table.style.display = 'table';
      tbody.innerHTML = empKeys.map(function (k) {
        var row = byEmp[k];
        var util = row.total > 0 ? (row.billable / row.total * 100) : 0;
        return '<tr>' +
          '<td class="tdp">' + esc(k) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + formatMinutesToHours(row.total) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;color:var(--green);">' + formatMinutesToHours(row.billable) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + formatMinutesToHours(row.nonBillable) + '</td>' +
          '<td>' + row.entries + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + util.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%</td>' +
        '</tr>';
      }).join('');
    }

    setText('ts-kpi-total', formatMinutesToHours(total));
    setText('ts-kpi-total-sub', filteredEntries.length + ' entries');
    setText('ts-kpi-billable', formatMinutesToHours(bill));
    setText('ts-kpi-billable-sub', total > 0 ? ((bill / total) * 100).toFixed(1) + '%' : '0.0%');
    setText('ts-kpi-nonbillable', formatMinutesToHours(non));
    setText('ts-kpi-nonbillable-sub', total > 0 ? ((non / total) * 100).toFixed(1) + '%' : '0.0%');
    setText('ts-kpi-employees', String(empKeys.length));
    setText('ts-kpi-avg', formatMinutesToHours(empKeys.length ? total / empKeys.length : 0));
    var avgSub = mode === 'all'
      ? 'all time'
      : mode === 'ytd'
        ? 'year to date'
        : mode === 'month'
          ? 'selected month'
          : mode === 'quarter'
            ? 'selected quarter'
            : 'selected week';
    setText('ts-kpi-avg-sub', avgSub);

    var subEmp = $('ts-sub-by-emp');
    var subLog = $('ts-sub-log');
    var rangePhrase = mode === 'all'
      ? 'all time'
      : mode === 'ytd'
        ? 'year to date'
        : mode === 'month'
          ? 'selected month'
          : mode === 'quarter'
            ? 'selected quarter'
            : 'selected week';
    if (subEmp) subEmp.textContent = 'Based on the Account field · ' + rangePhrase;
    if (subLog) subLog.textContent = 'Newest first · ' + rangePhrase;

    var list = filteredEntries.slice().sort(function (a, b) {
      var ad = (a.date || '') + ' ' + (a.createdAt || '');
      var bd = (b.date || '') + ' ' + (b.createdAt || '');
      return bd.localeCompare(ad);
    });
    if (!list.length) {
      logBody.innerHTML = '';
      if (logEmpty) logEmpty.style.display = 'block';
      if (logTable) logTable.style.display = 'none';
    } else {
      if (logEmpty) logEmpty.style.display = 'none';
      if (logTable) logTable.style.display = 'table';
      logBody.innerHTML = list.map(function (e) {
        var typ = e.billable ? '<span class="pl pg-g">Billable</span>' : '<span class="pl pg-a">Non-Billable</span>';
        var notes = e.notes ? esc(e.notes) : '—';
        return '<tr>' +
          '<td>' + esc(e.date || '—') + '</td>' +
          '<td class="tdp">' + esc(e.account || '—') + '</td>' +
          '<td>' + esc(e.project || '—') + '</td>' +
          '<td>' + esc(e.task || '—') + '</td>' +
          '<td>' + esc(e.activityCode || '—') + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + formatMinutesToHours(e.minutes) + '</td>' +
          '<td>' + typ + '</td>' +
          '<td>' + notes + '</td>' +
          '<td class="ts-row-actions">' +
            '<button type="button" class="btn" data-ts-edit="' + e.id + '" style="margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-ts-del="' + e.id + '" style="color:var(--red);">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }
  }

  function wireTimesheet() {
    var weekPrev = $('ts-week-prev');
    var weekNext = $('ts-week-next');
    var weekToday = $('ts-week-today');
    if (weekPrev) {
      weekPrev.addEventListener('click', function () {
        if (!timesheetWeekMondayYmd) timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
        var d = parseYMD(timesheetWeekMondayYmd);
        d.setDate(d.getDate() - 7);
        timesheetWeekMondayYmd = dateYMD(d);
        renderTimesheet();
      });
    }
    if (weekNext) {
      weekNext.addEventListener('click', function () {
        if (!timesheetWeekMondayYmd) timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
        var d = parseYMD(timesheetWeekMondayYmd);
        d.setDate(d.getDate() + 7);
        timesheetWeekMondayYmd = dateYMD(d);
        renderTimesheet();
      });
    }
    if (weekToday) {
      weekToday.addEventListener('click', function () {
        timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
        renderTimesheet();
      });
    }

    var periodModeSel = $('ts-period-mode');
    if (periodModeSel) {
      periodModeSel.addEventListener('change', function () {
        timesheetPeriodMode = periodModeSel.value || 'week';
        timesheetEnsurePeriodAnchors();
        renderTimesheet();
      });
    }

    var monthPrev = $('ts-month-prev');
    var monthNext = $('ts-month-next');
    var monthToday = $('ts-month-today');
    if (monthPrev) {
      monthPrev.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        timesheetMonthYm = shiftMonthYm(timesheetMonthYm, -1);
        renderTimesheet();
      });
    }
    if (monthNext) {
      monthNext.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        timesheetMonthYm = shiftMonthYm(timesheetMonthYm, 1);
        renderTimesheet();
      });
    }
    if (monthToday) {
      monthToday.addEventListener('click', function () {
        var n = new Date();
        timesheetMonthYm = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
        renderTimesheet();
      });
    }

    var quarterPrev = $('ts-quarter-prev');
    var quarterNext = $('ts-quarter-next');
    var quarterToday = $('ts-quarter-today');
    if (quarterPrev) {
      quarterPrev.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        var s = shiftQuarter(timesheetQuarterYear, timesheetQuarterQ, -1);
        timesheetQuarterYear = s.year;
        timesheetQuarterQ = s.q;
        renderTimesheet();
      });
    }
    if (quarterNext) {
      quarterNext.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        var s = shiftQuarter(timesheetQuarterYear, timesheetQuarterQ, 1);
        timesheetQuarterYear = s.year;
        timesheetQuarterQ = s.q;
        renderTimesheet();
      });
    }
    if (quarterToday) {
      quarterToday.addEventListener('click', function () {
        var cq = calendarQuarterFromDate(new Date());
        timesheetQuarterYear = cq.year;
        timesheetQuarterQ = cq.q;
        renderTimesheet();
      });
    }

    var m = $('timesheetModal');
    var btnAdd = $('btn-add-time');
    var btnSave = $('btn-timesheet-save');
    var btnCancel = $('btn-timesheet-cancel');
    var toggleExternal = $('ts-toggle-external-note');
    var logTable = $('timesheet-log-table');
    if (!m) return;

    function openModal(editId) {
      var title = $('timesheet-modal-title');
      var eid = $('timesheet-edit-id');
      if (eid) eid.value = editId || '';
      var t = null;
      if (editId) {
        t = (timesheetEntries || []).find(function (x) { return x.id === editId; }) || null;
      }
      if (title) title.textContent = t ? 'Edit Time Entry' : 'Time Entry';
      $('ts-account').value = t ? (t.account || '') : '';
      $('ts-project').value = t ? (t.project || '') : '';
      $('ts-task').value = t ? (t.task || '') : '';
      $('ts-activity-code').value = t ? (t.activityCode || '') : '';
      if ($('ts-time')) {
        if (t && t.minutes != null) {
          var hh = String(Math.floor(t.minutes / 60)).padStart(2, '0');
          var mm = String((t.minutes % 60)).padStart(2, '0');
          $('ts-time').value = hh + ':' + mm;
        } else {
          $('ts-time').value = '01:00';
        }
      }
      if ($('ts-billable')) $('ts-billable').checked = t ? !!t.billable : true;
      if ($('ts-nonbillable')) $('ts-nonbillable').checked = t ? !t.billable : false;
      $('ts-notes').value = t ? (t.notes || '') : '';
      $('ts-external-note').value = t ? (t.externalNote || '') : '';
      var extWrap = $('ts-external-wrap');
      var showExt = !!(t && t.externalNote);
      if (extWrap) animateRollout(extWrap, showExt, true);
      if (toggleExternal) toggleExternal.textContent = showExt ? '− Hide External Note' : '+ Show External Note';
      var cbs = m.querySelectorAll('.ts-weekday-cb');
      cbs.forEach(function (cb) { cb.checked = false; });
      if (t && Array.isArray(t.weekdays) && t.weekdays.length) {
        cbs.forEach(function (cb) {
          var dow = parseInt(cb.getAttribute('data-dow'), 10);
          cb.checked = t.weekdays.indexOf(dow) !== -1;
        });
      }
      m.classList.add('on');
    }

    function closeModal() {
      m.classList.remove('on');
    }

    if (btnAdd) btnAdd.addEventListener('click', function () { openModal(''); });
    if (btnCancel) btnCancel.addEventListener('click', closeModal);
    if (toggleExternal) {
      toggleExternal.addEventListener('click', function (ev) {
        ev.preventDefault();
        var extWrap = $('ts-external-wrap');
        if (!extWrap) return;
        var show = extWrap.style.display === 'none' || !extWrap.classList.contains('on');
        animateRollout(extWrap, show, false);
        toggleExternal.textContent = show ? '− Hide External Note' : '+ Show External Note';
      });
    }
    if (btnSave) {
      btnSave.addEventListener('click', async function () {
        var account = $('ts-account').value.trim();
        var project = $('ts-project').value.trim();
        var task = $('ts-task').value.trim();
        var activityCode = $('ts-activity-code').value.trim();
        var minutes = parseTimeInputToMinutes($('ts-time').value);
        var notes = $('ts-notes').value.trim();
        var external = $('ts-external-note').value.trim();
        var billable = !!($('ts-billable') && $('ts-billable').checked);
        if (!account || !project || !task || !isFinite(minutes) || minutes <= 0) {
          alert('Account, Project, Task, and a valid time (HH:MM) are required.');
          return;
        }
        var editId = $('timesheet-edit-id') ? $('timesheet-edit-id').value : '';
        var selectedDow = [];
        m.querySelectorAll('.ts-weekday-cb').forEach(function (cb) {
          if (cb.checked) {
            var n = parseInt(cb.getAttribute('data-dow'), 10);
            if (!isNaN(n)) selectedDow.push(n);
          }
        });
        if (!selectedDow.length) {
          var td = new Date();
          selectedDow = [td.getDay()];
        }
        if (editId) {
          var changedEntry = null;
          timesheetEntries = (timesheetEntries || []).map(function (e) {
            if (e.id !== editId) return e;
            var date = e.date || dateYMD(new Date());
            changedEntry = {
              id: e.id,
              date: date,
              account: account,
              project: project,
              task: task,
              activityCode: activityCode,
              minutes: minutes,
              billable: billable,
              notes: notes,
              externalNote: external,
              weekdays: selectedDow.slice(),
              createdAt: e.createdAt || new Date().toISOString(),
            };
            return changedEntry;
          });
          if (changedEntry) await persistTimesheetEntryToSupabase(changedEntry);
        } else {
          var newEntries = [];
          var base = timesheetBaseMondayForNewEntry();
          if (isNaN(base.getTime())) base = startOfWeekMonday(new Date());
          selectedDow.forEach(function (dow) {
            var dt = new Date(base.getTime());
            var idx = dow === 0 ? 6 : (dow - 1);
            dt.setDate(base.getDate() + idx);
            var entry = {
              id: uuid(),
              date: dateYMD(dt),
              account: account,
              project: project,
              task: task,
              activityCode: activityCode,
              minutes: minutes,
              billable: billable,
              notes: notes,
              externalNote: external,
              weekdays: selectedDow.slice(),
              createdAt: new Date().toISOString(),
            };
            timesheetEntries.push(entry);
            newEntries.push(entry);
          });
          for (var i = 0; i < newEntries.length; i++) {
            await persistTimesheetEntryToSupabase(newEntries[i]);
          }
        }
        saveTimesheetEntries(timesheetEntries);
        renderTimesheet();
        closeModal();
      });
    }
    if (logTable) {
      logTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-ts-edit]');
        if (editBtn) {
          var eid = editBtn.getAttribute('data-ts-edit');
          if (eid) openModal(eid);
          return;
        }
        var delBtn = ev.target.closest('[data-ts-del]');
        if (!delBtn) return;
        var did = delBtn.getAttribute('data-ts-del');
        if (!did) return;
        if (!confirm('Delete this time entry?')) return;
        timesheetEntries = (timesheetEntries || []).filter(function (e) { return e.id !== did; });
        saveTimesheetEntries(timesheetEntries);
        deleteTimesheetEntryRemote(did);
        renderTimesheet();
      });
    }
    if (m) {
      m.addEventListener('click', function (ev) {
        if (ev.target === m) closeModal();
      });
    }
  }

  // ---------- Mutations ----------

  function recomputeAndRender() {
    state.computed = compute(state.filter);
    renderAll();
  }

  function addTransaction(tx) {
    state.transactions.push(tx);
    saveTransactions(state.transactions);
    recomputeAndRender();
    persistTransactionToSupabase(tx);
  }

  function deleteTransaction(id) {
    markTransactionsDeletedLocally([id]);
    var invsToDelete = invoices.filter(function (inv) { return inv.incomeTxId === id; });
    state.transactions = state.transactions.filter(function (tx) { return tx.id !== id; });
    invoices = invoices.filter(function (inv) { return inv.incomeTxId !== id; });
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    recomputeAndRender();
    deleteTransactionRemote(id);
    invsToDelete.forEach(function (inv) { deleteInvoiceRemote(inv.id); });
  }

  function deleteTransactionsByIds(ids) {
    if (!ids || !ids.length) return;
    markTransactionsDeletedLocally(ids);
    var remove = {};
    ids.forEach(function (id) { remove[id] = true; });
    var invsToDelete = invoices.filter(function (inv) { return remove[inv.incomeTxId]; });
    state.transactions = state.transactions.filter(function (tx) { return !remove[tx.id]; });
    invoices = invoices.filter(function (inv) { return !remove[inv.incomeTxId]; });
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    recomputeAndRender();
    ids.forEach(function (id) { deleteTransactionRemote(id); });
    invsToDelete.forEach(function (inv) { deleteInvoiceRemote(inv.id); });
  }

  // ---------- UI wiring ----------

  function renderIncomePowerFilterRows() {
    var host = $('income-power-filters');
    if (!host) return;
    var rows = incomePowerState.filters || [];
    host.innerHTML = rows.map(function (rule, idx) {
      var colOptions = incomePowerColumns.map(function (col) {
        return '<option value="' + col.id + '"' + (col.id === rule.column ? ' selected' : '') + '>' + esc(col.label) + '</option>';
      }).join('');
      var ops = incomeRuleOptionsForColumn(rule.column || 'source');
      var opOptions = ops.map(function (op) {
        return '<option value="' + op + '"' + (op === rule.op ? ' selected' : '') + '>' + esc(op) + '</option>';
      }).join('');
      var needsSecond = rule.op === 'between';
      return '<div class="power-filter-row" data-income-filter-row="' + idx + '">' +
        '<select class="fi" data-income-filter-col="' + idx + '">' + colOptions + '</select>' +
        '<select class="fi" data-income-filter-op="' + idx + '">' + opOptions + '</select>' +
        '<input class="fi" data-income-filter-value="' + idx + '" value="' + esc(rule.value || '') + '" placeholder="value" />' +
        (needsSecond ? '<input class="fi" data-income-filter-value2="' + idx + '" value="' + esc(rule.value2 || '') + '" placeholder="and value" />' : '') +
        '<button type="button" class="btn" data-income-filter-remove="' + idx + '">Remove</button>' +
      '</div>';
    }).join('');
  }

  function renderIncomePowerColumnChooser() {
    var grid = $('income-power-columns-grid');
    if (!grid) return;
    grid.innerHTML = incomePowerColumns.map(function (col) {
      var checked = incomePowerState.visible[col.id] !== false ? ' checked' : '';
      return '<label class="power-col-item"><input type="checkbox" data-income-col="' + esc(col.id) + '"' + checked + ' />' + esc(col.label) + '</label>';
    }).join('');
  }

  function applyIncomeBulkAction(action) {
    var selectedIds = Object.keys(incomePowerState.selected || {}).filter(function (id) { return incomePowerState.selected[id]; });
    if (!selectedIds.length) {
      alert('Select at least one row.');
      return;
    }
    if (action === 'export:selected') {
      var rows = (window.__incomePowerFilteredRows || []).filter(function (r) { return incomePowerState.selected[r.id]; });
      exportIncomeRowsCsv(rows, true);
      return;
    }
    if (action === 'delete:selected') {
      if (!confirm('Delete ' + selectedIds.length + ' selected income entr' + (selectedIds.length === 1 ? 'y' : 'ies') + '?')) return;
      deleteTransactionsByIds(selectedIds);
      incomePowerState.selected = {};
      return;
    }
    var txMap = {};
    selectedIds.forEach(function (id) { txMap[id] = true; });
    if (action === 'category:svc' || action === 'category:ret') {
      var nextCat = action.split(':')[1];
      state.transactions = state.transactions.map(function (tx) {
        if (!txMap[tx.id]) return tx;
        var next = Object.assign({}, tx, { category: nextCat });
        persistTransactionToSupabase(next);
        return next;
      });
      saveTransactions(state.transactions);
      recomputeAndRender();
      return;
    }
    if (action === 'invoice:paid' || action === 'invoice:sent') {
      var nextStatus = action.split(':')[1];
      invoices = invoices.map(function (inv) {
        if (!txMap[inv.incomeTxId]) return inv;
        var nextInv = Object.assign({}, inv, {
          status: nextStatus,
          paidAt: nextStatus === 'paid' ? new Date().toISOString().slice(0, 10) : null,
        });
        persistInvoiceToSupabase(nextInv);
        return nextInv;
      });
      saveInvoices(invoices);
      recomputeAndRender();
    }
  }

  function wireIncomePowerTable() {
    loadIncomePowerPrefs();
    loadIncomeTrendRange();
    renderIncomePowerColumnChooser();
    renderIncomePowerFilterRows();

    var trendRange = $('rev-trend-range');
    if (trendRange) {
      trendRange.value = incomeTrendRange;
      trendRange.addEventListener('change', function () {
        var v = trendRange.value;
        incomeTrendRange = (v === '30d' || v === '90d' || v === 'ytd' || v === 'all') ? v : '90d';
        saveIncomeTrendRange();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var search = $('income-power-search');
    if (search) {
      search.value = incomePowerState.search || '';
      search.addEventListener('input', function () {
        incomePowerState.search = search.value || '';
        saveIncomePowerPrefs();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var addFilter = $('income-power-add-filter');
    if (addFilter) {
      addFilter.addEventListener('click', function () {
        incomePowerState.filters.push({ column: 'source', op: 'contains', value: '' });
        saveIncomePowerPrefs();
        renderIncomePowerFilterRows();
      });
    }

    var colsBtn = $('income-power-columns');
    var colsPanel = $('income-power-columns-panel');
    if (colsBtn && colsPanel) {
      colsBtn.addEventListener('click', function () {
        colsPanel.classList.toggle('on');
      });
    }

    var filtersHost = $('income-power-filters');
    if (filtersHost) {
      filtersHost.addEventListener('input', function (ev) {
        var colIdx = ev.target.getAttribute('data-income-filter-col');
        var opIdx = ev.target.getAttribute('data-income-filter-op');
        var vIdx = ev.target.getAttribute('data-income-filter-value');
        var v2Idx = ev.target.getAttribute('data-income-filter-value2');
        if (colIdx != null) {
          var i = Number(colIdx);
          incomePowerState.filters[i].column = ev.target.value;
          incomePowerState.filters[i].op = incomeRuleOptionsForColumn(ev.target.value)[0];
        } else if (opIdx != null) {
          incomePowerState.filters[Number(opIdx)].op = ev.target.value;
        } else if (vIdx != null) {
          incomePowerState.filters[Number(vIdx)].value = ev.target.value;
        } else if (v2Idx != null) {
          incomePowerState.filters[Number(v2Idx)].value2 = ev.target.value;
        } else {
          return;
        }
        saveIncomePowerPrefs();
        renderIncomePowerFilterRows();
        if (state.computed) renderIncomeSection(state.computed);
      });
      filtersHost.addEventListener('click', function (ev) {
        var ridx = ev.target.getAttribute('data-income-filter-remove');
        if (ridx == null) return;
        incomePowerState.filters.splice(Number(ridx), 1);
        saveIncomePowerPrefs();
        renderIncomePowerFilterRows();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var colGrid = $('income-power-columns-grid');
    if (colGrid) {
      colGrid.addEventListener('change', function (ev) {
        var col = ev.target.getAttribute('data-income-col');
        if (!col) return;
        incomePowerState.visible[col] = !!ev.target.checked;
        var visibleCount = incomePowerColumns.filter(function (c) { return incomePowerState.visible[c.id] !== false; }).length;
        if (!visibleCount) {
          incomePowerState.visible[col] = true;
          ev.target.checked = true;
          alert('Keep at least one column visible.');
        }
        saveIncomePowerPrefs();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var applyBulk = $('income-power-apply-bulk');
    if (applyBulk) {
      applyBulk.addEventListener('click', function () {
        var sel = $('income-power-bulk-action');
        var action = sel ? sel.value : '';
        if (!action) return;
        applyIncomeBulkAction(action);
      });
    }
    var exportAll = $('income-power-export-all');
    if (exportAll) {
      exportAll.addEventListener('click', function () {
        exportIncomeRowsCsv(window.__incomePowerFilteredRows || [], false);
      });
    }

    var incomeTable = $('income-table');
    if (incomeTable) {
      incomeTable.addEventListener('change', function (ev) {
        var rid = ev.target.getAttribute('data-income-select');
        if (rid) {
          incomePowerState.selected[rid] = !!ev.target.checked;
          if (state.computed) renderIncomeSection(state.computed);
          return;
        }
        if (ev.target.id === 'income-power-select-all') {
          var checked = !!ev.target.checked;
          (window.__incomePowerFilteredRows || []).forEach(function (r) {
            incomePowerState.selected[r.id] = checked;
          });
          if (state.computed) renderIncomeSection(state.computed);
        }
      });
    }
  }

  function syncTransactionModalOtherFields() {
    var cat = $('tx-category') ? $('tx-category').value : '';
    var w1 = $('tx-other-wrapper');
    var w2 = $('tx-other-type-wrapper');
    var show = cat === 'oth';
    if (w1) animateRollout(w1, show, false);
    if (w2) animateRollout(w2, show, false);
  }

  function openTransactionModal() {
    var modal = $('transactionModal');
    if (!modal) return;
    $('tx-date').value = new Date().toISOString().slice(0, 10);
    $('tx-amount').value = '';
    $('tx-note').value = '';
    $('tx-category').value = 'svc';
    var otherLabel = $('tx-other-label');
    var otherType = $('tx-other-type');
    if (otherLabel) otherLabel.value = '';
    if (otherType) otherType.value = '';
    syncTransactionModalOtherFields();
    modal.classList.add('on');
  }

  function closeTransactionModal() {
    var modal = $('transactionModal');
    if (modal) modal.classList.remove('on');
  }

  function wireTransactionForm() {
    var btnOpen1 = $('btn-open-transaction');
    var btnOpen2 = $('btn-open-transaction-2');
    var btnSave = $('btn-tx-save');
    var btnCancel = $('btn-tx-cancel');

    if (btnOpen1) btnOpen1.addEventListener('click', openTransactionModal);
    if (btnOpen2) btnOpen2.addEventListener('click', openTransactionModal);
    if (btnCancel) btnCancel.addEventListener('click', closeTransactionModal);
    var txCat = $('tx-category');
    if (txCat) txCat.addEventListener('change', syncTransactionModalOtherFields);
    // "Other expense" helpers are always visible; we just read their values when category is 'oth'.
    if (btnSave) {
      btnSave.addEventListener('click', function () {
        var amount = parseFloat(($('tx-amount').value || '').trim());
        if (!amount || amount <= 0) {
          alert('Enter a positive amount.');
          return;
        }
        var date = $('tx-date').value || new Date().toISOString().slice(0, 10);
        var category = $('tx-category').value || 'svc';
        var note = $('tx-note').value || '';
        var desc = note;
        if (category === 'oth') {
          var otherLabel = $('tx-other-label') ? $('tx-other-label').value.trim() : '';
          var otherType = $('tx-other-type') ? $('tx-other-type').value.trim() : '';
          var extraParts = [];
          if (otherLabel) extraParts.push(otherLabel);
          if (otherType) extraParts.push('(' + otherType + ')');
          var extra = extraParts.join(' ');
          if (extra) {
            desc = note ? note + ' · ' + extra : extra;
          }
        }
        addTransaction({
          id: uuid(),
          date: date,
          description: desc,
          amount: amount,
          category: category,
        });
        closeTransactionModal();
      });
    }
  }

  // Income / expense modals (Income tab, Expenses tab) wired into the same
  // transaction store.

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Local calendar YYYY-MM-DD (matches expandRecurringExpenseInstances "today"). */
  function todayLocalYMD() {
    var now = new Date();
    return dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0));
  }

  function dateYMD(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseYMD(iso) {
    var p = (iso || '').split('-');
    if (p.length < 3) return new Date(NaN);
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0, 0);
  }

  function daysInMonth(y, m0) {
    return new Date(y, m0 + 1, 0).getDate();
  }

  function addMonthsKeepDom(y, m0, dom, deltaMonths) {
    var dt = new Date(y, m0 + deltaMonths, 1, 12, 0, 0, 0);
    var dim = daysInMonth(dt.getFullYear(), dt.getMonth());
    dt.setDate(Math.min(dom, dim));
    return dt;
  }

  function calendarDaysFromTo(start, d) {
    var ua = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    var ub = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((ub - ua) / 86400000);
  }

  function generateMonthlyOccurrenceDates(rule, startStr, horizonEndStr) {
    var start = parseYMD(rule.startDate || startStr);
    var end = parseYMD(horizonEndStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    var dom = rule.dayOfMonth != null ? Math.min(31, Math.max(1, +rule.dayOfMonth)) : start.getDate();
    var interval = Math.max(1, parseInt(rule.interval, 10) || 1);
    var y0 = start.getFullYear();
    var m0 = start.getMonth();
    var out = [];
    var step;
    for (step = 0; step < 240; step++) {
      var dt = addMonthsKeepDom(y0, m0, dom, step * interval);
      if (dt > end) break;
      if (dt >= start) out.push(dateYMD(dt));
    }
    return out;
  }

  function generateWeeklyOccurrenceDates(rule, startStr, horizonEndStr) {
    var start = parseYMD(rule.startDate || startStr);
    var end = parseYMD(horizonEndStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    var weekdays = (rule.weekdays && rule.weekdays.length) ? rule.weekdays.slice().sort(function (a, b) { return a - b; }) : [start.getDay()];
    var interval = Math.max(1, parseInt(rule.interval, 10) || 1);
    var seen = {};
    var out = [];
    var d = new Date(start.getTime());
    var guard = 0;
    while (d <= end && guard < 800) {
      guard++;
      if (weekdays.indexOf(d.getDay()) !== -1) {
        var daysFrom = calendarDaysFromTo(start, d);
        if (daysFrom >= 0) {
          var weeksFrom = Math.floor(daysFrom / 7);
          if (weeksFrom % interval === 0) {
            var iso = dateYMD(d);
            if (!seen[iso]) {
              seen[iso] = true;
              out.push(iso);
            }
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function expandRecurringExpenseInstances() {
    var todayStr = todayLocalYMD();
    var futureInstanceIds = (state.transactions || []).filter(function (t) {
      return t && t.expenseRecurrenceInstance && t.date && t.date > todayStr;
    }).map(function (t) { return t.id; });
    if (futureInstanceIds.length) deleteTransactionsByIds(futureInstanceIds);

    var leads = (state.transactions || []).filter(function (t) {
      return t && t.expenseRecurringLead && t.recurrence && t.recurrenceSeriesId &&
        ['lab', 'sw', 'ads', 'oth'].indexOf(t.category) !== -1;
    });
    if (!leads.length) return;
    var added = false;

    leads.forEach(function (lead) {
      var rule = Object.assign({}, lead.recurrence);
      rule.startDate = rule.startDate || lead.date;
      // Only materialize occurrences on or before today so future months do not appear until those dates arrive.
      var materializeThrough = todayStr;
      if (rule.endDate && String(rule.endDate).trim() && rule.endDate < materializeThrough) {
        materializeThrough = rule.endDate;
      }
      var endCap = materializeThrough;
      var dates = rule.repeat === 'weekly'
        ? generateWeeklyOccurrenceDates(rule, rule.startDate, endCap)
        : generateMonthlyOccurrenceDates(rule, rule.startDate, endCap);
      // No legacy backfill: only auto-create instances on/after the day the user turned on recurring.
      var notBefore = rule.materializeNotBefore;
      if (notBefore && typeof notBefore === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(notBefore)) {
        dates = dates.filter(function (iso) { return iso >= notBefore; });
      }
      var existing = {};
      state.transactions.forEach(function (t) {
        if (t.recurrenceSeriesId === lead.recurrenceSeriesId && t.date) existing[t.date] = true;
      });
      dates.forEach(function (iso) {
        if (existing[iso]) return;
        existing[iso] = true;
        added = true;
        var clone = {
          id: uuid(),
          date: iso,
          title: lead.title,
          vendor: lead.vendor,
          notes: lead.notes,
          description: lead.description,
          amount: lead.amount,
          category: lead.category,
          clientId: lead.clientId || null,
          recurrenceSeriesId: lead.recurrenceSeriesId,
          expenseRecurrenceInstance: true,
        };
        state.transactions.push(clone);
        persistTransactionToSupabase(clone);
      });
    });
    if (added) saveTransactions(state.transactions);
  }

  function syncExpenseRecurrenceRepeatRows() {
    var rep = $('expense-recurrence-repeat');
    var mode = rep ? rep.value : 'monthly';
    var monthlyRow = $('expense-recurrence-monthly-row');
    var weeklyRow = $('expense-recurrence-weekly-row');
    var label = $('expense-recurrence-interval-label');
    if (monthlyRow) monthlyRow.style.display = mode === 'monthly' ? '' : 'none';
    if (weeklyRow) weeklyRow.style.display = mode === 'weekly' ? '' : 'none';
    if (label) label.textContent = mode === 'weekly' ? 'week(s)' : 'month(s)';
    var endDate = $('expense-recurrence-end-date');
    var endMode = $('expense-recurrence-end-mode');
    if (endDate) endDate.style.display = endMode && endMode.value === 'on' ? '' : 'none';
  }

  function updateExpenseRecurrenceSummary() {
    var el = $('expense-recurrence-summary');
    if (!el) return;
    var chk = $('expense-recurring');
    if (!chk || !chk.checked) {
      el.textContent = '';
      return;
    }
    var startStr = ($('expense-date') && $('expense-date').value) || todayISO();
    var rep = ($('expense-recurrence-repeat') && $('expense-recurrence-repeat').value) || 'monthly';
    var n = Math.max(1, parseInt($('expense-recurrence-interval') && $('expense-recurrence-interval').value, 10) || 1);
    var endMode = $('expense-recurrence-end-mode') && $('expense-recurrence-end-mode').value;
    var endPart = endMode === 'on' && $('expense-recurrence-end-date') && $('expense-recurrence-end-date').value
      ? ' until ' + fmtDateDisplay($('expense-recurrence-end-date').value) + '.'
      : '.';
    var startPretty = fmtDateDisplay(startStr);
    if (rep === 'monthly') {
      var dom = Math.min(31, Math.max(1, parseInt($('expense-recurrence-dom') && $('expense-recurrence-dom').value, 10) || 1));
      var unit = n === 1 ? 'month' : n + ' months';
      el.innerHTML = 'Occurs on day <strong>' + dom + '</strong> every <strong>' + unit + '</strong>, starting <strong>' + startPretty + '</strong>' + endPart;
      return;
    }
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var sel = [];
    var modal = $('expenseModal');
    if (modal) {
      modal.querySelectorAll('.exp-rec-dow.on').forEach(function (b) {
        var dow = parseInt(b.getAttribute('data-dow'), 10);
        if (!isNaN(dow)) sel.push(names[dow]);
      });
    }
    var sdW = parseYMD(startStr);
    var dayPart = sel.length ? sel.join(', ') : names[isNaN(sdW.getTime()) ? 0 : sdW.getDay()];
    var wunit = n === 1 ? 'week' : n + ' weeks';
    el.innerHTML = 'Occurs every <strong>' + dayPart + '</strong> (every <strong>' + wunit + '</strong>), starting <strong>' + startPretty + '</strong>' + endPart;
  }

  function resetExpenseRecurrenceUiDefaults() {
    var rep = $('expense-recurrence-repeat');
    if (rep) rep.value = 'monthly';
    var intv = $('expense-recurrence-interval');
    if (intv) intv.value = '1';
    var dom = $('expense-recurrence-dom');
    var dStr = ($('expense-date') && $('expense-date').value) || todayISO();
    var pd = parseYMD(dStr);
    if (dom && !isNaN(pd.getTime())) dom.value = String(pd.getDate());
    var endMode = $('expense-recurrence-end-mode');
    if (endMode) endMode.value = 'never';
    var endDate = $('expense-recurrence-end-date');
    if (endDate) endDate.value = '';
    var modal = $('expenseModal');
    if (modal) {
      modal.querySelectorAll('.exp-rec-dow').forEach(function (b) {
        b.classList.remove('on');
        b.setAttribute('aria-pressed', 'false');
      });
    }
    syncExpenseRecurrenceRepeatRows();
    updateExpenseRecurrenceSummary();
  }

  function readExpenseRecurrenceRuleFromUi(expenseDateIso) {
    var repeat = ($('expense-recurrence-repeat') && $('expense-recurrence-repeat').value) || 'monthly';
    var interval = Math.max(1, parseInt($('expense-recurrence-interval') && $('expense-recurrence-interval').value, 10) || 1);
    var endMode = $('expense-recurrence-end-mode') && $('expense-recurrence-end-mode').value;
    var endDate = endMode === 'on' && $('expense-recurrence-end-date') && $('expense-recurrence-end-date').value
      ? $('expense-recurrence-end-date').value
      : null;
    var rule = {
      repeat: repeat,
      interval: interval,
      startDate: expenseDateIso,
      endDate: endDate,
    };
    if (repeat === 'weekly') {
      var wds = [];
      var modal = $('expenseModal');
      if (modal) {
        modal.querySelectorAll('.exp-rec-dow.on').forEach(function (b) {
          var dow = parseInt(b.getAttribute('data-dow'), 10);
          if (!isNaN(dow)) wds.push(dow);
        });
      }
      if (!wds.length) {
        var sd0 = parseYMD(expenseDateIso);
        wds.push(isNaN(sd0.getTime()) ? 0 : sd0.getDay());
      }
      rule.weekdays = wds;
    } else {
      rule.dayOfMonth = Math.min(31, Math.max(1, parseInt($('expense-recurrence-dom') && $('expense-recurrence-dom').value, 10) || 1));
    }
    return rule;
  }

  function toggleExpenseRecurrencePanelVisible() {
    var panel = $('expense-recurrence-panel');
    var chk = $('expense-recurring');
    if (panel && chk) animateRollout(panel, !!chk.checked, false);
    if (chk && chk.checked) {
      var domIn = $('expense-recurrence-dom');
      var fDate = $('expense-date');
      var rep = $('expense-recurrence-repeat');
      if (domIn && fDate && rep && rep.value === 'monthly') {
        var pd = parseYMD(fDate.value || todayISO());
        if (!isNaN(pd.getTime())) domIn.value = String(pd.getDate());
      }
      syncExpenseRecurrenceRepeatRows();
    }
    updateExpenseRecurrenceSummary();
  }

  function wireExpenseRecurrenceControls() {
    var modal = $('expenseModal');
    if (!modal || modal.getAttribute('data-recurrence-wired') === '1') return;
    modal.setAttribute('data-recurrence-wired', '1');
    var chk = $('expense-recurring');
    if (chk) chk.addEventListener('change', toggleExpenseRecurrencePanelVisible);
    var rep = $('expense-recurrence-repeat');
    if (rep) rep.addEventListener('change', function () { syncExpenseRecurrenceRepeatRows(); updateExpenseRecurrenceSummary(); });
    var intv = $('expense-recurrence-interval');
    if (intv) intv.addEventListener('input', updateExpenseRecurrenceSummary);
    var domIn = $('expense-recurrence-dom');
    if (domIn) domIn.addEventListener('input', updateExpenseRecurrenceSummary);
    var endMode = $('expense-recurrence-end-mode');
    if (endMode) endMode.addEventListener('change', function () { syncExpenseRecurrenceRepeatRows(); updateExpenseRecurrenceSummary(); });
    var endDate = $('expense-recurrence-end-date');
    if (endDate) endDate.addEventListener('change', updateExpenseRecurrenceSummary);
    var fDate = $('expense-date');
    if (fDate) fDate.addEventListener('change', function () {
      var d = $('expense-recurrence-dom');
      var pd = parseYMD(fDate.value || todayISO());
      if (d && !isNaN(pd.getTime()) && $('expense-recurrence-repeat') && $('expense-recurrence-repeat').value === 'monthly') {
        d.value = String(pd.getDate());
      }
      updateExpenseRecurrenceSummary();
    });
    modal.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.exp-rec-dow');
      if (!btn) return;
      var on = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      updateExpenseRecurrenceSummary();
    });
  }

  function openExpenseModal(existingTx) {
    wireExpenseRecurrenceControls();
    var m = $('expenseModal');
    if (!m) return;
    populateIncomeClientOptions();
    var editId = $('expense-edit-id');
    var fDate = $('expense-date');
    var fAmount = $('expense-amount');
    var fTitle = $('expense-title');
    var fCat = $('expense-category');
    var fVendor = $('expense-vendor');
    var fClient = $('expense-client');
    var fNotes = $('expense-notes');
    var recChk = $('expense-recurring');

    if (existingTx) {
      if (editId) editId.value = existingTx.id || '';
      if (fDate) fDate.value = existingTx.date || todayISO();
      if (fAmount) fAmount.value = existingTx.amount != null ? String(existingTx.amount) : '';
      if (fTitle) fTitle.value = (existingTx.title != null && existingTx.title !== '') ? existingTx.title : (existingTx.description || '');
      if (fCat) fCat.value = existingTx.categoryLabel || '';
      if (fVendor) fVendor.value = existingTx.vendor || '';
      if (fClient) fClient.value = existingTx.clientId || '';
      if (fNotes) fNotes.value = existingTx.notes != null ? existingTx.notes : '';
      var isLead = !!existingTx.expenseRecurringLead && existingTx.recurrence;
      if (recChk) recChk.checked = isLead;
      if (isLead && existingTx.recurrence) {
        var r = existingTx.recurrence;
        if ($('expense-recurrence-repeat')) $('expense-recurrence-repeat').value = r.repeat === 'weekly' ? 'weekly' : 'monthly';
        if ($('expense-recurrence-interval')) $('expense-recurrence-interval').value = String(Math.max(1, r.interval || 1));
        if ($('expense-recurrence-dom')) {
          if (r.dayOfMonth != null) $('expense-recurrence-dom').value = String(r.dayOfMonth);
          else if (r.repeat !== 'weekly') {
            var pdDom = parseYMD(existingTx.date || todayISO());
            if (!isNaN(pdDom.getTime())) $('expense-recurrence-dom').value = String(pdDom.getDate());
          }
        }
        if ($('expense-recurrence-end-mode')) $('expense-recurrence-end-mode').value = r.endDate ? 'on' : 'never';
        if ($('expense-recurrence-end-date')) $('expense-recurrence-end-date').value = r.endDate || '';
        m.querySelectorAll('.exp-rec-dow').forEach(function (b) {
          b.classList.remove('on');
          b.setAttribute('aria-pressed', 'false');
        });
        if (r.weekdays && r.weekdays.length) {
          r.weekdays.forEach(function (wd) {
            var b = m.querySelector('.exp-rec-dow[data-dow="' + wd + '"]');
            if (b) {
              b.classList.add('on');
              b.setAttribute('aria-pressed', 'true');
            }
          });
        }
      } else {
        resetExpenseRecurrenceUiDefaults();
      }
    } else {
      if (editId) editId.value = '';
      if (fDate) fDate.value = todayISO();
      if (fAmount) fAmount.value = '';
      if (fTitle) fTitle.value = '';
      if (fCat) fCat.value = '';
      if (fVendor) fVendor.value = '';
      if (fClient) fClient.value = '';
      if (fNotes) fNotes.value = '';
      if (recChk) recChk.checked = false;
      resetExpenseRecurrenceUiDefaults();
    }
    syncExpenseRecurrenceRepeatRows();
    animateRollout($('expense-recurrence-panel'), !!(recChk && recChk.checked), true);
    toggleExpenseRecurrencePanelVisible();
    m.classList.add('on');
  }

  function closeExpenseModal() {
    var m = $('expenseModal');
    if (m) m.classList.remove('on');
  }

  function openIncomeModal() {
    var m = $('incomeModal');
    if (!m) return;
    var editId = $('income-edit-id');
    if (editId) editId.value = '';
    var fDate = $('income-date');
    var fAmount = $('income-amount');
    var fSource = $('income-source');
    var fCat = $('income-category');
    var fNotes = $('income-notes');
    if (fDate) fDate.value = todayISO();
    if (fAmount) fAmount.value = '';
    if (fSource) fSource.value = '';
    if (fCat) fCat.value = '';
    if (fNotes) fNotes.value = '';
    populateIncomeClientOptions();
    populateIncomeProjectOptions();
    m.classList.add('on');
  }

  function closeIncomeModal() {
    var m = $('incomeModal');
    if (m) m.classList.remove('on');
  }

  function createOrEditInvoiceForIncomeTx(txId, isEdit) {
    var tx = state.transactions.find(function (t) { return t.id === txId; });
    if (!tx) return;
    var existing = getInvoiceByIncomeTxId(txId);
    var today = new Date().toISOString().slice(0, 10);
    var issueDefault = existing && existing.dateIssued ? existing.dateIssued : (tx.date || today);
    var dueDefault = existing && existing.dueDate
      ? existing.dueDate
      : new Date(new Date(issueDefault).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    var numberDefault = existing && existing.number ? existing.number : nextInvoiceNumber();
    var amountDefault = existing && existing.amount ? String(existing.amount) : String(tx.amount || 0);

    var modal = $('invoiceModal');
    if (!modal) return;
    var incomeIdInput = $('invoice-income-id');
    var numInput = $('invoice-number');
    var issueInput = $('invoice-issue-date');
    var dueInput = $('invoice-due-date');
    var amountInput = $('invoice-amount');
    var ctx = $('invoice-context');
    var title = $('invoice-modal-title');

    if (incomeIdInput) incomeIdInput.value = txId;
    if (numInput) numInput.value = numberDefault;
    if (issueInput) issueInput.value = issueDefault;
    if (dueInput) dueInput.value = dueDefault;
    if (amountInput) amountInput.value = amountDefault;

    if (ctx) {
      var clientLabel = 'No client';
      if (tx.clientId) {
        var cl = clients.find(function (c) { return c.id === tx.clientId; });
        if (cl && cl.companyName) clientLabel = cl.companyName;
      }
      var desc = tx.description || '';
      ctx.textContent = (clientLabel ? clientLabel + ' • ' : '') + desc;
    }
    if (title) title.textContent = isEdit ? 'Edit invoice' : 'Create invoice';

    modal.classList.add('on');
  }

  function buildInvoiceMarkup(tx, inv) {
    var client = null;
    if (tx && tx.clientId) {
      client = clients.find(function (c) { return c.id === tx.clientId; }) || null;
    }
    var fromName = 'ives deutschmann marketing';
    var fromAddress1 = 'Business Dashboard';
    var fromAddress2 = 'United States';
    var toName = client && client.companyName ? client.companyName : (tx.description || 'Client');
    var issueDate = inv && inv.dateIssued ? inv.dateIssued : todayISO();
    var dueDate = inv && inv.dueDate ? inv.dueDate : issueDate;
    var number = inv && inv.number ? inv.number : nextInvoiceNumber();
    var amount = Number(inv && inv.amount != null ? inv.amount : (tx && tx.amount ? tx.amount : 0));
    var taxRate = 0.10;
    var subtotal = amount;
    var tax = subtotal * taxRate;
    var total = subtotal + tax;
    var serviceLabel = tx && tx.description ? tx.description : 'Project consulting';

    return '' +
      '<div style="max-width:860px;margin:0 auto;background:#fff;border-radius:16px;padding:54px 58px;color:#1f1f1f;font-family:\'Helvetica Now Pro Display Medium\',system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.08);">' +
        '<div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:36px;">' +
          '<div>' +
            '<div style="font-size:42px;line-height:0.9;font-weight:700;letter-spacing:0.02em;margin-bottom:14px;">IDM</div>' +
            '<div style="font-size:30px;line-height:1.05;font-weight:500;">Invoice</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-size:44px;font-weight:700;letter-spacing:0.02em;">INVOICE</div>' +
            '<div style="margin-top:16px;font-size:16px;line-height:1.45;">' +
              '<div style="font-weight:600;">' + esc(fromName) + '</div>' +
              '<div>' + esc(fromAddress1) + '</div>' +
              '<div>' + esc(fromAddress2) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:30px;margin-bottom:30px;">' +
          '<div style="font-size:16px;line-height:1.45;">' +
            '<div style="font-weight:700;margin-bottom:6px;">Bill To</div>' +
            '<div style="font-weight:600;">' + esc(toName) + '</div>' +
            (client && client.contactName ? '<div>' + esc(client.contactName) + '</div>' : '') +
            (client && client.email ? '<div>' + esc(client.email) + '</div>' : '') +
            (client && client.phone ? '<div>' + esc(client.phone) + '</div>' : '') +
          '</div>' +
          '<div style="font-size:32px;font-weight:700;text-align:right;line-height:1.2;">' +
            '<div style="font-size:16px;font-weight:600;">Invoice # ' + esc(number) + '</div>' +
            '<div style="font-size:15px;font-weight:500;color:#4c4c4c;margin-top:12px;">Issue date: ' + esc(fmtDateDisplay(issueDate)) + '</div>' +
            '<div style="font-size:15px;font-weight:500;color:#4c4c4c;">Due date: ' + esc(fmtDateDisplay(dueDate)) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="border-radius:14px;background:#f5f5f5;padding:16px 18px;margin-bottom:18px;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
            '<thead><tr style="color:#6d6d6d;text-align:left;">' +
              '<th style="padding:8px 0;font-weight:500;">Product</th>' +
              '<th style="padding:8px 0;font-weight:500;">Rate</th>' +
              '<th style="padding:8px 0;font-weight:500;">Qty</th>' +
              '<th style="padding:8px 0;font-weight:500;">Tax</th>' +
              '<th style="padding:8px 0;font-weight:500;text-align:right;">Amount</th>' +
            '</tr></thead>' +
            '<tbody><tr>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;line-height:1.2;">' + esc(serviceLabel) + '</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;">' + esc(fmtCurrencyPrecise(subtotal)) + '</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;">1</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;">10%</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;text-align:right;">' + esc(fmtCurrencyPrecise(subtotal)) + '</td>' +
            '</tr></tbody>' +
          '</table>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;">' +
          '<div style="width:320px;font-size:20px;line-height:1.65;">' +
            '<div style="display:flex;justify-content:space-between;"><span style="font-weight:600;">Subtotal:</span><span>' + esc(fmtCurrencyPrecise(subtotal)) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span style="font-weight:600;">Tax:</span><span>' + esc(fmtCurrencyPrecise(tax)) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span style="font-weight:700;">Invoice total:</span><span style="font-weight:700;">' + esc(fmtCurrencyPrecise(total)) + '</span></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function openInvoicePreviewForIncomeTx(txId) {
    var tx = state.transactions.find(function (t) { return t.id === txId; });
    if (!tx) return;
    var inv = getInvoiceByIncomeTxId(txId);
    if (!inv) {
      alert('Create the invoice first.');
      return;
    }
    var body = $('invoice-preview-body');
    var modal = $('invoicePreviewModal');
    if (!body || !modal) return;
    body.innerHTML = buildInvoiceMarkup(tx, inv);
    modal.classList.add('on');
  }

  function printCurrentInvoicePreview() {
    var body = $('invoice-preview-body');
    if (!body) return;
    var html = body.innerHTML;
    if (!html) return;
    var w = window.open('', '_blank', 'width=1100,height=900');
    if (!w) return;
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Invoice</title><style>body{margin:0;background:#fff;padding:24px;}*{box-sizing:border-box;}@media print{body{padding:0;}}</style></head><body>' + html + '</body></html>');
    w.document.close();
    w.focus();
    w.print();
  }

  function mapExpenseCategory(raw) {
    var v = (raw || '').toLowerCase();
    if (v.match(/labor|payroll|team|staff/)) return 'lab';
    if (v.match(/soft|saas|tool/)) return 'sw';
    if (v.match(/ad|advertis|marketing|promo/)) return 'ads';
    return 'oth';
  }

  function mapIncomeCategory(raw) {
    var v = (raw || '').toLowerCase();
    if (v.match(/retain/)) return 'ret';
    return 'svc';
  }

  /** User-facing income category for tables and the income modal; ledger still uses svc vs ret. */
  function displayIncomeCategory(tx) {
    if (!tx) return 'Services';
    var custom = tx.incomeCategoryLabel != null ? String(tx.incomeCategoryLabel).trim() : '';
    if (custom) return custom;
    return tx.category === 'ret' ? 'Retainer' : 'Services';
  }

  // ---------- CSV import & journal export (BYO data pipe) ----------

  var LAST_IMPORT_BATCH_KEY = 'last-import-batch:v1';
  var CSV_IMPORT_MAX_ROWS = 5000;

  function csvImportStoragePayload(batchId, ids) {
    return JSON.stringify({ batchId: batchId, ids: ids, at: Date.now() });
  }

  function loadLastImportBatch() {
    try {
      var raw = localStorage.getItem(storageKey(LAST_IMPORT_BATCH_KEY));
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.ids) || !o.batchId) return null;
      if (Date.now() - (o.at || 0) > 86400000) return null;
      return o;
    } catch (_) {
      return null;
    }
  }

  function saveLastImportBatch(batchId, ids) {
    try {
      localStorage.setItem(storageKey(LAST_IMPORT_BATCH_KEY), csvImportStoragePayload(batchId, ids));
    } catch (_) {}
  }

  function clearLastImportBatch() {
    try {
      localStorage.removeItem(storageKey(LAST_IMPORT_BATCH_KEY));
    } catch (_) {}
  }

  function refreshUndoImportButtons() {
    var last = loadLastImportBatch();
    var en = !!(last && last.ids && last.ids.length);
    ['btn-undo-last-import', 'btn-undo-last-import-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = !en;
    });
  }

  function parseCsvLine(line) {
    var out = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && (ch === ',' || ch === ';')) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function detectCsvDelimiter(firstLine) {
    if (!firstLine) return ',';
    var semi = (firstLine.match(/;/g) || []).length;
    var com = (firstLine.match(/,/g) || []).length;
    return semi > com ? ';' : ',';
  }

  function splitCsvRows(text, delim) {
    var rows = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '"') {
        if (inQuotes && text[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        cur += ch;
        continue;
      }
      if (!inQuotes && ch === '\n') {
        if (cur.length || rows.length === 0) rows.push(cur);
        cur = '';
        continue;
      }
      if (!inQuotes && ch === '\r') continue;
      cur += ch;
    }
    if (cur.length || rows.length === 0) rows.push(cur);
    return rows.filter(function (r) {
      return String(r).trim().length > 0;
    });
  }

  function parseCsvToMatrix(text) {
    var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) {
      return l.trim().length > 0;
    });
    if (!lines.length) return { headers: [], rows: [], delim: ',', warnings: ['File is empty.'] };
    var delim = detectCsvDelimiter(lines[0]);
    var headers = parseCsvLine(lines[0]).map(function (h) {
      return String(h || '').trim();
    });
    var rows = [];
    var warnings = [];
    var max = Math.min(lines.length - 1, CSV_IMPORT_MAX_ROWS);
    if (lines.length - 1 > CSV_IMPORT_MAX_ROWS) {
      warnings.push('Only the first ' + CSV_IMPORT_MAX_ROWS + ' data rows will be imported.');
    }
    for (var r = 1; r <= max; r++) {
      var cells = parseCsvLine(lines[r]);
      if (cells.length < headers.length) {
        while (cells.length < headers.length) cells.push('');
      } else if (cells.length > headers.length) {
        cells = cells.slice(0, headers.length);
      }
      rows.push(cells);
    }
    return { headers: headers, rows: rows, delim: delim, warnings: warnings };
  }

  function headerMatchScore(name, patterns) {
    var n = String(name || '').toLowerCase();
    var best = 0;
    for (var i = 0; i < patterns.length; i++) {
      if (n.indexOf(patterns[i]) !== -1) best = Math.max(best, patterns[i].length);
    }
    return best;
  }

  function guessCsvColumnIndices(headers) {
    var bestDate = -1;
    var bestDateScore = 0;
    var bestAmt = -1;
    var bestAmtScore = 0;
    var bestDebit = -1;
    var bestDebitScore = 0;
    var bestCredit = -1;
    var bestCreditScore = 0;
    var bestDesc = -1;
    var bestDescScore = 0;
    var bestExt = -1;
    var bestExtScore = 0;
    headers.forEach(function (h, idx) {
      var hs = headerMatchScore(h, [
        'transaction date',
        'posting date',
        'posted date',
        'date',
        'value date',
        'booking date',
      ]);
      if (hs > bestDateScore) {
        bestDateScore = hs;
        bestDate = idx;
      }
      hs = headerMatchScore(h, ['amount', 'amt', 'value']);
      if (hs > bestAmtScore && headerMatchScore(h, ['debit', 'credit']) === 0) {
        bestAmtScore = hs;
        bestAmt = idx;
      }
      hs = headerMatchScore(h, ['debit', 'withdraw', 'payment', 'outflow']);
      if (hs > bestDebitScore) {
        bestDebitScore = hs;
        bestDebit = idx;
      }
      hs = headerMatchScore(h, ['credit', 'deposit', 'inflow']);
      if (hs > bestCreditScore) {
        bestCreditScore = hs;
        bestCredit = idx;
      }
      hs = headerMatchScore(h, ['description', 'memo', 'details', 'narrative', 'payee', 'name', 'merchant']);
      if (hs > bestDescScore) {
        bestDescScore = hs;
        bestDesc = idx;
      }
      hs = headerMatchScore(h, ['transaction id', 'trans id', 'reference', 'fitid', 'id']);
      if (hs > bestExtScore) {
        bestExtScore = hs;
        bestExt = idx;
      }
    });
    return {
      dateIdx: bestDate,
      amountIdx: bestAmt,
      debitIdx: bestDebit,
      creditIdx: bestCredit,
      descIdx: bestDesc,
      extIdx: bestExt,
    };
  }

  function fillImpColumnSelects(headers, guess) {
    function opts(includeNone) {
      var o = [];
      if (includeNone) o.push('<option value="-1">— None —</option>');
      headers.forEach(function (h, i) {
        var lab = esc(String(h || 'Column ' + (i + 1)));
        o.push('<option value="' + i + '">' + lab + '</option>');
      });
      return o.join('');
    }
    var dateSel = $('imp-col-date');
    var amtSel = $('imp-col-amount');
    var debSel = $('imp-col-debit');
    var credSel = $('imp-col-credit');
    var descSel = $('imp-col-description');
    var extSel = $('imp-col-external');
    if (dateSel) dateSel.innerHTML = opts(false);
    if (amtSel) amtSel.innerHTML = opts(true);
    if (debSel) debSel.innerHTML = opts(true);
    if (credSel) credSel.innerHTML = opts(true);
    if (descSel) descSel.innerHTML = opts(false);
    if (extSel) extSel.innerHTML = opts(true);
    function setVal(sel, idx) {
      if (!sel || idx == null || idx < 0) return;
      if (idx < headers.length) sel.value = String(idx);
    }
    setVal(dateSel, guess.dateIdx);
    setVal(amtSel, guess.amountIdx);
    setVal(debSel, guess.debitIdx >= 0 ? guess.debitIdx : -1);
    setVal(credSel, guess.creditIdx >= 0 ? guess.creditIdx : -1);
    setVal(descSel, guess.descIdx >= 0 ? guess.descIdx : 0);
    setVal(extSel, guess.extIdx >= 0 ? guess.extIdx : -1);
  }

  function parseFlexibleMoney(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) {
      neg = true;
      s = s.slice(1, -1).trim();
    }
    if (s[0] === '-') {
      neg = !neg;
      s = s.slice(1).trim();
    }
    s = s.replace(/[$€£\s]/g, '');
    var hasComma = s.indexOf(',') !== -1;
    var hasDot = s.indexOf('.') !== -1;
    if (hasComma && hasDot) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }
    } else if (hasComma && !hasDot) {
      if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
      else s = s.replace(',', '.');
    } else if (!hasComma && hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');
    }
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    if (neg) n = -n;
    return n;
  }

  function parseFlexibleDate(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var d = parseDate(s);
    if (d && !isNaN(d.getTime())) return dateYMD(d);
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      var mo = +m[1] - 1;
      var day = +m[2];
      var y = +m[3];
      if (y < 100) y += 2000;
      var d2 = new Date(y, mo, day, 12, 0, 0, 0);
      if (!isNaN(d2.getTime())) return dateYMD(d2);
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      var d3 = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
      if (!isNaN(d3.getTime())) return dateYMD(d3);
    }
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      var d4 = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
      if (!isNaN(d4.getTime())) return dateYMD(d4);
    }
    return null;
  }

  function impSelectedIndex(sel) {
    if (!sel) return -1;
    var v = parseInt(sel.value, 10);
    return isNaN(v) ? -1 : v;
  }

  function txFingerprintForImport(dateYmd, amount, desc, ext) {
    var d = (desc || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return (dateYmd || '') + '|' + String(amount) + '|' + d + '|' + String(ext || '').trim();
  }

  function buildExistingImportFingerprints() {
    var ext = {};
    var fp = {};
    (state.transactions || []).forEach(function (t) {
      if (!t || !t.id) return;
      if (t.externalId) ext[String(t.externalId).trim()] = true;
      fp[txFingerprintForImport(t.date, t.amount, t.description || t.note || '', t.externalId)] = true;
    });
    return { extIds: ext, fps: fp };
  }

  function categoryLabelForJournal(code, tx) {
    if (code === 'svc' || code === 'ret') return displayIncomeCategory(tx);
    var m = {
      lab: 'Labor',
      sw: 'Software & tools',
      ads: 'Advertising',
      oth: 'Other',
      own: 'Owner investment',
    };
    return m[code] || code || '—';
  }

  function journalFlowForTx(tx) {
    var c = tx && tx.category;
    if (c === 'svc' || c === 'ret' || c === 'own') return 'Inflow';
    return 'Outflow';
  }

  function defaultJournalExportRange() {
    var f = state.filter || { mode: 'all', start: null, end: null };
    var end = new Date();
    var start = new Date(end.getTime());
    if (f.mode === 'range' && f.start && f.end) {
      return { start: f.start, end: f.end };
    }
    if (f.mode === 'month') {
      var y = end.getFullYear();
      var m0 = end.getMonth();
      var first = new Date(y, m0, 1, 12, 0, 0, 0);
      var last = new Date(y, m0 + 1, 0, 12, 0, 0, 0);
      return { start: dateYMD(first), end: dateYMD(last) };
    }
    start.setDate(start.getDate() - 89);
    return { start: dateYMD(start), end: dateYMD(end) };
  }

  function journalCsvEscapeCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }

  function buildJournalCsvLines(startYmd, endYmd, format) {
    var lines = [];
    var txs = (state.transactions || []).filter(function (t) {
      if (!t || !t.date) return false;
      if (t.date < startYmd || t.date > endYmd) return false;
      return true;
    }).slice()
      .sort(function (a, b) {
        return (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id));
      });
    if (format === 'split') {
      lines.push('Date,Type,CategoryCode,CategoryLabel,Debit,Credit,Memo,ClientName,ProjectName,ExternalId');
    } else {
      lines.push('Date,Type,CategoryCode,CategoryLabel,Amount,Description,ClientName,ProjectName,ExternalId');
    }
    txs.forEach(function (tx) {
      var code = tx.category || '';
      var lab = categoryLabelForJournal(code, tx);
      var flow = journalFlowForTx(tx);
      var amt = Math.abs(Number(tx.amount || 0));
      var desc = tx.description || tx.note || tx.title || '';
      var ext = tx.externalId || '';
      var clientName = '';
      if (tx.clientId) {
        var cl = clients.find(function (c) { return c.id === tx.clientId; });
        if (cl) clientName = cl.companyName || cl.contactName || '';
      }
      var projName = '';
      if (tx.projectId) {
        var pr = projects.find(function (p) { return p.id === tx.projectId; });
        if (pr) projName = pr.name || '';
      }
      if (format === 'split') {
        var debit = '';
        var credit = '';
        if (flow === 'Outflow') debit = String(amt);
        else credit = String(amt);
        lines.push(
          journalCsvEscapeCell(tx.date) + ',' +
          journalCsvEscapeCell(flow) + ',' +
          journalCsvEscapeCell(code) + ',' +
          journalCsvEscapeCell(lab) + ',' +
          journalCsvEscapeCell(debit) + ',' +
          journalCsvEscapeCell(credit) + ',' +
          journalCsvEscapeCell(desc) + ',' +
          journalCsvEscapeCell(clientName) + ',' +
          journalCsvEscapeCell(projName) + ',' +
          journalCsvEscapeCell(ext)
        );
      } else {
        lines.push(
          journalCsvEscapeCell(tx.date) + ',' +
          journalCsvEscapeCell(flow) + ',' +
          journalCsvEscapeCell(code) + ',' +
          journalCsvEscapeCell(lab) + ',' +
          String(amt) + ',' +
          journalCsvEscapeCell(desc) + ',' +
          journalCsvEscapeCell(clientName) + ',' +
          journalCsvEscapeCell(projName) + ',' +
          journalCsvEscapeCell(ext)
        );
      }
    });
    return lines;
  }

  function downloadTextFile(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  var impWizardState = {
    step: 1,
    matrix: null,
    previewTxs: [],
    batchId: null,
    lastSkipCount: 0,
  };

  function setImpStep(n) {
    impWizardState.step = n;
    var s1 = $('imp-step-1');
    var s2 = $('imp-step-2');
    var s3 = $('imp-step-3');
    var back = $('imp-back');
    var next = $('imp-next');
    var commit = $('imp-commit');
    if (s1) s1.style.display = n === 1 ? 'flex' : 'none';
    if (s2) s2.style.display = n === 2 ? 'block' : 'none';
    if (s3) s3.style.display = n === 3 ? 'flex' : 'none';
    if (back) back.style.display = n === 1 ? 'none' : 'inline-block';
    if (next) next.style.display = n === 3 ? 'none' : 'inline-block';
    if (commit) commit.style.display = n === 3 ? 'inline-block' : 'none';
  }

  function syncImpAmountModeUi() {
    var split = $('imp-amount-mode-split') && $('imp-amount-mode-split').checked;
    var wAmt = $('imp-wrap-col-amount');
    var wDeb = $('imp-wrap-col-debit');
    var wCred = $('imp-wrap-col-credit');
    if (wAmt) wAmt.style.display = split ? 'none' : '';
    if (wDeb) wDeb.style.display = split ? '' : 'none';
    if (wCred) wCred.style.display = split ? '' : 'none';
  }

  function buildImportPreviewTransactions() {
    var headers = impWizardState.matrix && impWizardState.matrix.headers;
    var rows = impWizardState.matrix && impWizardState.matrix.rows;
    if (!headers || !rows) return [];
    var dateIdx = impSelectedIndex($('imp-col-date'));
    var descIdx = impSelectedIndex($('imp-col-description'));
    var extIdx = impSelectedIndex($('imp-col-external'));
    var split = $('imp-amount-mode-split') && $('imp-amount-mode-split').checked;
    var amtIdx = impSelectedIndex($('imp-col-amount'));
    var debIdx = impSelectedIndex($('imp-col-debit'));
    var credIdx = impSelectedIndex($('imp-col-credit'));
    var defCat = $('imp-default-exp-cat') ? $('imp-default-exp-cat').value : 'infer';
    var importRev = $('imp-import-revenue') && $('imp-import-revenue').checked;
    var skipDup = $('imp-skip-dupes') && $('imp-skip-dupes').checked;
    var existing = skipDup ? buildExistingImportFingerprints() : { extIds: {}, fps: {} };
    var out = [];
    var skipped = 0;
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r];
      if (dateIdx < 0 || dateIdx >= cells.length) {
        skipped++;
        continue;
      }
      var dateY = parseFlexibleDate(cells[dateIdx]);
      if (!dateY) {
        skipped++;
        continue;
      }
      var desc = '';
      if (descIdx >= 0 && descIdx < cells.length) desc = String(cells[descIdx] || '').trim();
      var ext = '';
      if (extIdx >= 0 && extIdx < cells.length) ext = String(cells[extIdx] || '').trim();
      var signed = null;
      if (split) {
        var dv = debIdx >= 0 && debIdx < cells.length ? parseFlexibleMoney(cells[debIdx]) : null;
        var cv = credIdx >= 0 && credIdx < cells.length ? parseFlexibleMoney(cells[credIdx]) : null;
        var debitAmt = dv == null || isNaN(dv) ? 0 : Math.abs(dv);
        var creditAmt = cv == null || isNaN(cv) ? 0 : Math.abs(cv);
        if (debitAmt > 0 && creditAmt > 0) {
          skipped++;
          continue;
        }
        if (debitAmt > 0) signed = -debitAmt;
        else if (creditAmt > 0) signed = creditAmt;
      } else {
        if (amtIdx < 0 || amtIdx >= cells.length) {
          skipped++;
          continue;
        }
        signed = parseFlexibleMoney(cells[amtIdx]);
      }
      if (signed == null || isNaN(signed) || signed === 0) {
        skipped++;
        continue;
      }
      var flowOut = signed < 0;
      var amountPos = Math.abs(signed);
      var cat;
      if (flowOut) {
        if (defCat === 'infer') cat = mapExpenseCategory(desc);
        else cat = defCat;
      } else {
        if (!importRev) {
          skipped++;
          continue;
        }
        cat = mapIncomeCategory(desc);
      }
      var fp = txFingerprintForImport(dateY, amountPos, desc, ext);
      if (skipDup) {
        if (ext && existing.extIds[ext]) {
          skipped++;
          continue;
        }
        if (existing.fps[fp]) {
          skipped++;
          continue;
        }
        existing.fps[fp] = true;
        if (ext) existing.extIds[ext] = true;
      }
      out.push({
        date: dateY,
        description: desc || 'Imported',
        amount: amountPos,
        category: cat,
        externalId: ext || undefined,
        rawMemo: desc,
        flowLabel: flowOut ? 'Outflow' : 'Inflow',
      });
    }
    impWizardState.lastSkipCount = skipped;
    return out;
  }

  function renderImpPreviewTable(preview) {
    var tb = $('imp-preview-body');
    var sum = $('imp-preview-summary');
    if (sum) {
      var sk = impWizardState.lastSkipCount || 0;
      sum.textContent =
        'Ready to import ' +
        preview.length +
        ' row(s). ' +
        (sk ? sk + ' row(s) skipped (invalid or filtered).' : '');
    }
    if (!tb) return;
    var show = preview.slice(0, 50);
    var catLab = { lab: 'Labor', sw: 'Software & tools', ads: 'Advertising', oth: 'Other', svc: 'Services', ret: 'Retainers', own: 'Owner investment' };
    tb.innerHTML = show
      .map(function (p) {
        var cLab = catLab[p.category] || p.category || '—';
        return (
          '<tr><td>' +
          esc(p.date) +
          '</td><td>' +
          esc(p.flowLabel) +
          '</td><td>' +
          esc(cLab) +
          '</td><td class="tdp">' +
          esc(fmtCurrency(p.amount)) +
          '</td><td style="max-width:220px;" class="td-truncate" title="' +
          escAttr(p.description) +
          '">' +
          esc(p.description) +
          '</td></tr>'
        );
      })
      .join('');
    if (preview.length > 50 && sum) {
      sum.textContent += ' Showing first 50 rows in preview.';
    }
    var commit = $('imp-commit');
    if (commit) commit.textContent = 'Import ' + preview.length + ' row(s)';
  }

  async function persistImportedTransactionsThrottled(list) {
    if (isDemoDashboardUser()) return;
    for (var i = 0; i < list.length; i++) {
      await persistTransactionToSupabase(list[i]);
      if (i % 20 === 19) {
        await new Promise(function (res) {
          setTimeout(res, 40);
        });
      }
    }
  }

  function wireCsvImportAndJournalExport() {
    var modalImp = $('csvImportModal');
    var modalJ = $('journalExportModal');

    function openJournalExportModal() {
      if (!modalJ) return;
      var b = defaultJournalExportRange();
      var a = $('journal-exp-start');
      var e = $('journal-exp-end');
      if (a) a.value = b.start;
      if (e) e.value = b.end;
      var fmt = $('journal-exp-format');
      if (fmt) fmt.value = 'simple';
      modalJ.classList.add('on');
    }

    function closeJournalExportModal() {
      if (modalJ) modalJ.classList.remove('on');
    }

    function openCsvImportModal() {
      if (!modalImp) return;
      impWizardState = { step: 1, matrix: null, previewTxs: [], batchId: null, lastSkipCount: 0 };
      var f = $('imp-file');
      if (f) f.value = '';
      var st = $('imp-file-status');
      if (st) st.textContent = '';
      if ($('imp-import-revenue')) $('imp-import-revenue').checked = false;
      if ($('imp-skip-dupes')) $('imp-skip-dupes').checked = true;
      if ($('imp-amount-mode-single')) $('imp-amount-mode-single').checked = true;
      syncImpAmountModeUi();
      setImpStep(1);
      modalImp.classList.add('on');
    }

    function closeCsvImportModal() {
      if (modalImp) modalImp.classList.remove('on');
    }

    ['btn-csv-import-open', 'btn-csv-import-open-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', openCsvImportModal);
    });
    ['btn-journal-export-open', 'btn-journal-export-open-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', openJournalExportModal);
    });

    function runUndoLastImport() {
      var last = loadLastImportBatch();
      if (!last || !last.ids || !last.ids.length) return;
      if (!confirm('Remove the last CSV import (' + last.ids.length + ' transaction(s)) from this workspace?')) return;
      deleteTransactionsByIds(last.ids.slice());
      clearLastImportBatch();
      refreshUndoImportButtons();
    }
    ['btn-undo-last-import', 'btn-undo-last-import-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', runUndoLastImport);
    });

    var amtModeSingle = $('imp-amount-mode-single');
    var amtModeSplit = $('imp-amount-mode-split');
    if (amtModeSingle) amtModeSingle.addEventListener('change', syncImpAmountModeUi);
    if (amtModeSplit) amtModeSplit.addEventListener('change', syncImpAmountModeUi);

    var impFile = $('imp-file');
    if (impFile) {
      impFile.addEventListener('change', function () {
        var st = $('imp-file-status');
        var file = impFile.files && impFile.files[0];
        if (!file) {
          if (st) st.textContent = '';
          impWizardState.matrix = null;
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          var matrix = parseCsvToMatrix(text);
          impWizardState.matrix = matrix;
          var msg =
            'Found ' +
            matrix.rows.length +
            ' data row(s), ' +
            matrix.headers.length +
            ' column(s). Delimiter: ' +
            (matrix.delim === ';' ? 'semicolon' : 'comma') +
            '.';
          if (matrix.warnings && matrix.warnings.length) msg += ' ' + matrix.warnings.join(' ');
          if (st) st.textContent = msg;
        };
        reader.onerror = function () {
          if (st) st.textContent = 'Could not read file.';
          impWizardState.matrix = null;
        };
        reader.readAsText(file);
      });
    }

    var impNext = $('imp-next');
    if (impNext) {
      impNext.addEventListener('click', function () {
        if (impWizardState.step === 1) {
          if (!impWizardState.matrix || !impWizardState.matrix.headers.length) {
            alert('Choose a CSV file with a header row first.');
            return;
          }
          var guess = guessCsvColumnIndices(impWizardState.matrix.headers);
          fillImpColumnSelects(impWizardState.matrix.headers, guess);
          syncImpAmountModeUi();
          setImpStep(2);
          return;
        }
        if (impWizardState.step === 2) {
          var dateIdx = impSelectedIndex($('imp-col-date'));
          if (dateIdx < 0) {
            alert('Pick a date column.');
            return;
          }
          var split = $('imp-amount-mode-split') && $('imp-amount-mode-split').checked;
          if (split) {
            if (impSelectedIndex($('imp-col-debit')) < 0 && impSelectedIndex($('imp-col-credit')) < 0) {
              alert('Pick a Debit and/or Credit column.');
              return;
            }
          } else if (impSelectedIndex($('imp-col-amount')) < 0) {
            alert('Pick an amount column (or switch to Debit/Credit).');
            return;
          }
          impWizardState.previewTxs = buildImportPreviewTransactions();
          if (!impWizardState.previewTxs.length) {
            alert('No importable rows. Check column mapping and that outflows are negative in single-amount mode (or use Debit/Credit).');
            return;
          }
          renderImpPreviewTable(impWizardState.previewTxs);
          setImpStep(3);
        }
      });
    }

    var impBack = $('imp-back');
    if (impBack) {
      impBack.addEventListener('click', function () {
        if (impWizardState.step === 3) setImpStep(2);
        else if (impWizardState.step === 2) setImpStep(1);
      });
    }

    var impCancel = $('imp-cancel');
    if (impCancel) impCancel.addEventListener('click', closeCsvImportModal);

    var impCommit = $('imp-commit');
    if (impCommit) {
      impCommit.addEventListener('click', async function () {
        var preview = impWizardState.previewTxs || [];
        if (!preview.length) return;
        var batchId = uuid();
        var created = [];
        preview.forEach(function (p) {
          var tx = {
            id: uuid(),
            date: p.date,
            description: p.description,
            amount: p.amount,
            category: p.category,
            importBatchId: batchId,
            importSource: 'csv',
            createdAt: new Date().toISOString(),
          };
          if (p.externalId) tx.externalId = p.externalId;
          if (p.rawMemo) tx.rawMemo = p.rawMemo;
          state.transactions.push(tx);
          created.push(tx);
        });
        saveTransactions(state.transactions);
        recomputeAndRender();
        await persistImportedTransactionsThrottled(created);
        saveLastImportBatch(
          batchId,
          created.map(function (t) {
            return t.id;
          })
        );
        refreshUndoImportButtons();
        closeCsvImportModal();
      });
    }

    if (modalImp) {
      modalImp.addEventListener('click', function (ev) {
        if (ev.target === modalImp) closeCsvImportModal();
      });
    }

    var jCancel = $('journal-exp-cancel');
    if (jCancel) jCancel.addEventListener('click', closeJournalExportModal);
    var jDown = $('journal-exp-download');
    if (jDown) {
      jDown.addEventListener('click', function () {
        var a = $('journal-exp-start');
        var e = $('journal-exp-end');
        var startY = a && a.value ? a.value : defaultJournalExportRange().start;
        var endY = e && e.value ? e.value : defaultJournalExportRange().end;
        if (!startY || !endY || startY > endY) {
          alert('Pick a valid start and end date.');
          return;
        }
        var fmtEl = $('journal-exp-format');
        var fmt = fmtEl && fmtEl.value === 'split' ? 'split' : 'simple';
        var lines = buildJournalCsvLines(startY, endY, fmt);
        downloadTextFile('journal-export.csv', lines.join('\n'));
        closeJournalExportModal();
      });
    }
    if (modalJ) {
      modalJ.addEventListener('click', function (ev) {
        if (ev.target === modalJ) closeJournalExportModal();
      });
    }

    refreshUndoImportButtons();
  }

  function wireIncomeExpenseForms() {
    // Expenses tab
    var btnAddExpense = $('btn-add-expense');
    var btnExpenseSave = $('btn-expense-save');
    var btnExpenseCancel = $('btn-expense-cancel');

    if (btnAddExpense) btnAddExpense.addEventListener('click', function () { openExpenseModal(null); });
    if (btnExpenseCancel) btnExpenseCancel.addEventListener('click', closeExpenseModal);
    if (btnExpenseSave) {
      btnExpenseSave.addEventListener('click', function () {
        var amount = parseFloat(($('expense-amount').value || '').trim());
        if (!amount || amount <= 0) {
          alert('Enter a positive amount.');
          return;
        }
        var date = $('expense-date').value || todayISO();
        var title = $('expense-title').value || '';
        var catText = $('expense-category').value || '';
        var vendor = $('expense-vendor').value || '';
        var notes = $('expense-notes').value || '';
        var cat = mapExpenseCategory(catText);
        var titleTrim = (title || '').trim();
        var vendorTrim = (vendor || '').trim();
        var notesTrim = (notes || '').trim();
        var desc = titleTrim || vendorTrim || notesTrim;
        var clientIdRaw = $('expense-client') ? $('expense-client').value : '';
        var expenseClientId = clientIdRaw ? clientIdRaw : null;

        var editId = $('expense-edit-id') ? $('expense-edit-id').value : '';
        var recurring = $('expense-recurring') && $('expense-recurring').checked;
        if (editId) {
          var prevTx = state.transactions.find(function (t) { return t.id === editId; });
          state.transactions = state.transactions.map(function (tx) {
            if (tx.id !== editId) return tx;
            var next = {
              id: tx.id,
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
              clientId: expenseClientId,
            };
            if (recurring) {
              next.recurrenceSeriesId = (prevTx && prevTx.recurrenceSeriesId) ? prevTx.recurrenceSeriesId : uuid();
              next.expenseRecurringLead = true;
              next.recurrence = readExpenseRecurrenceRuleFromUi(date);
              if (prevTx && prevTx.recurrence && prevTx.recurrence.materializeNotBefore) {
                next.recurrence.materializeNotBefore = prevTx.recurrence.materializeNotBefore;
              } else {
                next.recurrence.materializeNotBefore = todayLocalYMD();
              }
              next.recurring = true;
            } else {
              if (prevTx && prevTx.expenseRecurrenceInstance) {
                next.recurrenceSeriesId = prevTx.recurrenceSeriesId;
                next.expenseRecurrenceInstance = true;
              }
            }
            return next;
          });
          saveTransactions(state.transactions);
          recomputeAndRender();
          var updated = state.transactions.find(function (t) { return t.id === editId; });
          if (updated) persistTransactionToSupabase(updated);
          if (recurring) {
            expandRecurringExpenseInstances();
            recomputeAndRender();
          }
        } else {
          if (recurring) {
            var seriesId = uuid();
            var recRule = readExpenseRecurrenceRuleFromUi(date);
            recRule.materializeNotBefore = todayLocalYMD();
            addTransaction({
              id: uuid(),
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
              clientId: expenseClientId,
              recurrenceSeriesId: seriesId,
              expenseRecurringLead: true,
              recurrence: recRule,
              recurring: true,
            });
            expandRecurringExpenseInstances();
            recomputeAndRender();
          } else {
            addTransaction({
              id: uuid(),
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
              clientId: expenseClientId,
            });
          }
        }
        closeExpenseModal();
      });
    }

    // Income tab
    var btnAddIncome = $('btn-add-income');
    var btnIncomeSave = $('btn-income-save');
    var btnIncomeCancel = $('btn-income-cancel');

    if (btnAddIncome) btnAddIncome.addEventListener('click', openIncomeModal);
    if (btnIncomeCancel) btnIncomeCancel.addEventListener('click', closeIncomeModal);
    if (btnIncomeSave) {
      btnIncomeSave.addEventListener('click', function () {
        var amount = parseFloat(($('income-amount').value || '').trim());
        if (!amount || amount <= 0) {
          alert('Enter a positive amount.');
          return;
        }
        var date = $('income-date').value || todayISO();
        var source = $('income-source').value || '';
        var catText = ($('income-category').value || '').trim();
        var notes = $('income-notes').value || '';
        var cat = mapIncomeCategory(catText);
        var desc = source || notes;
        var clientId = $('income-client') ? $('income-client').value : '';
        var projectId = $('income-project') ? $('income-project').value : '';
        var editId = $('income-edit-id') ? $('income-edit-id').value : '';
        if (editId) {
          state.transactions = state.transactions.map(function (tx) {
            if (tx.id !== editId) return tx;
            var next = Object.assign({}, tx, {
              date: date,
              description: desc,
              amount: amount,
              category: cat,
              clientId: clientId || null,
              projectId: projectId || null,
            });
            if (catText) next.incomeCategoryLabel = catText;
            else delete next.incomeCategoryLabel;
            return next;
          });
          saveTransactions(state.transactions);
          recomputeAndRender();
          var incomeUpdated = state.transactions.find(function (t) { return t.id === editId; });
          if (incomeUpdated) persistTransactionToSupabase(incomeUpdated);
        } else {
          var newInc = {
            id: uuid(),
            date: date,
            description: desc,
            amount: amount,
            category: cat,
            clientId: clientId || null,
            projectId: projectId || null,
          };
          if (catText) newInc.incomeCategoryLabel = catText;
          addTransaction(newInc);
        }
        closeIncomeModal();
      });
    }
  }

  function wireInvoiceModal() {
    var modal = $('invoiceModal');
    if (!modal) return;
    var btnCancel = $('btn-invoice-cancel');
    var btnSave = $('btn-invoice-save');

    function closeInvoiceModal() {
      if (modal) modal.classList.remove('on');
    }

    if (btnCancel) btnCancel.addEventListener('click', closeInvoiceModal);
    if (btnSave) {
      btnSave.addEventListener('click', function () {
        var txId = $('invoice-income-id') ? $('invoice-income-id').value : '';
        if (!txId) {
          closeInvoiceModal();
          return;
        }
        var issueDate = $('invoice-issue-date') ? $('invoice-issue-date').value : '';
        var dueDate = $('invoice-due-date') ? $('invoice-due-date').value : '';
        var number = $('invoice-number') ? $('invoice-number').value.trim() : '';
        var amountRaw = $('invoice-amount') ? $('invoice-amount').value : '';
        var amount = parseFloat(amountRaw || '0');

        if (!number) {
          alert('Invoice number is required.');
          return;
        }
        if (!issueDate || !dueDate) {
          alert('Issue and due dates are required.');
          return;
        }
        if (!amount || amount <= 0) {
          alert('Invoice amount must be greater than 0.');
          return;
        }

        var existing = getInvoiceByIncomeTxId(txId);
        if (existing) {
          invoices = invoices.map(function (inv) {
            if (inv.incomeTxId !== txId) return inv;
            return Object.assign({}, inv, {
              id: inv.id,
              incomeTxId: txId,
              number: number,
              dateIssued: issueDate,
              dueDate: dueDate,
              amount: amount,
              status: inv.status || 'sent',
              paidAt: inv.paidAt || null,
            });
          });
        } else {
          invoices.push({
            id: uuid(),
            incomeTxId: txId,
            number: number,
            dateIssued: issueDate,
            dueDate: dueDate,
            amount: amount,
            status: 'sent',
            paidAt: null,
          });
        }
        saveInvoices(invoices);
        recomputeAndRender();
        var invSaved = getInvoiceByIncomeTxId(txId);
        if (invSaved) persistInvoiceToSupabase(invSaved);
        closeInvoiceModal();
      });
    }
  }

  function wireInvoicePreviewModal() {
    var modal = $('invoicePreviewModal');
    if (!modal) return;
    var btnClose = $('btn-invoice-preview-close');
    var btnPrint = $('btn-invoice-preview-print');
    function closePreview() {
      modal.classList.remove('on');
    }
    if (btnClose) btnClose.addEventListener('click', closePreview);
    if (btnPrint) btnPrint.addEventListener('click', printCurrentInvoicePreview);
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) closePreview();
    });
  }

  function wireDeleteHandlers() {
    var txTable = $('transaction-log-table');
    if (txTable && txTable.getAttribute('data-bizdash-del-wired') !== '1') {
      txTable.setAttribute('data-bizdash-del-wired', '1');
      txTable.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-tx-del]');
        if (!btn) return;
        var id = btn.getAttribute('data-tx-del');
        if (!id) return;
        if (confirm('Delete this transaction?')) {
          deleteTransaction(id);
        }
      });
    }

    var expTable = $('expenses-table');
    if (expTable && expTable.getAttribute('data-bizdash-del-wired') !== '1') {
      expTable.setAttribute('data-bizdash-del-wired', '1');
      expTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-exp-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-exp-edit');
          if (!editId) return;
          var tx = state.transactions.find(function (t) { return t.id === editId; });
          if (!tx) return;
          var labelMap = {
            lab: 'Labor',
            sw: 'Software',
            ads: 'Advertising',
            oth: 'Other',
          };
          openExpenseModal({
            id: tx.id,
            date: tx.date,
            amount: tx.amount,
            categoryLabel: labelMap[tx.category] || tx.category || '',
            title: tx.title,
            vendor: tx.vendor,
            notes: tx.notes,
            description: tx.description,
            clientId: tx.clientId,
            expenseRecurringLead: tx.expenseRecurringLead,
            recurrence: tx.recurrence,
          });
          return;
        }

        var delBtn = ev.target.closest('[data-exp-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-exp-del');
        if (!id) return;
        var delTx = state.transactions.find(function (t) { return t.id === id; });
        if (delTx && delTx.expenseRecurringLead && delTx.recurrenceSeriesId) {
          if (!confirm('Delete this recurring expense and all auto-generated occurrences in the series?')) return;
          var sid = delTx.recurrenceSeriesId;
          var ids = state.transactions.filter(function (t) { return t.recurrenceSeriesId === sid; }).map(function (t) { return t.id; });
          deleteTransactionsByIds(ids);
          return;
        }
        if (confirm('Delete this expense transaction?')) {
          deleteTransaction(id);
        }
      });
    }

    var mktPipe = $('marketing-pipeline');
    if (mktPipe) {
      mktPipe.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-campaign-edit]');
        if (editBtn) {
          var eid = editBtn.getAttribute('data-campaign-edit');
          if (eid) openCampaignModal(eid);
          return;
        }
        var delBtn = ev.target.closest('[data-campaign-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-campaign-del');
        if (!id || !confirm('Remove this campaign?')) return;
        campaigns = campaigns.filter(function (c) { return c.id !== id; });
        saveCampaigns(campaigns);
        deleteCampaignRemote(id);
        renderMarketing();
      });
    }

    var custTable = $('customers-table');
    if (custTable) {
      custTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-client-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-client-edit');
          if (!editId) return;
          var client = clients.find(function (c) { return c.id === editId; });
          if (!client) return;
          var m = $('clientModal');
          if (!m) return;
          (async function () {
            await wfRefreshFromSupabase();
            populateClientIndustryDatalist();
            var hiddenId = $('client-edit-id');
            if (hiddenId) hiddenId.value = client.id;
            $('client-company').value = client.companyName || '';
            $('client-contact').value = client.contactName || '';
            $('client-status').value = client.status || '';
            $('client-industry').value = client.industry || '';
            $('client-email').value = client.email || '';
            $('client-phone').value = client.phone || '';
            $('client-notes').value = client.notes || '';
            if ($('client-salutation')) $('client-salutation').value = client.salutation || '';
            if ($('client-first-name')) $('client-first-name').value = client.firstName || '';
            if ($('client-last-name')) $('client-last-name').value = client.lastName || '';
            if ($('client-title')) $('client-title').value = client.title || '';
            if ($('client-reports-to')) $('client-reports-to').value = client.reportsTo || '';
            if ($('client-description')) $('client-description').value = client.description || '';
            if ($('client-owner')) $('client-owner').value = client.owner || '';
            if ($('client-mailing-country')) $('client-mailing-country').value = client.mailingCountry || '';
            if ($('client-mailing-street')) $('client-mailing-street').value = client.mailingStreet || '';
            if ($('client-mailing-city')) $('client-mailing-city').value = client.mailingCity || '';
            if ($('client-mailing-state')) $('client-mailing-state').value = client.mailingState || '';
            if ($('client-mailing-zip')) $('client-mailing-zip').value = client.mailingZip || '';
            if ($('client-email-opt-out')) $('client-email-opt-out').checked = client.emailOptOut === true;
            if ($('client-birthday')) $('client-birthday').value = client.birthday || '';
            if ($('client-preferred-channel')) $('client-preferred-channel').value = client.preferredChannel || '';
            if ($('client-communication-style')) $('client-communication-style').value = client.communicationStyle || '';
            if ($('client-last-touch')) $('client-last-touch').value = client.lastTouchAt || '';
            if ($('client-next-follow-up')) $('client-next-follow-up').value = client.nextFollowUpAt || '';
            if ($('client-relationship-notes')) $('client-relationship-notes').value = client.relationshipNotes || '';
            var cr = $('client-cust-revenue');
            var cc = $('client-cust-cost');
            if (cr) cr.value = client.custTabRevenue != null ? String(client.custTabRevenue) : '';
            if (cc) cc.value = client.custTabAllocatedCost != null ? String(client.custTabAllocatedCost) : '';
            var retCb = $('client-retainer');
            if (retCb) retCb.checked = client.retainer === true;
            wfFillClientPipelineSelect($('client-pipeline-stage'), client);
            m.classList.add('on');
          })();
          return;
        }

        var meetBtn = ev.target.closest('[data-log-meeting]');
        if (meetBtn) {
          var mid = meetBtn.getAttribute('data-log-meeting');
          var cl = clients.find(function (c) { return c.id === mid; });
          if (!cl) return;
          var notes = window.prompt('Meeting notes (optional):', '') || '';
          (async function () {
            var act = await wfInsertActivity(cl.id, 'meeting', notes, new Date().toISOString());
            if (act) {
              await addCrmEvent('meeting', 'Meeting logged for ' + (cl.companyName || 'client'), { notes: notes, activityId: act.id }, cl.id, 'meeting:' + act.id);
              await runWorkflowDispatch({ kind: 'activity_created', activity: { id: act.id, activity_type: act.activity_type }, client: wfCloneClientForWorkflow(cl) });
              renderPersonableCards();
            } else {
              alert('Could not save meeting (sign in and ensure crm_activities table exists — run workflow_automation.sql).');
            }
          })();
          return;
        }

        var delBtn = ev.target.closest('[data-client-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-client-del');
        if (!id) return;
        if (confirm('Delete this client?')) {
          clients = clients.filter(function (c) { return c.id !== id; });
          saveClients(clients);
          renderClients();
          if (state.computed) renderInsights();
          deleteClientRemote(id);
        }
      });
    }

    var projTable = $('projects-table');
    if (projTable) {
      projTable.addEventListener('change', function (ev) {
        var sel = ev.target;
        if (!sel || !sel.classList || !sel.classList.contains('project-row-status')) return;
        var pid = sel.getAttribute('data-project-status-id');
        if (!pid) return;
        var proj = projects.find(function (p) { return p.id === pid; });
        if (!proj) return;
        var next = sel.value || '';
        if ((proj.status || '') === next) return;
        proj.status = next;
        saveProjects(projects);
        persistProjectToSupabase(proj);
        renderProjectKpisAndCharts();
        if (state.computed) renderInsights();
      });
      projTable.addEventListener('click', function (ev) {
        var csBtn = ev.target.closest('[data-project-casestudy]');
        if (csBtn) {
          var csId = csBtn.getAttribute('data-project-casestudy');
          if (csId) openCaseStudyViewModal(csId);
          return;
        }
        var editBtn = ev.target.closest('[data-project-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-project-edit');
          if (!editId) return;
          var proj = projects.find(function (p) { return p.id === editId; });
          if (!proj) return;
          var m = $('projectModal');
          if (!m) return;
          var hiddenId = $('project-edit-id');
          if (hiddenId) hiddenId.value = proj.id;
          $('project-name').value = proj.name || '';
          populateProjectClientOptions();
          if (proj.clientId && $('project-client')) $('project-client').value = proj.clientId;
          populateProjectStatusOptions();
          if (proj.status && $('project-status')) $('project-status').value = proj.status;
          $('project-category').value = proj.type || '';
          $('project-start').value = proj.startDate || '';
          $('project-due').value = proj.dueDate || '';
          $('project-value').value = proj.value != null ? String(proj.value) : '';
          $('project-desc').value = proj.description || '';
          $('project-notes').value = proj.notes || '';
          if ($('project-satisfaction')) $('project-satisfaction').value = typeof proj.satisfaction === 'number' ? String(proj.satisfaction) : '';
          var archived = $('project-archived');
          if (archived) archived.checked = !!proj.archived;
          fillCaseStudyForm(proj);
          var det = $('project-case-study-details');
          var detBody = $('project-case-study-body');
          if (det && detBody) {
            det.open = false;
            animateRollout(detBody, false, true);
          }
          m.classList.add('on');
          return;
        }

        var delBtn = ev.target.closest('[data-project-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-project-del');
        if (!id) return;
        if (confirm('Delete this project?')) {
          projects = projects.filter(function (p) { return p.id !== id; });
          saveProjects(projects);
          deleteProjectRemote(id);
          renderProjects();
          populateIncomeProjectOptions();
          if (state.computed) renderInsights();
        }
      });
    }

    var incomeTable = $('income-table');
    if (incomeTable) {
      incomeTable.addEventListener('click', function (ev) {
        var createInvBtn = ev.target.closest('[data-income-invoice-create]');
        if (createInvBtn) {
          var createTxId = createInvBtn.getAttribute('data-income-invoice-create');
          if (!createTxId) return;
          createOrEditInvoiceForIncomeTx(createTxId, false);
          return;
        }

        var editInvBtn = ev.target.closest('[data-income-invoice-edit]');
        if (editInvBtn) {
          var editTxId = editInvBtn.getAttribute('data-income-invoice-edit');
          if (!editTxId) return;
          createOrEditInvoiceForIncomeTx(editTxId, true);
          return;
        }

        var viewInvBtn = ev.target.closest('[data-income-invoice-view]');
        if (viewInvBtn) {
          var viewTxId = viewInvBtn.getAttribute('data-income-invoice-view');
          if (!viewTxId) return;
          openInvoicePreviewForIncomeTx(viewTxId);
          return;
        }

        var payBtn = ev.target.closest('[data-income-invoice-pay]');
        if (payBtn) {
          var payTxId = payBtn.getAttribute('data-income-invoice-pay');
          if (!payTxId) return;
          var invPay = getInvoiceByIncomeTxId(payTxId);
          if (!invPay) {
            alert('Create the invoice first.');
            return;
          }
          startStripeCheckoutForInvoice(invPay);
          return;
        }

        var paidBtn = ev.target.closest('[data-income-invoice-paid]');
        if (paidBtn) {
          var paidTxId = paidBtn.getAttribute('data-income-invoice-paid');
          if (!paidTxId) return;
          invoices = invoices.map(function (inv) {
            if (inv.incomeTxId !== paidTxId) return inv;
            return Object.assign({}, inv, {
              status: 'paid',
              paidAt: new Date().toISOString().slice(0, 10),
            });
          });
          saveInvoices(invoices);
          recomputeAndRender();
          var invPaid = getInvoiceByIncomeTxId(paidTxId);
          if (invPaid) persistInvoiceToSupabase(invPaid);
          return;
        }

        var editBtn = ev.target.closest('[data-income-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-income-edit');
          if (!editId) return;
          var tx = state.transactions.find(function (t) { return t.id === editId; });
          if (!tx) return;
          var m = $('incomeModal');
          if (!m) return;
          var hiddenId = $('income-edit-id');
          if (hiddenId) hiddenId.value = tx.id;
          var fDate = $('income-date');
          var fAmount = $('income-amount');
          var fSource = $('income-source');
          var fCat = $('income-category');
          var fNotes = $('income-notes');
          if (fDate) fDate.value = tx.date || todayISO();
          if (fAmount) fAmount.value = tx.amount != null ? String(tx.amount) : '';
          if (fSource) fSource.value = tx.description || '';
          if (fCat) fCat.value = displayIncomeCategory(tx);
          if (fNotes) fNotes.value = '';
          populateIncomeClientOptions();
          populateIncomeProjectOptions();
          if (tx.clientId && $('income-client')) $('income-client').value = tx.clientId;
          if (tx.projectId && $('income-project')) $('income-project').value = tx.projectId;
          m.classList.add('on');
          return;
        }

        var delBtn = ev.target.closest('[data-income-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-income-del');
        if (!id) return;
        if (confirm('Delete this income entry?')) {
          deleteTransaction(id);
        }
      });
    }
  }

  function refreshCloudSyncStatus() {
    var el = $('settings-cloud-status');
    var syncBtn = $('settings-btn-cloud-sync');
    var authBtn = $('settings-btn-cloud-auth');
    supabase = window.supabaseClient || supabase;
    var user = window.currentUser || currentUser;
    if (!el) return;
    if (!window.supabaseClient) {
      el.textContent = 'Cloud: Supabase not loaded';
      if (syncBtn) syncBtn.disabled = true;
      return;
    }
    if (!user) {
      el.textContent = 'Cloud: sign in (gate or below) to sync clients and data across browsers.';
      if (syncBtn) syncBtn.disabled = true;
      if (authBtn) authBtn.textContent = 'Sign in';
      return;
    }
    if (isDemoDashboardUser()) {
      el.textContent = 'Demo mode: sample data only. Tap Exit demo to return to the login screen.';
      if (syncBtn) syncBtn.disabled = true;
      if (authBtn) authBtn.textContent = 'Exit demo';
      return;
    }
    el.textContent = 'Cloud: ' + (user.email || 'Signed in') + ' · ' + (clients && clients.length) + ' client(s) in this workspace';
    if (syncBtn) syncBtn.disabled = false;
    if (authBtn) authBtn.textContent = 'Sign out';
  }

  function openCloudAuthModal() {
    var m = $('cloudAuthModal');
    if (m) m.classList.add('on');
  }

  function closeCloudAuthModal() {
    var m = $('cloudAuthModal');
    if (m) m.classList.remove('on');
  }

  function wireCloudSyncPanel() {
    refreshCloudSyncStatus();

    var authBtn = $('settings-btn-cloud-auth');
    var syncBtn = $('settings-btn-cloud-sync');

    if (authBtn) {
      authBtn.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        var user = window.currentUser || currentUser;
        if (user && isDemoDashboardUser()) {
          window.currentUser = null;
          currentUser = null;
          setScreenshotNoCloudUpload(false);
          if (typeof window.clearRuntimeDataForAuthChange === 'function') {
            window.clearRuntimeDataForAuthChange(null);
          }
          if (typeof window.__dashboardShowLogin === 'function') {
            window.__dashboardShowLogin();
          }
          refreshCloudSyncStatus();
          return;
        }
        if (user && supabase) {
          try {
            await supabase.auth.signOut();
          } catch (e) {
            console.error('signOut error', e);
          }
          refreshCloudSyncStatus();
          return;
        }
        openCloudAuthModal();
      });
    }

    if (syncBtn) {
      syncBtn.addEventListener('click', async function () {
        if (!window.currentUser) {
          alert('Sign in with the same account you use on your other browser, then tap Sync. Data lives in the cloud per account, not in the browser alone.');
          openCloudAuthModal();
          return;
        }
        var label = syncBtn.textContent;
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing…';
        try {
          await initDataFromSupabase();
          await persistAppSettingsToSupabase();
          refreshCloudSyncStatus();
          syncBtn.textContent = 'Done';
          setTimeout(function () { syncBtn.textContent = label || 'Sync'; }, 1800);
        } catch (e) {
          console.error('Sync error', e);
          alert('Sync failed: ' + ((e && e.message) || String(e)));
          syncBtn.textContent = label || 'Sync';
        } finally {
          refreshCloudSyncStatus();
        }
      });
    }

    var btnCancel = $('btn-cloud-auth-cancel');
    if (btnCancel) btnCancel.addEventListener('click', closeCloudAuthModal);
    var modal = $('cloudAuthModal');
    if (modal) {
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) closeCloudAuthModal();
      });
    }

    var btnSignin = $('btn-cloud-auth-signin');
    if (btnSignin) {
      btnSignin.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        var emailEl = $('cloud-auth-email');
        var passEl = $('cloud-auth-password');
        var email = emailEl && emailEl.value.trim();
        var password = passEl && passEl.value;
        if (!email || !password) {
          alert('Enter email and password.');
          return;
        }
        try {
          var res = await supabase.auth.signInWithPassword({ email: email, password: password });
          if (res.error) {
            alert(res.error.message || 'Sign-in failed.');
            return;
          }
          closeCloudAuthModal();
        } catch (err) {
          console.error('cloud modal signin', err);
          alert('Sign-in failed.');
        }
      });
    }

    var btnSignup = $('btn-cloud-auth-signup');
    if (btnSignup) {
      btnSignup.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        var emailEl = $('cloud-auth-email');
        var passEl = $('cloud-auth-password');
        var email = emailEl && emailEl.value.trim();
        var password = passEl && passEl.value;
        if (!email || !password) {
          alert('Enter email and password.');
          return;
        }
        try {
          var res = await supabase.auth.signUp({ email: email, password: password });
          if (res.error) {
            alert(res.error.message || 'Sign-up failed.');
            return;
          }
          alert('Check your email to confirm your account if required, then sign in.');
        } catch (err) {
          console.error('cloud modal signup', err);
          alert('Sign-up failed.');
        }
      });
    }

    var btnGh = $('btn-cloud-auth-github');
    if (btnGh) {
      btnGh.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        if (!supabase) return;
        try {
          var redirectTo = window.location.origin + (window.location.pathname || '/') + (window.location.search || '');
          var res = await supabase.auth.signInWithOAuth({
            provider: 'github',
            options: { redirectTo: redirectTo },
          });
          if (res.error) alert(res.error.message || 'GitHub sign-in failed.');
        } catch (err) {
          console.error('cloud modal github', err);
          alert('GitHub sign-in failed.');
        }
      });
    }
  }

  window.refreshCloudSyncStatus = refreshCloudSyncStatus;

  // ---------- Client form wiring ----------

  function populateClientIndustryDatalist() {
    var dl = document.getElementById('client-industry-list');
    if (!dl) return;
    var seen = {};
    var list = [];
    (clients || []).forEach(function (c) {
      if (!c || !c.industry) return;
      var v = String(c.industry).trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      list.push(v);
    });
    list.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base' }); });
    dl.innerHTML = list.map(function (v) {
      return '<option value="' + esc(v) + '"></option>';
    }).join('');
  }

  function wireClientForm() {
    var btnAddClient = $('btn-add-client');
    var btnClientSave = $('btn-client-save');
    var btnClientCancel = $('btn-client-cancel');

    function openClientModal() {
      var m = $('clientModal');
      if (!m) return;
      var editId = $('client-edit-id');
      if (editId) editId.value = '';
      $('client-company').value = '';
      $('client-contact').value = '';
      $('client-status').value = '';
      $('client-industry').value = '';
      $('client-email').value = '';
      $('client-phone').value = '';
      $('client-notes').value = '';
      if ($('client-salutation')) $('client-salutation').value = '';
      if ($('client-first-name')) $('client-first-name').value = '';
      if ($('client-last-name')) $('client-last-name').value = '';
      if ($('client-title')) $('client-title').value = '';
      if ($('client-reports-to')) $('client-reports-to').value = '';
      if ($('client-description')) $('client-description').value = '';
      if ($('client-owner')) $('client-owner').value = '';
      if ($('client-mailing-country')) $('client-mailing-country').value = '';
      if ($('client-mailing-street')) $('client-mailing-street').value = '';
      if ($('client-mailing-city')) $('client-mailing-city').value = '';
      if ($('client-mailing-state')) $('client-mailing-state').value = '';
      if ($('client-mailing-zip')) $('client-mailing-zip').value = '';
      if ($('client-email-opt-out')) $('client-email-opt-out').checked = false;
      if ($('client-birthday')) $('client-birthday').value = '';
      if ($('client-preferred-channel')) $('client-preferred-channel').value = '';
      if ($('client-communication-style')) $('client-communication-style').value = '';
      if ($('client-last-touch')) $('client-last-touch').value = '';
      if ($('client-next-follow-up')) $('client-next-follow-up').value = '';
      if ($('client-relationship-notes')) $('client-relationship-notes').value = '';
      var cr = $('client-cust-revenue');
      var cc = $('client-cust-cost');
      if (cr) cr.value = '';
      if (cc) cc.value = '';
      var retCb = $('client-retainer');
      if (retCb) retCb.checked = false;
      var ps = $('client-pipeline-stage');
      if (ps) ps.innerHTML = '<option value="">— None —</option>';
      populateClientIndustryDatalist();
      m.classList.add('on');
    }

    function closeClientModal() {
      var m = $('clientModal');
      if (m) m.classList.remove('on');
    }

    if (btnAddClient) {
      btnAddClient.addEventListener('click', async function () {
        await wfRefreshFromSupabase();
        openClientModal();
        wfFillClientPipelineSelect($('client-pipeline-stage'), null);
      });
    }
    if (btnClientCancel) btnClientCancel.addEventListener('click', closeClientModal);
    if (btnClientSave) {
      btnClientSave.addEventListener('click', async function () {
        var company = $('client-company').value.trim();
        if (!company) {
          alert('Company name is required.');
          return;
        }
        function val(id) {
          var el = $(id);
          return el ? String(el.value || '').trim() : '';
        }
        var firstName = val('client-first-name');
        var lastName = val('client-last-name');
        var contactName = val('client-contact') || [firstName, lastName].filter(Boolean).join(' ');
        var existingId = $('client-edit-id') ? $('client-edit-id').value : '';
        var retainerChecked = $('client-retainer') && $('client-retainer').checked;
        var emailOptOut = $('client-email-opt-out') && $('client-email-opt-out').checked;
        var client;
        supabase = window.supabaseClient || supabase;
        currentUser = window.currentUser || currentUser;

        function parseCustTabMoney(el) {
          if (!el) return null;
          var s = String(el.value || '').trim();
          if (s === '') return null;
          var n = parseFloat(s);
          return isNaN(n) ? null : Math.max(0, n);
        }
        var custRev = parseCustTabMoney($('client-cust-revenue'));
        var custCost = parseCustTabMoney($('client-cust-cost'));

        var stageSel = $('client-pipeline-stage');
        var stageIdPick = stageSel && stageSel.value ? stageSel.value : '';
        function applyPipelineFieldsFromUi(cl) {
          if (!cl) return;
          if (stageIdPick) {
            var st = wfStages.find(function (s) { return s.id === stageIdPick; });
            if (st) {
              cl.pipelineId = st.pipelineId;
              cl.pipelineStageId = st.id;
              if (!val('client-status')) cl.status = st.label;
            }
          } else {
            cl.pipelineStageId = null;
            cl.pipelineId = null;
          }
        }

        var prevForWf = null;
        if (existingId) {
          var prevRow = clients.find(function (x) { return x.id === existingId; });
          prevForWf = wfCloneClientForWorkflow(prevRow);
        }

        if (existingId) {
          var clientsSnapshot = JSON.stringify(clients);
          clients = clients.map(function (c) {
            if (c.id !== existingId) return c;
            client = {
              id: c.id,
              companyName: company,
              contactName: contactName,
              status: val('client-status'),
              industry: val('client-industry'),
              email: val('client-email'),
              phone: val('client-phone'),
              notes: val('client-notes'),
              birthday: $('client-birthday') ? $('client-birthday').value : '',
              preferredChannel: val('client-preferred-channel'),
              communicationStyle: val('client-communication-style'),
              lastTouchAt: $('client-last-touch') ? $('client-last-touch').value : '',
              nextFollowUpAt: $('client-next-follow-up') ? $('client-next-follow-up').value : '',
              relationshipNotes: val('client-relationship-notes'),
              salutation: val('client-salutation'),
              firstName: firstName,
              lastName: lastName,
              title: val('client-title'),
              reportsTo: val('client-reports-to'),
              description: val('client-description'),
              owner: val('client-owner'),
              accountName: company,
              mailingCountry: val('client-mailing-country'),
              mailingStreet: val('client-mailing-street'),
              mailingCity: val('client-mailing-city'),
              mailingState: val('client-mailing-state'),
              mailingZip: val('client-mailing-zip'),
              emailOptOut: !!emailOptOut,
              totalRevenue: c.totalRevenue || 0,
              createdAt: c.createdAt || Date.now(),
              retainer: !!retainerChecked,
            };
            if (custRev != null) client.custTabRevenue = custRev;
            if (custCost != null) client.custTabAllocatedCost = custCost;
            applyPipelineFieldsFromUi(client);
            return client;
          });
          saveClients(clients);
          renderClients();
          if (state.computed) renderInsights();
          if (supabase && currentUser && client) {
            var editSync = await persistClientToSupabase(client, 'update');
            if (editSync === 'error') {
              try {
                clients = JSON.parse(clientsSnapshot);
              } catch (_) {}
              saveClients(clients);
              renderClients();
              if (state.computed) renderInsights();
              alert('Could not update this client in the cloud. Your changes were reverted.\n\n' + (persistClientLastError || 'Check the browser console and Supabase RLS rules.'));
              return;
            }
            await runWorkflowDispatch({ kind: 'client_updated', before: prevForWf, after: wfCloneClientForWorkflow(client) });
          }
        } else {
          if (!supabase || !currentUser) {
            alert('You must be signed in to add a client. New clients are saved to your cloud account only.');
            return;
          }
          client = {
            id: uuid(),
            companyName: company,
            contactName: contactName,
            status: val('client-status'),
            industry: val('client-industry'),
            email: val('client-email'),
            phone: val('client-phone'),
            notes: val('client-notes'),
            birthday: $('client-birthday') ? $('client-birthday').value : '',
            preferredChannel: val('client-preferred-channel'),
            communicationStyle: val('client-communication-style'),
            lastTouchAt: $('client-last-touch') ? $('client-last-touch').value : '',
            nextFollowUpAt: $('client-next-follow-up') ? $('client-next-follow-up').value : '',
            relationshipNotes: val('client-relationship-notes'),
            salutation: val('client-salutation'),
            firstName: firstName,
            lastName: lastName,
            title: val('client-title'),
            reportsTo: val('client-reports-to'),
            description: val('client-description'),
            owner: val('client-owner'),
            accountName: company,
            mailingCountry: val('client-mailing-country'),
            mailingStreet: val('client-mailing-street'),
            mailingCity: val('client-mailing-city'),
            mailingState: val('client-mailing-state'),
            mailingZip: val('client-mailing-zip'),
            emailOptOut: !!emailOptOut,
            totalRevenue: 0,
            createdAt: Date.now(),
            retainer: !!retainerChecked,
          };
          if (custRev != null) client.custTabRevenue = custRev;
          if (custCost != null) client.custTabAllocatedCost = custCost;
          applyPipelineFieldsFromUi(client);
          var addSync = await persistClientToSupabase(client, 'insert');
          if (addSync === 'skipped') {
            alert('Could not save this client: you are not signed in or your session expired.\n\n' + (persistClientLastError || 'Sign in again and retry.'));
            return;
          }
          if (addSync !== 'ok') {
            alert('Could not save this client to the cloud. Nothing was added.\n\n' + (persistClientLastError || 'Check the browser console and Supabase RLS rules.'));
            return;
          }
          clients.push(client);
          saveClients(clients);
          renderClients();
          if (state.computed) renderInsights();
          await runWorkflowDispatch({ kind: 'client_updated', before: null, after: wfCloneClientForWorkflow(client) });
        }
        if (client) {
          if (client.lastTouchAt) {
            addCrmEvent('touch', 'Last touch updated for ' + (client.companyName || 'client'), { lastTouchAt: client.lastTouchAt }, client.id, 'touch:' + client.id + ':' + client.lastTouchAt);
          }
          if (client.nextFollowUpAt) {
            addCrmEvent('follow_up', 'Follow-up scheduled for ' + (client.companyName || 'client'), { nextFollowUpAt: client.nextFollowUpAt }, client.id, 'followup:' + client.id + ':' + client.nextFollowUpAt);
          }
        }
        refreshCloudSyncStatus();
        populateProjectClientOptions();
        populateIncomeClientOptions();
        closeClientModal();
      });
    }

    window.bizDashOpenClientModalWithDraft = async function (draft) {
      await wfRefreshFromSupabase();
      var d = draft && typeof draft === 'object' ? draft : {};
      var m = $('clientModal');
      if (!m) return;
      var editId = $('client-edit-id');
      if (editId) editId.value = '';
      function setv(id, val) {
        var el = $(id);
        if (el) el.value = val == null ? '' : String(val);
      }
      setv('client-company', d.companyName);
      setv('client-contact', d.contactName);
      setv('client-status', d.status || 'Lead');
      setv('client-industry', d.industry);
      setv('client-email', d.email);
      setv('client-phone', d.phone);
      setv('client-notes', d.notes);
      setv('client-salutation', d.salutation);
      setv('client-first-name', d.firstName);
      setv('client-last-name', d.lastName);
      setv('client-title', d.title);
      setv('client-reports-to', d.reportsTo);
      setv('client-description', d.description);
      setv('client-owner', d.owner);
      setv('client-mailing-country', d.mailingCountry);
      setv('client-mailing-street', d.mailingStreet);
      setv('client-mailing-city', d.mailingCity);
      setv('client-mailing-state', d.mailingState);
      setv('client-mailing-zip', d.mailingZip);
      var optOut = $('client-email-opt-out');
      if (optOut) optOut.checked = !!d.emailOptOut;
      setv('client-birthday', d.birthday);
      setv('client-preferred-channel', d.preferredChannel);
      setv('client-communication-style', d.communicationStyle);
      setv('client-last-touch', d.lastTouchAt);
      setv('client-next-follow-up', d.nextFollowUpAt);
      setv('client-relationship-notes', d.relationshipNotes);
      var cr = $('client-cust-revenue');
      var cc = $('client-cust-cost');
      if (cr) cr.value = '';
      if (cc) cc.value = '';
      var retCb = $('client-retainer');
      if (retCb) retCb.checked = !!d.retainer;
      var stageSel = $('client-pipeline-stage');
      if (stageSel) {
        if (d.pipelineId && d.pipelineStageId) {
          wfFillClientPipelineSelect(stageSel, { pipelineId: d.pipelineId, pipelineStageId: d.pipelineStageId });
        } else {
          wfFillClientPipelineSelect(stageSel, null);
        }
      }
      populateClientIndustryDatalist();
      m.classList.add('on');
    };
  }

  // ---------- Projects & statuses wiring ----------

  function wireProjectsAndStatuses() {
    var btnAddProject = $('btn-add-project');
    var btnProjectSave = $('btn-project-save');
    var btnProjectCancel = $('btn-project-cancel');
    var btnManageStatuses = $('btn-manage-statuses');
    var btnStatusClose = $('btn-status-close');
    var btnStatusAdd = $('btn-status-add');
    var statusInput = $('status-new-label');
    var statusList = $('status-list');
    var caseStudyDetails = $('project-case-study-details');
    var caseStudyBody = $('project-case-study-body');

    if (caseStudyDetails && caseStudyBody && caseStudyDetails.getAttribute('data-rollout-wired') !== '1') {
      caseStudyDetails.setAttribute('data-rollout-wired', '1');
      animateRollout(caseStudyBody, false, true);
      caseStudyDetails.open = false;
      var caseSummary = caseStudyDetails.querySelector('summary');
      if (caseSummary) {
        caseSummary.addEventListener('click', function (ev) {
          ev.preventDefault();
          var opening = !caseStudyDetails.open;
          if (opening) caseStudyDetails.open = true;
          animateRollout(caseStudyBody, opening, false);
          if (!opening) {
            window.setTimeout(function () {
              caseStudyDetails.open = false;
            }, 380);
          }
        });
      }
    }

    function renderStatusList() {
      if (!statusList) return;
      if (!projectStatuses.length) {
        statusList.innerHTML = '<div style="font-size:13px;color:var(--text3);padding:6px 0;">No custom statuses yet.</div>';
        return;
      }
      statusList.innerHTML = projectStatuses.map(function (label, idx) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">' +
          '<span>' + label + '</span>' +
          '<button type="button" class="btn" data-status-del="' + idx + '" style="color:var(--red);">Remove</button>' +
        '</div>';
      }).join('');
    }

    function openProjectModal() {
      var m = $('projectModal');
      if (!m) return;
      // Clear simple fields so the form starts fresh.
      var editId = $('project-edit-id');
      if (editId) editId.value = '';
      $('project-name').value = '';
      $('project-client').value = '';
      $('project-status').value = '';
      $('project-category').value = '';
      $('project-start').value = '';
      $('project-due').value = '';
      $('project-value').value = '';
      $('project-desc').value = '';
      $('project-notes').value = '';
      if ($('project-satisfaction')) $('project-satisfaction').value = '';
      var archived = $('project-archived');
      if (archived) archived.checked = false;
      clearCaseStudyForm();
      var det = $('project-case-study-details');
      var detBody = $('project-case-study-body');
      if (det && detBody) {
        det.open = false;
        animateRollout(detBody, false, true);
      }
      populateProjectClientOptions();
      populateProjectStatusOptions();
      m.classList.add('on');
    }

    function closeProjectModal() {
      var m = $('projectModal');
      if (m) m.classList.remove('on');
    }

    function openStatusModal() {
      var m = $('statusModal');
      if (m) {
        renderStatusList();
        // Also refresh the status dropdown used in the project modal so new labels appear there.
        populateProjectStatusOptions();
        m.classList.add('on');
      }
    }

    function closeStatusModal() {
      var m = $('statusModal');
      if (m) m.classList.remove('on');
    }

    if (btnAddProject) btnAddProject.addEventListener('click', openProjectModal);
    if (btnProjectCancel) btnProjectCancel.addEventListener('click', closeProjectModal);
    if (btnProjectSave) {
      btnProjectSave.addEventListener('click', function () {
        var name = $('project-name').value.trim();
        if (!name) {
          alert('Project name is required.');
          return;
        }
        var clientId = $('project-client').value || '';
        var statusVal = $('project-status').value || '';
        var type = $('project-category').value.trim();
        var start = $('project-start').value || '';
        var due = $('project-due').value || '';
        var value = parseFloat(($('project-value').value || '').trim()) || 0;
        var desc = $('project-desc').value.trim();
        var notes = $('project-notes').value.trim();
        var archived = $('project-archived') && $('project-archived').checked;
        var satRaw = $('project-satisfaction') ? $('project-satisfaction').value.trim() : '';
        var satNum = satRaw !== '' ? Math.min(10, Math.max(1, parseInt(satRaw, 10))) : null;
        var satisfaction = (!isNaN(satNum) && satNum !== null) ? satNum : null;
        var cs = readCaseStudyFromUi();

        var existingId = $('project-edit-id') ? $('project-edit-id').value : '';
        var savedProject = null;
        if (existingId) {
          projects = projects.map(function (p) {
            if (p.id !== existingId) return p;
            return {
              id: p.id,
              name: name,
              clientId: clientId || null,
              status: statusVal,
              type: type,
              startDate: start,
              dueDate: due,
              value: value,
              description: desc,
              notes: notes,
              satisfaction: satisfaction,
              archived: !!archived,
              createdAt: p.createdAt || Date.now(),
              caseStudyPublished: cs.caseStudyPublished,
              caseStudyCategory: cs.caseStudyCategory,
              caseStudyChallenge: cs.caseStudyChallenge,
              caseStudyStrategy: cs.caseStudyStrategy,
              caseStudyResults: cs.caseStudyResults,
            };
          });
          savedProject = projects.find(function (p) { return p.id === existingId; }) || null;
        } else {
          var proj = {
            id: uuid(),
            name: name,
            clientId: clientId || null,
            status: statusVal,
            type: type,
            startDate: start,
            dueDate: due,
            value: value,
            description: desc,
            notes: notes,
            satisfaction: satisfaction,
            archived: !!archived,
            createdAt: Date.now(),
            caseStudyPublished: cs.caseStudyPublished,
            caseStudyCategory: cs.caseStudyCategory,
            caseStudyChallenge: cs.caseStudyChallenge,
            caseStudyStrategy: cs.caseStudyStrategy,
            caseStudyResults: cs.caseStudyResults,
          };
          projects.push(proj);
          savedProject = proj;
        }
        saveProjects(projects);
        if (savedProject) persistProjectToSupabase(savedProject);
        renderProjects();
        if (state.computed) renderInsights();
        closeProjectModal();
      });
    }

    if (btnManageStatuses) btnManageStatuses.addEventListener('click', openStatusModal);
    if (btnStatusClose) btnStatusClose.addEventListener('click', closeStatusModal);

    if (btnStatusAdd && statusInput) {
      btnStatusAdd.addEventListener('click', function () {
        var label = statusInput.value.trim();
        if (!label) return;
        projectStatuses.push(label);
        saveStatuses(projectStatuses);
        persistAppSettingsToSupabase({ includeDashboard: false });
        statusInput.value = '';
        renderStatusList();
        populateProjectStatusOptions();
        renderProjects();
      });
    }

    if (statusList) {
      statusList.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-status-del]');
        if (!btn) return;
        var idx = parseInt(btn.getAttribute('data-status-del'), 10);
        if (isNaN(idx)) return;
        projectStatuses.splice(idx, 1);
        saveStatuses(projectStatuses);
        persistAppSettingsToSupabase({ includeDashboard: false });
        renderStatusList();
        populateProjectStatusOptions();
        renderProjects();
      });
    }

    var btnStratAdd = $('btn-case-study-strategy-add');
    if (btnStratAdd) {
      btnStratAdd.addEventListener('click', function () {
        appendCaseStudyStrategyRow('', '');
      });
    }
    var stratList = $('case-study-strategy-list');
    if (stratList) {
      stratList.addEventListener('click', function (ev) {
        var rm = ev.target.closest('.case-strategy-remove');
        if (!rm) return;
        var row = rm.closest('.case-strategy-row');
        if (row && row.parentNode) row.parentNode.removeChild(row);
      });
    }
    var btnCsViewClose = $('btn-case-study-view-close');
    if (btnCsViewClose) btnCsViewClose.addEventListener('click', closeCaseStudyViewModal);
    var csViewModal = $('caseStudyViewModal');
    if (csViewModal) {
      csViewModal.addEventListener('click', function (ev) {
        if (ev.target === csViewModal) closeCaseStudyViewModal();
      });
    }
  }

  function wireFilter() {
    var sel = $('dash-period-select');
    if (!sel) return;
    sel.innerHTML = '' +
      '<option value="all">All-Time</option>' +
      '<option value="month">This Month</option>' +
      '<option value="range">Custom range…</option>';

    var container = sel.parentElement;
    var startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.id = 'filter-start';
    startInput.className = 'fi';
    startInput.style.maxWidth = '150px';
    startInput.style.display = 'none';

    var endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.id = 'filter-end';
    endInput.className = 'fi';
    endInput.style.maxWidth = '150px';
    endInput.style.display = 'none';

    container.insertBefore(startInput, sel.nextSibling);
    container.insertBefore(endInput, startInput.nextSibling);

    function applyFilter() {
      var mode = sel.value || 'all';
      state.filter.mode = mode;
      if (mode === 'range') {
        startInput.style.display = '';
        endInput.style.display = '';
        state.filter.start = startInput.value || null;
        state.filter.end = endInput.value || null;
      } else {
        startInput.style.display = 'none';
        endInput.style.display = 'none';
        state.filter.start = null;
        state.filter.end = null;
      }
      recomputeAndRender();
    }

    sel.addEventListener('change', applyFilter);
    startInput.addEventListener('change', applyFilter);
    endInput.addEventListener('change', applyFilter);
  }

  // Serialize runs so a pre-auth no-op init cannot overlap with post-login sync.
  var initDataFromSupabaseChain = Promise.resolve();
  function initDataFromSupabase() {
    initDataFromSupabaseChain = initDataFromSupabaseChain.then(function () {
      return initDataFromSupabaseInner();
    }).catch(function (err) {
      console.error('initDataFromSupabase error', err);
    });
    return initDataFromSupabaseChain;
  }

  // Initialize dashboard data from Supabase when available, falling back to local storage.
  async function initDataFromSupabaseInner() {
    try {
      supabase = window.supabaseClient || supabase;
      currentUser = window.currentUser || currentUser;
      // Re-scope budgets to the active account (in-memory `budgets` can still hold demo values after View Demo).
      budgets = loadBudgets();

      // Start from local cache so we can migrate/backfill if remote is empty.
      state.transactions = omitLocallyDeletedTransactions(loadTransactions());
      clients = loadClients();
      projects = loadProjects();
      invoices = loadInvoices();
      campaigns = loadCampaigns();
      timesheetEntries = loadTimesheetEntries();
      projectStatuses = loadStatuses();
      normalizeLocalIdsForSupabase();

      if (supabase && currentUser && getCurrentOrgId() && !isDemoDashboardUser()) {
        var remoteTxs = await fetchTransactionsFromSupabase();
        var remoteClients = await fetchClientsFromSupabase();

        // One-time backfill: if remote is empty but local has data, upload local records.
        if (!isScreenshotNoCloudUpload() && !remoteTxs.length && state.transactions.length) {
          await uploadTransactionsToSupabase(state.transactions);
          remoteTxs = await fetchTransactionsFromSupabase();
        }
        if (!isScreenshotNoCloudUpload() && !remoteClients.length && clients.length) {
          await uploadClientsToSupabase(clients);
          remoteClients = await fetchClientsFromSupabase();
        }

        // Prefer remote when available; otherwise keep local fallback.
        if (remoteTxs.length) {
          state.transactions = mergeTransactionsPreserveRecurrence(state.transactions, remoteTxs);
          state.transactions = omitLocallyDeletedTransactions(state.transactions);
          pruneDeletedTxMarksAbsentFromRemote(remoteTxs);
        }

        var remoteClientIdSet = {};
        (remoteClients || []).forEach(function (c) {
          if (c && c.id) remoteClientIdSet[c.id] = true;
        });
        clients = mergeClientsPreserveRetainer(clients, remoteClients);
        var localOnlyClients = clients.filter(function (c) {
          return c && c.id && !remoteClientIdSet[c.id];
        });
        if (!isScreenshotNoCloudUpload() && localOnlyClients.length) {
          await uploadClientsToSupabase(localOnlyClients);
          remoteClients = await fetchClientsFromSupabase();
          clients = mergeClientsPreserveRetainer(clients, remoteClients);
        }

        var remoteProjects = await fetchProjectsFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteProjects.length && projects.length) {
          await uploadProjectsToSupabase(projects);
          remoteProjects = await fetchProjectsFromSupabase();
        }
        if (remoteProjects.length) {
          projects = mergeRemoteWithLocalOrphans(projects, remoteProjects, function (x) { return x; });
        }

        var remoteInvoices = await fetchInvoicesFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteInvoices.length && invoices.length) {
          await uploadInvoicesToSupabase(invoices);
          remoteInvoices = await fetchInvoicesFromSupabase();
        }
        if (remoteInvoices.length) {
          invoices = mergeRemoteWithLocalOrphans(invoices, remoteInvoices, function (x) { return x; });
        }

        var remoteCampaigns = await fetchCampaignsFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteCampaigns.length && campaigns.length) {
          await uploadCampaignsToSupabase(campaigns);
          remoteCampaigns = await fetchCampaignsFromSupabase();
        }
        if (remoteCampaigns.length) {
          campaigns = mergeRemoteWithLocalOrphans(campaigns, remoteCampaigns, function (x) { return x; });
        }

        var remoteTimesheet = await fetchTimesheetEntriesFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteTimesheet.length && timesheetEntries.length) {
          await uploadTimesheetEntriesToSupabase(timesheetEntries);
          remoteTimesheet = await fetchTimesheetEntriesFromSupabase();
        }
        if (remoteTimesheet.length) {
          timesheetEntries = mergeRemoteWithLocalOrphans(timesheetEntries, remoteTimesheet, function (x) { return x; });
        }
        crmEvents = await fetchCrmEventsFromSupabase();
        weeklySummaries = await fetchWeeklySummariesFromSupabase();

        var settingsRow = await fetchAppSettingsFromSupabase();
        if (settingsRow && settingsRow.dashboard_settings) {
          await applyDashboardSettingsFromCloud(settingsRow.dashboard_settings);
        }
        if (settingsRow && Array.isArray(settingsRow.project_statuses) && settingsRow.project_statuses.length) {
          projectStatuses = settingsRow.project_statuses.map(function (s) { return String(s); }).filter(Boolean);
          saveStatuses(projectStatuses);
        } else if (!isScreenshotNoCloudUpload()) {
          await persistAppSettingsToSupabase();
        }

        // Cache in localStorage so existing browser keeps a copy.
        saveTransactions(state.transactions);
        saveClients(clients);
        saveProjects(projects);
        saveInvoices(invoices);
        saveCampaigns(campaigns);
        saveTimesheetEntries(timesheetEntries);
      }

      await wfRefreshFromSupabase();

      expandRecurringExpenseInstances();

      // Ensure dropdowns reflect latest clients/projects.
      populateProjectClientOptions();
      populateIncomeClientOptions();
      populateProjectStatusOptions();

      state.computed = compute(state.filter);
      renderAll();
      renderProjects();
      refreshCloudSyncStatus();
    } catch (err) {
      console.error('initDataFromSupabase error', err);
      // Fallback in case anything goes wrong.
      state.transactions = omitLocallyDeletedTransactions(loadTransactions());
      clients = loadClients();
      projects = loadProjects();
      invoices = loadInvoices();
      campaigns = loadCampaigns();
      timesheetEntries = loadTimesheetEntries();
      projectStatuses = loadStatuses();
      crmEvents = [];
      weeklySummaries = [];
      expandRecurringExpenseInstances();
      state.computed = compute(state.filter);
      renderAll();
      renderProjects();
      refreshCloudSyncStatus();
    }
  }

  /**
   * Fills local dashboard state for screenshots / “View Demo”. Sets session flag so sync does not
   * backfill mock rows to Supabase for signed-in users who load mock from settings.
   */
  function loadScreenshotMockData() {
    setScreenshotNoCloudUpload(true);

    function pad2(n) {
      return String(n).padStart(2, '0');
    }
    function ymdOffset(daysAgo) {
      var d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    var specs = [
      { co: 'Aurora Analytics', contact: 'Morgan Chen', email: 'morgan@aurora.example', phone: '(415) 555-0142', status: 'Retainer', industry: 'SaaS', ret: true, notes: 'Primary analytics retainer.' },
      { co: 'Brightline Health', contact: 'Sam Rivera', email: 'sam@brightline.example', phone: '(206) 555-0198', status: 'Retainer', industry: 'Healthcare', ret: true, notes: '' },
      { co: 'Copper Kettle Co.', contact: 'Alex Kim', email: 'alex@copperkettle.example', phone: '(512) 555-0101', status: 'Active', industry: 'Hospitality', ret: false, notes: 'Seasonal campaigns.' },
      { co: 'Driftwood Studio', contact: 'Riley Ng', email: 'riley@driftwood.example', phone: '(503) 555-0122', status: 'Retainer', industry: 'Design', ret: true, notes: '' },
      { co: 'Evergreen Supply', contact: 'Casey Park', email: 'casey@evergreen.example', phone: '(303) 555-0144', status: 'Active', industry: 'Retail', ret: false, notes: '' },
      { co: 'Falcon Mobility', contact: 'Jordan Blake', email: 'jordan@falcon.example', phone: '(617) 555-0166', status: 'Pipeline', industry: 'Mobility', ret: false, notes: 'Pilot Q1.' },
      { co: 'Greenleaf Farms', contact: 'Taylor Moss', email: 'taylor@greenleaf.example', phone: '(406) 555-0188', status: 'Active', industry: 'Agriculture', ret: false, notes: '' },
      { co: 'Harborlight Capital', contact: 'Morgan Diaz', email: 'morgan.h@harborlight.example', phone: '(212) 555-0199', status: 'Retainer', industry: 'Finance', ret: true, notes: '' },
      { co: 'Inkwell Publishing', contact: 'Jamie Frost', email: 'jamie@inkwell.example', phone: '(718) 555-0200', status: 'On hold', industry: 'Media', ret: false, notes: '' },
      { co: 'Juniper Learning', contact: 'Quinn Patel', email: 'quinn@juniper.example', phone: '(650) 555-0211', status: 'Active', industry: 'EdTech', ret: false, notes: '' },
      { co: 'Kindred Robotics', contact: 'Reese Lopez', email: 'reese@kindred.example', phone: '(408) 555-0222', status: 'Pipeline', industry: 'Robotics', ret: false, notes: '' },
      { co: 'Lumen Architecture', contact: 'Skyler Fox', email: 'skyler@lumenarch.example', phone: '(312) 555-0233', status: 'Active', industry: 'Architecture', ret: false, notes: '' },
    ];

    var t0 = Date.now();
    clients = specs.map(function (s, i) {
      return {
        id: uuid(),
        companyName: s.co,
        contactName: s.contact,
        status: s.status,
        industry: s.industry,
        email: s.email,
        phone: s.phone,
        notes: s.notes,
        birthday: '',
        communicationStyle: i % 3 === 0 ? 'Direct' : i % 3 === 1 ? 'Collaborative' : 'Async',
        preferredChannel: i % 2 === 0 ? 'Email' : 'Slack',
        lastTouchAt: ymdOffset(3 + (i % 5)),
        nextFollowUpAt: ymdOffset(-7 - i),
        relationshipNotes: i % 4 === 0 ? 'Champion: legal approved SOW renewal.' : '',
        totalRevenue: 12000 + i * 4200,
        createdAt: new Date(t0 - (120 - i * 7) * 86400000).toISOString(),
        retainer: s.ret === true,
        custTabRevenue: 8000 + i * 900,
        custTabAllocatedCost: 2000 + i * 400,
      };
    });

    var now = Date.now();
    projects = [
      { id: uuid(), clientId: clients[0].id, name: 'Analytics refresh & dashboards', status: 'In progress', type: 'Retainer', startDate: ymdOffset(60), dueDate: ymdOffset(-5), value: 42000, description: 'BI dashboards and weekly KPI pack.', notes: '', satisfaction: 9, archived: false, createdAt: now - 86400000 * 55, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[1].id, name: 'Member portal v2', status: 'In progress', type: 'Project', startDate: ymdOffset(45), dueDate: ymdOffset(20), value: 68000, description: 'Accessibility and performance pass.', notes: '', satisfaction: null, archived: false, createdAt: now - 86400000 * 40, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[2].id, name: 'Loyalty program launch', status: 'Complete', type: 'Campaign', startDate: ymdOffset(90), dueDate: ymdOffset(25), value: 18500, description: 'Email and in-store signage.', notes: 'Delivered on time.', satisfaction: 10, archived: false, createdAt: now - 86400000 * 88, caseStudyPublished: true, caseStudyChallenge: 'Low repeat visits.', caseStudyStrategy: [{ title: 'Approach', body: 'Segmented offers.' }], caseStudyResults: [{ metric: 'Repeat rate', value: '+18%' }], caseStudyCategory: 'Hospitality' },
      { id: uuid(), clientId: clients[3].id, name: 'Brand system 2026', status: 'In progress', type: 'Retainer', startDate: ymdOffset(30), dueDate: ymdOffset(45), value: 24000, description: 'Typography and component library.', notes: '', satisfaction: 8, archived: false, createdAt: now - 86400000 * 28, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[4].id, name: 'Inventory forecasting', status: 'Blocked', type: 'Sprint', startDate: ymdOffset(20), dueDate: ymdOffset(5), value: 12000, description: 'Waiting on ERP export format.', notes: '', satisfaction: null, archived: false, createdAt: now - 86400000 * 18, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[5].id, name: 'Fleet dashboard MVP', status: 'Not started', type: 'MVP', startDate: ymdOffset(10), dueDate: ymdOffset(55), value: 95000, description: 'Phase 0 discovery.', notes: '', satisfaction: null, archived: false, createdAt: now - 86400000 * 8, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[7].id, name: 'LP reporting templates', status: 'Complete', type: 'Project', startDate: ymdOffset(75), dueDate: ymdOffset(40), value: 31000, description: 'Quarterly LP pack automation.', notes: '', satisfaction: 9, archived: false, createdAt: now - 86400000 * 70, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[9].id, name: 'Course CMS migration', status: 'In progress', type: 'Project', startDate: ymdOffset(14), dueDate: ymdOffset(30), value: 52000, description: 'Headless CMS and SSO.', notes: '', satisfaction: 8, archived: false, createdAt: now - 86400000 * 12, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
    ];

    var txs = [];
    function addTx(o) {
      txs.push({
        id: uuid(),
        date: o.d,
        category: o.c,
        amount: o.a,
        description: o.desc || '',
        note: o.note || o.desc || '',
        clientId: o.cid || null,
        projectId: o.pid || null,
        otherLabel: o.ol || '',
        otherType: o.ot || '',
        source: o.src || '',
        createdAt: new Date().toISOString(),
      });
    }

    var i;
    var p;
    for (i = 0; i < 95; i += 3) {
      if (i % 9 === 0) {
        addTx({ d: ymdOffset(i), c: 'svc', a: 4800 + (i % 7) * 200, desc: 'Services invoice', cid: clients[i % clients.length].id, pid: projects[i % projects.length].id });
      }
      if (i % 11 === 2) {
        addTx({ d: ymdOffset(i), c: 'ret', a: 6200 + (i % 5) * 150, desc: 'Monthly retainer', cid: clients[(i + 1) % clients.length].id });
      }
      if (i % 5 === 1) addTx({ d: ymdOffset(i), c: 'lab', a: 2100 + (i % 4) * 180, desc: 'Contract labor', note: 'Design + engineering' });
      if (i % 6 === 3) addTx({ d: ymdOffset(i), c: 'sw', a: 180 + (i % 3) * 40, desc: 'SaaS subscriptions', note: 'Figma, Linear, hosting' });
      if (i % 8 === 4) addTx({ d: ymdOffset(i), c: 'ads', a: 950 + (i % 5) * 120, desc: 'Paid search and social' });
      if (i % 10 === 6) addTx({ d: ymdOffset(i), c: 'oth', a: 320 + (i % 4) * 55, desc: 'Travel and meals', ol: 'Travel', ot: 'One-time' });
    }
    addTx({ d: ymdOffset(1), c: 'own', a: 15000, desc: 'Owner capital contribution', note: 'Operating buffer' });

    state.transactions = txs;

    var incomeForInvoices = txs.filter(function (t) { return t.category === 'svc' && t.clientId; }).slice(0, 4);
    invoices = incomeForInvoices.map(function (t, idx) {
      return {
        id: uuid(),
        incomeTxId: t.id,
        number: 'INV-' + String(2400 + idx).padStart(4, '0'),
        dateIssued: t.date,
        dueDate: ymdOffset(-20 + idx * 5),
        amount: t.amount,
        status: idx === 0 ? 'paid' : idx === 1 ? 'sent' : 'sent',
        paidAt: idx === 0 ? ymdOffset(2) : null,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        stripeStatus: null,
      };
    });

    campaigns = [
      normalizeCampaign({ id: uuid(), name: 'Spring webinar series', channel: 'LinkedIn + email', startDate: ymdOffset(40), notes: 'MQL goal 120.', pipelineValue: 45000, status: CAMPAIGN_STATUS_PIPELINE, createdAt: now - 86400000 * 35 }),
      normalizeCampaign({ id: uuid(), name: 'Partner co-marketing', channel: 'Events', startDate: ymdOffset(25), notes: 'Two field events.', pipelineValue: 28000, status: CAMPAIGN_STATUS_PIPELINE, createdAt: now - 86400000 * 20 }),
      normalizeCampaign({ id: uuid(), name: 'Brand refresh launch', channel: 'Organic + PR', startDate: ymdOffset(70), notes: 'Case study push.', pipelineValue: 0, status: CAMPAIGN_STATUS_WON, createdAt: now - 86400000 * 65 }),
      normalizeCampaign({ id: uuid(), name: 'Legacy nurture pilot', channel: 'Email', startDate: ymdOffset(90), notes: 'Sunset Q4.', pipelineValue: 8000, status: CAMPAIGN_STATUS_LOST, createdAt: now - 86400000 * 85 }),
    ];

    timesheetEntries = [];
    for (p = 0; p < 5; p++) {
      timesheetEntries.push({
        id: uuid(),
        date: ymdOffset(p),
        account: 'Client delivery',
        project: projects[p % projects.length].name,
        task: p % 2 === 0 ? 'Implementation' : 'Review',
        activityCode: 'BILL',
        minutes: 240 + p * 45,
        billable: true,
        notes: 'Screenshot sample entry',
        externalNote: '',
        weekdays: [],
        createdAt: new Date().toISOString(),
      });
    }

    crmEvents = [
      { id: uuid(), clientId: clients[0].id, kind: 'note', title: 'QBR scheduled', details: {}, eventAt: new Date(now - 86400000 * 2).toISOString() },
      { id: uuid(), clientId: clients[2].id, kind: 'note', title: 'Sent revised SOW', details: {}, eventAt: new Date(now - 86400000 * 5).toISOString() },
      { id: uuid(), clientId: clients[5].id, kind: 'note', title: 'Discovery call — budget confirmed', details: {}, eventAt: new Date(now - 86400000 * 8).toISOString() },
    ];
    weeklySummaries = [];

    budgets = { lab: 8500, sw: 950, ads: 2200, oth: 650 };
    saveBudgets(budgets);

    normalizeLocalIdsForSupabase();
    saveClients(clients);
    saveProjects(projects);
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    saveCampaigns(campaigns);
    saveTimesheetEntries(timesheetEntries);

    var sn = $('setting-name');
    if (sn) sn.value = 'Northwind Creative Studio';
    var so = $('setting-owner');
    if (so) so.value = 'Alex Morgan';
    var spe = $('setting-period');
    if (spe) spe.value = 'Q1 2026';
    ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
      var el = document.getElementById('budget-input-' + k);
      if (el && budgets[k] > 0) el.value = budgets[k];
    });

    expandRecurringExpenseInstances();
    populateProjectClientOptions();
    populateIncomeClientOptions();
    populateProjectStatusOptions();
    state.computed = compute(state.filter);
    renderAll();
    renderProjects();
    refreshCloudSyncStatus();
  }

  function resumeScreenshotCloudUpload() {
    if (!isScreenshotNoCloudUpload()) {
      alert('Screenshot upload pause is not active.');
      return;
    }
    if (!confirm('Resume automatic cloud upload? Sign-in and Sync will behave normally again. Local demo data stays until you replace or clear it. If your cloud account is empty, the next Sync may upload what is in this browser.')) return;
    setScreenshotNoCloudUpload(false);
    refreshCloudSyncStatus();
    if (window.currentUser && window.supabaseClient) {
      alert('Upload pause is off. Use Sync if you want to merge with your account.');
    }
  }

  /** Clear settings inputs that demo mode writes so a real account never inherits sample business text. */
  function resetSettingsFormForAccountHandoff() {
    function setEl(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v != null ? String(v) : '';
    }
    ['setting-name', 'setting-owner', 'setting-email', 'setting-phone', 'setting-address', 'setting-period'].forEach(function (id) {
      setEl(id, '');
    });
    setEl('setting-terms', '30');
    setEl('setting-tax', '0');
    var cur = document.getElementById('setting-currency');
    if (cur) cur.value = 'USD';
    var fis = document.getElementById('setting-fiscal');
    if (fis) fis.value = 'January';
    // Preserve current branding until account-specific settings are loaded.
    ['setting-logo-light', 'setting-logo-dark'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.type === 'file') el.value = '';
    });
  }

  function destroyAllWorkspaceCharts() {
    function kill(ch) {
      if (ch && window.Chart && typeof ch.destroy === 'function') {
        try {
          ch.destroy();
        } catch (_) {}
      }
    }
    kill(expenseChart);
    expenseChart = null;
    kill(revExpChart);
    revExpChart = null;
    kill(projTypeChart);
    projTypeChart = null;
    kill(projMonthlyChart);
    projMonthlyChart = null;
    kill(revTrendChart);
    revTrendChart = null;
    kill(verticalChart);
    verticalChart = null;
    kill(leadSourceChart);
    leadSourceChart = null;
    kill(spendTrendChart);
    spendTrendChart = null;
    kill(insTrendChart);
    insTrendChart = null;
    kill(retTrendChart);
    retTrendChart = null;
  }

  function clearRuntimeDataForAuthChange(nextUser) {
    currentUser = nextUser || null;
    window.currentUser = currentUser;
    if (!nextUser) {
      window.currentOrganizationId = null;
      window.currentOrganizationSlug = null;
      window.currentOrganizationRole = null;
    }
    if (!nextUser || nextUser.id !== DEMO_DASHBOARD_USER_ID) {
      setScreenshotNoCloudUpload(false);
    }
    customersColumnPrefs = loadCustomersColumnPrefs();
    renderCustomersColumnsPanel();
    if (!isDemoDashboardUser()) {
      resetSettingsFormForAccountHandoff();
    }
    destroyAllWorkspaceCharts();
    budgets = loadBudgets();
    refreshSettingsBudgetInputsFromState();
    wfPipelines = [];
    wfStages = [];
    wfRules = [];
    wfTasks = [];
    advisorContactContext = null;
    state.transactions = [];
    clients = [];
    projects = [];
    invoices = [];
    campaigns = [];
    marketingGa4State = {
      orgId: '',
      loading: false,
      loaded: false,
      error: '',
      data: null,
      inFlight: null,
    };
    timesheetEntries = [];
    crmEvents = [];
    weeklySummaries = [];
    state.computed = compute(state.filter);
    renderAll();
    renderProjects();
    refreshCloudSyncStatus();
  }

  window.bizDashSetAdvisorContactContext = function (obj) {
    advisorContactContext = normalizeAdvisorContactContext(obj);
  };
  window.bizDashGetAdvisorContactContext = function () {
    return advisorContactContext ? Object.assign({}, advisorContactContext) : null;
  };
  window.bizDashGetClientsDigestForAdvisor = function () {
    var out = [];
    (clients || []).forEach(function (c) {
      if (!c || out.length >= 30) return;
      out.push({
        companyName: String(c.companyName || '').slice(0, 120),
        email: String(c.email || '').slice(0, 160),
      });
    });
    return out;
  };
  /**
   * One-click insert from Advisor CRM proposal (user must confirm in Advisor UI before calling).
   * @returns {Promise<{ok:boolean, client?:object, error?:string}>}
   */
  window.bizDashCreateClientFromDraft = async function (draft) {
    var client = buildNewClientObjectFromDraft(draft);
    if (!client) {
      return { ok: false, error: 'Company name is required.' };
    }
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      return { ok: false, error: 'You must be signed in to add a client.' };
    }
    var addSync = await persistClientToSupabase(client, 'insert');
    if (addSync === 'skipped') {
      return { ok: false, error: persistClientLastError || 'Could not save (session or demo mode).' };
    }
    if (addSync !== 'ok') {
      return { ok: false, error: persistClientLastError || 'Could not save to the cloud.' };
    }
    clients.push(client);
    saveClients(clients);
    renderClients();
    if (state.computed) renderInsights();
    await runWorkflowDispatch({ kind: 'client_updated', before: null, after: wfCloneClientForWorkflow(client) });
    if (client.lastTouchAt) {
      addCrmEvent('touch', 'Last touch updated for ' + (client.companyName || 'client'), { lastTouchAt: client.lastTouchAt }, client.id, 'touch:' + client.id + ':' + client.lastTouchAt);
    }
    if (client.nextFollowUpAt) {
      addCrmEvent('follow_up', 'Follow-up scheduled for ' + (client.companyName || 'client'), { nextFollowUpAt: client.nextFollowUpAt }, client.id, 'followup:' + client.id + ':' + client.nextFollowUpAt);
    }
    refreshCloudSyncStatus();
    populateProjectClientOptions();
    populateIncomeClientOptions();
    return { ok: true, client: client };
  };

  /**
   * Called after first-time workspace setup (org name + slug) to sync Settings fields,
   * accent, optional tagline / role, and persist dashboard_settings to Supabase.
   */
  window.bizdashApplyWorkspaceBrandingFromOnboarding = async function (payload) {
    payload = payload || {};
    function gid(id) {
      return document.getElementById(id);
    }
    var nm = gid('setting-name');
    var ow = gid('setting-owner');
    var orr = gid('setting-owner-role');
    var tg = gid('setting-tagline');
    var ac = gid('setting-accent');
    var ach = gid('setting-accent-hex');
    if (nm && payload.businessName != null) nm.value = String(payload.businessName);
    if (ow && payload.owner != null) ow.value = String(payload.owner);
    if (orr && payload.ownerRole != null) orr.value = String(payload.ownerRole);
    if (tg && payload.tagline != null) tg.value = String(payload.tagline);
    if (payload.accent) {
      var hex = normalizeHexColor(payload.accent, '#e8501a');
      if (ac) ac.value = hex;
      if (ach) ach.value = hex;
      applyAccentBranding(hex);
    }
    var tagOut = gid('dash-brand-tagline');
    if (tagOut) {
      var tgs = payload.tagline != null ? String(payload.tagline).trim() : '';
      if (tgs) {
        tagOut.textContent = tgs;
        tagOut.style.display = 'block';
      } else {
        tagOut.textContent = '';
        tagOut.style.display = 'none';
      }
    }
    await persistAppSettingsToSupabase({ includeDashboard: true });
  };

  // Expose so supabase-auth.js can reset state on auth transitions and trigger reload.
  window.clearRuntimeDataForAuthChange = clearRuntimeDataForAuthChange;
  window.initDataFromSupabase = initDataFromSupabase;
  window.loadScreenshotMockData = loadScreenshotMockData;
  window.resumeScreenshotCloudUpload = resumeScreenshotCloudUpload;
  window.setBizdashScreenshotNoCloud = setScreenshotNoCloudUpload;

  /**
   * Read-only ledger rollups for the in-dashboard assistant (same rules as compute(): categories svc/ret = revenue, lab/sw/ads/oth = expense, own excluded).
   * @returns {object|null} null if range is invalid
   */
  window.bizDashLedgerSummaryRange = function (startYmd, endYmd) {
    if (!startYmd || !endYmd) return null;
    var c = computeForYmdRange(startYmd, endYmd);
    return {
      startYmd: startYmd,
      endYmd: endYmd,
      expenseTotal: c.expenseTotal,
      revenueTotal: c.revenueTotal,
      netProfit: c.netProfit,
      grossProfit: c.grossProfit,
      grossMarginPct: c.grossMarginPct,
      cogsTotal: c.cogsTotal,
      expenseByCat: {
        lab: c.expenseByCat.lab,
        sw: c.expenseByCat.sw,
        ads: c.expenseByCat.ads,
        oth: c.expenseByCat.oth,
      },
      revenueByCat: { svc: c.revenueByCat.svc, ret: c.revenueByCat.ret },
      expenseFixedTotal: c.expenseFixedTotal,
      expenseVariableTotal: c.expenseVariableTotal,
      transactionCount: c.txs.length,
    };
  };

  window.bizDashLedgerSummaryAll = function () {
    var c = compute({ mode: 'all', start: null, end: null });
    return {
      expenseTotal: c.expenseTotal,
      revenueTotal: c.revenueTotal,
      netProfit: c.netProfit,
      grossProfit: c.grossProfit,
      grossMarginPct: c.grossMarginPct,
      cogsTotal: c.cogsTotal,
      expenseByCat: {
        lab: c.expenseByCat.lab,
        sw: c.expenseByCat.sw,
        ads: c.expenseByCat.ads,
        oth: c.expenseByCat.oth,
      },
      revenueByCat: { svc: c.revenueByCat.svc, ret: c.revenueByCat.ret },
      expenseFixedTotal: c.expenseFixedTotal,
      expenseVariableTotal: c.expenseVariableTotal,
      transactionCount: c.txs.length,
    };
  };

  function wireTeamPage() {
    var teamWired = false;
    function buildInviteShareUrl(result) {
      var token = result && result.token ? String(result.token) : '';
      if (token) {
        return (window.location.origin || '') + '/?invite=' + encodeURIComponent(token);
      }
      return result && result.inviteUrl ? String(result.inviteUrl) : '';
    }
    function roleLabel(r) {
      if (r === 'member') return 'Employee';
      if (r === 'viewer') return 'Viewer';
      if (!r) return '—';
      return String(r).charAt(0).toUpperCase() + String(r).slice(1);
    }
    /** Supabase FunctionsFetchError = fetch never completed (not a 4xx/5xx from the function). */
    function formatTeamInvokeError(err) {
      if (!err) return 'Request failed';
      var msg = err.message || 'Request failed';
      if (err.name === 'FunctionsHttpError' && err.context && typeof err.context.status === 'number') {
        if (err.context.status === 401) {
          return 'Session expired or not accepted by the server. Sign in again, then reopen My team.';
        }
        return msg + ' (HTTP ' + String(err.context.status) + ')';
      }
      if (err.name === 'FunctionsFetchError') {
        var inner =
          err.context && typeof err.context === 'object' && err.context.message != null
            ? String(err.context.message)
            : err.context != null && typeof err.context !== 'object'
              ? String(err.context)
              : '';
        var suffix =
          ' Usually: deploy `organization-team` to this Supabase project (`supabase functions deploy organization-team`), or open DevTools → Network and inspect …/functions/v1/organization-team.';
        return inner && inner !== msg ? msg + ' — ' + inner + '.' + suffix : msg + '.' + suffix;
      }
      return msg;
    }
    /**
     * SupabaseClient's fetch wrapper uses auth.getSession() for Bearer — that can lag GoTrue.
     * Passing Authorization on invoke() pins a token; fetch will not replace it, so it must
     * be fresh. refreshSession() returns the new access_token from the server.
     */
    async function bearerForTeamEdge(supabase) {
      try {
        var ref = await supabase.auth.refreshSession();
        if (ref && ref.error) return null;
        var s = ref && ref.data && ref.data.session;
        if (s && s.access_token) return s.access_token;
        var g = await supabase.auth.getSession();
        s = g && g.data && g.data.session;
        return s && s.access_token ? s.access_token : null;
      } catch (_) {
        return null;
      }
    }
    /** Avoid supabase.functions.invoke: bundled fetch wrapper can omit Authorization (gateway UNAUTHORIZED_NO_AUTH_HEADER). */
    async function invokeOrganizationTeamRaw(supabase, orgId, body, accessToken) {
      var base = (
        (supabase && supabase.supabaseUrl ? String(supabase.supabaseUrl) : '') ||
        (typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl : '')
      ).replace(/\/$/, '');
      var anon =
        (supabase && supabase.supabaseKey ? String(supabase.supabaseKey) : '') ||
        (typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey : '');
      if (!base || !anon) return { ok: false, status: 0, data: null, errText: 'Missing Supabase URL or key on client.' };
      var url = base + '/functions/v1/organization-team';
      var res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
          apikey: anon,
        },
        body: JSON.stringify(Object.assign({ organizationId: orgId }, body)),
      });
      var text = await res.text();
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = { error: text || 'Invalid JSON from server.' };
      }
      return { ok: res.ok, status: res.status, data: data, errText: text };
    }
    async function invokeTeam(body) {
      var supabase = window.supabaseClient;
      if (!supabase) return { error: 'Sign in to manage the team.' };
      var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
      if (!orgId) return { error: 'No workspace selected.' };
      try {
        var token = await bearerForTeamEdge(supabase);
        if (!token) return { error: 'Session expired. Sign in again.' };
        var raw = await invokeOrganizationTeamRaw(supabase, orgId, body, token);
        if (!raw.ok && raw.status === 401) {
          token = await bearerForTeamEdge(supabase);
          if (token) raw = await invokeOrganizationTeamRaw(supabase, orgId, body, token);
        }
        if (!raw.ok) {
          var apiErr =
            raw.data && typeof raw.data === 'object'
              ? raw.data.error || raw.data.message || raw.data.msg
              : null;
          var pseudo = {
            name: 'FunctionsHttpError',
            message: apiErr ? String(apiErr) : 'Request failed',
            context: { status: raw.status || 0 },
          };
          return { error: formatTeamInvokeError(pseudo) };
        }
        return raw.data && typeof raw.data === 'object' ? raw.data : {};
      } catch (e) {
        return { error: formatTeamInvokeError(e) };
      }
    }
    async function refreshTeamPage() {
      var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
      var hint = document.getElementById('team-page-hint');
      var tbody = document.getElementById('team-members-body');
      var thActions = document.getElementById('team-th-actions');
      var inviteCard = document.getElementById('team-invite-card');
      var pendingCard = document.getElementById('team-pending-invites-card');
      if (!tbody || !hint) return;
      if (!orgId) {
        hint.textContent = 'Open a workspace URL (path starts with your org slug) to view the team.';
        tbody.innerHTML = '';
        if (inviteCard) inviteCard.style.display = 'none';
        if (pendingCard) pendingCard.style.display = 'none';
        return;
      }
      var out = await invokeTeam({ action: 'list' });
      if (out.error) {
        hint.textContent = String(out.error);
        tbody.innerHTML = '';
        if (inviteCard) inviteCard.style.display = 'none';
        if (pendingCard) pendingCard.style.display = 'none';
        return;
      }
      var canManage = !!out.canManage;
      var myRole = out.yourRole || '';
      hint.textContent = canManage
        ? 'Change roles or remove people from this workspace. Only owners can assign the Owner role.'
        : 'Only workspace admins (Owner or Admin) can change roles or send invites.';
      if (thActions) thActions.style.display = canManage ? '' : 'none';
      if (inviteCard) inviteCard.style.display = canManage ? 'block' : 'none';
      var members = out.members || [];
      tbody.innerHTML = members
        .map(function (m) {
          var email = m.email || m.user_id || '—';
          var uid = m.user_id;
          var isSelf = window.currentUser && window.currentUser.id === uid;
          var row =
            '<tr><td>' + esc(email) + '</td><td>' + esc(roleLabel(m.role)) + '</td>';
          if (canManage) {
            var roleOpts = myRole === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer'];
            var sel = roleOpts
              .map(function (r) {
                return '<option value="' + esc(r) + '"' + (m.role === r ? ' selected' : '') + '>' + esc(roleLabel(r)) + '</option>';
              })
              .join('');
            row +=
              '<td><select class="fi team-role-select" data-user-id="' +
              esc(uid) +
              '" style="min-width:130px;font-size:12px;">' +
              sel +
              '</select> ';
            row += isSelf
              ? '<span style="color:var(--text3);font-size:11px;">You</span></td>'
              : '<button type="button" class="btn team-remove-btn" data-user-id="' +
                esc(uid) +
                '" style="font-size:11px;padding:4px 8px;">Remove</button></td>';
          }
          row += '</tr>';
          return row;
        })
        .join('');

      if (canManage && pendingCard) {
        var pi = await invokeTeam({ action: 'pending_invites' });
        var pb = document.getElementById('team-pending-invites-body');
        if (!pi.error && pi.invitations && pi.invitations.length && pb) {
          pendingCard.style.display = 'block';
          pb.innerHTML = pi.invitations
            .map(function (inv) {
              return (
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);">' +
                '<span>' +
                esc(inv.email) +
                ' · ' +
                esc(roleLabel(inv.role)) +
                ' · expires ' +
                esc(String(inv.expires_at || '').slice(0, 10)) +
                '</span>' +
                '<button type="button" class="btn team-revoke-invite" data-invite-id="' +
                esc(inv.id) +
                '" style="font-size:11px;">Revoke</button></div>'
              );
            })
            .join('');
        } else {
          pendingCard.style.display = 'none';
          if (pb) pb.innerHTML = '';
        }
      } else if (pendingCard) {
        pendingCard.style.display = 'none';
      }

      if (!teamWired) {
        teamWired = true;
        var btnInv = document.getElementById('team-btn-create-invite');
        var btnAdd = document.getElementById('team-btn-add-existing');
        if (btnInv) {
          btnInv.addEventListener('click', async function () {
            var emEl = document.getElementById('team-invite-email');
            var roleEl = document.getElementById('team-invite-role');
            var resEl = document.getElementById('team-invite-result');
            var email = emEl && emEl.value ? String(emEl.value).trim() : '';
            var role = roleEl && roleEl.value ? roleEl.value : 'member';
            if (!email) {
              alert('Enter an email address.');
              return;
            }
            var r = await invokeTeam({ action: 'invite', email: email, role: role });
            if (r.error) {
              alert(r.error);
              return;
            }
            if (resEl) {
              var shareUrl = buildInviteShareUrl(r);
              resEl.style.display = 'block';
              resEl.textContent = shareUrl ? 'Share this link: ' + shareUrl : 'Invite created.';
            }
            if (emEl) emEl.value = '';
            await refreshTeamPage();
          });
        }
        if (btnAdd) {
          btnAdd.addEventListener('click', async function () {
            var emEl = document.getElementById('team-invite-email');
            var roleEl = document.getElementById('team-invite-role');
            var email = emEl && emEl.value ? String(emEl.value).trim() : '';
            var role = roleEl && roleEl.value ? roleEl.value : 'member';
            if (!email) {
              alert('Enter an email address.');
              return;
            }
            var r = await invokeTeam({ action: 'add', email: email, role: role });
            if (r.error) {
              alert(r.error);
              return;
            }
            alert('User added to this workspace.');
            if (emEl) emEl.value = '';
            await refreshTeamPage();
          });
        }
        tbody.addEventListener('change', async function (ev) {
          var t = ev.target;
          if (!t || !t.classList || !t.classList.contains('team-role-select')) return;
          var uid = t.getAttribute('data-user-id');
          var role = t.value;
          var r = await invokeTeam({ action: 'update_role', userId: uid, role: role });
          if (r.error) {
            alert(r.error);
            await refreshTeamPage();
            return;
          }
        });
        tbody.addEventListener('click', async function (ev) {
          var t = ev.target;
          if (!t || !t.closest) return;
          var removeBtn = t.closest('.team-remove-btn');
          if (!removeBtn) return;
          var uid = removeBtn.getAttribute('data-user-id');
          if (!uid) return;
          if (
            !confirm(
              'Are you sure you want to remove this person from the workspace? They will lose access immediately.'
            )
          ) {
            return;
          }
          var r = await invokeTeam({ action: 'remove', userId: uid });
          if (r.error) {
            alert(r.error);
            await refreshTeamPage();
            return;
          }
          if (r.ok === false) {
            alert(r.message || 'Could not remove this member.');
            await refreshTeamPage();
            return;
          }
          await refreshTeamPage();
        });
        var pendingHost = document.getElementById('team-pending-invites-body');
        if (pendingHost) {
          pendingHost.addEventListener('click', async function (ev) {
            var t = ev.target;
            if (!t || !t.classList || !t.classList.contains('team-revoke-invite')) return;
            var id = t.getAttribute('data-invite-id');
            if (!id || !confirm('Revoke this invitation?')) return;
            var r = await invokeTeam({ action: 'revoke_invite', inviteId: id });
            if (r.error) {
              alert(r.error);
              return;
            }
            await refreshTeamPage();
          });
        }
      }
    }
    window.refreshTeamPage = refreshTeamPage;
  }

  function init() {
    state.filter = { mode: 'all', start: null, end: null };
    wireTransactionForm();
    wireCsvImportAndJournalExport();
    wireIncomeExpenseForms();
    wireTimesheet();
    wireDeleteHandlers();
    wireClientForm();
    wireInvoiceModal();
    wireInvoicePreviewModal();
    wireProjectsAndStatuses();
    wireFilter();
    wireCustomersColumnsPicker();
    wireIncomePowerTable();
    wireSpendingReport();
    wireSettingsSave();
    wirePersonableActions();
    wireCloudSyncPanel();
    wireMarketingCampaign();
    wireWorkflowAutomation();
    if (typeof window.wireDashboardAssistant === 'function') {
      window.wireDashboardAssistant();
    }
    wireTeamPage();

    // Simple page navigation wiring to replace the original bundle's nav().
    // Exposed globally so existing onclick="nav('dashboard', this)" continues to work.
    window.nav = function (pageId, el) {
      document.body.classList.remove('mobile-nav-open');

      // Switch visible page
      var pages = document.querySelectorAll('.pg');
      pages.forEach(function (pg) {
        pg.classList.remove('on');
      });
      var target = document.getElementById('page-' + pageId);
      if (target) target.classList.add('on');
      stagePageMotion(target);
      if (pageId !== 'chat') {
        var chatPg = document.getElementById('page-chat');
        if (chatPg) chatPg.classList.remove('chat-compose-docked');
      }
      if (pageId === 'chat' && typeof window.seedDashboardChatWelcome === 'function') {
        window.seedDashboardChatWelcome();
      }

      // Sidebar active state
      var items = document.querySelectorAll('.ni');
      items.forEach(function (n) { n.classList.remove('active'); });
      if (el && el.classList) {
        el.classList.add('active');
      } else {
        var sideItem = document.querySelector('.ni[data-nav="' + pageId + '"]');
        if (sideItem) sideItem.classList.add('active');
      }

      var mobileTitle = document.getElementById('mobile-title');
      if (mobileTitle) {
        var titles = {
          dashboard: 'Business Performance',
          customers: 'Customers',
          tasks: 'Tasks',
          revenue: 'Income',
          expenses: 'Expenses',
          timesheet: 'Timesheet',
          performance: 'Projects',
          retention: 'Retention',
          insights: 'Insights',
          marketing: 'Marketing',
          chat: 'Advisor',
          team: 'Your team',
          settings: 'Settings',
        };
        mobileTitle.textContent = titles[pageId] || 'Dashboard';
      }
      if (pageId === 'team' && typeof window.refreshTeamPage === 'function') {
        window.refreshTeamPage();
      }
      if (pageId === 'tasks') {
        wfRefreshFromSupabase().then(function () {
          renderTasksPage();
        });
      }
      if (pageId === 'settings') {
        wfRefreshFromSupabase().then(function () {
          renderAutomationSettings();
        });
      }
    };

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') document.body.classList.remove('mobile-nav-open');
    });

    stagePageMotion(document.querySelector('.pg.on'));

    // Load data only when session is already present (auth also calls init after login).
    if (typeof initDataFromSupabase === 'function' && window.currentUser && window.supabaseClient) {
      initDataFromSupabase();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
