import { useLive } from "../lib/live";
import { openSettings } from "../lib/settings";

/** A Bot's model, picked from the models in Settings, with a way to add more. */
export function ModelPicker({ value, onChange }: { value: string; onChange: (model: string) => void }) {
  const models = useLive((s) => s.models);
  const defaultModel = useLive((s) => s.defaultModel);
  // A Bot can point at a model that was since removed from Settings; it then runs on the default.
  const missing = Boolean(value) && !models.includes(value);
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule py-3">
      <label className="flex items-center justify-between gap-4 text-sm">
        Model
        <select value={missing ? "" : value || defaultModel} onChange={(e) => onChange(e.target.value)} disabled={!models.length}
          className="max-w-[65%] truncate rounded-md bg-raised px-2 py-1 font-mono text-[12px] text-ink outline-none">
          {missing && <option value="" disabled>{value} (unavailable)</option>}
          {!models.length && <option value="">No models yet</option>}
          {models.map((id) => <option key={id} value={id}>{id}{id === defaultModel ? " · default" : ""}</option>)}
        </select>
      </label>
      {missing && <span className="text-meta text-lemon">That model isn't in Settings any more, so this Bot uses {defaultModel || "the default"}.</span>}
      <button type="button" onClick={openSettings} className="self-end text-meta text-muted hover:text-ink">
        {models.length <= 1 ? "Add more models in Settings" : "Manage models"}
      </button>
    </div>
  );
}
