import type { ReactNode } from "react";
import { m } from "motion/react";
import { soft } from "../lib/motion";
import { cn } from "../lib/utils";

const WIDTH = 430;

/** A panel beside the chat on desktop, full screen on the phone. Sits inside a PanelDock. */
export function SidePanel({ label, phone, children }: { label: string; phone: boolean; children: ReactNode }) {
  return (
    <aside
      aria-label={label}
      className={cn("flex h-full flex-col gap-3 bg-surface px-4 pt-3.5 pb-4",
        phone ? "pt-[max(env(safe-area-inset-top),14px)] pb-[max(env(safe-area-inset-bottom),14px)]" : "w-[430px]")}
    >
      {children}
    </aside>
  );
}

/**
 * Where side panels live. On desktop the dock grows from nothing so the chat makes room smoothly
 * (the panel inside keeps its full width, so its contents never reflow mid-animation);
 * on the phone it slides in from the right. Render it inside <AnimatePresence> so it can leave too.
 */
export function PanelDock({ phone, children }: { phone: boolean; children: ReactNode }) {
  if (phone) {
    return (
      <m.div className="fixed inset-0 z-40 bg-surface"
        initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%", transition: { duration: 0.2, ease: "easeIn" } }} transition={soft}>
        {children}
      </m.div>
    );
  }
  return (
    <m.div className="h-full shrink-0 overflow-hidden border-l border-rule bg-surface"
      initial={{ width: 0 }} animate={{ width: WIDTH }} exit={{ width: 0, transition: { duration: 0.18, ease: "easeIn" } }} transition={soft}>
      {children}
    </m.div>
  );
}
