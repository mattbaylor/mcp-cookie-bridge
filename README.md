# mcp-cookie-bridge

A Chrome extension + MCP server that captures browser cookies from a local dev server and exposes them to AI coding assistants (Claude, OpenCode, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io).

**Use case:** You have a local dev server that sets auth cookies on login. You want AI tools to access those cookies for tasks like:
- Authenticating Playwright browser sessions
- Making authenticated curl/fetch requests to local APIs
- Spinning up secondary dev servers that share the same session

## How it works

```
Chrome Extension                    MCP Server (stdio)
┌───────────────────────┐           ┌──────────────────────┐
│  chrome.cookies API   │──POST────>│  HTTP bridge :18443  │
│  reads from your      │  every    │                      │
│  configured URL       │  2 min    │  Persists to disk    │
│                       │  + on     │                      │
│  Popup shows status   │  change   │  Exposes MCP tools:  │
│  and freshness        │           │  - get_cookies       │
└───────────────────────┘           │  - get_cookie_header │
                                    │  - get_playwright_...|
                                    │  - get_cookie_status │
                                    └──────────────────────┘
                                              ▲
                                              │ stdio
                                              ▼
                                    ┌──────────────────────┐
                                    │  AI Agent            │
                                    │  (Claude, OpenCode)  │
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

Edit `config.json` with your cookie names and source/target hosts. Cookies are
harvested from `cookieUrl`'s host and re-targeted to `targetDomain` so a remote
session (e.g. a staging site) can be applied to localhost and other dev
servers/containers:

```json
{
  "cookieUrl": "https://your-source-host.example.com",
  "bridgePort": 18443,
  "refreshIntervalMinutes": 2,
  "staleAfterSeconds": 600,
  "targetDomain": "localhost",
  "targetPort": 8443,
  "cookies": [
    "session_token",
    "auth_jwt",
    "device_id"
  ]
}
```

Also copy the config into the extension directory:

```bash
cp config.json extension/config.json
```

### 2. Create the extension manifest

The manifest is user-specific because its `host_permissions` must name the host
you harvest cookies from, so it is git-ignored. Copy the template:

```bash
cp extension/manifest.example.json extension/manifest.json
```

If you harvest from a remote host (not just `localhost`), add it to
`host_permissions`, e.g. `"https://*.staging.example.com/*"`.

### 3. Install the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory
5. The extension icon should appear with a badge

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

Log into your dev server in Chrome, then ask your AI assistant:

- *"Get my dev server cookies"* → calls `get_cookies`
- *"Give me a cookie header for curl"* → calls `get_cookie_header`
- *"Set up Playwright with my auth cookies"* → calls `get_playwright_cookies`
- *"Is my cookie bridge healthy?"* → calls `get_cookie_status`

## Configuration

`config.json` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cookieUrl` | string | required | The URL/host to read (harvest) cookies from (e.g. `https://staging.example.com`) |
| `bridgePort` | number | `18443` | Local port for the HTTP bridge between extension and MCP server |
| `refreshIntervalMinutes` | number | `2` | How often the extension pushes cookie updates |
| `keepAliveIntervalMinutes` | number | `0` | How often the extension checks the session and, if at risk, reloads an open source-host tab to keep it alive. `0` disables it. See [Keeping a remote session alive](#keeping-a-remote-session-alive) |
| `keepAliveThresholdSeconds` | number | `300` | Reload the source-host tab(s) when the soonest cookie expiry is within this many seconds |
| `staleAfterSeconds` | number | `600` | Age threshold (seconds) after which cookies are flagged as stale |
| `targetDomain` | string | `localhost` | Host the cookies are re-targeted to in `get_playwright_cookies` output |
| `targetPort` | number | `8443` | Port used to build the Playwright `targetUrl` string |
| `cookies` | string[] | required | Cookie names to capture |

The config file is searched in this order:
1. `$MCP_COOKIE_BRIDGE_CONFIG` (env var)
2. `mcp-server/config.json`
3. `config.json` (repo root)
4. `~/.config/mcp-cookie-bridge/config.json`

## Keeping a remote session alive

When you harvest from a remote host (e.g. a staging site) whose session cookie
is short-lived, the session will expire if the tab sits idle. Set
`keepAliveIntervalMinutes` (> 0) to have the extension periodically **check** the
session and, only when it is at risk, reload an open tab pointed at `cookieUrl`'s
host — which re-bootstraps auth and rotates the session cookie. The fresh cookies
are then re-harvested automatically.

"At risk" means either a configured cookie is missing, or the soonest cookie
expiry is within `keepAliveThresholdSeconds`. When the session is healthy the
extension does nothing, so a tab you're actively using is never disturbed (active
use keeps the session far from expiry). When it is at risk, every open
source-host tab is reloaded — including the focused one, since an idle near-expiry
tab is safe to reload.

This works via a tab reload rather than a background request on purpose:
`SameSite=Strict` session cookies are only sent on same-site navigations, so a
`fetch()` from the extension's service worker (a cross-site context) would not
carry the cookie. **Keep a dedicated tab open on the source host** for keep-alive
to have anything to reload — it cannot revive a session once fully expired
(re-login is expected, e.g. daily).

**Confirming it works:** open the extension popup — the **Keep-alive** line shows
the last check time, how many source-host tabs were found, minutes of session
life left, and whether it reloaded (it turns amber if enabled but no tab is
open). The same status is included in the `get_cookie_status` MCP tool output,
and detailed lines are logged to the extension's service-worker console
(`chrome://extensions/` → the extension → *Inspect views: service worker*).

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_cookies` | Full cookie objects with values, metadata, and freshness |
| `get_cookie_header` | Ready-to-use `Cookie:` header string for HTTP requests |
| `get_playwright_cookies` | Array for `context.addCookies()` in Playwright automation |
| `get_cookie_status` | Health check: present/missing cookies, age, staleness |

## Security

- Cookies are stored in Chrome extension storage and in `~/.config/mcp-cookie-bridge/cookies.json`
- The HTTP bridge listens only on `127.0.0.1` (loopback) — not exposed to the network
- `config.json` and `cookies.json` are `.gitignore`d to prevent leaking secrets
- The extension requests `host_permissions` for `localhost` and the configured source host (e.g. `*.staging.example.com`)

## License

MIT
