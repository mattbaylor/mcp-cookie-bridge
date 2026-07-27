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
  ],
  "requiredCookies": [
    "auth_jwt",
    "device_id"
  ],
  "bootstrapCookies": [
    "session_token"
  ]
}
```

`requiredCookies` drive session health; `bootstrapCookies` are short-lived tokens
that expire on their own and are [primed on demand](#priming-the-session) rather
than kept warm. Anything in `cookies` but neither list is treated as required.

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
| `logoutUrl` | string | — | Preferred **"Prime session"** target: a real logout URL (e.g. `https://staging.example.com/logout?reason=logout`). Navigated to with cookies intact so the server logs out, clears cookies, and redirects to login |
| `loginUrl` | string | `cookieUrl` | Fallback used only when `logoutUrl` is unset: Prime deletes `primeClearCookies` then navigates here |
| `bridgePort` | number | `18443` | Local port for the HTTP bridge between extension and MCP server |
| `refreshIntervalMinutes` | number | `2` | How often the extension pushes cookie updates |
| `requiredCookies` | string[] | all `cookies` | Cookies that must be present for a healthy session; drive the status badge |
| `bootstrapCookies` | string[] | `[]` | Short-lived cookies (e.g. a BFF session) primed on demand; their absence is not an error. See [Priming the session](#priming-the-session) |
| `primeClearCookies` | string[] | all `cookies` | Cookies **"Prime session"** deletes to force re-login. Set this to preserve some (e.g. a long-lived device id whose removal triggers a new-device challenge) |
| `staleAfterSeconds` | number | `600` | Age threshold (seconds) after which cookies are flagged as stale |
| `targetDomain` | string | `localhost` | Host the cookies are re-targeted to in `get_playwright_cookies` output |
| `targetPort` | number | `8443` | Port used to build the Playwright `targetUrl` string |
| `cookies` | string[] | required | Cookie names to capture |

The config file is searched in this order:
1. `$MCP_COOKIE_BRIDGE_CONFIG` (env var)
2. `mcp-server/config.json`
3. `config.json` (repo root)
4. `~/.config/mcp-cookie-bridge/config.json`

## Priming the session

Some auth setups issue a short-lived **bootstrap** cookie (e.g. a BFF session)
that the app mints on load and that expires on its own — often within minutes —
*even while the underlying login is still valid*. Trying to keep such a cookie
warm with a background loop is the wrong model (and, via repeated tab reloads,
can misbehave). Instead this extension treats bootstrap cookies as **primed on
demand**:

- List them in `bootstrapCookies`. Their absence does **not** mark the session
  unhealthy — the status badge and `get_cookie_status` are driven by
  `requiredCookies` (e.g. the login/device cookies) only.
- When you need one present — right before instantiating a session such as a
  Playwright context — click **"Prime session"** in the extension popup. A plain
  reload does *not* re-mint a bootstrap cookie while the session cookies are still
  set; it is only issued by the login flow. So Prime drives a real logout→login:
  - If **`logoutUrl`** is set (preferred), it navigates the tab there **with
    cookies intact** so the server performs a proper logout — invalidating the
    session, clearing its cookies, and redirecting to login.
  - Otherwise it falls back to deleting `primeClearCookies` (defaults to all
    `cookies`) and navigating to `loginUrl`. Use `primeClearCookies` to preserve
    cookies you don't want deleted — e.g. a device id whose removal would trigger
    a new-device challenge.

  **Complete the login in that tab** and the full cookie set (bootstrap included)
  is re-set and harvested automatically.

`get_playwright_cookies` and `get_cookie_status` include a `primeHint` whenever a
bootstrap cookie is missing. Priming needs the `cookies` and `tabs` permissions;
keep a source-host tab open.

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
