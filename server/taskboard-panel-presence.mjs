const PANEL_ID_PATTERN = /^[a-z0-9-]{8,80}$/i;

export function createTaskboardPanelPresence({
  now = Date.now,
  ttlMs = 8_000,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
    throw new TypeError("Taskboard panel presence TTL must be between 1 and 60 seconds");
  }
  const panels = new Map();
  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [panelId, updatedAt] of panels) {
      if (updatedAt < cutoff) panels.delete(panelId);
    }
  };
  const assertPanelId = (panelId) => {
    if (typeof panelId !== "string" || !PANEL_ID_PATTERN.test(panelId)) {
      throw new TypeError("Taskboard panel id is invalid");
    }
  };

  return {
    touch(panelId) {
      assertPanelId(panelId);
      prune();
      panels.set(panelId, now());
    },
    remove(panelId) {
      assertPanelId(panelId);
      panels.delete(panelId);
    },
    hasLivePanel() {
      prune();
      return panels.size > 0;
    },
  };
}
