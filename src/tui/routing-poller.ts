/** One physical request at a time, even if a transport ignores abort. */
export function createRoutingPoller<T>(options: {
  read: (sessionID: string, signal: AbortSignal) => Promise<T | undefined>;
  publish: (sessionID: string | undefined, value: T | undefined) => void;
  intervalMs?: number;
  deadlineMs?: number;
}) {
  let sessionID: string | undefined;
  let generation = 0;
  let disposed = false;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (disposed || active || !sessionID) return;
    const id = sessionID;
    const version = generation;
    const controller = new AbortController();
    active = controller;
    deadline = setTimeout(() => {
      controller.abort();
      if (!disposed && version === generation) options.publish(id, undefined);
    }, options.deadlineMs ?? 3000);
    void Promise.resolve()
      .then(() => options.read(id, controller.signal))
      .then(
        (value) => {
          if (!disposed && version === generation && !controller.signal.aborted)
            options.publish(id, value);
        },
        () => {
          if (!disposed && version === generation) options.publish(id, undefined);
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        active = undefined;
        if (!disposed && sessionID) timer = setTimeout(run, options.intervalMs ?? 3000);
      });
  };
  return {
    select(id: string | undefined) {
      if (disposed || id === sessionID) return;
      sessionID = id;
      generation++;
      active?.abort();
      clearTimeout(timer);
      options.publish(id, undefined);
      run();
    },
    dispose() {
      disposed = true;
      generation++;
      active?.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
    },
  };
}
