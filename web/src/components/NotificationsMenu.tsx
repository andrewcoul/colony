import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing, Send } from "lucide-react";
import { api } from "../lib/api";
import { disablePush, enablePush, pushStatus, type PushStatus } from "../lib/push";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "./ui/menu";

const HELP: Partial<Record<PushStatus, string>> = {
  "needs-install": "On iPhone, tap Share → Add to Home Screen, then open Colony from there to turn on notifications.",
  insecure: "Notifications need HTTPS. Open Colony through your tailscale serve address (https://…ts.net).",
  unsupported: "This browser can't receive notifications.",
  blocked: "Notifications are blocked for Colony. Allow them in this browser's site settings.",
};

/** Bell in the roster header: turn this device's push notifications on or off. */
export function NotificationsMenu({ className }: { className?: string }) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => { void pushStatus().then(setStatus).catch(() => setStatus("off")); }, []);

  async function act(action: () => Promise<PushStatus | void>) {
    setBusy(true); setNote("");
    try { const next = await action(); if (next) setStatus(next); }
    catch (failure) { setNote(failure instanceof Error ? failure.message : "That didn't work."); }
    finally { setBusy(false); }
  }

  const on = status === "on";
  const Icon = on ? BellRing : status === "off" || status === null ? Bell : BellOff;
  return (
    <MenuRoot>
      <MenuTrigger>
        <Button variant="outline" size="icon" aria-label="Notifications" className={cn(on && "text-ink", className)}><Icon size={17} /></Button>
      </MenuTrigger>
      <MenuContent className="w-72">
        <div className="flex flex-col gap-1 px-2.5 pt-1.5 pb-2">
          <strong className="text-sm">Notifications on this device</strong>
          <span className="text-meta leading-snug text-muted">
            {on ? "You'll hear from Bots when they finish, a routine runs, or they need your approval."
              : HELP[status ?? "off"] ?? "Get a ping when Bots finish work, a routine runs, or they need your approval."}
          </span>
          {note && <span className="text-meta text-danger">{note}</span>}
        </div>
        {status === "off" && <MenuItem disabled={busy} closeOnClick={false} onClick={() => void act(enablePush)}><Bell size={15} />Turn on</MenuItem>}
        {on && (
          <>
            <MenuItem disabled={busy} closeOnClick={false} onClick={() => void act(async () => {
              const { delivered } = await api.pushTest();
              setNote(delivered ? "" : "No device received it. Try turning notifications off and on.");
            })}><Send size={15} />Send a test</MenuItem>
            <MenuItem disabled={busy} closeOnClick={false} onClick={() => void act(disablePush)}><BellOff size={15} />Turn off</MenuItem>
          </>
        )}
      </MenuContent>
    </MenuRoot>
  );
}
