/* Minimal end-to-end test: bridge + mock extension + api + suggest. Run: npm test */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/bridge.js";
import * as api from "../src/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 47899, TOKEN = "t-" + Math.random().toString(36).slice(2);

const bridge = new Bridge({ port: PORT, token: TOKEN, connectTimeout: 5000 });
await bridge.start();
const mock = spawn(process.execPath, [path.join(__dirname, "mock-extension.js"), String(PORT), TOKEN], { stdio: "ignore" });
try {
  await bridge.waitForConnection();
  const ping = await api.ping(bridge);
  assert.equal(ping.ok, true);

  const accounts = await api.listAccounts(bridge);
  assert.equal(accounts.length, 1);

  const scan = await api.scanAccounts(bridge, { recentDays: 365 });
  assert.ok(scan.accounts[0].inbox.stats.total > 0);

  const sug = api.suggestFromScan(scan, { lang: "en" });
  const rules = sug.accounts.flatMap((a) => a.rules);
  assert.ok(rules.length >= 3, "expected some rules");
  assert.ok(rules.some((r) => r.dest === "Inbox/Boekhouding"), "should reuse existing Boekhouding for receipts");
  assert.ok(rules.some((r) => /Social/.test(r.dest)), "linkedin -> social");

  const dry = await api.runRules(bridge, rules, { apply: false });
  assert.equal(dry.apply, false);
  assert.ok(dry.totalMatched > 0);

  const applied = await api.runRules(bridge, rules, { apply: true });
  assert.equal(applied.totalMoved, dry.totalMatched);

  const arch = await api.runArchive(bridge, { account: "test@example.com", dest: "Inbox/Archive", byYear: true, apply: false });
  assert.equal(arch.apply, false);

  // bad token is refused
  const bad = new Bridge({ port: PORT + 1, token: "right", connectTimeout: 1500 });
  await bad.start();
  const badMock = spawn(process.execPath, [path.join(__dirname, "mock-extension.js"), String(PORT + 1), "wrong"], { stdio: "ignore" });
  await assert.rejects(bad.waitForConnection(), /did not connect/);
  badMock.kill();
  await bad.stop();

  console.log("ok: bridge, scan, suggest, rules, archive, auth");
} finally {
  mock.kill();
  await bridge.stop();
}
