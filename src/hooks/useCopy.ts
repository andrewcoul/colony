import { useEffect, useRef, useState } from "react";

/** Copies text and reports `copied` for a moment afterwards. */
export function useCopy(onError?: () => void) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch { onError?.(); }
  }
  return { copied, copy };
}
