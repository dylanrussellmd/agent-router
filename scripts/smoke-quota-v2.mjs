// Real private OpenCode 2.x + production router + synthetic usage-query service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertSupportedOpenCodeVersion } from "./lib/opencode-version.mjs";

const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const usageSource = process.env.USAGE_TRACKER_SOURCE;
const root = await mkdtemp(path.join(tmpdir(), "router-quota-"));
for (const dir of ["project", "probe", "config", "data", "cache", "state", "agents", "stacks", "runtime"])
  await mkdir(path.join(root, dir));
const route = { model: "fixture/primary", fallbacks: [{ model: "backup-fixture/backup" }] };
const agentBytes = "---\nmodel: fixture/primary\npermissions: []\n---\nSynthetic agent\n";
for (const agent of ["build", "general"]) await writeFile(path.join(root, `agents/${agent}.md`), agentBytes);
const stateBytes = JSON.stringify({ version: 1, active: "fixture", previousActive: null, lastSwitchedAt: "fixture", fallbackAgents: { build: route, general: route } });
await writeFile(path.join(root, "runtime/state.json"), stateBytes);
await writeFile(path.join(root, "stacks/fixture.json"), JSON.stringify({ agents: { build: route, general: route } }));
const requests = [];
let scenario;
function stream(res, model, delta, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finish }])
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-quota", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, ...chunk }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function tool(res, model, name, input) {
  stream(res, model, { role: "assistant", tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, "tool_calls");
}
const endpoint = createServer(async (req, res) => {
  let raw = "";
  for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  const sessionID = req.headers["x-probe-session"];
  const previous = requests.some(r => r.sessionID === sessionID);
  requests.push({ scenario, sessionID, model: body.model });
  if (scenario.startsWith("failure") && body.model === "primary") {
    res.writeHead(scenario.includes("503") ? 503 : 429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Synthetic rate limit", type: "rate_limit_error" } }));
    return;
  }
  if (body.model === "parent" && !previous)
    return tool(res, body.model, "subagent", { agent: "general", description: "Native quota child", prompt: "Synthetic child first prompt",
      ...(scenario === "child-pinned" ? { model: "fixture/primary" } : {}) });
  if (scenario === "midtask" && !previous) return tool(res, body.model, "probe_reset_quota", {});
  stream(res, body.model, { content: "Synthetic success" });
});
endpoint.listen(0, "127.0.0.1");
await once(endpoint, "listening");
if (usageSource) {
  for (const name of ["rpc.mjs", "rpc-input.mjs", "quota.mjs", "core.mjs"]) {
    const content = (await readFile(path.join(usageSource, name), "utf8"))
      .replace('"@opencode/plugin/rpc"', JSON.stringify(import.meta.resolve("@opencode/plugin/rpc")));
    await writeFile(path.join(root, "probe", name), content);
  }
}
await writeFile(path.join(root, "probe/index.js"), `
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
${usageSource ? 'import { Usage } from "./rpc.mjs";\nimport { createQuotaQuery } from "./quota.mjs";' : ""}
export default { id: "quota-acceptance", async setup(ctx) {
  const file = name => path.join(process.env.HOME, name);
  const record = row => appendFile(file("observations.jsonl"), JSON.stringify(row) + "\\n");
  const controller = new AbortController();
  const events = (async () => { for await (const event of ctx.event.subscribe({ signal: controller.signal }))
    if (event.type === "session.model.selected") await record({ type: "selection", data: event.data }); })().catch(() => {});
  await ctx.session.hook("title", event => { event.result = "Quota acceptance"; });
  await ctx.session.hook("prompt", async event => {
    const session = await ctx.session.get({ sessionID: event.sessionID });
    await record({ type: "prompt", session });
  });
  await ctx.session.hook("http.request", event => { event.request.headers.set("x-probe-session", event.sessionID); });
  await ctx.rpc.register({ id: "quota-acceptance", events: {}, methods: { control: {
    input: { type: "object", properties: { sessionID: { type: "string" }, action: { enum: ["pin", "auto", "status"] } }, required: ["sessionID", "action"], additionalProperties: false },
    output: { type: "object" }, errors: {} } } }, { control: async ({ sessionID, action }) => {
      let tool;
      const registration = await ctx.tool.transform(editor => { tool = editor.get(action === "status" ? "router_routing_status" : "router_" + action); });
      await registration.dispose();
      return JSON.parse((await tool.execute({}, { sessionID })).content);
    } });
  ${usageSource ? `let lastMode;
  const makeQuota = () => createQuotaQuery({
    bindings: [{ providerID: "fixture", source: "go", models: ["primary"], connection: { type: "credential", id: "fixture-go" }, approval: "synthetic native acceptance" },
      { providerID: "backup-fixture", source: "openai", models: ["backup"], connection: { type: "credential", id: "fixture-openai" }, approval: "synthetic native acceptance" }],
    resolve: async source => ({ connection: { type: "credential", id: "fixture-" + source }, integrationID: source,
      credential: source === "go" ? { type: "key", key: "synthetic-only" } : { type: "oauth", access: "synthetic-only", metadata: { accountID: "synthetic-account" } } }),
    fetcher: async (url, { signal }) => {
      const clock = Date.now();
      const mode = await readFile(file("quota"), "utf8");
      if (mode === "error") throw new Error("Synthetic unavailable");
      if (mode === "timeout") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Synthetic abort")), { once: true }));
      const reset = new Date(clock + (["reset", "stale"].includes(mode) ? -1000 : 120000)).toISOString();
      const blocked = mode === "exhausted";
      return Response.json(url.includes("wham") ? { rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor((clock + 120000) / 1000) } } } :
        { usage: Object.fromEntries(["rolling", "weekly", "monthly"].map(name => [name, { percent: blocked ? 100 : 10, resetsAt: reset, status: mode === "unknown" ? "unknown" : blocked ? "rate-limited" : "ok" }])) });
    },
  });
  let quota = makeQuota();` : ""}
  await ctx.rpc.register(${usageSource ? "Usage" : `{ id: "direct-api-usage", events: {}, methods: { query: {
    input: { type: "object", properties: { candidates: { type: "array", maxItems: 64, items: { type: "object", properties: { providerID: { type: "string" }, id: { type: "string" } }, required: ["providerID", "id"], additionalProperties: false } } }, required: ["candidates"], additionalProperties: false },
    output: { type: "object" }, errors: {} } } }`}, { ${usageSource ? "refresh: async () => ({})," : ""} query: async ({ candidates }, context) => {
      const mode = await readFile(file("quota"), "utf8");
      await record({ type: "query", mode, candidates });
      ${usageSource ? "if (lastMode !== mode) { quota.dispose(); quota = makeQuota(); lastMode = mode; } return quota.query({ candidates });" : ""}
      if (mode === "error") throw new Error("Synthetic missing quota source");
      if (mode === "timeout") await new Promise(resolve => context.signal.addEventListener("abort", resolve, { once: true }));
      const now = Date.now();
      return { candidates: candidates.map(candidate => ({ ...candidate,
        status: candidate.id === "primary" ? (["available", "unknown"].includes(mode) ? mode : "exhausted") : "unknown",
        checkedAt: now - 1, validUntil: mode === "stale" ? now - 1 : now + 60000,
        resetAt: mode === "reset" ? now - 1 : now + 120000,
        reason: "fixture", accountRef: "opaque-fixture-account", scopeRef: "fixture-scope" })) };
    } });
  await ctx.tool.transform(editor => editor.add({ name: "probe_reset_quota", description: "Reset synthetic quota during tool continuation",
    input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
    execute: async () => { await writeFile(file("quota"), "available"); return { content: "Quota reset; continue once" }; } }));
  return async () => { controller.abort(); ${usageSource ? "quota.dispose();" : ""} await events; };
} };
`);
await writeFile(path.join(root, "project/opencode.json"), JSON.stringify({
  plugins: [{ package: process.env.AGENT_ROUTER_TEST_PACKAGE ?? source, options: { quotaPreflight: { enabled: true, allowPaidFallbacks: false } } }, path.join(root, "probe")],
  model: "fixture/primary", enabled_providers: ["fixture", "backup-fixture"], agents: { general: { model: "fixture/primary" } },
  providers: { fixture: { env: ["FIXTURE_TOKEN"], package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "synthetic-only" },
    models: Object.fromEntries(["primary", "parent"].map(id => [id, { name: id }])) },
    "backup-fixture": { env: ["FIXTURE_TOKEN"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "synthetic-only" }, models: { backup: { name: "backup" } } } },
}));
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const server = spawn(process.env.OPENCODE_TEST_BINARY ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: path.join(root, "project"), env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, FIXTURE_TOKEN: "synthetic-only",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    AGENT_ROUTER_HOME: path.join(root, "runtime"), AGENT_ROUTER_AGENTS_DIR: path.join(root, "agents"), AGENT_ROUTER_STACKS_DIR: path.join(root, "stacks") }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", b => { logs += b; }); server.stderr.on("data", b => { logs += b; });
const exited = once(server, "exit");
try {
  let password;
  for (let i = 0; i < 300; i++) {
    password = /server password (\S+)/.exec(logs)?.[1];
    if (password || server.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(password, "Private host startup failed");
  const request = async (url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); const result = text ? JSON.parse(text) : null;
    assert.ok(response.ok, `${url}: ${JSON.stringify(result)}`); return result?.data ?? result;
  };
  const hostVersion = assertSupportedOpenCodeVersion((await request("/api/info")).version);
  await request("/api/location");
  for (let i = 0; i < 100; i++) {
    const plugins = await request("/api/plugin");
    for (const plugin of plugins) assert.notEqual(plugin.state.status, "failed", JSON.stringify(plugin));
    if (["agent-router", "quota-acceptance"].every(id => plugins.some(p => p.id === id && p.state.status === "active"))) break;
    if (i === 99) throw new Error("Plugins did not activate");
    await delay(100);
  }
  const prompt = async (session) => {
    await request(`/api/session/${session.id}/prompt`, { text: "Synthetic explicit user turn" });
    await request(`/api/experimental/session/${session.id}/wait`, {});
  };
  const create = async (model) => request("/api/session", { location: { directory: path.join(root, "project") }, title: scenario, agent: "build", ...(model ? { model: { providerID: "fixture", id: model } } : {}) });
  const control = async (session, action) => (await request("/api/rpc/quota-acceptance/control", { input: { sessionID: session.id, action } })).output;
  const routingStatus = async sessionID => (await request("/api/rpc/agent-router/status", { input: { sessionID } })).output;
  assert.equal(await routingStatus("ses_missing"), null);
  const foreign = await request("/api/session", { location: { directory: root }, title: "Foreign location fixture" });
  assert.equal(await routingStatus(foreign.id), null, "Other-location session must fail closed");
  const badInput = await fetch(`http://127.0.0.1:${port}/api/rpc/agent-router/status`, { method: "POST", headers: {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { sessionID: "../invalid" } }) });
  assert.notEqual(badInput.status, 500, "Explicit input schema avoids native omission 500");
  assert.ok(!badInput.ok || (await badInput.json()).error, "Invalid ID must fail validation");
  for (const [mode, expected] of [["available", "primary"], ["unknown", "primary"], ["exhausted", "backup"], ["stale", "primary"], ["reset", "primary"], ["error", "primary"], ["timeout", "primary"]]) {
    scenario = mode;
    await writeFile(path.join(root, "quota"), mode);
    const session = await create();
    const start = Date.now();
    await prompt(session);
    if (mode === "timeout") assert.ok(Date.now() - start < 5000, "Quota deadline bounded at 3 seconds plus host overhead");
    assert.deepEqual(requests.filter(r => r.sessionID === session.id).map(r => r.model), [expected], mode);
    const beforeStatus = await readFile(path.join(root, "observations.jsonl"), "utf8");
    const count = requests.length;
    const status = await routingStatus(session.id);
    assert.equal(status.mode, "automatic");
    assert.deepEqual(await routingStatus(session.id), status, "Polling cannot invent observation times");
    assert.equal(requests.length, count, "Status never invokes inference");
    assert.equal(await readFile(path.join(root, "observations.jsonl"), "utf8"), beforeStatus, "Status never queries quota or switches models");
    if (["error", "timeout"].includes(mode)) assert.equal(status.checkedAt, null);
    else assert.ok(status.checkedAt > 0 && status.checkedAt <= Date.now(), JSON.stringify({ mode, status }));
    if (process.env.ROUTER_PTY_EVIDENCE && mode === "exhausted") {
      const capture = spawn("python", [fileURLToPath(new URL("./capture-status-pty.py", import.meta.url)), path.join(root, "project"), `http://127.0.0.1:${port}`, session.id, "preflight-exhausted", process.env.ROUTER_PTY_EVIDENCE], {
        env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", OPENCODE_SERVER_PASSWORD: password, ...(process.env.PYTHONPATH ? { PYTHONPATH: process.env.PYTHONPATH } : {}),
          XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
          AGENT_ROUTER_HOME: path.join(root, "runtime"), AGENT_ROUTER_AGENTS_DIR: path.join(root, "agents"), AGENT_ROUTER_STACKS_DIR: path.join(root, "stacks"),
          OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [source] }) }, stdio: "inherit",
      });
      assert.equal((await once(capture, "exit"))[0], 0, "PTY capture failed");
    }
  }
  scenario = "recovery";
  await writeFile(path.join(root, "quota"), "exhausted");
  const recovery = await create(); await prompt(recovery);
  await writeFile(path.join(root, "quota"), "available"); await prompt(recovery);
  assert.deepEqual(requests.filter(r => r.sessionID === recovery.id).map(r => r.model), ["backup", "primary"]);
  scenario = "manual-same";
  await writeFile(path.join(root, "quota"), "exhausted");
  const manual = await create(); await prompt(manual);
  await request(`/api/session/${manual.id}/model`, { model: { providerID: "backup-fixture", id: "backup" } });
  await writeFile(path.join(root, "quota"), "available"); await prompt(manual);
  // Native limitation: selecting the already-active model is a no-op, with no
  // event or persisted provenance. Record this explicitly, never claim pin support.
  const manualRows = (await readFile(path.join(root, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(manualRows.filter(row => row.type === "selection" && row.data.sessionID === manual.id).length, 2);
  assert.deepEqual(requests.filter(r => r.sessionID === manual.id).map(r => r.model), ["backup", "primary"]);
  console.log("KNOWN HOST LIMITATION: same-active-model selection emits no pin event; automatic recovery cannot distinguish that action");
  scenario = "manual-distinct";
  await writeFile(path.join(root, "quota"), "exhausted");
  const distinct = await create(); await prompt(distinct);
  await request(`/api/session/${distinct.id}/model`, { model: { providerID: "fixture", id: "primary" } });
  await prompt(distinct);
  assert.deepEqual(requests.filter(r => r.sessionID === distinct.id).map(r => r.model), ["backup", "primary"]);
  scenario = "explicit-primary";
  await writeFile(path.join(root, "quota"), "exhausted");
  const pinned = await create("primary"); await prompt(pinned);
  assert.deepEqual(requests.filter(r => r.sessionID === pinned.id).map(r => r.model), ["primary"]);
  scenario = "explicit-router-pin";
  await writeFile(path.join(root, "quota"), "exhausted");
  const controlled = await create(); await prompt(controlled);
  const requestCount = requests.length;
  const pinStatus = await control(controlled, "pin");
  assert.equal(pinStatus.mode, "pinned");
  assert.equal(pinStatus.reason, "explicit_pin");
  assert.equal(pinStatus.model.id, "backup");
  assert.equal(requests.length, requestCount, "Pin does not execute a prompt");
  await writeFile(path.join(root, "quota"), "available"); await prompt(controlled);
  assert.deepEqual(requests.filter(r => r.sessionID === controlled.id).map(r => r.model), ["backup", "backup"]);
  const beforeAuto = requests.length;
  const autoStatus = await control(controlled, "auto");
  assert.equal(autoStatus.mode, "automatic");
  assert.equal(autoStatus.reason, "automatic_next_explicit_turn");
  assert.equal(autoStatus.model.id, "backup");
  assert.equal(requests.length, beforeAuto, "Auto does not switch or execute immediately");
  await prompt(controlled);
  assert.deepEqual(requests.filter(r => r.sessionID === controlled.id).map(r => r.model), ["backup", "backup", "primary"]);
  scenario = "pin-unresolved";
  await writeFile(path.join(root, "quota"), "exhausted");
  const unresolved = await create();
  assert.equal((await control(unresolved, "pin")).model.id, "primary");
  await prompt(unresolved);
  assert.deepEqual(requests.filter(r => r.sessionID === unresolved.id).map(r => r.model), ["primary"]);
  for (const [name, mode, expected] of [["child-exhausted", "exhausted", "backup"], ["child-available", "available", "primary"], ["child-unknown", "unknown", "primary"], ["child-reset", "reset", "primary"], ["child-pinned", "exhausted", "primary"]]) {
    scenario = name; await writeFile(path.join(root, "quota"), mode);
    const parent = await create("parent"); await prompt(parent);
    const observations = (await readFile(path.join(root, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const child = observations.find(o => o.type === "prompt" && o.session.parentID === parent.id)?.session;
    assert.ok(child, `${name}: true native child admitted`);
    assert.deepEqual(requests.filter(r => r.sessionID === child.id).map(r => r.model), [expected], name);
    assert.equal(child.model.id, expected, "Child selection exists before first prompt hook");
  }
  scenario = "midtask"; await writeFile(path.join(root, "quota"), "exhausted");
  const midtask = await create(); await prompt(midtask);
  assert.deepEqual(requests.filter(r => r.sessionID === midtask.id).map(r => r.model), ["backup", "backup"]);
  for (const status of [429, 503]) for (const nextQuota of ["available", "unknown"]) {
    scenario = `failure${status}-${nextQuota}`; await writeFile(path.join(root, "quota"), "available");
    const failed = await create(); await prompt(failed);
    assert.deepEqual(requests.filter(r => r.sessionID === failed.id).map(r => r.model), ["primary"], `${status} never switches or replays midtask`);
    await writeFile(path.join(root, "quota"), nextQuota); await prompt(failed);
    assert.deepEqual(requests.filter(r => r.sessionID === failed.id).map(r => r.model), ["primary", "backup"], `Staged ${status} fallback precedes ${nextQuota} primary`);
    assert.equal((await control(failed, "status")).reason, "staged_reactive_fallback");
  }
  scenario = "failure429-pin"; await writeFile(path.join(root, "quota"), "available");
  const stagedPin = await create(); await prompt(stagedPin);
  await control(stagedPin, "pin");
  scenario = "pinned-after-failure"; await writeFile(path.join(root, "quota"), "exhausted");
  await prompt(stagedPin);
  assert.deepEqual(requests.filter(r => r.sessionID === stagedPin.id).map(r => r.model), ["primary", "primary"], "Pin vetoes staged reactive and quota fallbacks together");
  await control(stagedPin, "auto");
  assert.deepEqual(requests.filter(r => r.sessionID === stagedPin.id).map(r => r.model), ["primary", "primary"]);
  await prompt(stagedPin);
  assert.deepEqual(requests.filter(r => r.sessionID === stagedPin.id).map(r => r.model), ["primary", "primary", "backup"]);
  const observations = (await readFile(path.join(root, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(observations.some(o => o.type === "query"), "Native cross-plugin query executed");
  for (const agent of ["build", "general"]) assert.equal(await readFile(path.join(root, `agents/${agent}.md`), "utf8"), agentBytes);
  assert.equal(await readFile(path.join(root, "runtime/state.json"), "utf8"), stateBytes);
  console.log(`PASS: OpenCode ${hostVersion} native quota RPC; main/true-child admissions; durable pin/next-turn auto controls; 429/503 staged precedence; timeout; recovery; no midtask switching; files intact`);
  if (usageSource) console.log("PASS: actual usage-tracker RPC definition and quota implementation with synthetic direct-provider responses");
} finally {
  endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve));
  server.kill("SIGTERM"); const kill = setTimeout(() => server.kill("SIGKILL"), 5000); kill.unref();
  await exited; clearTimeout(kill); await rm(root, { recursive: true, force: true });
}
