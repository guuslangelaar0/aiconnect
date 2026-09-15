#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effective, ensureToken, loadConfig, saveConfig, CONFIG_FILE } from "./config.js";
import { withBridge, BridgeError } from "./bridge.js";
import * as api from "./api.js";
import * as fmt from "./format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pkg = { version: "0.1.0" };
try { pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")); } catch (e) { /* bundled */ }

const program = new Command();
program
  .name("aiconnect")
  .description("Read, organize and automate Thunderbird accounts from the command line (and from AI tools via MCP).")
  .version(pkg.version)
  .option("--port <n>", "force a single bridge port (default: walk the port list)")
  .option("--ports <list>", "comma-separated bridge ports to walk (default 47800-47804)")
  .option("--token <t>", "pairing token (default from config)")
  .option("--timeout <ms>", "how long to wait for Thunderbird to connect", "20000")
  .option("--json", "machine-readable JSON output")
  .option("-q, --quiet", "no progress output on stderr");

const g = () => program.opts();
const settings = () => effective(g());

function progressPrinter() {
  if (g().quiet) return () => {};
  let last = "";
  return (p) => {
    const line = `${p.label || ""} ${p.done ?? ""}${p.total ? "/" + p.total : ""}`.trim();
    if (line && line !== last) { process.stderr.write("\r" + line.padEnd(70)); last = line; }
  };
}
function endProgress() { if (!g().quiet) process.stderr.write("\r" + " ".repeat(70) + "\r"); }

function out(data, human) {
  if (g().json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else process.stdout.write((typeof human === "function" ? human(data) : human ?? JSON.stringify(data, null, 2)) + "\n");
}

async function run(fn) {
  try {
    await withBridge(settings(), fn, { onProgress: progressPrinter() });
    endProgress();
  } catch (e) {
    endProgress();
    if (e instanceof BridgeError) {
      process.stderr.write("error: " + e.message + "\n");
      process.exit(e.code === "NO_CLIENT" ? 3 : 2);
    }
    process.stderr.write("error: " + (e.stack || e.message) + "\n");
    process.exit(1);
  }
}

function readJsonArg(fileOrJson) {
  if (fileOrJson === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  if (fs.existsSync(fileOrJson)) return JSON.parse(fs.readFileSync(fileOrJson, "utf8"));
  return JSON.parse(fileOrJson);
}

/* ---------- pairing / status ---------- */

program.command("pair")
  .description("Create (or show) the pairing token and explain how to enter it in the Thunderbird extension")
  .option("--regenerate", "make a new token (the extension must be updated)")
  .option("--set-token <t>", "use this exact token (e.g. one already entered in the extension)")
  .option("--set-port <n>", "store a different bridge port in the config")
  .option("--set-ports <list>", "store the comma-separated port list to walk")
  .action((opts) => {
    let cfg = ensureToken(!!opts.regenerate);
    if (opts.setToken) { cfg.token = String(opts.setToken).trim(); saveConfig(cfg); }
    if (opts.setPort) { cfg.port = Number(opts.setPort); saveConfig(cfg); }
    if (opts.setPorts) { cfg.ports = opts.setPorts.split(",").map((s) => Number(s.trim())).filter(Boolean); saveConfig(cfg); }
    const eff = settings();
    if (g().json) return out({ ports: eff.ports, token: cfg.token, configFile: CONFIG_FILE });
    console.log(`AIConnect pairing
  Ports:  ${eff.ports.join(", ")}   (the bridge takes the first free one; the extension tries them in order)
  Token:  ${cfg.token}
  Config: ${CONFIG_FILE}

In Thunderbird: Add-ons and Themes > AIConnect > Preferences (or click the AIConnect toolbar button),
enter the token above, Save. Then run:  aiconnect status`);
  });

program.command("status")
  .description("Check that Thunderbird's AIConnect extension can reach this machine's bridge")
  .action(() => run(async (b) => {
    const r = await api.ping(b);
    out(r, `connected: AIConnect extension ${r.version} in Thunderbird ${r.thunderbird}`);
  }));

/* ---------- accounts / folders ---------- */

program.command("accounts")
  .description("List accounts and their folder trees")
  .option("--counts", "include message counts (slower)")
  .action((opts) => run(async (b) => out(await api.listAccounts(b, { counts: !!opts.counts }), fmt.renderAccounts)));

const folders = program.command("folders").description("Folder operations");
folders.command("list <account>")
  .description("Flat folder list with counts for one account")
  .option("--no-counts", "skip counts")
  .action((account, opts) => run(async (b) => out(await api.listFolders(b, account, { counts: opts.counts !== false }), fmt.renderFolders)));
folders.command("create <account> <path>")
  .description("Create a folder path (creates missing parents), e.g. \"Inbox/Clients/Acme\"")
  .action((account, p) => run(async (b) => out(await api.ensureFolder(b, account, p), (r) => `${r.created.length ? "created" : "exists"}: ${r.path}`)));
folders.command("rename <account:path> <newName>")
  .action((ref, newName) => run(async (b) => out(await api.renameFolder(b, api.folderRef(ref), newName), (r) => `renamed: ${r.path}`)));
folders.command("delete <account:path>")
  .option("--force", "delete even if not empty")
  .action((ref, opts) => run(async (b) => out(await api.deleteFolder(b, api.folderRef(ref), !!opts.force), "deleted")));

/* ---------- scan / suggest ---------- */

program.command("scan [account]")
  .description("Inventory folders and analyse inbox senders (all accounts by default)")
  .option("--days <n>", "'recent' window in days", "365")
  .option("--top <n>", "top N senders/domains", "60")
  .option("--probe [n]", "fetch headers of one message per top sender to detect bulk mail (List-Unsubscribe)")
  .option("--senders <n>", "senders to print per account (text output)", "25")
  .option("-o, --out <file>", "also write the JSON scan to a file (needed by `suggest`)")
  .action((account, opts) => run(async (b) => {
    const probe = opts.probe === undefined ? false : (opts.probe === true ? 40 : Number(opts.probe));
    const scan = await api.scanAccounts(b, { account, recentDays: Number(opts.days), top: Number(opts.top), probe, onProgress: progressPrinter() });
    if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(scan, null, 2));
    out(scan, (s) => fmt.renderScan(s, { senders: Number(opts.senders) }));
  }));

program.command("suggest [scanFile]")
  .description("Propose folders, sorting rules, an archive step and unsubscribe candidates from a scan (runs a scan if no file given)")
  .option("--lang <en|nl>", "language for new folder names", "en")
  .option("--vendor-threshold <n>", "msgs/yr from one sender before it gets its own sub-folder", "25")
  .option("--min <n>", "ignore senders with fewer recent messages", "3")
  .option("--archive-days <n>", "archive inbox mail older than this", "365")
  .option("--probe", "when scanning, probe headers for bulk detection")
  .option("--rules-out <file>", "write the proposed rules (input for `rules dry-run` / `rules apply`)")
  .action((scanFile, opts) => {
    const doSuggest = (scan) => {
      const sug = api.suggestFromScan(scan, { lang: opts.lang, vendorThreshold: Number(opts.vendorThreshold), minCount: Number(opts.min), archiveDays: Number(opts.archiveDays) });
      if (opts.rulesOut) fs.writeFileSync(opts.rulesOut, JSON.stringify(sug.accounts.flatMap((a) => a.rules), null, 2));
      out(sug, fmt.renderSuggestion);
    };
    if (scanFile) return doSuggest(readJsonArg(scanFile));
    return run(async (b) => doSuggest(await api.scanAccounts(b, { probe: opts.probe ? 40 : false, onProgress: progressPrinter() })));
  });

/* ---------- messages ---------- */

const messages = program.command("messages").description("List, search, read and act on messages");
messages.command("list <account:path>")
  .description("List messages in a folder (newest first). Use \"account:Inbox\" for the inbox")
  .option("--limit <n>", "max messages", "50")
  .option("--cursor <c>", "continue a previous listing")
  .action((ref, opts) => run(async (b) => out(await api.listMessages(b, api.folderRef(ref), { limit: Number(opts.limit), cursor: opts.cursor }), (r) => fmt.renderMessages(r.messages) + (r.cursor ? `\n(more: --cursor ${r.cursor})` : ""))));

messages.command("search")
  .description("Search messages (Thunderbird query)")
  .option("--account <a>").option("--folder <account:path>").option("--subfolders", "include subfolders")
  .option("--from <text>", "author contains").option("--subject <text>").option("--to <text>", "recipients contain")
  .option("--text <text>", "full text (slow)").option("--since <date>").option("--until <date>")
  .option("--unread").option("--flagged").option("--limit <n>", "", "100")
  .action((opts) => run(async (b) => {
    const q = { limit: Number(opts.limit) };
    if (opts.account) q.account = opts.account;
    if (opts.folder) { q.folder = api.folderRef(opts.folder); if (opts.subfolders) q.includeSubFolders = true; }
    if (opts.from) q.author = opts.from;
    if (opts.subject) q.subject = opts.subject;
    if (opts.to) q.recipients = opts.to;
    if (opts.text) q.fullText = opts.text;
    if (opts.since) q.fromDate = opts.since;
    if (opts.until) q.toDate = opts.until;
    if (opts.unread) q.unread = true;
    if (opts.flagged) q.flagged = true;
    out(await api.searchMessages(b, q), (r) => fmt.renderMessages(r.messages) + (r.truncated ? "\n(truncated)" : ""));
  }));

messages.command("read <id>")
  .description("Print headers and body text of one message")
  .option("--html", "include HTML body").option("--max <chars>", "", "20000").option("--all-headers")
  .action((id, opts) => run(async (b) => out(await api.readMessage(b, Number(id), { html: !!opts.html, maxChars: Number(opts.max), allHeaders: !!opts.allHeaders }),
    (m) => `From: ${m.author}\nTo: ${(m.recipients || []).join(", ")}\nDate: ${m.date}\nSubject: ${m.subject}\n${Object.entries(m.headers).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${m.text}${m.truncated ? "\n[truncated]" : ""}${m.attachments.length ? "\n\nAttachments: " + m.attachments.map((a) => a.name).join(", ") : ""}`)));

messages.command("move <ids...>")
  .description("Move messages to a folder; --to account:Path (folder is created if missing)")
  .requiredOption("--to <account:path>")
  .action((ids, opts) => run(async (b) => out(await api.moveMessages(b, ids.map(Number), api.folderRef(opts.to)), (r) => `moved ${r.moved} -> ${r.to.path}`)));

messages.command("mark <ids...>")
  .description("Update flags: --read/--unread, --flag/--unflag, --junk/--notjunk, --tags a,b")
  .option("--read").option("--unread").option("--flag").option("--unflag").option("--junk").option("--notjunk").option("--tags <list>")
  .action((ids, opts) => run(async (b) => {
    const props = {};
    if (opts.read) props.read = true; if (opts.unread) props.read = false;
    if (opts.flag) props.flagged = true; if (opts.unflag) props.flagged = false;
    if (opts.junk) props.junk = true; if (opts.notjunk) props.junk = false;
    if (opts.tags) props.tags = opts.tags.split(",").map((s) => s.trim()).filter(Boolean);
    out(await api.updateMessages(b, ids.map(Number), props), (r) => `updated ${r.updated}`);
  }));

messages.command("delete <ids...>")
  .description("Move messages to Trash (or --permanent). Requires --yes")
  .option("--permanent").option("--yes")
  .action((ids, opts) => {
    if (!opts.yes) { console.error("refusing without --yes"); process.exit(4); }
    return run(async (b) => out(await api.deleteMessages(b, ids.map(Number), !!opts.permanent), (r) => `deleted ${r.deleted}${r.permanent ? " permanently" : " (to Trash)"}`));
  });

/* ---------- rules ---------- */

const rules = program.command("rules").description("Sorting rules: dry-run, apply to existing mail, save as ongoing rules");
rules.command("show").description("Show the ongoing rules stored in the extension")
  .action(() => run(async (b) => out(await api.getRules(b), (r) => r.map((x) => `${x.account}: ${x.field} ~ [${x.patterns.join(", ")}] -> ${x.dest}`).join("\n") || "(none)")));
rules.command("dry-run <rulesFile>").description("Count what each rule would move from each account's inbox; moves nothing")
  .option("--source <path>", "evaluate against this folder instead of the inbox")
  .action((file, opts) => run(async (b) => out(await api.runRules(b, readJsonArg(file), { apply: false, sourceFolder: opts.source, onProgress: progressPrinter() }), fmt.renderRulesReport)));
rules.command("apply <rulesFile>").description("Move matching existing mail. Requires --yes")
  .option("--source <path>").option("--yes")
  .action((file, opts) => {
    if (!opts.yes) { console.error("refusing without --yes (run `rules dry-run` first)"); process.exit(4); }
    return run(async (b) => out(await api.runRules(b, readJsonArg(file), { apply: true, sourceFolder: opts.source, onProgress: progressPrinter() }), fmt.renderRulesReport));
  });
rules.command("save <rulesFile>").description("Store rules in the extension so new mail is sorted automatically (replaces existing)")
  .action((file) => run(async (b) => out(await api.setRules(b, readJsonArg(file)), (r) => `saved ${r.saved} ongoing rules`)));
rules.command("clear").action(() => run(async (b) => out(await api.setRules(b, []), "cleared")));

/* ---------- archive ---------- */

program.command("archive <account>")
  .description("Move old inbox mail to an archive folder. Dry run unless --yes")
  .option("--older-than <days>", "", "365")
  .requiredOption("--to <path>", "destination path in the same account, e.g. \"Inbox/Archive\" or \"[Gmail]/All Mail\"")
  .option("--by-year", "create <dest>/<year> subfolders")
  .option("--include-unread", "also archive unread messages")
  .option("--include-flagged", "also archive flagged messages")
  .option("--source <path>", "source folder instead of the inbox")
  .option("--yes", "actually move")
  .action((account, opts) => run(async (b) => {
    const olderThanDays = Number(opts.olderThan);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      console.error(`--older-than must be a number of days >= 0 (got "${opts.olderThan}")`);
      process.exit(4);
    }
    return out(await api.runArchive(b, {
      account, olderThanDays, dest: opts.to, byYear: !!opts.byYear,
      readOnly: !opts.includeUnread, skipFlagged: !opts.includeFlagged, sourceFolder: opts.source, apply: !!opts.yes, onProgress: progressPrinter()
    }), fmt.renderArchiveReport);
  }));

/* ---------- mcp / misc ---------- */

program.command("mcp")
  .description("Run as an MCP server over stdio (for Claude Code, Claude Desktop, Cowork, etc.)")
  .action(async () => {
    const { runMcp } = await import("./mcp.js");
    await runMcp(settings());
  });

program.command("extension-path")
  .description("Print where the Thunderbird extension source lives (for 'Load Temporary Add-on' during development)")
  .action(() => console.log(path.join(__dirname, "..", "extension")));

program.command("build-xpi")
  .description("Package the extension as dist/aiconnect.xpi for installing in Thunderbird")
  .option("-o, --out <file>")
  .action(async (opts) => {
    const { buildXpi } = await import("../scripts/build-xpi.js");
    console.log(await buildXpi(opts.out));
  });

program.command("config").description("Show effective settings").action(() => out({ ...loadConfig(), effective: settings(), configFile: CONFIG_FILE }));

program.parseAsync(process.argv);
