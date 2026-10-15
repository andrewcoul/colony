import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { compareVersions } from "./version.js";

/**
 * Server updates. An installed Colony (see scripts/install.ps1) lives in a home folder:
 *
 *   versions/<version>/   one folder per installed version
 *   state.json            { current, previous, trial, failed, updated }
 *   launcher.mjs          runs `trial ?? current`, and restarts it when it exits
 *
 * Updating downloads the release's archive from GitHub, checks it against the release's
 * SHA256SUMS, unpacks it into versions/<new>, marks it as the trial and exits with RESTART.
 * The launcher starts the new version; once it has been up for a little while it confirms
 * itself (`confirm`). If it exits before then, the launcher goes back to the previous version
 * and records why in `failed`. A Colony run from a git checkout has no home and only reports
 * what's available.
 */

/** Exit code that asks the launcher to start Colony again right away (e.g. on a new version). */
export const RESTART = 75;

export type HomeState = {
  current: string;
  previous?: string | null;
  trial?: string | null;
  failed?: { version: string; at: string; reason: string } | null;
  updated?: { from: string | null; to: string; at: string } | null;
};

export type Release = { version: string; notes: string; url: string; publishedAt: string; download: string | null; sums: string | null };
export type UpdateStatus = "idle" | "downloading" | "installing" | "restarting" | "failed";
export type SystemInfo = {
  version: string;
  /** Installed with a home folder, so it can update itself. */
  managed: boolean;
  latest: Omit<Release, "download" | "sums"> | null;
  /** A newer version is out and has a download for this platform. */
  available: boolean;
  checkedAt: number | null;
  update: { status: UpdateStatus; target: string | null; progress: number | null; error: string | null };
  failed: HomeState["failed"];
  updated: HomeState["updated"];
};

export class BusyError extends Error {
  constructor(public names: string[]) {
    super(`${names.join(" and ")} ${names.length === 1 ? "is" : "are"} working. Updating restarts Colony; ${names.length === 1 ? "that reply picks" : "those replies pick"} up where ${names.length === 1 ? "it" : "they"} left off.`);
  }
}

/** This platform's server archive, e.g. colony-server-0.2.0-win-x64.zip. */
export const archiveName = (version: string, platform: string = process.platform, arch: string = process.arch) =>
  `colony-server-${version}-${platform === "win32" ? "win" : platform}-${arch}.zip`;

const CHECK_EVERY = 3 * 3600_000;

export class Updater {
  private latest: Release | null = null;
  private checkedAt: number | null = null;
  private checking: Promise<void> | null = null;
  private status: SystemInfo["update"] = { status: "idle", target: null, progress: null, error: null };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private options: {
    version: string;
    /** The install's home folder, or null when Colony runs from a checkout. */
    home: string | null;
    /** GitHub repository that publishes releases, e.g. "andrewcoul/colony". */
    repo: string;
    apiBase?: string;
    fetch?: typeof fetch;
    /** Names of Bots in the middle of a reply (an update would cut them off). */
    busy?: () => string[];
    /** Unpacks a .zip into a folder. */
    extract?: (archive: string, into: string) => Promise<void>;
    exit?: (code: number) => void;
    platform?: NodeJS.Platform;
    arch?: string;
  }) {}

  private get fetch() { return this.options.fetch ?? fetch; }
  private get stateFile() { return this.options.home ? path.join(this.options.home, "state.json") : null; }

  readState(): HomeState | null {
    if (!this.stateFile) return null;
    try { return JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as HomeState; } catch { return null; }
  }

  private writeState(state: HomeState) {
    if (!this.stateFile) return;
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  get managed() {
    return Boolean(this.options.home && this.readState());
  }

  info(): SystemInfo {
    const state = this.readState();
    const latest = this.latest;
    return {
      version: this.options.version,
      managed: this.managed,
      latest: latest && { version: latest.version, notes: latest.notes, url: latest.url, publishedAt: latest.publishedAt },
      available: Boolean(latest?.download && compareVersions(latest.version, this.options.version) > 0),
      checkedAt: this.checkedAt,
      update: this.status,
      failed: state?.failed ?? null,
      updated: state?.updated ?? null,
    };
  }

  /** Checks GitHub for the latest release (shared by everyone asking at once). */
  check(): Promise<void> {
    this.checking ??= (async () => {
      const response = await this.fetch(`${this.options.apiBase ?? "https://api.github.com"}/repos/${this.options.repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": `colony/${this.options.version}` },
        signal: AbortSignal.timeout(15_000),
      });
      this.checkedAt = Date.now();
      if (response.status === 404) { this.latest = null; return; } // Nothing released yet.
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
      const release = await response.json() as { tag_name: string; body?: string; html_url: string; published_at: string; assets: { name: string; browser_download_url: string }[] };
      const version = release.tag_name.replace(/^v/, "");
      const asset = (name: string) => release.assets.find((item) => item.name === name)?.browser_download_url ?? null;
      this.latest = {
        version,
        notes: (release.body ?? "").slice(0, 4000),
        url: release.html_url,
        publishedAt: release.published_at,
        download: asset(archiveName(version, this.options.platform, this.options.arch)),
        sums: asset("SHA256SUMS"),
      };
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  /** Checks now and then every few hours. */
  start() {
    const check = () => void this.check().catch((error) => console.log(`[colony] Couldn't check for updates: ${error instanceof Error ? error.message : error}`));
    setTimeout(check, 20_000).unref();
    this.timer = setInterval(check, CHECK_EVERY);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /**
   * Downloads and installs the latest version, then restarts into it. Resolves once the
   * work has started; follow it with `info().update`. Throws BusyError while Bots are mid-reply
   * (unless forced).
   */
  async install({ force = false } = {}) {
    const home = this.options.home;
    const state = this.readState();
    if (!home || !state) throw new Error("This Colony runs from source, so it can't update itself. Pull the latest code and rebuild instead.");
    if (this.status.status === "downloading" || this.status.status === "installing" || this.status.status === "restarting") return;
    if (!this.latest) await this.check();
    const release = this.latest;
    if (!release || compareVersions(release.version, this.options.version) <= 0) throw new Error("Colony is already up to date.");
    if (!release.download || !release.sums) throw new Error(`Version ${release.version} has no server download for this computer.`);
    const busy = this.options.busy?.() ?? [];
    if (busy.length && !force) throw new BusyError(busy);

    this.status = { status: "downloading", target: release.version, progress: 0, error: null };
    void this.run(home, state, release).catch((error) => {
      this.status = { status: "failed", target: release.version, progress: null, error: error instanceof Error ? error.message : String(error) };
      console.log(`[colony] Update to ${release.version} failed: ${this.status.error}`);
    });
  }

  private async run(home: string, state: HomeState, release: Release) {
    const name = archiveName(release.version, this.options.platform, this.options.arch);
    const downloads = path.join(home, "downloads");
    fs.mkdirSync(downloads, { recursive: true });
    const archive = path.join(downloads, name);
    try {
      const sums = await this.fetch(release.sums!, { signal: AbortSignal.timeout(30_000) });
      if (!sums.ok) throw new Error(`Couldn't download the checksums (${sums.status}).`);
      const expected = (await sums.text()).split(/\r?\n/).map((line) => line.trim().split(/\s+\*?/)).find(([, file]) => file === name)?.[0]?.toLowerCase();
      if (!expected) throw new Error(`The release's checksums don't list ${name}.`);

      const response = await this.fetch(release.download!, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Couldn't download version ${release.version} (${response.status}).`);
      const total = Number(response.headers.get("content-length")) || 0;
      const hash = createHash("sha256");
      let received = 0;
      const progress = this.status;
      await pipeline(
        Readable.fromWeb(response.body as never),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            received += chunk.length;
            if (total) progress.progress = Math.min(1, received / total);
            done(null, chunk);
          },
        }),
        fs.createWriteStream(archive),
      );
      if (hash.digest("hex") !== expected) throw new Error("The download doesn't match the release's checksum, so it wasn't installed.");

      this.status = { status: "installing", target: release.version, progress: null, error: null };
      const target = path.join(home, "versions", release.version);
      const partial = `${target}.partial`;
      fs.rmSync(partial, { recursive: true, force: true });
      fs.mkdirSync(partial, { recursive: true });
      await (this.options.extract ?? extractZip)(archive, partial);
      const unpacked = JSON.parse(fs.readFileSync(path.join(partial, "package.json"), "utf8")) as { version?: string };
      if (unpacked.version !== release.version || !fs.existsSync(path.join(partial, "server", "dist", "index.js"))) {
        throw new Error(`The download doesn't contain Colony ${release.version}.`);
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(partial, target);

      this.writeState({ ...state, trial: release.version, failed: null });
      this.status = { status: "restarting", target: release.version, progress: null, error: null };
      console.log(`[colony] Installed ${release.version}; restarting into it.`);
      setTimeout(() => (this.options.exit ?? process.exit)(RESTART), 500);
    } finally {
      fs.rmSync(archive, { force: true });
    }
  }

  /**
   * Called once this version has run for a while: makes a trial version the current one,
   * refreshes the launcher, and removes versions older than the previous one.
   */
  confirm() {
    const home = this.options.home;
    const state = this.readState();
    if (!home || !state || state.trial !== this.options.version) return false;
    const from = state.current === this.options.version ? state.previous ?? null : state.current;
    this.writeState({ current: this.options.version, previous: from, trial: null, failed: null, updated: { from, to: this.options.version, at: new Date().toISOString() } });
    // The new version's launcher and service script take over from their next start.
    for (const file of ["launcher.mjs", "service.ps1"]) {
      const source = path.join(home, "versions", this.options.version, "scripts", file);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(home, `${file}.tmp`));
      fs.renameSync(path.join(home, `${file}.tmp`), path.join(home, file));
    }
    const keep = new Set([this.options.version, from]);
    for (const entry of fs.readdirSync(path.join(home, "versions"))) {
      if (!keep.has(entry)) fs.rmSync(path.join(home, "versions", entry), { recursive: true, force: true });
    }
    console.log(`[colony] Updated to ${this.options.version}${from ? ` from ${from}` : ""}.`);
    return true;
  }
}

/** Unpacks a .zip with the system's tar (Windows 10+ includes bsdtar, which reads zips). */
function extractZip(archive: string, into: string) {
  const systemTar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const tar = process.platform === "win32" && !fs.existsSync(systemTar) ? "tar" : systemTar;
  return new Promise<void>((resolve, reject) => {
    execFile(tar, ["-xf", archive, "-C", into], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Couldn't unpack the update: ${(stderr || error.message).slice(-300)}`));
      else resolve();
    });
  });
}
