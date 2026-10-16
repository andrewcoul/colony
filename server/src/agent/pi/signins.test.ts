import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "colony-signins-"));
process.env.COLONY_DATA_DIR = dataDir;
delete process.env.COLONY_DEV_BASE_URL;

const { openDb } = await import("../../db.js");
const { EventLog } = await import("../../events.js");
const { Store } = await import("../../store.js");
const { ApprovalGate } = await import("../approvals.js");
const { PiRunner } = await import("./runner.js");
const { MemoryStorage } = await import("@earendil-works/pi-durable");
const { scriptedModels } = await import("./testkit.js");
const { createApi } = await import("../../api.js");
const { FileCredentialStore } = await import("../../credentials.js");
const { ColonyModels } = await import("./models.js");
const { ModelSignIns } = await import("./signins.js");
const settings = await import("../../settings.js");
settings.loadSettings();

afterEach(() => vi.unstubAllGlobals());
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** OpenCode's console: approves the device code on the second poll, then renews tokens. */
function fakeConsole() {
  const requests: { url: string; fields: Record<string, string> }[] = [];
  let polls = 0;
  let issued = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const fields = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    requests.push({ url: String(url), fields });
    if (String(url).endsWith("/auth/device/code")) {
      return json(200, { device_code: "dev-code", user_code: "ABCD-EFGH", verification_uri: "/console/device", verification_uri_complete: "/console/device?user_code=ABCD-EFGH", expires_in: 600, interval: 0 });
    }
    if (fields.grant_type === "refresh_token") {
      if (fields.refresh_token !== `refresh-${issued}`) return json(400, { error: "invalid_grant" });
      issued += 1;
      return json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, org_id: "org_1" });
    }
    if (++polls < 2) return json(400, { error: "authorization_pending" });
    issued += 1;
    return json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, org_id: "org_1" });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function setup(fetchImpl?: typeof fetch) {
  const credentials = new FileCredentialStore(path.join(dataDir, `credentials-${Math.random()}.json`));
  const models = new ColonyModels({ credentials, fetch: fetchImpl });
  const modelSignIns = new ModelSignIns(models);
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const store = new Store(db, events);
  const gate = new ApprovalGate(store);
  const runner = await PiRunner.open(store, events, gate, undefined, { storage: new MemoryStorage(), models: scriptedModels().source });
  const api = createApi({ store, events, gate, runner, models, modelSignIns });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await api.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith("{") ? JSON.parse(text) : null };
  };
  return { models, credentials, call };
}

async function until<T>(read: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("OpenCode: a code you approve in the browser signs in Zen and Go; tokens renew and never reach devices", async () => {
  const opencode = fakeConsole();
  const { models, credentials, call } = await setup(opencode.fetchImpl);
  settings.saveProvider("opencode-go", { models: ["deepseek-v4.1-flash"] });

  const { json: started } = await call("POST", "/settings/signins/opencode/start");
  expect(started).toMatchObject({ kind: "code", userCode: "ABCD-EFGH", verificationUri: "https://opencode.ai/console/device?user_code=ABCD-EFGH" });
  expect(opencode.requests[0].fields).toMatchObject({ client_id: "colony", supports_org_scope: "true" });
  await until(async () => (await call("GET", `/settings/signins/session/${started.id}`)).json.status === "done");

  const view = await call("GET", "/settings");
  expect(view.json.signIns.find((item: { id: string }) => item.id === "opencode")).toMatchObject({ signedIn: true });
  expect(view.json.configured).toBe(true);
  expect(view.text).not.toContain("access-");
  expect(settings.resolveModel("opencode-go::deepseek-v4.1-flash", { fallback: false })).not.toBeNull();

  // Go and Zen both send the console token.
  expect((await models.models.getAuth("opencode"))?.auth.apiKey).toBe("access-1");
  expect((await models.models.getAuth("opencode-go"))?.auth.apiKey).toBe("access-1");

  // An expiring token is renewed (and the new one saved) before a request uses it.
  await credentials.modify("opencode", async (current) => ({ ...current!, expires: Date.now() - 1 }) as never);
  expect((await models.models.getAuth("opencode-go"))?.auth.apiKey).toBe("access-2");
  expect(opencode.requests.at(-1)!.fields).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "colony" });
  expect(JSON.parse(fs.readFileSync((credentials as unknown as { file: string }).file, "utf8")).opencode).toMatchObject({ access: "access-2", refresh: "refresh-2" });

  // Signing out forgets the token; its models stop being offered.
  expect((await call("DELETE", "/settings/signins/opencode")).json.signIns[1]).toMatchObject({ id: "opencode", signedIn: false });
  expect(settings.resolveModel("opencode-go::deepseek-v4.1-flash", { fallback: false })).toBeNull();
  expect(await models.models.getAuth("opencode-go")).toBeUndefined();
  models.close();
});

test("ChatGPT: OpenAI's sign-in page, finished by pasting the address it ends on (for a browser on another device)", async () => {
  const exchanged: Record<string, string>[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith("https://auth.openai.com/")) throw new Error(`unexpected ${url}`);
    exchanged.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))));
    return new Response(JSON.stringify({ access_token: "chatgpt-access", refresh_token: "chatgpt-refresh", id_token: "id", expires_in: 3600, scope: "openid offline_access chatgpt.tokens.use.direct" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const { models, call } = await setup();
  settings.saveProvider("openai", { models: ["gpt-5.5"] });

  const { json: started, status } = await call("POST", "/settings/signins/chatgpt/start");
  expect(status).toBe(200);
  expect(started.kind).toBe("browser");
  const url = new URL(started.url);
  expect(url.origin).toBe("https://auth.openai.com");
  expect(url.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${settings.installationId()}`);
  expect(url.searchParams.get("agent_name_hint")).toBe("Colony");

  const back = `${url.searchParams.get("redirect_uri")}?code=the-code&state=${url.searchParams.get("state")}&client_id=issued-client`;
  expect((await call("POST", `/settings/signins/session/${started.id}/finish`, { url: back })).status).toBe(204);
  await until(async () => (await call("GET", `/settings/signins/session/${started.id}`)).json.status === "done");
  expect(exchanged[0]).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "issued-client" });
  expect((await models.models.getAuth("openai"))?.auth.apiKey).toBe("chatgpt-access");
  expect(settings.resolveModel("openai::gpt-5.5", { fallback: false })).toMatchObject({ provider: { name: "ChatGPT" } });
  await call("DELETE", "/settings/signins/chatgpt");
  models.close();
});
