// MCP Cookie Bridge — popup (per-profile status + prime)

function getConfig() {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getConfig' }, resolve));
}
function getState() {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getState' }, resolve));
}

function renderBridge(bridgeStatus) {
  const el = document.getElementById('bridgeStatus');
  if (bridgeStatus && bridgeStatus.ok) {
    el.className = 'bridge-status connected';
    el.textContent = 'MCP bridge: connected';
  } else {
    el.className = 'bridge-status disconnected';
    el.textContent = `MCP bridge: ${(bridgeStatus && bridgeStatus.error) || 'not connected'}`;
  }
}

function renderProfileCard(rp, payload) {
  const tpl = document.getElementById('profileTpl').content.cloneNode(true);
  const card = tpl.querySelector('.profile');
  const dot = card.querySelector('.p-dot');
  const name = card.querySelector('.p-name');
  const host = card.querySelector('.p-host');
  const state = card.querySelector('.p-state');
  const blocked = card.querySelector('.p-blocked');
  const primeBtn = card.querySelector('.p-prime');
  const primeStatus = card.querySelector('.p-primestatus');

  name.textContent = rp.key;
  host.textContent = rp.cookieUrl;
  if (rp.production) card.querySelector('.p-prod').style.display = '';
  if (rp.isDefault) card.querySelector('.p-default').style.display = '';

  if (rp.blocked) {
    dot.className = 'dot gray p-dot';
    blocked.style.display = '';
    blocked.textContent = rp.blockedReason || 'blocked';
    state.style.display = 'none';
    primeBtn.disabled = true;
    return card;
  }

  const required = rp.requiredCookies || [];
  const bootstrap = rp.bootstrapCookies || [];
  const present = (n) => !!(payload && payload.cookies && payload.cookies[n]);
  const reqPresent = required.filter(present).length;
  const missingReq = required.filter((n) => !present(n));
  const missingBoot = bootstrap.filter((n) => !present(n));

  if (!payload) {
    dot.className = 'dot red p-dot';
    state.innerHTML = 'No data yet — click Refresh';
  } else if (reqPresent === required.length) {
    dot.className = 'dot green p-dot';
    state.innerHTML = `Session ready (${reqPresent}/${required.length} required)`;
  } else if (reqPresent > 0) {
    dot.className = 'dot yellow p-dot';
    state.innerHTML = `${reqPresent}/${required.length} required present`;
  } else {
    dot.className = 'dot red p-dot';
    state.innerHTML = 'Not logged in — no required cookies';
  }

  const bits = [];
  if (payload && missingReq.length) bits.push(`<span class="miss">missing: ${missingReq.join(', ')}</span>`);
  if (missingBoot.length) bits.push(`<span class="boot">prime: ${missingBoot.join(', ')}</span>`);
  if (bits.length) state.innerHTML += '<br>' + bits.join(' · ');

  primeBtn.addEventListener('click', () => {
    primeBtn.disabled = true;
    primeBtn.textContent = 'Priming…';
    primeStatus.textContent = '';
    chrome.runtime.sendMessage({ type: 'prime', profile: rp.key }, (res) => {
      primeBtn.disabled = false;
      primeBtn.textContent = 'Prime';
      if (!res || !res.ok) {
        primeStatus.style.color = '#fdba74';
        primeStatus.textContent = (res && res.error) || 'Prime failed';
        return;
      }
      primeStatus.style.color = '#93c5fd';
      primeStatus.textContent = 'Complete login in the tab; cookies capture automatically.';
    });
  });

  return card;
}

async function renderAll() {
  const [cfg, st] = await Promise.all([getConfig(), getState()]);
  const payloads = (st && st.payloads) || {};
  renderBridge(st && st.bridgeStatus);

  const container = document.getElementById('profiles');
  const empty = document.getElementById('empty');
  container.innerHTML = '';

  const profiles = cfg && cfg.profiles ? Object.values(cfg.profiles) : [];
  if (!profiles.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  for (const rp of profiles) {
    rp.isDefault = cfg.defaultProfile === rp.key;
    container.appendChild(renderProfileCard(rp, payloads[rp.key]));
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  chrome.runtime.sendMessage({ type: 'refresh' }, () => {
    renderAll().then(() => {
      btn.disabled = false;
      btn.textContent = 'Refresh Now';
    });
  });
});

document.getElementById('settingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

renderAll();
