const el = (id) => document.getElementById(id);

const DEFAULT_PORTS = [47800, 47801, 47802, 47803, 47804];

async function load() {
  const { settings } = await messenger.storage.local.get({ settings: { ports: DEFAULT_PORTS, token: "", enabled: true } });
  const ports = (Array.isArray(settings.ports) && settings.ports.length) ? settings.ports : (settings.port ? [settings.port] : DEFAULT_PORTS);
  el("ports").value = ports.join(",");
  el("token").value = settings.token || "";
  el("enabled").checked = settings.enabled !== false;
  refresh();
}

async function refresh() {
  let s = null;
  try { s = await messenger.runtime.sendMessage({ type: "status" }); } catch (e) { /* background not ready */ }
  if (!s) {
    const { status } = await messenger.storage.local.get({ status: null });
    s = status;
  }
  const node = el("status");
  if (s && s.connected) {
    node.className = "status on";
    node.textContent = "Connected to bridge" + (s.port ? " on port " + s.port : "") + (s.lastSeen ? " (last activity " + s.lastSeen.slice(11, 19) + " UTC)" : "");
  } else {
    node.className = "status off";
    node.textContent = "Not connected" + (s && s.lastError ? ": " + s.lastError : ". Start a command with the aiconnect CLI and this will connect automatically.");
  }
  el("log").textContent = (s && s.log ? s.log : []).join("\n");
}

el("save").addEventListener("click", async () => {
  const ports = el("ports").value.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  const settings = {
    ports: ports.length ? ports : DEFAULT_PORTS,
    token: el("token").value.trim(),
    enabled: el("enabled").checked
  };
  await messenger.storage.local.set({ settings });
  setTimeout(refresh, 800);
});

el("reconnect").addEventListener("click", async () => {
  try { await messenger.runtime.sendMessage({ type: "reconnect" }); } catch (e) { /* ignore */ }
  setTimeout(refresh, 800);
});

load();
setInterval(refresh, 2000);
