// MCP Cookie Bridge — Background Service Worker
//
// Reads cookies specified in config.json from a configured URL and pushes
// them to a local MCP bridge server. Config-driven — no hardcoded cookie
// names or URLs.

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** @type {{ cookieUrl: string, bridgePort: number, refreshIntervalMinutes: number, cookies: string[], requiredCookies?: string[], bootstrapCookies?: string[], primeClearCookies?: string[], loginUrl?: string } | null} */
let config = null;

// Cookies that must always be present for the session to be considered healthy.
// Defaults to all configured cookies when not specified.
function requiredCookieNames() {
  if (!config) return [];
  return config.requiredCookies && config.requiredCookies.length
    ? config.requiredCookies
    : config.cookies;
}

// Short-lived "bootstrap" cookies (e.g. a BFF session) that are minted when the
// app loads and expire on their own. Their absence is normal — they are primed
// on demand rather than kept warm. Defaults to none.
function bootstrapCookieNames() {
  return (config && config.bootstrapCookies) || [];
}

// Cookies that "Prime session" deletes to force a fresh login. Defaults to all
// configured cookies; set primeClearCookies to preserve some (e.g. a long-lived
// device id whose removal would trigger a new-device challenge).
function primeClearCookieNames() {
  if (!config) return [];
  return config.primeClearCookies && config.primeClearCookies.length
    ? config.primeClearCookies
    : config.cookies;
}

async function loadConfig() {
  try {
    const resp = await fetch(chrome.runtime.getURL('config.json'));
    config = await resp.json();
  } catch {
    console.error(
      'MCP Cookie Bridge: config.json not found. Copy config.example.json to config.json and configure it.'
    );
    config = null;
  }
  return config;
}

function getBridgeUrl() {
  if (!config) return null;
  return `http://127.0.0.1:${config.bridgePort}/cookies`;
}

// ---------------------------------------------------------------------------
// Core: read cookies from Chrome
// ---------------------------------------------------------------------------

async function readCookies() {
  if (!config) await loadConfig();
  if (!config) return null;

  // Use getAll with domain filter — this finds cookies on ANY path,
  // unlike chrome.cookies.get which requires the URL path to match.
  const domain = new URL(config.cookieUrl).hostname;
  const allCookies = await chrome.cookies.getAll({ domain });

  const results = {};
  let allPresent = true;

  for (const name of config.cookies) {
    const cookie = allCookies.find((c) => c.name === name);
    if (cookie) {
      results[name] = {
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate || null,
      };
    } else {
      results[name] = null;
      allPresent = false;
    }
  }

  // Health is driven by the *required* cookies. Bootstrap cookies (e.g. a BFF
  // session) are allowed to be absent — they are primed on demand.
  const requiredPresent = requiredCookieNames().every((name) => results[name]);

  return {
    cookies: results,
    allPresent,
    requiredPresent,
    timestamp: new Date().toISOString(),
    cookieUrl: config.cookieUrl,
  };
}

// ---------------------------------------------------------------------------
// Push to the bridge HTTP endpoint (companion MCP server)
// ---------------------------------------------------------------------------

async function postToBridge(payload) {
  const url = getBridgeUrl();
  if (!url) return { ok: false, error: 'No config loaded' };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`Bridge returned ${resp.status}`);
    return { ok: true };
  } catch (err) {
    // Bridge not running — that's fine, cookies are still in storage
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Refresh cycle
// ---------------------------------------------------------------------------

async function refresh() {
  const payload = await readCookies();
  if (!payload) return null;

  // Always persist to extension storage (popup reads this)
  await chrome.storage.local.set({ lastPayload: payload });

  // Try to push to the bridge
  const bridgeResult = await postToBridge(payload);
  payload.bridgeStatus = bridgeResult;

  await chrome.storage.local.set({ lastPayload: payload });

  // Update badge
  updateBadge(payload);

  return payload;
}

function updateBadge(payload) {
  if (!config) return;

  // Badge reflects the required cookies (bootstrap cookies are primed on demand
  // and expected to come and go, so they must not turn the badge red).
  const required = requiredCookieNames();
  const presentRequired = required.filter((name) => payload.cookies[name]).length;

  if (payload.requiredPresent) {
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } else {
    chrome.action.setBadgeText({ text: `${presentRequired}/${required.length}` });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
}

// ---------------------------------------------------------------------------
// Alarms — periodic refresh
// ---------------------------------------------------------------------------

async function setupAlarm() {
  if (!config) await loadConfig();
  const interval = config?.refreshIntervalMinutes || 2;

  chrome.alarms.create('cookie-refresh', {
    periodInMinutes: interval,
  });

  // Clear any legacy keep-alive alarm from older versions.
  chrome.alarms.clear('cookie-keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cookie-refresh') {
    refresh();
  }
});

// ---------------------------------------------------------------------------
// Prime — force a fresh login so the full cookie set (incl. the short-lived
// bootstrap/BFF cookie) is re-minted.
//
// A plain reload with the session cookies still set does NOT re-mint the
// bootstrap cookie — it is only issued by going through the login flow. So Prime
// deletes the identified cookies and reloads the source-host tab: the app lands
// unauthenticated and redirects to login. Once you complete login in that tab,
// the cookies are re-set and harvested automatically (via the cookie-change and
// tab-load listeners). Run this right before instantiating a session (e.g. a
// Playwright context) that needs the bootstrap cookie present.
// ---------------------------------------------------------------------------

async function clearConfiguredCookies(host) {
  // Look up the real cookie objects so we can build correct removal URLs, then
  // remove each cookie this config tracks.
  let all = [];
  try {
    all = await chrome.cookies.getAll({ domain: host });
  } catch {
    return 0;
  }
  const wanted = new Set(primeClearCookieNames());
  let removed = 0;
  for (const c of all) {
    if (!wanted.has(c.name)) continue;
    const scheme = c.secure ? 'https' : 'http';
    const cookieHost = c.domain.replace(/^\./, ''); // domain cookies are dot-prefixed
    const url = `${scheme}://${cookieHost}${c.path}`;
    try {
      await chrome.cookies.remove({ url, name: c.name });
      removed++;
    } catch {
      // Best effort — keep going.
    }
  }
  return removed;
}

async function primeSession() {
  if (!config) await loadConfig();
  if (!config || !config.cookieUrl) return { ok: false, error: 'No config loaded' };

  const host = new URL(config.cookieUrl).hostname;
  const tabs = await chrome.tabs.query({ url: `*://${host}/*` });
  if (!tabs.length) {
    return {
      ok: false,
      error: `No ${host} tab is open. Open one, then prime.`,
    };
  }

  // Delete the identified cookies so the tab lands unauthenticated.
  const cleared = await clearConfiguredCookies(host);

  // Force the primary tab to the configured login URL (falls back to cookieUrl).
  // Navigating to an explicit login URL is more reliable than reloading a deep
  // app route, which may not cleanly redirect to login. Login is interactive;
  // the cookie-change / tab-load listeners harvest automatically once you finish.
  const loginUrl = config.loginUrl || config.cookieUrl;
  const primaryTabId = tabs[0].id;
  if (primaryTabId != null) {
    await chrome.tabs.update(primaryTabId, { url: loginUrl, active: true });
  }
  // Drop the authed view on any other source-host tabs too.
  for (const t of tabs) if (t.id != null && t.id !== primaryTabId) chrome.tabs.reload(t.id);

  const payload = await refresh(); // reflects the cleared state immediately
  console.log('[prime]', `cleared ${cleared} cookie(s) on ${host}; sent tab to ${loginUrl}`);
  return { ok: true, cleared, loginUrl, needsLogin: true, payload };
}

// Re-harvest as soon as a source-host tab finishes (re)loading, so freshly
// minted cookies are pushed to the bridge without waiting for the next alarm.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !config || !tab.url) return;
  try {
    const host = new URL(config.cookieUrl).hostname;
    if (new URL(tab.url).hostname === host) refresh();
  } catch {
    // Ignore non-http(s) tab URLs.
  }
});

// ---------------------------------------------------------------------------
// Message handler — popup can request immediate refresh or config
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'refresh') {
    refresh().then(sendResponse);
    return true; // async response
  }
  if (msg.type === 'getState') {
    chrome.storage.local.get('lastPayload', (data) => {
      sendResponse(data.lastPayload || null);
    });
    return true;
  }
  if (msg.type === 'getConfig') {
    (async () => {
      if (!config) await loadConfig();
      sendResponse(config);
    })();
    return true;
  }
  if (msg.type === 'prime') {
    primeSession().then(sendResponse);
    return true; // async response
  }
});

// ---------------------------------------------------------------------------
// Cookie change listener — refresh when relevant cookies change
// ---------------------------------------------------------------------------

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!config) return;
  if (!config.cookies.includes(changeInfo.cookie.name)) return;

  // Match the changed cookie against the configured source host instead of a
  // hardcoded domain. Cookie domains may be host-only ("staging.example.com")
  // or dot-prefixed domain cookies (".staging.example.com"); normalise the
  // leading dot and accept the exact host or any subdomain of it.
  const host = new URL(config.cookieUrl).hostname;
  const cookieDomain = changeInfo.cookie.domain.replace(/^\./, '');
  if (cookieDomain === host || cookieDomain.endsWith('.' + host)) {
    refresh();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  await loadConfig();
  if (!config) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
  await setupAlarm();
  await refresh();
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
