import { z } from "zod";

const Pins = z
  .object({ version: z.literal(1), sessionIDs: z.array(z.string().min(1)).max(1024) })
  .strict();
export const PIN_STORE_KEY = "quota-pins-v1";

/** One bounded durable value; a bounded lane prevents cross-session lost updates. */
export function createPinStore(storage: {
  get(key: string): Promise<unknown>;
  set(key: string, value: { version: 1; sessionIDs: string[] }): Promise<unknown>;
}) {
  let lane = Promise.resolve();
  let pending = 0;
  const read = async () => {
    const value = await storage.get(PIN_STORE_KEY);
    return new Set(value === undefined ? [] : Pins.parse(value).sessionIDs);
  };
  const mutate = (sessionID: string, add: boolean, valid: () => boolean) => {
    // At most 64 controls plus one serial event-stream deletion.
    if (pending >= 65) return Promise.reject(new Error("Session pin storage is busy; try again."));
    pending++;
    const operation = lane.then(async () => {
      const pins = await read();
      if (!valid()) throw new Error("Session pin operation was cancelled.");
      if (add) {
        if (!pins.has(sessionID) && pins.size >= 1024)
          throw new Error("Session pin capacity reached.");
        pins.add(sessionID);
      } else if (!pins.delete(sessionID)) return;
      await storage.set(PIN_STORE_KEY, { version: 1, sessionIDs: [...pins] });
    });
    lane = operation.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return operation;
  };
  return {
    async has(sessionID: string) {
      await lane;
      return (await read()).has(sessionID);
    },
    add: (sessionID: string, valid: () => boolean) => mutate(sessionID, true, valid),
    remove: (sessionID: string, valid = () => true) => mutate(sessionID, false, valid),
    drain: () => lane,
  };
}
