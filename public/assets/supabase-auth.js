// supabase-auth.js
// Supabase auth gate + organization slug routing (path /:slug/…).

(function () {
  'use strict';

  var PENDING_INVITE_KEY = 'bizdash_pending_org_invite';
  var FLASH_INVITE_KEY = 'bizdash_flash_invite_msg';

  // NOTE: anon key is safe to expose in the browser.
  var SUPABASE_URL = 'https://ausivxesedagohjlthiy.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1c2l2eGVzZWRhZ29oamx0aGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU3MTEsImV4cCI6MjA5MDYzMTcxMX0.H5PRdJVXCq8_9CbB12F6xFzy0ljqz1-aiVZmguErLxk';

  if (!window.supabase) {
    console.error('Supabase JS not loaded. Check CDN <script> tag.');
    function recoverNoSupabaseClient() {
      var loading = document.getElementById('auth-loading');
      var shell = document.getElementById('auth-login-shell');
      var app = document.getElementById('app-shell');
      var ge = document.getElementById('gate-auth-error');
      if (loading) loading.style.display = 'none';
      if (shell) shell.style.display = 'flex';
      if (app) app.classList.remove('on');
      if (ge) {
        ge.textContent =
          'The sign-in library did not load. Check your connection, allow cdn.jsdelivr.net, then refresh. Sign-in will not work until this script loads.';
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', recoverNoSupabaseClient);
    } else {
      recoverNoSupabaseClient();
    }
    return;
  }

  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.supabaseClient = supabase;
  /** Used by team Edge `fetch` (CDN bundles may not expose `supabaseUrl` / `supabaseKey`). */
  window.__bizdashSupabaseUrl = SUPABASE_URL;
  window.__bizdashSupabaseAnonKey = SUPABASE_ANON_KEY;

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Ceilings for org / onboarding resolution (not session read — that is driven by INITIAL_SESSION).
   * These are UX timeouts only; the auth session itself has no artificial cap.
   */
  var ORG_RESOLVE_MS = 8000;
  var ONBOARDING_GATE_MS = 5000;

  function withTimeout(promise, ms, errMsg) {
    return Promise.race([
      promise,
      new Promise(function (_, rej) {
        setTimeout(function () {
          rej(new Error(errMsg));
        }, ms);
      }),
    ]);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function isLockStolenError(err) {
    var msg = '';
    if (err && err.message) msg = String(err.message);
    if (!msg && err) msg = String(err);
    msg = msg.toLowerCase();
    return msg.indexOf('lock was stolen by another request') !== -1 || msg.indexOf('aborterror') !== -1;
  }

  async function retryOnAuthLock(task) {
    var maxAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await task();
      } catch (err) {
        if (!isLockStolenError(err) || attempt === maxAttempts) throw err;
        // Tiny jitter gives the competing request time to release the lock.
        await sleep(120 * attempt);
      }
    }
    return await task();
  }

  async function getSessionNow() {
    return retryOnAuthLock(function () {
      return supabase.auth.getSession();
    });
  }

  function clearOrgContext() {
    window.currentOrganizationId = null;
    window.currentOrganizationSlug = null;
    window.currentOrganizationRole = null;
  }

  function captureInviteFromUrlToStorage() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var tok = (params.get('invite') || '').trim();
      if (tok) sessionStorage.setItem(PENDING_INVITE_KEY, tok);
    } catch (_) {}
  }

  function updateGateInviteHint() {
    var hint = $('gate-invite-hint');
    if (!hint) return;
    try {
      if (sessionStorage.getItem(PENDING_INVITE_KEY)) {
        hint.style.display = 'block';
        hint.textContent =
          'You have a pending team invitation. Sign in with the same email the invitation was sent to, then we will attach you to the workspace.';
      } else {
        hint.style.display = 'none';
        hint.textContent = '';
      }
    } catch (_) {
      hint.style.display = 'none';
    }
  }

  function clearPendingInviteStorage() {
    try {
      sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch (_) {}
  }

  function stripInviteFromBrowserUrl() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (!params.get('invite')) return;
      params.delete('invite');
      var qs = params.toString();
      window.history.replaceState(null, '', (window.location.pathname || '/') + (qs ? '?' + qs : '') + (window.location.hash || ''));
    } catch (_) {}
  }

  function flashInviteMessage(msg) {
    if (!msg) return;
    try {
      sessionStorage.setItem(FLASH_INVITE_KEY, String(msg));
    } catch (_) {}
  }

  function drainInviteFlashIntoApp() {
    var bar = $('app-invite-flash');
    if (!bar) return;
    var msg = '';
    try {
      msg = sessionStorage.getItem(FLASH_INVITE_KEY) || '';
      if (msg) sessionStorage.removeItem(FLASH_INVITE_KEY);
    } catch (_) {}
    if (!msg) {
      bar.style.display = 'none';
      bar.textContent = '';
      return;
    }
    bar.textContent = msg;
    bar.style.display = 'block';
    window.setTimeout(function () {
      bar.style.display = 'none';
      bar.textContent = '';
    }, 12000);
  }

  /** First path segment is workspace slug (e.g. /acme/dashboard → acme). */
  function parseTenantSlug() {
    var raw = (window.location.pathname || '/').replace(/\/+/g, '/');
    if (raw !== '/' && raw.endsWith('/')) raw = raw.slice(0, -1);
    var parts = raw.split('/').filter(Boolean);
    if (!parts.length) return null;
    var seg = parts[0];
    if (seg === 'index.html' || seg === 'dist') return null;
    if (/\.[a-z0-9]{1,8}$/i.test(seg)) return null;
    var head = (seg || '').toLowerCase().split('.')[0];
    var block = { login: 1, assets: 1, api: 1, favicon: 1, health: 1 };
    if (block[head]) return null;
    return String(seg).toLowerCase();
  }

  function setOrgContext(orgId, slug, role) {
    window.currentOrganizationId = orgId || null;
    window.currentOrganizationSlug = slug || null;
    window.currentOrganizationRole = role || null;
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugClientValid(sl) {
    return /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(sl || '').trim().toLowerCase());
  }

  /**
   * Slug is taken if any org uses it, except the org given by currentOrgId (same slug = allowed for that org).
   * Uses organization_public_by_slug (SECURITY DEFINER); aligns with DB unique on organizations.slug.
   */
  async function workspaceSlugTakenByAnotherOrg(sl, currentOrgId) {
    var r = await retryOnAuthLock(function () {
      return supabase.rpc('organization_public_by_slug', { sl: sl });
    });
    if (r.error) return { taken: false, rpcError: r.error };
    if (!r.data || !r.data.length) return { taken: false };
    var row = r.data[0];
    if (currentOrgId && String(row.id) === String(currentOrgId)) return { taken: false };
    return { taken: true };
  }

  function replaceBrowserPathForSlug(newSlug) {
    var search = window.location.search || '';
    window.history.replaceState(null, '', '/' + String(newSlug).toLowerCase() + '/' + search);
  }

  /**
   * Consume ?invite= or pending sessionStorage token; on soft failure keep session and continue.
   * @returns {Promise<boolean>} false only when session token missing (should not happen post sign-in)
   */
  async function tryConsumeOrgInvite(user, gateErr, authSession) {
    var params = new URLSearchParams(window.location.search || '');
    var tok = (params.get('invite') || '').trim();
    if (!tok) {
      try {
        tok = (sessionStorage.getItem(PENDING_INVITE_KEY) || '').trim();
      } catch (_) {}
    }
    if (!tok) return true;

    try {
      var sess = authSession && authSession.access_token ? authSession : null;
      if (!sess) {
        var sessRes = await getSessionNow();
        sess = sessRes && sessRes.data ? sessRes.data.session : null;
      }
      if (!sess || !sess.access_token) {
        if (gateErr) gateErr('Sign in to accept this invitation.');
        return false;
      }
      var url = SUPABASE_URL + '/functions/v1/accept-org-invite';
      var res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + sess.access_token,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ token: tok }),
      });
      var j = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j.ok) {
        clearPendingInviteStorage();
        stripInviteFromBrowserUrl();
        flashInviteMessage(j.error ? String(j.error) : 'Could not accept invitation.');
        if (gateErr) gateErr('');
        return true;
      }
      clearPendingInviteStorage();
      params.delete('invite');
      var qs = params.toString();
      var newSearch = qs ? '?' + qs : '';
      var sl = j.slug ? String(j.slug) : '';
      if (sl) {
        window.history.replaceState(null, '', '/' + sl + '/' + newSearch);
      } else {
        window.history.replaceState(null, '', (window.location.pathname || '/') + newSearch);
      }
      return true;
    } catch (err) {
      clearPendingInviteStorage();
      stripInviteFromBrowserUrl();
      flashInviteMessage('Could not accept invitation.');
      if (gateErr) gateErr('');
      return true;
    }
  }

  /** When RPC returns onboarding_completed, avoid a second round-trip. */
  function onboardingModalNeededFromRow(row) {
    if (!row || typeof row.onboarding_completed !== 'boolean') return null;
    return row.onboarding_completed === false;
  }

  /**
   * Resolve URL slug to org + membership, or redirect signed-in user to their first org.
   * @returns {Promise<{ ok: boolean, needsOnboarding?: boolean }>}
   */
  async function ensureOrganizationContext(user, authSession) {
    var errEl = $('gate-auth-error');
    function gateErr(msg) {
      if (errEl) errEl.textContent = msg || '';
    }
    gateErr('');
    if (!user || !user.id) {
      clearOrgContext();
      return { ok: false };
    }

    if (!(await tryConsumeOrgInvite(user, gateErr, authSession))) {
      return { ok: false };
    }

    var slug = parseTenantSlug();
    if (slug) {
      var pubRes = await retryOnAuthLock(function () {
        return supabase.rpc('organization_public_by_slug', { sl: slug });
      });
      if (pubRes.error) {
        console.error('organization_public_by_slug failed', pubRes.error);
        gateErr('Could not load workspace URL. ' + String(pubRes.error.message || pubRes.error));
        clearOrgContext();
        return { ok: false };
      }
      if (!pubRes.data || !pubRes.data.length) {
        gateErr('Unknown workspace URL.');
        clearOrgContext();
        return { ok: false };
      }
      var org = pubRes.data[0];
      var memRes = await retryOnAuthLock(function () {
        return supabase
          .from('organization_members')
          .select('role')
          .eq('organization_id', org.id)
          .eq('user_id', user.id)
          .maybeSingle();
      });
      if (memRes.error) {
        console.error('organization_members membership check failed', memRes.error);
        gateErr('Could not verify workspace membership. ' + String(memRes.error.message || memRes.error));
        clearOrgContext();
        return { ok: false };
      }
      if (!memRes.data) {
        gateErr('You do not have access to this workspace.');
        clearOrgContext();
        return { ok: false };
      }
      setOrgContext(org.id, org.slug || slug, memRes.data.role);
      var slugFlag = onboardingModalNeededFromRow(org);
      var needsOnSlug = slugFlag !== null ? slugFlag : await fetchOrgNeedsOnboarding(org.id);
      return { ok: true, needsOnboarding: needsOnSlug };
    }

    var listRes = await retryOnAuthLock(function () {
      return supabase.rpc('my_organizations');
    });
    if (listRes.error) {
      console.error('my_organizations failed', listRes.error);
      gateErr('Could not load your workspaces. ' + String(listRes.error.message || listRes.error));
      clearOrgContext();
      return { ok: false };
    }
    if (!listRes.data || !listRes.data.length) {
      gateErr('No workspace found for your account. Contact support.');
      clearOrgContext();
      return { ok: false };
    }
    var first = listRes.data[0];
    var targetPath = '/' + first.slug + '/';
    var cur = window.location.pathname || '/';
    if (cur !== targetPath && cur.replace(/\/$/, '') !== '/' + first.slug) {
      window.history.replaceState(null, '', targetPath + (window.location.search || ''));
    }
    setOrgContext(first.id, first.slug, first.role);
    var listFlag = onboardingModalNeededFromRow(first);
    var needsOnList = listFlag !== null ? listFlag : await fetchOrgNeedsOnboarding(first.id);
    return { ok: true, needsOnboarding: needsOnList };
  }

  async function fetchOrgNeedsOnboarding(orgId) {
    if (!orgId) return false;
    try {
      var r = await retryOnAuthLock(function () {
        return supabase.from('organizations').select('onboarding_completed').eq('id', orgId).maybeSingle();
      });
      if (r.error) return false;
      if (!r.data) return false;
      return r.data.onboarding_completed === false;
    } catch (_) {
      return false;
    }
  }

  async function resolveOrgContextWithRetry(user, authSession) {
    try {
      return await withTimeout(
        ensureOrganizationContext(user, authSession),
        ORG_RESOLVE_MS,
        'Loading workspace timed out. Check your connection and try again.'
      );
    } catch (err) {
      // One immediate second chance for lock contention only (no extra wait).
      if (isLockStolenError(err)) {
        return await withTimeout(
          ensureOrganizationContext(user, authSession),
          ORG_RESOLVE_MS,
          'Loading workspace timed out. Check your connection and try again.'
        );
      }
      throw err;
    }
  }

  function showOnboardModal() {
    var m = $('onboardModal');
    if (m) m.classList.add('on');
  }

  function hideOnboardModal() {
    var m = $('onboardModal');
    if (m) m.classList.remove('on');
  }

  function prefillOnboardFormFromOrg() {
    var nameEl = $('ob-name');
    var slugEl = $('ob-slug');
    var orgId = window.currentOrganizationId;
    if (!orgId) return;
    supabase
      .from('organizations')
      .select('name,slug')
      .eq('id', orgId)
      .maybeSingle()
      .then(function (r) {
        if (!r.data) return;
        if (nameEl) nameEl.value = r.data.name || '';
        if (slugEl) slugEl.value = r.data.slug || '';
      });
  }

  async function maybeWorkspaceOnboardingThenShowApp(user, needsOnboardingKnown) {
    var needs;
    if (typeof needsOnboardingKnown === 'boolean') {
      needs = needsOnboardingKnown;
    } else {
      needs = await fetchOrgNeedsOnboarding(window.currentOrganizationId);
    }
    if (!needs) {
      showApp(user);
      return;
    }
    var loading = $('auth-loading');
    if (loading) loading.style.display = 'none';
    var shell = $('auth-login-shell');
    if (shell) shell.style.display = 'none';
    prefillOnboardFormFromOrg();
    var err = $('onboard-error');
    if (err) err.textContent = '';
    showOnboardModal();
  }

  function wireOnboardSubmit(user) {
    var btn = $('onboard-submit-btn');
    if (!btn || btn.getAttribute('data-wired') === '1') return;
    btn.setAttribute('data-wired', '1');
    btn.addEventListener('click', async function () {
      var err = $('onboard-error');
      if (err) err.textContent = '';
      var name = ($('ob-name') && $('ob-name').value.trim()) || '';
      var slug = ($('ob-slug') && $('ob-slug').value.trim().toLowerCase()) || '';
      var owner = ($('ob-owner') && $('ob-owner').value.trim()) || '';
      var role = ($('ob-role') && $('ob-role').value.trim()) || '';
      var tagline = ($('ob-tagline') && $('ob-tagline').value.trim()) || '';
      var accentEl = $('ob-accent');
      var accent = accentEl && accentEl.value ? accentEl.value : '#e8501a';
      if (!name) {
        if (err) err.textContent = 'Company name is required.';
        return;
      }
      if (!slugClientValid(slug)) {
        if (err)
          err.textContent =
            'URL slug: 2–63 characters, lowercase letters, numbers, or hyphens; must start with a letter or number.';
        return;
      }
      var orgId = window.currentOrganizationId;
      if (!orgId) {
        if (err) err.textContent = 'No workspace context.';
        return;
      }
      var takenOb = await workspaceSlugTakenByAnotherOrg(slug, orgId);
      if (takenOb.rpcError) {
        if (err) err.textContent = 'Could not verify that URL. Try again.';
        return;
      }
      if (takenOb.taken) {
        if (err) err.textContent = 'That workspace URL is already taken. Choose a different slug.';
        return;
      }
      var prevSlug = window.currentOrganizationSlug;
      try {
        var rpcRes = await supabase.rpc('update_workspace_profile', {
          p_org_id: orgId,
          p_name: name,
          p_slug: slug,
        });
        var payload = rpcRes.data;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (_) {}
        }
        if (rpcRes.error || !payload || typeof payload !== 'object') {
          if (err) err.textContent = rpcRes.error ? String(rpcRes.error.message || rpcRes.error) : 'Could not save workspace.';
          return;
        }
        if (!payload.ok) {
          if (err) err.textContent = payload.error ? String(payload.error) : 'Could not save workspace.';
          return;
        }
        var newSlug = payload.slug ? String(payload.slug) : slug;
        setOrgContext(orgId, newSlug, window.currentOrganizationRole);
        if (prevSlug && newSlug && String(prevSlug).toLowerCase() !== String(newSlug).toLowerCase()) {
          replaceBrowserPathForSlug(newSlug);
        }
        if (typeof window.bizdashApplyWorkspaceBrandingFromOnboarding === 'function') {
          await window.bizdashApplyWorkspaceBrandingFromOnboarding({
            businessName: name,
            owner: owner,
            ownerRole: role,
            tagline: tagline,
            accent: accent,
          });
        }
        hideOnboardModal();
        showApp(user);
      } catch (e) {
        if (err) err.textContent = 'Could not save workspace. If this persists, confirm the database migration ran.';
      }
    });
  }

  function renderWorkspaceList(rows) {
    var list = $('workspace-list');
    if (!list) return;
    if (!rows || !rows.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text2);">No workspaces found.</div>';
      return;
    }
    var cur = (window.currentOrganizationSlug || '').toLowerCase();
    list.innerHTML = rows
      .map(function (r) {
        var sl = String(r.slug || '');
        var nm = String(r.name || sl);
        var ro = String(r.role || 'member');
        var isHere = sl.toLowerCase() === cur;
        return (
          '<div class="workspace-row" data-slug="' +
          escHtml(sl) +
          '" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;background:' +
          (isHere ? 'var(--bg3)' : 'var(--bg2)') +
          ';">' +
          '<div><div style="font-weight:600;font-size:14px;">' +
          escHtml(nm) +
          '</div><div style="font-size:12px;color:var(--text3);">/' +
          escHtml(sl) +
          ' · ' +
          escHtml(ro) +
          '</div></div>' +
          (isHere ? '<span style="font-size:12px;color:var(--text3);">Current</span>' : '<span style="font-size:12px;color:var(--coral);">Open</span>') +
          '</div>'
        );
      })
      .join('');
    list.querySelectorAll('.workspace-row').forEach(function (el) {
      el.addEventListener('click', function () {
        var sl = el.getAttribute('data-slug');
        if (!sl) return;
        window.location.assign('/' + sl + '/' + (window.location.search || ''));
      });
    });
  }

  async function refreshWorkspaceModalList() {
    var sessRes;
    try {
      sessRes = await getSessionNow();
    } catch (_) {
      renderWorkspaceList([]);
      return;
    }
    var u = sessRes && sessRes.data && sessRes.data.session && sessRes.data.session.user;
    if (!u) return;
    var listRes = await retryOnAuthLock(function () {
      return supabase.rpc('my_organizations');
    });
    if (listRes.error || !listRes.data) {
      renderWorkspaceList([]);
      return;
    }
    renderWorkspaceList(listRes.data);
  }

  function wireWorkspaceModal() {
    var closeBtn = $('btn-workspace-modal-close');
    if (closeBtn && closeBtn.getAttribute('data-wired') !== '1') {
      closeBtn.setAttribute('data-wired', '1');
      closeBtn.addEventListener('click', function () {
        var m = $('workspaceModal');
        if (m) m.classList.remove('on');
      });
    }
    var addBtn = $('btn-workspace-add-another');
    var panel = $('workspace-add-panel');
    var createBtn = $('btn-workspace-create-submit');
    var cancelBtn = $('btn-workspace-add-cancel');
    if (addBtn && addBtn.getAttribute('data-wired') !== '1') {
      addBtn.setAttribute('data-wired', '1');
      addBtn.addEventListener('click', function () {
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    }
    if (cancelBtn && cancelBtn.getAttribute('data-wired') !== '1') {
      cancelBtn.setAttribute('data-wired', '1');
      cancelBtn.addEventListener('click', function () {
        if (panel) panel.style.display = 'none';
      });
    }
    if (createBtn && createBtn.getAttribute('data-wired') !== '1') {
      createBtn.setAttribute('data-wired', '1');
      createBtn.addEventListener('click', async function () {
        var err = $('workspace-add-error');
        if (err) err.textContent = '';
        var nm = ($('ws-new-name') && $('ws-new-name').value.trim()) || '';
        var sl = ($('ws-new-slug') && $('ws-new-slug').value.trim().toLowerCase()) || '';
        if (!nm) {
          if (err) err.textContent = 'Workspace name is required.';
          return;
        }
        if (!slugClientValid(sl)) {
          if (err)
            err.textContent =
              'URL slug: 2–63 characters, lowercase letters, numbers, or hyphens; must start with a letter or number.';
          return;
        }
        var takenWs = await workspaceSlugTakenByAnotherOrg(sl, null);
        if (takenWs.rpcError) {
          if (err) err.textContent = 'Could not verify that URL. Try again.';
          return;
        }
        if (takenWs.taken) {
          if (err) err.textContent = 'That workspace URL is already taken. Choose a different slug.';
          return;
        }
        var rpcRes = await supabase.rpc('create_workspace_for_user', { p_name: nm, p_slug: sl });
        var payload = rpcRes.data;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (_) {}
        }
        if (rpcRes.error || !payload || typeof payload !== 'object' || !payload.ok) {
          if (err) err.textContent = payload && payload.error ? String(payload.error) : 'Could not create workspace.';
          return;
        }
        var newSlug = payload.slug ? String(payload.slug) : sl;
        window.location.assign('/' + newSlug + '/' + (window.location.search || ''));
      });
    }
  }

  window.openWorkspaceSwitcherModal = async function () {
    var m = $('workspaceModal');
    var panel = $('workspace-add-panel');
    if (panel) panel.style.display = 'none';
    var err = $('workspace-add-error');
    if (err) err.textContent = '';
    wireWorkspaceModal();
    await refreshWorkspaceModalList();
    if (m) m.classList.add('on');
  };

  function setCurrentUser(user) {
    var prevUser = window.currentUser || null;
    var nextUser = user || null;
    window.currentUser = nextUser;
    var prevId = prevUser && prevUser.id ? prevUser.id : null;
    var nextId = nextUser && nextUser.id ? nextUser.id : null;
    if (prevId !== nextId && typeof window.clearRuntimeDataForAuthChange === 'function') {
      window.clearRuntimeDataForAuthChange(nextUser);
    }
  }

  function showLoading() {
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'flex';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.remove('on');
  }

  function showLogin() {
    clearStableAppUserMarker();
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'flex';
    if (app) app.classList.remove('on');
    updateGateInviteHint();
  }

  window.__dashboardShowLogin = showLogin;

  var authRecoveryMode = false;
  function setAuthRecoveryMode(on) {
    authRecoveryMode = !!on;
    var heading = document.querySelector('#auth-login-shell .pt');
    var subtitle = document.querySelector('#auth-login-shell p');
    var signin = $('gate-signin');
    var signup = $('gate-signup');
    var github = $('gate-github');
    var forgot = $('gate-forgot-password');
    var confirmWrap = $('gate-confirm-wrap');
    var errorBox = $('gate-auth-error');
    if (heading) heading.textContent = authRecoveryMode ? 'Reset password' : 'Sign in';
    if (subtitle) {
      subtitle.textContent = authRecoveryMode
        ? 'Set a new password for your account.'
        : 'Sign in to use the dashboard.';
    }
    if (signin) signin.textContent = authRecoveryMode ? 'Update password' : 'Sign in';
    if (signup) signup.style.display = authRecoveryMode ? 'none' : '';
    if (github) github.style.display = authRecoveryMode ? 'none' : '';
    if (forgot) forgot.style.display = authRecoveryMode ? 'none' : '';
    if (confirmWrap) confirmWrap.style.display = authRecoveryMode ? '' : 'none';
    if (errorBox && authRecoveryMode && !errorBox.textContent) {
      errorBox.textContent = 'Enter and confirm your new password.';
    }
  }

  /**
   * GoTrue often emits SIGNED_IN again on tab focus (visibility) even when nothing changed.
   * `window.currentUser` can be missing or stale vs `session.user`, so we also remember the
   * last user id we successfully showed in #app-shell and skip the loading gate when it matches.
   */
  var lastStableAppUserId = null;

  function clearStableAppUserMarker() {
    lastStableAppUserId = null;
  }

  function markStableAppUser(user) {
    if (user && user.id != null && String(user.id) !== '') {
      lastStableAppUserId = String(user.id);
    } else {
      lastStableAppUserId = null;
    }
  }

  function shouldSkipSessionReflow(session) {
    if (!session || !session.user || session.user.id == null) return false;
    var sid = String(session.user.id);
    var app = $('app-shell');
    if (!app || !app.classList.contains('on')) return false;
    if (lastStableAppUserId && lastStableAppUserId === sid) return true;
    var cu = window.currentUser && window.currentUser.id != null ? String(window.currentUser.id) : '';
    return !!cu && cu === sid;
  }

  function shouldSkipSessionReflowForUser(user) {
    if (!user || user.id == null) return false;
    return shouldSkipSessionReflow({ user: user });
  }

  function isAppVisible() {
    var app = $('app-shell');
    return !!(app && app.classList && app.classList.contains('on'));
  }

  /** In-flight session resolution so bootstrap + INITIAL_SESSION do not run two flows in parallel. */
  var sessionFlowPromise = null;

  /**
   * Resolve org context, optional onboarding modal, then show the app (or login on failure).
   * Used from bootstrap and from auth events (including INITIAL_SESSION; deduped with bootstrap).
   */
  async function runAuthSessionFlow(user, authSession) {
    if (!user || !user.id) {
      clearOrgContext();
      setCurrentUser(null);
      showLogin();
      return;
    }
    if (shouldSkipSessionReflowForUser(user)) {
      setCurrentUser(user);
      return;
    }
    if (sessionFlowPromise) {
      return sessionFlowPromise;
    }
    sessionFlowPromise = (async function () {
      showLoading();
      try {
        setCurrentUser(user);
        var ctx = await resolveOrgContextWithRetry(user, authSession);
        if (!ctx || !ctx.ok) {
          if (isAppVisible()) {
            setCurrentUser(user);
            return;
          }
          setCurrentUser(null);
          showLogin();
          return;
        }
        wireOnboardSubmit(user);
        await withTimeout(
          maybeWorkspaceOnboardingThenShowApp(user, ctx.needsOnboarding),
          ONBOARDING_GATE_MS,
          'Could not finish workspace setup. Try signing in again.'
        );
      } catch (err) {
        console.error('runAuthSessionFlow', err);
        if (isAppVisible()) {
          setCurrentUser(user);
          return;
        }
        setCurrentUser(null);
        clearOrgContext();
        var ge = $('gate-auth-error');
        if (ge && err && err.message) ge.textContent = String(err.message);
        showLogin();
      } finally {
        sessionFlowPromise = null;
      }
    })();
    return sessionFlowPromise;
  }

  function showDemoDashboard() {
    clearOrgContext();
    var demoId = window.DEMO_DASHBOARD_USER_ID || '00000000-0000-4000-8000-000000000001';
    var demoUser = { id: demoId, email: 'demo@preview.local', app_metadata: {}, user_metadata: {} };
    setCurrentUser(demoUser);
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.add('on');
    markStableAppUser(demoUser);
    var nameEl = $('user-name');
    var roleEl = $('user-role');
    var avatarEl = $('user-avatar');
    if (nameEl) nameEl.textContent = 'Demo';
    if (roleEl) roleEl.textContent = 'Preview';
    if (avatarEl) avatarEl.textContent = 'D';
    if (typeof window.loadScreenshotMockData === 'function') {
      window.loadScreenshotMockData();
    } else {
      console.error('financial-core: loadScreenshotMockData not available (script order?)');
    }
  }

  function showApp(user) {
    hideOnboardModal();
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.add('on');
    markStableAppUser(user);

    if (user) {
      var nameEl = document.getElementById('user-name');
      var roleEl = document.getElementById('user-role');
      var avatarEl = document.getElementById('user-avatar');
      if (nameEl) nameEl.textContent = user.email || 'Signed in';
      if (roleEl) {
        var rr = window.currentOrganizationRole;
        roleEl.textContent = rr ? String(rr).charAt(0).toUpperCase() + String(rr).slice(1) : 'Member';
      }
      if (avatarEl && user.email) {
        avatarEl.textContent = user.email.charAt(0).toUpperCase();
      }
    }

    drainInviteFlashIntoApp();

    if (window.initDataFromSupabase) {
      window.initDataFromSupabase();
    }
  }

  /**
   * Supabase v2 fires INITIAL_SESSION on the next tick when a session exists in storage.
   * That is the canonical startup hook — no separate bootstrapSession() needed.
   * We show the loading screen now so there is no flash of the login form.
   */
  showLoading();

  supabase.auth.onAuthStateChange(async function (event, session) {
    if (event === 'SIGNED_OUT') {
      setAuthRecoveryMode(false);
      clearOrgContext();
      setCurrentUser(null);
      showLogin();
      return;
    }

    if (event === 'PASSWORD_RECOVERY') {
      showLogin();
      setAuthRecoveryMode(true);
      return;
    }

    if (event === 'INITIAL_SESSION') {
      if (!session || !session.user) {
        setAuthRecoveryMode(false);
        showLogin();
        return;
      }
      if (shouldSkipSessionReflow(session)) {
        setCurrentUser(session.user);
        return;
      }
      try {
        if (typeof window.setBizdashScreenshotNoCloud === 'function') {
          window.setBizdashScreenshotNoCloud(false);
        }
      } catch (_) {}
      await runAuthSessionFlow(session.user, session);
      return;
    }

    if (!session || !session.user) {
      setAuthRecoveryMode(false);
      clearOrgContext();
      setCurrentUser(null);
      showLogin();
      return;
    }

    try {
      if (typeof window.setBizdashScreenshotNoCloud === 'function') {
        window.setBizdashScreenshotNoCloud(false);
      }
    } catch (_) {}

    if (event === 'TOKEN_REFRESHED') {
      setCurrentUser(session.user);
      showApp(session.user);
      return;
    }

    /* Tab focus: GoTrue may emit SIGNED_IN / INITIAL_SESSION again without a real auth change. */
    if (shouldSkipSessionReflow(session)) {
      setCurrentUser(session.user);
      return;
    }

    await runAuthSessionFlow(session.user, session);
  });

  function wireAuthForm() {
    captureInviteFromUrlToStorage();
    updateGateInviteHint();

    var emailInput = $('gate-email');
    var passwordInput = $('gate-password');
    var confirmWrap = $('gate-confirm-wrap');
    var confirmInput = $('gate-confirm-password');
    var errorBox = $('gate-auth-error');
    var signupMode = false;

    function setError(msg) {
      if (errorBox) errorBox.textContent = msg || '';
    }

    function setSignupMode(on) {
      signupMode = !!on;
      if (confirmWrap) confirmWrap.style.display = signupMode || authRecoveryMode ? '' : 'none';
      if (!signupMode && confirmInput) confirmInput.value = '';
    }

    var btnSignin = $('gate-signin');
    var btnSignup = $('gate-signup');
    var btnGithub = $('gate-github');
    var btnForgot = $('gate-forgot-password');

    if (btnSignin) {
      btnSignin.addEventListener('click', async function () {
        if (!authRecoveryMode) setSignupMode(false);
        var email = emailInput && emailInput.value.trim();
        var password = passwordInput && passwordInput.value;
        setError('');
        if (authRecoveryMode) {
          var confirmPasswordRecovery = confirmInput && confirmInput.value;
          if (!password) {
            setError('New password is required.');
            return;
          }
          if (!confirmPasswordRecovery) {
            setError('Please confirm your new password.');
            return;
          }
          if (password !== confirmPasswordRecovery) {
            setError('Passwords do not match.');
            return;
          }
          try {
            var upd = await supabase.auth.updateUser({ password: password });
            if (upd.error) {
              setError(upd.error.message || 'Could not update password.');
              return;
            }
            setAuthRecoveryMode(false);
            if (confirmInput) confirmInput.value = '';
            if (passwordInput) passwordInput.value = '';
            setError('Password updated. You can sign in with your new password.');
            try {
              await supabase.auth.signOut();
            } catch (_) {}
            showLogin();
          } catch (errRecovery) {
            console.error('password update error', errRecovery);
            setError('Unexpected error updating password.');
          }
          return;
        }
        if (!email || !password) {
          setError('Email and password are required.');
          return;
        }
        try {
          var res = await supabase.auth.signInWithPassword({ email: email, password: password });
          if (res.error) {
            setError(res.error.message || 'Could not sign in.');
            return;
          }
          try {
            if (typeof window.setBizdashScreenshotNoCloud === 'function') {
              window.setBizdashScreenshotNoCloud(false);
            }
          } catch (_) {}
          setCurrentUser(res.data.user);
        } catch (err) {
          console.error('signIn error', err);
          setError('Unexpected error signing in.');
        }
      });
    }

    if (btnSignup) {
      btnSignup.addEventListener('click', async function () {
        if (!signupMode) {
          setSignupMode(true);
          setError('Confirm your password to create an account.');
          if (confirmInput) confirmInput.focus();
          return;
        }
        var email = emailInput && emailInput.value.trim();
        var password = passwordInput && passwordInput.value;
        var confirmPassword = confirmInput && confirmInput.value;
        if (!email || !password) {
          setError('Email and password are required.');
          return;
        }
        if (!confirmPassword) {
          setError('Please confirm your password.');
          return;
        }
        if (password !== confirmPassword) {
          setError('Passwords do not match.');
          return;
        }
        setError('');
        try {
          var res = await supabase.auth.signUp({ email: email, password: password });
          if (res.error) {
            setError(res.error.message || 'Could not sign up.');
            return;
          }
          setError('Check your email to confirm your account, then sign in.');
          setSignupMode(false);
        } catch (err) {
          console.error('signUp error', err);
          setError('Unexpected error signing up.');
        }
      });
    }

    if (btnForgot) {
      btnForgot.addEventListener('click', async function () {
        setSignupMode(false);
        var email = emailInput && emailInput.value ? emailInput.value.trim() : '';
        if (!email) {
          setError('Enter your email, then click Forgot password again.');
          return;
        }
        setError('');
        try {
          var redirectTo = window.location.origin + (window.location.pathname || '/');
          var reset = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
          if (reset.error) {
            setError(reset.error.message || 'Could not send reset email.');
            return;
          }
          setError('Password reset email sent. Open the link in your email to set a new password.');
        } catch (errForgot) {
          console.error('reset password error', errForgot);
          setError('Unexpected error sending reset email.');
        }
      });
    }

    var btnViewDemo = $('gate-view-demo');
    if (btnViewDemo) {
      btnViewDemo.addEventListener('click', function () {
        showDemoDashboard();
      });
    }

    if (btnGithub) {
      btnGithub.addEventListener('click', async function () {
        try {
          var path = window.location.pathname || '/';
          var search = window.location.search || '';
          var redirectTo = window.location.origin + path + search;
          var res = await supabase.auth.signInWithOAuth({
            provider: 'github',
            options: {
              redirectTo: redirectTo,
            },
          });
          if (res.error) {
            setError(res.error.message || 'GitHub sign-in failed.');
          }
        } catch (err) {
          console.error('GitHub auth error', err);
          setError('Unexpected error starting GitHub sign-in.');
        }
      });
    }

    var btnWs = $('btn-open-workspaces');
    if (btnWs) {
      btnWs.addEventListener('click', function () {
        if (typeof window.openWorkspaceSwitcherModal === 'function') {
          window.openWorkspaceSwitcherModal();
        }
      });
    }
    wireWorkspaceModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      captureInviteFromUrlToStorage();
      updateGateInviteHint();
      wireAuthForm();
    });
  } else {
    captureInviteFromUrlToStorage();
    updateGateInviteHint();
    wireAuthForm();
  }
})();
