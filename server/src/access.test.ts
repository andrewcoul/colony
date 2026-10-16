import { Hono } from "hono";
import { expect, test } from "vitest";
import { tailnetOnly, type Owner } from "./access.js";

/** An owner record kept in memory, as settings.json keeps it. */
const owner = (allowed: string[] = [], login: string | null = null): Owner & { current: () => string | null } => {
  let recorded = login;
  return { allowed, login: () => recorded, claim: (next) => { recorded = next; }, current: () => recorded };
};
const app = (who: Owner) => new Hono().use(tailnetOnly(who)).get("/", (c) => c.text("ok"));
const status = async (who: Owner, headers: Record<string, string> = {}) => (await app(who).request("/", { headers })).status;

test("Funnel traffic is refused; requests made on this PC are allowed", async () => {
  expect(await status(owner(), { "Tailscale-Funnel-Request": "?1" })).toBe(403);
  expect(await status(owner())).toBe(200);
});

test("the first tailnet login is recorded as yours, and other logins are refused", async () => {
  const who = owner();
  expect(await status(who, { "Tailscale-User-Login": "Me@Example.com" })).toBe(200);
  expect(who.current()).toBe("me@example.com");
  expect(await status(who, { "Tailscale-User-Login": "me@example.com" })).toBe(200);
  expect(await status(who, { "Tailscale-User-Login": "guest@example.com" })).toBe(403);
  expect(await status(who)).toBe(200); // Direct on this PC.
});

test("a recorded owner login keeps everyone else out", async () => {
  const who = owner([], "me@example.com");
  expect(await status(who, { "Tailscale-User-Login": "marija@example.com" })).toBe(403);
  expect(who.current()).toBe("me@example.com");
});

test("COLONY_ALLOWED_USERS decides which tailnet logins get in", async () => {
  const who = owner(["Me@Example.com", "me@work.example"]);
  expect(await status(who, { "Tailscale-User-Login": "me@example.com" })).toBe(200);
  expect(await status(who, { "Tailscale-User-Login": "me@work.example" })).toBe(200);
  expect(await status(who, { "Tailscale-User-Login": "guest@example.com" })).toBe(403);
  expect(who.current()).toBeNull(); // Nothing is claimed while the list decides.
});
