import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { cn } from "../../lib/utils";

export const MenuRoot = BaseMenu.Root;
export const MenuRadioGroup = BaseMenu.RadioGroup;

export function MenuTrigger({ children }: { children: ReactElement<Record<string, unknown>> }) {
  return <BaseMenu.Trigger render={children} />;
}

export function MenuContent({ children, side = "bottom", align = "end", className }: {
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={8} className="z-50 outline-none">
        <BaseMenu.Popup className={cn(
          "min-w-48 max-w-80 rounded-xl border border-rule bg-surface p-1.5 text-ink shadow-pop outline-none transition-[opacity,scale] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
          className,
        )}>
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

const itemClass = "flex w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-label outline-none select-none data-[highlighted]:bg-hover";

export function MenuItem({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) {
  return <BaseMenu.Item className={cn(itemClass, className)} {...props} />;
}

export function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof BaseMenu.RadioItem> & { children: ReactNode }) {
  return (
    <BaseMenu.RadioItem className={cn(itemClass, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <BaseMenu.RadioItemIndicator className="text-ink">✓</BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-meta text-muted">{children}</div>;
}
