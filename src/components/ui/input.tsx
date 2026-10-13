import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn("h-[42px] w-full rounded-lg border border-rule bg-ground px-3.5 text-sm text-ink outline-none placeholder:text-muted focus:border-muted", className)}
      {...props}
    />
  );
}

export function Field({ label, htmlFor, children }: { label: ReactNode; htmlFor: string; children: ReactNode }) {
  return (
    <div className="mb-3.5 flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-label text-muted">{label}</label>
      {children}
    </div>
  );
}
