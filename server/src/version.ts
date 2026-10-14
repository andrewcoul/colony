import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Colony's version: the root package.json (server/src or server/dist sit two levels below it). */
export const VERSION: string = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")).version;

/** Compares two versions like 1.2.3 or 1.2.3-beta.1: negative if a is older, positive if newer. */
export function compareVersions(a: string, b: string) {
  const parse = (version: string) => {
    const [core, pre] = version.replace(/^v/, "").split("-", 2);
    return { core: core.split(".").map((part) => Number(part) || 0), pre: pre ?? null };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1; // A release is newer than its pre-releases.
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}
