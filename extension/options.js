// MCP Cookie Bridge — options page

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

// --- form <-> config ---------------------------------------------------------

function writeForm(cfg) {
  cfg = cfg || {};
  const set = (id, v) => { $(id).value = v == null ? '' : v; };
  const setList = (id, a) => { $(id).value = (a || []).join('\n'); };
  set('cookieUrl', cfg.cookieUrl);
  set('logoutUrl', cfg.logoutUrl);
  set('loginUrl', cfg.loginUrl);
  setList('cookies', cfg.cookies);
  setList('requiredCookies', cfg.requiredCookies);
  setList('bootstrapCookies', cfg.bootstrapCookies);
  setList('primeClearCookies', cfg.primeClearCookies);
  set('targetDomain', cfg.targetDomain);
  set('targetPort', cfg.targetPort);
  set('bridgePort', cfg.bridgePort);
  set('refreshIntervalMinutes', cfg.refreshIntervalMinutes);
  set('staleAfterSeconds', cfg.staleAfterSeconds);
  set('bridgeToken', cfg.bridgeToken);
  setList('allowedHosts', cfg.allowedHosts);
  $('persist').checked = cfg.persist !== false;
}

function readForm() {
  const val = (id) => $(id).value.trim();
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };
  const list = (id) => $(id).value.split(/\n|,/).map((s) => s.trim()).filter(Boolean);

  const cfg = {
    cookieUrl: val('cookieUrl'),
    bridgePort: num('bridgePort') ?? 18443,
    refreshIntervalMinutes: num('refreshIntervalMinutes') ?? 2,
    cookies: list('cookies'),
    persist: $('persist').checked,
  };
  const opt = (key, v) => { if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) cfg[key] = v; };
  opt('logoutUrl', val('logoutUrl'));
  opt('loginUrl', val('loginUrl'));
  opt('requiredCookies', list('requiredCookies'));
  opt('bootstrapCookies', list('bootstrapCookies'));
  opt('primeClearCookies', list('primeClearCookies'));
  opt('targetDomain', val('targetDomain'));
  opt('targetPort', num('targetPort'));
  opt('staleAfterSeconds', num('staleAfterSeconds'));
  opt('bridgeToken', val('bridgeToken'));
  opt('allowedHosts', list('allowedHosts'));
  return cfg;
}

function validate(cfg) {
  if (!cfg.cookieUrl) return 'Cookie URL is required.';
  try { new URL(cfg.cookieUrl); } catch { return 'Cookie URL is not a valid URL.'; }
  if (!cfg.cookies.length) return 'At least one cookie name is required.';
  return null;
}

function saveConfig(cfg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'saveConfig', config: cfg }, resolve)
  );
}

// --- actions -----------------------------------------------------------------

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
    const cfg = JSON.parse(text);
    let generated = false;
    if (!cfg.bridgeToken) { cfg.bridgeToken = genToken(); generated = true; }
    const err = validate(cfg);
    if (err) return status('Imported file invalid: ' + err, true);
    writeForm(cfg);
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

chrome.runtime.sendMessage({ type: 'getConfig' }, (cfg) => {
  writeForm(cfg || {});
});
