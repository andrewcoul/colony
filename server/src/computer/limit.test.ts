import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

/* Bot computers belong to their Bot's owner: labeled with them, and limited for members. */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-computers-"));
process.env.COLONY_DATA_DIR = dataDir;
delete process.env.COLONY_MEMBER_MAX_COMPUTERS;

const { openDb } = await import("../db.js");
const { EventLog } = await import("../events.js");
const { Store } = await import("../store.js");
const { People } = await import("../people.js");
const { ComputerLimitError, ComputerService } = await import("./docker.js");
const { config } = await import("../config.js");
type Docker = import("./docker.js").Docker;

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** Docker as a few maps: which Bots' containers run, and every command it was given. */
function fakeDocker(store: InstanceType<typeof Store>) {
  const running = new Set<string>();
  const commands: string[][] = [];
  const botOf = (name: string) => store.listBots().find((bot) => `colony-${bot.id.slice(0, 8)}` === name)?.id;
  const docker: Docker = async (args) => {
    commands.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    switch (args[0]) {
      case "inspect": { const botId = botOf(args.at(-1)!); return botId && running.has(botId) ? ok("colony-computer:3|true") : { code: 1, stdout: "", stderr: "No such container" }; }
      case "run": {
        // Starting takes a moment, as it does.
        await new Promise((resolve) => setTimeout(resolve, 5));
        running.add(args[args.indexOf("--label") + 1].replace("colony.bot=", ""));
        return ok("container-id");
      }
      case "ps": return ok([...running].join("\n"));
      case "stop": { const botId = botOf(args.at(-1)!); if (botId) running.delete(botId); return ok(); }
      case "port": return { code: 1, stdout: "", stderr: "" };
      default: return ok();
    }
  };
  return { docker, running, commands };
}

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const people = new People(store, { adminEmails: [] });
  const alice = (people.byEmail("alice@example.com") as { id: string }).id;
  const bob = (people.byEmail("bob@example.com") as { id: string }).id;
  const fake = fakeDocker(store);
  const computers = new ComputerService(store, events, { docker: fake.docker });
  const bot = (ownerId: string, name: string) => store.createBot({ name, title: "", description: "", model: "", computer: true, ownerId });
  return { store, alice, bob, computers, bot, ...fake };
}

test("each Bot's container is labeled with its Bot and its owner", async () => {
  const { computers, bot, alice, commands } = setup();
  const ana = bot(alice, "Ana");
  const max = bot("owner", "Max");
  await computers.ensure(ana.id);
  await computers.ensure(max.id);
  const runs = commands.filter((args) => args[0] === "run");
  expect(runs[0]).toEqual(expect.arrayContaining(["--label", `colony.bot=${ana.id}`, "--label", `colony.person=${alice}`]));
  expect(runs[1]).toEqual(expect.arrayContaining(["--label", `colony.bot=${max.id}`, "--label", "colony.person=owner"]));
});

test("a member may run 2 computers at once (COLONY_MEMBER_MAX_COMPUTERS); the admin has no limit", async () => {
  expect(config.limits.memberMaxComputers).toBe(2);
  const { computers, bot, alice, bob, store } = setup();
  const [a1, a2, a3] = ["A1", "A2", "A3"].map((name) => bot(alice, name));
  await computers.ensure(a1.id);
  await computers.ensure(a2.id);
  await expect(computers.ensure(a3.id)).rejects.toBeInstanceOf(ComputerLimitError);
  await expect(computers.ensure(a3.id)).rejects.toThrow("You can have 2 Bot computers running at once. Switch one off");
  // The refused one isn't left looking like it's starting, or broken.
  expect(store.getBot(a3.id)!.computerState).toBe("off");
  // A running one is still fine to use, and Bob's count is his own.
  await computers.ensure(a1.id);
  await computers.ensure(bot(bob, "B1").id);
  // Switching one off makes room.
  await computers.stop(a1.id);
  await computers.ensure(a3.id);
  expect(store.getBot(a3.id)!.computerState).toBe("on");
  // The admin: as many as they like.
  for (const name of ["M1", "M2", "M3", "M4"]) await computers.ensure(bot("owner", name).id);
});

test("two of a member's computers starting at once can't both slip under the limit", async () => {
  const { computers, bot, alice, running } = setup();
  const [a1, a2, a3] = ["A1", "A2", "A3"].map((name) => bot(alice, name));
  await computers.ensure(a1.id);
  const results = await Promise.allSettled([computers.ensure(a2.id), computers.ensure(a3.id)]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect([...running].filter((id) => [a1.id, a2.id, a3.id].includes(id))).toHaveLength(2);
});
