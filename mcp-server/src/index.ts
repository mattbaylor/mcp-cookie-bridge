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
  bridgePort: number;
  refreshIntervalMinutes: number;
  cookies: string[];
  /** Staleness threshold in seconds. Defaults to 600 (10 min). */
  staleAfterSeconds?: number;
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
const BRIDGE_PORT = config.bridgePort || 18443;
const STALE_SECONDS = config.staleAfterSeconds ?? 600;

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
  timestamp: string;
  cookieUrl?: string;
  bridgeStatus?: { ok: boolean; error?: string };
}

let currentPayload: CookiePayload | null = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureConfigDir() {
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveToDisk(payload: CookiePayload) {
  try {
    ensureConfigDir();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to write ${COOKIE_FILE}:`, err);
  }
}

function loadFromDisk(): CookiePayload | null {
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

function startBridge() {
  const server = http.createServer((req, res) => {
    // CORS for Chrome extension
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/cookies") {
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

  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    console.error(`Cookie bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${BRIDGE_PORT} already in use — another instance running?`
      );
    } else {
      console.error("Bridge server error:", err);
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPayload(): CookiePayload | null {
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
    const payload = getPayload();
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
    const payload = getPayload();
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
        "Target port for the cookies. Cookies are typically domain-scoped and work across ports. Defaults to the port from the configured cookie URL."
      ),
  },
  async ({ port }) => {
    const payload = getPayload();
    if (!payload) return noDataResponse();

    const { ageSeconds, fresh, staleWarning } = freshness(payload);
    const targetPort = port || new URL(config.cookieUrl).port || "443";

    const playwrightCookies = config.cookies
      .filter((name) => payload.cookies[name])
      .map((name) => {
        const c = payload.cookies[name]!;
        return {
          name,
          value: c.value,
          domain: "localhost",
          path: c.path,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: (
            c.sameSite === "strict" ? "Strict" :
            c.sameSite === "lax" ? "Lax" : "None"
          ),
        };
      });

    const result: Record<string, unknown> = {
      cookies: playwrightCookies,
      usage: `await context.addCookies(${JSON.stringify(playwrightCookies)})`,
      targetUrl: `https://localhost:${targetPort}`,
      ageSeconds,
      fresh,
    };
    if (staleWarning) result.warning = staleWarning;

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
    const payload = getPayload();

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

    const status = {
      status: payload.allPresent && fresh ? "healthy" : "degraded",
      allPresent: payload.allPresent,
      presentCookies: config.cookies.filter((name) => payload.cookies[name]),
      missingCookies: config.cookies.filter((name) => !payload.cookies[name]),
      timestamp: payload.timestamp,
      ageSeconds,
      fresh,
      cookieUrl: config.cookieUrl,
      ...(staleWarning ? { warning: staleWarning } : {}),
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
  // Load any persisted cookies from disk
  currentPayload = loadFromDisk();

  // Start the HTTP bridge for the Chrome extension
  startBridge();

  // Start the MCP stdio server
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("mcp-cookie-bridge MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
