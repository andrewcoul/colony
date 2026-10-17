import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-ink text-on-ink hover:opacity-90",
        outline: "border border-rule text-ink hover:bg-hover",
        ghost: "text-muted hover:bg-hover hover:text-ink",
        toggle: "border border-rule text-muted hover:bg-hover hover:text-ink aria-pressed:border-transparent aria-pressed:bg-active aria-pressed:text-ink",
        danger: "bg-danger text-white hover:opacity-90",
      },
      size: {
        default: "h-10 rounded-full px-4 text-sm",
        pill: "h-[34px] rounded-full px-3 text-label",
        icon: "size-[34px] rounded-full",
        "icon-sm": "size-8 rounded-lg",
      },
    },
    defaultVariants: { variant: "ghost", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

/**
 * A button. It's `type="button"` unless you say otherwise, so it never submits a form by accident:
 * a form's own submit button must be `type="submit"`, or tapping it does nothing.
 */
export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
