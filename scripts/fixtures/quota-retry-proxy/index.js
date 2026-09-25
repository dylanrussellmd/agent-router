// TEST ONLY: transparent transport rewrite on the disposable loopback provider.
// Loaded before/after the production router to exercise both HTTP hook orders.
export default {
  id: "quota-retry-proxy",
  async setup(ctx) {
    await ctx.session.hook("http.request", event => {
      const original = event.request;
      const url = new URL(original.url);
      if (url.hostname !== "127.0.0.1" || url.pathname !== "/v1/chat/completions") return;
      url.pathname = "/transport/v1/chat/completions";
      const replacement = new Request(url, new Request(original, { redirect: "error" }));
      if (ctx.options?.provenance !== false) {
        Object.defineProperty(replacement, Symbol.for("@dylanrussell/agent-router.original-request"), {
          value: original,
        });
      }
      event.request = replacement;
    }, { providerID: "primary-fixture" });
  },
};
