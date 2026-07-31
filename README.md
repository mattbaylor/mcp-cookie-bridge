# mcp-cookie-bridge

A Chrome extension + MCP server that captures browser cookies and exposes them to
AI coding assistants (Claude, OpenCode, etc.) via the
[Model Context Protocol](https://modelcontextprotocol.io).

**Use case:** You have one or more sites/apps whose auth cookies you want AI tools
to reuse for local development — for example:
- Authenticating Playwright browser sessions
- Making authenticated curl/fetch requests to local APIs
- Spinning up secondary dev servers that share the same session

The bridge is **profile-based**: define many independent host+cookie combos
(different apps and/or environments — staging, dev, prod) and it tracks them all
at once. Each profile harvests from its own source host and re-targets to its own
local dev target. The agent picks a profile per call by **key** or by **URL**.

## How it works

```
Chrome Extension                    MCP Server (stdio)
┌───────────────────────┐           ┌──────────────────────┐
│  chrome.cookies API   │──POST────>│  HTTP bridge :18443  │
│  reads EVERY profile  │  every    │                      │
│  you're logged into   │  2 min    │  { profiles: {…} }   │
│                       │  + on     │  Persists to disk    │
│  Popup: per-profile   │  change   │                      │
│  status + Prime       │           │  MCP tools:          │
│                       │<─poll─────│  - list_profiles     │
│  Prime queue          │  /prime   │  - get_cookies       │
└───────────────────────┘           │  - get_cookie_header │
                                    │  - get_playwright_…  │
                                    │  - get_cookie_status │
                                    │  - request_prime     │
                                    └──────────────────────┘
                                              ▲ stdio
                                              ▼
                                    ┌──────────────────────┐
                                    │  AI Agent            │
                                    └──────────────────────┘
```

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/mattbaylor/mcp-cookie-bridge.git
cd mcp-cookie-bridge

# Create your config (both the extension and MCP server read this)
cp config.example.json config.json
```

Edit `config.json`. Each **profile** names a source host (`cookieUrl`), the cookie
names to capture, and where to re-target them locally (`targetDomain`/`targetPort`).
Cookies are harvested from the profile's host and re-targeted so a remote session
(e.g. a staging site) can be applied to localhost and other dev servers/containers:

```json
{
  "bridgePort": 18443,
  "bridgeToken": "CHANGE_ME_shared_secret",
  "persist": true,
  "allowProduction": false,
  "defaultProfile": "app-staging",
  "profiles": {
    "app-staging": {
      "cookieUrl": "https://staging.example.com",
      "logoutUrl": "https://staging.example.com/logout",
      "cookies": ["session_token", "auth_jwt", "device_id"],
      "requiredCookies": ["auth_jwt", "device_id"],
      "bootstrapCookies": ["session_token"],
      "targetDomain": "localhost",
      "targetPort": 8443,
      "allowedHosts": ["staging.example.com"]
    },
    "other-app-staging": {
      "cookieUrl": "https://staging.other-app.example",
      "cookies": ["oa_session", "oa_csrf"],
      "requiredCookies": ["oa_session"],
      "targetPort": 9000,
      "allowedHosts": ["other-app.example"]
    }
  }
}
```

Per profile: `requiredCookies` drive session health; `bootstrapCookies` are
short-lived tokens that expire on their own and are
[primed on demand](#priming-the-session) rather than kept warm. Anything in
`cookies` but neither list is treated as required.

**Back-compat:** a legacy single-host config (top-level `cookieUrl`) or the earlier
`environments` shape still loads — each is converted to profiles automatically.

Also copy the config into the extension directory:

```bash
cp config.json extension/config.json
```

### 2. Create the extension manifest

The manifest is user-specific because its `host_permissions` must name every host
you harvest cookies from, so it is git-ignored. Copy the template:

```bash
cp extension/manifest.example.json extension/manifest.json
```

Add **every** profile host to `host_permissions`, e.g.:

```json
"host_permissions": [
  "https://*.staging.example.com/*",
  "https://*.other-app.example/*",
  "https://localhost/*",
  "http://localhost/*"
]
```

### 3. Install the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory

### 4. Build and configure the MCP server

```bash
cd mcp-server
npm install
npm run build
```

### 5. Add to your MCP client

#### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "cookie-bridge": {
      "type": "local",
      "command": ["node", "/path/to/mcp-cookie-bridge/mcp-server/dist/index.js"],
      "enabled": true
    }
  }
}
```

#### Claude Code (`.claude.json`)

```json
{
  "mcpServers": {
    "cookie-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-cookie-bridge/mcp-server/dist/index.js"]
    }
  }
}
```

### 6. Use it

Log into your site(s) in Chrome, then ask your AI assistant:

- *"What cookie profiles are available?"* → `list_profiles`
- *"Get my cookies for app-staging"* / *"…for https://staging.example.com"* → `get_cookies`
- *"Give me a cookie header for the staging API"* → `get_cookie_header`
- *"Set up Playwright with the other-app cookies"* → `get_playwright_cookies`
- *"Is the staging session healthy?"* → `get_cookie_status`
- *"Prime the staging session"* → `request_prime`

## Selecting a profile

Every cookie tool accepts a selector:

- **`profile`** — the exact key, e.g. `"app-staging"`.
- **`url`** — any URL/host you're targeting; the bridge resolves the profile whose
  host (or `allowedHosts`) matches. Handy when the agent knows the URL but not the key.
- **Neither** — falls back to `defaultProfile` (or the only profile if just one).

Use **`list_profiles`** to discover the configured profiles, their hosts, whether
they're production/blocked, and live cookie status.

## Configuration

Top-level (bridge) fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `bridgePort` | number | `18443` | Local port for the HTTP bridge between extension and MCP server |
| `bridgeToken` | string | — | Shared secret. When set, the bridge requires an `X-Cookie-Bridge-Token` header. **Must match** in the extension and server config |
| `persist` | boolean | `true` | Persist cookies to `~/.config/mcp-cookie-bridge/cookies.json`. Set `false` for memory-only |
| `refreshIntervalMinutes` | number | `2` | How often the extension pushes cookie updates |
| `staleAfterSeconds` | number | `600` | Age threshold after which cookies are flagged stale |
| `allowProduction` | boolean | `false` | Global opt-in. Profiles marked `production` stay blocked until this is `true` |
| `defaultProfile` | string | — | Profile used when a tool omits both `profile` and `url` |
| `profiles` | object | required | Map of profile key → profile config (below) |

Per-profile fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cookieUrl` | string | required | Host to harvest cookies from |
| `logoutUrl` | string | — | Preferred **Prime** target: a real logout URL (navigated to with cookies intact for a server-side logout) |
| `loginUrl` | string | `cookieUrl` | Fallback Prime target when `logoutUrl` is unset |
| `cookies` | string[] | required | Cookie names to capture |
| `requiredCookies` | string[] | all `cookies` | Cookies that must be present for a healthy session |
| `bootstrapCookies` | string[] | `[]` | Short-lived cookies primed on demand; their absence is not an error |
| `primeClearCookies` | string[] | all `cookies` | Cookies Prime's fallback path deletes to force re-login |
| `targetDomain` | string | `localhost` | Host the cookies are re-targeted to for Playwright |
| `targetPort` | number | `8443` | Port used to build the Playwright `targetUrl` |
| `allowedHosts` | string[] | — | Allowlist of permitted `cookieUrl` host suffixes. If `cookieUrl`'s host doesn't match, the profile is **blocked** |
| `production` | boolean | `false` | Marks the profile as production — blocked unless `allowProduction` is `true` |

The config file is searched in this order:
1. `$MCP_COOKIE_BRIDGE_CONFIG` (env var)
2. `mcp-server/config.json`
3. `config.json` (repo root)
4. `~/.config/mcp-cookie-bridge/config.json`

### Configuring via the extension UI

The extension's **options page** (its ⚙ Settings link, or `chrome://extensions/`
→ Details → Extension options) is a full **profile manager**: add/remove/edit
profiles, set bridge-level options, the default profile, and the `allowProduction`
toggle. It saves to `chrome.storage` (preferred over the bundled `config.json`).

- **Import JSON** — upload a shared preset. If it has no `bridgeToken`, a per-device
  one is generated.
- **Export JSON** — download the current settings. **The MCP server reads a file,
  not this UI**, so place the exported `config.json` at a server config path and
  restart the server.

## Priming the session

Some auth setups issue a short-lived **bootstrap** cookie (e.g. a BFF session) that
the app mints on load and that expires on its own, even while the underlying login
is still valid. These are **primed on demand**, per profile:

- List them in a profile's `bootstrapCookies`. Their absence does **not** mark the
  session unhealthy.
- When you need one present — right before instantiating a session such as a
  Playwright context — prime the profile. A plain reload does *not* re-mint a
  bootstrap cookie; only the login flow does. So Prime drives a real logout→login:
  - If **`logoutUrl`** is set (preferred), it navigates the profile's tab there
    with cookies intact so the server performs a proper logout and redirects to login.
  - Otherwise it deletes `primeClearCookies` and navigates to `loginUrl`.

  **Complete the login in that tab** and the full cookie set is re-harvested
  automatically.

Two ways to prime:

- **Manually** — click **Prime** next to the profile in the extension popup.
- **Agent-triggered** — call the **`request_prime`** tool with a `profile` or `url`.
  The MCP queues the request on the bridge; the extension picks it up (polling every
  ~30s, or immediately when its popup is open), opens/redirects a tab on that host,
  and you complete the interactive login. `get_playwright_cookies` and
  `get_cookie_status` include a `primeHint` whenever a bootstrap cookie is missing.

Priming needs the `cookies` and `tabs` permissions.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_profiles` | List configured profiles, their hosts, and live status. Start here to pick a profile |
| `get_cookies` | Full cookie objects for a profile, with values, metadata, and freshness |
| `get_cookie_header` | Ready-to-use `Cookie:` header string for a profile |
| `get_playwright_cookies` | Array for `context.addCookies()` + the profile's local `targetUrl` |
| `get_cookie_status` | Health check for a profile: present/missing cookies, age, staleness |
| `request_prime` | Ask the extension to prime (re-login) a profile so bootstrap cookies are re-minted |

All cookie tools accept `profile` and/or `url` (see [Selecting a profile](#selecting-a-profile)).

## Security

**Trust boundary.** The tool uses your *own* already-authenticated browser sessions,
on your *own* machine. It creates no new credentials and grants no access you don't
already have — it automates what you could do by hand in DevTools, with tighter
handling:

- **Scoped** — only the cookies named in each profile's `cookies` are read.
- **No secret sprawl** — values never touch the clipboard, shell history, or chat.
- **No secrets in git** — `config.json`, `extension/config.json`, `manifest.json`
  and `cookies.json` are `.gitignore`d; the repo carries names/examples only.
- **Real logout** — Prime performs a server-side logout where a `logoutUrl` is set.

**Handling of secrets at rest / in transit:**

- The HTTP bridge listens only on `127.0.0.1` (loopback), never the network.
- `cookies.json` is written owner-only (`0600`, dir `0700`); set `persist: false`
  for memory-only (no tokens at rest).
- CORS is sent only on the extension's writes, never on the secret-returning
  `GET /cookies`, so a malicious web page cannot read your tokens cross-origin.
- Set `bridgeToken` to require an `X-Cookie-Bridge-Token` header on the secret
  routes (`/cookies`, `/prime`).
- **Production gating** — a profile marked `production` stays blocked (no harvest,
  tools return an error) until you set `allowProduction: true`, so production is
  never the accidental default. When you do opt in, production session tokens are
  written to `cookies.json`; use `persist: false` if you'd rather not have them at rest.
- Set each profile's `allowedHosts` to pin it to known hosts.

**Notes for review:**

- The extension necessarily reads `httpOnly` cookies (via `chrome.cookies`) — the
  same capability DevTools has — because the tokens are needed to instantiate a
  session. Exposure is minimised by the controls above.
- The extension is **dev-loaded (unpacked) and code-reviewed in this repo**, not
  installed from a store; it requests `cookies`, `tabs`, and `host_permissions` for
  `localhost` and the configured profile hosts only.

## License

MIT
