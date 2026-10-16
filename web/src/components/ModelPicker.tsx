import type { ModelOption } from "@shared/types";
import { useLive } from "../lib/live";
import { openSettings } from "../lib/settings";

/** "OpenRouter · anthropic/claude-x" for a model ref, or the raw value if it's unknown. */
export function modelLabel(ref: string, models: ModelOption[]) {
  const option = models.find((item) => item.ref === ref);
  return option ? `${option.providerName} · ${option.model}` : ref.split("::").pop() || ref;
}

/** A model to switch to when turning on the desktop: the default if it can drive one, else the first that can. */
export function desktopModel(models: ModelOption[], current: string, defaultModel: string) {
  const can = (ref: string) => models.some((item) => item.ref === ref && item.desktop);
  if (can(current)) return current;
  if (can(defaultModel)) return defaultModel;
  return models.find((item) => item.desktop)?.ref ?? null;
}

/**
 * A Bot's model: any model from any provider in Settings, grouped by provider. While the desktop
 * is on, models that can't drive one are disabled.
 */
export function ModelPicker({ value, onChange, desktopOnly = false }: { value: string; onChange: (model: string) => void; desktopOnly?: boolean }) {
  const models = useLive((s) => s.models);
  const defaultModel = useLive((s) => s.defaultModel);
  // A Bot can point at a model that was since removed from Settings; it then runs on the default.
  const missing = Boolean(value) && !models.some((item) => item.ref === value);
  const groups = [...new Set(models.map((item) => item.providerId))].map((id) => models.filter((item) => item.providerId === id));
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule py-3">
      <label className="flex items-center justify-between gap-4 text-sm">
        Model
        <select value={missing ? "" : value || defaultModel} onChange={(e) => onChange(e.target.value)} disabled={!models.length}
          className="max-w-[65%] truncate rounded-md bg-raised px-2 py-1 font-mono text-[12px] text-ink outline-none">
          {missing && <option value="" disabled>{value.split("::").pop()} (unavailable)</option>}
          {!models.length && <option value="">No models yet</option>}
          {groups.map((group) => (
            <optgroup key={group[0].providerId} label={group[0].providerName}>
              {group.map((item) => (
                <option key={item.ref} value={item.ref} disabled={desktopOnly && !item.desktop}>
                  {item.model}{item.ref === defaultModel ? " · default" : ""}{desktopOnly && !item.desktop ? " · can't drive the desktop" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {missing && <span className="text-meta text-lemon">That model isn't in Settings any more, so this Bot uses {modelLabel(defaultModel, models) || "the default"}.</span>}
      <button type="button" onClick={openSettings} className="self-end text-meta text-muted hover:text-ink">
        {models.length <= 1 ? "Add models or providers in Settings" : "Manage models"}
      </button>
    </div>
  );
}
