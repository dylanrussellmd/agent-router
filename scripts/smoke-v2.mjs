import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Runs a real, private 2.0.8 host. Never reads or edits the user's config/state.
const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = process.env.AGENT_ROUTER_TEST_PACKAGE ?? source;
const root = await mkdtemp(path.join(tmpdir(), "agent-router-host-"));
const project = path.join(root, "project");
const probe = path.join(root, "probe");
for (const name of [
  "project",
  "probe",
  "config/opencode",
  "data",
  "cache",
  "state",
  "agents",
  "stacks",
  "runtime",
]) {
  await mkdir(path.join(root, name), { recursive: true });
}
const agentBytes = "---\nmodel: fixture/primary\npermissions: []\n---\nFixture prompt must survive.\n";
const agentPath = path.join(root, "agents/build.md");
await writeFile(agentPath, agentBytes);
const route = { model: "fixture/primary", fallbacks: [{ model: "fixture/backup" }] };
const initialStackBytes = JSON.stringify({ agents: { build: route } });
await writeFile(path.join(root, "stacks/initial.json"), initialStackBytes);
await writeFile(path.join(root, "runtime/state.json"), JSON.stringify({
  version: 1, active: "initial", previousActive: null, lastSwitchedAt: "fixture",
  fallbackAgents: { build: route },
}));
const stateBytes = await readFile(path.join(root, "runtime/state.json"), "utf8");
const stackBytes = JSON.stringify({ agents: { build: { model: "fixture/backup" } } });
await writeFile(path.join(root, "stacks/backup.json"), stackBytes);
const requests = [];
let failureStatus = 429;
const endpoint = createHTTPServer(async (req, res) => {
  let raw = "";
  for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  requests.push({ model: body.model, messages: body.messages });
  if (body.model === "primary") {
    res.writeHead(failureStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "deterministic fixture failure", type: "rate_limit_error" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [
    { delta: { role: "assistant", content: "fixture success" }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]) res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, ...chunk }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
endpoint.listen(0, "127.0.0.1");
await once(endpoint, "listening");
await writeFile(
  path.join(project, "opencode.json"),
  JSON.stringify({
    plugins: [packagePath, probe], model: "fixture/primary", enabled_providers: ["fixture"],
    providers: { fixture: { env: ["FIXTURE_TOKEN"], package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "synthetic-only" },
      models: Object.fromEntries(["primary", "backup", "manual"].map(id => [id, {
        name: id,
      }])),
    } },
  }),
);
// This RPC exists only in the disposable integration fixture. Router has no RPC API.
await writeFile(
  path.join(probe, "index.js"),
  `
const noInput = { "~standard": { version: 1, vendor: "agent-router-integration",
  validate(input) { return input == null ? { value: undefined } : { issues: [{ message: "No input accepted" }] }; }
} };
export default { id: "agent-router.integration-probe", async setup(ctx) {
  await ctx.session.hook("title", event => { event.result = "Fixture"; });
  let calls = 0;
  const observed = [];
  const abort = new AbortController();
  void (async () => { for await (const e of ctx.event.subscribe({ signal: abort.signal })) if (e.type.includes("error") || e.type.includes("failed")) observed.push(e); })();
  await ctx.rpc.register({ id: "agent-router.integration-probe", events: {}, methods: {
    status: { input: noInput, output: { type: "object" }, errors: {} },
    tool: { input: { type: "object" }, output: { type: "object" }, errors: {} }
  } }, {
    status: async () => ({ calls: ++calls, observed, plugins: (await ctx.plugin.list()).data.map(p => ({ id: p.id, status: p.state.status })) }),
    tool: async ({ name, args }) => {
      try {
      let tool;
      const registration = await ctx.tool.transform(editor => { tool = editor.get(name); });
      await registration.dispose();
      return JSON.parse((await tool.execute(args, {})).content);
      } catch (error) { return { error: String(error) }; }
    },
  });
  return () => abort.abort();
} };
`,
);

const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve())),
);
const env = {
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  FIXTURE_TOKEN: "synthetic-only",
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  AGENT_ROUTER_HOME: path.join(root, "runtime"),
  AGENT_ROUTER_AGENTS_DIR: path.join(root, "agents"),
  AGENT_ROUTER_STACKS_DIR: path.join(root, "stacks"),
};
for (const key of Object.keys(env)) {
  if (key.startsWith("OPENCODE_") || key.startsWith("OMO_") || key.endsWith("_API_KEY"))
    delete env[key];
}
const server = spawn(
  process.env.OPENCODE_TEST_BINARY ?? "opencode",
  ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
server.stdout.on("data", (bytes) => {
  logs += bytes.toString();
});
server.stderr.on("data", (bytes) => {
  logs += bytes.toString();
});
const exited = once(server, "exit");
try {
  let password;
  for (let attempt = 0; attempt < 300; attempt++) {
    password = /server password (\S+)/.exec(logs)?.[1];
    if (password) break;
    if (server.exitCode !== null) throw new Error("Private OpenCode host exited before startup");
    await delay(100);
  }
  assert.ok(password, "Private host must report its generated authentication password");
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  const request = async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      headers,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    }).catch(error => { throw new Error(`${endpoint}: ${error}; requests=${JSON.stringify(requests.map(r => r.model))}`, { cause: error }); });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  assert.equal((await request("/api/info")).body.version, "2.0.8");
  // Location initialization is required before reading plugin status in 2.0.8.
  assert.equal((await request("/api/location")).status, 200);
  let plugins = [];
  let router;
  for (let attempt = 0; attempt < 100; attempt++) {
    plugins = (await request("/api/plugin")).body.data;
    router = plugins.find((plugin) => plugin.id === "agent-router" || plugin.id === packagePath);
    if (router?.state.status === "active") break;
    await delay(100);
  }
  assert.equal(
    router?.state.status,
    "active",
    JSON.stringify(plugins.filter((p) => !p.id.startsWith("opencode."))),
  );
  assert.equal(
    router.features.tui,
    true,
    "Local package must advertise its literal tui entrypoint",
  );
  for (const plugin of plugins) {
    if (plugin.state.status === "failed")
      console.error(plugin.id, String(plugin.state.error).split("\n").slice(0, 3).join("\n"));
  }
  const rpc = "/api/rpc/agent-router.integration-probe/status";
  const absent = await request(rpc, {});
  assert.equal(
    absent.status,
    200,
    JSON.stringify({
      result: absent.body,
      plugins: plugins.filter((p) => !p.id.startsWith("opencode.")),
    }),
  );
  const explicitNull = await request(rpc, { input: null });
  assert.equal(explicitNull.status, 200, JSON.stringify(explicitNull.body));
  const invalid = await request(rpc, { input: { unexpected: true } });
  assert.notEqual(
    invalid.status,
    200,
    "Unexpected RPC arguments must be rejected before the handler",
  );
  const after = await request(rpc, {});
  assert.equal(after.status, 200);
  assert.ok(
    JSON.stringify(after.body).includes('"calls":3'),
    "Invalid input must not execute the handler",
  );
  console.log(
    "PASS: real OpenCode 2.0.8 local package activation and RPC absent/null/invalid-input checks",
  );
  const checked = async (url, body) => {
    const result = await request(url, body);
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
    return result.body?.data ?? result.body;
  };
  for (const status of [429, 503]) {
    failureStatus = status;
    const session = await checked("/api/session", { location: { directory: project }, title: "Fixture", agent: "build", model: { providerID: "fixture", id: "primary" } });
    const base = `/api/session/${session.id}`;
    const start = requests.length;
    await checked(`${base}/prompt`, { text: `first user turn ${status}` });
    await checked(`/api/experimental/session/${session.id}/wait`, {});
    if (requests.length === start) console.error(JSON.stringify(await checked(rpc, {})));
    assert.deepEqual(requests.slice(start).map(r => r.model), ["primary"], "No automatic replay");
    assert.equal((await checked(base)).model.id, "primary");
    await checked(`${base}/prompt`, { text: `next USER turn ${status}` });
    await checked(`/api/experimental/session/${session.id}/wait`, {});
    assert.deepEqual(requests.slice(start).map(r => r.model), ["primary", "backup"]);
    assert.equal((await checked(base)).model.id, "backup");
    assert.equal(await readFile(agentPath, "utf8"), agentBytes);
  }
  console.log("PASS: real 429/503 next-user-turn failover, no automatic replay, agent fixture intact");
  const manual = await checked("/api/session", { location: { directory: project }, title: "Manual selection", agent: "build", model: { providerID: "fixture", id: "primary" } });
  const manualBase = `/api/session/${manual.id}`;
  const manualStart = requests.length;
  await checked(`${manualBase}/prompt`, { text: "fail before explicit selection" });
  await checked(`/api/experimental/session/${manual.id}/wait`, {});
  await checked(`${manualBase}/model`, { model: { providerID: "fixture", id: "manual" } });
  await checked(`${manualBase}/prompt`, { text: "respect explicit model on next user turn" });
  await checked(`/api/experimental/session/${manual.id}/wait`, {});
  assert.deepEqual(requests.slice(manualStart).map(r => r.model), ["primary", "manual"]);
  assert.equal(await readFile(path.join(root, "runtime/state.json"), "utf8"), stateBytes);
  assert.equal(await readFile(agentPath, "utf8"), agentBytes);
  console.log("PASS: real explicit model selection supersedes pending fallback");
  const tool = async (name, args = {}) => {
    try {
      const result = await checked("/api/rpc/agent-router.integration-probe/tool", { input: { name, args } });
      assert.ok(!result.output?.error, JSON.stringify(result));
      return result;
    } catch (cause) {
      throw new Error(`Real-host ${name} acceptance failed`, { cause });
    }
  };
  const used = await tool("router_use", { name: "backup" });
  assert.ok(!JSON.stringify(used).includes('"error"'), JSON.stringify(used));
  assert.equal(await readFile(agentPath, "utf8"), agentBytes.replace("fixture/primary", "fixture/backup"));
  const history = await readdir(path.join(root, "runtime/history"));
  assert.equal(history.length, 1);
  assert.match(history[0], /__initial-to-backup\.json$/);
  assert.equal(JSON.parse(await readFile(path.join(root, "runtime/history", history[0]), "utf8")).agents.build.model, "fixture/primary");
  assert.equal(await readFile(path.join(root, "stacks/backup.json"), "utf8"), stackBytes);
  assert.equal(await readFile(path.join(root, "stacks/initial.json"), "utf8"), initialStackBytes);
  console.log("PASS: real router_use, history creation, source-stack integrity");
  const backed = await tool("router_back");
  assert.ok(!JSON.stringify(backed).includes('"error"'), JSON.stringify(backed));
  assert.equal(await readFile(agentPath, "utf8"), agentBytes);
  assert.equal(await readFile(path.join(root, "stacks/backup.json"), "utf8"), stackBytes);
  assert.equal(await readFile(path.join(root, "stacks/initial.json"), "utf8"), initialStackBytes);
  console.log("PASS: real 429/503 next-user-turn failover, no replay, stack use/back/history and fixture integrity");
} finally {
  endpoint.closeAllConnections();
  await new Promise(resolve => endpoint.close(resolve));
  server.kill("SIGTERM");
  const killTimer = setTimeout(() => server.kill("SIGKILL"), 5_000);
  killTimer.unref();
  await exited;
  clearTimeout(killTimer);
  await rm(root, { recursive: true, force: true });
}
