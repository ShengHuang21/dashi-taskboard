export function createNativeTaskboardPanelOpener({
  hasLivePanel,
  openPanel,
  focusApp,
  now = Date.now,
  openingLeaseMs = 7_500,
}) {
  if (
    typeof hasLivePanel !== "function"
    || typeof openPanel !== "function"
    || typeof focusApp !== "function"
  ) {
    throw new TypeError("Native Taskboard panel opener dependencies are required");
  }

  let operation = Promise.resolve();
  let openingUntil = 0;
  const openOrFocus = () => {
    const next = operation.then(async () => {
      if (await hasLivePanel()) {
        openingUntil = 0;
        try {
          focusApp();
        } catch (_) {
          // A live panel is still reusable when macOS refuses foreground activation.
        }
        return { action: "reused" };
      }
      if (now() < openingUntil) return { action: "opening" };
      await openPanel();
      openingUntil = now() + openingLeaseMs;
      return { action: "opened" };
    });
    operation = next.catch(() => {});
    return next;
  };

  return { openOrFocus };
}
