/* Simulates the Thunderbird extension: dials the bridge, answers RPC calls from an in-memory mailbox.
 * Usage: node test/mock-extension.js <port> <token>
 */
import WebSocket from "ws";

const [port, token] = [process.argv[2] || "47800", process.argv[3] || "test"];

const folders = [
  { id: "f-inbox", name: "Inbox", path: "/INBOX", specialUse: ["inbox"], subFolders: [
    { id: "f-sent", name: "Sent", path: "/INBOX/Sent", specialUse: ["sent"], subFolders: [] },
    { id: "f-boek", name: "Boekhouding", path: "/INBOX/Boekhouding", specialUse: [], subFolders: [] }
  ] }
];
const account = { id: "account1", name: "test@example.com", type: "imap", identities: [{ id: "id1", email: "test@example.com", name: "Test" }], rootFolder: { id: "f-root", name: "Root", path: "/", subFolders: folders } };
const now = Date.now();
const senders = [
  ["Medium Daily Digest <noreply@medium.com>", "Why X is Y", 140], ["LinkedIn <notifications-noreply@linkedin.com>", "You have a new invitation", 90],
  ["Devidee <administratie@devidee.nl>", "Factuur: 2025100034", 40], ["bol <automail@bol.com>", "Je pakket is onderweg", 30],
  ["Sentry <noreply@md.getsentry.com>", "Weekly report", 26], ["John Doe <john@gmail.com>", "Re: lunch?", 4], ["noreply@kvk.nl", "Je KVK-wijziging is verwerkt", 3]
];
let nextId = 1;
const messages = new Map();
for (const [author, subject, n] of senders) {
  for (let i = 0; i < n; i++) {
    const id = nextId++;
    const ageDays = Math.floor(Math.random() * 900);
    messages.set(id, { id, folderId: "f-inbox", author, subject: subject + " #" + i, date: new Date(now - ageDays * 864e5), read: i % 7 !== 0, flagged: false, junk: false, size: 1000, tags: [], recipients: ["test@example.com"] });
  }
}

const find = (id, list = folders) => { for (const f of list) { if (f.id === id) return f; const r = find(id, f.subFolders); if (r) return r; } return null; };
const inFolder = (fid) => [...messages.values()].filter((m) => m.folderId === fid);
const ser = (m) => ({ ...m, folder: { id: m.folderId }, date: m.date });

const handlers = {
  ping: () => ({ ok: true, version: "mock", thunderbird: "mock" }),
  "accounts.list": () => [{ id: account.id, name: account.name, type: account.type, identities: account.identities, rootFolderId: "f-root", inboxFolderId: "f-inbox", folders: serialize(folders, "") }],
  "folders.list": () => ({ account: { id: account.id, name: account.name }, folders: flatten(serialize(folders, "")).map((f) => ({ ...f, total: inFolder(f.id).length, unread: inFolder(f.id).filter((m) => !m.read).length })) }),
  "folders.ensure": ({ path }) => { let list = folders, parent = null, cur = null; for (const part of path.split("/")) { cur = list.find((f) => f.name === part); if (!cur) { cur = { id: "f-" + part.toLowerCase().replace(/\W+/g, "-") + "-" + nextId++, name: part, path: (parent ? parent.path : "") + "/" + part, specialUse: [], subFolders: [] }; list.push(cur); } parent = cur; list = cur.subFolders; } return { id: cur.id, name: cur.name, path: cur.path, created: [] }; },
  "messages.list": ({ folder, limit }) => ({ folder: { id: folder.folderId }, messages: inFolder(folder.folderId).slice(0, limit || 100).map(ser), cursor: null }),
  "messages.read": ({ id }) => ({ ...ser(messages.get(id)), headers: { "list-unsubscribe": "<mailto:x>" }, text: "Hello body", attachments: [] }),
  "messages.move": ({ ids, to }) => { const dest = to.folderId ? find(to.folderId) : handlers["folders.ensure"]({ path: to.path }); for (const id of ids) messages.get(id).folderId = dest.id; return { moved: ids.length, to: { id: dest.id, name: dest.name, path: dest.path } }; },
  "scan.folder": ({ folder, recentDays = 365, top = 60 }, progress) => {
    const msgs = inFolder(folder.folderId); const rs = new Map(), dom = new Map(), years = new Map();
    let recent = 0, older = 0, unread = 0;
    for (const m of msgs) { const isRecent = now - m.date.getTime() <= recentDays * 864e5; if (isRecent) recent++; else older++; if (!m.read) unread++; years.set(m.date.getFullYear(), (years.get(m.date.getFullYear()) || 0) + 1); if (!isRecent) continue; const email = (m.author.match(/<([^>]+)>/) || [, m.author])[1].toLowerCase(); const e = rs.get(email) || { count: 0, unread: 0, display: m.author, samples: [] }; e.count++; if (e.samples.length < 3) e.samples.push(m.subject); rs.set(email, e); const d = email.split("@")[1]; dom.set(d, (dom.get(d) || 0) + 1); }
    progress(msgs.length, msgs.length, "listing");
    const list = [...rs.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, top).map(([email, e]) => ({ email, domain: email.split("@")[1], ...e }));
    return { folder: { id: folder.folderId, name: "Inbox" }, recentDays, stats: { total: msgs.length, unread, flagged: 0, recent, older, oldest: "2023-01-01", newest: "2026-09-14" }, years: [...years.entries()].sort().map(([year, count]) => ({ year, count })), recentSenders: list, allSenders: list, recentDomains: [...dom.entries()].map(([domain, count]) => ({ domain, count })), allDomains: [] };
  },
  "rules.get": () => storedRules, "rules.set": ({ rules }) => { storedRules = rules; return { saved: rules.length }; },
  "rules.run": ({ rules, apply }, progress) => {
    const report = { apply, accounts: [], totalMatched: 0, totalMoved: 0, errors: [] };
    const msgs = inFolder("f-inbox"); const entry = { account: account.name, accountId: account.id, source: "Inbox", scanned: msgs.length, matched: 0, unmatched: 0, rules: [] };
    const groups = rules.map((r) => ({ rule: r, ids: [], samples: [] }));
    for (const m of msgs) { const g = groups.find((g) => (g.rule.patterns || [g.rule.pattern]).some((p) => (g.rule.field === "subject" ? m.subject : m.author).toLowerCase().includes(p.toLowerCase()))); if (g) { g.ids.push(m.id); entry.matched++; } }
    for (const g of groups) { const line = { field: g.rule.field, patterns: g.rule.patterns, dest: g.rule.dest, count: g.ids.length, samples: [] }; if (apply && g.ids.length) { handlers["messages.move"]({ ids: g.ids, to: { path: g.rule.dest } }); line.moved = g.ids.length; report.totalMoved += g.ids.length; progress(g.ids.length, g.ids.length, "moving"); } entry.rules.push(line); }
    entry.unmatched = entry.scanned - entry.matched; report.accounts.push(entry); report.totalMatched = entry.matched; return report;
  },
  "archive.run": ({ olderThanDays = 365, dest, byYear, apply }) => {
    const cutoff = now - olderThanDays * 864e5; const groups = new Map();
    for (const m of inFolder("f-inbox")) { if (m.date.getTime() > cutoff || !m.read) continue; const k = byYear ? dest + "/" + m.date.getFullYear() : dest; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m.id); }
    const report = { apply, account: account.name, source: "Inbox", scanned: inFolder("f-inbox").length, olderThanDays, readOnly: true, unreadSkipped: 0, flaggedSkipped: 0, groups: [], totalMoved: 0 };
    for (const [d, ids] of groups) { const g = { dest: d, count: ids.length }; if (apply) { handlers["messages.move"]({ ids, to: { path: d } }); g.moved = ids.length; report.totalMoved += ids.length; } report.groups.push(g); }
    return report;
  }
};
let storedRules = [];
function serialize(list, prefix) { return list.map((f) => ({ id: f.id, name: f.name, path: prefix ? prefix + "/" + f.name : f.name, rawPath: f.path, specialUse: f.specialUse, subFolders: serialize(f.subFolders, prefix ? prefix + "/" + f.name : f.name) })); }
function flatten(tree, out = []) { for (const f of tree) { const { subFolders, ...rest } = f; out.push(rest); flatten(subFolders, out); } return out; }

function connect() {
  const ws = new WebSocket("ws://127.0.0.1:" + port + "/");
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, client: "mock", version: "mock" })));
  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type) return;
    const h = handlers[msg.method];
    const progress = (done, total, label) => ws.send(JSON.stringify({ method: "progress", params: { id: msg.id, done, total, label } }));
    try { ws.send(JSON.stringify({ id: msg.id, result: h ? await h(msg.params || {}, progress) : (() => { throw new Error("Unknown method " + msg.method); })() })); }
    catch (e) { ws.send(JSON.stringify({ id: msg.id, error: { message: e.message } })); }
  });
  ws.on("close", () => setTimeout(connect, 300));
  ws.on("error", () => {});
}
connect();
