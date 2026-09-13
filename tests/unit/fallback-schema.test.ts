import { expect, it } from "vitest";
import { StackFileSchema } from "../../src/core/schema.js";
import { validateStack } from "../../src/core/validator.js";

it.each([
  null,
  "b/two",
  [{ model: "bad" }],
  [{ model: "b/two", variant: "" }],
  [{ model: "b/two", temperature: 1 }],
  Array.from({ length: 9 }, () => ({ model: "b/two" })),
])("rejects invalid fallback shape %j", (fallbacks) => {
  expect(
    StackFileSchema.safeParse({ agents: { worker: { model: "a/one", fallbacks } } }).success,
  ).toBe(false);
});

it("validates every candidate with indexed diagnostic paths", async () => {
  const stack = StackFileSchema.parse({
    agents: {
      worker: {
        model: "a/one",
        fallbacks: [{ model: "b/two", variant: "low" }, { model: "c/three" }],
      },
    },
  });
  const result = await validateStack(stack, { runOpencodeModels: async () => "a/one\nc/three" });
  expect(result.checked).toBe(3);
  expect(result.missing).toEqual([{ path: "agents.worker.fallbacks.0.model", modelId: "b/two" }]);
});
