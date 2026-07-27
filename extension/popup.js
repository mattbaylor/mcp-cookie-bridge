// MCP Cookie Bridge — Popup Script

/** @type {string[]} */
let cookieNames = [];

function render(payload, cfg) {
  const statusBar = document.getElementById('statusBar');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const cookieList = document.getElementById('cookieList');
  const lastRefresh = document.getElementById('lastRefresh');
  const bridgeStatus = document.getElementById('bridgeStatus');
  const sourceUrl = document.getElementById('sourceUrl');

  if (!cfg) {
    statusBar.className = 'status-bar noconfig';
    statusDot.className = 'dot yellow';
    statusText.textContent = 'No config.json found';
    return;
  }

  cookieNames = cfg.cookies || [];
  sourceUrl.textContent = cfg.cookieUrl || '--';

  const requiredNames =
    cfg.requiredCookies && cfg.requiredCookies.length ? cfg.requiredCookies : cookieNames;
  const bootstrapNames = cfg.bootstrapCookies || [];

  if (!payload) {
    statusText.textContent = 'No data yet — click Refresh';
    return;
  }

  // Cookie list
  cookieList.innerHTML = '';
  let requiredPresent = 0;
  for (const name of cookieNames) {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cookie-name';
    nameSpan.textContent = name;
    nameSpan.title = name;

    const isBootstrap = bootstrapNames.includes(name);
    const isRequired = requiredNames.includes(name);
    if (isBootstrap) {
      const tag = document.createElement('span');
      tag.className = 'cookie-optional-tag';
      tag.textContent = 'bootstrap';
      nameSpan.appendChild(tag);
    }

    const present = !!(payload.cookies && payload.cookies[name]);
    if (isRequired && present) requiredPresent++;

    const statusSpan = document.createElement('span');
    if (present) {
      statusSpan.className = 'cookie-present';
      statusSpan.textContent = '\u2713';
    } else if (isBootstrap) {
      // Bootstrap cookies come and go — absence is normal, not an error.
      statusSpan.className = 'cookie-bootstrap';
      statusSpan.textContent = 'prime';
    } else {
      statusSpan.className = 'cookie-missing';
      statusSpan.textContent = '\u2717';
    }

    li.appendChild(nameSpan);
    li.appendChild(statusSpan);
    cookieList.appendChild(li);
  }

  // Status bar — driven by REQUIRED cookies only.
  const totalRequired = requiredNames.length;
  if (requiredPresent === totalRequired) {
    statusBar.className = 'status-bar ok';
    statusDot.className = 'dot green';
    statusText.textContent = `Session ready (${totalRequired}/${totalRequired} required)`;
  } else if (requiredPresent > 0) {
    statusBar.className = 'status-bar partial';
    statusDot.className = 'dot yellow';
    statusText.textContent = `${requiredPresent}/${totalRequired} required cookies present`;
  } else {
    statusBar.className = 'status-bar none';
    statusDot.className = 'dot red';
    statusText.textContent = 'Not logged in — no required cookies';
  }

  // Timestamp
  if (payload.timestamp) {
    const d = new Date(payload.timestamp);
    lastRefresh.textContent = d.toLocaleTimeString();
  }

  // Bridge status
  if (payload.bridgeStatus?.ok) {
    bridgeStatus.className = 'bridge-status connected';
    bridgeStatus.textContent = 'MCP bridge: connected';
  } else {
    bridgeStatus.className = 'bridge-status disconnected';
    bridgeStatus.textContent = `MCP bridge: ${payload.bridgeStatus?.error || 'not connected'}`;
  }
}

// Load config and initial state in parallel
Promise.all([
  new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getConfig' }, resolve)),
  new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getState' }, resolve)),
]).then(([cfg, payload]) => {
  render(payload, cfg);
});

// Prime button — reload the source-host tab to mint a fresh bootstrap session.
document.getElementById('primeBtn').addEventListener('click', () => {
  const btn = document.getElementById('primeBtn');
  const primeStatus = document.getElementById('primeStatus');
  btn.disabled = true;
  btn.textContent = 'Priming…';
  primeStatus.textContent = '';
  primeStatus.style.color = '';

  chrome.runtime.sendMessage({ type: 'prime' }, (res) => {
    btn.disabled = false;
    btn.textContent = 'Prime session';
    if (!res || !res.ok) {
      primeStatus.style.color = '#fdba74';
      primeStatus.textContent = (res && res.error) || 'Prime failed';
      return;
    }
    primeStatus.style.color = '#93c5fd';
    primeStatus.textContent = `Cleared ${res.cleared} cookie(s) & reloaded — log in in the tab; cookies capture automatically.`;
    // Re-render with the (now-cleared) payload; login will update it live.
    Promise.all([
      new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getConfig' }, resolve)),
      new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getState' }, resolve)),
    ]).then(([cfg, payload]) => render(payload, cfg));
  });
});

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', () => {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';

  Promise.all([
    new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getConfig' }, resolve)),
    new Promise((resolve) => chrome.runtime.sendMessage({ type: 'refresh' }, resolve)),
  ]).then(([cfg, payload]) => {
    render(payload, cfg);
    btn.disabled = false;
    btn.textContent = 'Refresh Now';
  });
});
