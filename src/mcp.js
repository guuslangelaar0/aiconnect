/* MCP server (stdio). Exposes the same operations as the CLI as tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";
import * as api from "./api.js";
import * as fmt from "./format.js";

const folderRefSchema = z.union([
  z.string().describe("\"account:Path/To/Folder\" (account name or id; path by folder names, e.g. \"guus@example.com:Inbox/Clients\") or a folder id"),
  z.object({ account: z.string(), path: z.string() }),
  z.object({ folderId: z.string() })
]);

const ruleSchema = z.object({
  account: z.string().describe("account name (email) or id"),
  field: z.enum(["from", "subject", "any", "to"]).default("from"),
  patterns: z.array(z.string()).min(1).describe("case-insensitive substrings; any match"),
  dest: z.string().describe("destination folder path in that account, created if missing"),
  note: z.string().optional()
});

function text(data, human) {
  return { content: [{ type: "text", text: typeof human === "function" ? human(data) : (human ?? JSON.stringify(data, null, 2)) }] };
}
function json(data) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }

export async function runMcp(settings) {
  const log = (...a) => process.stderr.write("[aiconnect mcp] " + a.join(" ") + "\n");
  const bridge = new Bridge({ ports: settings.ports, port: settings.port, token: settings.token, connectTimeout: settings.timeout });
  if (!settings.token) log("warning: no pairing token configured; run `aiconnect pair`");
  bridge.on("connected", (c) => log("Thunderbird reachable (" + ((c && c.client) || "?") + ")"));
  bridge.on("disconnected", () => log("Thunderbird not reachable"));
  // Become hub if a port is free, otherwise relay through the existing hub. Never exit on failure.
  const ready = async () => { await bridge.waitForConnection(settings.timeout); return bridge; };
  bridge.start().then((m) => log("bridge mode: " + m + " on 127.0.0.1:" + bridge.port)).catch((e) => log("bridge start failed: " + e.message + " (will retry on first call)"));

  const server = new McpServer({ name: "aiconnect", version: "0.2.0" }, {
    instructions: "AIConnect gives you Thunderbird mail access through a local extension bridge. Safe workflow for organizing mail: scan -> suggest -> show the user the plan -> rules_dry_run -> (user approves) rules_apply -> rules_save -> archive. Never delete without an explicit user instruction; prefer moving to Trash over permanent delete. Folder paths use folder names separated by '/', relative to the account root (some IMAP servers nest everything under 'Inbox/'; use the paths returned by list_folders)."
  });

  server.tool("status", "Check the Thunderbird connection", {}, async () => text(await api.ping(await ready()), (r) => `connected: extension ${r.version}, Thunderbird ${r.thunderbird}`));

  server.tool("list_accounts", "List all mail accounts with their folder trees", { counts: z.boolean().default(false).describe("include message counts (slower)") },
    async ({ counts }) => json(await api.listAccounts(await ready(), { counts })));

  server.tool("list_folders", "Flat list of folders in one account with counts", { account: z.string(), counts: z.boolean().default(true) },
    async ({ account, counts }) => json(await api.listFolders(await ready(), account, { counts })));

  server.tool("create_folder", "Create a folder path in an account (missing parents are created)", { account: z.string(), path: z.string() },
    async ({ account, path }) => json(await api.ensureFolder(await ready(), account, path)));

  server.tool("scan", "Inventory folders and analyse inbox senders/domains/years for one or all accounts. Returns the scan object; pass it to suggest.", {
    account: z.string().optional(), recentDays: z.number().int().default(365), top: z.number().int().default(60),
    probe: z.number().int().default(0).describe("probe headers of N top senders for List-Unsubscribe (bulk detection)"),
    format: z.enum(["json", "text"]).default("text")
  }, async ({ account, recentDays, top, probe, format }) => {
    const scan = await api.scanAccounts(await ready(), { account, recentDays, top, probe: probe || false });
    return format === "json" ? json(scan) : text(scan, (s) => fmt.renderScan(s, { senders: 30 }));
  });

  server.tool("suggest", "Propose folders, sorting rules, an archive step and unsubscribe candidates. Runs a scan unless a scan object is given. Review with the user before applying.", {
    account: z.string().optional(), scan: z.any().optional().describe("a scan object from the scan tool (json format)"),
    lang: z.enum(["en", "nl"]).default("en"), vendorThreshold: z.number().int().default(25), minCount: z.number().int().default(3), archiveDays: z.number().int().default(365),
    probe: z.boolean().default(false), format: z.enum(["json", "text"]).default("json")
  }, async ({ account, scan, lang, vendorThreshold, minCount, archiveDays, probe, format }) => {
    const s = scan || await api.scanAccounts(await ready(), { account, probe: probe ? 40 : false });
    const sug = api.suggestFromScan(s, { lang, vendorThreshold, minCount, archiveDays });
    return format === "json" ? json(sug) : text(sug, fmt.renderSuggestion);
  });

  server.tool("list_messages", "List messages in a folder, newest first", { folder: folderRefSchema, limit: z.number().int().default(50), cursor: z.string().optional() },
    async ({ folder, limit, cursor }) => json(await api.listMessages(await ready(), api.folderRef(folder), { limit, cursor })));

  server.tool("search_messages", "Search messages by author/subject/recipients/date/flags/full text", {
    account: z.string().optional(), folder: folderRefSchema.optional(), includeSubFolders: z.boolean().default(false),
    author: z.string().optional(), subject: z.string().optional(), recipients: z.string().optional(), fullText: z.string().optional(),
    fromDate: z.string().optional(), toDate: z.string().optional(), unread: z.boolean().optional(), flagged: z.boolean().optional(), limit: z.number().int().default(100)
  }, async (q) => json(await api.searchMessages(await ready(), { ...q, folder: q.folder ? api.folderRef(q.folder) : undefined })));

  server.tool("read_message", "Read one message: headers, plain-text body, attachments list", { id: z.number().int(), maxChars: z.number().int().default(20000), html: z.boolean().default(false), allHeaders: z.boolean().default(false) },
    async ({ id, maxChars, html, allHeaders }) => json(await api.readMessage(await ready(), id, { maxChars, html, allHeaders })));

  server.tool("move_messages", "Move messages to a folder (created if missing)", { ids: z.array(z.number().int()).min(1), to: folderRefSchema },
    async ({ ids, to }) => json(await api.moveMessages(await ready(), ids, api.folderRef(to))));

  server.tool("update_messages", "Mark read/unread, flag, junk, tags", { ids: z.array(z.number().int()).min(1), read: z.boolean().optional(), flagged: z.boolean().optional(), junk: z.boolean().optional(), tags: z.array(z.string()).optional() },
    async ({ ids, ...props }) => json(await api.updateMessages(await ready(), ids, props)));

  server.tool("delete_messages", "Move messages to Trash (permanent=true deletes for good). Only with explicit user approval.", { ids: z.array(z.number().int()).min(1), permanent: z.boolean().default(false), confirm: z.literal(true).describe("must be true; the user has approved this deletion") },
    async ({ ids, permanent }) => json(await api.deleteMessages(await ready(), ids, permanent)));

  server.tool("rules_dry_run", "Count what each rule would move from each account's inbox. Moves nothing.", { rules: z.array(ruleSchema).min(1), sourceFolder: z.string().optional(), format: z.enum(["json", "text"]).default("text") },
    async ({ rules, sourceFolder, format }) => { const r = await api.runRules(await ready(), rules, { apply: false, sourceFolder }); return format === "json" ? json(r) : text(r, fmt.renderRulesReport); });

  server.tool("rules_apply", "Move existing inbox mail according to rules. Run rules_dry_run and get user approval first.", { rules: z.array(ruleSchema).min(1), sourceFolder: z.string().optional(), confirm: z.literal(true).describe("must be true; the user has approved the dry-run result") },
    async ({ rules, sourceFolder }) => text(await api.runRules(await ready(), rules, { apply: true, sourceFolder }), fmt.renderRulesReport));

  server.tool("rules_save", "Store rules in the extension so new mail is sorted automatically (replaces existing ongoing rules)", { rules: z.array(ruleSchema) },
    async ({ rules }) => json(await api.setRules(await ready(), rules)));

  server.tool("rules_get", "Show the ongoing rules stored in the extension", {}, async () => json(await api.getRules(await ready())));

  server.tool("archive", "Move old inbox mail into an archive folder (dry run unless confirm=true). Read-only messages by default; flagged skipped.", {
    account: z.string(), olderThanDays: z.number().int().default(365), dest: z.string().describe("e.g. \"Inbox/Archive\" or \"[Gmail]/All Mail\""),
    byYear: z.boolean().default(false), includeUnread: z.boolean().default(false), includeFlagged: z.boolean().default(false), sourceFolder: z.string().optional(),
    confirm: z.boolean().default(false).describe("true = actually move (user approved the dry run)")
  }, async ({ account, olderThanDays, dest, byYear, includeUnread, includeFlagged, sourceFolder, confirm }) =>
    text(await api.runArchive(await ready(), { account, olderThanDays, dest, byYear, readOnly: !includeUnread, skipFlagged: !includeFlagged, sourceFolder, apply: confirm }), fmt.renderArchiveReport));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready (stdio)");
  const shutdown = () => bridge.stop().then(() => process.exit(0), () => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  process.on("uncaughtException", (e) => log("uncaught: " + (e && e.stack || e)));
  process.on("unhandledRejection", (e) => log("unhandled: " + (e && e.stack || e)));
}
