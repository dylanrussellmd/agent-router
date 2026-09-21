import { expect, it } from "vitest";
import { PIN_STORE_KEY, createPinStore } from "../../src/core/pin-store.js";

it("serializes cross-session pin writes into one bounded durable value", async () => {
  const values = new Map<string, unknown>();
  const store = createPinStore({
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  await Promise.all([store.add("one", () => true), store.add("two", () => true)]);
  expect(values.size).toBe(1);
  expect(values.get(PIN_STORE_KEY)).toEqual({ version: 1, sessionIDs: ["one", "two"] });
  await store.remove("one");
  expect(await store.has("one")).toBe(false);
  expect(await store.has("two")).toBe(true);
});

it("bounds queued storage operations and drains already-dispatched writes", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let value: unknown;
  const store = createPinStore({
    get: async () => {
      await gate;
      return value;
    },
    set: async (_key, next) => {
      value = next;
    },
  });
  const pending = Array.from({ length: 65 }, (_, i) => store.add(String(i), () => true));
  await expect(store.add("overflow", () => true)).rejects.toThrow("busy");
  release?.();
  await Promise.all(pending);
  await store.drain();
  expect((value as { sessionIDs: string[] }).sessionIDs).toHaveLength(65);
});
