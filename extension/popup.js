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

  if (!payload) {
    statusText.textContent = 'No data yet — click Refresh';
    return;
  }

  // Cookie list
  cookieList.innerHTML = '';
  let presentCount = 0;
  for (const name of cookieNames) {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cookie-name';
    nameSpan.textContent = name;
    nameSpan.title = name;

    const statusSpan = document.createElement('span');
    if (payload.cookies && payload.cookies[name]) {
      statusSpan.className = 'cookie-present';
      statusSpan.textContent = '\u2713';
      presentCount++;
    } else {
      statusSpan.className = 'cookie-missing';
      statusSpan.textContent = '\u2717';
    }

    li.appendChild(nameSpan);
    li.appendChild(statusSpan);
    cookieList.appendChild(li);
  }

  // Status bar
  const total = cookieNames.length;
  if (presentCount === total) {
    statusBar.className = 'status-bar ok';
    statusDot.className = 'dot green';
    statusText.textContent = `All ${presentCount} cookies present`;
  } else if (presentCount > 0) {
    statusBar.className = 'status-bar partial';
    statusDot.className = 'dot yellow';
    statusText.textContent = `${presentCount}/${total} cookies present`;
  } else {
    statusBar.className = 'status-bar none';
    statusDot.className = 'dot red';
    statusText.textContent = 'No cookies found';
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
