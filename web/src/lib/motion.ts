import type { Transition, Variants } from "motion/react";

/*
 * Shared motion tokens so every component moves the same way.
 * Springs for things that move, short fades for things that only appear or disappear.
 * Exits run at about half the enter time: leaving should never hold anything up.
 */

/** Chips, badges, toggles, checks: quick and a little bouncy. */
export const snappy: Transition = { type: "spring", stiffness: 500, damping: 34 };
/** Panels, cards, layout shifts: settles without overshooting. */
export const soft: Transition = { type: "spring", stiffness: 260, damping: 30 };
/** Something landing with a visible bounce (the logo's crown, a badge popping in). */
export const bouncy: Transition = { type: "spring", stiffness: 600, damping: 14 };
/** Opacity-only changes. */
export const fade: Transition = { duration: 0.16, ease: "easeOut" };

/** Rise in from slightly below; fade out in place. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: soft },
  gone: { opacity: 0, transition: { duration: 0.12 } },
};

/** Pop in from a little smaller (cards, chips). */
export const pop: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 6 },
  shown: { opacity: 1, scale: 1, y: 0, transition: soft },
  gone: { opacity: 0, scale: 0.98, transition: { duration: 0.12 } },
};

/** Your own message springs up from the composer. */
export const sent: Variants = {
  hidden: { opacity: 0, y: 28, scale: 0.98 },
  shown: { opacity: 1, y: 0, scale: 1, transition: soft },
};

/** Lists longer than this skip the stagger: nobody wants to wait for row 80. */
export const STAGGER_LIMIT = 50;
export const stagger = (index: number, step = 0.03) => (index < STAGGER_LIMIT ? index * step : 0);
