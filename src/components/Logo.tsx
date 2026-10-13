/** The Colony mark: a small settlement — two houses flanking a tower with one lit window. */
export function LogoMark({ size = 24, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M2.5 20.5h19" />
      <path d="M3.5 20.5v-7l3-3 3 3" />
      <path d="M9.5 20.5V5.5h5v15" />
      <path d="M14.5 12.5l3-3 3 3v8" />
      <path d="M6.5 20.5v-3" />
      <circle cx="12" cy="9" r={strokeWidth < 1.8 ? 1.15 : 1.3} fill="currentColor" stroke="none" />
    </svg>
  );
}
