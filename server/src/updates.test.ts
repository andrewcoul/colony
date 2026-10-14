import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BusyError, RESTART, Updater, archiveName, type HomeState } from "./updates.js";
import { compareVersions } from "./version.js";

const ARCHIVE = Buffer.from("pretend this is a zip");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const homes: string[] = [];

function makeHome(state: HomeState | null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "colony-home-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, "versions", "0.1.0"), { recursive: true });
  if (state) fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(state));
  return home;
}
const readState = (home: string) => JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8")) as HomeState;

/** A pretend GitHub: the latest release is `latest`, with this platform's archive and checksums. */
function github(latest: string, { sum = sha(ARCHIVE), withArchive = true } = {}) {
  const name = archiveName(latest, "win32", "x64");
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("/releases/latest")) {
      return Response.json({
        tag_name: `v${latest}`, body: "What's new", html_url: `https://github.com/x/y/releases/v${latest}`, published_at: "2026-10-14T00:00:00Z",
        assets: [
          ...(withArchive ? [{ name, browser_download_url: `https://dl/${name}` }] : []),
          { name: "SHA256SUMS", browser_download_url: "https://dl/SHA256SUMS" },
        ],
      });
    }
    if (href === "https://dl/SHA256SUMS") return new Response(`${sum}  ${name}\nabc  install-colony-server.ps1\n`);
    if (href === `https://dl/${name}`) return new Response(ARCHIVE, { headers: { "content-length": String(ARCHIVE.length) } });
    return new Response("not found", { status: 404 });
  });
}

/** Unpacks the pretend archive as the given version. */
const fakeExtract = (version: string) => async (_archive: string, into: string) => {
  fs.mkdirSync(path.join(into, "server", "dist"), { recursive: true });
  fs.mkdirSync(path.join(into, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(into, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(into, "server", "dist", "index.js"), "");
  fs.writeFileSync(path.join(into, "scripts", "launcher.mjs"), `// launcher ${version}`);
};

function updater(home: string | null, options: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
  return new Updater({ version: "0.1.0", home, repo: "x/y", platform: "win32", arch: "x64", fetch: github("0.2.0") as never, extract: fakeExtract("0.2.0"), exit: vi.fn(), ...options });
}

async function settle(target: Updater) {
  await vi.waitFor(() => expect(["restarting", "failed"]).toContain(target.info().update.status));
}

afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("compareVersions", () => {
  test("orders releases and pre-releases", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
  });
});

describe("Updater", () => {
  test("reports a newer release with a download for this computer", async () => {
    const target = updater(makeHome({ current: "0.1.0" }));
    await target.check();
    expect(target.info()).toMatchObject({ version: "0.1.0", managed: true, available: true, latest: { version: "0.2.0", notes: "What's new" } });
  });

  test("a release without this computer's download isn't offered", async () => {
    const target = updater(makeHome({ current: "0.1.0" }), { fetch: github("0.2.0", { withArchive: false }) as never });
    await target.check();
    expect(target.info().available).toBe(false);
  });

  test("installs the new version as a trial and restarts into it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const exit = vi.fn();
    const home = makeHome({ current: "0.1.0", failed: { version: "0.1.5", at: "x", reason: "y" } });
    const target = updater(home, { exit });
    await target.install();
    await vi.waitFor(() => expect(target.info().update.status).toBe("restarting"));
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(RESTART);
    expect(readState(home)).toMatchObject({ current: "0.1.0", trial: "0.2.0", failed: null });
    expect(fs.existsSync(path.join(home, "versions", "0.2.0", "server", "dist", "index.js"))).toBe(true);
    expect(fs.readdirSync(path.join(home, "downloads"))).toEqual([]);
  });

  test("waits for permission while Bots are mid-reply", async () => {
    const home = makeHome({ current: "0.1.0" });
    const target = updater(home, { busy: () => ["John"] });
    await expect(target.install()).rejects.toBeInstanceOf(BusyError);
    expect(target.info().update.status).toBe("idle");
    await target.install({ force: true });
    await settle(target);
    expect(target.info().update.status).toBe("restarting");
  });

  test("refuses a download that doesn't match the release's checksum", async () => {
    const home = makeHome({ current: "0.1.0" });
    const target = updater(home, { fetch: github("0.2.0", { sum: "0".repeat(64) }) as never });
    await target.install();
    await settle(target);
    expect(target.info().update).toMatchObject({ status: "failed", error: expect.stringContaining("checksum") });
    expect(readState(home).trial).toBeUndefined();
    expect(fs.existsSync(path.join(home, "versions", "0.2.0"))).toBe(false);
  });

  test("refuses an archive that holds some other version", async () => {
    const home = makeHome({ current: "0.1.0" });
    const target = updater(home, { extract: fakeExtract("0.1.9") });
    await target.install();
    await settle(target);
    expect(target.info().update).toMatchObject({ status: "failed", error: expect.stringContaining("doesn't contain") });
    expect(readState(home).trial).toBeUndefined();
  });

  test("a Colony run from source can't update itself", async () => {
    await expect(updater(null).install()).rejects.toThrow("runs from source");
    expect(updater(null).info().managed).toBe(false);
  });

  test("a confirmed trial becomes current; older versions and the old launcher go", async () => {
    const home = makeHome({ current: "0.1.0", previous: "0.0.9", trial: "0.2.0" });
    for (const version of ["0.0.9", "0.2.0"]) fs.mkdirSync(path.join(home, "versions", version), { recursive: true });
    await fakeExtract("0.2.0")("", path.join(home, "versions", "0.2.0"));
    fs.writeFileSync(path.join(home, "launcher.mjs"), "// launcher 0.1.0");

    expect(updater(home, { version: "0.2.0" }).confirm()).toBe(true);
    expect(readState(home)).toMatchObject({ current: "0.2.0", previous: "0.1.0", trial: null, updated: { from: "0.1.0", to: "0.2.0" } });
    expect(fs.readdirSync(path.join(home, "versions")).sort()).toEqual(["0.1.0", "0.2.0"]);
    expect(fs.readFileSync(path.join(home, "launcher.mjs"), "utf8")).toBe("// launcher 0.2.0");
    // Nothing to confirm on the next start.
    expect(updater(home, { version: "0.2.0" }).confirm()).toBe(false);
  });
});
