/** Opens Model settings from anywhere (App owns the dialog). */
export function openSettings() {
  window.dispatchEvent(new Event("colony:settings"));
}

export function onOpenSettings(listener: () => void) {
  window.addEventListener("colony:settings", listener);
  return () => window.removeEventListener("colony:settings", listener);
}
