/* Heuristic folder + rule suggestions from a scan result.
 * Input: the output of `scanAccounts()` (see commands/scan.js): per account, folders and inbox stats.
 * Output: { accounts: [{ account, prefix, existingFolders, folders: [...new], rules: [...], archive, unsubscribe: [...] }] }
 *
 * Design goals (what is "often recommended"):
 *  - Inbox holds only things that need a human. Everything automated leaves.
 *  - Few top-level categories, vendor sub-folders only for high-volume senders.
 *  - Reuse folders the user already has (synonyms below) instead of inventing parallel ones.
 *  - Old mail is archived per year, never deleted.
 */

export const CATEGORIES = {
  receipts: {
    label: { en: "Receipts", nl: "Bonnen" },
    synonyms: ["receipts", "bonnen", "boekhouding", "facturen", "invoices", "administratie", "administration", "finance", "financieel", "billing"],
    from: ["invoice", "factuur", "facturen", "billing", "receipt", "payments", "payment", "accounting", "administratie", "crediteuren", "debiteuren", "salaris", "salary", "statements"],
    subject: ["invoice", "factuur", "receipt", "betaling", "payment", "bon ", "kwitantie", "loonstrook", "your receipt", "bestelbevestiging"]
  },
  orders: {
    label: { en: "Orders", nl: "Bestellingen" },
    synonyms: ["orders", "bestellingen", "shopping", "aankopen", "purchases"],
    from: ["dhl", "postnl", "dpd.", "ups.com", "fedex", "gls-", "bol.com", "amazon.", "aliexpress", "coolblue", "zalando", "klarna", "verzending", "shipping", "orders@", "order@", "bestelling", "pakket"],
    subject: ["bestelling", "your order", "je pakket", "uw pakket", "shipped", "verzonden", "bezorgd", "delivered", "tracking", "op weg", "onderweg", "order confirmation", "bezorger"]
  },
  newsletters: {
    label: { en: "Newsletters", nl: "Nieuwsbrieven" },
    synonyms: ["newsletters", "nieuwsbrieven", "news", "reclame", "ads", "promotions", "marketing", "mailings"],
    from: ["newsletter", "nieuwsbrief", "news@", "marketing", "promo", "deals@", "mailing", "campaign", "digest", "enews", "nieuws@"],
    domainPrefix: ["e.", "em.", "edm.", "email.", "e-mail.", "mail.", "news.", "info.", "hello.", "go.", "mailer.", "m.", "emails.", "nieuwsbrief.", "newsletter.", "club-", "link-", "vip.", "my."],
    subject: ["korting", "% off", "sale", "aanbieding", "deal", "nieuwsbrief", "newsletter", "unsubscribe", "uitschrijven", "webinar", "laatste kans", "last chance", "gratis", "win "]
  },
  notifications: {
    label: { en: "Notifications", nl: "Meldingen" },
    synonyms: ["notifications", "meldingen", "systems", "system", "automated", "alerts", "server", "monitoring"],
    from: ["noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "notification", "notifications", "alerts", "alert@", "mailer-daemon", "automated", "system@", "robot", "bot@", "monitoring", "status@", "updates@", "verify", "security"],
    subject: ["security alert", "beveiligingsmelding", "verification code", "verificatiecode", "your code", "je code", "password", "wachtwoord", "login", "inloggen", "sign-in", "backup", "report", "alert", "warning", "recovered", "down:", "up:", "expir"]
  },
  social: {
    label: { en: "Social", nl: "Social" },
    synonyms: ["social", "sociaal", "social media"],
    from: ["linkedin", "facebookmail", "facebook.com", "twitter.com", "x.com", "instagram", "reddit", "snapchat", "pinterest", "youtube", "tiktok", "discord", "whatsapp", "meetup", "strava", "nextdoor", "threads.net"],
    subject: []
  },
  dev: {
    label: { en: "Dev", nl: "Dev" },
    synonyms: ["dev", "development", "developer", "code", "engineering", "tech"],
    from: ["github", "gitlab", "bitbucket", "sentry", "docker", "npmjs", "vercel", "netlify", "heroku", "amazonaws", "azure", "hetzner", "digitalocean", "cloudflare", "atlassian", "jira", "expo.dev", "testflight", "apple developer", "developer@", "play-developer", "openai", "anthropic", "claude.com", "huggingface", "ngrok", "grafana", "datadog", "pagerduty", "plesk", "transip", "letsencrypt", "netdata", "proxmox", "wordpress@", "stripe.com", "twilio", "mollie", "supabase", "firebase", "railway", "render.com", "fly.io", "tailscale", "1password", "bitwarden"],
    subject: ["run failed", "build failed", "pull request", "merge request", "deploy", "pipeline", "certificate", "vulnerab", "scan report", "backup successful", "cron"]
  },
  jobs: {
    label: { en: "Jobs", nl: "Vacatures" },
    synonyms: ["jobs", "vacatures", "recruiting", "careers", "werk"],
    from: ["jobalerts", "jobs-noreply", "jobs-listings", "indeed", "glassdoor", "monsterboard", "recruit", "werkzoeken", "stageplaza", "freelance.nl", "upwork", "toptal"],
    subject: ["vacature", "job alert", "new jobs", "nieuwe banen", "solliciteer", "apply now", "we're hiring", "opdracht"]
  },
  government: {
    label: { en: "Government", nl: "Overheid" },
    synonyms: ["government", "overheid", "gemeente", "belasting", "tax"],
    from: ["overheid.nl", "belastingdienst", "kvk.nl", "gemeente", "rijksoverheid", "digid", "mijnoverheid", "rdw.nl", "duo.nl", "svb.nl", "uwv.nl", "cbr.nl", "kadaster", "waterschap", "irs.gov", "gov.uk", ".gov"],
    subject: ["aangifte", "belasting", "toeslag", "uittreksel", "bericht van", "berichtenbox"]
  },
  finance: {
    label: { en: "Finance", nl: "Financieel" },
    synonyms: ["finance", "financieel", "bank", "banking", "geld", "money", "beleggen", "investing"],
    from: ["bunq", "ing.nl", "rabobank", "abnamro", "snsbank", "asnbank", "triodos", "knab", "revolut", "n26", "wise.com", "paypal", "degiro", "coinbase", "kraken", "binance", "okx", "bitvavo", "brand new day", "hypotheek", "mortgage", "verzekering", "insurance", "centraalbeheer", "independer", "zonneplan", "energie", "odido", "kpn", "ziggo", "t-mobile", "vodafone"],
    subject: ["saldo", "afschrift", "statement", "transactie", "polis", "premie", "hypotheek", "energiecontract", "termijnbedrag"]
  },
  housing: {
    label: { en: "Housing", nl: "Wonen" },
    synonyms: ["housing", "wonen", "huis", "home", "verhuizing"],
    from: ["funda", "huispedia", "pararius", "makelaar", "nieuwbouw", "whoon", "jaap.nl", "zoopla", "rightmove", "zillow", "immobilien"],
    subject: ["nieuwbouw", "woning", "makelaar", "bezichtiging", "kavel", "bouwnummer"]
  },
  family: {
    label: { en: "Family", nl: "Gezin" },
    synonyms: ["family", "gezin", "familie", "kids", "kinderen", "school"],
    from: ["kinderopvang", "kdv", "school", "bso", "consultatiebureau", "ggd", "zwanger", "babydump", "baby-dump", "prenatal", "parro", "schoudercom", "social schools"],
    subject: ["ouderavond", "schoolreis", "kinderopvang", "opvang"]
  }
};

const HUMAN_DOMAINS = ["gmail.com", "hotmail.com", "outlook.com", "live.nl", "live.com", "icloud.com", "me.com", "yahoo.com", "ziggo.nl", "kpnmail.nl", "home.nl", "protonmail.com", "proton.me", "hetnet.nl", "planet.nl", "xs4all.nl", "upcmail.nl", "casema.nl", "quicknet.nl", "chello.nl"];
const NOREPLY = /(^|[._-])(no-?_?reply|noreply|donotreply|do-not-reply|notifications?|alerts?|newsletter|nieuwsbrief|marketing|promo|news|mailer|updates?|info|hello|team|support|billing|invoice|factuur|automail|notificatie|service)([._-]|@|$)/i;

export function classifySender(sender) {
  // sender: { email, domain, display, count, samples[], bulk? }
  const email = (sender.email || "").toLowerCase();
  const local = email.split("@")[0] || "";
  const domain = sender.domain || email.split("@")[1] || "";
  const display = (sender.display || "").toLowerCase();
  const subjects = (sender.samples || []).join(" | ").toLowerCase();
  const hay = email + " " + display;
  const scores = {};
  for (const [cat, def] of Object.entries(CATEGORIES)) {
    let s = 0;
    const w = cat === "notifications" ? 0.5 : 3; // automation markers are weak evidence; identity wins
    for (const p of def.from) if (hay.includes(p)) s += w;
    for (const p of def.domainPrefix || []) if (domain.startsWith(p)) s += 2; // marketing-style subdomain: suggestive, not decisive
    const subjW = cat === "notifications" ? 0.25 : (cat === "receipts" || cat === "orders") ? 2.5 : 1; // transactional subjects are strong evidence
    for (const p of def.subject) if (subjects.includes(p)) s += subjW;
    if (s) scores[cat] = s;
  }
  // Bulk header evidence pushes towards newsletters unless it's clearly something else.
  if (sender.bulk === true) scores.newsletters = (scores.newsletters || 0) + 2;
  // A human-looking sender: personal mailbox domain and no automation markers.
  const looksHuman = HUMAN_DOMAINS.includes(domain) && !NOREPLY.test(local) && !sender.bulk;
  if (looksHuman) return { category: "people", confidence: 0.8, scores };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    // automated-looking but unknown vendor → notifications; else leave in inbox (people)
    if (NOREPLY.test(local) || sender.bulk) return { category: "notifications", confidence: 0.4, scores };
    return { category: "people", confidence: 0.3, scores };
  }
  const [cat, score] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  return { category: cat, confidence: Math.min(1, (score - second + 1) / 6), scores };
}

/* Pick an existing folder for a category (by synonym), else propose a new one. */
function pickFolder(category, existing, prefix, lang) {
  const def = CATEGORIES[category];
  const lower = existing.map((f) => ({ f, name: f.name.toLowerCase(), path: f.path.toLowerCase() }));
  // Prefer a top-level (or prefix-level) folder whose name is a synonym.
  for (const syn of def.synonyms) {
    const hit = lower.find((x) => x.name === syn && (x.path === (prefix ? prefix.toLowerCase() + "/" : "") + syn));
    if (hit) return { path: hit.f.path, existing: true };
  }
  for (const syn of def.synonyms) {
    const hit = lower.find((x) => x.name === syn);
    if (hit) return { path: hit.f.path, existing: true };
  }
  return { path: (prefix ? prefix + "/" : "") + (def.label[lang] || def.label.en), existing: false };
}

function vendorName(sender) {
  const disp = (sender.display || "").replace(/<.*$/, "").replace(/"/g, "").replace(/\b(via|from)\b.*$/i, "").trim();
  if (disp && !disp.includes("@") && disp.length <= 24 && disp.split(/\s+/).length <= 2) return disp.replace(/[\/\\:*?"<>|]/g, "-");
  const domain = sender.domain || "";
  const core = domain.split(".").filter((p) => !["com", "nl", "net", "org", "io", "co", "uk", "de", "eu", "mail", "email", "e", "em", "edm", "news", "info", "hello"].includes(p));
  const name = core[core.length - 1] || domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/* Main entry. scan = { accounts: [{ account: {id,name}, folders:[{path,name,specialUse,total}], inbox: scanFolderResult }] } */
export function suggest(scan, { lang = "en", vendorThreshold = 25, minCount = 3, archiveDays = 365 } = {}) {
  const out = { lang, accounts: [] };
  for (const acc of scan.accounts) {
    if (!acc.inbox) continue;
    const existing = acc.folders || [];
    const inbox = existing.find((f) => f.specialUse && f.specialUse.includes("inbox"));
    // Dovecot-style namespaces put everything under Inbox/; detect and keep it.
    const prefix = inbox && existing.some((f) => f.path.startsWith(inbox.path + "/")) ? inbox.path : "";
    const gmailAllMail = existing.find((f) => (f.specialUse || []).includes("archives") && /all mail|alle e-mail|alle berichten/i.test(f.name));
    const senders = acc.inbox.recentSenders || [];
    const domainCats = new Map();
    for (const s of senders) {
      if (s.count < minCount) continue;
      const c = classifySender(s).category;
      if (!domainCats.has(s.domain)) domainCats.set(s.domain, new Set());
      domainCats.get(s.domain).add(c);
    }
    const ownDomains = new Set((acc.account.identities || []).map((i) => (i.email || "").split("@")[1]).filter(Boolean));
    const patternFor = (s, category) => {
      const shared = domainCats.get(s.domain) && domainCats.get(s.domain).size > 1;
      if (HUMAN_DOMAINS.includes(s.domain) || ownDomains.has(s.domain) || shared) return s.email;
      const parts = s.domain.split(".");
      return parts.length > 2 && !/^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts.slice(-2).join(".") : s.domain;
    };
    const byCategory = new Map();
    const vendors = [];
    const unsubscribe = [];
    const people = [];
    for (const s of senders) {
      if (s.count < minCount) continue;
      const { category, confidence } = classifySender(s);
      if (category === "people") { people.push({ email: s.email, count: s.count }); continue; }
      const entry = { email: s.email, domain: s.domain, display: s.display, count: s.count, category, confidence, samples: s.samples };
      if (category === "newsletters" || (s.bulk === true && category !== "receipts" && category !== "orders" && category !== "dev")) {
        unsubscribe.push({ email: s.email, display: s.display, count: s.count, listUnsubscribe: s.listUnsubscribe || null });
      }
      if (s.count >= vendorThreshold && ["notifications", "dev", "newsletters", "social"].includes(category)) {
        vendors.push(entry);
      } else {
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push(entry);
      }
    }
    const folders = [];
    const rules = [];
    const seenFolders = new Set();
    // Vendor sub-folders first (more specific rules win because they come first).
    for (const v of vendors) {
      const base = pickFolder(v.category, existing, prefix, lang);
      const path = base.path + "/" + vendorName(v);
      if (!seenFolders.has(path)) { seenFolders.add(path); folders.push({ path, existing: existing.some((f) => f.path === path), reason: v.count + " msgs/yr from " + v.email }); }
      // Match on domain when the domain is specific enough, else on the exact address.
      const pattern = patternFor(v, v.category);
      rules.push({ account: acc.account.name, field: "from", patterns: [pattern], dest: path, note: v.category + " (" + v.count + "/yr)" });
    }
    // Category folders with grouped patterns.
    for (const [category, entries] of byCategory) {
      const { path, existing: isExisting } = pickFolder(category, existing, prefix, lang);
      if (!seenFolders.has(path)) { seenFolders.add(path); folders.push({ path, existing: isExisting, reason: entries.length + " senders, " + entries.reduce((n, e) => n + e.count, 0) + " msgs/yr" }); }
      const patterns = [...new Set(entries.map((e) => patternFor(e, category)))];
      rules.push({ account: acc.account.name, field: "from", patterns, dest: path, note: category });
    }
    // Archive proposal.
    const stats = acc.inbox.stats || {};
    const archive = {
      olderThanDays: archiveDays,
      candidates: stats.older || 0,
      dest: gmailAllMail ? gmailAllMail.path : (prefix ? prefix + "/" : "") + (lang === "nl" ? "Archief" : "Archive"),
      byYear: !gmailAllMail,
      note: gmailAllMail ? "Gmail: moving out of Inbox is 'archive'; messages stay in All Mail" : "per-year subfolders keep folders small"
    };
    out.accounts.push({
      account: acc.account.name,
      prefix,
      inboxTotal: stats.total || 0,
      recentTotal: stats.recent || 0,
      folders,
      rules,
      archive,
      unsubscribe: unsubscribe.sort((a, b) => b.count - a.count),
      peopleKeptInInbox: people.slice(0, 20)
    });
  }
  return out;
}
