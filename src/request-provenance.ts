/**
 * Request provenance cooperation contract.
 *
 * Trusted HTTP rewriting plugins (for example a local gateway adapter) replace
 * `session.http.request` / `session.http.response` requests with a new
 * `Request` that they send on the wire. Without cooperation the router's
 * quota fallback correlates by exact `Request` identity, so a replacement
 * either fails endpoint validation or breaks the response WeakMap lookup.
 *
 * The contract is a shared global symbol, attached as an immutable,
 * non-enumerable own *data* property on the replacement:
 *
 * ```ts
 * Object.defineProperty(replacement, ORIGINAL_REQUEST, {
 *   value: original,
 *   writable: false,
 *   enumerable: false,
 *   configurable: false,
 * }),
 * ```
 *
 * `attachOriginalRequest` performs exactly that definition and is the only
 * place the router attaches markers (primarily for tests and internal reuse).
 * External trusted adapters may attach the marker themselves with the same
 * symbol; `resolveOriginalRequest` never inspects bodies, headers, or any
 * network data as authority. A request without the marker is its own origin.
 */

/** Global cooperation symbol shared by the router and trusted rewriting plugins. */
export const ORIGINAL_REQUEST = Symbol.for("@dylanrussell/agent-router.original-request");

/** Maximum marker hops the resolver follows before rejecting a chain. */
export const MAX_PROVENANCE_DEPTH = 8;
const UNMARKED = Symbol("unmarked-request");

/** Resolver failure: malformed, cyclic, mismatched, or unbounded provenance. */
export class RequestProvenanceError extends Error {
  override readonly name: string = "RequestProvenanceError";
}

/**
 * Validate the marker descriptor on `request`. The contract requires an own
 * data property that is immutable (`writable: false`, `configurable: false`)
 * and non-enumerable. Accessors, inherited markers, and any relaxed flag are
 * rejected so the link cannot change between request and response checks, and
 * a getter can never be invoked as a side effect of resolution. The transport
 * plugin itself remains trusted; descriptors do not authenticate arbitrary code.
 */
function readMarker(request: Request): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(request, ORIGINAL_REQUEST);
  } catch {
    throw new RequestProvenanceError("provenance marker descriptor is unreadable");
  }
  if (descriptor === undefined) {
    if (ORIGINAL_REQUEST in request)
      throw new RequestProvenanceError("provenance marker must be an own property");
    return UNMARKED;
  }
  if (
    !("value" in descriptor) ||
    descriptor.enumerable ||
    descriptor.writable ||
    descriptor.configurable
  )
    throw new RequestProvenanceError(
      "provenance marker must be an immutable non-enumerable data property",
    );
  return descriptor.value;
}

/**
 * Resolve the exact *original* native `Request` behind a possibly rewritten
 * replacement, following at most `MAX_PROVENANCE_DEPTH` marker hops.
 *
 * Resolution is identity-only: it reads the marker property descriptor, never
 * request bodies, headers, or any network-provided data. An unmarked request
 * resolves to itself. Rejected: malformed descriptors, accessor markers,
 * non-`Request` marker values, method mismatches between a link and its
 * parent, cycles, and chains deeper than the bound.
 */
export function resolveOriginalRequest(request: Request): Request {
  if (!(request instanceof Request))
    throw new RequestProvenanceError("provenance must reference a Request");
  const seen = new Set<object>();
  let current: Request = request;
  for (let hops = 0; hops <= MAX_PROVENANCE_DEPTH; hops++) {
    if (seen.has(current))
      throw new RequestProvenanceError("cyclic request provenance marker chain");
    seen.add(current);
    const marker = readMarker(current);
    if (marker === UNMARKED) return current;
    if (!(marker instanceof Request))
      throw new RequestProvenanceError("provenance marker does not reference a Request");
    if (marker.method !== current.method)
      throw new RequestProvenanceError("provenance marker method mismatch");
    current = marker;
  }
  throw new RequestProvenanceError(
    `request provenance chain exceeds ${MAX_PROVENANCE_DEPTH} marker hops`,
  );
}

/**
 * Attach the cooperation marker to a replacement `Request`, preserving the
 * exact original identity for router correlation. Returns the replacement.
 * Throws if either argument is not a `Request`, if the replacement already
 * carries a marker, or if the marker cannot be made immutable.
 */
export function attachOriginalRequest(replacement: Request, original: Request): Request {
  if (!(replacement instanceof Request) || !(original instanceof Request))
    throw new TypeError("attachOriginalRequest expects two Request instances");
  if (Object.getOwnPropertyDescriptor(replacement, ORIGINAL_REQUEST) !== undefined)
    throw new RequestProvenanceError("replacement already carries a provenance marker");
  try {
    Object.defineProperty(replacement, ORIGINAL_REQUEST, {
      value: original,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch (error) {
    throw new RequestProvenanceError("cannot attach provenance marker to this Request", {
      cause: error,
    });
  }
  return replacement;
}
