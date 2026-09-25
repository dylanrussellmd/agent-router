import type { Context } from "@opencode/plugin/promise/plugin";
import { afterEach, expect, it, vi } from "vitest";
import { PIN_STORE_KEY } from "../../src/core/pin-store.js";
import { createQuotaAdmission } from "../../src/quota-v2.js";
import {
  RoutingControlInput,
  RoutingStatusInput,
  RoutingStatusOutput,
  createRoutingStatusReader,
} from "../../src/routing-status.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const location = { directory: "/project", project: { id: "project" } };
  const session: {
    projectID: string;
    location: { directory: string; workspaceID?: string };
    agent: string;
    model?: { providerID: string; id: string };
  } = { projectID: "project", location: { directory: "/project" }, agent: "build" };
  const stored = new Map<string, unknown>();
  const quotaQuery = vi.fn();
  const ctx = {
    location,
    options: { quotaPreflight: { enabled: true } },
    rpc: () => ({ query: quotaQuery }),
    storage: { get: vi.fn(async (key: string) => stored.get(key)), set: vi.fn() },
    session: { get: vi.fn(async () => session), switchModel: vi.fn(), prompt: vi.fn() },
    agent: {
      get: vi.fn(async () => ({ data: { model: { providerID: "fixture", id: "primary" } } })),
    },
    model: { default: vi.fn() },
  };
  const admission = createQuotaAdmission(
    ctx as unknown as Context,
    { build: { model: "fixture/primary" } },
    () => true,
  )!;
  return {
    ctx,
    session,
    stored,
    quotaQuery,
    admission,
    read: createRoutingStatusReader(ctx as unknown as Context, admission),
  };
}

it("reports native default, manual, durable pin, and proven child ownership without routing side effects", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fixture();
  expect(await f.read({ sessionID: "ses_test" })).toMatchObject({
    mode: "automatic",
    model: { id: "primary" },
    checkedAt: null,
    validUntil: null,
  });
  f.session.model = { providerID: "fixture", id: "backup" };
  expect(await f.read({ sessionID: "ses_test" })).toMatchObject({
    mode: "pinned",
    reason: "manual_or_preexisting_selection",
  });
  f.admission.claim("ses_test", "build", f.session.model);
  f.admission.reason("ses_test", "quota_fallback_selected_retry_requested_not_confirmed");
  expect(await f.read({ sessionID: "ses_test" })).toMatchObject({
    mode: "automatic",
    reason: "quota_fallback_selected_retry_requested_not_confirmed",
  });
  f.admission.reason("ses_test", "quota_fallback_attempt_dispatched");
  expect(await f.read({ sessionID: "ses_test" })).toMatchObject({
    reason: "quota_fallback_attempt_dispatched",
  });
  f.stored.set(PIN_STORE_KEY, { version: 1, sessionIDs: ["ses_test"] });
  expect(await f.read({ sessionID: "ses_test" })).toMatchObject({
    mode: "pinned",
    reason: "explicit_pin",
  });
  expect(f.quotaQuery).not.toHaveBeenCalled();
  expect(f.ctx.storage.set).not.toHaveBeenCalled();
  expect(f.ctx.session.switchModel).not.toHaveBeenCalled();
  expect(f.ctx.session.prompt).not.toHaveBeenCalled();
  await f.admission.dispose();
});

it.each([
  undefined,
  {},
  { sessionID: "" },
  { sessionID: "../secret" },
  { sessionID: "ses_test", extra: true },
])("rejects invalid RPC input before any reads: %j", async (input) => {
  const f = fixture();
  expect(RoutingStatusInput.safeParse(input).success).toBe(false);
  expect(await f.read(input)).toBeNull();
  expect(f.ctx.session.get).not.toHaveBeenCalled();
  await f.admission.dispose();
});

it.each([
  undefined,
  {},
  { sessionID: "ses_test" },
  { sessionID: "ses_test", action: "toggle" },
  { sessionID: "ses_test", action: "pin", extra: true },
])("rejects invalid routing control input: %j", (input) => {
  expect(RoutingControlInput.safeParse(input).success).toBe(false);
});

it.each(["directory", "workspace", "project", "missing"])(
  "fails closed for %s ownership before pins/defaults",
  async (kind) => {
    const f = fixture();
    if (kind === "directory") f.session.location.directory = "/foreign";
    if (kind === "workspace") f.session.location.workspaceID = "foreign";
    if (kind === "project") f.session.projectID = "foreign";
    if (kind === "missing") f.ctx.session.get.mockResolvedValueOnce(undefined as never);
    expect(await f.read({ sessionID: "ses_test" })).toBeNull();
    expect(f.ctx.storage.get).not.toHaveBeenCalled();
    expect(f.ctx.agent.get).not.toHaveBeenCalled();
    await f.admission.dispose();
  },
);

it("keeps actual historical quota time, sanitizes output, and clears observations", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fixture();
  const checkedAt = Date.now() - 30000;
  f.admission.observe("ses_test", { providerID: "fixture", id: "primary" }, [
    {
      providerID: "fixture",
      id: "primary",
      checkedAt,
      validUntil: checkedAt + 60000,
      resetAt: null,
      accountRef: "secret-account",
      scopeRef: "secret-scope",
      status: "available",
      reason: "secret-error-url",
    },
  ]);
  f.admission.reason("ses_test", "https://secret.example/prompt");
  const a = await f.read({ sessionID: "ses_test" });
  const b = await f.read({ sessionID: "ses_test" });
  expect(a?.checkedAt).toBe(checkedAt);
  expect(b).toEqual(a);
  expect(a?.reason).toBe("unknown");
  expect(JSON.stringify(a)).not.toContain("secret");
  expect(RoutingStatusOutput.safeParse({ ...a, accountRef: "secret" }).success).toBe(false);
  f.admission.clearFreshness();
  expect((await f.read({ sessionID: "ses_test" }))?.checkedAt).toBeNull();
  await f.admission.dispose();
});
