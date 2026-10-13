import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { isTauri } from "@tauri-apps/api/core";
import { api } from "../../convex/_generated/api";
import { searchWithMcp } from "./client";

export function SearchWorker({ enabled, onError }: { enabled: boolean; onError: (message: string) => void }) {
  const jobs = useQuery(api.search.pending, enabled && (isTauri() || import.meta.env.DEV) ? {} : "skip");
  const claim = useMutation(api.search.claim);
  const complete = useMutation(api.search.complete);
  const running = useRef(new Set<string>());
  const workerId = useRef(crypto.randomUUID());
  useEffect(() => {
    for (const job of jobs || []) {
      if (running.current.has(job._id)) continue;
      running.current.add(job._id);
      void (async () => {
        try {
          if (!await claim({ searchId: job._id, workerId: workerId.current })) return;
          try {
            const results = await searchWithMcp(job.query);
            await complete({ searchId: job._id, workerId: workerId.current, results });
          } catch {
            await complete({ searchId: job._id, workerId: workerId.current, failed: true });
            onError("Self-hosted web search is unavailable. Check Firecrawl and its MCP container in Docker.");
          }
        } catch { /* The user may sign out or stop the request while it is running. */ }
        finally { running.current.delete(job._id); }
      })();
    }
  }, [jobs, claim, complete, onError]);
  return null;
}

