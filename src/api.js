/* High-level operations shared by the CLI and the MCP server. Each takes a connected Bridge. */
import { suggest as suggestRules } from "./suggest.js";

export async function ping(bridge) {
  return bridge.call("ping");
}

export async function listAccounts(bridge, { counts = false } = {}) {
  return bridge.call("accounts.list", { counts });
}

export async function listFolders(bridge, account, { counts = true } = {}) {
  return bridge.call("folders.list", { account, counts });
}

export async function ensureFolder(bridge, account, path) {
  return bridge.call("folders.ensure", { account, path });
}

export async function renameFolder(bridge, folder, newName) {
  return bridge.call("folders.rename", { folder, newName });
}

export async function deleteFolder(bridge, folder, force = false) {
  return bridge.call("folders.delete", { folder, force });
}

/* Scan one or all accounts: folders (with counts) + inbox statistics. */
export async function scanAccounts(bridge, { account, recentDays = 365, top = 60, probe = false, onProgress } = {}) {
  const accounts = await bridge.call("accounts.list", { counts: false });
  const targets = account ? accounts.filter((a) => a.id === account || a.name.toLowerCase() === String(account).toLowerCase()) : accounts;
  if (account && !targets.length) throw new Error("Unknown account: " + account);
  const out = { generatedAt: new Date().toISOString(), recentDays, accounts: [] };
  for (const a of targets) {
    if (onProgress) onProgress({ label: "folders " + a.name });
    const { folders } = await bridge.call("folders.list", { account: a.id, counts: true });
    let inbox = null;
    if (a.inboxFolderId) {
      if (onProgress) onProgress({ label: "inbox " + a.name });
      inbox = await bridge.call("scan.folder", { folder: { folderId: a.inboxFolderId }, recentDays, top, probe }, {
        onProgress: (p) => onProgress && onProgress({ ...p, label: a.name + ": " + (p.label || "") })
      });
    }
    out.accounts.push({ account: { id: a.id, name: a.name, type: a.type, identities: a.identities || [] }, folders, inbox });
  }
  return out;
}

export async function listMessages(bridge, folderRef, { limit = 50, cursor } = {}) {
  return bridge.call("messages.list", { folder: folderRef, limit, cursor });
}

export async function searchMessages(bridge, query) {
  return bridge.call("messages.query", query);
}

export async function readMessage(bridge, id, { html = false, maxChars = 20000, allHeaders = false } = {}) {
  return bridge.call("messages.read", { id, html, maxChars, allHeaders });
}

export async function moveMessages(bridge, ids, to, { onProgress } = {}) {
  return bridge.call("messages.move", { ids, to }, { onProgress });
}

export async function updateMessages(bridge, ids, props) {
  return bridge.call("messages.update", { ids, ...props });
}

export async function deleteMessages(bridge, ids, permanent = false) {
  return bridge.call("messages.delete", { ids, permanent });
}

export async function archiveMessages(bridge, ids) {
  return bridge.call("messages.archive", { ids });
}

export async function getRules(bridge) {
  return bridge.call("rules.get");
}

export async function setRules(bridge, rules) {
  return bridge.call("rules.set", { rules });
}

export async function runRules(bridge, rules, { apply = false, sourceFolder, onProgress } = {}) {
  return bridge.call("rules.run", { rules, apply, sourceFolder }, { onProgress });
}

export async function runArchive(bridge, { account, olderThanDays = 365, dest, byYear = false, readOnly = true, skipFlagged = true, sourceFolder, apply = false, onProgress }) {
  return bridge.call("archive.run", { account, olderThanDays, dest, byYear, readOnly, skipFlagged, sourceFolder, apply }, { onProgress });
}

export function suggestFromScan(scan, opts) {
  return suggestRules(scan, opts);
}

/* Normalise "account:Path/To/Folder" or {account,path} or folder id into a folder reference object. */
export function folderRef(spec) {
  if (!spec) return null;
  if (typeof spec === "object") return spec;
  const s = String(spec);
  const idx = s.indexOf(":");
  if (idx > 0) return { account: s.slice(0, idx), path: s.slice(idx + 1) };
  return { folderId: s };
}
