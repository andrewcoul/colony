import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** A panel beside the chat on desktop, full screen on the phone. */
export function SidePanel({ label, phone, children }: { label: string; phone: boolean; children: ReactNode }) {
  return (
    <aside
      aria-label={label}
      className={cn("flex flex-col gap-3 bg-surface px-4 pt-3.5 pb-4",
        phone ? "fixed inset-0 z-40 pt-[max(env(safe-area-inset-top),14px)] pb-[max(env(safe-area-inset-bottom),14px)]" : "w-[430px] shrink-0 border-l border-rule")}
    >
      {children}
    </aside>
  );
}
