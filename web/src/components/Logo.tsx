import { m } from "motion/react";
import { bouncy } from "../lib/motion";

/*
 * The Colony mark: the King Bot. Every Bot has a coloured face; the plain white one wearing
 * the little black crown is you, the person they work for.
 * The crown's white outline keeps it visible on dark grounds; on light grounds the head gets
 * a thin ink outline instead (the stroke is the ink colour, so it vanishes on dark).
 */

export const CROWN = "M13.2 10.6 12.2 3.6l4.4 3.3L20 2.2l3.4 4.7 4.4-3.3-1 7z";

export type LogoMood = "still" | "alive" | "connecting" | "landing";

export function LogoMark({ size = 24, mood = "still" }: { size?: number; mood?: LogoMood }) {
  const crown =
    mood === "connecting" ? { animate: { y: [0, -3, 0] }, transition: { duration: 0.8, repeat: Infinity, ease: "easeInOut" as const } }
    : mood === "landing" ? { initial: { y: -7, rotate: -8 }, animate: { y: 0, rotate: 0 }, transition: { ...bouncy, delay: 0.15 } }
    : {};
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true" className="logo shrink-0 overflow-visible" data-mood={mood}>
      <circle cx="20" cy="23" r="14.3" fill="#fff" stroke="var(--ink)" strokeWidth="1.4" />
      <m.g {...crown} style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}>
        <g transform="rotate(-10 20 8) translate(4 2.6) scale(0.8)">
          <path d={CROWN} fill="#fff" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
          <path d={CROWN} fill="#0F0F0F" stroke="#0F0F0F" strokeWidth="0.8" strokeLinejoin="round" />
        </g>
      </m.g>
      <g className="logo-eyes">
        <ellipse cx="14.5" cy="23" rx="3.4" ry="4.4" fill="#0F0F0F" />
        <ellipse cx="25.5" cy="23" rx="3.4" ry="4.4" fill="#0F0F0F" />
        <circle cx="15.5" cy="21.5" r="1.2" fill="#fff" />
        <circle cx="26.5" cy="21.5" r="1.2" fill="#fff" />
      </g>
    </svg>
  );
}
