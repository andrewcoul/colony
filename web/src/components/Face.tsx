import { memo } from "react";
import { AnimatePresence, m } from "motion/react";
import type { Presence } from "@shared/types";
import { bouncy, snappy } from "../lib/motion";
import { cn } from "../lib/utils";

/*
 * Deterministic Bot faces: the same seed always draws the same face. Parts are separate
 * SVG groups so CSS can animate them per presence state (see .face rules in globals.css).
 * CSS runs the loops (blink, spin, bob); Motion runs the changes between states (the ring
 * springing in when work starts, a badge popping in, eyes crossfading). Motion only touches the
 * wrapper groups, so it never fights the CSS transforms underneath.
 */

const CENTRE = { transformBox: "fill-box", transformOrigin: "center" } as const;
const eyesKind = (state: Presence) => (state === "working" || state === "done" || state === "blocked" ? state : "open");

export const HUES = ["#7CC4FA", "#7EE2B8", "#FFB38A", "#C5A6FF", "#FFE07A", "#FF8A9A"] as const;
const SHAPES = ["round", "boxy", "organic", "arch", "circle", "nub"] as const;
const ACCESSORIES = ["none", "antenna", "ears", "horns", "tuft"] as const;

type Shape = (typeof SHAPES)[number];
type Accessory = (typeof ACCESSORIES)[number];

/** FNV-1a, then mulberry32: tiny, fast, and stable across platforms. */
function random(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function faceTraits(seed: string) {
  const next = random(seed.trim().toLowerCase() || "colony");
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  return {
    shape: pick(SHAPES) as Shape,
    hue: pick(HUES),
    accessory: pick(ACCESSORIES) as Accessory,
    /** Offset blinks so a roster of Bots never blinks in unison. */
    blinkDelay: Math.round(next() * 4000),
  };
}

const TOP: Record<Shape, number> = { round: 7, boxy: 8, organic: 6, arch: 6, circle: 7, nub: 6 };
const EYE_Y: Record<Shape, number> = { round: 23, boxy: 23, organic: 23, arch: 22, circle: 23, nub: 24 };

function Body({ shape, hue }: { shape: Shape; hue: string }) {
  switch (shape) {
    case "round": return <rect x="5" y="7" width="34" height="32" rx="16" fill={hue} />;
    case "boxy": return <rect x="6" y="8" width="32" height="30" rx="9" fill={hue} />;
    case "organic": return <path d="M22 6c9 0 16 6 16 15 0 10-6 17-16 17S6 31 6 21C6 12 13 6 22 6Z" fill={hue} />;
    case "arch": return <path d="M8 38V20C8 12 14 6 22 6s14 6 14 14v18Z" fill={hue} />;
    case "circle": return <circle cx="22" cy="23" r="16" fill={hue} />;
    case "nub": return <g fill={hue}><rect x="7" y="11" width="30" height="27" rx="13" /><path d="M12 14c2-6 6-8 10-8s8 2 10 8Z" /></g>;
  }
}

function Accessory({ kind, top, hue }: { kind: Accessory; top: number; hue: string }) {
  switch (kind) {
    case "antenna": return <g><path d={`M22 ${top + 1}V${top - 3}`} stroke={hue} strokeWidth="2.4" strokeLinecap="round" /><circle cx="22" cy={top - 3.4} r="2" fill={hue} /></g>;
    case "ears": return <g fill={hue}><circle cx="11" cy={top + 4} r="4" /><circle cx="33" cy={top + 4} r="4" /></g>;
    case "horns": return <path d={`M14 ${top + 1}l3 4M30 ${top + 1}l-3 4`} stroke={hue} strokeWidth="2.4" strokeLinecap="round" />;
    case "tuft": return <path d={`M19 ${top + 2}l1-4M22 ${top + 1.5}v-4.5M25 ${top + 2}l-1-4`} stroke={hue} strokeWidth="2" strokeLinecap="round" />;
    default: return null;
  }
}

function Eyes({ state, y }: { state: Presence; y: number }) {
  const ink = "#0F0F0F";
  if (state === "working") return <path className="face-eyes" d={`M13 ${y - 0.5}h7M24 ${y - 0.5}h7`} stroke={ink} strokeWidth="3.2" strokeLinecap="round" />;
  if (state === "done") return <path className="face-eyes" d={`M13 ${y + 1}c1.5-3 5.5-3 7 0M24 ${y + 1}c1.5-3 5.5-3 7 0`} stroke={ink} strokeWidth="2.6" strokeLinecap="round" fill="none" />;
  const blocked = state === "blocked";
  return (
    <g className="face-eyes">
      {blocked && <path d={`M13 ${y - 3}l6 2M31 ${y - 3}l-6 2`} stroke={ink} strokeWidth="2" strokeLinecap="round" />}
      <ellipse cx="16.5" cy={y + (blocked ? 2 : 0)} rx="3.6" ry={blocked ? 3.6 : 4.6} fill={ink} />
      <ellipse cx="27.5" cy={y + (blocked ? 2 : 0)} rx="3.6" ry={blocked ? 3.6 : 4.6} fill={ink} />
      {!blocked && <><circle cx="17.6" cy={y - 1.6} r="1.3" fill="#fff" /><circle cx="28.6" cy={y - 1.6} r="1.3" fill="#fff" /></>}
    </g>
  );
}

export const Face = memo(function Face({ seed, state = "idle", size = 40, className, title }: {
  seed: string;
  state?: Presence;
  size?: number;
  className?: string;
  title?: string;
}) {
  const traits = faceTraits(seed);
  const top = TOP[traits.shape];
  return (
    <svg
      width={size} height={size} viewBox="0 0 44 44" role="img" aria-label={title ?? "Bot"}
      data-state={state} className={cn("face shrink-0 overflow-visible", className)}
      style={{ "--blink-delay": `${traits.blinkDelay}ms` } as React.CSSProperties}
    >
      <AnimatePresence initial={false}>
        {state === "working" && (
          <m.g key="ring" style={CENTRE} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.85, opacity: 0 }} transition={snappy}>
            <circle className="face-ring" cx="22" cy="23" r="20.5" stroke="#7EE2B8" strokeWidth="2" strokeDasharray="22 8" fill="none" />
          </m.g>
        )}
      </AnimatePresence>
      <g className="face-body">
        <Accessory kind={traits.accessory} top={top} hue={traits.hue} />
        <Body shape={traits.shape} hue={traits.hue} />
        <AnimatePresence initial={false}>
          <m.g key={eyesKind(state)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            <Eyes state={state} y={EYE_Y[traits.shape]} />
          </m.g>
        </AnimatePresence>
      </g>
      <AnimatePresence initial={false}>
        {state === "thinking" && (
          <m.g key="dots" className="face-dots" fill="#fff" initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={snappy}>
            <circle cx="37" cy="7" r="1.7" /><circle cx="41" cy="3.5" r="1.1" opacity="0.6" />
          </m.g>
        )}
        {(state === "waiting" || state === "blocked") && (
          <m.g key={`badge-${state}`} style={CENTRE} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0, transition: { duration: 0.12 } }} transition={bouncy}>
            <g className="face-badge">
              <circle cx="37" cy="10" r="6" fill={state === "waiting" ? "#FFE07A" : "#FF8A9A"} stroke="var(--ground)" strokeWidth="2.5" />
              {state === "blocked" && <><path d="M37 7.5v3" stroke="#141414" strokeWidth="1.8" strokeLinecap="round" /><circle cx="37" cy="12.6" r="0.9" fill="#141414" /></>}
            </g>
          </m.g>
        )}
      </AnimatePresence>
    </svg>
  );
});
