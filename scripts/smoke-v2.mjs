import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
]) {
  await mkdir(path.join(root, name), { recursive: true });
}
await writeFile(
  path.join(project, "opencode.json"),
  JSON.stringify({ plugins: [packagePath, probe] }),
);
// This RPC exists only in the disposable integration fixture. Router has no RPC API.
await writeFile(
  path.join(probe, "index.js"),
  `
const noInput = { "~standard": { version: 1, vendor: "agent-router-integration",
  validate(input) { return input == null ? { value: undefined } : { issues: [{ message: "No input accepted" }] }; }
} };
export default { id: "agent-router.integration-probe", async setup(ctx) {
  let calls = 0;
  await ctx.rpc.register({ id: "agent-router.integration-probe", events: {}, methods: {
    status: { input: noInput, output: { type: "object" }, errors: {} }
  } }, { status: async () => ({ calls: ++calls, plugins: (await ctx.plugin.list()).data.map(p => ({ id: p.id, status: p.state.status })) }) });
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
  ...process.env,
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
    });
    return { status: response.status, body: await response.json() };
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
} finally {
  server.kill("SIGTERM");
  const killTimer = setTimeout(() => server.kill("SIGKILL"), 5_000);
  killTimer.unref();
  await exited;
  clearTimeout(killTimer);
  await rm(root, { recursive: true, force: true });
}
