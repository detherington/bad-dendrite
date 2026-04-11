/** Generic `<script>`-tag scanner for SSR hydration payloads.
 *
 *  Covers the many shapes modern streamer sites use:
 *
 *    - `<script id="__NEXT_DATA__" type="application/json">{...}</script>`
 *      (Disney+, HBO, Next.js in general)
 *    - `<script id="serialized-server-data" type="application/json">{...}</script>`
 *      (Apple TV web, SvelteKit)
 *    - `<script>window.__APOLLO_STATE__ = {...};</script>`
 *      (Peacock)
 *    - `<script>window.netflix = ...; netflix.reactContext = {...};</script>`
 *      (Netflix Tudum — dotted-path assignment, not window.__FOO__)
 *    - Various `window.__INITIAL_STATE__` / `__PRELOADED_STATE__`
 *      assignments (older React apps)
 *
 *  Strategy:
 *    1. For each <script> tag, attempt to parse the ENTIRE body as
 *       JSON directly (`typed-json` when there's an application/json
 *       type attribute, `raw-json` otherwise).
 *    2. Scan the body for `IDENT.IDENT...  = {|[` assignment patterns
 *       using a balanced-brace extractor (so nested objects work —
 *       naive `{[\s\S]*?}` regex gives up at the first `}`).
 *    3. Preprocess each extracted literal to convert `\xNN` hex
 *       escapes to `\u00NN` Unicode escapes before JSON.parse — React
 *       embeds often use `\x20` etc. which are valid JS but not JSON.
 *    4. Return every parsed value along with its `source` label so
 *       callers can see which strategy produced each hit. */

import type { HTMLElement } from "node-html-parser";

export interface ScriptInventoryItem {
  id: string | null;
  type: string | null;
  bytes: number;
  preview: string;
}

export function inventoryScripts(root: HTMLElement): ScriptInventoryItem[] {
  const scripts = root.querySelectorAll("script");
  const items: ScriptInventoryItem[] = [];
  for (const script of scripts) {
    const raw = script.rawText ?? "";
    if (raw.length < 50) continue;
    items.push({
      id: script.getAttribute("id") ?? null,
      type: script.getAttribute("type") ?? null,
      bytes: raw.length,
      preview: raw.slice(0, 150).replace(/\s+/g, " ").trim(),
    });
    if (items.length >= 20) break;
  }
  return items;
}

export interface ScanPayload {
  value: unknown;
  source: string;
  bytes: number;
}

/** Extract every parseable JSON payload from the page's <script> tags.
 *  Returns one entry per (script, strategy) that successfully parsed. */
export function scanScriptsForJsonPayloads(root: HTMLElement): ScanPayload[] {
  const out: ScanPayload[] = [];
  const scripts = root.querySelectorAll("script");

  for (const script of scripts) {
    const raw = script.rawText;
    if (!raw || raw.length < 50) continue;
    const type = script.getAttribute("type") ?? "";
    const id = script.getAttribute("id") ?? "";

    // Strategy 1: typed JSON script.
    if (type === "application/json" || type === "application/ld+json") {
      const parsed = safeJsonParse(raw);
      if (parsed != null) {
        out.push({
          value: parsed,
          source: `typed-json${id ? `:${id}` : ""}`,
          bytes: raw.length,
        });
        continue;
      }
    }

    // Strategy 2: plain JSON at position 0.
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = safeJsonParse(trimmed);
      if (parsed != null) {
        out.push({
          value: parsed,
          source: `raw-json${id ? `:${id}` : ""}`,
          bytes: raw.length,
        });
        continue;
      }
    }

    // Strategy 3: inline state assignments. Scan for
    //
    //     IDENT(.IDENT)* = { ... };
    //     IDENT(.IDENT)* = [ ... ];
    //
    // and extract the RHS via a balanced-brace scan. Any literal
    // larger than the threshold and parseable as JSON (after the
    // \xNN -> \uNN fix) is kept. The threshold filters out tiny
    // config objects like `{enabled: true}`.
    const assignments = findAssignments(raw);
    for (const assignment of assignments) {
      const literal = extractBalancedLiteral(raw, assignment.valueStart);
      if (!literal || literal.length < 200) continue;
      const parsed = safeJsonParse(jsLiteralToJson(literal));
      if (parsed == null) continue;
      out.push({
        value: parsed,
        source: `inline:${assignment.name}`,
        bytes: literal.length,
      });
    }
  }
  return out;
}

// ---------- JSON parsing helpers ----------

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Convert `\xNN` hex escapes and any accidentally-embedded raw
 *  unicode chars to their JSON-safe equivalents. Minimal sweep — we
 *  don't try to convert JS object literal syntax to JSON (unquoted
 *  keys, trailing commas, single quotes) because streamer hydration
 *  blobs are typically serialised via JSON.stringify() and then
 *  assigned, so the literal IS valid JSON once the `\x` escapes
 *  are normalised. */
function jsLiteralToJson(src: string): string {
  return src.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => `\\u00${hex}`);
}

// ---------- Balanced brace literal extraction ----------

interface Assignment {
  name: string;
  valueStart: number; // index of the opening `{` or `[`
}

/** Scan a script body for `IDENT(.IDENT)* = {|[` assignment starts.
 *  Does NOT attempt to parse the RHS — that's the extractor's job. */
function findAssignments(src: string): Assignment[] {
  // Identifier path like `window.__APOLLO_STATE__`,
  // `netflix.reactContext`, or `propStore`. Allow bare identifiers
  // too so dotted paths without `window.` (Netflix Tudum) are caught.
  const regex = /(?:^|[\s;{(])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*([{[])/g;
  const out: Assignment[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(src)) !== null) {
    const name = match[1];
    // Filter: require at least one dot (dotted path) OR a known
    // uppercase `__FOO__` style, AND require the name to be something
    // plausibly hydration-related. Excludes things like `var x = {...}`
    // or tiny inline config assignments.
    if (!looksLikeHydrationName(name)) continue;
    // `match.index` points at the preceding whitespace/punctuation;
    // the `[{[]` capture group is at match[0]'s last char.
    const valueStart = match.index + match[0].length - 1;
    out.push({ name, valueStart });
  }
  return out;
}

function looksLikeHydrationName(name: string): boolean {
  const lower = name.toLowerCase();
  // __FOO__ style (APOLLO_STATE, INITIAL_STATE, NEXT_DATA, etc.)
  if (/__[a-z_]+__/i.test(name)) return true;
  // Dotted paths on namespaces we care about.
  if (name.includes(".")) {
    const lastPart = name.split(".").pop() ?? "";
    if (
      /reactcontext|initialstate|preloadedstate|apollostate|propstore|serverdata|serializedserverdata|store|hydrat(ion|edstate)|clientstate|content|pagedata|propsstate|__data__/i.test(
        lastPart,
      )
    ) {
      return true;
    }
    // Catch `window.netflix` / `window.apple` / etc. style top-level
    // assignments we want to skip.
    if (/^window$/i.test(name.split(".")[0]) && !/reactcontext/i.test(lower)) {
      return false;
    }
    return false;
  }
  // Bare identifiers we specifically want to catch.
  return /^(?:initialstate|preloadedstate|apollostate|propstore|serverdata|pagedata)$/i.test(
    name,
  );
}

/** Extract the first balanced `{...}` or `[...]` literal starting at
 *  the given position in `src`, respecting JSON string escapes. */
function extractBalancedLiteral(src: string, start: number): string | null {
  if (start < 0 || start >= src.length) return null;
  const open = src[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (c === "\\") {
      escapeNext = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
