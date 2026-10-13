import { expect, test } from "vitest";
import { normalizeSearch } from "../src/search/client";

test("accepts public results and omits executable links and private destinations", () => {
  const result = normalizeSearch({ content: [{ type: "text", text: JSON.stringify({ web: [
    { url: "https://v2.tauri.app", title: "Tauri", description: "Official docs" },
    { url: "javascript:alert(1)", title: "Unsafe" },
    { url: "http://127.0.0.1:3002", title: "Private" },
    { url: "http://192.168.1.1", title: "Private" },
    { url: "https://user:password@example.com", title: "Credentials" },
  ] }) }] });
  expect(result).toEqual([{ url: "https://v2.tauri.app", title: "Tauri", description: "Official docs" }]);
});

test("tool failures cannot turn into successful search results", () => {
  expect(() => normalizeSearch({ isError: true, content: [{ type: "text", text: "failed" }] })).toThrow("unavailable");
});
