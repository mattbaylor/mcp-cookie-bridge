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

Edit `config.json` with your cookie names and dev server URL:

```json
{
  "cookieUrl": "https://localhost:8443",
  "bridgePort": 18443,
  "refreshIntervalMinutes": 2,
  "staleAfterSeconds": 600,
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

### 2. Install the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory
5. The extension icon should appear with a badge

### 3. Build and configure the MCP server

```bash
cd mcp-server
npm install
npm run build
```

### 4. Add to your MCP client

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

### 5. Use it

Log into your dev server in Chrome, then ask your AI assistant:

- *"Get my dev server cookies"* → calls `get_cookies`
- *"Give me a cookie header for curl"* → calls `get_cookie_header`
- *"Set up Playwright with my auth cookies"* → calls `get_playwright_cookies`
- *"Is my cookie bridge healthy?"* → calls `get_cookie_status`

## Configuration

`config.json` fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cookieUrl` | string | required | The URL to read cookies from (e.g. `https://localhost:8443`) |
| `bridgePort` | number | `18443` | Local port for the HTTP bridge between extension and MCP server |
| `refreshIntervalMinutes` | number | `2` | How often the extension pushes cookie updates |
| `staleAfterSeconds` | number | `600` | Age threshold (seconds) after which cookies are flagged as stale |
| `cookies` | string[] | required | Cookie names to capture |

The config file is searched in this order:
1. `$MCP_COOKIE_BRIDGE_CONFIG` (env var)
2. `mcp-server/config.json`
3. `config.json` (repo root)
4. `~/.config/mcp-cookie-bridge/config.json`

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
- The extension only requests `host_permissions` for `localhost`

## License

MIT
