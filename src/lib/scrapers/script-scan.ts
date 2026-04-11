/** Generic `<script>`-tag scanner.
 *
 *  Site-specific scrapers kept missing the data because every streamer
 *  uses a different hydration mechanism: Next.js has `__NEXT_DATA__`,
 *  Apollo has `window.__APOLLO_STATE__`, SvelteKit has
 *  `<script data-sveltekit-*>`, older React SSR apps used the
 *  `__INITIAL_STATE__` / `__PRELOADED_STATE__` pattern, and Apple
 *  used to use shoebox but has moved to SvelteKit. Rather than add a
 *  per-site pattern every time, this module does two things:
 *
 *    1. `inventoryScripts` enumerates every `<script>` tag with
 *       non-trivial content, so the debug endpoint shows the exact
 *       inventory of a page (id, type, size, first 150 chars of
 *       content). Lets us see what's available without having to
 *       reproduce the request.
 *
 *    2. `scanScriptsForJsonPayloads` tries every plausible extraction
 *       strategy against every script tag and returns a list of
 *       parsed JSON objects. The caller feeds each into
 *       `walkForTitleDatePairs()`. Strategies, in order:
 *         a) type="application/json" or "application/ld+json" — parse
 *            directly.
 *         b) No type (plain inline JS) — regex-extract any
 *            `window.__FOO__ = { ... };` object literal and try
 *            JSON.parse. JavaScript object literals aren't always
 *            valid JSON (unquoted keys, trailing commas), but most
 *            SSR hydration payloads are stringified JSON.parse'd
 *            back, so the object literal IS valid JSON.
 *         c) Plain JSON object/array starting at position 0 — parse
 *            directly. */

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
    if (raw.length < 50) continue; // skip tiny analytics pings
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

/** Extract every parseable JSON payload from the page's <script> tags.
 *  Returns an array of (parsed, source) pairs so the caller can tell
 *  which strategy produced which hit — useful for diagnostics. */
export function scanScriptsForJsonPayloads(root: HTMLElement): Array<{
  value: unknown;
  source: string;
}> {
  const out: Array<{ value: unknown; source: string }> = [];
  const scripts = root.querySelectorAll("script");

  for (const script of scripts) {
    const raw = script.rawText;
    if (!raw || raw.length < 50) continue;
    const type = script.getAttribute("type") ?? "";
    const id = script.getAttribute("id") ?? "";

    // Strategy a: typed JSON script.
    if (type === "application/json" || type === "application/ld+json") {
      const parsed = safeJsonParse(raw);
      if (parsed != null) {
        out.push({ value: parsed, source: `typed-json${id ? `:${id}` : ""}` });
        continue;
      }
    }

    // Strategy c: plain JSON at position 0 (Apollo sometimes does this
    // with no type attribute).
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = safeJsonParse(trimmed);
      if (parsed != null) {
        out.push({ value: parsed, source: `raw-json${id ? `:${id}` : ""}` });
        continue;
      }
    }

    // Strategy b: inline state assignment(s). One script can contain
    // several (e.g. `window.__APOLLO_STATE__ = {...}; window.__ENV__ = {...};`),
    // so we loop over the regex matches.
    const assignRegex =
      /(?:window|self|globalThis)\s*\.\s*(__[A-Z0-9_]+__|[A-Za-z_$][\w$]*)\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = assignRegex.exec(raw)) !== null) {
      const varName = match[1];
      // Only recognise well-known hydration variable names to avoid
      // pulling in random window assignments from analytics, etc.
      if (!/^(?:__[A-Z_]+__|initialState|preloadedState|__APOLLO_STATE__)$/i.test(varName)) {
        continue;
      }
      const parsed = safeJsonParse(match[2]);
      if (parsed != null) {
        out.push({ value: parsed, source: `window.${varName}` });
      }
    }
  }
  return out;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
