import { expect, test } from "vitest";
import { plainText } from "./store.js";

test("roster previews strip Markdown to one plain line", () => {
  expect(plainText("**Canberra** — the capital.\n\nSource: [Gov](https://www.australia.gov.au)")).toBe("Canberra — the capital. Source: Gov");
  expect(plainText("## Plan\n- step one\n- `npm test`\n```ts\nconst x = 1;\n```\nDone")).toBe("Plan step one npm test Done");
});
