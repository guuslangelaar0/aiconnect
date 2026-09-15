/* Bridge: the local endpoint the Thunderbird extension dials into.
 *
 * Exactly one aiconnect process can own the port ("hub"). Any other aiconnect process
 * (a second MCP lane, a CLI command while `aiconnect mcp` runs) connects to the hub as a
 * "peer" and relays its calls through it. Both modes expose the same API:
 *   start() -> waitForConnection() -> call(method, params, {onProgress}) -> stop()
 *
 * Wire format (JSON text frames):
 *   client -> hub   {"type":"hello","token":"...","client":"thunderbird"|"peer","version":"..."}
 *   hub -> client   {"type":"welcome","role":"extension"|"peer"} | {"type":"error","message":"..."}
 *   hub -> ext      {"id":N,"method":"...","params":{...}}         ext -> hub  {"id":N,"result"|"error"}
 *   ext -> hub      {"method":"progress","params":{"id":N,"done":..,"total":..,"label":".."}}
 *   peer -> hub     {"id":M,"method":"...","params":{...}}          (relayed to ext with a hub id)
 *   peer -> hub     {"id":M,"method":"_hub.status"}                 hub answers locally
 */
import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";

export class BridgeError extends Error {
  constructor(message, code) { super(message); this.code = code || "BRIDGE"; }
}

const NO_CLIENT_MSG = (t) => "Thunderbird did not connect within " + Math.round(t / 1000) + "s. Check: Thunderbird is running, the AIConnect extension is installed and enabled, and its port/token match (`aiconnect pair`).";

export class Bridge extends EventEmitter {
  constructor({ port, ports, token, connectTimeout = 20000, callTimeout = 0, onProgress } = {}) {
    super();
    this.ports = (Array.isArray(ports) && ports.length ? ports : [port]).filter(Boolean);
    this.port = this.ports[0]; // resolved to the actual port after start()
    this.token = token;
    this.connectTimeout = connectTimeout;
    this.callTimeout = callTimeout; // 0 = none (moves can take minutes)
    this.onProgress = onProgress;
    this.mode = null;        // "hub" | "peer"
    this.socket = null;      // hub: extension socket; peer: socket to hub
    this.wss = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer, onProgress}   (our own calls)
    this.forwarded = new Map(); // hubId -> {peer, peerId}                       (hub relaying for peers)
    this.peers = new Set();
    this.extConnected = false;  // peer mode: last known hub->extension state
  }

  /* Walk the port list and settle on the lowest port that is either free (become hub) or already
   * hosts an aiconnect hub with our token (become peer). Ports held by unrelated services are skipped. */
  async start() {
    if (this.mode) return this.mode;
    let lastErr = null;
    for (const port of this.ports) {
      try {
        await this._listen(port);
        this.port = port;
        this.mode = "hub";
        return this.mode;
      } catch (e) {
        if (e.code !== "EADDRINUSE") throw e;
        try {
          await this._attachAsPeer(port);
          this.port = port;
          this.mode = "peer";
          return this.mode;
        } catch (e2) {
          lastErr = e2; // not an aiconnect hub (or wrong token) on this port; try the next
        }
      }
    }
    throw new BridgeError("No usable port in [" + this.ports.join(", ") + "]" + (lastErr ? ": " + lastErr.message : "") + ". Every port is held by a non-AIConnect process.", "NO_PORT");
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      wss.on("error", (e) => { if (e.code === "EADDRINUSE") reject(Object.assign(new BridgeError("Port " + port + " in use", "EADDRINUSE"), { code: "EADDRINUSE" })); else reject(e); });
      wss.on("listening", () => { this.wss = wss; resolve(); });
      wss.on("connection", (ws) => this._onHubConnection(ws));
    });
  }

  /* ---------- hub side ---------- */

  _onHubConnection(ws) {
    let role = null;
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!role) {
        if (msg.type !== "hello" || !this.token || msg.token !== this.token) {
          ws.send(JSON.stringify({ type: "error", message: this.token ? "bad token" : "bridge has no token; run `aiconnect pair`" }));
          setTimeout(() => ws.close(), 100);
          return;
        }
        role = msg.client === "peer" ? "peer" : "extension";
        if (role === "extension") {
          if (this.socket && this.socket !== ws) { try { this.socket.close(); } catch (e) { /* ignore */ } }
          this.socket = ws;
          ws.send(JSON.stringify({ type: "welcome", role }));
          this.emit("connected", { client: msg.client, version: msg.version });
          for (const p of this.peers) this._safeSend(p, { type: "ext_status", connected: true });
        } else {
          this.peers.add(ws);
          ws.send(JSON.stringify({ type: "welcome", role, extConnected: !!this.socket }));
        }
        return;
      }
      if (role === "extension") this._onExtensionMessage(msg);
      else this._onPeerMessage(ws, msg);
    });
    ws.on("close", () => {
      if (role === "extension" && this.socket === ws) {
        this.socket = null;
        this.emit("disconnected");
        for (const p of this.peers) this._safeSend(p, { type: "ext_status", connected: false });
        const err = new BridgeError("Thunderbird disconnected during call", "DISCONNECTED");
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
        for (const [hubId, f] of this.forwarded) { this._safeSend(f.peer, { id: f.peerId, error: { message: err.message, code: err.code } }); this.forwarded.delete(hubId); }
      } else if (role === "peer") {
        this.peers.delete(ws);
        for (const [hubId, f] of this.forwarded) if (f.peer === ws) this.forwarded.delete(hubId);
      }
    });
  }

  _onExtensionMessage(msg) {
    if (msg.method === "progress" && msg.params) {
      const id = msg.params.id;
      const p = this.pending.get(id);
      if (p) { if (p.onProgress) p.onProgress(msg.params); if (this.onProgress) this.onProgress(msg.params); return; }
      const f = this.forwarded.get(id);
      if (f) this._safeSend(f.peer, { method: "progress", params: { ...msg.params, id: f.peerId } });
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (p) {
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new BridgeError(msg.error.message || "remote error", "REMOTE")); else p.resolve(msg.result);
      return;
    }
    const f = this.forwarded.get(msg.id);
    if (f) { this.forwarded.delete(msg.id); this._safeSend(f.peer, { id: f.peerId, result: msg.result, error: msg.error }); }
  }

  _onPeerMessage(peer, msg) {
    if (msg.id === undefined || !msg.method) return;
    if (msg.method === "_hub.status") return this._safeSend(peer, { id: msg.id, result: { extConnected: !!this.socket, peers: this.peers.size } });
    if (!this.socket) return this._safeSend(peer, { id: msg.id, error: { message: NO_CLIENT_MSG(this.connectTimeout), code: "NO_CLIENT" } });
    const hubId = this.nextId++;
    this.forwarded.set(hubId, { peer, peerId: msg.id });
    this.socket.send(JSON.stringify({ id: hubId, method: msg.method, params: msg.params || {} }));
  }

  _safeSend(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }

  /* ---------- peer side ---------- */

  _attachAsPeer(port = this.port) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://127.0.0.1:" + port + "/");
      const fail = (m) => reject(new BridgeError("Port " + port + " is in use but the process there is not an AIConnect hub (" + m + ")", "EADDRINUSE"));
      const t = setTimeout(() => { try { ws.close(); } catch (e) { /* ignore */ } fail("timeout"); }, 3000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: this.token, client: "peer", version: "peer" })));
      ws.on("error", (e) => { clearTimeout(t); fail(e.message); });
      ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        if (msg.type === "welcome") {
          clearTimeout(t);
          this.socket = ws;
          this.extConnected = !!msg.extConnected;
          if (this.extConnected) this.emit("connected", { client: "via-hub" });
          resolve();
          return;
        }
        if (msg.type === "error") { clearTimeout(t); fail(msg.message); return; }
        if (msg.type === "ext_status") {
          const was = this.extConnected;
          this.extConnected = !!msg.connected;
          if (this.extConnected && !was) this.emit("connected", { client: "via-hub" });
          if (!this.extConnected && was) this.emit("disconnected");
          return;
        }
        if (msg.method === "progress" && msg.params) {
          const p = this.pending.get(msg.params.id);
          if (p && p.onProgress) p.onProgress(msg.params);
          if (this.onProgress) this.onProgress(msg.params);
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new BridgeError(msg.error.message || "remote error", msg.error.code || "REMOTE")); else p.resolve(msg.result);
        }
      });
      ws.on("close", () => {
        if (this.socket === ws) {
          this.socket = null;
          this.mode = null; // hub went away; next start() re-elects
          const err = new BridgeError("AIConnect hub process exited during call", "DISCONNECTED");
          for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
          this.emit("disconnected");
        }
      });
    });
  }

  /* ---------- shared API ---------- */

  get connected() {
    return this.mode === "hub" ? !!this.socket : (this.mode === "peer" && !!this.socket && this.extConnected);
  }

  async waitForConnection(timeout = this.connectTimeout) {
    if (!this.mode) await this.start();
    if (this.connected) return;
    if (this.mode === "peer") {
      // Ask the hub once; it also pushes ext_status changes.
      try { const s = await this.call("_hub.status", {}, { timeout: 3000 }); this.extConnected = !!s.extConnected; } catch (e) { /* ignore */ }
      if (this.connected) return;
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off("connected", ok); reject(new BridgeError(NO_CLIENT_MSG(timeout), "NO_CLIENT")); }, timeout);
      const ok = () => { clearTimeout(t); resolve(); };
      this.once("connected", ok);
    });
  }

  call(method, params = {}, { onProgress, timeout } = {}) {
    if (!this.socket) return Promise.reject(new BridgeError("Not connected", "NO_CLIENT"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = timeout ?? this.callTimeout;
      const timer = t > 0 ? setTimeout(() => { this.pending.delete(id); reject(new BridgeError("Call " + method + " timed out after " + t + "ms", "TIMEOUT")); }, t) : null;
      this.pending.set(id, { resolve, reject, timer, onProgress });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async stop() {
    if (this.socket) { try { this.socket.close(); } catch (e) { /* ignore */ } }
    for (const p of this.peers) { try { p.close(); } catch (e) { /* ignore */ } }
    await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = null;
    this.mode = null;
  }
}

/* Convenience: open a bridge for one unit of work, then close it. */
export async function withBridge(settings, fn, { onProgress } = {}) {
  const bridge = new Bridge({ ports: settings.ports, port: settings.port, token: settings.token, connectTimeout: settings.timeout, onProgress });
  await bridge.start();
  try {
    await bridge.waitForConnection();
    return await fn(bridge);
  } finally {
    await bridge.stop();
  }
}
