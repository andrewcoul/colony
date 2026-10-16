import type { Price } from "./shared/types.js";

/**
 * Approximate list prices in US dollars per million tokens, for pre-filling a provider's models.
 * Anyone can change them on their own providers (the host on shared ones). First match wins,
 * so the smaller models come before the families they belong to.
 */
const BUILT_IN: [RegExp, Price][] = [
  [/claude.*opus/i, { input: 5, output: 25, cached: 0.5 }],
  [/claude.*sonnet/i, { input: 3, output: 15, cached: 0.3 }],
  [/claude.*haiku/i, { input: 1, output: 5, cached: 0.1 }],
  [/gpt-5.*nano/i, { input: 0.05, output: 0.4, cached: 0.005 }],
  [/gpt-5.*mini/i, { input: 0.25, output: 2, cached: 0.025 }],
  [/gpt-5/i, { input: 1.25, output: 10, cached: 0.125 }],
  [/gpt-4\.1.*nano/i, { input: 0.1, output: 0.4, cached: 0.025 }],
  [/gpt-4\.1.*mini/i, { input: 0.4, output: 1.6, cached: 0.1 }],
  [/gpt-4\.1/i, { input: 2, output: 8, cached: 0.5 }],
  [/gpt-4o.*mini/i, { input: 0.15, output: 0.6, cached: 0.075 }],
  [/gpt-4o/i, { input: 2.5, output: 10, cached: 1.25 }],
  [/o4-mini/i, { input: 1.1, output: 4.4, cached: 0.275 }],
  [/\bo3\b/i, { input: 2, output: 8, cached: 0.5 }],
  [/gemini.*flash-lite/i, { input: 0.1, output: 0.4, cached: 0.025 }],
  [/gemini.*flash/i, { input: 0.3, output: 2.5, cached: 0.075 }],
  [/gemini.*pro/i, { input: 1.25, output: 10, cached: 0.31 }],
  [/deepseek/i, { input: 0.28, output: 0.42, cached: 0.028 }],
];

export const builtInPrice = (model: string): Price | null => BUILT_IN.find(([pattern]) => pattern.test(model))?.[1] ?? null;

/** What one model step cost, in millionths of a dollar (tokens × dollars per million). Null when the model has no price. */
export function costMicros(usage: { input: number; cached: number; output: number }, price: Price | null) {
  if (!price) return null;
  return Math.round((usage.input - usage.cached) * price.input + usage.cached * (price.cached ?? price.input) + usage.output * price.output);
}
