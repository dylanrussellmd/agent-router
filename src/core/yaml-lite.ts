/**
 * Minimal YAML for agent-router frontmatter options — dependency-free.
 *
 * We deliberately do NOT pull in a YAML library: the package ships a
 * self-contained bundle (see `tsup.config.ts`), and the canonical `yaml`
 * package is CJS that calls `require('process')`, which esbuild's ESM
 * CJS-shim refuses in a bundled ESM output. Hand-rolling a parser here keeps
 * the bundle clean and the runtime dep list empty.
 *
 * Scope is intentionally narrow: only what agent frontmatter option values
 * need.
 *   - Serialize: scalars (with safe quoting) + objects/arrays as JSON flow
 *     (a valid YAML subset, single line regardless of nesting).
 *   - Parse: a top-level YAML mapping block — scalars, quoted strings, flow
 *     `{...}` / `[...]`, and block-style mappings / sequences. Unknown
 *     constructs fall back to the raw string so data is never lost.
 *
 * This is NOT a general YAML implementation. It assumes well-formed
 * frontmatter produced by humans or by `serializeOptionValue`. opencode's own
 * frontmatter loader (which uses a full parser) is the authority at runtime;
 * this module only governs what agent-router captures and writes.
 */

/* ------------------------------------------------------------------------- *
 * serialize                                                                  *
 * ------------------------------------------------------------------------- */

const RESERVED_WORDS = new Set([
  "null",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "~",
  // YAML 1.1 nulls
  "Null",
  "NULL",
  "True",
  "False",
  "Yes",
  "No",
  "On",
  "Off",
]);

const BARE_STRING_RE = /^[A-Za-z0-9._\-\/+@$%^&()~]+$/;

/** True when a bare string would be coerced to a non-string YAML scalar. */
function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (RESERVED_WORDS.has(s)) return true;
  // looks like a number (int, float, scientific, hex, ±Infinity, etc.)
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true;
  if (/^0x[0-9A-Fa-f]+$/.test(s)) return true;
  if (/^[+-]?\.(inf|Inf|INF|nan|NaN|NAN)$/.test(s)) return true;
  if (!BARE_STRING_RE.test(s)) return true;
  return false;
}

/**
 * Serialize a single option value to one YAML line.
 * Scalars get safe quoting; objects and arrays use JSON flow (valid YAML,
 * always single-line). `null` serializes as `null`.
 */
export function serializeOptionValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return needsQuoting(value) ? JSON.stringify(value) : value;
  // object or array — JSON is a YAML subset and stays on one line
  return JSON.stringify(value);
}

/* ------------------------------------------------------------------------- *
 * parse                                                                       *
 * ------------------------------------------------------------------------- */

interface RawLine {
  indent: number;
  text: string; // content with trailing comment stripped, trimmed of leading indent
  raw: string; // original line (for error fallback)
}

/** Strip a trailing YAML comment (` # ...`) that is not inside quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      // only a comment if preceded by whitespace or start of line
      if (i === 0 || /\s/.test(line[i - 1] ?? "")) return line.slice(0, i);
    }
  }
  return line;
}

/** Split a block into indented, comment-stripped lines (blank lines dropped). */
function tokenize(block: string): RawLine[] {
  const out: RawLine[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const indentMatch = /^( *)/.exec(raw);
    const indent = indentMatch?.[1]?.length ?? 0;
    const content = stripComment(raw.slice(indent));
    if (content.trim() === "") continue;
    out.push({ indent, text: content.trimEnd(), raw });
  }
  return out;
}

/** Coerce a bare (unquoted) scalar token to its JS value. */
function coerceScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~" || v === "Null" || v === "NULL") return null;
  if (v === "true" || v === "True" || v === "TRUE") return true;
  if (v === "false" || v === "False" || v === "FALSE") return false;
  if (v === "yes" || v === "Yes" || v === "YES") return true;
  if (v === "no" || v === "No" || v === "NO") return false;
  if (v === "on" || v === "On" || v === "ON") return true;
  if (v === "off" || v === "Off" || v === "OFF") return false;
  if (/^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return Number.parseFloat(v);
  if (/^0x[0-9A-Fa-f]+$/.test(v)) return Number.parseInt(v, 16);
  return v; // string
}

/** Parse a quoted scalar starting at index 0 of `s`. Returns {value, rest}. */
function parseQuoted(s: string): { value: string; rest: string } | null {
  const quote = s[0] ?? "";
  if (quote !== '"' && quote !== "'") return null;
  if (quote === '"') {
    // JSON-style double-quoted: find closing unescaped quote
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const ch = s[i] ?? "";
      if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1] ?? "";
        const map: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
        };
        out += map[next] ?? next;
        i++;
      } else if (ch === '"') {
        return { value: out, rest: s.slice(i + 1) };
      } else {
        out += ch;
      }
    }
    return null;
  }
  // single-quoted: '' is an escaped literal quote
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const ch = s[i] ?? "";
    if (ch === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        return { value: out, rest: s.slice(i + 1) };
      }
    } else {
      out += ch;
    }
  }
  return null;
}

/**
 * Split a flow collection string on top-level commas (respecting nested
 * `{}`/`[]` and quotes). Returns the item substrings (untrimmed).
 */
function splitFlow(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(raw.slice(start, i));
        start = i + 1;
      }
    }
  }
  parts.push(raw.slice(start));
  return parts;
}

/** Parse a flow value: `{...}` mapping, `[...]` sequence, quoted, or bare. */
function parseFlowValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return null;
  const first = s[0] ?? "";
  if (first === "{") {
    const inner = s.slice(1, s.length - 1);
    const obj: Record<string, unknown> = {};
    for (const part of splitFlow(inner)) {
      const t = part.trim();
      if (t === "") continue;
      const colon = findColon(t);
      if (colon < 0) {
        obj[t] = null; // `{key}` ⇒ key with null value
      } else {
        const k = t.slice(0, colon).trim();
        const v = t.slice(colon + 1).trim();
        obj[stripKeyQuotes(k)] = parseFlowValue(v);
      }
    }
    return obj;
  }
  if (first === "[") {
    const inner = s.slice(1, s.length - 1);
    return splitFlow(inner)
      .filter((p) => p.trim() !== "")
      .map((p) => parseFlowValue(p));
  }
  if (first === '"' || first === "'") {
    const q = parseQuoted(s);
    return q ? q.value : s;
  }
  return coerceScalar(s);
}

/** Find the first top-level `:` (not inside quotes / nested flow). */
function findColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === ":" && depth === 0) return i;
    }
  }
  return -1;
}

function stripKeyQuotes(k: string): string {
  if (k.length >= 2 && ((k[0] === '"' && k.at(-1) === '"') || (k[0] === "'" && k.at(-1) === "'"))) {
    return k.slice(1, -1);
  }
  return k;
}

/**
 * Parse a mapping at `indent` starting at `lines[startIdx]`. Returns the
 * parsed object and the index of the first line NOT consumed (indent < this
 * level, or end).
 */
function parseMapping(
  lines: RawLine[],
  startIdx: number,
  indent: number,
): { value: Record<string, unknown>; next: number } {
  const out: Record<string, unknown> = {};
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      // stray deeper line at mapping level — skip defensively
      i++;
      continue;
    }
    const colon = findColon(line.text);
    if (colon < 0) {
      // not a `key: value` line at mapping level — skip
      i++;
      continue;
    }
    const key = stripKeyQuotes(line.text.slice(0, colon).trim());
    if (key === "") {
      // empty key (e.g. `: : :` malformed line) — skip defensively
      i++;
      continue;
    }
    const rest = line.text.slice(colon + 1).trim();
    if (rest !== "") {
      out[key] = parseFlowValue(rest);
      i++;
    } else {
      // block value: child indent is whatever the first child actually uses
      // (2 spaces, 4 spaces, …) — not assumed to be parent+1.
      const childIndent = lines[i + 1]?.indent ?? line.indent + 1;
      let j = i + 1;
      while (j < lines.length && (lines[j]?.indent ?? -1) >= childIndent) j++;
      if (j === i + 1) {
        out[key] = null;
        i++;
      } else {
        const childBlock = lines.slice(i + 1, j);
        const firstChild = childBlock[0];
        if (firstChild?.text.trimStart().startsWith("- ")) {
          out[key] = parseSequence(childBlock, childIndent);
        } else {
          out[key] = parseMapping(childBlock, 0, childIndent).value;
        }
        i = j;
      }
    }
  }
  return { value: out, next: i };
}

/** Parse a block sequence at `indent`. */
function parseSequence(lines: RawLine[], indent: number): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.indent < indent) break;
    const t = line.text.trimStart();
    if (!t.startsWith("- ")) {
      i++;
      continue;
    }
    const item = t.slice(2).trim();
    if (item === "") {
      // nested block item — child indent is the first following line's indent
      const childIndent = lines[i + 1]?.indent ?? line.indent + 1;
      let j = i + 1;
      while (j < lines.length && (lines[j]?.indent ?? -1) >= childIndent) j++;
      out.push(parseMapping(lines.slice(i + 1, j), 0, childIndent).value);
      i = j;
    } else {
      out.push(parseFlowValue(item));
      i++;
    }
  }
  return out;
}

/**
 * Parse a frontmatter block (the text between the `---` fences) into a
 * record. Returns `null` when the block is empty or not a parseable mapping.
 * Never throws — callers use this for best-effort capture.
 */
export function parseFrontmatterBlock(block: string): Record<string, unknown> | null {
  const lines = tokenize(block);
  if (lines.length === 0) return null;
  const { value } = parseMapping(lines, 0, 0);
  return value;
}

/** Re-exported for tests. */
export const __test = { tokenize, coerceScalar, parseFlowValue, needsQuoting };
