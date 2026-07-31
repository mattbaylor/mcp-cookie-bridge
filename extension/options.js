// MCP Cookie Bridge — options page (profile manager)

const $ = (id) => document.getElementById(id);

function genToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function status(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = isError ? '#fca5a5' : '#6ee7b7';
}

// --- shape helpers -----------------------------------------------------------

// Coerce any supported config shape (profiles / legacy environments / legacy
// flat) into an editable { bridge fields, profiles } structure.
function toEditable(raw) {
  raw = raw || {};
  let profiles = {};
  let defaultProfile = raw.defaultProfile || '';

  if (raw.profiles && Object.keys(raw.profiles).length) {
    profiles = JSON.parse(JSON.stringify(raw.profiles));
  } else if (raw.environments && Object.keys(raw.environments).length) {
    for (const [name, env] of Object.entries(raw.environments)) {
      profiles[name] = {
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
    profiles.default = {
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

  return {
    bridgePort: raw.bridgePort,
    bridgeToken: raw.bridgeToken,
    persist: raw.persist,
    refreshIntervalMinutes: raw.refreshIntervalMinutes,
    staleAfterSeconds: raw.staleAfterSeconds,
    allowProduction: !!raw.allowProduction,
    defaultProfile,
    profiles,
  };
}

// --- profile cards -----------------------------------------------------------

function profileCards() {
  return [...document.querySelectorAll('.profile-card')];
}

function readCard(card) {
  const v = (sel) => card.querySelector(sel).value.trim();
  const list = (sel) =>
    card.querySelector(sel).value.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
  const num = (sel) => { const x = card.querySelector(sel).value.trim(); return x === '' ? undefined : Number(x); };

  const p = { cookieUrl: v('.p-cookieUrl'), cookies: list('.p-cookies') };
  const opt = (k, val) => { if (val !== undefined && val !== '' && !(Array.isArray(val) && !val.length)) p[k] = val; };
  opt('loginUrl', v('.p-loginUrl'));
  opt('logoutUrl', v('.p-logoutUrl'));
  opt('requiredCookies', list('.p-requiredCookies'));
  opt('bootstrapCookies', list('.p-bootstrapCookies'));
  opt('primeClearCookies', list('.p-primeClearCookies'));
  opt('targetDomain', v('.p-targetDomain'));
  opt('targetPort', num('.p-targetPort'));
  opt('allowedHosts', list('.p-allowedHosts'));
  if (card.querySelector('.p-production').checked) p.production = true;
  return { key: v('.p-key'), profile: p };
}

function addProfileCard(key, p) {
  p = p || {};
  const tpl = $('profileTpl').content.cloneNode(true);
  const card = tpl.querySelector('.profile-card');
  const set = (sel, val) => { card.querySelector(sel).value = val == null ? '' : val; };
  const setList = (sel, a) => { card.querySelector(sel).value = (a || []).join('\n'); };
  set('.p-key', key || '');
  set('.p-cookieUrl', p.cookieUrl);
  set('.p-loginUrl', p.loginUrl);
  set('.p-logoutUrl', p.logoutUrl);
  setList('.p-cookies', p.cookies);
  setList('.p-requiredCookies', p.requiredCookies);
  setList('.p-bootstrapCookies', p.bootstrapCookies);
  setList('.p-primeClearCookies', p.primeClearCookies);
  set('.p-targetDomain', p.targetDomain);
  set('.p-targetPort', p.targetPort);
  setList('.p-allowedHosts', p.allowedHosts);
  card.querySelector('.p-production').checked = !!p.production;

  card.querySelector('.p-remove').addEventListener('click', () => {
    card.remove();
    refreshDefaultOptions();
  });
  card.querySelector('.p-key').addEventListener('input', refreshDefaultOptions);
  $('profiles').appendChild(card);
}

function refreshDefaultOptions() {
  const sel = $('defaultProfile');
  const prev = sel.value;
  const keys = profileCards().map((c) => c.querySelector('.p-key').value.trim()).filter(Boolean);
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '(none)';
  sel.appendChild(blank);
  for (const k of keys) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = k;
    sel.appendChild(o);
  }
  sel.value = keys.includes(prev) ? prev : (keys[0] || '');
}

// --- form <-> config ---------------------------------------------------------

function writeForm(raw) {
  const ed = toEditable(raw);
  const set = (id, v) => { $(id).value = v == null ? '' : v; };
  set('bridgePort', ed.bridgePort);
  set('bridgeToken', ed.bridgeToken);
  set('refreshIntervalMinutes', ed.refreshIntervalMinutes);
  set('staleAfterSeconds', ed.staleAfterSeconds);
  $('persist').checked = ed.persist !== false;
  $('allowProduction').checked = !!ed.allowProduction;

  $('profiles').innerHTML = '';
  for (const [key, p] of Object.entries(ed.profiles)) addProfileCard(key, p);
  if (!Object.keys(ed.profiles).length) addProfileCard('', {});

  refreshDefaultOptions();
  if (ed.defaultProfile) $('defaultProfile').value = ed.defaultProfile;
}

function readForm() {
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };
  const val = (id) => $(id).value.trim();

  const profiles = {};
  for (const card of profileCards()) {
    const { key, profile } = readCard(card);
    if (!key) continue;
    profiles[key] = profile;
  }

  const cfg = {
    bridgePort: num('bridgePort') ?? 18443,
    refreshIntervalMinutes: num('refreshIntervalMinutes') ?? 2,
    persist: $('persist').checked,
    allowProduction: $('allowProduction').checked,
    profiles,
  };
  const opt = (k, v) => { if (v !== undefined && v !== '') cfg[k] = v; };
  opt('staleAfterSeconds', num('staleAfterSeconds'));
  opt('bridgeToken', val('bridgeToken'));
  opt('defaultProfile', val('defaultProfile'));
  return cfg;
}

function validate(cfg) {
  const keys = Object.keys(cfg.profiles);
  if (!keys.length) return 'Add at least one profile with a Cookie URL.';
  for (const key of keys) {
    const p = cfg.profiles[key];
    if (!p.cookieUrl) return `Cookie URL is required for profile "${key}".`;
    try { new URL(p.cookieUrl); } catch { return `Cookie URL for "${key}" is not a valid URL.`; }
    if (!p.cookies || !p.cookies.length) return `At least one cookie name is required for "${key}".`;
  }
  if (cfg.defaultProfile && !keys.includes(cfg.defaultProfile)) {
    return `Default profile "${cfg.defaultProfile}" is not one of the profiles.`;
  }
  return null;
}

function saveConfig(cfg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'saveConfig', config: cfg }, resolve)
  );
}

// --- actions -----------------------------------------------------------------

$('addProfileBtn').addEventListener('click', () => {
  addProfileCard('', {});
  refreshDefaultOptions();
});

$('genTokenBtn').addEventListener('click', () => {
  $('bridgeToken').value = genToken();
  status('Generated a token — remember to Save and Export.');
});

$('saveBtn').addEventListener('click', async () => {
  const cfg = readForm();
  const err = validate(cfg);
  if (err) return status(err, true);
  const res = await saveConfig(cfg);
  if (res && res.ok) status('Saved. Export the JSON and place it at the MCP server config path, then restart the server.');
  else status('Save failed: ' + ((res && res.error) || 'unknown'), true);
});

$('exportBtn').addEventListener('click', () => {
  const cfg = readForm();
  const err = validate(cfg);
  if (err) return status(err, true);
  const blob = new Blob([JSON.stringify(cfg, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'config.json';
  a.click();
  URL.revokeObjectURL(url);
  status('Exported config.json — place it at the MCP server config path too.');
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    let generated = false;
    if (!raw.bridgeToken) { raw.bridgeToken = genToken(); generated = true; }
    writeForm(raw);
    const cfg = readForm();
    const err = validate(cfg);
    if (err) return status('Imported file invalid: ' + err, true);
    const res = await saveConfig(cfg);
    if (res && res.ok) {
      status('Imported & saved.' + (generated ? ' Generated a per-device bridgeToken — Export to share the rest.' : '') + ' Also place the JSON at the MCP server config path.');
    } else {
      status('Imported but save failed: ' + ((res && res.error) || 'unknown'), true);
    }
  } catch (e) {
    status('Import failed: ' + e.message, true);
  } finally {
    $('importFile').value = '';
  }
});

// --- init --------------------------------------------------------------------

chrome.runtime.sendMessage({ type: 'getRawConfig' }, (raw) => {
  writeForm(raw || {});
});
