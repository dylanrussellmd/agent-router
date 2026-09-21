// TEST ONLY: loaded solely by probe-quota-retry.mjs into a disposable native host.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export default { id: "quota-retry-probe", async setup(ctx) {
  const root = process.env.HOME;
  const record = (entry) => appendFile(path.join(root, "observations.jsonl"), JSON.stringify(entry) + "\n");
  const responses = new Map();
  const switched = new Set();
  await ctx.session.hook("title", event => { event.result = "Synthetic probe"; });
  await ctx.session.hook("http.request", event => {
    event.request.headers.set("x-probe-session", event.sessionID);
    event.request.headers.set("x-probe-kind", event.kind);
    responses.delete(event.sessionID);
  });
  await ctx.session.hook("http.response", event => {
    responses.set(event.sessionID, { status: event.response.status, kind: event.kind });
  });
  await ctx.session.hook("retry", async event => {
    const response = responses.get(event.sessionID);
    const session = await ctx.session.get({ sessionID: event.sessionID });
    const eligible = event.error.type === "provider.quota" &&
      response?.kind === "primary" && response.status >= 400 &&
      event.model.providerID === "primary-fixture" &&
      session.model.providerID === event.model.providerID && session.model.id === event.model.id &&
      !switched.has(event.sessionID);
    await record({ type: "retry", sessionID: event.sessionID, model: event.model,
      error: event.error, attempt: event.attempt, originalDecision: event.decision, response, eligible });
    // Veto native retries too, to bound the negative controls deterministically.
    event.decision = { retry: false };
    if (!eligible) return;
    switched.add(event.sessionID);
    await ctx.session.switchModel({ sessionID: event.sessionID,
      model: { providerID: "backup-fixture", id: "backup" } });
    event.decision = { retry: true, delay: 0 };
  });
  // Deliberately demonstrate that a subsequent policy veto is not transactional.
  await ctx.session.hook("retry", async event => {
    if (await readFile(path.join(root, "scenario"), "utf8") !== "later-veto") return;
    event.decision = { retry: false };
    await record({ type: "later-veto", sessionID: event.sessionID });
  });
  await ctx.tool.transform(editor => editor.add({
    name: "probe_increment", description: "Increment the disposable test counter once",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: async (_input, context) => {
      const file = path.join(root, "counter");
      const count = Number(await readFile(file, "utf8").catch(() => "0")) + 1;
      await writeFile(file, String(count));
      await record({ type: "tool", sessionID: context.sessionID, count });
      return { content: "durable-counter=" + count };
    },
  }));
} };
