import { useEffect, useRef } from "react";

/** Registers Ctrl/Cmd+<key> shortcuts. Handlers may change between renders. */
export function useHotkeys(bindings: Record<string, () => void>) {
  const latest = useRef(bindings);
  latest.current = bindings;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const handler = latest.current[event.key.toLowerCase()];
      if (!handler) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
