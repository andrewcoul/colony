import type { ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { Button } from "./button";

export function Dialog({ open, onOpenChange, title, description, wide, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Room for reading (a Doc in full screen) rather than a form. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-backdrop backdrop-blur-sm transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BaseDialog.Popup className={`fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-48px)] ${wide ? "w-[min(760px,calc(100vw-32px))]" : "w-[min(440px,calc(100vw-32px))]"} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[20px] border border-rule bg-surface p-6 text-ink shadow-pop transition-[opacity,scale] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0`}>
          <div className="mb-2 flex items-center justify-between gap-4">
            <BaseDialog.Title className="m-0 text-xl font-semibold tracking-tight">{title}</BaseDialog.Title>
            <BaseDialog.Close render={<Button size="icon-sm" aria-label="Close" />}><X size={18} /></BaseDialog.Close>
          </div>
          {description && <BaseDialog.Description className="mb-5 text-label leading-relaxed text-muted">{description}</BaseDialog.Description>}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
