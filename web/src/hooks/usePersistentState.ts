import { useEffect, useState } from "react";

/** useState backed by localStorage. Values are JSON-encoded under a colony- prefix. */
export function usePersistentState<T>(key: string, initial: T) {
  const storageKey = "colony-" + key;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* storage full or disabled */ }
  }, [storageKey, value]);
  return [value, setValue] as const;
}
