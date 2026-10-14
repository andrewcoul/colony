import { useState } from "react";
import { useLive } from "../lib/live";
import { openSettings } from "../lib/settings";
import { cn } from "../lib/utils";
import { desktopModel, modelLabel } from "./ModelPicker";

/**
 * Lets a Bot see and use its computer's desktop. Only models that can drive a desktop are
 * allowed while it's on, so turning it on may switch the Bot to one that can.
 */
export function DesktopToggle({ computer, desktop, model, onChange }: {
  computer: boolean;
  desktop: boolean;
  model: string;
  onChange: (patch: { desktop: boolean; model?: string }) => void;
}) {
  const models = useLive((s) => s.models);
  const defaultModel = useLive((s) => s.defaultModel);
  const [switched, setSwitched] = useState<string | null>(null);
  const capable = desktopModel(models, model || defaultModel, defaultModel);
  const available = computer && capable !== null;

  function toggle() {
    if (desktop) { setSwitched(null); onChange({ desktop: false }); return; }
    if (!capable) return;
    const swap = capable !== (model || defaultModel) ? capable : undefined;
    setSwitched(swap ?? null);
    onChange({ desktop: true, ...(swap ? { model: swap } : {}) });
  }

  return (
    <div className="flex flex-col gap-1 border-t border-rule py-3">
      <button type="button" role="switch" aria-checked={desktop} disabled={!available && !desktop} onClick={toggle}
        className="flex items-center justify-between gap-4 text-left disabled:cursor-not-allowed">
        <span className="flex flex-col gap-0.5">
          <span className={cn("text-sm", !available && !desktop && "text-muted")}>Desktop control</span>
          <span className="text-meta text-muted">
            {!computer ? "Needs its own computer." : capable ? "Sees the screen and uses the mouse and keyboard." : "No model here can drive a desktop yet."}
          </span>
        </span>
        <span className={cn("flex h-6 w-10 shrink-0 items-center rounded-full p-[3px] transition-colors", desktop ? "justify-end bg-ink" : "justify-start bg-raised")}>
          <span className={cn("size-[18px] rounded-full", desktop ? "bg-on-ink" : "bg-muted")} />
        </span>
      </button>
      {switched && desktop && <span className="text-meta text-mint">Switched to {modelLabel(switched, models)}, which can drive a desktop.</span>}
      {computer && !capable && (
        <button type="button" onClick={openSettings} className="self-start text-meta text-muted underline hover:text-ink">
          Find one with the desktop check in Settings
        </button>
      )}
    </div>
  );
}
