import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { LogOut } from "lucide-react";
import type { api } from "../../convex/_generated/api";
import type { ThemePreference } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

type Settings = FunctionReturnType<typeof api.settings.status>;

export function SettingsDialog({ open, onOpenChange, settings, theme, onThemeChange, onSignOut }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings | undefined;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSignOut: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Settings">
      <Row title="Appearance" detail="Dark, light, or match Windows">
        <div className="flex rounded-full bg-raised p-[3px]">
          {(["dark", "light", "system"] as const).map((option) => (
            <button
              key={option} type="button" aria-pressed={theme === option} onClick={() => onThemeChange(option)}
              className={cn("h-[30px] rounded-full px-3 text-label capitalize", theme === option ? "bg-ground text-ink" : "text-muted hover:text-ink")}
            >{option}</button>
          ))}
        </div>
      </Row>
      <Row title="Model" detail={(settings?.provider || "…") + " · set in Convex env"}>
        <span className="max-w-[45%] truncate text-label text-soft">{settings?.models.join(", ") || "Not configured"}</span>
      </Row>
      {settings && !settings.canGenerate && (
        <div className="mb-3.5 rounded-xl border border-rule bg-ground p-3.5 text-label leading-relaxed text-muted">
          <strong className="text-ink">{settings.configured ? "This account doesn't have model access" : "Connect a model"}</strong>
          <p className="my-1.5">Credentials stay in Convex. From the project folder, run:</p>
          <pre className="m-0 overflow-x-auto font-mono text-meta leading-relaxed whitespace-pre text-ink">{[
            "npx convex env set AI_BASE_URL <api-base-url>",
            "npx convex env set AI_MODEL <model-id>",
            "npx convex env set AI_MODELS <optional,extra,ids>",
            "npx convex env set AI_PROVIDER_NAME <provider>",
            "npx convex env set AI_API_KEY <your-key>",
            "npx convex env set COLONY_OWNER_EMAIL " + (settings.email || "<your-email>"),
          ].join("\n")}</pre>
        </div>
      )}
      <Row title="Account" detail={settings?.email || "…"} last>
        <Button variant="outline" size="pill" onClick={onSignOut}><LogOut size={14} />Sign out</Button>
      </Row>
    </Dialog>
  );
}

function Row({ title, detail, children, last }: { title: string; detail: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 border-t border-rule py-3.5", last && "pb-1")}>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <strong className="text-sm font-medium">{title}</strong>
        <small className="text-meta text-muted [overflow-wrap:anywhere]">{detail}</small>
      </div>
      {children}
    </div>
  );
}
