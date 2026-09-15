/* AIConnect - RPC method implementations.
 * Every handler is async (params) => result. Long-running handlers accept a
 * `progress(done, total, label)` callback as the second argument.
 * Written for the Thunderbird 128+ WebExtension API (folder ids, rootFolder, specialUse).
 */

const AIC = {
  /* Read from the manifest so it can never drift from the installed version -- a hardcoded
     copy here made `aiconnect status` report a stale version after an upgrade. */
  VERSION: (() => {
    try { return messenger.runtime.getManifest().version; } catch (e) { return "unknown"; }
  })(),
  LOG: "[AIConnect]",

  /* Resumable-scan state, kept in the background page across RPC calls so a huge inbox is walked in
   * bounded slices instead of one all-or-nothing scan (which Gmail/IMAP can throttle past the host's
   * response window). Keyed by folderId. */
  _scan: {},

  /* ---------- helpers ---------- */

  topFolders(account) {
    if (account && account.rootFolder && Array.isArray(account.rootFolder.subFolders)) return account.rootFolder.subFolders;
    if (account && Array.isArray(account.folders)) return account.folders;
    return [];
  },

  isInbox(folder) {
    if (!folder) return false;
    if (Array.isArray(folder.specialUse) && folder.specialUse.includes("inbox")) return true;
    return !!(folder.name && folder.name.toLowerCase() === "inbox");
  },

  findInbox(account) {
    const walk = (folders) => {
      for (const f of folders) {
        if (AIC.isInbox(f)) return f;
      }
      for (const f of folders) {
        const hit = f.subFolders && f.subFolders.length ? walk(f.subFolders) : null;
        if (hit) return hit;
      }
      return null;
    };
    return walk(AIC.topFolders(account));
  },

  pathParts(path) {
    return String(path).split("/").map((s) => s.trim()).filter(Boolean);
  },

  /* Serialise a folder tree to plain objects with path-by-name. */
  serializeFolders(folders, prefix) {
    return (folders || []).map((f) => {
      const path = prefix ? prefix + "/" + f.name : f.name;
      return {
        id: f.id,
        name: f.name,
        path,
        rawPath: f.path,
        specialUse: Array.isArray(f.specialUse) ? f.specialUse : [],
        subFolders: AIC.serializeFolders(f.subFolders, path)
      };
    });
  },

  flattenFolders(tree, out) {
    out = out || [];
    for (const f of tree) {
      const { subFolders, ...rest } = f;
      out.push(rest);
      if (subFolders && subFolders.length) AIC.flattenFolders(subFolders, out);
    }
    return out;
  },

  async getAccount(accountRef) {
    // accountRef may be an id or a name/email
    let acc = await messenger.accounts.get(accountRef, true);
    if (acc) return acc;
    const all = await messenger.accounts.list(true);
    acc = all.find((a) => a.name === accountRef || a.name.toLowerCase() === String(accountRef).toLowerCase());
    if (!acc) throw new Error("Unknown account: " + accountRef);
    return acc;
  },

  findFolderByPath(account, path) {
    let candidates = AIC.topFolders(account);
    let found = null;
    for (const part of AIC.pathParts(path)) {
      found = candidates.find((f) => f.name === part) ||
        candidates.find((f) => f.name.toLowerCase() === part.toLowerCase());
      if (!found) return null;
      candidates = found.subFolders || [];
    }
    return found;
  },

  /* Resolve {folderId} | {account, path} | "account:path" into a MailFolder. */
  async resolveFolder(ref) {
    if (!ref) throw new Error("folder reference required");
    if (typeof ref === "string" && ref.includes(":") && !ref.startsWith("account")) {
      const idx = ref.indexOf(":");
      ref = { account: ref.slice(0, idx), path: ref.slice(idx + 1) };
    }
    if (typeof ref === "string") ref = { folderId: ref };
    if (ref.folderId) {
      const f = await messenger.folders.get(ref.folderId, true);
      if (!f) throw new Error("Unknown folder id: " + ref.folderId);
      return f;
    }
    const account = await AIC.getAccount(ref.account);
    if (!ref.path || ref.path.toLowerCase() === "inbox") {
      const inbox = AIC.findInbox(account);
      if (inbox && (!ref.path || !AIC.findFolderByPath(account, ref.path))) return inbox;
    }
    const f = AIC.findFolderByPath(account, ref.path);
    if (!f) throw new Error("Folder not found: " + account.name + ":" + ref.path);
    return f;
  },

  async ensureFolderPath(accountRef, path) {
    const account = await AIC.getAccount(accountRef);
    let parentId = account.rootFolder ? account.rootFolder.id : null;
    let candidates = AIC.topFolders(account);
    let current = null;
    const created = [];
    for (const part of AIC.pathParts(path)) {
      current = candidates.find((f) => f.name === part);
      if (!current) {
        if (!parentId) throw new Error("Cannot determine parent for " + part);
        current = await messenger.folders.create(parentId, part);
        created.push(part);
        candidates = [];
      } else {
        candidates = current.subFolders || [];
      }
      parentId = current.id;
    }
    return { folder: current, created };
  },

  pageOf(result) {
    if (Array.isArray(result)) return { id: null, messages: result };
    return { id: result && result.id ? result.id : null, messages: (result && result.messages) || [] };
  },

  async listAll(folderId, cap, progress) {
    const out = [];
    let page = AIC.pageOf(await messenger.messages.list(folderId));
    out.push(...page.messages);
    while (page.id && out.length < cap) {
      page = AIC.pageOf(await messenger.messages.continueList(page.id));
      out.push(...page.messages);
      if (progress) progress(out.length, null, "listing");
    }
    if (page.id && messenger.messages.abortList) {
      try { await messenger.messages.abortList(page.id); } catch (e) { /* ignore */ }
    }
    return out.slice(0, cap);
  },

  serializeMessage(m) {
    return {
      id: m.id,
      folderId: m.folder && m.folder.id ? m.folder.id : (m.folderId || null),
      author: m.author,
      recipients: m.recipients,
      subject: m.subject,
      date: m.date ? new Date(m.date).toISOString() : null,
      read: m.read,
      flagged: m.flagged,
      junk: m.junk,
      size: m.size,
      tags: m.tags || [],
      headerMessageId: m.headerMessageId
    };
  },

  extractEmail(author) {
    if (!author) return "";
    const m = String(author).match(/<([^>]+)>/);
    return (m ? m[1] : author).toLowerCase().trim().replace(/^"|"$/g, "");
  },

  matches(field, patterns, message) {
    const pats = (Array.isArray(patterns) ? patterns : [patterns]).map((p) => String(p).toLowerCase()).filter(Boolean);
    const values = [];
    if (field === "from" || field === "any") values.push(message.author || "");
    if (field === "subject" || field === "any") values.push(message.subject || "");
    if (field === "to") values.push((message.recipients || []).join(" "));
    for (const v of values) {
      const lv = String(v).toLowerCase();
      if (pats.some((p) => lv.includes(p))) return true;
    }
    return false;
  },

  ruleMatches(rule, message) {
    return AIC.matches(rule.field || "from", rule.patterns || rule.pattern, message);
  },

  async moveInBatches(ids, folderId, progress, label, batchSize) {
    const BATCH = batchSize || 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      await messenger.messages.move(ids.slice(i, i + BATCH), folderId);
      if (progress) progress(Math.min(i + BATCH, ids.length), ids.length, label || "moving");
    }
  },

  /* Walk a MessagePart tree and return plain text (prefer text/plain). */
  partText(part, wantHtml) {
    if (!part) return "";
    const ct = (part.contentType || "").toLowerCase();
    if (part.body && ct.startsWith("text/plain") && !wantHtml) return part.body;
    if (part.body && ct.startsWith("text/html") && wantHtml) return part.body;
    if (Array.isArray(part.parts)) {
      for (const p of part.parts) {
        const t = AIC.partText(p, wantHtml);
        if (t) return t;
      }
    }
    return "";
  },

  stripHtml(html) {
    return String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
      .replace(/\n{3,}/g, "\n\n").trim();
  },

  /* ---------- handlers ---------- */

  handlers: {
    async ping() {
      let tb = null;
      try { tb = await messenger.runtime.getBrowserInfo(); } catch (e) { /* ignore */ }
      return { ok: true, version: AIC.VERSION, thunderbird: tb ? tb.version : null, time: new Date().toISOString() };
    },

    async "accounts.list"(params) {
      const withCounts = !!(params && params.counts);
      const accounts = await messenger.accounts.list(true);
      const out = [];
      for (const a of accounts) {
        const folders = AIC.serializeFolders(AIC.topFolders(a), "");
        if (withCounts) {
          for (const f of AIC.flattenFolders(folders)) {
            try {
              const info = await messenger.folders.getFolderInfo(f.id);
              f.total = info.totalMessageCount;
              f.unread = info.unreadMessageCount;
            } catch (e) { /* ignore */ }
          }
        }
        const inbox = AIC.findInbox(a);
        out.push({
          id: a.id,
          name: a.name,
          type: a.type,
          identities: (a.identities || []).map((i) => ({ id: i.id, email: i.email, name: i.name })),
          rootFolderId: a.rootFolder ? a.rootFolder.id : null,
          inboxFolderId: inbox ? inbox.id : null,
          folders
        });
      }
      return out;
    },

    async "folders.list"(params) {
      const account = await AIC.getAccount(params.account);
      const folders = AIC.serializeFolders(AIC.topFolders(account), "");
      const flat = AIC.flattenFolders(folders);
      if (params.counts) {
        for (const f of flat) {
          try {
            const info = await messenger.folders.getFolderInfo(f.id);
            f.total = info.totalMessageCount;
            f.unread = info.unreadMessageCount;
            f.lastUsed = info.lastUsed ? new Date(info.lastUsed).toISOString() : null;
          } catch (e) { /* ignore */ }
        }
      }
      return { account: { id: account.id, name: account.name }, folders: flat };
    },

    async "folders.info"(params) {
      const folder = await AIC.resolveFolder(params.folder || params);
      const info = await messenger.folders.getFolderInfo(folder.id);
      return { id: folder.id, name: folder.name, path: folder.path, specialUse: folder.specialUse || [], ...info };
    },

    async "folders.ensure"(params) {
      const { folder, created } = await AIC.ensureFolderPath(params.account, params.path);
      return { id: folder.id, name: folder.name, path: folder.path, created };
    },

    async "folders.rename"(params) {
      const folder = await AIC.resolveFolder(params.folder);
      const f = await messenger.folders.rename(folder.id, params.newName);
      return { id: f.id, name: f.name, path: f.path };
    },

    async "folders.delete"(params) {
      const folder = await AIC.resolveFolder(params.folder);
      const info = await messenger.folders.getFolderInfo(folder.id);
      if (info.totalMessageCount > 0 && !params.force) {
        throw new Error("Folder is not empty (" + info.totalMessageCount + " messages); pass force=true");
      }
      await messenger.folders.delete(folder.id);
      return { deleted: true };
    },

    async "messages.list"(params, progress) {
      const folder = await AIC.resolveFolder(params.folder);
      const limit = Math.max(1, Math.min(params.limit || 100, 100000));
      const out = [];
      let page = params.cursor
        ? AIC.pageOf(await messenger.messages.continueList(params.cursor))
        : AIC.pageOf(await messenger.messages.list(folder.id));
      out.push(...page.messages);
      while (page.id && out.length < limit) {
        page = AIC.pageOf(await messenger.messages.continueList(page.id));
        out.push(...page.messages);
        if (progress) progress(out.length, null, "listing");
      }
      let msgs = out.map(AIC.serializeMessage);
      if (params.newestFirst !== false) msgs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return { folder: { id: folder.id, name: folder.name }, messages: msgs, cursor: page.id || null };
    },

    async "messages.query"(params, progress) {
      const q = {};
      const allowed = ["author", "subject", "recipients", "fromDate", "toDate", "unread", "flagged", "junk", "tags",
        "fullText", "body", "headerMessageId", "fromMe", "toMe", "attachment", "size", "new"];
      for (const k of allowed) if (params[k] !== undefined) q[k] = params[k];
      if (params.fromDate) q.fromDate = new Date(params.fromDate);
      if (params.toDate) q.toDate = new Date(params.toDate);
      if (params.folder) {
        const f = await AIC.resolveFolder(params.folder);
        q.folderId = f.id;
        if (params.includeSubFolders) q.includeSubFolders = true;
      } else if (params.account) {
        const a = await AIC.getAccount(params.account);
        q.accountId = a.id;
      }
      const limit = Math.max(1, Math.min(params.limit || 200, 100000));
      const out = [];
      let page = AIC.pageOf(await messenger.messages.query(q));
      out.push(...page.messages);
      while (page.id && out.length < limit) {
        page = AIC.pageOf(await messenger.messages.continueList(page.id));
        out.push(...page.messages);
        if (progress) progress(out.length, null, "querying");
      }
      if (page.id && messenger.messages.abortList) { try { await messenger.messages.abortList(page.id); } catch (e) { /* ignore */ } }
      const msgs = out.slice(0, limit).map(AIC.serializeMessage);
      msgs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return { messages: msgs, truncated: out.length > limit || !!page.id };
    },

    async "messages.get"(params) {
      const ids = Array.isArray(params.ids) ? params.ids : [params.id];
      const out = [];
      for (const id of ids) out.push(AIC.serializeMessage(await messenger.messages.get(id)));
      return out;
    },

    async "messages.read"(params) {
      const header = AIC.serializeMessage(await messenger.messages.get(params.id));
      const full = await messenger.messages.getFull(params.id);
      const headers = {};
      for (const [k, v] of Object.entries(full.headers || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      let text = AIC.partText(full, false);
      let html = params.html ? AIC.partText(full, true) : "";
      if (!text) text = AIC.stripHtml(AIC.partText(full, true));
      const maxChars = params.maxChars || 20000;
      const attachments = [];
      const walk = (p) => {
        if (p.name && p.contentType && !(p.contentType || "").startsWith("text/")) attachments.push({ name: p.name, contentType: p.contentType, size: p.size });
        (p.parts || []).forEach(walk);
      };
      walk(full);
      return {
        ...header,
        headers: params.allHeaders ? headers : {
          "list-unsubscribe": headers["list-unsubscribe"] || null,
          "list-id": headers["list-id"] || null,
          "precedence": headers["precedence"] || null,
          "auto-submitted": headers["auto-submitted"] || null,
          "reply-to": headers["reply-to"] || null,
          "to": headers["to"] || null
        },
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        html: html ? html.slice(0, maxChars) : undefined,
        attachments
      };
    },

    async "messages.move"(params, progress) {
      const dest = params.to && params.to.account && params.to.path
        ? (await AIC.ensureFolderPath(params.to.account, params.to.path)).folder
        : await AIC.resolveFolder(params.to);
      await AIC.moveInBatches(params.ids, dest.id, progress, "moving");
      return { moved: params.ids.length, to: { id: dest.id, name: dest.name, path: dest.path } };
    },

    async "messages.copy"(params, progress) {
      const dest = await AIC.resolveFolder(params.to);
      const BATCH = 100;
      for (let i = 0; i < params.ids.length; i += BATCH) {
        await messenger.messages.copy(params.ids.slice(i, i + BATCH), dest.id);
        if (progress) progress(Math.min(i + BATCH, params.ids.length), params.ids.length, "copying");
      }
      return { copied: params.ids.length };
    },

    async "messages.delete"(params, progress) {
      const BATCH = 100;
      for (let i = 0; i < params.ids.length; i += BATCH) {
        await messenger.messages.delete(params.ids.slice(i, i + BATCH), !!params.permanent);
        if (progress) progress(Math.min(i + BATCH, params.ids.length), params.ids.length, "deleting");
      }
      return { deleted: params.ids.length, permanent: !!params.permanent };
    },

    async "messages.archive"(params, progress) {
      const BATCH = 100;
      for (let i = 0; i < params.ids.length; i += BATCH) {
        await messenger.messages.archive(params.ids.slice(i, i + BATCH));
        if (progress) progress(Math.min(i + BATCH, params.ids.length), params.ids.length, "archiving");
      }
      return { archived: params.ids.length };
    },

    async "messages.update"(params, progress) {
      const props = {};
      for (const k of ["read", "flagged", "junk", "tags"]) if (params[k] !== undefined) props[k] = params[k];
      let done = 0;
      for (const id of params.ids) {
        await messenger.messages.update(id, props);
        done += 1;
        if (progress && done % 50 === 0) progress(done, params.ids.length, "updating");
      }
      return { updated: params.ids.length, props };
    },

    async "tags.list"() {
      const api = messenger.messages.tags && messenger.messages.tags.list ? messenger.messages.tags.list() : messenger.messages.listTags();
      return await api;
    },

    /* Aggregate statistics for a folder without shipping every header to the CLI. */
    async "scan.folder"(params, progress) {
      const folder = await AIC.resolveFolder(params.folder);
      const recentDays = params.recentDays || 365;
      const topN = params.top || 60;
      const cap = params.cap || 200000;
      const messages = await AIC.listAll(folder.id, cap, progress);
      const now = Date.now();
      const recentMs = recentDays * 864e5;
      const stats = { total: messages.length, unread: 0, flagged: 0, recent: 0, older: 0, oldest: null, newest: null };
      const years = new Map(), recentSenders = new Map(), allSenders = new Map(), recentDomains = new Map(), allDomains = new Map();
      const bump = (map, key, msg, isRecent) => {
        const e = map.get(key) || { count: 0, unread: 0, display: msg.author, samples: [], last: null };
        e.count += 1;
        if (msg.read === false) e.unread += 1;
        if (e.samples.length < 3 && msg.subject && !e.samples.includes(msg.subject)) e.samples.push(String(msg.subject).slice(0, 80));
        const d = msg.date ? new Date(msg.date).toISOString().slice(0, 10) : null;
        if (d && (!e.last || d > e.last)) e.last = d;
        map.set(key, e);
      };
      for (const m of messages) {
        if (m.read === false) stats.unread += 1;
        if (m.flagged) stats.flagged += 1;
        const d = m.date ? new Date(m.date) : null;
        let isRecent = false;
        if (d && !isNaN(d)) {
          years.set(d.getFullYear(), (years.get(d.getFullYear()) || 0) + 1);
          isRecent = now - d.getTime() <= recentMs;
          if (isRecent) stats.recent += 1; else stats.older += 1;
          if (!stats.oldest || d < stats.oldest) stats.oldest = d;
          if (!stats.newest || d > stats.newest) stats.newest = d;
        }
        const email = AIC.extractEmail(m.author);
        if (!email) continue;
        const domain = email.split("@")[1] || "";
        bump(allSenders, email, m, isRecent);
        if (domain) allDomains.set(domain, (allDomains.get(domain) || 0) + 1);
        if (isRecent) {
          bump(recentSenders, email, m, true);
          if (domain) recentDomains.set(domain, (recentDomains.get(domain) || 0) + 1);
        }
      }
      const senderList = (map) => [...map.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, topN)
        .map(([email, e]) => ({ email, domain: email.split("@")[1] || "", ...e }));
      const domainList = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([domain, count]) => ({ domain, count }));
      const result = {
        folder: { id: folder.id, name: folder.name, path: folder.path, accountId: folder.accountId },
        recentDays,
        stats: { ...stats, oldest: stats.oldest ? stats.oldest.toISOString().slice(0, 10) : null, newest: stats.newest ? stats.newest.toISOString().slice(0, 10) : null },
        years: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count })),
        recentSenders: senderList(recentSenders),
        allSenders: senderList(allSenders),
        recentDomains: domainList(recentDomains),
        allDomains: domainList(allDomains)
      };
      // Optionally probe one message per top recent sender for bulk-mail headers.
      if (params.probe) {
        const probeN = Math.min(params.probe === true ? 40 : params.probe, result.recentSenders.length);
        const byEmail = new Map();
        for (const m of messages) {
          const e = AIC.extractEmail(m.author);
          if (e && !byEmail.has(e)) byEmail.set(e, m.id);
        }
        for (let i = 0; i < probeN; i++) {
          const s = result.recentSenders[i];
          const id = byEmail.get(s.email);
          if (!id) continue;
          try {
            const full = await messenger.messages.getFull(id, { decrypt: false });
            const h = {};
            for (const [k, v] of Object.entries(full.headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
            s.bulk = !!(h["list-unsubscribe"] || h["list-id"] || /bulk|list/i.test(h["precedence"] || "") || /auto-/i.test(h["auto-submitted"] || ""));
            s.listUnsubscribe = h["list-unsubscribe"] ? String(h["list-unsubscribe"]).slice(0, 300) : null;
          } catch (e) {
            s.bulk = null;
          }
          if (progress) progress(i + 1, probeN, "probing headers");
        }
      }
      return result;
    },

    /* Rules stored in the extension and applied to new mail by background.js. */
    async "rules.get"() {
      const { rules } = await messenger.storage.local.get({ rules: [] });
      return Array.isArray(rules) ? rules : [];
    },

    async "rules.set"(params) {
      const rules = await AIC.normalizeRules(params.rules || []);
      await messenger.storage.local.set({ rules });
      return { saved: rules.length };
    },

    /* Evaluate rules against ONE account's inbox in bounded, resumable slices, moving as it goes.
     * Each call scans at most ~budgetMs of pages (resuming from a stored cursor) and moves at most
     * maxMoves messages, so it always returns under the host's response window even on a throttled
     * 25k+ inbox. report.done=false means "call me again" (the caller loops until done). Pass one
     * account's rules per call; if several accounts are passed, the first unfinished one is processed. */
    async "rules.run"(params, progress) {
      const rules = await AIC.normalizeRules(params.rules || []);
      const apply = !!params.apply;
      const budgetMs = params.budgetMs || 35000;
      const maxMoves = apply ? (params.maxMoves || 1000) : Infinity;
      const byAccount = new Map();
      for (const r of rules) {
        if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, []);
        byAccount.get(r.accountId).push(r);
      }
      const report = { apply, accounts: [], totalMatched: 0, totalMoved: 0, remaining: 0, done: true, errors: [] };
      const started = Date.now();

      for (const [accountId, accRules] of byAccount) {
        const account = await messenger.accounts.get(accountId, true);
        const source = params.sourceFolder
          ? await AIC.resolveFolder({ account: accountId, path: params.sourceFolder })
          : AIC.findInbox(account);
        const entry = { account: account.name, accountId, source: source ? source.name : null, scanned: 0, matched: 0, moved: 0, rules: [] };
        report.accounts.push(entry);
        if (!source) { entry.error = "no inbox"; continue; }

        // Resume this folder's scan from the stored cursor, or start fresh.
        const st = AIC._scan[source.id];
        let page = st && st.listId
          ? AIC.pageOf(await messenger.messages.continueList(st.listId).catch(() => AIC.pageOf(null)))
          : AIC.pageOf(await messenger.messages.list(source.id));
        if (st && st.listId && !page.messages.length && !page.id) {
          // stale cursor (session expired) — restart the scan
          page = AIC.pageOf(await messenger.messages.list(source.id));
        }

        const groups = new Map();
        for (const r of accRules) groups.set(r.id, { rule: r, ids: [], samples: [] });
        let matchedThisCall = 0;
        // Scan pages until the time budget or the move cap is reached, or the list is exhausted.
        while (true) {
          for (const m of page.messages) {
            entry.scanned += 1;
            const rule = accRules.find((r) => AIC.ruleMatches(r, m));
            if (!rule) continue;
            const g = groups.get(rule.id);
            g.ids.push(m.id);
            matchedThisCall += 1;
            if (g.samples.length < 3) g.samples.push({ author: m.author, subject: m.subject });
          }
          if (!page.id) break;                                   // list exhausted
          if (!apply) { page = AIC.pageOf(await messenger.messages.continueList(page.id)); continue; }
          if (matchedThisCall >= maxMoves) break;                // enough to move this call
          if (Date.now() - started > budgetMs) break;            // time budget hit
          page = AIC.pageOf(await messenger.messages.continueList(page.id));
        }

        entry.matched = matchedThisCall;
        if (apply) {
          for (const { rule, ids } of groups.values()) {
            const line = { field: rule.field, patterns: rule.patterns, dest: rule.dest, count: ids.length };
            entry.rules.push(line);
            if (!ids.length) continue;
            try {
              const { folder } = await AIC.ensureFolderPath(accountId, rule.dest);
              if (folder.id === source.id) { line.skipped = "destination is the source folder"; continue; }
              await AIC.moveInBatches(ids, folder.id, progress, account.name + " -> " + rule.dest, params.batchSize || 200);
              line.moved = ids.length;
              entry.moved += ids.length;
              report.totalMoved += ids.length;
            } catch (e) {
              line.error = e.message;
              report.errors.push({ account: account.name, dest: rule.dest, error: e.message });
            }
          }
        } else {
          for (const { rule, ids, samples } of groups.values())
            entry.rules.push({ field: rule.field, patterns: rule.patterns, dest: rule.dest, count: ids.length, samples });
        }
        report.totalMatched += entry.matched;

        // Save/clear the cursor. More to do on this folder if the list isn't exhausted.
        if (page.id) { AIC._scan[source.id] = { listId: page.id }; report.done = false; entry.more = true; }
        else { delete AIC._scan[source.id]; }

        // Only advance to the next account once this one's scan is exhausted; otherwise stop here.
        if (page.id) break;
      }
      return report;
    },

    /* Move old messages out of a folder into an archive path (optionally per year). */
    async "archive.run"(params, progress) {
      const account = await AIC.getAccount(params.account);
      const source = params.sourceFolder ? await AIC.resolveFolder({ account: account.id, path: params.sourceFolder }) : AIC.findInbox(account);
      if (!source) throw new Error("no source folder");
      // 0 is a valid age ("everything read, regardless of date"), so only a missing/invalid
      // value falls back to the default -- `||` would turn 0 into 365.
      const days = Number.isFinite(params.olderThanDays) && params.olderThanDays >= 0 ? params.olderThanDays : 365;
      const cutoff = Date.now() - days * 864e5;
      const readOnly = params.readOnly !== false;
      const byYear = !!params.byYear;
      const messages = await AIC.listAll(source.id, 200000, (n) => progress && progress(n, null, "listing"));
      const groups = new Map();
      let unreadSkipped = 0, flaggedSkipped = 0;
      for (const m of messages) {
        const d = m.date ? new Date(m.date) : null;
        if (!d || isNaN(d) || d.getTime() > cutoff) continue;
        if (readOnly && m.read === false) { unreadSkipped += 1; continue; }
        if (params.skipFlagged !== false && m.flagged) { flaggedSkipped += 1; continue; }
        const key = byYear ? params.dest + "/" + d.getFullYear() : params.dest;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m.id);
      }
      const maxMoves = params.apply ? (params.maxMoves || 1500) : Infinity;
      const report = { apply: !!params.apply, account: account.name, source: source.name, scanned: messages.length, olderThanDays: days, readOnly, unreadSkipped, flaggedSkipped, groups: [], totalMoved: 0, remaining: 0, done: true };
      for (const [path, ids] of [...groups.entries()].sort()) {
        const g = { dest: path, count: ids.length };
        report.groups.push(g);
        if (!params.apply) continue;
        const budget = maxMoves - report.totalMoved;
        if (budget <= 0) { g.deferred = ids.length; report.remaining += ids.length; report.done = false; continue; }
        const take = ids.slice(0, budget);
        const deferred = ids.length - take.length;
        try {
          const { folder } = await AIC.ensureFolderPath(account.id, path);
          if (folder.id === source.id) { g.skipped = "destination is source"; continue; }
          await AIC.moveInBatches(take, folder.id, progress, "archive -> " + path, params.batchSize || 200);
          g.moved = take.length;
          report.totalMoved += take.length;
          if (deferred) { g.deferred = deferred; report.remaining += deferred; report.done = false; }
        } catch (e) {
          g.error = e.message;
        }
      }
      return report;
    }
  },

  async normalizeRules(input) {
    const accounts = await messenger.accounts.list(false);
    const byName = new Map(accounts.map((a) => [a.name.toLowerCase(), a]));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return input.map((r, i) => {
      const acc = byId.get(r.accountId) || byName.get(String(r.account || "").toLowerCase());
      if (!acc) throw new Error("Rule " + (i + 1) + ": unknown account \"" + (r.account || r.accountId) + "\"");
      const patterns = Array.isArray(r.patterns) ? r.patterns : (r.pattern ? [r.pattern] : []);
      if (!patterns.length) throw new Error("Rule " + (i + 1) + ": no patterns");
      const dest = r.dest || r.destPath;
      if (!dest) throw new Error("Rule " + (i + 1) + ": no dest");
      const field = r.field || "from";
      if (!["from", "subject", "any", "to"].includes(field)) throw new Error("Rule " + (i + 1) + ": bad field " + field);
      return {
        id: r.id || ("r" + (i + 1) + "-" + Math.random().toString(36).slice(2, 8)),
        accountId: acc.id,
        account: acc.name,
        field,
        patterns,
        dest,
        note: r.note || ""
      };
    });
  }
};
