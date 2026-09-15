/* Derive release metadata from the repo itself, so publish.cmd hardcodes nothing.
 *
 * Usage: node scripts/release-meta.js <out.cmd> <notes.md>
 *   <out.cmd>  a generated batch file of `set "KEY=value"` lines, meant to be `call`ed
 *   <notes.md> the release notes body, for `gh release create --notes-file`
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [outCmd, notesFile] = process.argv.slice(2);
if (!outCmd || !notesFile) {
  console.error("usage: release-meta.js <out.cmd> <notes.md>");
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!version) throw new Error("package.json has no version");

/* owner/name from the git remote, so a fork or rename needs no edit here.
   Handles git@host:owner/name.git, https://host/owner/name.git and ssh://... */
function repoSlug() {
  let url = "";
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";                       // no remote yet -- publish.cmd will create the repo
  }
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}

/* Release notes = this version's CHANGELOG section, falling back to a generic line. */
function notesFor(v) {
  const file = path.join(root, "CHANGELOG.md");
  if (fs.existsSync(file)) {
    const md = fs.readFileSync(file, "utf8");
    // Grab from "## <version>" up to the next "## " heading.
    const re = new RegExp(`^##\\s+v?${v.replace(/\./g, "\\.")}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, "m");
    const m = md.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "Thunderbird extension (install the .xpi), plus the aiconnect CLI and MCP server. See CHANGELOG.md.";
}

const slug = repoSlug();
const notes = notesFor(version);
fs.writeFileSync(notesFile, notes + "\n");

/* ^ & | < > % ! are all live in cmd; strip them rather than trying to escape. */
const cmdSafe = (s) => String(s).replace(/[\^&|<>%!"]/g, "");
const lines = [
  "@echo off",
  `set "VER=${cmdSafe(version)}"`,
  `set "REPO=${cmdSafe(slug)}"`,
  `set "DESC=${cmdSafe(pkg.description || "")}"`,
  `set "XPI=dist\\aiconnect-${cmdSafe(version)}.xpi"`,
];
fs.writeFileSync(outCmd, lines.join("\r\n") + "\r\n");

console.log(`version ${version}` + (slug ? `, repo ${slug}` : ", no remote yet"));
