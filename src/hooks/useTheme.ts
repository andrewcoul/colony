import { useEffect, useState } from "react";
import { usePersistentState } from "./usePersistentState";

export type ThemePreference = "dark" | "light" | "system";

const query = "(prefers-color-scheme: light)";

export function useTheme() {
  const [preference, setPreference] = usePersistentState<ThemePreference>("theme", "dark");
  const [systemLight, setSystemLight] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setSystemLight(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const resolved = preference === "system" ? (systemLight ? "light" : "dark") : preference;
  useEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);
  return { preference, setPreference, resolved };
}
