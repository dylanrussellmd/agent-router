// Explicit, test-only native host. ROUTER_PRODUCTION=1 loads the production router.
// Run: node scripts/probe-quota-retry.mjs [evidence.json]
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

const root = await mkdtemp(path.join(tmpdir(), "quota-retry-"));
const production = process.env.ROUTER_PRODUCTION === "1";
const project = path.join(root, "project");
for (const dir of ["project", "config", "data", "cache", "state"]) await mkdir(path.join(root, dir));
if (production) {
  for (const dir of ["agents", "runtime", "stacks"]) await mkdir(path.join(root, dir));
  const route = { model: "primary-fixture/primary", fallbacks: [{ model: "backup-fixture/backup" }] };
  for (const agent of ["build", "general"]) await writeFile(path.join(root, `agents/${agent}.md`), "---\nmodel: primary-fixture/primary\npermissions: []\n---\nSynthetic agent\n");
  await writeFile(path.join(root, "runtime/state.json"), JSON.stringify({ version: 1, active: "fixture", previousActive: null, lastSwitchedAt: "fixture", fallbackAgents: { build: route, general: route } }));
  await writeFile(path.join(root, "stacks/fixture.json"), JSON.stringify({ agents: { build: route, general: route } }));
}
const requests = [];
let scenario;
let releaseResponse;
let requestArrived;
let titleReady;
let primaryReady;
let announceTitle;
let announcePrimary;
const proxyOrder = process.env.ROUTER_PROXY_ORDER;
assert.ok(!proxyOrder || (production && ["before", "after"].includes(proxyOrder)));
const unmarkedProxy = process.env.ROUTER_PROXY_UNMARKED === "1";
assert.ok(!unmarkedProxy || proxyOrder);
const quota = { error: { type: "GoUsageLimitError", message: "Synthetic account cap" } };
function stream(res, model, delta, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finish }])
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, ...chunk }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function tool(res, model, name, args) {
  stream(res, model, { role: "assistant", tool_calls: [{ index: 0, id: "call-" + name,
    type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}
const endpoint = createServer(async (req, res) => {
  let raw = "";
  for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw);
  const sessionID = req.headers["x-probe-session"];
  const previous = requests.filter(r => r.sessionID === sessionID && r.model === body.model).length;
  requests.push({ sessionID, kind: req.headers["x-probe-kind"], agent: req.headers["x-probe-agent"], path: req.url, model: body.model, messages: body.messages });
  const kind = req.headers["x-probe-kind"];
  if (scenario === "title-overlap" || scenario === "title-quota") {
    if (kind === "title") {
      announceTitle();
      await primaryReady;
      if (scenario === "title-quota") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify(quota));
        return;
      }
      return stream(res, body.model, { content: "Synthetic title" });
    }
    if (kind === "primary" && body.model === "primary") {
      // Both native requests must be in flight before either response is sent.
      announcePrimary();
      await titleReady;
      if (scenario === "title-quota")
        return stream(res, body.model, { content: "Synthetic primary completion" });
    }
  }
  if (scenario === "compaction" && !previous)
    return stream(res, body.model, { content: "Synthetic pre-compaction completion" });
  if (["manual", "manual-same", "cancel", "pin"].includes(scenario)) {
    requestArrived();
    await new Promise(resolve => { releaseResponse = resolve; });
  }
  if (body.model === "parent") {
    if (!previous) return tool(res, body.model, "subagent", { agent: "general", description: "Synthetic quota test",
      prompt: "Run synthetic counter task", ...(production && scenario !== "child-explicit" ? {} : { model: "primary-fixture/primary" }) });
    return stream(res, body.model, { content: "Parent completed once" });
  }
  if (body.model === "primary" && scenario.includes("tool") && !previous)
    return tool(res, body.model, "probe_increment", {});
  if (body.model === "backup" && scenario === "backup503") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Synthetic backup unavailable", type: "server_error" } }));
    return;
  }
  if (body.model === "backup" && scenario !== "exhaustion")
    return stream(res, body.model, { content: "Backup completed" });
  if (scenario === "partial") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: { content: "Partial output" }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify(quota)}\n\n`);
    return;
  }
  res.writeHead(scenario === "auth" ? 401 : scenario === "timeout" ? 408 : 429, { "Content-Type": "application/json" });
  res.end(JSON.stringify(scenario === "auth" ? { error: { type: "authentication_error", message: "Synthetic auth failure" } } :
    scenario === "timeout" ? { error: { message: "Synthetic request timeout" } } : quota));
});
endpoint.listen(0, "127.0.0.1");
await once(endpoint, "listening");
const provider = models => ({ env: ["FIXTURE_TOKEN"], package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "synthetic-only" },
  models: Object.fromEntries(models.map(id => [id, { name: id }])) });
const proxyPlugin = { package: fileURLToPath(new URL("./fixtures/quota-retry-proxy", import.meta.url)), options: { provenance: !unmarkedProxy } };
await writeFile(path.join(project, "opencode.json"), JSON.stringify({
  plugins: [...(proxyOrder === "before" ? [proxyPlugin] : []), ...(production ? [{ package: fileURLToPath(new URL("..", import.meta.url)), options: { quotaFallback: { enabled: true, allowPaidFallbacks: true }, quotaPreflight: { enabled: process.env.ROUTER_PREFLIGHT === "1" } } }] : []), ...(proxyOrder === "after" ? [proxyPlugin] : []), fileURLToPath(new URL("./fixtures/quota-retry", import.meta.url))],
  agents: { general: { model: "primary-fixture/primary" }, title: { model: "primary-fixture/primary" } },
  model: "primary-fixture/primary", enabled_providers: ["primary-fixture", "backup-fixture"],
  providers: { "primary-fixture": provider(["primary", "parent", "manual"]), "backup-fixture": provider(["backup"]) },
}));
// Reuse smoke-v2's allowlisted process environment and private serve lifecycle.
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const server = spawn(process.env.OPENCODE_TEST_BINARY ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: project, env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, FIXTURE_TOKEN: "synthetic-only",
    ...(production ? { ROUTER_PRODUCTION: "1", AGENT_ROUTER_HOME: path.join(root, "runtime"), AGENT_ROUTER_AGENTS_DIR: path.join(root, "agents"), AGENT_ROUTER_STACKS_DIR: path.join(root, "stacks") } : {}),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", b => { logs += b; }); server.stderr.on("data", b => { logs += b; });
const exited = once(server, "exit");
const evidence = { version: null, proxyOrder: proxyOrder ?? null, unmarkedProxy, cases: [] };
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
    const text = await response.text(); const result = text ? JSON.parse(text) : null;
    assert.ok(response.ok, `${url}: ${JSON.stringify(result)}`); return result?.data ?? result;
  };
  evidence.version = assertSupportedOpenCodeVersion((await request("/api/info")).version);
  await request("/api/location");
  for (let i = 0; i < 100; i++) {
    const plugins = await request("/api/plugin");
    const probe = plugins.find(p => p.id === "quota-retry-probe");
    if (probe?.state.status === "active") break;
    assert.notEqual(probe?.state.status, "failed", JSON.stringify(probe));
    if (i === 99) throw new Error("Probe did not activate");
    await delay(100);
  }
  const scenarios = unmarkedProxy ? ["proxy-unmarked"] : ["first", "main-tool", "child-first", "child-tool", "exhaustion", "partial", "auth", "timeout", "manual", "cancel", "compaction", "later-veto", ...(production ? ["explicit-first", "child-explicit", "manual-same", "pin", "backup503", "title-overlap", "title-quota"] : [])];
  const requested = process.env.ROUTER_SCENARIOS?.split(",");
  assert.ok(!requested || requested.every(name => scenarios.includes(name)), "Unknown scenario filter");
  for (scenario of scenarios.filter(name => !requested || requested.includes(name))) {
    await writeFile(path.join(root, "scenario"), scenario);
    await writeFile(path.join(root, "counter"), "0");
    titleReady = new Promise(resolve => { announceTitle = resolve; });
    primaryReady = new Promise(resolve => { announcePrimary = resolve; });
    const start = requests.length;
    const session = await request("/api/session", { location: { directory: project }, agent: "build",
      ...(production && (scenario === "title-overlap" || scenario === "title-quota") ? {} : { title: "Synthetic probe" }),
      ...(!production || scenario.startsWith("child-") || scenario === "explicit-first" ? { model: { providerID: "primary-fixture", id: scenario.startsWith("child-") ? "parent" : "primary" } } : {}) });
    const arrived = new Promise(resolve => { requestArrived = resolve; });
    await request(`/api/session/${session.id}/prompt`, { text: "Run synthetic test once" });
    if (scenario === "title-overlap" || scenario === "title-quota") {
      await Promise.race([
        Promise.all([titleReady, primaryReady]),
        delay(12_000, undefined, { ref: false }).then(() => {
          announceTitle();
          announcePrimary();
          throw new Error("No native title request at overlap barrier");
        }),
      ]);
    }
    if (["manual", "manual-same", "cancel", "pin"].includes(scenario)) {
      await Promise.race([arrived, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("No request at control barrier"); })]);
      if (scenario === "manual" || scenario === "manual-same") await request(`/api/session/${session.id}/model`, {
        model: { providerID: "primary-fixture", id: scenario === "manual" ? "manual" : "primary" },
      });
      else if (scenario === "pin") await request("/api/rpc/quota-retry-probe/pin", { input: { sessionID: session.id } });
      else await request(`/api/session/${session.id}/interrupt`, { continue: false });
      releaseResponse();
    }
    await request(`/api/experimental/session/${session.id}/wait`, {});
    if (scenario === "compaction") {
      await request(`/api/session/${session.id}/compact`, {});
      await request(`/api/experimental/session/${session.id}/wait`, {});
    }
    const rows = requests.slice(start);
    const ids = [...new Set([session.id, ...rows.map(r => r.sessionID)])];
    const sessions = [];
    for (const id of ids) sessions.push({ info: await request(`/api/session/${id}`), context: await request(`/api/session/${id}/context`) });
    const observations = (await readFile(path.join(root, "observations.jsonl"), "utf8").catch(() => ""))
      .trim().split("\n").filter(Boolean).map(JSON.parse).filter(o => ids.includes(o.sessionID));
    const counter = Number(await readFile(path.join(root, "counter"), "utf8"));
    const expected = {
      first: ["primary", "backup"], "main-tool": ["primary", "primary", "backup"],
      "child-first": ["parent", "primary", "backup", "parent"],
      "child-tool": ["parent", "primary", "primary", "backup", "parent"],
      exhaustion: ["primary", "backup"], partial: ["primary"], auth: ["primary"], timeout: ["primary"],
      manual: ["primary"], cancel: ["primary"],
      compaction: ["primary", "primary"], "later-veto": ["primary"],
      "explicit-first": ["primary"], "child-explicit": ["parent", "primary", "parent"],
      "manual-same": ["primary"], pin: ["primary"],
      backup503: ["primary", "backup"],
      "title-overlap": ["primary", "backup"], "title-quota": ["primary"],
      "proxy-unmarked": ["primary"],
    }[scenario];
    const summary = { scenario, sessionID: session.id, counter,
      requests: rows.map(r => ({ sessionID: r.sessionID, kind: r.kind, agent: r.agent, path: r.path, model: r.model,
        userMessages: r.messages.filter(m => m.role === "user").length,
        toolResults: r.messages.filter(m => m.role === "tool") })), observations,
      sessions: sessions.map(s => ({ id: s.info.id, parentID: s.info.parentID, model: s.info.model,
        messages: s.context.map(m => ({ id: m.id, type: m.type, model: m.model, finish: m.finish,
          outcome: m.outcome, error: m.error, content: m.content })) })), passed: false };
    evidence.cases.push(summary);
    assert.deepEqual(rows.filter(r => r.kind !== "title").map(r => r.model), expected, scenario);
    if (scenario.startsWith("title-")) {
      assert.equal(rows.filter(r => r.kind === "title").length, 1, "One native title request");
      assert.equal(rows.find(r => r.kind === "title").model, "primary", "Same-model title regression");
      assert.equal(rows.find(r => r.kind === "title").agent, "title");
      assert.ok(!observations.some(o => o.type === "retry" && o.agent === "title" && o.originalDecision.retry), "Title quota never requests router retry");
    }
    if (proxyOrder) assert.ok(rows.some(r => r.path === "/transport/v1/chat/completions"), "Proxy rewrite reached dispatch");
    assert.equal(counter, scenario.includes("tool") ? 1 : 0, scenario);
    for (const s of sessions) assert.equal(s.context.filter(m => m.type === "user").length, 1, "No prompt replay");
    const target = sessions.at(-1);
    if (production) {
      const status = (await request("/api/rpc/agent-router/status", { input: { sessionID: target.info.id } })).output;
      summary.routingStatus = status;
      assert.ok(status, "Native status RPC returned null for owned location");
      if (["first", "child-first", "child-tool", "main-tool", "title-overlap"].includes(scenario)) {
        assert.equal(status.mode, "automatic");
        assert.equal(status.reason, "quota_fallback_attempt_dispatched");
      }
      if (scenario === "later-veto") assert.equal(status.reason, "quota_fallback_selected_retry_requested_not_confirmed");
      if (scenario === "pin") assert.equal(status.mode, "pinned");
      if (process.env.ROUTER_PTY_EVIDENCE && ["first", "later-veto", "pin"].includes(scenario)) {
        const child = spawn("python", [fileURLToPath(new URL("./capture-status-pty.py", import.meta.url)), project, `http://127.0.0.1:${port}`, target.info.id, scenario, process.env.ROUTER_PTY_EVIDENCE], {
          env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", OPENCODE_SERVER_PASSWORD: password, ...(process.env.PYTHONPATH ? { PYTHONPATH: process.env.PYTHONPATH } : {}),
            XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
            AGENT_ROUTER_HOME: path.join(root, "runtime"), AGENT_ROUTER_AGENTS_DIR: path.join(root, "agents"), AGENT_ROUTER_STACKS_DIR: path.join(root, "stacks"),
            OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [fileURLToPath(new URL("..", import.meta.url))] }) }, stdio: "inherit",
        });
        assert.equal((await once(child, "exit"))[0], 0, "PTY capture failed");
      }
    }
    const completed = target.context.filter(m => m.type === "assistant" && m.finish === "stop");
    if (["first", "main-tool", "child-first", "child-tool", "title-overlap"].includes(scenario)) {
      assert.equal(completed.length, 1);
      assert.equal(completed[0].model.providerID, "backup-fixture");
      assert.equal(target.info.model.providerID, "backup-fixture");
      assert.ok(observations.some(o => o.eligible && o.error.type === "provider.quota" && o.originalDecision.retry === production));
    }
    if (scenario === "title-quota") {
      assert.equal(completed.length, 1);
      assert.equal(completed[0].model.providerID, "primary-fixture");
      assert.ok(!rows.some(r => r.model === "backup"), "Title-only quota must not select backup");
    }
    if (scenario.includes("tool")) {
      const calls = target.context.flatMap(m => m.content ?? []).filter(c => c.name === "probe_increment");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].state.status, "completed");
      const backup = rows.find(r => r.model === "backup");
      assert.equal(backup.sessionID, target.info.id);
      assert.ok(backup.messages.some(m => m.role === "tool" && m.content === "durable-counter=1"));
    }
    if (scenario.startsWith("child-") && scenario !== "child-explicit") {
      assert.equal(sessions.length, 2);
      assert.equal(target.info.parentID, session.id);
      const calls = sessions[0].context.flatMap(m => m.content ?? []).filter(c => c.name === "subagent");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].state.status, "completed");
      assert.equal(calls[0].state.metadata.sessionID, target.info.id);
      assert.equal(calls[0].state.metadata.status, "completed");
      assert.equal(sessions[0].context.filter(m => m.type === "assistant" && m.finish === "stop").length, 1);
    }
    if (scenario === "exhaustion") {
      assert.equal(observations.filter(o => o.type === "retry").length, 2);
      assert.equal(target.context.at(-1).outcome, "failed");
    }
    if (scenario === "backup503") {
      assert.equal(target.context.at(-1).outcome, "failed");
      assert.ok(observations.some(o => o.error?.status === 503 && !o.originalDecision.retry));
    }
    if (scenario === "partial") {
      assert.ok(target.context.some(m => m.content?.some(c => c.text === "Partial output")));
      assert.ok(observations.some(o => o.error.type === "provider.quota" && !o.eligible && o.response.status === 200));
    }
    if (scenario === "manual") assert.equal(target.info.model.id, "manual");
    if (scenario === "compaction") {
      assert.equal(target.info.model?.id, production ? undefined : "primary");
      assert.ok(observations.some(o => o.error?.type === "provider.quota" && o.response?.kind === "compaction" && !o.eligible));
    }
    if (scenario === "later-veto") {
      assert.equal(target.info.model.id, "backup", "Negative proof: switch persists despite subsequent retry veto");
      assert.ok(observations.some(o => o.type === "later-veto"));
      summary.hazard = "Backup remains selected although no backup request was dispatched after later hook veto";
    }
    summary.passed = true;
    console.log(`PASS ${scenario}: ${rows.map(r => r.model).join(" -> ")}`);
  }
} finally {
  // All retained content is generated by the synthetic fixture; never save host logs/auth.
  const output = process.argv[2] ?? `${root}.json`;
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Evidence: ${output}`);
  endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve));
  server.kill("SIGTERM"); const timer = setTimeout(() => server.kill("SIGKILL"), 5000); timer.unref();
  await exited; clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
}
