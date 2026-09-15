/* Register aiconnect as an MCP server in the Claude desktop app's config. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(__dirname, "..", "src", "cli.js");

function configPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("APPDATA is not set; cannot locate the Claude desktop config.");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config"), "Claude", "claude_desktop_config.json");
}

/* Read the existing config. Missing file -> fresh config. Unreadable/!JSON file -> abort:
   overwriting it would throw away every other MCP server and all desktop preferences. */
function readConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    return parsed;
  } catch (e) {
    throw new Error(
      `${file} exists but is not valid JSON (${e.message}).\n` +
      "Refusing to overwrite it — that would wipe your other MCP servers and desktop settings.\n" +
      "Fix or remove the file, then re-run setup-mcp.cmd."
    );
  }
}

function main() {
  if (!fs.existsSync(cli)) throw new Error(`Cannot find ${cli} — run setup.cmd first.`);

  const file = configPath();
  const config = readConfig(file);

  /* Launch via the absolute node + cli.js path, NOT the bare "aiconnect" command: on Windows
     npm link only creates aiconnect.cmd/.ps1 shims, and the desktop app spawns MCP servers
     without a shell, so "aiconnect" fails with ENOENT. This also survives a broken npm link. */
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.aiconnect = { command: process.execPath, args: [cli, "mcp"] };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);

  // Write via a temp file so an interrupted write cannot leave a truncated config behind.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);

  console.log("updated", file);
  if (fs.existsSync(`${file}.bak`)) console.log("backup ", `${file}.bak`);
  console.log(JSON.stringify(config.mcpServers, null, 2));
}

try {
  main();
} catch (e) {
  console.error("\nFailed to register the MCP server:\n" + e.message);
  process.exit(1);
}
