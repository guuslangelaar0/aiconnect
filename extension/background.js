/* AIConnect - background: WebSocket client to the local AIConnect CLI/MCP bridge.
 *
 * Protocol (JSON text frames):
 *   ext -> bridge  {"type":"hello","token":"...","client":"thunderbird","version":"0.1.0"}
 *   bridge -> ext  {"type":"welcome"}  |  {"type":"error","message":"bad token"}
 *   bridge -> ext  {"id":1,"method":"accounts.list","params":{...}}         (JSON-RPC style)
 *   ext -> bridge  {"id":1,"result":{...}} | {"id":1,"error":{"message":"..."}}
 *   ext -> bridge  {"method":"progress","params":{"id":1,"done":100,"total":500,"label":"moving"}}
 */

const DEFAULT_PORTS = [47800, 47801, 47802, 47803, 47804];
const DEFAULT_SETTINGS = { port: 47800, ports: DEFAULT_PORTS, token: "", enabled: true };
const state = { ws: null, connected: false, lastError: null, lastSeen: null, backoff: 1000, inflight: 0, log: [], port: null, probeIdx: 0 };

/* The ordered port list to try: explicit `ports`, else the stored single `port` first, then defaults. */
function portList(settings) {
  let ports = Array.isArray(settings.ports) && settings.ports.length ? settings.ports.slice() : [];
  if (!ports.length) ports = DEFAULT_PORTS.slice();
  const single = Number(settings.port);
  if (single && !ports.includes(single)) ports.unshift(single);
  return [...new Set(ports)];
}

function log(...args) {
  console.log(AIC.LOG, ...args);
  state.log.push(new Date().toISOString().slice(11, 19) + " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  if (state.log.length > 200) state.log.shift();
}

async function getSettings() {
  const { settings } = await messenger.storage.local.get({ settings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...settings };
}

function publishStatus() {
  messenger.storage.local.set({
    status: { connected: state.connected, port: state.port, lastError: state.lastError, lastSeen: state.lastSeen, inflight: state.inflight, log: state.log.slice(-40) }
  }).catch(() => {});
}

async function handleRequest(msg) {
  const handler = AIC.handlers[msg.method];
  const send = (obj) => { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); };
  if (!handler) return send({ id: msg.id, error: { message: "Unknown method: " + msg.method } });
  state.inflight += 1;
  publishStatus();
  let lastProgress = 0;
  const progress = (done, total, label) => {
    const now = Date.now();
    if (now - lastProgress < 250 && done !== total) return; // throttle
    lastProgress = now;
    send({ method: "progress", params: { id: msg.id, done, total, label } });
  };
  try {
    const result = await handler(msg.params || {}, progress);
    send({ id: msg.id, result });
  } catch (e) {
    log("error in", msg.method, e && e.message);
    send({ id: msg.id, error: { message: (e && e.message) || String(e) } });
  } finally {
    state.inflight -= 1;
    publishStatus();
  }
}

let reconnectTimer = null;

async function connect() {
  clearTimeout(reconnectTimer);
  const settings = await getSettings();
  if (!settings.enabled) { state.connected = false; publishStatus(); return; }
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
  const ports = portList(settings);
  const port = ports[state.probeIdx % ports.length]; // try each port in turn across reconnect ticks
  const url = "ws://127.0.0.1:" + port + "/";
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    state.lastError = e.message;
    state.probeIdx += 1;
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  let welcomed = false;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", token: settings.token, client: "thunderbird", version: AIC.VERSION }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "welcome") {
      welcomed = true;
      state.connected = true;
      state.port = port;
      state.lastError = null;
      state.lastSeen = new Date().toISOString();
      state.backoff = 1000;
      log("connected to bridge on port", port);
      publishStatus();
      return;
    }
    if (msg.type === "error") {
      state.lastError = msg.message;
      log("bridge on " + port + " refused:", msg.message);
      state.probeIdx += 1; // wrong token or not-a-hub: move to the next port
      publishStatus();
      return;
    }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.method && msg.id !== undefined) {
      state.lastSeen = new Date().toISOString();
      handleRequest(msg);
    }
  };
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = () => {
    if (state.connected) log("disconnected from port", state.port);
    else state.probeIdx += 1; // nothing listened here; try the next port next tick
    state.connected = false;
    state.ws = null;
    publishStatus();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, state.backoff);
  state.backoff = Math.min(state.backoff * 1.5, 5000);
}

/* Settings changes from the options page: reconnect. */
messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    state.backoff = 500;
    if (state.ws) { try { state.ws.close(); } catch (e) { /* ignore */ } }
    else connect();
  }
});

messenger.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "reconnect") { state.backoff = 300; state.probeIdx = 0; if (state.ws) state.ws.close(); else connect(); return Promise.resolve({ ok: true }); }
  if (msg && msg.type === "status") return Promise.resolve({ connected: state.connected, port: state.port, lastError: state.lastError, lastSeen: state.lastSeen, log: state.log.slice(-40) });
  return false;
});

/* Ongoing rules: apply to new mail arriving in an inbox. */
async function applyRulesToNewMail(folder, messages) {
  const { rules } = await messenger.storage.local.get({ rules: [] });
  const accRules = (rules || []).filter((r) => r.accountId === folder.accountId);
  if (!accRules.length) return;
  const byDest = new Map();
  for (const m of messages) {
    const rule = accRules.find((r) => AIC.ruleMatches(r, m));
    if (!rule) continue;
    if (!byDest.has(rule.dest)) byDest.set(rule.dest, []);
    byDest.get(rule.dest).push(m.id);
  }
  for (const [dest, ids] of byDest) {
    try {
      const { folder: f } = await AIC.ensureFolderPath(folder.accountId, dest);
      if (f.id === folder.id) continue;
      await AIC.moveInBatches(ids, f.id);
      log("auto-sorted", ids.length, "->", dest);
    } catch (e) {
      log("auto-sort failed", dest, e.message);
    }
  }
}

messenger.messages.onNewMailReceived.addListener((folder, messageList) => {
  if (!AIC.isInbox(folder)) return;
  const msgs = AIC.pageOf(messageList).messages;
  if (msgs.length) applyRulesToNewMail(folder, msgs);
});

log("background started");
connect();
