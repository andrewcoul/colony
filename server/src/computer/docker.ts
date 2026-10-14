import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventLog } from "../events.js";
import { botDir, workspaceDir } from "../files.js";
import type { Store } from "../store.js";

/** Bump with computer/Dockerfile; containers on an older image are recreated (/workspace persists). */
const IMAGE = "colony-computer:3";
const CDP_PORT = "9223";
/** cua-spacesd inside the computer: screenshots, input and the live viewer of the desktop. */
const SPACESD_PORT = "3211";
/** The desktop session's user; Bot commands run as this user so the desktop can use their files. */
const DESKTOP_USER = "cua";
const CONTEXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../computer");
const LOG_MAX = 256_000;
const LOG_KEEP = 200_000;
const OUTPUT_TO_MODEL = 20_000;

export type ExecResult = { exitCode: number; output: string; truncated: boolean; timedOut: boolean; durationMs: number };

function run(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("docker", args, { windowsHide: true, env: options.env ? { ...process.env, ...options.env } : undefined });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr + error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options.input) child.stdin.end(options.input);
  });
}

/**
 * One Docker container per Bot: its own Linux computer with /workspace bind-mounted
 * from data/bots/<id>/workspace. Hardened: no privileges, capped memory/CPU/processes.
 */
export class ComputerService {
  private starting = new Map<string, Promise<void>>();
  /** Called whenever a Bot's computer is used (the idle stopper listens). */
  onUse: (botId: string) => void = () => {};
  private imageReady: Promise<void> | null = null;

  constructor(private store: Store, private events: EventLog) {}

  containerName(botId: string) {
    return `colony-${botId.slice(0, 8)}`;
  }

  /** The Bot's spacesd token (full control of its desktop). Kept in its folder, readable only by you. */
  private spacesdToken(botId: string) {
    const file = path.join(botDir(botId), "spacesd.token");
    try {
      const saved = fs.readFileSync(file, "utf8").trim();
      if (saved) return saved;
    } catch { /* first start */ }
    const token = randomBytes(24).toString("hex");
    fs.mkdirSync(botDir(botId), { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
    return token;
  }

  private async hostPort(name: string, port: string) {
    const answer = await run(["port", name, port]);
    const address = answer.stdout.split(/\r?\n/).find((line) => line.startsWith("127.0.0.1:"));
    return address ? Number(address.trim().split(":")[1]) : null;
  }

  private ensureImage() {
    this.imageReady ??= (async () => {
      if ((await run(["image", "inspect", IMAGE])).code === 0) return;
      const build = await run(["build", "-t", IMAGE, CONTEXT]);
      if (build.code !== 0) throw new Error(`Couldn't build the computer image: ${build.stderr.slice(-300)}`);
    })().catch((error) => { this.imageReady = null; throw error; });
    return this.imageReady;
  }

  /** Starts (or creates) the Bot's container. Concurrent callers share one start. */
  ensure(botId: string) {
    this.onUse(botId);
    const existing = this.starting.get(botId);
    if (existing) return existing;
    const start = (async () => {
      const name = this.containerName(botId);
      const inspect = await run(["inspect", "-f", "{{.Config.Image}}|{{.State.Running}}", name]);
      const [image, running] = inspect.stdout.trim().split("|");
      const current = inspect.code === 0 && image === IMAGE;
      if (current && running === "true") { this.store.setComputerState(botId, "on"); return; }
      this.store.setComputerState(botId, "starting");
      try {
        await this.ensureImage();
        const migrating = inspect.code === 0 && !current;
        if (migrating) await run(["rm", "-f", name]); // Outdated image: rebuild around the same files.
        if (current) {
          const started = await run(["start", name]);
          if (started.code !== 0) throw new Error(started.stderr.trim());
        } else {
          fs.mkdirSync(workspaceDir(botId), { recursive: true });
          fs.mkdirSync(path.join(botDir(botId), "browser"), { recursive: true });
          const created = await run([
            "run", "-d", "--name", name, "--hostname", name, "--label", `colony.bot=${botId}`,
            // Passed through the environment so the token never shows in a command line.
            "-e", "CUA_ENV_TOKEN",
            "-v", `${workspaceDir(botId)}:/workspace`,
            // The browser profile (logins) lives outside the workspace the Bot shares with you.
            "-v", `${path.join(botDir(botId), "browser")}:/browser`,
            // DevTools for the Bot's browser, reachable only from this PC.
            "-p", `127.0.0.1::${CDP_PORT}`,
            // The desktop (screenshots, input, live viewer), also only from this PC.
            "-p", `127.0.0.1::${SPACESD_PORT}`,
            "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "512m",
            "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
            "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL",
            "--security-opt", "no-new-privileges",
            IMAGE,
          ], { env: { CUA_ENV_TOKEN: this.spacesdToken(botId) } });
          if (created.code !== 0) throw new Error(created.stderr.trim() || "docker run failed");
        }
        // Files made by older computers (as root) or by Colony's file tools belong to the desktop user.
        await run(["exec", name, "chown", "-R", `${DESKTOP_USER}:${DESKTOP_USER}`, "/workspace", "/browser"]);
        await this.waitForDesktop(name);
        this.store.setComputerState(botId, "on");
        if (migrating) void this.pruneOldImages();
      } catch (error) {
        this.store.setComputerState(botId, "error");
        throw new Error(`The computer couldn't start. Is Docker running? (${error instanceof Error ? error.message.slice(0, 200) : "unknown"})`);
      }
    })().finally(() => this.starting.delete(botId));
    this.starting.set(botId, start);
    return start;
  }

  /** Runs a command in the Bot's computer, streaming output to the terminal panel. */
  async exec(botId: string, command: string, options: { cwd?: string; timeoutSec?: number; signal: AbortSignal }): Promise<ExecResult> {
    this.onUse(botId);
    await this.ensure(botId);
    const name = this.containerName(botId);
    const execId = randomUUID().slice(0, 8);
    const timeout = Math.min(Math.max(options.timeoutSec ?? 120, 1), 1800);
    const cwd = options.cwd && options.cwd.startsWith("/workspace") ? options.cwd : "/workspace";
    const started = Date.now();
    this.appendLog(botId, `$ ${command}\n`);

    // setsid gives the command its own process group so Stop can kill all of it.
    const script = `echo $$ > /tmp/colony-${execId}.pid; exec timeout -k 5 ${timeout}s bash -lc "$COLONY_CMD"`;
    const child = spawn("docker", ["exec", "-i", "-u", DESKTOP_USER, "-e", `HOME=/home/${DESKTOP_USER}`, "-e", "DISPLAY=:1", "-w", cwd, "-e", "COLONY_CMD", name, "setsid", "-w", "bash", "-c", script], {
      windowsHide: true,
      env: { ...process.env, COLONY_CMD: command },
    });
    child.stdin.end();

    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (output.length < 1_000_000) output += text;
      this.appendLog(botId, text);
      this.events.broadcast({ type: "computer.output", botId, text });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const kill = () => {
      void run(["exec", name, "bash", "-c", `kill -KILL -- -$(cat /tmp/colony-${execId}.pid) 2>/dev/null; rm -f /tmp/colony-${execId}.pid`]);
      child.kill();
    };
    options.signal.addEventListener("abort", kill, { once: true });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });
    options.signal.removeEventListener("abort", kill);
    void run(["exec", name, "rm", "-f", `/tmp/colony-${execId}.pid`]);

    const timedOut = exitCode === 124 || exitCode === 137;
    const footer = options.signal.aborted ? "^C stopped\n" : timedOut ? `(timed out after ${timeout}s)\n` : exitCode !== 0 ? `(exit ${exitCode})\n` : "";
    if (footer) this.appendLog(botId, footer);
    const truncated = output.length > OUTPUT_TO_MODEL;
    return {
      exitCode,
      // Keep the head and tail: errors usually sit at the end.
      output: truncated ? output.slice(0, 4000) + `\n…[${output.length - OUTPUT_TO_MODEL} chars omitted]…\n` + output.slice(-(OUTPUT_TO_MODEL - 4000)) : output,
      truncated,
      timedOut,
      durationMs: Date.now() - started,
    };
  }

  /** Starts the Bot's browser if needed and returns its DevTools address on this PC. */
  /** The desktop answers health checks a few seconds after the container starts. */
  private async waitForDesktop(name: string) {
    const port = await this.hostPort(name, SPACESD_PORT);
    if (!port) return; // Older layout without the desktop port; the computer still works.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.status === 204) return;
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Where the Bot's desktop (cua-spacesd) listens on this PC, and its token. Starts the computer if needed. */
  async desktopEndpoint(botId: string) {
    await this.ensure(botId);
    const port = await this.hostPort(this.containerName(botId), SPACESD_PORT);
    if (!port) throw new Error("The desktop isn't available on this computer; turn it off and on again.");
    return { url: `http://127.0.0.1:${port}`, token: this.spacesdToken(botId) };
  }

  /** The desktop's port if the computer is already running (never starts it). */
  async runningDesktopPort(botId: string) {
    const name = this.containerName(botId);
    const inspect = await run(["inspect", "-f", "{{.State.Running}}", name]);
    if (inspect.stdout.trim() !== "true") return null;
    return this.hostPort(name, SPACESD_PORT);
  }

  async browserEndpoint(botId: string) {
    await this.ensure(botId);
    const name = this.containerName(botId);
    const started = await run(["exec", name, "colony-browser"]);
    if (started.code !== 0) throw new Error(`The browser couldn't start: ${(started.stderr || started.stdout).trim().slice(-300)}`);
    const port = await run(["port", name, CDP_PORT]);
    const address = port.stdout.split(/\r?\n/).find((line) => line.startsWith("127.0.0.1:"));
    if (!address) throw new Error("The browser's DevTools port isn't published; turn the computer off and on again.");
    return `http://${address.trim()}`;
  }

  async remove(botId: string) {
    await run(["rm", "-f", this.containerName(botId)]);
  }

  async stop(botId: string) {
    await run(["stop", "-t", "2", this.containerName(botId)]);
    this.store.setComputerState(botId, "off");
  }

  /** Bots whose computers are running right now. */
  async runningBots() {
    const list = await run(["ps", "--filter", "label=colony.bot", "--format", "{{.Label \"colony.bot\"}}"]);
    return list.code === 0 ? list.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  }

  /** Marks containers that are actually running (e.g. after a server restart). */
  async syncStates() {
    const running = new Set(await this.runningBots());
    for (const bot of this.store.listBots()) this.store.setComputerState(bot.id, running.has(bot.id) ? "on" : "off");
  }

  /**
   * Deletes older computer images once no container (running or stopped) uses them, i.e. after
   * every Bot's computer has moved to the current image. The Cua base image stays: the current
   * image is built on it and shares its layers.
   */
  async pruneOldImages() {
    const images = await run(["images", "colony-computer", "--format", "{{.Repository}}:{{.Tag}}"]);
    if (images.code !== 0) return [];
    const removed: string[] = [];
    for (const ref of images.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      if (ref === IMAGE || ref.endsWith(":<none>")) continue;
      const users = await run(["ps", "-a", "-q", "--filter", `ancestor=${ref}`]);
      if (users.code !== 0 || users.stdout.trim()) continue;
      if ((await run(["rmi", ref])).code === 0) removed.push(ref);
    }
    if (removed.length) console.log(`[colony] Removed old computer images: ${removed.join(", ")}`);
    return removed;
  }

  readLog(botId: string) {
    try { return fs.readFileSync(path.join(botDir(botId), "terminal.log"), "utf8"); } catch { return ""; }
  }

  private appendLog(botId: string, text: string) {
    const file = path.join(botDir(botId), "terminal.log");
    try {
      fs.appendFileSync(file, text);
      if (fs.statSync(file).size > LOG_MAX) fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(-LOG_KEEP));
    } catch { /* the Bot folder may have been deleted mid-run */ }
  }
}
