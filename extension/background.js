// MCP Cookie Bridge — Background Service Worker
//
// PROFILE-based: tracks many independent host+cookie combos (different apps
// and/or environments) at once. Every non-blocked profile is harvested and
// pushed to the local MCP bridge as a { profiles: { key: payload } } map. Also
// polls the bridge's prime queue so an agent can request a re-login per profile.
// Config-driven — no hardcoded cookie names or URLs.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let rawConfig = null; // config as stored/bundled (authoring shape)
let cfg = null; // normalized: { profiles, defaultProfile, allowProduction, bridgePort, bridgeToken, refreshIntervalMinutes }

/** True if `host` equals or is a subdomain of one of the allowed suffixes. */
function hostAllowed(host, allowed) {
  if (!allowed || !allowed.length) return true;
  return allowed.some((s) => host === s || host.endsWith('.' + s));
}

// ---------------------------------------------------------------------------
// Config normalisation (mirror of the server) — supports profiles / legacy
// environments / legacy flat shapes.
// ---------------------------------------------------------------------------

function normalizeConfig(raw) {
  if (!raw) return null;
  const allowProduction = raw.allowProduction === true;

  let rawProfiles = {};
  let defaultProfile = raw.defaultProfile || null;

  if (raw.profiles && Object.keys(raw.profiles).length) {
    rawProfiles = raw.profiles;
  } else if (raw.environments && Object.keys(raw.environments).length) {
    for (const [name, env] of Object.entries(raw.environments)) {
      rawProfiles[name] = {
        cookieUrl: env.cookieUrl,
        loginUrl: env.loginUrl,
        logoutUrl: env.logoutUrl,
        allowedHosts: env.allowedHosts,
        cookies: raw.cookies || [],
        requiredCookies: raw.requiredCookies,
        bootstrapCookies: raw.bootstrapCookies,
        primeClearCookies: raw.primeClearCookies,
        targetDomain: raw.targetDomain,
        targetPort: raw.targetPort,
        production: name.toLowerCase() === 'production',
      };
    }
    if (!defaultProfile) defaultProfile = raw.activeEnv || 'staging';
  } else if (raw.cookieUrl) {
    rawProfiles.default = {
      cookieUrl: raw.cookieUrl,
      loginUrl: raw.loginUrl,
      logoutUrl: raw.logoutUrl,
      allowedHosts: raw.allowedHosts,
      cookies: raw.cookies || [],
      requiredCookies: raw.requiredCookies,
      bootstrapCookies: raw.bootstrapCookies,
      primeClearCookies: raw.primeClearCookies,
      targetDomain: raw.targetDomain,
      targetPort: raw.targetPort,
    };
    if (!defaultProfile) defaultProfile = 'default';
  }

  const keys = Object.keys(rawProfiles);
  if (!keys.length) return null;
  if (!defaultProfile && keys.length === 1) defaultProfile = keys[0];

  const profiles = {};
  for (const [key, p] of Object.entries(rawProfiles)) {
    let host = '';
    let invalid = false;
    try {
      host = new URL(p.cookieUrl).hostname;
    } catch {
      invalid = true;
    }
    const production = p.production === true;
    let blocked = false;
    let blockedReason;
    if (invalid) {
      blocked = true;
      blockedReason = 'Invalid cookieUrl';
    } else if (production && !allowProduction) {
      blocked = true;
      blockedReason = 'Production profile gated — enable "Allow production".';
    } else if (!hostAllowed(host, p.allowedHosts)) {
      blocked = true;
      blockedReason = `Host ${host} not in allowedHosts`;
    }
    profiles[key] = {
      key,
      cookieUrl: p.cookieUrl,
      host,
      loginUrl: p.loginUrl,
      logoutUrl: p.logoutUrl,
      cookies: p.cookies || [],
      requiredCookies:
        p.requiredCookies && p.requiredCookies.length ? p.requiredCookies : p.cookies || [],
      bootstrapCookies: p.bootstrapCookies || [],
      primeClearCookies:
        p.primeClearCookies && p.primeClearCookies.length ? p.primeClearCookies : p.cookies || [],
      targetDomain: p.targetDomain || 'localhost',
      targetPort: p.targetPort || 8443,
      allowedHosts: p.allowedHosts,
      production,
      blocked,
      blockedReason,
    };
  }

  return {
    allowProduction,
    defaultProfile,
    profiles,
    bridgePort: raw.bridgePort || 18443,
    bridgeToken: raw.bridgeToken || null,
    refreshIntervalMinutes: raw.refreshIntervalMinutes || 2,
  };
}

async function loadConfig() {
  let raw = null;
  try {
    const { config: stored } = await chrome.storage.local.get('config');
    if (stored && typeof stored === 'object' && (stored.profiles || stored.cookieUrl || stored.environments)) {
      raw = stored;
    }
  } catch {
    // storage unavailable — fall through to bundled file
  }
  if (!raw) {
    try {
      const resp = await fetch(chrome.runtime.getURL('config.json'));
      raw = await resp.json();
    } catch {
      console.error('MCP Cookie Bridge: no saved config and config.json not found. Open options to configure.');
      rawConfig = null;
      cfg = null;
      return null;
    }
  }
  rawConfig = raw;
  cfg = normalizeConfig(raw);
  return cfg;
}

function bridgeBase() {
  return cfg ? `http://127.0.0.1:${cfg.bridgePort}` : null;
}

function activeProfiles() {
  if (!cfg) return [];
  return Object.values(cfg.profiles).filter((p) => !p.blocked);
}

// ---------------------------------------------------------------------------
// Harvest — read every active profile's cookies
// ---------------------------------------------------------------------------

async function readProfile(rp) {
  const all = await chrome.cookies.getAll({ domain: rp.host });
  const results = {};
  let allPresent = true;
  for (const name of rp.cookies) {
    const c = all.find((x) => x.name === name);
    if (c) {
      results[name] = {
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate || null,
      };
    } else {
      results[name] = null;
      allPresent = false;
    }
  }
  const requiredPresent = rp.requiredCookies.every((n) => results[n]);
  return {
    cookies: results,
    allPresent,
    requiredPresent,
    timestamp: new Date().toISOString(),
    cookieUrl: rp.cookieUrl,
    profile: rp.key,
  };
}

async function readAllProfiles() {
  if (!cfg) await loadConfig();
  if (!cfg) return null;
  const profiles = {};
  for (const rp of activeProfiles()) {
    try {
      profiles[rp.key] = await readProfile(rp);
    } catch (err) {
      console.error(`MCP Cookie Bridge: failed to read profile ${rp.key}:`, err);
    }
  }
  return { profiles };
}

async function postToBridge(state) {
  const base = bridgeBase();
  if (!base) return { ok: false, error: 'No config loaded' };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.bridgeToken) headers['X-Cookie-Bridge-Token'] = cfg.bridgeToken;
    const resp = await fetch(`${base}/cookies`, {
      method: 'POST',
      headers,
      body: JSON.stringify(state),
    });
    if (!resp.ok) throw new Error(`Bridge returned ${resp.status}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function refresh() {
  const state = await readAllProfiles();
  if (!state) return null;

  await chrome.storage.local.set({ lastPayloads: state.profiles });
  const bridgeResult = await postToBridge(state);
  await chrome.storage.local.set({ lastBridgeStatus: bridgeResult });

  updateBadge(state.profiles);
  // Opportunistically service any agent-requested primes.
  drainPrimes().catch(() => {});
  return state.profiles;
}

function updateBadge(profiles) {
  const active = activeProfiles();
  if (!active.length) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
  let healthy = 0;
  for (const rp of active) {
    const p = profiles[rp.key];
    if (p && rp.requiredCookies.every((n) => p.cookies[n])) healthy++;
  }
  if (healthy === active.length) {
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } else {
    chrome.action.setBadgeText({ text: `${healthy}/${active.length}` });
    chrome.action.setBadgeBackgroundColor({ color: healthy ? '#f59e0b' : '#ef4444' });
  }
}

// ---------------------------------------------------------------------------
// Prime — force a logout→login so short-lived bootstrap cookies are re-minted,
// per profile. Opens a tab on the profile host if none is open.
// ---------------------------------------------------------------------------

async function clearProfileCookies(rp) {
  let all = [];
  try {
    all = await chrome.cookies.getAll({ domain: rp.host });
  } catch {
    return 0;
  }
  const wanted = new Set(rp.primeClearCookies);
  let removed = 0;
  for (const c of all) {
    if (!wanted.has(c.name)) continue;
    const scheme = c.secure ? 'https' : 'http';
    const cookieHost = c.domain.replace(/^\./, '');
    const url = `${scheme}://${cookieHost}${c.path}`;
    try {
      await chrome.cookies.remove({ url, name: c.name });
      removed++;
    } catch {
      // best effort
    }
  }
  return removed;
}

async function primeSession(profileKey) {
  if (!cfg) await loadConfig();
  const rp = cfg && cfg.profiles[profileKey];
  if (!rp) return { ok: false, error: `Unknown profile ${profileKey}` };
  if (rp.blocked) return { ok: false, error: `Profile ${profileKey} is blocked: ${rp.blockedReason}` };

  const tabs = await chrome.tabs.query({ url: `*://${rp.host}/*` });
  let cleared = 0;
  let destination;
  let action;

  if (rp.logoutUrl) {
    destination = rp.logoutUrl;
    action = `logout via ${destination}`;
  } else {
    cleared = await clearProfileCookies(rp);
    destination = rp.loginUrl || rp.cookieUrl;
    action = `cleared ${cleared} cookie(s), sent tab to ${destination}`;
  }

  if (tabs.length && tabs[0].id != null) {
    await chrome.tabs.update(tabs[0].id, { url: destination, active: true });
    for (const t of tabs.slice(1)) if (t.id != null) chrome.tabs.reload(t.id);
  } else {
    // No open tab for this host — open one so the human can log in.
    await chrome.tabs.create({ url: destination, active: true });
    action += ' (opened a new tab)';
  }

  await refresh();
  console.log(`[prime:${profileKey}]`, action);
  return { ok: true, profile: profileKey, cleared, destination, action, needsLogin: true };
}

// Drain the bridge's prime queue: run a prime for each profile an agent asked for.
let draining = false;
async function drainPrimes() {
  const base = bridgeBase();
  if (!base || draining) return;
  draining = true;
  try {
    const headers = cfg.bridgeToken ? { 'X-Cookie-Bridge-Token': cfg.bridgeToken } : {};
    const resp = await fetch(`${base}/prime`, { headers });
    if (!resp.ok) return;
    const { pending } = await resp.json();
    for (const key of Object.keys(pending || {})) {
      if (!cfg.profiles[key] || cfg.profiles[key].blocked) {
        await clearPrime(key); // unknown/blocked — drop it
        continue;
      }
      await primeSession(key);
      await clearPrime(key);
    }
  } catch {
    // bridge not running — ignore
  } finally {
    draining = false;
  }
}

async function clearPrime(profileKey) {
  const base = bridgeBase();
  if (!base) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.bridgeToken) headers['X-Cookie-Bridge-Token'] = cfg.bridgeToken;
    await fetch(`${base}/prime/clear`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ profile: profileKey }),
    });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

async function setupAlarms() {
  if (!cfg) await loadConfig();
  const interval = (cfg && cfg.refreshIntervalMinutes) || 2;
  chrome.alarms.create('cookie-refresh', { periodInMinutes: interval });
  chrome.alarms.create('prime-poll', { periodInMinutes: 0.5 });
  chrome.alarms.clear('cookie-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cookie-refresh') refresh();
  else if (alarm.name === 'prime-poll') drainPrimes();
});

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

// Re-harvest as soon as any profile-host tab finishes loading.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !cfg || !tab.url) return;
  try {
    const host = new URL(tab.url).hostname;
    if (activeProfiles().some((rp) => rp.host === host || host.endsWith('.' + rp.host))) refresh();
  } catch {
    // ignore non-http(s) URLs
  }
});

// Refresh when a tracked cookie changes on any profile host.
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!cfg) return;
  const name = changeInfo.cookie.name;
  const cookieDomain = changeInfo.cookie.domain.replace(/^\./, '');
  const match = activeProfiles().some(
    (rp) =>
      rp.cookies.includes(name) &&
      (cookieDomain === rp.host || cookieDomain.endsWith('.' + rp.host))
  );
  if (match) refresh();
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'refresh') {
    refresh().then(sendResponse, (err) => sendResponse({ error: String(err && err.message || err) }));
    return true;
  }
  if (msg.type === 'getState') {
    chrome.storage.local.get(['lastPayloads', 'lastBridgeStatus'], (data) => {
      sendResponse({ payloads: data.lastPayloads || {}, bridgeStatus: data.lastBridgeStatus || null });
    });
    return true;
  }
  if (msg.type === 'getConfig') {
    // Normalized config (profiles + status) for the popup.
    (async () => {
      try {
        if (!cfg) await loadConfig();
        sendResponse(cfg);
      } catch (err) {
        sendResponse(null);
      }
    })();
    return true;
  }
  if (msg.type === 'getRawConfig') {
    // Authoring shape for the options page.
    (async () => {
      try {
        if (!rawConfig) await loadConfig();
        sendResponse(rawConfig);
      } catch (err) {
        sendResponse(null);
      }
    })();
    return true;
  }
  if (msg.type === 'prime') {
    primeSession(msg.profile).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: String(err && err.message || err) })
    );
    return true;
  }
  if (msg.type === 'saveConfig') {
    (async () => {
      try {
        await chrome.storage.local.set({ config: msg.config });
        await init();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  await loadConfig();
  if (!cfg) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
  const blocked = Object.values(cfg.profiles).filter((p) => p.blocked);
  if (blocked.length) {
    // Informational, not an error: a gated production profile (or a host-guarded
    // one) being blocked is expected. Use console.info so it doesn't surface in
    // chrome://extensions' Errors panel.
    console.info(
      'MCP Cookie Bridge: blocked profiles — ' +
        blocked.map((p) => `${p.key} (${p.blockedReason})`).join('; ')
    );
  }
  await setupAlarms();
  await refresh();
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
