import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD = 120;

/**
 * Keeps a scroll container pinned to the bottom while content grows,
 * unless the reader has scrolled up. `dependency` should change whenever content does.
 */
export function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
    pinned.current = near;
    setAtBottom(near);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const unpin = useCallback(() => { pinned.current = false; }, []);

  useEffect(() => {
    if (pinned.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [dependency]);

  return { ref, onScroll, atBottom, scrollToBottom, unpin };
}
