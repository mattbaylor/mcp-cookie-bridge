// MCP Cookie Bridge — keep-alive content script
//
// Runs inside a source-host tab. This exists because an MV3 background service
// worker gets suspended when idle and its chrome.alarms can stall — so a
// service-worker-driven keep-alive is unreliable. A content script's timer, by
// contrast, runs dependably for as long as the tab is open.
//
// Each tick does two things:
//   1. A same-origin credentialed fetch of the current URL. Because this runs in
//      the page's origin it is a SAME-SITE request, so it carries SameSite=Strict
//      session cookies (a service-worker fetch would not) and lets the BFF slide
//      the session forward — no page reload, no lost state.
//   2. A message to the service worker, which reliably wakes it to re-harvest the
//      rotated cookies and run its expiry-based reload backstop if the ping alone
//      didn't renew the session.

(function () {
  let started = false;

  async function getConfig() {
    try {
      return await chrome.runtime.sendMessage({ type: 'getConfig' });
    } catch {
      return null;
    }
  }

  async function tick() {
    // Non-disruptive renew: same-origin, credentialed. redirect:'manual' so a
    // logged-out 302 to the login page is ignored rather than followed.
    try {
      await fetch(location.href, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch {
      // Network hiccup — the service-worker backstop still runs below.
    }
    // Wake the service worker to re-harvest and run its expiry check/backstop.
    try {
      chrome.runtime.sendMessage({ type: 'keepalive-tick' });
    } catch {
      // Extension context gone (e.g. reloaded) — the fresh injection takes over.
    }
  }

  async function start() {
    if (started) return;
    const cfg = await getConfig();
    if (!cfg || !(cfg.keepAliveIntervalMinutes > 0)) return; // disabled
    started = true;
    const ms = Math.max(30000, cfg.keepAliveIntervalMinutes * 60000);
    setInterval(tick, ms);
    tick();
  }

  start();
})();
