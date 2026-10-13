import { useLayoutEffect, type FormEvent, type Ref, type RefObject } from "react";
import { ArrowUp, ChevronDown, Globe, Lightbulb, Square } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuRoot, MenuTrigger } from "./ui/menu";

export const MAX_PROMPT = 16_000;

export type ReplyOptions = { webSearch: boolean; think: boolean; model: string };

export function Composer({
  inputRef, value, onChange, onSubmit, onStop, generating, stopping, busy,
  options, onOptionsChange, models, searchAvailable, placeholder, className,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  generating: boolean;
  stopping: boolean;
  busy: boolean;
  options: ReplyOptions;
  onOptionsChange: (options: ReplyOptions) => void;
  models: string[];
  searchAvailable: boolean;
  placeholder: string;
  className?: string;
}) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value, inputRef]);

  const canSend = Boolean(value.trim()) && !busy && !generating;
  const set = (patch: Partial<ReplyOptions>) => onOptionsChange({ ...options, ...patch });

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (canSend) onSubmit();
  }

  return (
    <form
      onSubmit={submit}
      onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}
      className={cn("flex flex-col gap-3 rounded-composer border border-rule bg-raised py-3.5 pr-3 pl-5 transition-colors focus-within:border-muted", className)}
    >
      <textarea
        ref={inputRef as Ref<HTMLTextAreaElement>}
        aria-label="Message"
        rows={1}
        maxLength={MAX_PROMPT}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        className="max-h-60 w-full resize-none bg-transparent pt-1 text-base leading-6 text-ink outline-none placeholder:text-muted"
      />
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip label={searchAvailable ? "Let the model search the web" : "Web search needs the desktop app"} side="top">
          <Button
            variant="toggle" size="pill" aria-label="Search the web" aria-pressed={options.webSearch && searchAvailable}
            disabled={!searchAvailable} onClick={() => set({ webSearch: !options.webSearch })}
          ><Globe size={15} /><span className="max-sm:hidden">Search</span></Button>
        </Tooltip>
        <Tooltip label="Spend longer reasoning before answering" side="top">
          <Button variant="toggle" size="pill" aria-label="Think" aria-pressed={options.think} onClick={() => set({ think: !options.think })}>
            <Lightbulb size={15} /><span className="max-sm:hidden">Think</span>
          </Button>
        </Tooltip>
        <div className="flex-1" />
        {value.length > MAX_PROMPT - 2000 && <span className="text-meta text-muted">{value.length.toLocaleString()} / 16,000</span>}
        <ModelPicker model={options.model} models={models} onChange={(model) => set({ model })} />
        {generating ? (
          <Tooltip label="Stop" side="top">
            <Button variant="primary" className="size-9 rounded-full" aria-label="Stop reply" disabled={stopping} onClick={onStop}>
              <Square size={13} fill="currentColor" />
            </Button>
          </Tooltip>
        ) : (
          <Button type="submit" variant="primary" className="size-9 rounded-full" aria-label="Send message" disabled={!canSend}>
            <ArrowUp size={19} strokeWidth={2.25} />
          </Button>
        )}
      </div>
    </form>
  );
}

function ModelPicker({ model, models, onChange }: { model: string; models: string[]; onChange: (model: string) => void }) {
  if (!model) return null;
  if (models.length < 2) return <span className="min-w-0 max-w-56 truncate px-2.5 text-label text-soft">{model}</span>;
  return (
    <MenuRoot>
      <MenuTrigger>
        <Button size="pill" className="min-w-0 max-w-56 shrink text-ink" aria-label={"Model: " + model}>
          <span className="truncate">{model}</span><ChevronDown size={14} className="text-muted" />
        </Button>
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>Model</MenuLabel>
        <MenuRadioGroup value={model} onValueChange={(value) => onChange(String(value))}>
          {models.map((id) => <MenuRadioItem key={id} value={id}>{id}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuContent>
    </MenuRoot>
  );
}
