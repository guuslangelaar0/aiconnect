/* Human-readable renderers for CLI output. Everything also has a --json path. */

const pad = (s, n) => String(s).padStart(n);
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export function renderAccounts(accounts) {
  const lines = [];
  for (const a of accounts) {
    lines.push(`${a.name}  [${a.type}]  id=${a.id}`);
    const walk = (folders, depth) => {
      for (const f of folders) {
        const su = f.specialUse && f.specialUse.length ? ` (${f.specialUse.join(",")})` : "";
        const counts = typeof f.total === "number" ? `  ${f.total}${f.unread ? ` / ${f.unread} unread` : ""}` : "";
        lines.push(`${"  ".repeat(depth + 1)}${f.name}${su}${counts}`);
        if (f.subFolders && f.subFolders.length) walk(f.subFolders, depth + 1);
      }
    };
    walk(a.folders || [], 0);
  }
  return lines.join("\n");
}

export function renderFolders(result) {
  const lines = [`${result.account.name}`];
  for (const f of result.folders) {
    const su = f.specialUse && f.specialUse.length ? ` (${f.specialUse.join(",")})` : "";
    const counts = typeof f.total === "number" ? `${pad(f.total, 7)}${f.unread ? ` (${f.unread} unread)` : ""}` : pad("?", 7);
    lines.push(`${counts}  ${f.path}${su}`);
  }
  return lines.join("\n");
}

export function renderScan(scan, { senders = 25 } = {}) {
  const lines = [`AICONNECT SCAN ${scan.generatedAt}  (recent = last ${scan.recentDays} days)`, ""];
  for (const acc of scan.accounts) {
    lines.push(`=== ${acc.account.name} (${acc.account.type}) ===`);
    lines.push("Folders:");
    for (const f of acc.folders) {
      const su = f.specialUse && f.specialUse.length ? ` [${f.specialUse.join(",")}]` : "";
      lines.push(`  ${f.path}${su}: ${typeof f.total === "number" ? f.total : "?"}${f.unread ? ` (${f.unread} unread)` : ""}`);
    }
    if (!acc.inbox) { lines.push("Inbox: none", ""); continue; }
    const s = acc.inbox.stats;
    lines.push(`Inbox: ${s.total} messages, ${s.unread} unread, ${s.flagged} flagged, ${s.recent} recent, ${s.older} older, range ${s.oldest} .. ${s.newest}`);
    lines.push(`Per year: ${acc.inbox.years.map((y) => `${y.year}=${y.count}`).join(", ")}`);
    lines.push(`Recent top domains: ${acc.inbox.recentDomains.slice(0, 20).map((d) => `${d.domain} ${d.count}`).join(", ")}`);
    lines.push("Recent top senders:");
    for (const t of acc.inbox.recentSenders.slice(0, senders)) {
      const bulk = t.bulk === true ? " [bulk]" : t.bulk === false ? " [direct]" : "";
      lines.push(`  ${pad(t.count, 5)}${t.unread ? ` (${t.unread} unread)` : ""}  ${trunc(t.display, 60)}${bulk}  | ${t.samples.map((x) => trunc(x, 50)).join(" | ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderSuggestion(sug) {
  const lines = [];
  for (const a of sug.accounts) {
    lines.push(`=== ${a.account} ===  inbox ${a.inboxTotal} (recent ${a.recentTotal})${a.prefix ? `, folders live under "${a.prefix}/"` : ""}`);
    lines.push("Folders:");
    for (const f of a.folders) lines.push(`  ${f.existing ? "keep " : "NEW  "} ${f.path}   (${f.reason})`);
    lines.push("Rules (first match wins):");
    for (const r of a.rules) lines.push(`  ${r.field} ~ [${r.patterns.join(", ")}]  ->  ${r.dest}${r.note ? `   # ${r.note}` : ""}`);
    lines.push(`Archive: ${a.archive.candidates} inbox messages older than ${a.archive.olderThanDays} days -> ${a.archive.dest}${a.archive.byYear ? "/<year>" : ""}   (${a.archive.note})`);
    if (a.unsubscribe.length) {
      lines.push("Unsubscribe candidates:");
      for (const u of a.unsubscribe.slice(0, 25)) lines.push(`  ${pad(u.count, 5)}  ${trunc(u.display, 60)}${u.listUnsubscribe ? "  (List-Unsubscribe present)" : ""}`);
    }
    if (a.peopleKeptInInbox.length) lines.push(`People left in inbox: ${a.peopleKeptInInbox.map((p) => p.email).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderRulesReport(report) {
  const lines = [];
  for (const a of report.accounts) {
    lines.push(`=== ${a.account} ===  ${a.source || "?"}: ${a.scanned} scanned, ${a.matched} matched, ${a.unmatched} unmatched${a.error ? `  ERROR ${a.error}` : ""}`);
    for (const r of a.rules) {
      const status = r.error ? `  ERROR ${r.error}` : r.skipped ? `  SKIPPED ${r.skipped}` : r.moved !== undefined ? `  moved ${r.moved}` : "";
      lines.push(`  ${pad(r.count, 6)}  ${r.field} ~ [${trunc(r.patterns.join(", "), 70)}]  ->  ${r.dest}${status}`);
    }
  }
  lines.push("", `${report.apply ? "Applied" : "Dry run"}: ${report.totalMatched} matched${report.apply ? `, ${report.totalMoved} moved` : ""}${report.remaining ? `, ${report.remaining} deferred to next call` : ""}${report.errors.length ? `, ${report.errors.length} errors` : ""}${report.apply ? `  [done=${report.done !== false}]` : ""}`);
  return lines.join("\n");
}

export function renderArchiveReport(r) {
  const lines = [`=== ${r.account} ===  ${r.source}: ${r.scanned} scanned; older than ${r.olderThanDays} days${r.readOnly ? ", read only" : ""}: ${r.groups.reduce((n, g) => n + g.count, 0)} (unread skipped ${r.unreadSkipped}, flagged skipped ${r.flaggedSkipped})`];
  for (const g of r.groups) lines.push(`  ${pad(g.count, 6)}  -> ${g.dest}${g.moved !== undefined ? `  moved ${g.moved}` : ""}${g.deferred ? `  (${g.deferred} deferred)` : ""}${g.error ? `  ERROR ${g.error}` : ""}${g.skipped ? `  SKIPPED ${g.skipped}` : ""}`);
  lines.push(r.apply ? `Archived ${r.totalMoved}${r.remaining ? `, ${r.remaining} deferred` : ""}  [done=${r.done !== false}]` : "Dry run.");
  return lines.join("\n");
}

export function renderMessages(list) {
  const lines = [];
  for (const m of list) {
    lines.push(`${m.id}  ${(m.date || "").slice(0, 10)}  ${m.read === false ? "*" : " "}${m.flagged ? "!" : " "}  ${trunc(m.author, 40).padEnd(40)}  ${trunc(m.subject, 70)}`);
  }
  return lines.join("\n");
}
