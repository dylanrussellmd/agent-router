import { afterEach, expect, it, vi } from "vitest";
import { createRoutingPoller } from "../../src/tui/routing-poller.js";
afterEach(() => vi.useRealTimers());

it("coalesces, aborts navigation, discards late results and stops on disposal", async () => {
  vi.useFakeTimers();
  let resolve: ((value: string) => void) | undefined;
  const read = vi.fn(
    (_id: string, _signal: AbortSignal) =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  const publish = vi.fn();
  const poller = createRoutingPoller({ read, publish, intervalMs: 100, deadlineMs: 50 });
  poller.select("ses_old");
  await vi.advanceTimersByTimeAsync(0);
  poller.select("ses_new");
  expect(read.mock.calls[0][1].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  resolve?.("old");
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).not.toHaveBeenCalledWith("ses_old", "old");
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1][0]).toBe("ses_new");
  poller.dispose();
  expect(read.mock.calls[1][1].aborted).toBe(true);
  resolve?.("late");
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).not.toHaveBeenCalledWith("ses_new", "late");
  expect(read).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes success, clears on timeout/unmount, and never starts a busy loop", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => "status");
  const publish = vi.fn();
  const poller = createRoutingPoller({ read, publish, intervalMs: 100, deadlineMs: 50 });
  poller.select("ses_test");
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith("ses_test", "status");
  read.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(150);
  expect(publish).toHaveBeenLastCalledWith("ses_test", undefined);
  poller.select(undefined);
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith(undefined, undefined);
  poller.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
