// Discovery-only native 2.0.8 admission probe. Synthetic credentials; private host.
// Does not load the router or change the same-turn retry experiment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(path.join(tmpdir(), "router-admission-"));
for (const dir of ["project", "probe", "config", "data", "cache", "state"])
  await mkdir(path.join(root, dir));
const requests = [];
let scenario = "implicit";
function stream(res, model, delta, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finish }])
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, ...chunk }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const endpoint = createServer(async (req, res) => {
  let raw = "";
  for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  const sessionID = req.headers["x-probe-session"];
  const previous = requests.some(r => r.sessionID === sessionID);
  requests.push({ scenario, sessionID, model: body.model });
  if (body.model === "parent" && !previous) {
    const args = { agent: "general", description: "Admission discovery", prompt: "Synthetic child first prompt",
      ...(scenario === "explicit-child" ? { model: "fixture/primary" } : {}) };
    return stream(res, body.model, { role: "assistant", tool_calls: [{ index: 0, id: "call-child", type: "function",
      function: { name: "subagent", arguments: JSON.stringify(args) } }] }, "tool_calls");
  }
  stream(res, body.model, { content: "Synthetic completion" });
});
endpoint.listen(0, "127.0.0.1");
await once(endpoint, "listening");
await writeFile(path.join(root, "probe/index.js"), `
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
export default { id: "admission-probe", async setup(ctx) {
  const record = entry => appendFile(path.join(process.env.HOME, "observations.jsonl"), JSON.stringify(entry) + "\\n");
  await ctx.session.hook("title", event => { event.result = "Admission probe"; });
  await ctx.tool.hook("execute.before", async event => {
    if (event.tool !== "subagent") return;
    await record({ type: "subagent.before", sessionID: event.sessionID, input: event.input });
    if (await readFile(path.join(process.env.HOME, "scenario"), "utf8") === "before-child")
      event.input.model = "fixture/backup";
  });
  await ctx.session.hook("prompt", async event => {
    const session = await ctx.session.get({ sessionID: event.sessionID });
    await record({ type: "prompt", session, metadata: event.metadata, delivery: event.delivery });
    const mode = await readFile(path.join(process.env.HOME, "scenario"), "utf8");
    if (session.parentID && mode === "switch-child") {
      await ctx.session.switchModel({ sessionID: event.sessionID, model: { providerID: "fixture", id: "backup" } });
      await record({ type: "switched", session: await ctx.session.get({ sessionID: event.sessionID }) });
    }
  });
  await ctx.session.hook("http.request", event => { event.request.headers.set("x-probe-session", event.sessionID); });
  const controller = new AbortController();
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal }))
      if (["session.model.selected", "session.agent.selected"].includes(event.type)) await record(event);
  })().catch(() => {});
  return async () => { controller.abort(); await events; };
} };
`);
await writeFile(path.join(root, "project/opencode.json"), JSON.stringify({
  plugins: [path.join(root, "probe")], model: "fixture/primary", enabled_providers: ["fixture"],
  agents: { general: { model: "fixture/primary" } },
  providers: { fixture: { env: ["FIXTURE_TOKEN"], package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "synthetic-only" },
    models: Object.fromEntries(["primary", "backup", "parent"].map(id => [id, { name: id }])) } },
}));
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const server = spawn(process.env.OPENCODE_TEST_BINARY ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: path.join(root, "project"), env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, FIXTURE_TOKEN: "synthetic-only",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", b => { logs += b; });
server.stderr.on("data", b => { logs += b; });
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
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    const result = text ? JSON.parse(text) : null;
    assert.ok(response.ok, `${url}: ${JSON.stringify(result)}`);
    return result?.data ?? result;
  };
  assert.equal((await request("/api/info")).version, "2.0.8");
  await request("/api/location");
  for (let i = 0; i < 100; i++) {
    const plugins = await request("/api/plugin");
    const probe = plugins.find(p => p.id === "admission-probe");
    if (probe?.state.status === "active") break;
    assert.notEqual(probe?.state.status, "failed", JSON.stringify(probe));
    if (i === 99) throw new Error("Probe did not activate");
    await delay(100);
  }
  const sessions = [];
  for (scenario of ["implicit", "explicit", "manual-same", "implicit-child", "explicit-child", "switch-child", "before-child"]) {
    await writeFile(path.join(root, "scenario"), scenario);
    const child = scenario.endsWith("child");
    const session = await request("/api/session", { location: { directory: path.join(root, "project") },
      title: scenario, agent: "build", ...(scenario === "implicit" || scenario === "manual-same" ? {} : {
        model: { providerID: "fixture", id: child ? "parent" : "primary" } }) });
    if (scenario === "manual-same") await request(`/api/session/${session.id}/model`, { model: { providerID: "fixture", id: "primary" } });
    sessions.push({ scenario, created: session });
    await request(`/api/session/${session.id}/prompt`, { text: "Synthetic admission discovery" });
    await request(`/api/experimental/session/${session.id}/wait`, {});
    if (scenario === "implicit") {
      await request(`/api/session/${session.id}/prompt`, { text: "Second explicit user turn" });
      await request(`/api/experimental/session/${session.id}/wait`, {});
    }
  }
  const observations = (await readFile(path.join(root, "observations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  for (const name of ["implicit-child", "explicit-child", "switch-child", "before-child"]) {
    const parent = sessions.find(s => s.scenario === name).created.id;
    const admission = observations.find(o => o.type === "prompt" && o.session.parentID === parent);
    assert.ok(admission, `${name}: native subagent must run prompt admission`);
    const sent = requests.filter(r => r.sessionID === admission.session.id);
    assert.equal(sent.length, 1, `${name}: exactly one child request`);
    assert.equal(sent[0].model, ["switch-child", "before-child"].includes(name) ? "backup" : "primary");
  }
  const evidence = { version: "2.0.8", sessions, observations, requests };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  endpoint.closeAllConnections();
  await new Promise(resolve => endpoint.close(resolve));
  server.kill("SIGTERM");
  const kill = setTimeout(() => server.kill("SIGKILL"), 5000);
  kill.unref();
  await exited;
  clearTimeout(kill);
  await rm(root, { recursive: true, force: true });
}
