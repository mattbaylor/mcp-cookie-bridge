#!/usr/bin/env node

// MCP Cookie Bridge — MCP Server
//
// Two responsibilities:
//   1. HTTP server on a configurable port — receives cookie pushes from the
//      Chrome extension
//   2. MCP stdio server — exposes tools for AI agents to read/use cookies
//
// Cookie data is held in memory and persisted to a JSON file as a fallback.
// All cookie names, URLs, and ports are config-driven — nothing is hardcoded.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  cookieUrl: string;
  /**
   * Extension-only: preferred Prime action. When set, "Prime session" navigates
   * the tab here WITH cookies intact to perform a real server-side logout (which
   * clears cookies and redirects to login). e.g. ".../logout?reason=logout".
   */
  logoutUrl?: string;
  /**
   * Extension-only: fallback used only when logoutUrl is not set. "Prime session"
   * deletes primeClearCookies and navigates here. Defaults to cookieUrl.
   */
  loginUrl?: string;
  bridgePort: number;
  refreshIntervalMinutes: number;
  cookies: string[];
  /** Staleness threshold in seconds. Defaults to 600 (10 min). */
  staleAfterSeconds?: number;
  /**
   * Cookies that must be present for the session to be considered healthy.
   * Defaults to all `cookies` when omitted.
   */
  requiredCookies?: string[];
  /**
   * Short-lived "bootstrap" cookies (e.g. a BFF session) that are minted when the
   * app loads and expire on their own. Their absence is not a health problem —
   * they are primed on demand (reload the source tab) right before a session that
   * needs them, e.g. a Playwright context.
   */
  bootstrapCookies?: string[];
  /**
   * Extension-only: cookies that "Prime session" deletes to force a fresh login.
   * Defaults to all `cookies`. Set this to preserve some — e.g. a long-lived
   * device id whose removal would trigger a new-device challenge.
   */
  primeClearCookies?: string[];
  /**
   * Domain the captured cookies are re-targeted to when emitted for Playwright.
   * The source cookies are harvested from cookieUrl's host but applied to this
   * host on the local dev machine. Defaults to "localhost".
   */
  targetDomain?: string;
  /** Port used to build the Playwright targetUrl string. Defaults to 8443. */
  targetPort?: number;
  /**
   * Shared secret. When set, the loopback bridge requires an
   * `X-Cookie-Bridge-Token: <token>` header on /cookies (GET and POST), so other
   * local processes that can reach the port but can't read this config cannot
   * read or inject cookies. The extension must be configured with the same token.
   */
  bridgeToken?: string;
  /**
   * Whether to persist cookies to ~/.config/mcp-cookie-bridge/cookies.json.
   * Defaults to true. Set false for memory-only (no session tokens at rest).
   */
  persist?: boolean;
  /**
   * Allowlist of permitted cookieUrl host suffixes (e.g. ["banno-staging.com"]).
   * When set, the server refuses to start if cookieUrl's host doesn't match one —
   * a guard against pointing the tool at production.
   */
  allowedHosts?: string[];
}

/** True if `host` equals or is a subdomain of one of the allowed suffixes. */
function hostAllowed(host: string, allowed?: string[]): boolean {
  if (!allowed || !allowed.length) return true; // no allowlist configured
  return allowed.some((suffix) => host === suffix || host.endsWith("." + suffix));
}

const CONFIG_SEARCH_PATHS = [
  // Explicit env var
  process.env.MCP_COOKIE_BRIDGE_CONFIG,
  // Next to the running script (mcp-server/dist/)
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config.json"),
  // Repo root (one level above mcp-server/)
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "config.json"),
  // XDG config
  path.join(os.homedir(), ".config", "mcp-cookie-bridge", "config.json"),
].filter(Boolean) as string[];

function loadConfig(): Config {
  for (const p of CONFIG_SEARCH_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        const cfg = JSON.parse(raw) as Config;
        console.error(`Loaded config from ${p}`);
        return cfg;
      }
    } catch {
      // Try next path
    }
  }

  console.error(
    "No config.json found. Searched:\n" +
      CONFIG_SEARCH_PATHS.map((p) => `  - ${p}`).join("\n") +
      "\nCopy config.example.json to one of these locations."
  );
  process.exit(1);
}

const config = loadConfig();

// H5 — prod guard: refuse to run against a host outside the allowlist.
try {
  const cookieHost = new URL(config.cookieUrl).hostname;
  if (!hostAllowed(cookieHost, config.allowedHosts)) {
    console.error(
      `Refusing to start: cookieUrl host "${cookieHost}" is not in allowedHosts [${(config.allowedHosts || []).join(", ")}]. ` +
        `Update allowedHosts or cookieUrl.`
    );
    process.exit(1);
  }
} catch {
  console.error(`Invalid cookieUrl: ${config.cookieUrl}`);
  process.exit(1);
}

const BRIDGE_PORT = config.bridgePort || 18443;
const STALE_SECONDS = config.staleAfterSeconds ?? 600;
const BRIDGE_TOKEN = config.bridgeToken || null; // H3 — shared secret (optional)
const PERSIST = config.persist !== false; // H4 — default true

if (!BRIDGE_TOKEN) {
  console.error(
    "Warning: no bridgeToken configured — any local process that can reach the bridge port can read cookies. Set bridgeToken to require an auth header."
  );
}

const COOKIE_FILE = path.join(
  os.homedir(),
  ".config",
  "mcp-cookie-bridge",
  "cookies.json"
);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CookieEntry {
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  expirationDate: number | null;
}

interface CookiePayload {
  cookies: Record<string, CookieEntry | null>;
  allPresent: boolean;
  /** True when all required cookies are present (bootstrap cookies may be absent). */
  requiredPresent?: boolean;
  timestamp: string;
  cookieUrl?: string;
  bridgeStatus?: { ok: boolean; error?: string };
}

// Cookies that must be present for a healthy session (defaults to all).
const REQUIRED_COOKIES =
  config.requiredCookies && config.requiredCookies.length
    ? config.requiredCookies
    : config.cookies;
// Short-lived cookies primed on demand; their absence is not an error.
const BOOTSTRAP_COOKIES = config.bootstrapCookies ?? [];

let currentPayload: CookiePayload | null = null;

// When the bridge port is already taken by a sibling instance, this process
// runs in "client mode": it does not bind the HTTP port (the sibling owns
// extension pushes), but it still serves the MCP stdio interface by proxying
// each query to the sibling daemon over HTTP. This keeps MCP tools registered
// across every concurrent client (opencode, Claude Code, ad-hoc CLI), instead
// of having the second-to-start MCP exit and leave its client toolless.
let clientMode = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureConfigDir() {
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Enforce owner-only on the dir even if it pre-existed with looser perms.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function saveToDisk(payload: CookiePayload) {
  if (!PERSIST) return; // H4 — memory-only mode
  try {
    ensureConfigDir();
    // The file holds live session tokens (incl. httpOnly). Write owner-only and
    // re-chmod in case it pre-existed world-readable.
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(COOKIE_FILE, 0o600);
  } catch (err) {
    console.error(`Failed to write ${COOKIE_FILE}:`, err);
  }
}

function loadFromDisk(): CookiePayload | null {
  if (!PERSIST) return null; // H4 — memory-only mode
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const raw = fs.readFileSync(COOKIE_FILE, "utf-8");
      return JSON.parse(raw) as CookiePayload;
    }
  } catch (err) {
    console.error(`Failed to read ${COOKIE_FILE}:`, err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP Bridge Server — receives POST /cookies from the Chrome extension
// ---------------------------------------------------------------------------

function startBridge(): Promise<http.Server | null> {
  const server = http.createServer((req, res) => {
    // CORS is granted ONLY for the extension's cross-origin write (POST) and its
    // preflight. It is deliberately NOT sent on the secret-returning GET /cookies
    // — Node/curl clients don't need CORS, and withholding it stops a malicious
    // web page from reading the tokens cross-origin via fetch().
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }

    // H3 — require the shared token on the secret /cookies routes when set.
    if (BRIDGE_TOKEN && req.url === "/cookies") {
      if (req.headers["x-cookie-bridge-token"] !== BRIDGE_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
    }

    if (req.method === "POST" && req.url === "/cookies") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          currentPayload = JSON.parse(body) as CookiePayload;
          saveToDisk(currentPayload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/cookies") {
      const payload = currentPayload || loadFromDisk();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload || { error: "No cookies available" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          hasCookies: currentPayload?.allPresent ?? false,
          timestamp: currentPayload?.timestamp ?? null,
        })
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.once("listening", () => {
      console.error(`Cookie bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
      resolve(server);
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another instance owns the port and is the one receiving extension
        // pushes. Don't bind, don't serve stale in-memory cookies — enter
        // client mode and proxy reads to the surviving daemon over HTTP.
        // The MCP stdio interface stays alive so this client's tools register.
        clientMode = true;
        console.error(
          `Port ${BRIDGE_PORT} already in use — entering client mode (proxying reads to the surviving daemon).`
        );
        resolve(null);
      } else {
        console.error("Bridge server error:", err);
        process.exit(1);
      }
    });

    server.listen(BRIDGE_PORT, "127.0.0.1");
  });
}

async function fetchPayloadFromDaemon(): Promise<CookiePayload | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/cookies`, {
      headers: BRIDGE_TOKEN ? { "X-Cookie-Bridge-Token": BRIDGE_TOKEN } : {},
    });
    if (!res.ok) return null;
    const json = (await res.json()) as CookiePayload | { error: string };
    if ("error" in json) return null;
    return json;
  } catch (err) {
    console.error("client-mode fetch failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getPayload(): Promise<CookiePayload | null> {
  if (clientMode) {
    // The sibling daemon is the source of truth in client mode. Always fetch
    // fresh — never cache locally, otherwise we re-create the zombie problem.
    return fetchPayloadFromDaemon();
  }
  if (currentPayload) return currentPayload;
  currentPayload = loadFromDisk();
  return currentPayload;
}

function freshness(payload: CookiePayload): {
  ageSeconds: number;
  fresh: boolean;
  staleWarning: string | null;
} {
  const age = (Date.now() - new Date(payload.timestamp).getTime()) / 1000;
  const fresh = age < STALE_SECONDS;
  return {
    ageSeconds: Math.round(age),
    fresh,
    staleWarning: fresh
      ? null
      : `Cookies are ${Math.round(age / 60)} minutes old (stale threshold: ${Math.round(STALE_SECONDS / 60)} min). Click the extension to refresh or re-login.`,
  };
}

function noDataResponse() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: "No cookies available",
            hint: "Make sure the MCP Cookie Bridge Chrome extension is installed, config.json is set up, and you are logged into your dev server.",
          },
          null,
          2
        ),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new McpServer({
  name: "mcp-cookie-bridge",
  version: "1.0.0",
});

// --- Tool: get_cookies -------------------------------------------------------

mcp.tool(
  "get_cookies",
  `Get the current dev server cookies captured by the Chrome extension. Returns cookie objects with values, freshness info, and warnings. Configured cookies: ${config.cookies.join(", ")}`,
  {},
  async () => {
    const payload = await getPayload();
    if (!payload) return noDataResponse();

    const { ageSeconds, fresh, staleWarning } = freshness(payload);

    const result = {
      cookies: payload.cookies,
      allPresent: payload.allPresent,
      timestamp: payload.timestamp,
      ageSeconds,
      fresh,
      ...(staleWarning ? { warning: staleWarning } : {}),
      missingCookies: config.cookies.filter((name) => !payload.cookies[name]),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- Tool: get_cookie_header -------------------------------------------------

mcp.tool(
  "get_cookie_header",
  "Get a ready-to-use Cookie header string for HTTP requests. Returns the header value in `name=value; name=value` format, suitable for curl or fetch calls.",
  {},
  async () => {
    const payload = await getPayload();
    if (!payload) return noDataResponse();

    const { ageSeconds, fresh, staleWarning } = freshness(payload);

    const pairs = config.cookies
      .filter((name) => payload.cookies[name])
      .map((name) => `${name}=${payload.cookies[name]!.value}`);

    const result: Record<string, unknown> = {
      cookieHeader: pairs.join("; "),
      ageSeconds,
      fresh,
    };
    if (staleWarning) result.warning = staleWarning;
    if (!payload.allPresent) {
      result.missingCookies = config.cookies.filter((name) => !payload.cookies[name]);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- Tool: get_playwright_cookies --------------------------------------------

mcp.tool(
  "get_playwright_cookies",
  "Get cookies formatted for Playwright's context.addCookies() call. Returns an array of cookie objects ready to pass directly to Playwright for browser automation.",
  {
    port: z
      .number()
      .min(1)
      .max(65535)
      .optional()
      .describe(
        "Target port for the Playwright targetUrl. Cookies are domain-scoped and work across ports. Defaults to config.targetPort (8443)."
      ),
  },
  async ({ port }) => {
    const payload = await getPayload();
    if (!payload) return noDataResponse();

    const { ageSeconds, fresh, staleWarning } = freshness(payload);
    // Cookies are harvested from the source host (config.cookieUrl) but applied
    // to the local dev target. Re-target every cookie to config.targetDomain and
    // normalise the path to "/" so a source cookie scoped to e.g. "/a/" still
    // applies site-wide on localhost and other dev servers/containers.
    const targetDomain = config.targetDomain || "localhost";
    const targetPort = port || config.targetPort || 8443;

    const playwrightCookies = config.cookies
      .filter((name) => payload.cookies[name])
      .map((name) => {
        const c = payload.cookies[name]!;
        return {
          name,
          value: c.value,
          domain: targetDomain,
          path: "/",
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: (
            c.sameSite === "strict" ? "Strict" :
            c.sameSite === "lax" ? "Lax" : "None"
          ),
        };
      });

    const missingRequired = REQUIRED_COOKIES.filter((name) => !payload.cookies[name]);
    const missingBootstrap = BOOTSTRAP_COOKIES.filter((name) => !payload.cookies[name]);

    const result: Record<string, unknown> = {
      cookies: playwrightCookies,
      usage: `await context.addCookies(${JSON.stringify(playwrightCookies)})`,
      targetUrl: `https://${targetDomain}:${targetPort}`,
      ageSeconds,
      fresh,
    };
    if (staleWarning) result.warning = staleWarning;
    if (missingRequired.length) result.missingRequired = missingRequired;
    if (missingBootstrap.length) {
      // Bootstrap cookies must be present at instantiation but expire on their
      // own — tell the caller to prime rather than treating this as broken.
      result.missingBootstrap = missingBootstrap;
      result.primeHint = `Bootstrap cookie(s) ${missingBootstrap.join(", ")} are not present. They are only re-minted by logging in again — click "Prime session" in the MCP Cookie Bridge extension (it clears the session cookies and reloads the ${new URL(config.cookieUrl).hostname} tab so you can log in), complete login, then call this tool again before creating the Playwright context.`;
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- Tool: get_cookie_status -------------------------------------------------

mcp.tool(
  "get_cookie_status",
  "Check the health and freshness of the cookie bridge. Reports which cookies are present/missing, how old they are, and whether the Chrome extension is pushing updates.",
  {},
  async () => {
    const payload = await getPayload();

    if (!payload) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "no_data",
              configuredCookies: config.cookies,
              cookieUrl: config.cookieUrl,
              hint: "No cookies have been received yet. Ensure the Chrome extension is installed and your dev server has an active session.",
            }, null, 2),
          },
        ],
      };
    }

    const { ageSeconds, fresh, staleWarning } = freshness(payload);

    const missingRequired = REQUIRED_COOKIES.filter((name) => !payload.cookies[name]);
    const missingBootstrap = BOOTSTRAP_COOKIES.filter((name) => !payload.cookies[name]);
    const requiredPresent = missingRequired.length === 0;

    const status = {
      // Health is driven by REQUIRED cookies. Bootstrap cookies expire on their
      // own and are primed on demand, so their absence is not "degraded".
      status: requiredPresent && fresh ? "healthy" : "degraded",
      requiredPresent,
      presentCookies: config.cookies.filter((name) => payload.cookies[name]),
      missingRequired,
      missingBootstrap,
      timestamp: payload.timestamp,
      ageSeconds,
      fresh,
      cookieUrl: config.cookieUrl,
      ...(staleWarning ? { warning: staleWarning } : {}),
      ...(missingBootstrap.length
        ? {
            primeHint: `Bootstrap cookie(s) ${missingBootstrap.join(", ")} absent (normal — they expire). To get one, click "Prime session" in the extension (clears the session cookies and reloads so you can log in again), then complete login.`,
          }
        : {}),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  // Load any persisted cookies from disk (used only in server mode; client
  // mode always proxies to the daemon and ignores local cache).
  currentPayload = loadFromDisk();

  // Try to start the HTTP bridge for the Chrome extension. If the port is
  // already taken, startBridge() flips us to client mode and returns null.
  await startBridge();

  // Start the MCP stdio server
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(
    `mcp-cookie-bridge MCP server running on stdio (${clientMode ? "client" : "server"} mode)`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
