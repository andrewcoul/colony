/** One line of a line-by-line comparison. */
export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/**
 * Line diff by longest common subsequence: plenty for a Doc of a few hundred lines.
 * Docs past ~2,000 lines on each side fall back to "all removed, all added" rather than doing the full work.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "removed", text: a[i++] });
    else out.push({ kind: "added", text: b[j++] });
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });
  return out;
}

/** Just the changes, with a line of context around each run, for a compact view. */
export function changesOnly(lines: DiffLine[], context = 1): (DiffLine | { kind: "gap"; count: number })[] {
  const keep = lines.map((line, index) => line.kind !== "same" || lines.slice(Math.max(0, index - context), index + context + 1).some((near) => near.kind !== "same"));
  const out: (DiffLine | { kind: "gap"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) out.push({ kind: "gap", count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "gap", count: skipped });
  return out;
}
