import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge our custom font sizes, or it treats text-label etc. as colours
// and drops them when a text-<color> class follows.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["meta", "label", "body"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
