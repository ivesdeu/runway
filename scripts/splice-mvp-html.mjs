import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'index.html');
let s = fs.readFileSync(path, 'utf8');

s = s.replace(
  /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"]+"><\/script>\s*<script>[\s\S]*?<\/script>\s*/i,
  ''
);
s = s.replace(/<title>[^<]*<\/title>/, '<title>Runway — Lead &amp; campaign performance</title>');

const start = s.indexOf('<div id="auth-loading">');
const scriptIdx = s.indexOf('<script src="https://cdn.jsdelivr.net/npm/@supabase');
if (start === -1 || scriptIdx === -1) {
  console.error('markers', start, scriptIdx);
  process.exit(1);
}

const newBody = `<div id="auth-loading" style="display:none;">
  <span class="auth-loading-inner"><span>Loading</span></span>
</div>
<div id="auth-login-shell" style="display:none;">
  <div class="gate-card"><div class="pt">Sign in disabled</div><p style="font-size:13px;color:var(--text2);">This MVP loads local mock data only.</p></div>
</div>

<div id="app-shell" class="on">
<div id="app-invite-flash" style="display:none;margin:0;padding:10px 14px;font-size:13px;line-height:1.45;color:var(--text);background:var(--bg3);border-bottom:1px solid var(--border);"></div>
<div class="mobile-topbar">
  <button type="button" id="btn-mobile-menu" class="mobile-menu-btn" aria-label="Open navigation" onclick="document.body.classList.toggle('mobile-nav-open')"><span></span></button>
  <div class="mobile-topbar-title" id="mobile-title">Leads &amp; clients</div>
</div>
<div class="mobile-nav-overlay" id="mobile-nav-overlay" onclick="document.body.classList.remove('mobile-nav-open')"></div>
<div class="sb">
  <div class="sb-logo">
    <img class="sb-brand-img" id="sb-brand-img" src="/runway-wordmark.svg" width="188" height="28" alt="Runway" loading="eager" decoding="async" />
  </div>
  <nav class="sb-nav">
    <div class="nav-lbl">Dashboard</div>
    <div class="ni active" data-nav="leads" onclick="nav('leads',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Leads / clients
    </div>
    <div class="ni" data-nav="campaigns" onclick="nav('campaigns',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 6-7"/></svg>
      Campaigns
    </div>
    <div class="ni" data-nav="connections" onclick="nav('connections',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
      Connections
    </div>
    <div class="sb-spacer"></div>
  </nav>
  <div class="sb-user" id="sb-user-menu">
    <div class="avatar" id="user-avatar">A</div>
    <div style="min-width:0;flex:1;">
      <div id="user-name" class="sb-user-name">Agency demo</div>
      <div id="user-role" class="sb-user-role">Local mock data</div>
    </div>
  </div>
</div>

<div class="main mobile-main-offset">

  <div class="pg on" id="page-leads">
    <div class="ph">
      <div>
        <div class="pt">Leads &amp; clients</div>
        <div class="ps">Who came in, what they paid, and which campaign gets credit.</div>
      </div>
      <div class="hr">
        <button type="button" class="btn btn-p" id="btn-add-lead">+ Add lead</button>
      </div>
    </div>
    <div class="card mb" style="margin-bottom:16px;">
      <div class="fg" style="margin-bottom:0;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));align-items:end;">
        <div class="fgp"><label class="fl">Status</label>
          <select class="fi" id="lead-filter-status"><option value="all">All</option><option value="lead">Lead</option><option value="closed">Closed sale</option></select>
        </div>
        <div class="fgp"><label class="fl">Campaign</label>
          <select class="fi" id="lead-filter-campaign"><option value="all">All campaigns</option></select>
        </div>
        <div class="fgp"><label class="fl">From</label><input class="fi" type="date" id="lead-filter-from" /></div>
        <div class="fgp"><label class="fl">To</label><input class="fi" type="date" id="lead-filter-to" /></div>
      </div>
    </div>
    <div class="card">
      <div id="leads-empty" style="font-size:13px;color:var(--text3);padding:8px 0;">No rows match your filters.</div>
      <table class="dt" id="leads-table" style="display:none;">
        <thead><tr><th>Name</th><th>Status</th><th>Payment</th><th>Keyword</th><th>Campaign</th><th>Date added</th><th style="width:100px;"></th></tr></thead>
        <tbody id="leads-tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="pg" id="page-campaigns">
    <div class="ph">
      <div>
        <div class="pt">Campaigns</div>
        <div class="ps">Spend vs closed revenue; ROI updates from your lead records.</div>
      </div>
      <div class="hr">
        <button type="button" class="btn btn-p" id="btn-add-campaign">+ Add campaign</button>
      </div>
    </div>
    <div id="campaigns-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;"></div>
  </div>

  <div class="pg" id="page-connections">
    <div class="ph">
      <div>
        <div class="pt">Connections</div>
        <div class="ps">Link data sources and imports. Only Sheets/CSV import is live in this MVP.</div>
      </div>
    </div>
    <div class="g2" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));">
      <div class="card">
        <div class="sh" style="margin-bottom:8px;"><div class="st">CRM sync</div></div>
        <p style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:12px;">Connected to your internal CRM database. Lead records sync automatically.</p>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <span id="conn-crm-dot" style="width:10px;height:10px;border-radius:50%;background:var(--green);"></span>
          <span id="conn-crm-status" style="font-size:13px;font-weight:600;">Connected</span>
        </div>
        <button type="button" class="btn" id="btn-conn-crm-placeholder">Toggle demo status</button>
      </div>
      <div class="card">
        <div class="sh" style="margin-bottom:8px;"><div class="st">Google Sheets / CSV</div></div>
        <p style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:12px;">Import rows and map columns to name, status, payment, keyword, and campaign. Preview before saving.</p>
        <button type="button" class="btn btn-p" id="btn-conn-csv-open">Import CSV</button>
      </div>
      <div class="card">
        <div class="sh" style="margin-bottom:8px;"><div class="st">Google Analytics 4</div></div>
        <p style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:12px;">Placeholder — no OAuth yet.</p>
        <button type="button" class="btn" id="btn-conn-ga4">Connect GA4</button>
      </div>
      <div class="card">
        <div class="sh" style="margin-bottom:8px;"><div class="st">Salesforce</div></div>
        <p style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:12px;">Placeholder — future integration.</p>
        <button type="button" class="btn" id="btn-conn-sf">Connect Salesforce</button>
      </div>
    </div>
  </div>

  <div class="mo" id="leadClientModal">
    <div class="md" style="max-width:480px;">
      <div class="mt" id="lead-modal-title">Add lead / client</div>
      <input type="hidden" id="lead-edit-id" value="" />
      <div class="fg" style="margin-bottom:16px;">
        <div class="fgp" style="grid-column:1/-1;"><label class="fl">Name *</label><input class="fi" id="lead-field-name" placeholder="Company or person" /></div>
        <div class="fgp"><label class="fl">Status</label>
          <select class="fi" id="lead-field-status"><option value="lead">Lead</option><option value="closed">Closed sale</option></select>
        </div>
        <div class="fgp" id="lead-payment-wrap" style="display:none;"><label class="fl">Payment amount</label><input class="fi" id="lead-field-payment" type="number" min="0" step="1" placeholder="0" /></div>
        <div class="fgp" style="grid-column:1/-1;"><label class="fl">Search keyword</label><input class="fi" id="lead-field-keyword" placeholder="Optional" /></div>
        <div class="fgp" style="grid-column:1/-1;"><label class="fl">Campaign</label><select class="fi" id="lead-field-campaign"><option value="">— Unassigned —</option></select></div>
        <div class="fgp"><label class="fl">Date added</label><input class="fi" id="lead-field-date" type="date" /></div>
      </div>
      <div class="mf" style="border-top:none;padding-top:0;">
        <button type="button" class="btn" id="btn-lead-cancel">Cancel</button>
        <button type="button" class="btn btn-p" id="btn-lead-save">Save</button>
      </div>
    </div>
  </div>

  <div class="mo" id="campaignMvpModal">
    <div class="md" style="max-width:440px;">
      <div class="mt" id="campaign-mvp-title">Add campaign</div>
      <input type="hidden" id="campaign-mvp-edit-id" value="" />
      <div class="fg" style="margin-bottom:16px;">
        <div class="fgp" style="grid-column:1/-1;"><label class="fl">Campaign name *</label><input class="fi" id="campaign-mvp-name" /></div>
        <div class="fgp"><label class="fl">Channel</label><select class="fi" id="campaign-mvp-channel"></select></div>
        <div class="fgp"><label class="fl">Total spend</label><input class="fi" id="campaign-mvp-spend" type="number" min="0" step="100" /></div>
      </div>
      <div class="mf" style="border-top:none;padding-top:0;">
        <button type="button" class="btn" id="btn-campaign-mvp-cancel">Cancel</button>
        <button type="button" class="btn btn-p" id="btn-campaign-mvp-save">Save</button>
      </div>
    </div>
  </div>

  <div class="mo" id="connectionsCsvModal">
    <div class="md" style="max-width:760px;max-height:92vh;display:flex;flex-direction:column;">
      <div class="mt">Import CSV</div>
      <p style="font-size:13px;color:var(--text2);line-height:1.45;margin-bottom:12px;">Choose a file or paste CSV text, map columns, preview, then confirm.</p>
      <div id="csv-import-step1" style="flex:1;min-height:0;">
        <label class="fl">CSV file</label>
        <input type="file" class="fi" id="csv-import-file" accept=".csv,text/csv" />
        <label class="fl" style="margin-top:14px;">Or paste CSV</label>
        <textarea class="fi" id="csv-import-paste" rows="6" placeholder="name,status,payment,..." style="resize:vertical;min-height:120px;font-family:var(--font-mono);font-size:12px;"></textarea>
      </div>
      <div id="csv-import-step2" style="display:none;flex:1;min-height:0;overflow:auto;">
        <div class="fg" style="margin-bottom:0;">
          <div class="fgp"><label class="fl">Name *</label><select class="fi" id="map-name"></select></div>
          <div class="fgp"><label class="fl">Status</label><select class="fi" id="map-status"></select></div>
          <div class="fgp"><label class="fl">Payment</label><select class="fi" id="map-payment"></select></div>
          <div class="fgp"><label class="fl">Keyword</label><select class="fi" id="map-keyword"></select></div>
          <div class="fgp"><label class="fl">Campaign</label><select class="fi" id="map-campaign"></select></div>
          <div class="fgp"><label class="fl">Date added</label><select class="fi" id="map-dateAdded"></select></div>
        </div>
      </div>
      <div id="csv-import-step3" style="display:none;flex:1;min-height:0;flex-direction:column;">
        <div class="st" style="font-size:13px;margin-bottom:8px;">Preview (first rows)</div>
        <div style="overflow:auto;max-height:280px;border:1px solid var(--border);border-radius:var(--rl);">
          <table class="dt" style="margin:0;">
            <thead><tr><th>Name</th><th>Status</th><th>Payment</th><th>Keyword</th><th>Campaign</th><th>Date</th></tr></thead>
            <tbody id="csv-import-preview-body"></tbody>
          </table>
        </div>
      </div>
      <div class="mf" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;flex-shrink:0;">
        <button type="button" class="btn" id="csv-import-cancel">Cancel</button>
        <button type="button" class="btn" id="csv-import-back" style="display:none;">Back</button>
        <button type="button" class="btn btn-p" id="csv-import-next">Next</button>
        <button type="button" class="btn btn-p" id="csv-import-commit" style="display:none;">Confirm import</button>
      </div>
    </div>
  </div>

  <div class="mo stub-pop" id="stubFeatureModal" onclick="if (event.target === this) this.classList.remove('on')">
    <div class="md" onclick="event.stopPropagation()">
      <div class="mt" id="stubFeatureTitle">Coming soon</div>
      <p class="stub-body" id="stubFeatureBody" style="font-size:14px;color:var(--text2);line-height:1.5;">This integration is not available yet.</p>
      <div class="mf" style="border-top:none;padding-top:0;">
        <button type="button" class="btn btn-p" id="stubFeatureOk">OK</button>
      </div>
    </div>
  </div>

</div>
</div><!-- #app-shell -->

<div class="mobile-actions">
  <button type="button" class="btn" onclick="document.getElementById('btn-add-lead')?.click()">+ Lead</button>
  <button type="button" class="btn btn-p" onclick="document.getElementById('btn-add-campaign')?.click()">+ Campaign</button>
</div>

`;

s = s.slice(0, start) + newBody + '<script src="/assets/agency-mvp.js?v=20260419-mvp"></script>\n</body>\n</html>\n';
fs.writeFileSync(path, s);
console.log('Wrote', path, 'length', s.length);
