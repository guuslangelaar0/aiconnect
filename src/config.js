import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const CONFIG_DIR = process.env.AICONNECT_HOME || path.join(os.homedir(), ".aiconnect");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DEFAULT_PORT = 47800;
/* Ports every aiconnect process and the extension walk, in order. The lowest port that is
 * free (or already hosts an aiconnect hub) is the one they all converge on. */
export const DEFAULT_PORTS = [47800, 47801, 47802, 47803, 47804];

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return { port: DEFAULT_PORT, ...JSON.parse(raw) };
  } catch (e) {
    return { port: DEFAULT_PORT, token: "" };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return cfg;
}

export function ensureToken(regenerate = false) {
  const cfg = loadConfig();
  if (!cfg.token || regenerate) {
    cfg.token = crypto.randomBytes(24).toString("base64url");
    saveConfig(cfg);
  }
  return cfg;
}

function parsePorts(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Boolean);
  if (typeof v === "number") return [v];
  if (typeof v === "string") return v.split(",").map((s) => Number(s.trim())).filter(Boolean);
  return [];
}

/* The port list to walk: explicit --port(s)/env/config narrows it; otherwise the default range,
 * with any configured single `port` moved to the front so an existing setup keeps its port. */
export function effectivePorts(opts = {}, cfg = loadConfig()) {
  const explicit = parsePorts(opts.ports || opts.port || process.env.AICONNECT_PORTS || process.env.AICONNECT_PORT || cfg.ports);
  if (explicit.length) return [...new Set(explicit)];
  const base = [...DEFAULT_PORTS];
  const single = Number(cfg.port);
  if (single && !base.includes(single)) return [single, ...base];
  if (single) return [single, ...base.filter((p) => p !== single)];
  return base;
}

/* Resolve effective settings: CLI flags > env > config file. */
export function effective(opts = {}) {
  const cfg = loadConfig();
  const ports = effectivePorts(opts, cfg);
  return {
    ports,
    port: ports[0],
    token: opts.token || process.env.AICONNECT_TOKEN || cfg.token || "",
    timeout: Number(opts.timeout || process.env.AICONNECT_TIMEOUT || 20000)
  };
}
