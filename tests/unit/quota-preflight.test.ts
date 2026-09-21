import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type QuotaResult,
  chooseQuotaRoute,
  createQuotaQuery,
} from "../../src/core/quota-preflight.js";

const route = {
  model: "go/primary",
  fallbacks: [{ model: "openai/backup" }, { model: "paid/last" }],
};
const now = 10000;
const result = (
  providerID: string,
  id: string,
  status: QuotaResult["status"],
  extra: Partial<QuotaResult> = {},
): QuotaResult => ({
  providerID,
  id,
  status,
  checkedAt: now - 1,
  validUntil: now + 1000,
  resetAt: now + 2000,
  accountRef: "opaque-account",
  scopeRef: "quota-scope",
  reason: "fixture",
  ...extra,
});
const exhausted = result("go", "primary", "exhausted");
afterEach(() => vi.useRealTimers());

describe("quota selection", () => {
  it("retains fresh available and unknown primary, including absent service", () => {
    for (const rows of [
      [],
      [result("go", "primary", "unknown")],
      [result("go", "primary", "available")],
    ])
      expect(chooseQuotaRoute(route, rows, false, now)?.model).toBe(route.model);
  });
  it("skips only fresh account-scoped exhaustion; an unknown bound backup is eligible", () => {
    expect(
      chooseQuotaRoute(route, [exhausted, result("openai", "backup", "unknown")], false, now)
        ?.model,
    ).toBe("openai/backup");
    for (const extra of [
      { checkedAt: null },
      { checkedAt: -1 },
      { checkedAt: 0 },
      { checkedAt: now + 1 },
      { validUntil: now },
      { resetAt: now },
      { accountRef: null },
      { scopeRef: null },
    ])
      expect(chooseQuotaRoute(route, [{ ...exhausted, ...extra }], false, now)?.model).toBe(
        route.model,
      );
  });
  it("does not apply another model's quota or ambiguous attribution", () => {
    expect(chooseQuotaRoute(route, [{ ...exhausted, id: "unrelated" }], true, now)?.model).toBe(
      route.model,
    );
    expect(chooseQuotaRoute(route, [exhausted, exhausted], true, now)?.model).toBe(route.model);
  });
  it("requires paid opt-in for unbound backup and handles exhausted chains", () => {
    expect(chooseQuotaRoute(route, [exhausted], false, now)).toBeUndefined();
    expect(chooseQuotaRoute(route, [exhausted], true, now)?.model).toBe("openai/backup");
    const rows = [
      exhausted,
      result("openai", "backup", "exhausted"),
      result("paid", "last", "exhausted"),
    ];
    expect(chooseQuotaRoute(route, rows, true, now)).toBeUndefined();
  });
});

describe("bounded query client", () => {
  it("turns missing RPC, rejection and malformed output into unknown", async () => {
    for (const query of [
      async () => {
        throw new Error("absent");
      },
      async () => ({ candidates: [exhausted, { credential: "bad" }] }),
    ]) {
      const client = createQuotaQuery(query);
      expect(await client.read([{ providerID: "go", id: "primary" }])).toEqual([]);
      client.dispose();
    }
  });
  it("aborts at deadline and caps permanently noncooperative calls without a queue", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const query = vi.fn((_input, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const client = createQuotaQuery(query, 3000, 2);
    const first = client.read([]);
    const second = client.read([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await client.read([])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
    client.dispose();
  });
  it("settles outstanding admission on disposal", async () => {
    const client = createQuotaQuery(() => new Promise(() => {}));
    const pending = client.read([]);
    client.dispose();
    expect(await pending).toEqual([]);
    expect(await client.read([])).toEqual([]);
  });
});
