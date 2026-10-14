import { Hono } from "hono";
import { expect, test } from "vitest";
import { tailnetOnly } from "./access.js";

const app = (users: string[]) => new Hono().use(tailnetOnly(users)).get("/", (c) => c.text("ok"));
const status = async (users: string[], headers: Record<string, string> = {}) => (await app(users).request("/", { headers })).status;

test("Funnel traffic is refused; local and tailnet traffic is allowed", async () => {
  expect(await status([], { "Tailscale-Funnel-Request": "?1" })).toBe(403);
  expect(await status([])).toBe(200);
  expect(await status([], { "Tailscale-User-Login": "anyone@example.com" })).toBe(200);
});

test("COLONY_ALLOWED_USERS limits which tailnet logins get in", async () => {
  const users = ["Me@Example.com"];
  expect(await status(users, { "Tailscale-User-Login": "me@example.com" })).toBe(200);
  expect(await status(users, { "Tailscale-User-Login": "guest@example.com" })).toBe(403);
  expect(await status(users)).toBe(200); // Direct on this PC.
});
