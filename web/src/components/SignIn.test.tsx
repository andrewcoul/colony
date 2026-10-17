// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResetPage, SignInPage, SignUpPage } from "./SignIn";
import { WebSignInSection } from "./PeopleSettings";

/*
 * Tapping each sign-in form's button sends its request, shows that it's working, and shows any
 * failure (Better Auth's { message, code }, Colony's { error }, no network, a page that isn't JSON).
 */

type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (status: number) => new Response("<html>Bad gateway</html>", { status, headers: { "Content-Type": "text/html" } });

let routes: Record<string, Reply>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input).split("?")[0];
  const reply = routes[url];
  if (!reply) throw new Error(`unexpected fetch ${url}`);
  return typeof reply === "function" ? reply() : reply;
});
const calls = (url: string) => fetchMock.mock.calls.filter(([input]) => String(input).split("?")[0] === url);
const body = (url: string) => JSON.parse(String(calls(url).at(-1)?.[1]?.body));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  routes = { "/api/auth-status": json({ webSignIn: true, email: true, signedIn: false, via: "cloudflare" }) };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SignInPage", () => {
  it("tapping Sign in sends the email and password, and shows Better Auth's message", async () => {
    let answer!: (response: Response) => void;
    routes["/api/auth/sign-in/email"] = () => new Promise<Response>((resolve) => { answer = resolve; });
    render(<SignInPage />);
    type("Email", " boss@example.com ");
    type("Password", "a long password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Signing in…" })).toHaveProperty("disabled", true);
    expect(body("/api/auth/sign-in/email")).toEqual({ email: "boss@example.com", password: "a long password" });
    answer(json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", false);
  });

  it("says what's missing instead of doing nothing", async () => {
    render(<SignInPage />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your email.");
    type("Email", "boss@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Enter your password."));
    expect(calls("/api/auth/sign-in/email")).toHaveLength(0);
  });

  it.each([
    ["no network", () => Promise.reject(new TypeError("Load failed")), "Couldn't reach Colony. Check your connection, then try again."],
    ["an HTML error page", () => html(502), "That didn't work (502)."],
    ["an HTML page that says OK", () => html(200), "Colony sent back something unexpected (200). Try again."],
    ["only a code", () => json({ code: "USER_NOT_FOUND" }, 400), "That didn't work (user not found)."],
    ["too many tries", () => new Response("", { status: 429 }), "Too many tries. Wait a minute, then try again."],
  ])("shows a failure: %s", async (_name, reply, text) => {
    routes["/api/auth/sign-in/email"] = reply;
    render(<SignInPage />);
    type("Email", "boss@example.com");
    type("Password", "a long password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
  });

  it("emails a code, then signs in with it", async () => {
    routes["/api/auth/email-otp/send-verification-otp"] = json({ success: true });
    routes["/api/auth/sign-in/email-otp"] = json({ message: "Invalid OTP" }, 400);
    render(<SignInPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    type("Email", "boss@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByLabelText("Code from the email")).toBeTruthy();
    expect(body("/api/auth/email-otp/send-verification-otp")).toEqual({ email: "boss@example.com", type: "sign-in" });
    type("Code from the email", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid OTP");
    expect(body("/api/auth/sign-in/email-otp")).toEqual({ email: "boss@example.com", otp: "123456" });
  });

  it("emails a link to reset a forgotten password", async () => {
    routes["/api/auth/request-password-reset"] = json({ error: "Email isn't set up." }, 503);
    render(<SignInPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Forgot your password?" }));
    type("Email", "boss@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Email isn't set up.");
    expect(body("/api/auth/request-password-reset").email).toBe("boss@example.com");
  });
});

describe("SignUpPage", () => {
  beforeEach(() => { routes["/api/invites/check"] = json({ valid: true, email: "ana@example.com" }); });

  it("tapping Create my account signs up with the invite, and shows the server's error", async () => {
    routes["/api/auth/sign-up/email"] = json({ message: "This invite was already used." }, 400);
    render(<SignUpPage invite="tok" />);
    await screen.findByLabelText("Choose a password");
    type("Choose a password", "a long password");
    type("Once more", "a long password");
    fireEvent.click(screen.getByRole("button", { name: "Create my account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This invite was already used.");
    expect(body("/api/auth/sign-up/email")).toMatchObject({ email: "ana@example.com", password: "a long password", invite: "tok" });
  });

  it("says a short password is too short", async () => {
    render(<SignUpPage invite="tok" />);
    await screen.findByLabelText("Choose a password");
    type("Choose a password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Create my account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use at least 10 characters.");
    expect(calls("/api/auth/sign-up/email")).toHaveLength(0);
  });

  it("says when it can't check the invite", async () => {
    routes["/api/invites/check"] = () => Promise.reject(new TypeError("Load failed"));
    render(<SignUpPage invite="tok" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach Colony. Check your connection, then try again.");
  });
});

describe("ResetPage", () => {
  it("tapping Save it sets the new password, and shows a failure", async () => {
    routes["/api/auth/reset-password"] = json({ message: "Invalid token", code: "INVALID_TOKEN" }, 400);
    render(<ResetPage token="tok" />);
    type("New password", "a new long password");
    fireEvent.click(screen.getByRole("button", { name: "Save it" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid token");
    expect(body("/api/auth/reset-password")).toEqual({ token: "tok", newPassword: "a new long password" });
  });

  it("then offers to sign in", async () => {
    routes["/api/auth/reset-password"] = json({ status: true });
    render(<ResetPage token="tok" />);
    type("New password", "a new long password");
    fireEvent.click(screen.getByRole("button", { name: "Save it" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});

describe("Settings › People › Set up web sign-in", () => {
  beforeEach(() => { routes["/api/web-signin"] = json({ enabled: true, email: false, adminEmails: ["boss@example.com"], origins: [] }); });

  it("tapping Save sets the admin's password, showing that it's working", async () => {
    let answer!: (response: Response) => void;
    routes["/api/web-signin/admin"] = () => new Promise<Response>((resolve) => { answer = resolve; });
    render(<WebSignInSection />);
    fireEvent.change(await screen.findByLabelText("Web sign-in password"), { target: { value: "a long admin password" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    expect(body("/api/web-signin/admin")).toEqual({ email: "boss@example.com", password: "a long admin password" });
    answer(new Response(null, { status: 204 }));
    expect(await screen.findByText("Done: sign in on the web as boss@example.com.")).toBeTruthy();
  });

  it("isn't silently disabled for a short password: it says so", async () => {
    render(<WebSignInSection />);
    fireEvent.change(await screen.findByLabelText("Web sign-in password"), { target: { value: "short" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect((await screen.findByRole("alert")).textContent).toBe("Use at least 10 characters.");
    expect(calls("/api/web-signin/admin")).toHaveLength(0);
  });

  it.each([
    ["the server's error", () => json({ error: "That email isn't in COLONY_ADMIN_EMAILS." }, 400), "That email isn't in COLONY_ADMIN_EMAILS."],
    ["no network", () => Promise.reject(new TypeError("Load failed")), "Couldn't reach Colony. Check your connection, then try again."],
    ["an HTML error page", () => html(500), "Request failed (500)."],
  ])("shows %s", async (_name, reply, text) => {
    routes["/api/web-signin/admin"] = reply;
    render(<WebSignInSection />);
    fireEvent.change(await screen.findByLabelText("Web sign-in password"), { target: { value: "a long admin password" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
  });

  it("says when it can't load", async () => {
    routes["/api/web-signin"] = json({ error: "Only the admin can do that." }, 403);
    render(<WebSignInSection />);
    expect((await screen.findByRole("alert")).textContent).toBe("Only the admin can do that.");
  });
});
