import { describe, expect, it } from "vitest";
import {
  MAX_PROVENANCE_DEPTH,
  ORIGINAL_REQUEST,
  RequestProvenanceError,
  attachOriginalRequest,
  resolveOriginalRequest,
} from "../../src/request-provenance.js";

const url = "https://native.test/v1/chat/completions";
const fresh = () => new Request(url);

/** Build `depth` wrapped replacements layered over one original. */
function chain(depth: number) {
  const root = fresh();
  let current = root;
  for (let i = 0; i < depth; i++) {
    const wrapper = fresh();
    attachOriginalRequest(wrapper, current);
    current = wrapper;
  }
  return { root, outer: current };
}

describe("request provenance resolver", () => {
  it("treats an unmarked Request as its own origin", () => {
    const request = fresh();
    expect(resolveOriginalRequest(request)).toBe(request);
  });
  it("resolves a single marked replacement to the exact original identity", () => {
    const native = fresh();
    const replacement = fresh();
    attachOriginalRequest(replacement, native);
    expect(resolveOriginalRequest(replacement)).toBe(native);
  });
  it("shares the cooperation symbol with external adapters via Symbol.for", () => {
    expect(ORIGINAL_REQUEST).toBe(Symbol.for("@dylanrussell/agent-router.original-request"));
    const native = fresh();
    const replacement = fresh();
    // An external trusted plugin attaches the marker itself, same symbol.
    Object.defineProperty(replacement, Symbol.for("@dylanrussell/agent-router.original-request"), {
      value: native,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(resolveOriginalRequest(replacement)).toBe(native);
  });
  it.each([1, 4, MAX_PROVENANCE_DEPTH])("resolves a chain of %i markers", (depth) => {
    const { root, outer } = chain(depth);
    expect(resolveOriginalRequest(outer)).toBe(root);
  });
  it("rejects a chain deeper than the bound", () => {
    const { outer } = chain(MAX_PROVENANCE_DEPTH + 1);
    expect(() => resolveOriginalRequest(outer)).toThrow(RequestProvenanceError);
  });
  it("rejects a cyclic marker chain", () => {
    const a = fresh();
    const b = fresh();
    attachOriginalRequest(b, a);
    attachOriginalRequest(a, b);
    expect(() => resolveOriginalRequest(b)).toThrow(RequestProvenanceError);
    expect(() => resolveOriginalRequest(a)).toThrow(RequestProvenanceError);
  });
  it.each([undefined, null, { fake: true }])("rejects a non-Request marker value: %s", (value) => {
    const replacement = fresh();
    Object.defineProperty(replacement, ORIGINAL_REQUEST, {
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(() => resolveOriginalRequest(replacement)).toThrow(RequestProvenanceError);
  });
  it("rejects inherited markers without invoking a getter", () => {
    const replacement = fresh();
    const prototype = Object.create(Request.prototype);
    Object.defineProperty(prototype, ORIGINAL_REQUEST, {
      get: () => {
        throw new Error("getter must not run");
      },
    });
    Object.setPrototypeOf(replacement, prototype);
    expect(() => resolveOriginalRequest(replacement)).toThrow(RequestProvenanceError);
  });
  it("rejects an accessor marker and never invokes its getter", () => {
    const replacement = fresh();
    Object.defineProperty(replacement, ORIGINAL_REQUEST, {
      get: () => {
        throw new Error("getter must not run");
      },
      enumerable: false,
      configurable: false,
    });
    expect(() => resolveOriginalRequest(replacement)).toThrow(RequestProvenanceError);
  });
  it.each([
    ["enumerable", { enumerable: true, writable: false, configurable: false }],
    ["writable", { enumerable: false, writable: true, configurable: false }],
    ["configurable", { enumerable: false, writable: false, configurable: true }],
  ] as const)("rejects a marker that is not immutable non-enumerable: %s", (_label, flags) => {
    const native = fresh();
    const replacement = fresh();
    Object.defineProperty(replacement, ORIGINAL_REQUEST, { value: native, ...flags });
    expect(() => resolveOriginalRequest(replacement)).toThrow(RequestProvenanceError);
  });
  it("rejects a method mismatch between a link and its origin", () => {
    const native = new Request(url, { method: "GET" });
    const replacement = new Request(url, { method: "POST" });
    attachOriginalRequest(replacement, native);
    expect(() => resolveOriginalRequest(replacement)).toThrow(RequestProvenanceError);
  });
  it("never reads bodies while resolving", () => {
    const native = fresh();
    const replacement = fresh();
    attachOriginalRequest(replacement, native);
    expect(native.bodyUsed).toBe(false);
    expect(replacement.bodyUsed).toBe(false);
    expect(resolveOriginalRequest(replacement)).toBe(native);
    expect(native.bodyUsed).toBe(false);
    expect(replacement.bodyUsed).toBe(false);
  });
});

describe("attachOriginalRequest", () => {
  it("defines an immutable non-enumerable own data property and returns the replacement", () => {
    const native = fresh();
    const replacement = fresh();
    expect(attachOriginalRequest(replacement, native)).toBe(replacement);
    const descriptor = Object.getOwnPropertyDescriptor(replacement, ORIGINAL_REQUEST);
    expect(descriptor).toBeDefined();
    expect(descriptor && "value" in descriptor).toBe(true);
    expect(descriptor).toMatchObject({
      value: native,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(resolveOriginalRequest(replacement)).toBe(native);
    expect(Object.keys(replacement)).toEqual([]);
  });
  it("rejects attaching a marker more than once", () => {
    const native = fresh();
    const replacement = fresh();
    attachOriginalRequest(replacement, native);
    expect(() => attachOriginalRequest(replacement, native)).toThrow(RequestProvenanceError);
  });
  it("rejects non-Request arguments", () => {
    expect(() => attachOriginalRequest({} as unknown as Request, fresh())).toThrow(TypeError);
    expect(() => attachOriginalRequest(fresh(), {} as unknown as Request)).toThrow(TypeError);
  });
  it("cannot be reassigned once attached", () => {
    const native = fresh();
    const replacement = fresh();
    attachOriginalRequest(replacement, native);
    expect(() => {
      replacement[ORIGINAL_REQUEST] = fresh();
    }).toThrow(TypeError);
    expect(resolveOriginalRequest(replacement)).toBe(native);
  });
});
