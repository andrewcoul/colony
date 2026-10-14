import { expect, test } from "vitest";
import { stripNotes } from "./agent/prompt.js";
import { plainText } from "./store.js";

test("roster previews strip Markdown to one plain line", () => {
  expect(plainText("**Canberra** — the capital.\n\nSource: [Gov](https://www.australia.gov.au)")).toBe("Canberra — the capital. Source: Gov");
  expect(plainText("## Plan\n- step one\n- `npm test`\n```ts\nconst x = 1;\n```\nDone")).toBe("Plan step one npm test Done");
});

test("stripNotes removes system notes a model copied into its reply", () => {
  expect(stripNotes("[System note, not part of your reply: you used tools: Ran x]\n\nThe hash is abc.")).toBe("The hash is abc.");
  expect(stripNotes("The hash is abc.\n\n(Actions taken: Messaged John (Engineer) — hash; Ran `sha256sum` — 0.1s)")).toBe("The hash is abc.");
  expect(stripNotes("Keep (parentheses) like this.")).toBe("Keep (parentheses) like this.");
});
