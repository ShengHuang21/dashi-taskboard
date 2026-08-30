const HEARTBEAT_INTERVAL_MS = 2_500;

export function installTaskboardPanelPresence() {
  const location = new URL(window.location.href);
  if (location.searchParams.get("host") !== "codex") return () => {};

  const panelId = crypto.randomUUID();
  const endpoint = new URL("api/local/taskboard-panel-presence", document.baseURI);
  const body = JSON.stringify({ panelId });
  const touch = () => void fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  const remove = () => void fetch(endpoint, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});

  touch();
  const interval = window.setInterval(touch, HEARTBEAT_INTERVAL_MS);
  window.addEventListener("pagehide", remove, { once: true });
  return () => {
    window.clearInterval(interval);
    window.removeEventListener("pagehide", remove);
    remove();
  };
}
