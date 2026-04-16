// Advisor scaffolding before external AI provider integration.
// Uses a stable task contract and Supabase Edge Function stubs.

(function () {
  'use strict';

  /** Minimum time to show the “thinking” state before revealing the reply (ms). */
  var THINKING_MIN_MS = 2000;

  var WELCOME =
    'Hi — I am your business copilot for this dashboard.\n\n' +
    'I help turn your numbers into clear next steps, not just answers.\n\n' +
    'Use Advisor to:\n' +
    '• Prioritize today\'s most important actions\n' +
    '• Follow up on overdue invoices and client outreach\n' +
    '• Understand profit or expense changes over time\n' +
    '• Generate Monday plans and Friday recaps\n\n' +
    'Advisor uses your dashboard data and signed-in session context to provide focused recommendations and drafts. You stay in control of final decisions and actions.';
  var WELCOME_MOBILE =
    'Hi — I am your business copilot.\n\n' +
    'I turn dashboard numbers into prioritized next steps.\n\n' +
    'Use the task chips for Daily brief, Follow-up draft, Variance explanation, and Weekly recap.';

  var TOOL_META = {
    createImage: { short: 'Image' },
    searchWeb: { short: 'Search' },
    writeCode: { short: 'Write' },
    deepResearch: { short: 'Deep Search' },
    thinkLonger: { short: 'Think' },
  };
  var ADVISOR_TASKS = {
    daily_brief: 'daily_brief',
    followup_draft: 'followup_draft',
    variance_explain: 'variance_explain',
    weekly_recap: 'weekly_recap',
    general: 'general',
  };

  function mkUuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function norm(s) {
    return (s || '').toLowerCase().trim();
  }

  function fmtUsd(n) {
    var v = Math.round(Number(n) || 0);
    return '$' + v.toLocaleString('en-US');
  }

  function ymdFromDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /** Calendar bounds in local time, aligned with financial-core.js compute({ mode: 'month'|'range' }). */
  function resolvePeriodBounds(ql) {
    var ref = new Date();
    var y = ref.getFullYear();
    var m = ref.getMonth();
    var day = ref.getDate();

    if (/\b(all[\s-]?time|lifetime|everything|overall|entire\s+history)\b/.test(ql)) {
      return { kind: 'all', label: 'all time' };
    }
    if (/\b(year\s+to\s+date|ytd)\b/.test(ql)) {
      var ys = new Date(y, 0, 1);
      var ye = new Date(y, m, day);
      return { kind: 'range', start: ymdFromDate(ys), end: ymdFromDate(ye), label: 'year to date' };
    }
    if (/\b(last\s+year|previous\s+year)\b/.test(ql)) {
      var s = new Date(y - 1, 0, 1);
      var e = new Date(y - 1, 11, 31);
      return { kind: 'range', start: ymdFromDate(s), end: ymdFromDate(e), label: 'last calendar year' };
    }
    if (/\bthis\s+year\b/.test(ql)) {
      var s2 = new Date(y, 0, 1);
      var e2 = new Date(y, 11, 31);
      return { kind: 'range', start: ymdFromDate(s2), end: ymdFromDate(e2), label: 'this calendar year' };
    }
    if (/\b(last\s+month|previous\s+month)\b/.test(ql)) {
      var s3 = new Date(y, m - 1, 1);
      var e3 = new Date(y, m, 0);
      return { kind: 'range', start: ymdFromDate(s3), end: ymdFromDate(e3), label: 'last calendar month' };
    }
    if (/\b(last\s+30\s+days|past\s+30\s+days|last\s+thirty\s+days)\b/.test(ql)) {
      var end30 = new Date(y, m, day);
      var start30 = new Date(end30);
      start30.setDate(start30.getDate() - 29);
      return { kind: 'range', start: ymdFromDate(start30), end: ymdFromDate(end30), label: 'the last 30 days' };
    }
    if (/\b(last\s+7\s+days|past\s+week|last\s+week)\b/.test(ql)) {
      var end7 = new Date(y, m, day);
      var start7 = new Date(end7);
      start7.setDate(start7.getDate() - 6);
      return { kind: 'range', start: ymdFromDate(start7), end: ymdFromDate(end7), label: 'the last 7 days' };
    }
    if (/\b(this\s+month|current\s+month)\b/.test(ql)) {
      var s4 = new Date(y, m, 1);
      var e4 = new Date(y, m + 1, 0);
      return { kind: 'range', start: ymdFromDate(s4), end: ymdFromDate(e4), label: 'this calendar month' };
    }
    return null;
  }

  function tryLedgerFinancialAnswer(q) {
    if (typeof window.bizDashLedgerSummaryRange !== 'function' || typeof window.bizDashLedgerSummaryAll !== 'function') {
      return null;
    }

    var ql = norm(q);
    if (!ql) return null;

    var wantsBreakdown = /\b(break\s*down|by\s+category|split|each\s+category)\b/.test(ql);
    var wantsGross = /\bgross\s+profit\b/.test(ql) || /\bgross\s+margin\b/.test(ql);
    var wantsNet = /\bnet\s+profit\b/.test(ql) || /\bnet\s+income\b/.test(ql) || /\bbottom\s*line\b/.test(ql);
    var wantsProfitGeneric = /\bprofit\b/.test(ql) && !wantsGross && !wantsNet;
    var wantsExpense =
      /\b(expenses?|spending|spend|costs?|burn)\b/.test(ql) ||
      /\b(how\s+much)\b.*\b(spent|spend|pay|paid)\b/.test(ql) ||
      (/\bwhat\s+are\b/.test(ql) && /\bexpenses?\b/.test(ql));
    var wantsRevenue =
      (!wantsNet && !wantsGross && (/\b(revenue|turnover)\b/.test(ql) || /\b(total\s+)?income\b/.test(ql))) ||
      /\b(sales|earnings)\b/.test(ql) ||
      /\b(how\s+much)\b.*\b(make|made|earn|earned)\b/.test(ql);
    if (/\bnet\s+profit\b/.test(ql) || /\bnet\s+income\b/.test(ql)) wantsRevenue = false;

    if (!wantsExpense && !wantsRevenue && !wantsNet && !wantsProfitGeneric && !wantsGross) return null;

    var period = resolvePeriodBounds(ql);
    var defaultedPeriod = false;
    if (!period && (wantsExpense || wantsRevenue || wantsNet || wantsProfitGeneric || wantsGross)) {
      var ref = new Date();
      var y = ref.getFullYear();
      var m = ref.getMonth();
      var s = new Date(y, m, 1);
      var e = new Date(y, m + 1, 0);
      period = { kind: 'range', start: ymdFromDate(s), end: ymdFromDate(e), label: 'this calendar month' };
      defaultedPeriod = true;
    }
    if (!period) return null;

    var s;
    if (period.kind === 'all') {
      s = window.bizDashLedgerSummaryAll();
    } else {
      s = window.bizDashLedgerSummaryRange(period.start, period.end);
    }
    if (!s) return null;

    var header =
      'From your loaded transaction ledger (same rules as the dashboard: categories lab/sw/ads/oth = expenses, svc/ret = revenue, owner equity “own” excluded):\n\n';
    var when =
      period.kind === 'all'
        ? 'Period: ' + period.label + '.'
        : 'Period: ' + period.label + ' (' + (s.startYmd || period.start) + ' → ' + (s.endYmd || period.end) + ').';
    if (defaultedPeriod) {
      when += ' (No explicit range in your message—I used the current calendar month.)';
    }
    when += '\nTransaction lines in range: ' + s.transactionCount + '.\n\n';

    var catExpenseLabels = { lab: 'Labor (delivery / COGS)', sw: 'Software & tools', ads: 'Advertising', oth: 'Other' };
    var catRevenueLabels = { svc: 'Service revenue', ret: 'Retainer revenue' };

    var singleCat = null;
    if (wantsExpense && /\blabor\b|\bcogs\b|\bdelivery\b/.test(ql)) singleCat = 'lab';
    else if (wantsExpense && /\bsoftware\b|\bsaas\b|\btools?\b/.test(ql)) singleCat = 'sw';
    else if (wantsExpense && /\bad(s|vertising)?\b/.test(ql)) singleCat = 'ads';
    else if (wantsExpense && /\bother\s+expenses?\b/.test(ql)) singleCat = 'oth';

    var lines = [header + when];

    function pushBreakdownExpense() {
      lines.push('Expense breakdown:');
      lines.push(
        '• ' +
          catExpenseLabels.lab +
          ': ' +
          fmtUsd(s.expenseByCat.lab) +
          '\n• ' +
          catExpenseLabels.sw +
          ': ' +
          fmtUsd(s.expenseByCat.sw) +
          '\n• ' +
          catExpenseLabels.ads +
          ': ' +
          fmtUsd(s.expenseByCat.ads) +
          '\n• ' +
          catExpenseLabels.oth +
          ': ' +
          fmtUsd(s.expenseByCat.oth),
      );
    }

    function pushBreakdownRevenue() {
      lines.push('Revenue breakdown:');
      lines.push('• ' + catRevenueLabels.svc + ': ' + fmtUsd(s.revenueByCat.svc) + '\n• ' + catRevenueLabels.ret + ': ' + fmtUsd(s.revenueByCat.ret));
    }

    if (wantsExpense) {
      if (singleCat && s.expenseByCat[singleCat] != null) {
        lines.push(catExpenseLabels[singleCat] + ': ' + fmtUsd(s.expenseByCat[singleCat]) + '.');
      } else {
        lines.push('Total expenses: ' + fmtUsd(s.expenseTotal) + '.');
        if (wantsBreakdown || s.expenseTotal > 0) pushBreakdownExpense();
      }
    }
    if (wantsRevenue) {
      lines.push('Total revenue: ' + fmtUsd(s.revenueTotal) + '.');
      if (wantsBreakdown || s.revenueTotal > 0) pushBreakdownRevenue();
    }
    if (wantsGross) {
      lines.push(
        'Gross profit (revenue minus labor/COGS only): ' +
          fmtUsd(s.grossProfit) +
          '.' +
          (s.grossMarginPct != null && !isNaN(s.grossMarginPct)
            ? ' Gross margin: ' + Math.round(s.grossMarginPct * 10) / 10 + '%.'
            : ''),
      );
    }
    if (wantsNet || wantsProfitGeneric) {
      lines.push('Net profit (revenue minus all expense buckets): ' + fmtUsd(s.netProfit) + '.');
    }

    if (s.transactionCount === 0) {
      lines.push('\nNo transactions fall in that range. Add lines on Income/Expenses or widen the period.');
    }

    return lines.join('\n');
  }

  function appendBubble(logEl, role, text) {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'asst');
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function appendThinkingBubble(logEl) {
    var div = document.createElement('div');
    div.className = 'chat-msg asst chat-msg-thinking';
    div.setAttribute('aria-busy', 'true');
    div.setAttribute('aria-label', 'Assistant is thinking');
    var inner = document.createElement('div');
    inner.className = 'chat-thinking-inner';
    var lab = document.createElement('span');
    lab.className = 'chat-thinking-label';
    lab.textContent = 'Thinking';
    var dots = document.createElement('span');
    dots.className = 'chat-thinking-dots';
    for (var i = 0; i < 3; i++) {
      dots.appendChild(document.createElement('span'));
    }
    inner.appendChild(lab);
    inner.appendChild(dots);
    div.appendChild(inner);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  }

  async function countRows(supabase, userId, table, organizationId) {
    if (!organizationId) {
      return { ok: false, err: 'Open your workspace link (path starts with your org slug) to count rows for that workspace.' };
    }
    var res = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('organization_id', organizationId);
    if (res.error) return { ok: false, err: res.error.message };
    return { ok: true, count: typeof res.count === 'number' ? res.count : 0 };
  }

  async function tryLiveCount(q, supabase, user) {
    if (!user || !supabase) return null;
    var orgId = typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null;
    if (!orgId) return null;
    var ql = norm(q);
    if (!/\b(how many|how\s+much|count|number of|total)\b/.test(ql)) return null;

    var specs = [
      { re: /\bclients?\b/, table: 'clients', label: 'client' },
      { re: /\btransactions?\b/, table: 'transactions', label: 'transaction' },
      { re: /\bprojects?\b/, table: 'projects', label: 'project' },
      { re: /\binvoices?\b/, table: 'invoices', label: 'invoice' },
      { re: /\bcampaigns?\b/, table: 'campaigns', label: 'campaign' },
      { re: /\b(timesheet\s+entries|timesheets?|time\s+entries)\b/, table: 'timesheet_entries', label: 'timesheet entry' },
    ];

    for (var i = 0; i < specs.length; i++) {
      if (specs[i].re.test(ql)) {
        var r = await countRows(supabase, user.id, specs[i].table, orgId);
        if (!r.ok) {
          return 'Could not count ' + specs[i].table + ': ' + r.err;
        }
        var noun = r.count === 1 ? specs[i].label : specs[i].label + 's';
        return 'You have ' + r.count + ' ' + noun + ' in this workspace (Supabase).';
      }
    }
    return null;
  }

  function answerStatic(q) {
    var ql = norm(q);

    if (!ql) return null;

    if (/\b(help|what can you|what do you do|capabilities)\b/.test(ql)) {
      return (
        'I can answer:\n' +
        '• Money questions from your loaded ledger (same math as the dashboard): expenses, revenue, gross/net profit by period\n' +
        '• Which Supabase tables and columns the dashboard expects\n' +
        '• How RLS scopes data to your account\n' +
        '• Where SQL migrations and Edge Functions live\n' +
        '• How static builds and deploy work\n' +
        '• Live counts for the current workspace (clients, transactions, projects, invoices, campaigns, timesheet rows) when you’re signed in with an org URL'
      );
    }

    if (/\b(hello|hi\b|hey)\b/.test(ql)) {
      return 'Hello! Ask about Supabase tables, RLS, Stripe fields, or say “how many projects do I have?” when you’re signed in on a workspace URL.';
    }

    if (/\b(table|tables|schema|database|supabase)\b/.test(ql)) {
      return (
        'Core tables (see supabase/dashboard_sync.sql and bootstrap_core.sql):\n' +
        '• clients — company/contact, industry, is_retainer, metadata (jsonb)\n' +
        '• transactions — date, category, amount, client_id, project_id, metadata (jsonb)\n' +
        '• projects — client link, status, value, case study fields\n' +
        '• invoices — links to income via income_tx_id; optional stripe_* columns\n' +
        '• campaigns — marketing pipeline\n' +
        '• timesheet_entries — date, account, project, minutes, billable\n' +
        '• app_settings — per-user json (project_statuses, dashboard_settings)'
      );
    }

    if (/\b(rls|row level|security|policy|policies|auth\.uid)\b/.test(ql)) {
      return (
        'Row level security ties rows to auth.uid() = user_id on most tables. ' +
        'clients and transactions also allow legacy rows where user_id IS NULL for select/update in some policies—see dashboard_sync.sql. ' +
        'The browser uses the Supabase anon key plus your JWT after sign-in; only your permitted rows are returned.'
      );
    }

    if (/\b(mrr|retainer|recurring)\b/.test(ql)) {
      return (
        'MRR on the dashboard comes from retainers: clients with is_retainer and related income transactions. ' +
        'The main KPI logic lives in public/assets/financial-core.js; client records are in public.clients.'
      );
    }

    if (/\b(stripe|checkout|payment intent)\b/.test(ql)) {
      return (
        'Invoices can store Stripe metadata: stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id, stripe_status. ' +
        'Edge Functions in supabase/functions/create-stripe-checkout-session and stripe-webhook integrate with Stripe (deploy separately in Supabase).'
      );
    }

    if (/\b(which file|where is|codebase|repository|repo)\b/.test(ql) && /\b(sql|migration|schema)\b/.test(ql)) {
      return 'Schema and RLS are in supabase/dashboard_sync.sql (full sync) and supabase/bootstrap_core.sql (minimal bootstrap).';
    }

    if (/\b(build|dist|netlify|deploy)\b/.test(ql)) {
      return (
        'npm run build runs scripts/build-static.mjs, which copies index.html and public/ into dist/. ' +
        'netlify.toml publishes dist/ and SPA-redirects to index.html. No bundler step for the main dashboard JS.'
      );
    }

    if (/\b(script|javascript|frontend)\b/.test(ql) && /\b(where|which|file)\b/.test(ql)) {
      return (
        'Main UI logic: public/assets/financial-core.js. Auth: public/assets/supabase-auth.js (creates window.supabaseClient). ' +
        'Entry markup: index.html.'
      );
    }

    if (/\b(sign in|signin|login|auth|github)\b/.test(ql)) {
      return (
        'Sign-in is handled in public/assets/supabase-auth.js using @supabase/supabase-js. ' +
        'After session is established, initDataFromSupabase loads your data into the dashboard.'
      );
    }

    if (/\b(performance|projects page)\b/.test(ql)) {
      return 'The Performance nav page drives project lists, statuses, and case-study fields stored on public.projects.';
    }

    if (/\b(insights|retention|churn)\b/.test(ql)) {
      return 'Insights and Retention pages analyze clients and transactions already loaded in the app (income gaps, churn risk, etc.).';
    }

    return null;
  }

  function mergeAdvisorCrmDraft(contactRequest, crmProposal) {
    var o = {};
    if (contactRequest && typeof contactRequest === 'object') {
      ['id', 'source', 'companyName', 'contactName', 'email', 'phone', 'notes', 'receivedAt'].forEach(function (k) {
        if (contactRequest[k] != null && String(contactRequest[k]).trim() !== '') o[k] = contactRequest[k];
      });
    }
    if (crmProposal && typeof crmProposal === 'object') {
      ['companyName', 'contactName', 'email', 'phone', 'notes', 'status', 'industry'].forEach(function (k) {
        if (crmProposal[k] != null && String(crmProposal[k]).trim() !== '') o[k] = crmProposal[k];
      });
    }
    return o;
  }

  function normalizeTask(task, message) {
    if (task && ADVISOR_TASKS[task]) return task;
    var q = norm(message || '');
    if (/brief|today|priority|action/.test(q)) return ADVISOR_TASKS.daily_brief;
    if (/follow|outreach|draft|email|message/.test(q)) return ADVISOR_TASKS.followup_draft;
    if (/variance|month[-\s]?over[-\s]?month|mo[m]?/.test(q)) return ADVISOR_TASKS.variance_explain;
    if (/week|recap|summary/.test(q)) return ADVISOR_TASKS.weekly_recap;
    return ADVISOR_TASKS.general;
  }

  function renderAdvisorPayload(el, payload) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    var p = payload || {};
    if (p.title) {
      var ttl = document.createElement('div');
      ttl.style.fontWeight = '600';
      ttl.style.marginBottom = '6px';
      ttl.textContent = String(p.title);
      el.appendChild(ttl);
    }
    if (Array.isArray(p.bullets) && p.bullets.length) {
      var ul = document.createElement('ul');
      ul.style.margin = '0 0 8px 18px';
      ul.style.padding = '0';
      p.bullets.forEach(function (b) {
        var li = document.createElement('li');
        li.textContent = String(b);
        ul.appendChild(li);
      });
      el.appendChild(ul);
    }
    if (p.draft) {
      var draft = document.createElement('div');
      draft.style.marginTop = '8px';
      draft.style.padding = '8px 10px';
      draft.style.border = '1px solid var(--border)';
      draft.style.borderRadius = '10px';
      draft.style.background = 'var(--bg2)';
      draft.textContent = String(p.draft);
      el.appendChild(draft);
    }
    if ((!p.title && (!p.bullets || !p.bullets.length) && !p.draft) && p.text) {
      el.textContent = String(p.text);
    }
  }

  async function logAdvisorUsage(entry) {
    var supabase = window.supabaseClient;
    var user = window.currentUser;
    if (!supabase || !user || !entry) return;
    try {
      await supabase.from('ai_usage_events').insert(entry);
    } catch (_) {}
  }

  async function logAdvisorFeedback(entry) {
    var supabase = window.supabaseClient;
    var user = window.currentUser;
    if (!supabase || !user || !entry) return;
    try {
      await supabase.from('ai_feedback').insert(entry);
    } catch (_) {}
  }

  async function logAdvisorActionOutcome(entry) {
    var supabase = window.supabaseClient;
    var user = window.currentUser;
    if (!supabase || !user || !entry) return;
    try {
      await supabase.from('ai_action_outcomes').insert(entry);
    } catch (_) {}
  }

  async function invokeAdvisorTask(req) {
    var supabase = window.supabaseClient;
    var user = window.currentUser;
    if (!supabase || !user) {
      return {
        ok: false,
        error: 'Sign in to use Advisor task stubs.',
        response: { title: 'Sign in required', bullets: ['Advisor tasks are scoped per user session.'] },
      };
    }
    try {
      var session = null;
      try {
        var sessRes = await supabase.auth.getSession();
        session = sessRes && sessRes.data ? sessRes.data.session : null;
      } catch (_) {}
      if (!session || !session.access_token) {
        return {
          ok: false,
          error: 'No active auth session. Sign in again to use Advisor.',
          response: { title: 'Sign in required', bullets: ['Your session expired or demo mode is active. Sign in to use Advisor.'] },
        };
      }
      var res = await supabase.functions.invoke('ai-assistant', {
        body: req,
        headers: {
          Authorization: 'Bearer ' + session.access_token,
        },
      });
      if (res.error) {
        return { ok: false, error: res.error.message || 'Invoke failed', response: { title: 'Stub call failed', bullets: [res.error.message || 'Unknown function error'] } };
      }
      return { ok: true, response: res.data || { title: 'No data', bullets: [] } };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err), response: { title: 'Stub call failed', bullets: ['Advisor function could not be reached.'] } };
    }
  }

  window.wireDashboardAssistant = function () {
    var pageChat = document.getElementById('page-chat');
    var composerStack = pageChat ? pageChat.querySelector('.chat-composer-stack') : null;
    var logEl = document.getElementById('chat-log');
    var ta = document.getElementById('chat-input');
    var sendBtn = document.getElementById('chat-send');
    var starters = document.getElementById('chat-starters');
    var promptBox = document.getElementById('chat-prompt-box');
    var fileInput = document.getElementById('chat-file-input');
    var attachBtn = document.getElementById('chat-attach-btn');
    var previewWrap = document.getElementById('chat-image-preview-wrap');
    var thumbImg = document.getElementById('chat-image-thumb');
    var thumbBtn = document.getElementById('chat-image-thumb-btn');
    var removeImgBtn = document.getElementById('chat-image-remove');
    var toolsTrigger = document.getElementById('chat-tools-trigger');
    var toolsPop = document.getElementById('chat-tools-pop');
    var toolsLabel = document.getElementById('chat-tools-label');
    var activeToolEl = document.getElementById('chat-active-tool');
    var activeToolName = document.getElementById('chat-active-tool-name');
    var activeToolClear = document.getElementById('chat-active-tool-clear');
    var lightbox = document.getElementById('chat-lightbox');
    var lightboxImg = document.getElementById('chat-lightbox-img');
    var lightboxClose = document.getElementById('chat-lightbox-close');
    var micBtn = document.getElementById('chat-mic-btn');

    if (!logEl || !ta || !sendBtn) return;

    var imagePreview = null;
    var selectedTool = null;
    var docked = true;
    if (pageChat) pageChat.classList.add('chat-compose-docked');

    function setComposeDocked(on) {
      if (!pageChat || !composerStack) return;
      var next = true;
      if (next === docked) return;
      docked = next;
      pageChat.classList.toggle('chat-compose-docked', next);
    }

    function syncSendDisabled() {
      var has = ta.value.trim().length > 0 || !!imagePreview;
      sendBtn.disabled = !has;
    }

    function autoResizeTa() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }

    function setImagePreview(dataUrl) {
      imagePreview = dataUrl || null;
      if (imagePreview) {
        thumbImg.src = imagePreview;
        previewWrap.hidden = false;
      } else {
        thumbImg.removeAttribute('src');
        previewWrap.hidden = true;
        if (fileInput) fileInput.value = '';
      }
      syncSendDisabled();
    }

    function setToolsOpen(open) {
      if (!toolsPop || !toolsTrigger) return;
      toolsPop.hidden = !open;
      toolsTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setSelectedTool(id) {
      selectedTool = id || null;
      if (!activeToolEl || !activeToolName || !toolsLabel) return;
      if (selectedTool && TOOL_META[selectedTool]) {
        activeToolEl.hidden = false;
        activeToolName.textContent = TOOL_META[selectedTool].short;
        toolsLabel.style.display = 'none';
      } else {
        activeToolEl.hidden = true;
        toolsLabel.style.display = '';
      }
    }

    ta.addEventListener('input', function () {
      if ((ta.value || '').trim()) setComposeDocked(true);
      syncSendDisabled();
      autoResizeTa();
    });

    ta.addEventListener('focus', function () {
      setComposeDocked(true);
    });
    ta.addEventListener('blur', function () {});

    if (promptBox) {
      promptBox.addEventListener('click', function (ev) {
        if (ev.target.closest('button') || ev.target.closest('textarea')) return;
        ta.focus();
      });
    }

    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () {
        fileInput.click();
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', function (ev) {
        var file = ev.target.files && ev.target.files[0];
        if (file && file.type.indexOf('image/') === 0) {
          var reader = new FileReader();
          reader.onloadend = function () {
            setImagePreview(reader.result);
          };
          reader.readAsDataURL(file);
        }
        ev.target.value = '';
      });
    }

    if (removeImgBtn) {
      removeImgBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setImagePreview(null);
      });
    }

    if (thumbBtn && lightbox && lightboxImg) {
      thumbBtn.addEventListener('click', function () {
        if (!imagePreview) return;
        lightboxImg.src = imagePreview;
        lightbox.hidden = false;
      });
    }

    function closeLightbox() {
      if (lightbox) lightbox.hidden = true;
      if (lightboxImg) lightboxImg.removeAttribute('src');
    }

    if (lightbox) {
      lightbox.addEventListener('click', function (ev) {
        if (ev.target === lightbox || ev.target === lightboxImg) closeLightbox();
      });
    }
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);

    if (toolsTrigger && toolsPop) {
      toolsTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        setToolsOpen(toolsPop.hidden);
      });
    }

    if (toolsPop) {
      toolsPop.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = ev.target.closest('[data-chat-tool]');
        if (!row) return;
        var id = row.getAttribute('data-chat-tool');
        setSelectedTool(id);
        setToolsOpen(false);
      });
    }

    if (activeToolClear) {
      activeToolClear.addEventListener('click', function () {
        setSelectedTool(null);
      });
    }

    document.addEventListener('click', function () {
      setToolsOpen(false);
    });

    if (micBtn) {
      micBtn.addEventListener('click', function () {
        /* Title explains; no modal */
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        setToolsOpen(false);
        if (lightbox && !lightbox.hidden) closeLightbox();
        if (document.activeElement === ta) {
          ta.blur();
          if (!(ta.value || '').trim()) setComposeDocked(false);
        }
      }
    });

    var seeded = false;
    var isThinking = false;
    var pendingTask = null;
    function seedWelcome() {
      if (seeded) return;
      seeded = true;
      var isMobile = false;
      try {
        isMobile = !!(window.matchMedia && window.matchMedia('(max-width: 960px)').matches);
      } catch (_) {}
      appendBubble(logEl, 'asst', isMobile ? WELCOME_MOBILE : WELCOME);
    }

    function appendFeedbackControls(messageEl, usageMeta) {
      if (!messageEl || !usageMeta || !usageMeta.usageEventId) return;
      var row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '6px';
      row.style.marginTop = '8px';
      var up = document.createElement('button');
      var down = document.createElement('button');
      up.type = 'button';
      down.type = 'button';
      up.className = 'btn';
      down.className = 'btn';
      up.textContent = 'Useful';
      down.textContent = 'Not useful';
      function lock(sel) {
        up.disabled = true;
        down.disabled = true;
        if (sel) sel.style.borderColor = 'var(--coral)';
      }
      up.addEventListener('click', function () {
        lock(up);
        logAdvisorFeedback({
          id: mkUuid(),
          user_id: window.currentUser && window.currentUser.id ? window.currentUser.id : null,
          organization_id: typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null,
          usage_event_id: usageMeta.usageEventId,
          task: usageMeta.task,
          sentiment: 'up',
          note: null,
          created_at: new Date().toISOString(),
        });
      });
      down.addEventListener('click', function () {
        lock(down);
        logAdvisorFeedback({
          id: mkUuid(),
          user_id: window.currentUser && window.currentUser.id ? window.currentUser.id : null,
          organization_id: typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null,
          usage_event_id: usageMeta.usageEventId,
          task: usageMeta.task,
          sentiment: 'down',
          note: null,
          created_at: new Date().toISOString(),
        });
      });
      row.appendChild(up);
      row.appendChild(down);
      messageEl.appendChild(row);
    }

    function appendActionButtons(messageEl, usageMeta, actions) {
      if (!messageEl || !Array.isArray(actions) || !actions.length || !usageMeta || !usageMeta.usageEventId) return;
      var row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '6px';
      row.style.flexWrap = 'wrap';
      row.style.marginTop = '8px';
      actions.forEach(function (action) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = action.label || action.id || 'Action';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          logAdvisorActionOutcome({
            id: mkUuid(),
            user_id: window.currentUser && window.currentUser.id ? window.currentUser.id : null,
            organization_id: typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null,
            usage_event_id: usageMeta.usageEventId,
            task: usageMeta.task,
            action_id: action.id || btn.textContent,
            action_label: action.label || btn.textContent,
            outcome: 'applied',
            details: {},
            created_at: new Date().toISOString(),
          });
        });
        row.appendChild(btn);
      });
      messageEl.appendChild(row);
    }

    function appendCrmProposalControls(messageEl, usageMeta, crmProposal, contactRequestSnapshot) {
      if (!messageEl || !usageMeta || !usageMeta.usageEventId) return;
      var prop = crmProposal && typeof crmProposal === 'object' ? crmProposal : null;
      if (!prop || !String(prop.companyName || '').trim()) return;
      var merged = mergeAdvisorCrmDraft(contactRequestSnapshot, prop);
      delete merged.confidence;
      var row = document.createElement('div');
      row.className = 'advisor-crm-proposal-actions';
      row.style.display = 'flex';
      row.style.gap = '6px';
      row.style.flexWrap = 'wrap';
      row.style.marginTop = '10px';
      var review = document.createElement('button');
      review.type = 'button';
      review.className = 'btn';
      review.textContent = 'Review in CRM';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-p';
      addBtn.textContent = 'Add to CRM';
      review.addEventListener('click', async function () {
        if (typeof window.bizDashOpenClientModalWithDraft !== 'function') return;
        review.disabled = true;
        try {
          if (typeof window.nav === 'function') window.nav('customers', null);
          await window.bizDashOpenClientModalWithDraft(merged);
          await logAdvisorActionOutcome({
            id: mkUuid(),
            user_id: window.currentUser && window.currentUser.id ? window.currentUser.id : null,
            organization_id: typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null,
            usage_event_id: usageMeta.usageEventId,
            task: usageMeta.task,
            action_id: 'crm-review-modal',
            action_label: 'Review in CRM',
            outcome: 'applied',
            details: { companyName: merged.companyName || null },
            created_at: new Date().toISOString(),
          });
        } finally {
          review.disabled = false;
        }
      });
      addBtn.addEventListener('click', async function () {
        if (typeof window.bizDashCreateClientFromDraft !== 'function') return;
        var label = String(merged.companyName || 'this contact').trim();
        if (!window.confirm('Add ' + label + ' to your CRM now?')) return;
        addBtn.disabled = true;
        review.disabled = true;
        var result = await window.bizDashCreateClientFromDraft(merged);
        await logAdvisorActionOutcome({
          id: mkUuid(),
          user_id: window.currentUser && window.currentUser.id ? window.currentUser.id : null,
          organization_id: typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null,
          usage_event_id: usageMeta.usageEventId,
          task: usageMeta.task,
          action_id: 'crm-add-client',
          action_label: 'Add to CRM',
          outcome: result && result.ok ? 'applied' : 'error',
          details: {
            clientId: result && result.client && result.client.id ? result.client.id : null,
            error: result && result.error ? result.error : null,
          },
          created_at: new Date().toISOString(),
        });
        if (result && result.ok && typeof window.nav === 'function') window.nav('customers', null);
        else if (!result || !result.ok) {
          window.alert((result && result.error) || 'Could not add client.');
          addBtn.disabled = false;
          review.disabled = false;
        }
      });
      row.appendChild(review);
      row.appendChild(addBtn);
      messageEl.appendChild(row);
    }

    async function handleSend(text) {
      if (isThinking) return;
      var t = (text || '').trim();
      var hadImage = !!imagePreview;
      if (!t && !hadImage) return;
      seedWelcome();

      var userLine = t || '(Image attached)';
      appendBubble(logEl, 'user', userLine);

      ta.value = '';
      autoResizeTa();
      setImagePreview(null);
      ta.blur();

      isThinking = true;
      sendBtn.disabled = true;
      var thinkingEl = appendThinkingBubble(logEl);

      var t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      var out;
      var usageMeta = null;
      var contactSnapshot = null;
      try {
        var task = normalizeTask(pendingTask, t);
        contactSnapshot =
          typeof window.bizDashGetAdvisorContactContext === 'function' ? window.bizDashGetAdvisorContactContext() : null;
        var clientsDigest =
          typeof window.bizDashGetClientsDigestForAdvisor === 'function' ? window.bizDashGetClientsDigestForAdvisor() : [];
        var orgId = typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : window.currentOrganizationId;
        var request = {
          organizationId: orgId || undefined,
          task: task,
          message: t,
          context: {
            page: 'advisor',
            hadImage: !!hadImage,
            selectedTool: selectedTool || null,
            contactRequest: contactSnapshot,
            clientsDigest: clientsDigest,
          },
          constraints: { maxBullets: 5, tone: 'concise' },
        };
        out = await invokeAdvisorTask(request);
        var t1req = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        usageMeta = { usageEventId: mkUuid(), task: task };
        await logAdvisorUsage({
          id: usageMeta.usageEventId,
          user_id: window.currentUser && window.currentUser.id ? window.currentUser.id : null,
          organization_id: typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : null,
          task: task,
          request_payload: request,
          response_payload: out && out.response ? out.response : {},
          status: out && out.ok ? 'ok' : 'error',
          latency_ms: Math.max(0, Math.round(t1req - t0)),
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        out = { ok: false, response: { title: 'Advisor unavailable', bullets: ['Something went wrong while preparing a reply. Try again.'] } };
        if (typeof console !== 'undefined' && console.error) console.error(err);
      }
      var t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      var elapsed = t1 - t0;
      if (elapsed < THINKING_MIN_MS) {
        await delay(THINKING_MIN_MS - elapsed);
      }

      thinkingEl.className = 'chat-msg asst';
      thinkingEl.removeAttribute('aria-busy');
      thinkingEl.removeAttribute('aria-label');
      while (thinkingEl.firstChild) {
        thinkingEl.removeChild(thinkingEl.firstChild);
      }
      renderAdvisorPayload(thinkingEl, out && out.response ? out.response : { text: 'No response.' });
      if (out && out.response && out.response.crmProposal && usageMeta) {
        appendCrmProposalControls(thinkingEl, usageMeta, out.response.crmProposal, contactSnapshot);
      }
      if (out && out.response && Array.isArray(out.response.actions) && usageMeta) {
        appendActionButtons(thinkingEl, usageMeta, out.response.actions);
      }
      if (usageMeta) appendFeedbackControls(thinkingEl, usageMeta);
      pendingTask = null;

      logEl.scrollTop = logEl.scrollHeight;
      isThinking = false;
      syncSendDisabled();
    }

    sendBtn.addEventListener('click', function () {
      handleSend(ta.value);
    });

    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        if (!sendBtn.disabled) handleSend(ta.value);
      }
    });

    if (starters) {
      starters.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-chat-q]');
        if (!btn) return;
        var q = btn.getAttribute('data-chat-q');
        var task = btn.getAttribute('data-advisor-task');
        if (q) {
          pendingTask = task || null;
          ta.value = q;
          autoResizeTa();
          syncSendDisabled();
          handleSend(q);
        }
      });
    }

    if (document.getElementById('page-chat') && document.getElementById('page-chat').classList.contains('on')) {
      seedWelcome();
    }

    syncSendDisabled();
    autoResizeTa();

    window.bizDashAskAdvisorToAddContactRequest = function (contactRequest) {
      if (typeof window.bizDashSetAdvisorContactContext === 'function') {
        window.bizDashSetAdvisorContactContext(contactRequest || null);
      }
      if (typeof window.nav === 'function') window.nav('chat', null);
      seedWelcome();
      var c = contactRequest && typeof contactRequest === 'object' ? contactRequest : {};
      var company = String(c.companyName || '').trim();
      var contact = String(c.contactName || '').trim();
      var who = [contact, company].filter(Boolean).join(' at ');
      ta.value = who
        ? 'Add this contact request to my CRM: ' + who + '. Use Lead status and suggest any missing fields.'
        : 'Add this contact request to my CRM with Lead status and suggest any missing fields.';
      autoResizeTa();
      syncSendDisabled();
      ta.focus();
    };

    window.seedDashboardChatWelcome = seedWelcome;
  };
})();
