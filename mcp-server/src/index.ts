#!/usr/bin/env node

// MCP Cookie Bridge — MCP Server
//
// Two responsibilities:
//   1. HTTP server on a configurable port — receives cookie pushes from the
//      Chrome extension and hosts a small "prime request" queue.
//   2. MCP stdio server — exposes tools for AI agents to read/use cookies.
//
// The bridge is PROFILE-based: it can track many independent host+cookie combos
// (different apps and/or environments) at once. Each profile harvests from its
// own source host and re-targets to its own local dev target. The agent selects
// a profile per call by key or by URL. Cookie data is held in memory and
// persisted to a JSON file as a fallback. All names, URLs, and ports are
// config-driven — nothing is hardcoded.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** A single host+cookie combo. */
interface Profile {
  cookieUrl: string;
  /** Preferred Prime target: a real logout URL (extension-only). */
  logoutUrl?: string;
  /** Fallback Prime target when logoutUrl is unset (extension-only). */
  loginUrl?: string;
  cookies: string[];
  requiredCookies?: string[];
  bootstrapCookies?: string[];
  primeClearCookies?: string[];
  /** Domain captured cookies are re-targeted to for Playwright. Default "localhost". */
  targetDomain?: string;
  /** Port used to build the Playwright targetUrl. Default 8443. */
  targetPort?: number;
  /** Allowlist of permitted cookieUrl host suffixes for this profile. */
  allowedHosts?: string[];
  /** When true, this profile is gated behind the global allowProduction opt-in. */
  production?: boolean;
}

interface Config {
  // Bridge-level (shared)
  bridgePort?: number;
  bridgeToken?: string;
  persist?: boolean;
  refreshIntervalMinutes?: number;
  staleAfterSeconds?: number;
  /** Global opt-in required before any profile marked production will run. */
  allowProduction?: boolean;
  /** Profile used when a tool call omits both profile and url. */
  defaultProfile?: string;
  /** Canonical shape: named host+cookie combos. */
  profiles?: Record<string, Profile>;

  // --- Back-compat: legacy "environments" shape (one app × envs) ---
  environments?: Record<
    string,
    { cookieUrl: string; loginUrl?: string; logoutUrl?: string; allowedHosts?: string[] }
  >;
  activeEnv?: string;

  // --- Back-compat: legacy flat shape (single host) ---
  cookieUrl?: string;
  loginUrl?: string;
  logoutUrl?: string;
  cookies?: string[];
  requiredCookies?: string[];
  bootstrapCookies?: string[];
  primeClearCookies?: string[];
  targetDomain?: string;
  targetPort?: number;
  allowedHosts?: string[];
}

/** A profile with all defaults resolved and its block status computed. */
interface ResolvedProfile {
  key: string;
  cookieUrl: string;
  host: string;
  loginUrl?: string;
  logoutUrl?: string;
  cookies: string[];
  requiredCookies: string[];
  bootstrapCookies: string[];
  primeClearCookies: string[];
  targetDomain: string;
  targetPort: number;
  allowedHosts?: string[];
  production: boolean;
  blocked: boolean;
  blockedReason?: string;
}

// ---------------------------------------------------------------------------
// Config loading + normalisation
// ---------------------------------------------------------------------------

const CONFIG_SEARCH_PATHS = [
  process.env.MCP_COOKIE_BRIDGE_CONFIG,
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config.json"),
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "config.json"),
  path.join(os.homedir(), ".config", "mcp-cookie-bridge", "config.json"),
].filter(Boolean) as string[];

function loadRawConfig(): Config {
  for (const p of CONFIG_SEARCH_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as Config;
        console.error(`Loaded config from ${p}`);
        return cfg;
      }
    } catch {
      // try next
    }
  }
  console.error(
    "No config.json found. Searched:\n" +
      CONFIG_SEARCH_PATHS.map((p) => `  - ${p}`).join("\n") +
      "\nCopy config.example.json to one of these locations."
  );
  process.exit(1);
}

/** True if `host` equals or is a subdomain of one of the allowed suffixes. */
function hostAllowed(host: string, allowed?: string[]): boolean {
  if (!allowed || !allowed.length) return true;
  return allowed.some((s) => host === s || host.endsWith("." + s));
}

interface NormalizedConfig {
  bridgePort: number;
  bridgeToken: string | null;
  persist: boolean;
  refreshIntervalMinutes: number;
  staleAfterSeconds: number;
  allowProduction: boolean;
  defaultProfile: string | null;
  profiles: Record<string, ResolvedProfile>;
}

/** Build a canonical, fully-resolved config from any supported shape. */
function normalizeConfig(raw: Config): NormalizedConfig {
  const allowProduction = raw.allowProduction === true;

  // 1) Gather raw profiles from whichever shape the config uses.
  let rawProfiles: Record<string, Profile> = {};
  let defaultProfile: string | null = raw.defaultProfile ?? null;

  if (raw.profiles && Object.keys(raw.profiles).length) {
    rawProfiles = raw.profiles;
  } else if (raw.environments && Object.keys(raw.environments).length) {
    // Legacy env shape → one profile per env, sharing the top-level cookie lists.
    for (const [name, env] of Object.entries(raw.environments)) {
      rawProfiles[name] = {
        cookieUrl: env.cookieUrl,
        loginUrl: env.loginUrl,
        logoutUrl: env.logoutUrl,
        allowedHosts: env.allowedHosts,
        cookies: raw.cookies ?? [],
        requiredCookies: raw.requiredCookies,
        bootstrapCookies: raw.bootstrapCookies,
        primeClearCookies: raw.primeClearCookies,
        targetDomain: raw.targetDomain,
        targetPort: raw.targetPort,
        production: name.toLowerCase() === "production",
      };
    }
    if (!defaultProfile) defaultProfile = raw.activeEnv ?? "staging";
  } else if (raw.cookieUrl) {
    // Legacy flat shape → a single "default" profile.
    rawProfiles.default = {
      cookieUrl: raw.cookieUrl,
      loginUrl: raw.loginUrl,
      logoutUrl: raw.logoutUrl,
      allowedHosts: raw.allowedHosts,
      cookies: raw.cookies ?? [],
      requiredCookies: raw.requiredCookies,
      bootstrapCookies: raw.bootstrapCookies,
      primeClearCookies: raw.primeClearCookies,
      targetDomain: raw.targetDomain,
      targetPort: raw.targetPort,
    };
    if (!defaultProfile) defaultProfile = "default";
  }

  const keys = Object.keys(rawProfiles);
  if (!keys.length) {
    console.error(
      "Config has no profiles. Define a `profiles` map (see config.example.json)."
    );
    process.exit(1);
  }
  // If exactly one profile and no default set, it's the default.
  if (!defaultProfile && keys.length === 1) defaultProfile = keys[0];
  if (defaultProfile && !rawProfiles[defaultProfile]) {
    console.error(
      `defaultProfile "${defaultProfile}" is not among profiles [${keys.join(", ")}].`
    );
    process.exit(1);
  }

  // 2) Resolve defaults + compute block status per profile.
  const profiles: Record<string, ResolvedProfile> = {};
  for (const [key, p] of Object.entries(rawProfiles)) {
    let host = "";
    let invalidUrl = false;
    try {
      host = new URL(p.cookieUrl).hostname;
    } catch {
      invalidUrl = true;
    }

    const production = p.production === true;
    let blocked = false;
    let blockedReason: string | undefined;

    if (invalidUrl) {
      blocked = true;
      blockedReason = `Invalid cookieUrl: ${p.cookieUrl}`;
    } else if (production && !allowProduction) {
      blocked = true;
      blockedReason =
        'Production profile is gated. Set "allowProduction": true in config.json to enable it.';
    } else if (!hostAllowed(host, p.allowedHosts)) {
      blocked = true;
      blockedReason = `cookieUrl host "${host}" is not in this profile's allowedHosts [${(
        p.allowedHosts || []
      ).join(", ")}].`;
    }

    profiles[key] = {
      key,
      cookieUrl: p.cookieUrl,
      host,
      loginUrl: p.loginUrl,
      logoutUrl: p.logoutUrl,
      cookies: p.cookies ?? [],
      requiredCookies:
        p.requiredCookies && p.requiredCookies.length ? p.requiredCookies : p.cookies ?? [],
      bootstrapCookies: p.bootstrapCookies ?? [],
      primeClearCookies:
        p.primeClearCookies && p.primeClearCookies.length ? p.primeClearCookies : p.cookies ?? [],
      targetDomain: p.targetDomain || "localhost",
      targetPort: p.targetPort || 8443,
      allowedHosts: p.allowedHosts,
      production,
      blocked,
      blockedReason,
    };
  }

  return {
    bridgePort: raw.bridgePort || 18443,
    bridgeToken: raw.bridgeToken || null,
    persist: raw.persist !== false,
    refreshIntervalMinutes: raw.refreshIntervalMinutes || 2,
    staleAfterSeconds: raw.staleAfterSeconds ?? 600,
    allowProduction,
    defaultProfile,
    profiles,
  };
}

const CONFIG = normalizeConfig(loadRawConfig());

const BRIDGE_PORT = CONFIG.bridgePort;
const STALE_SECONDS = CONFIG.staleAfterSeconds;
const BRIDGE_TOKEN = CONFIG.bridgeToken;
const PERSIST = CONFIG.persist;

console.error(
  `Profiles: ${Object.values(CONFIG.profiles)
    .map((p) => `${p.key}${p.key === CONFIG.defaultProfile ? "*" : ""}${p.blocked ? " (blocked)" : ""}`)
    .join(", ")}`
);
if (!BRIDGE_TOKEN) {
  console.error(
    "Warning: no bridgeToken configured — any local process that can reach the bridge port can read cookies. Set bridgeToken to require an auth header."
  );
}

const COOKIE_FILE = path.join(os.homedir(), ".config", "mcp-cookie-bridge", "cookies.json");

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
  requiredPresent?: boolean;
  timestamp: string;
  cookieUrl?: string;
  profile?: string;
  bridgeStatus?: { ok: boolean; error?: string };
}

/** Persisted/exchanged shape: cookies keyed by profile. */
interface PersistedState {
  profiles: Record<string, CookiePayload>;
}

let payloadsByProfile: Record<string, CookiePayload> = {};

/** Agent-requested primes awaiting the extension. profile key → ISO timestamp. */
let pendingPrimes: Record<string, string> = {};

// When the bridge port is already taken by a sibling instance, this process runs
// in "client mode": it proxies reads/writes to the surviving daemon over HTTP so
// its MCP tools stay registered.
let clientMode = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureConfigDir() {
  const dir = path.dirname(COOKIE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function saveToDisk() {
  if (!PERSIST) return;
  try {
    ensureConfigDir();
    const state: PersistedState = { profiles: payloadsByProfile };
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(state, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(COOKIE_FILE, 0o600);
  } catch (err) {
    console.error(`Failed to write ${COOKIE_FILE}:`, err);
  }
}

function loadFromDisk(): Record<string, CookiePayload> {
  if (!PERSIST) return {};
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
      if (raw && typeof raw === "object" && raw.profiles) {
        return raw.profiles as Record<string, CookiePayload>;
      }
      // Back-compat: a single legacy payload → file it under the default profile.
      if (raw && typeof raw === "object" && raw.cookies) {
        const key = (raw as CookiePayload).profile || CONFIG.defaultProfile || "default";
        return { [key]: raw as CookiePayload };
      }
    }
  } catch (err) {
    console.error(`Failed to read ${COOKIE_FILE}:`, err);
  }
  return {};
}

// ---------------------------------------------------------------------------
// HTTP bridge — cookie pushes from the extension + the prime-request queue
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function tokenOk(req: http.IncomingMessage): boolean {
  if (!BRIDGE_TOKEN) return true;
  return req.headers["x-cookie-bridge-token"] === BRIDGE_TOKEN;
}

function startBridge(): Promise<http.Server | null> {
  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    const pathname = url.split("?")[0];

    // CORS preflight for the extension's cross-origin writes.
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Cookie-Bridge-Token");
      res.writeHead(204);
      res.end();
      return;
    }

    // Token-guard the secret routes.
    if ((pathname === "/cookies" || pathname === "/prime" || pathname === "/prime/clear") && !tokenOk(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    // --- Cookie push: replace the whole profile map (or a single legacy payload).
    if (req.method === "POST" && pathname === "/cookies") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const parsed = JSON.parse(await readBody(req));
        if (parsed && parsed.profiles) {
          payloadsByProfile = parsed.profiles;
        } else if (parsed && parsed.cookies) {
          const key = parsed.profile || CONFIG.defaultProfile || "default";
          payloadsByProfile[key] = parsed;
        } else {
          throw new Error("unrecognised body");
        }
        saveToDisk();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
      return;
    }

    // --- Read cookies. Whole map, or ?profile=key for one.
    if (req.method === "GET" && pathname === "/cookies") {
      const q = new URLSearchParams(url.split("?")[1] || "");
      const profile = q.get("profile");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (profile) {
        res.end(JSON.stringify(payloadsByProfile[profile] || { error: "No cookies for profile" }));
      } else {
        res.end(JSON.stringify({ profiles: payloadsByProfile }));
      }
      return;
    }

    // --- Prime queue: the MCP requests a prime; the extension drains it.
    if (req.method === "POST" && pathname === "/prime") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const { profile } = JSON.parse(await readBody(req));
        if (!profile) throw new Error("no profile");
        pendingPrimes[profile] = new Date().toISOString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
      return;
    }
    if (req.method === "GET" && pathname === "/prime") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: pendingPrimes }));
      return;
    }
    if (req.method === "POST" && pathname === "/prime/clear") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const { profile } = JSON.parse(await readBody(req));
        if (profile) delete pendingPrimes[profile];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          profiles: Object.keys(payloadsByProfile),
          pendingPrimes: Object.keys(pendingPrimes),
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
        clientMode = true;
        console.error(
          `Port ${BRIDGE_PORT} already in use — entering client mode (proxying to the surviving daemon).`
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

// ---------------------------------------------------------------------------
// Client-mode proxying
// ---------------------------------------------------------------------------

async function daemonGetProfiles(): Promise<Record<string, CookiePayload>> {
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/cookies`, {
      headers: BRIDGE_TOKEN ? { "X-Cookie-Bridge-Token": BRIDGE_TOKEN } : {},
    });
    if (!res.ok) return {};
    const json = (await res.json()) as PersistedState | { error: string };
    if ("profiles" in json) return json.profiles;
    return {};
  } catch (err) {
    console.error("client-mode fetch failed:", err);
    return {};
  }
}

async function daemonPostPrime(profile: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/prime`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BRIDGE_TOKEN ? { "X-Cookie-Bridge-Token": BRIDGE_TOKEN } : {}),
      },
      body: JSON.stringify({ profile }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getProfilePayload(key: string): Promise<CookiePayload | null> {
  if (clientMode) {
    const profiles = await daemonGetProfiles();
    return profiles[key] || null;
  }
  return payloadsByProfile[key] || null;
}

function freshness(payload: CookiePayload) {
  const age = (Date.now() - new Date(payload.timestamp).getTime()) / 1000;
  const fresh = age < STALE_SECONDS;
  return {
    ageSeconds: Math.round(age),
    fresh,
    staleWarning: fresh
      ? null
      : `Cookies are ${Math.round(age / 60)} minutes old (stale threshold: ${Math.round(
          STALE_SECONDS / 60
        )} min). Refresh the extension or re-login.`,
  };
}

interface ResolveError {
  error: string;
  available?: string[];
}

/**
 * Resolve which profile a tool call refers to. Accepts an exact `profile` key or
 * a `url`/host (matched against each profile's host or allowedHosts). Falls back
 * to defaultProfile, or the only profile. Enforces the production/host block.
 */
function resolveProfile(sel: { profile?: string; url?: string }): ResolvedProfile | ResolveError {
  const keys = Object.keys(CONFIG.profiles);
  let rp: ResolvedProfile | undefined;

  if (sel.profile) {
    rp = CONFIG.profiles[sel.profile];
    if (!rp) return { error: `Unknown profile "${sel.profile}".`, available: keys };
  } else if (sel.url) {
    let host: string;
    try {
      host = new URL(sel.url).hostname;
    } catch {
      host = sel.url.replace(/^https?:\/\//, "").split("/")[0];
    }
    rp = Object.values(CONFIG.profiles).find(
      (p) =>
        p.host === host ||
        host.endsWith("." + p.host) ||
        p.host.endsWith("." + host) ||
        hostAllowed(host, p.allowedHosts)
    );
    if (!rp)
      return {
        error: `No profile matches host "${host}". Use list_profiles to see configured profiles.`,
        available: keys,
      };
  } else if (CONFIG.defaultProfile) {
    rp = CONFIG.profiles[CONFIG.defaultProfile];
  } else if (keys.length === 1) {
    rp = CONFIG.profiles[keys[0]];
  } else {
    return {
      error: "Multiple profiles configured — specify `profile` or `url`.",
      available: keys,
    };
  }

  if (rp.blocked) {
    return { error: `Profile "${rp.key}" is blocked: ${rp.blockedReason}`, available: keys };
  }
  return rp;
}

function isResolveError(x: ResolvedProfile | ResolveError): x is ResolveError {
  return (x as ResolveError).error !== undefined;
}

function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function noDataResult(rp: ResolvedProfile) {
  return jsonResult({
    error: "No cookies available",
    profile: rp.key,
    cookieUrl: rp.cookieUrl,
    hint: `No cookies received for "${rp.key}" yet. Ensure the Chrome extension is installed, this profile is configured, and you are logged into ${rp.host}.`,
  });
}

function computeProfileStatus(rp: ResolvedProfile, payload: CookiePayload | null) {
  if (!payload) {
    return {
      hasData: false,
      requiredPresent: false,
      presentCookies: [] as string[],
      missingRequired: rp.requiredCookies,
      missingBootstrap: rp.bootstrapCookies,
    };
  }
  const present = rp.cookies.filter((n) => payload.cookies[n]);
  const missingRequired = rp.requiredCookies.filter((n) => !payload.cookies[n]);
  const missingBootstrap = rp.bootstrapCookies.filter((n) => !payload.cookies[n]);
  return {
    hasData: true,
    requiredPresent: missingRequired.length === 0,
    presentCookies: present,
    missingRequired,
    missingBootstrap,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new McpServer({ name: "mcp-cookie-bridge", version: "2.0.0" });

const selectorSchema = {
  profile: z
    .string()
    .optional()
    .describe("Exact profile key (see list_profiles). Omit to use url, or the default profile."),
  url: z
    .string()
    .optional()
    .describe(
      "The URL/host you are targeting; the matching profile is resolved by host. Handy when you know the URL but not the profile key."
    ),
};

// --- Tool: list_profiles -----------------------------------------------------

mcp.tool(
  "list_profiles",
  "List the configured cookie profiles (host+cookie combos) and their live status. Use this to discover which profile to pass to the other tools. Each profile can be selected by its `profile` key or by a `url` whose host matches it.",
  {},
  async () => {
    const out = [];
    for (const rp of Object.values(CONFIG.profiles)) {
      const payload = rp.blocked ? null : await getProfilePayload(rp.key);
      const st = computeProfileStatus(rp, payload);
      const fresh = payload ? freshness(payload) : null;
      out.push({
        profile: rp.key,
        isDefault: rp.key === CONFIG.defaultProfile,
        cookieUrl: rp.cookieUrl,
        host: rp.host,
        target: `https://${rp.targetDomain}:${rp.targetPort}`,
        production: rp.production,
        blocked: rp.blocked,
        ...(rp.blockedReason ? { blockedReason: rp.blockedReason } : {}),
        cookies: rp.cookies,
        requiredCookies: rp.requiredCookies,
        bootstrapCookies: rp.bootstrapCookies,
        hasData: st.hasData,
        healthy: st.hasData && st.requiredPresent && (fresh?.fresh ?? false),
        missingRequired: st.missingRequired,
        missingBootstrap: st.missingBootstrap,
        ...(fresh ? { ageSeconds: fresh.ageSeconds, fresh: fresh.fresh } : {}),
      });
    }
    return jsonResult({ defaultProfile: CONFIG.defaultProfile, profiles: out });
  }
);

// --- Tool: get_cookies -------------------------------------------------------

mcp.tool(
  "get_cookies",
  "Get the current cookies for a profile (host+cookie combo) captured by the Chrome extension. Select the profile by `profile` key or `url`. Use list_profiles to see options.",
  selectorSchema,
  async (sel) => {
    const rp = resolveProfile(sel);
    if (isResolveError(rp)) return jsonResult(rp);
    const payload = await getProfilePayload(rp.key);
    if (!payload) return noDataResult(rp);

    const { ageSeconds, fresh, staleWarning } = freshness(payload);
    return jsonResult({
      profile: rp.key,
      cookies: payload.cookies,
      allPresent: payload.allPresent,
      timestamp: payload.timestamp,
      ageSeconds,
      fresh,
      ...(staleWarning ? { warning: staleWarning } : {}),
      missingCookies: rp.cookies.filter((n) => !payload.cookies[n]),
    });
  }
);

// --- Tool: get_cookie_header -------------------------------------------------

mcp.tool(
  "get_cookie_header",
  "Get a ready-to-use Cookie header string for HTTP requests, for a given profile. Returns `name=value; name=value`, suitable for curl or fetch. Select by `profile` key or `url`.",
  selectorSchema,
  async (sel) => {
    const rp = resolveProfile(sel);
    if (isResolveError(rp)) return jsonResult(rp);
    const payload = await getProfilePayload(rp.key);
    if (!payload) return noDataResult(rp);

    const { ageSeconds, fresh, staleWarning } = freshness(payload);
    const pairs = rp.cookies
      .filter((n) => payload.cookies[n])
      .map((n) => `${n}=${payload.cookies[n]!.value}`);

    const result: Record<string, unknown> = {
      profile: rp.key,
      cookieHeader: pairs.join("; "),
      ageSeconds,
      fresh,
    };
    if (staleWarning) result.warning = staleWarning;
    const missing = rp.cookies.filter((n) => !payload.cookies[n]);
    if (missing.length) result.missingCookies = missing;
    return jsonResult(result);
  }
);

// --- Tool: get_playwright_cookies --------------------------------------------

mcp.tool(
  "get_playwright_cookies",
  "Get cookies formatted for Playwright's context.addCookies(), for a given profile. Returns the array plus the profile's local targetUrl. Select by `profile` key or `url`.",
  {
    ...selectorSchema,
    port: z
      .number()
      .min(1)
      .max(65535)
      .optional()
      .describe("Override the target port for the returned targetUrl. Defaults to the profile's targetPort."),
  },
  async (sel) => {
    const rp = resolveProfile(sel);
    if (isResolveError(rp)) return jsonResult(rp);
    const payload = await getProfilePayload(rp.key);
    if (!payload) return noDataResult(rp);

    const { ageSeconds, fresh, staleWarning } = freshness(payload);
    const targetDomain = rp.targetDomain;
    const targetPort = sel.port || rp.targetPort;

    const playwrightCookies = rp.cookies
      .filter((n) => payload.cookies[n])
      .map((n) => {
        const c = payload.cookies[n]!;
        return {
          name: n,
          value: c.value,
          domain: targetDomain,
          path: "/",
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite === "strict" ? "Strict" : c.sameSite === "lax" ? "Lax" : "None",
        };
      });

    const missingRequired = rp.requiredCookies.filter((n) => !payload.cookies[n]);
    const missingBootstrap = rp.bootstrapCookies.filter((n) => !payload.cookies[n]);

    const result: Record<string, unknown> = {
      profile: rp.key,
      cookies: playwrightCookies,
      usage: `await context.addCookies(${JSON.stringify(playwrightCookies)})`,
      targetUrl: `https://${targetDomain}:${targetPort}`,
      ageSeconds,
      fresh,
    };
    if (staleWarning) result.warning = staleWarning;
    if (missingRequired.length) result.missingRequired = missingRequired;
    if (missingBootstrap.length) {
      result.missingBootstrap = missingBootstrap;
      result.primeHint = `Bootstrap cookie(s) ${missingBootstrap.join(
        ", "
      )} are not present for "${rp.key}". Call request_prime with profile "${rp.key}" (or click Prime in the extension), complete the login, then call this tool again.`;
    }
    return jsonResult(result);
  }
);

// --- Tool: get_cookie_status -------------------------------------------------

mcp.tool(
  "get_cookie_status",
  "Check the health and freshness of a profile's cookies: which are present/missing, how old they are, and whether priming is needed. Select by `profile` key or `url`.",
  selectorSchema,
  async (sel) => {
    const rp = resolveProfile(sel);
    if (isResolveError(rp)) return jsonResult(rp);
    const payload = await getProfilePayload(rp.key);

    if (!payload) {
      return jsonResult({
        profile: rp.key,
        status: "no_data",
        configuredCookies: rp.cookies,
        cookieUrl: rp.cookieUrl,
        hint: `No cookies received for "${rp.key}" yet. Ensure the extension is installed and ${rp.host} has an active session.`,
      });
    }

    const { ageSeconds, fresh, staleWarning } = freshness(payload);
    const st = computeProfileStatus(rp, payload);

    return jsonResult({
      profile: rp.key,
      status: st.requiredPresent && fresh ? "healthy" : "degraded",
      requiredPresent: st.requiredPresent,
      presentCookies: st.presentCookies,
      missingRequired: st.missingRequired,
      missingBootstrap: st.missingBootstrap,
      timestamp: payload.timestamp,
      ageSeconds,
      fresh,
      cookieUrl: rp.cookieUrl,
      ...(staleWarning ? { warning: staleWarning } : {}),
      ...(st.missingBootstrap.length
        ? {
            primeHint: `Bootstrap cookie(s) ${st.missingBootstrap.join(
              ", "
            )} absent (normal — they expire). Call request_prime for "${rp.key}" or click Prime in the extension, then complete login.`,
          }
        : {}),
    });
  }
);

// --- Tool: request_prime -----------------------------------------------------

mcp.tool(
  "request_prime",
  "Ask the extension to prime (re-mint the session for) a profile — it drives a logout→login so short-lived bootstrap cookies are re-issued. Login is interactive: after calling this, the browser opens/updates a tab on the profile's host and a human completes the login, after which cookies are captured automatically. Select by `profile` key or `url`.",
  selectorSchema,
  async (sel) => {
    const rp = resolveProfile(sel);
    if (isResolveError(rp)) return jsonResult(rp);

    let queued = false;
    if (clientMode) {
      queued = await daemonPostPrime(rp.key);
    } else {
      pendingPrimes[rp.key] = new Date().toISOString();
      queued = true;
    }

    return jsonResult({
      profile: rp.key,
      queued,
      cookieUrl: rp.cookieUrl,
      hint: queued
        ? `Prime queued for "${rp.key}". The extension will open/redirect a ${rp.host} tab to log out and back in — complete the login there, then re-read cookies. If the extension isn't running, click Prime in its popup instead.`
        : `Could not queue a prime for "${rp.key}" (bridge unreachable). Click Prime in the extension popup instead.`,
    });
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  payloadsByProfile = loadFromDisk();
  await startBridge();
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
