// Explicit, test-only native-host experiment. No production router is loaded.
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

const root = await mkdtemp(path.join(tmpdir(), "quota-retry-"));
const project = path.join(root, "project");
for (const dir of ["project", "config", "data", "cache", "state"]) await mkdir(path.join(root, dir));
const requests = [];
let scenario;
let releaseResponse;
let requestArrived;
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
  requests.push({ sessionID, kind: req.headers["x-probe-kind"], model: body.model, messages: body.messages });
  if (scenario === "compaction" && !previous)
    return stream(res, body.model, { content: "Synthetic pre-compaction completion" });
  if (scenario === "manual" || scenario === "cancel") {
    requestArrived();
    await new Promise(resolve => { releaseResponse = resolve; });
  }
  if (body.model === "parent") {
    if (!previous) return tool(res, body.model, "subagent", { agent: "general", description: "Synthetic quota test",
      prompt: "Run synthetic counter task", model: "primary-fixture/primary" });
    return stream(res, body.model, { content: "Parent completed once" });
  }
  if (body.model === "primary" && scenario.includes("tool") && !previous)
    return tool(res, body.model, "probe_increment", {});
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
await writeFile(path.join(project, "opencode.json"), JSON.stringify({
  plugins: [fileURLToPath(new URL("./fixtures/quota-retry", import.meta.url))],
  model: "primary-fixture/primary", enabled_providers: ["primary-fixture", "backup-fixture"],
  providers: { "primary-fixture": provider(["primary", "parent", "manual"]), "backup-fixture": provider(["backup"]) },
}));
// Reuse smoke-v2's allowlisted process environment and private serve lifecycle.
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const server = spawn(process.env.OPENCODE_TEST_BINARY ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: project, env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, FIXTURE_TOKEN: "synthetic-only",
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state") }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", b => { logs += b; }); server.stderr.on("data", b => { logs += b; });
const exited = once(server, "exit");
const evidence = { version: null, cases: [] };
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
  evidence.version = (await request("/api/info")).version;
  assert.equal(evidence.version, "2.0.8");
  await request("/api/location");
  for (let i = 0; i < 100; i++) {
    const plugins = await request("/api/plugin");
    const probe = plugins.find(p => p.id === "quota-retry-probe");
    if (probe?.state.status === "active") break;
    assert.notEqual(probe?.state.status, "failed", JSON.stringify(probe));
    if (i === 99) throw new Error("Probe did not activate");
    await delay(100);
  }
  for (scenario of ["first", "main-tool", "child-first", "child-tool", "exhaustion", "partial", "auth", "timeout", "manual", "cancel", "compaction", "later-veto"]) {
    await writeFile(path.join(root, "scenario"), scenario);
    await writeFile(path.join(root, "counter"), "0");
    const start = requests.length;
    const session = await request("/api/session", { location: { directory: project }, title: "Synthetic probe", agent: "build",
      model: { providerID: "primary-fixture", id: scenario.startsWith("child-") ? "parent" : "primary" } });
    const arrived = new Promise(resolve => { requestArrived = resolve; });
    await request(`/api/session/${session.id}/prompt`, { text: "Run synthetic test once" });
    if (scenario === "manual" || scenario === "cancel") {
      await Promise.race([arrived, delay(10_000, undefined, { ref: false }).then(() => { throw new Error("No request at control barrier"); })]);
      if (scenario === "manual") await request(`/api/session/${session.id}/model`, {
        model: { providerID: "primary-fixture", id: "manual" },
      });
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
    }[scenario];
    const summary = { scenario, sessionID: session.id, counter,
      requests: rows.map(r => ({ sessionID: r.sessionID, kind: r.kind, model: r.model,
        userMessages: r.messages.filter(m => m.role === "user").length,
        toolResults: r.messages.filter(m => m.role === "tool") })), observations,
      sessions: sessions.map(s => ({ id: s.info.id, parentID: s.info.parentID, model: s.info.model,
        messages: s.context.map(m => ({ id: m.id, type: m.type, model: m.model, finish: m.finish,
          outcome: m.outcome, error: m.error, content: m.content })) })), passed: false };
    evidence.cases.push(summary);
    assert.deepEqual(rows.map(r => r.model), expected, scenario);
    assert.equal(counter, scenario.includes("tool") ? 1 : 0, scenario);
    for (const s of sessions) assert.equal(s.context.filter(m => m.type === "user").length, 1, "No prompt replay");
    const target = sessions.at(-1);
    const completed = target.context.filter(m => m.type === "assistant" && m.finish === "stop");
    if (["first", "main-tool", "child-first", "child-tool"].includes(scenario)) {
      assert.equal(completed.length, 1);
      assert.equal(completed[0].model.providerID, "backup-fixture");
      assert.equal(target.info.model.providerID, "backup-fixture");
      assert.ok(observations.some(o => o.eligible && o.error.type === "provider.quota" && o.originalDecision.retry === false));
    }
    if (scenario.includes("tool")) {
      const calls = target.context.flatMap(m => m.content ?? []).filter(c => c.name === "probe_increment");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].state.status, "completed");
      const backup = rows.find(r => r.model === "backup");
      assert.equal(backup.sessionID, target.info.id);
      assert.ok(backup.messages.some(m => m.role === "tool" && m.content === "durable-counter=1"));
    }
    if (scenario.startsWith("child-")) {
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
    if (scenario === "partial") {
      assert.ok(target.context.some(m => m.content?.some(c => c.text === "Partial output")));
      assert.ok(observations.some(o => o.error.type === "provider.quota" && !o.eligible && o.response.status === 200));
    }
    if (scenario === "manual") assert.equal(target.info.model.id, "manual");
    if (scenario === "compaction") {
      assert.equal(target.info.model.id, "primary");
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
