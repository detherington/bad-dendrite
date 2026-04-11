/** JSON-LD extraction — the most reliable way to scrape a press /
 *  marketing page, since it's the schema.org data search engines
 *  consume. When a site has good JSON-LD we can pull titles + release
 *  dates with almost zero site-specific HTML wrangling. */

import type { HTMLElement } from "node-html-parser";

/** One entity we recognise from a JSON-LD block. */
export interface JsonLdEntity {
  /** e.g. "Movie", "TVSeries", "TVSeason", "TVEpisode", "CreativeWork",
   *  "Event", "BroadcastEvent". */
  type: string;
  name?: string;
  /** YYYY-MM-DD, normalised from whatever date field the entity carries
   *  (datePublished, startDate, dateCreated, etc.). */
  releaseDate?: string;
  year?: number;
  url?: string;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normaliseType(rawType: unknown): string | null {
  if (typeof rawType !== "string") return null;
  // Schema.org @type can come back as "Movie" or as a URL like
  // "https://schema.org/Movie" — normalise to the local part.
  const parts = rawType.split("/").pop();
  return parts ?? rawType;
}

function normaliseDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Accept ISO-ish strings like "2026-05-12", "2026-05-12T00:00:00Z",
  // "2026/05/12", or plain date words like "May 12 2026".
  const iso = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(raw.trim());
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function normaliseYear(raw: unknown, fallbackDate?: string): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const m = /(\d{4})/.exec(raw);
    if (m) return parseInt(m[1], 10);
  }
  if (fallbackDate) {
    const m = /^(\d{4})/.exec(fallbackDate);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

/** Walk a single JSON-LD object (possibly an @graph container) and
 *  yield every nested entity that looks like a CreativeWork. */
function* walkEntities(node: unknown): Generator<Record<string, unknown>> {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    for (const child of obj["@graph"] as unknown[]) {
      yield* walkEntities(child);
    }
    return;
  }
  if (obj["@type"]) {
    yield obj;
  }
  // Some press sites nest items inside itemListElement arrays.
  if (Array.isArray(obj.itemListElement)) {
    for (const el of obj.itemListElement) {
      if (el && typeof el === "object") {
        const maybeItem = (el as Record<string, unknown>).item ?? el;
        yield* walkEntities(maybeItem);
      }
    }
  }
}

/** Extract every JSON-LD entity from a parsed HTML document. */
export function extractJsonLdEntities(root: HTMLElement): JsonLdEntity[] {
  const entities: JsonLdEntity[] = [];
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    const raw = script.rawText;
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some sites embed multiple JSON-LD blocks separated by commas
      // (technically invalid). Try the "array wrap" trick.
      try {
        parsed = JSON.parse(`[${raw}]`);
      } catch {
        continue;
      }
    }
    for (const candidate of asArray(parsed)) {
      for (const entity of walkEntities(candidate)) {
        const type = normaliseType(entity["@type"]);
        if (!type) continue;
        const name = typeof entity.name === "string" ? entity.name : undefined;
        const releaseDate =
          normaliseDate(entity.datePublished) ||
          normaliseDate(entity.dateCreated) ||
          normaliseDate(entity.startDate) ||
          normaliseDate(entity.uploadDate) ||
          undefined;
        const year = normaliseYear(entity.copyrightYear, releaseDate);
        const url = typeof entity.url === "string" ? entity.url : undefined;
        entities.push({
          type,
          name,
          releaseDate: releaseDate ?? undefined,
          year,
          url,
        });
      }
    }
  }
  return entities;
}

/** Map a schema.org @type to our movie/tv discriminator. */
export function mediaTypeFromJsonLdType(
  type: string,
): "movie" | "tv" | "unknown" {
  const lower = type.toLowerCase();
  if (lower === "movie") return "movie";
  if (
    lower === "tvseries" ||
    lower === "tvseason" ||
    lower === "tvepisode" ||
    lower === "televisionseries"
  ) {
    return "tv";
  }
  return "unknown";
}
