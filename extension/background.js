// MCP Cookie Bridge — Background Service Worker
//
// Reads cookies specified in config.json from a configured URL and pushes
// them to a local MCP bridge server. Config-driven — no hardcoded cookie
// names or URLs.

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** @type {{ cookieUrl: string, bridgePort: number, refreshIntervalMinutes: number, keepAliveIntervalMinutes?: number, keepAliveThresholdSeconds?: number, cookies: string[] } | null} */
let config = null;

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
  const wantedNames = new Set(config.cookies);

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

  return {
    cookies: results,
    allPresent,
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

  // Attach the latest keep-alive status so it rides along to the bridge/popup.
  try {
    const { keepAlive } = await chrome.storage.local.get('keepAlive');
    if (keepAlive) payload.keepAlive = keepAlive;
  } catch {
    // storage unavailable — non-fatal
  }

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

  const total = config.cookies.length;
  if (payload.allPresent) {
    chrome.action.setBadgeText({ text: 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } else {
    const count = Object.values(payload.cookies).filter((c) => c !== null).length;
    chrome.action.setBadgeText({ text: `${count}/${total}` });
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

  // Optional keep-alive alarm — only when configured (> 0).
  const keepAlive = config?.keepAliveIntervalMinutes || 0;
  if (keepAlive > 0) {
    chrome.alarms.create('cookie-keepalive', {
      periodInMinutes: keepAlive,
    });
  } else {
    chrome.alarms.clear('cookie-keepalive');
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cookie-refresh') {
    refresh();
  }
  if (alarm.name === 'cookie-keepalive') {
    keepAliveCheck();
  }
});

// ---------------------------------------------------------------------------
// Keep-alive — reload an open source-host tab so a short-lived remote session
// cookie keeps rotating.
//
// The session cookie is typically SameSite=Strict, so it is only sent on
// same-site navigations. A background fetch from this service worker is
// cross-site and would NOT carry the cookie — so the only way to keep the
// session warm is to reload an actual tab pointed at the source host.
//
// This runs on every keep-alive alarm as a *check*: it reloads only when the
// session is actually at risk — either a configured cookie is missing, or the
// soonest cookie expiry is within keepAliveThresholdSeconds. When healthy it
// does nothing (and, in particular, never disturbs a tab you're actively using,
// because active use keeps the session far from expiry). When at risk it
// reloads every open source-host tab, including the focused one — if you were
// actively using it the session wouldn't be near expiry, so an idle reload is
// safe. Status is recorded to storage (and pushed to the bridge) for
// observability.
// ---------------------------------------------------------------------------

async function keepAliveCheck() {
  if (!config) await loadConfig();
  if (!config || !config.cookieUrl) return null;
  if (!(config.keepAliveIntervalMinutes > 0)) return null;

  const thresholdSec = config.keepAliveThresholdSeconds || 300;
  const host = new URL(config.cookieUrl).hostname;

  /** @type {{lastRunAt:string, host:string, tabsFound:number, reloaded:number, minSecondsToExpiry:(number|null), thresholdSeconds:number, reason:string}} */
  const status = {
    lastRunAt: new Date().toISOString(),
    host,
    tabsFound: 0,
    reloaded: 0,
    minSecondsToExpiry: null,
    thresholdSeconds: thresholdSec,
    reason: '',
  };

  const tabs = await chrome.tabs.query({ url: `*://${host}/*` });
  status.tabsFound = tabs.length;

  // Determine the soonest expiry among present, dated cookies.
  const payload = await readCookies();
  let minRemainingMs = Infinity;
  if (payload) {
    for (const name of config.cookies) {
      const c = payload.cookies[name];
      if (c && c.expirationDate) {
        minRemainingMs = Math.min(minRemainingMs, c.expirationDate * 1000 - Date.now());
      }
    }
  }
  const minSec = Number.isFinite(minRemainingMs) ? Math.round(minRemainingMs / 1000) : null;
  status.minSecondsToExpiry = minSec;

  const anyMissing = !payload || !payload.allPresent;
  const nearExpiry = minSec !== null && minSec < thresholdSec;
  const needReload = anyMissing || nearExpiry;

  if (!tabs.length) {
    status.reason = 'no source-host tab open — cannot keep the session alive';
  } else if (!needReload) {
    status.reason = `healthy — ${minSec}s to expiry (>= ${thresholdSec}s), no reload`;
  } else {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.reload(tab.id);
        status.reloaded++;
      }
    }
    status.reason = anyMissing
      ? `cookie(s) missing — reloaded ${status.reloaded} tab(s) to re-establish session`
      : `${minSec}s to expiry (< ${thresholdSec}s) — reloaded ${status.reloaded} tab(s)`;
  }

  const logArgs = ['[keep-alive]', status.reason, `(tabsFound=${status.tabsFound}, minSecondsToExpiry=${minSec})`];
  // Routine status is informational; only "no tab open" is actionable. Neither
  // is an error, so don't use console.error (keeps the SW error badge clean).
  if (status.tabsFound === 0) console.warn(...logArgs);
  else console.log(...logArgs);
  await chrome.storage.local.set({ keepAlive: status });

  // Push the status promptly. If we reloaded, the tabs.onUpdated handler will
  // also refresh once the reload completes with the rotated cookies.
  if (!status.reloaded) refresh();

  return status;
}

// Re-harvest as soon as a source-host tab finishes (re)loading, so the freshly
// rotated cookies are pushed to the bridge without waiting for the next alarm.
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
