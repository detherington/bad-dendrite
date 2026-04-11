/** Netflix Tudum scraper.
 *
 *  Netflix's own editorial site (netflix.com/tudum) publishes monthly
 *  "Coming to Netflix" articles. The main landing page at
 *  /tudum/articles/new-on-netflix redirects to or renders whichever
 *  article is current. Tudum is built on Next.js, so the article
 *  content is present in the page as a serialised `__NEXT_DATA__`
 *  blob — even when the rendered HTML doesn't expose a clean
 *  schema.org outline.
 *
 *  Parse strategies, in order:
 *    1. JSON-LD entities (Movie / TVSeries).
 *    2. __NEXT_DATA__ JSON tree walk: find every nested object that
 *       carries a plausible `{ title, releaseDate }` pair. This is how
 *       we get the actual editorial list of upcoming titles.
 *
 *  Diagnostics capture:
 *    - `fetchedHtmlSample`: first 2000 chars of the raw HTML.
 *    - `nextDataSample`: first 2000 chars of the parsed __NEXT_DATA__
 *      payload (when present). The next debug run will show exactly
 *      what shape Tudum uses so we can tighten the extractor. */

import { fetchHtml, parseDocument } from "./fetch";
import {
  extractJsonLdEntities,
  mediaTypeFromJsonLdType,
} from "./json-ld";
import type { ScrapedRelease, ScraperDiagnostic, ScraperResult } from "./types";

const SOURCE = "netflix-tudum";
const NETFLIX_PROVIDER_ID = 8;
const TUDUM_URL = "https://www.netflix.com/tudum/articles/new-on-netflix";

export async function scrapeNetflixTudum(): Promise<ScraperResult> {
  const diagnostic: ScraperDiagnostic = {
    source: SOURCE,
    providerId: NETFLIX_PROVIDER_ID,
    url: TUDUM_URL,
    fetched: false,
    httpStatus: null,
    itemsFound: 0,
    error: null,
    samples: [],
    parseStrategy: null,
    htmlBytes: 0,
    fetchedHtmlSample: null,
    nextDataSample: null,
  };

  const fetchResult = await fetchHtml(TUDUM_URL);
  diagnostic.httpStatus = fetchResult.status;
  diagnostic.htmlBytes = fetchResult.bytes;
  if (fetchResult.html) {
    diagnostic.fetchedHtmlSample = fetchResult.html.slice(0, 2000);
  }
  if (!fetchResult.ok) {
    diagnostic.error = fetchResult.error ?? "fetch failed";
    return { releases: [], diagnostics: [diagnostic] };
  }
  diagnostic.fetched = true;

  const root = parseDocument(fetchResult.html);
  const releases: ScrapedRelease[] = [];

  // ---- Strategy 1: JSON-LD ------------------------------------------------
  const jsonLdEntities = extractJsonLdEntities(root);
  for (const entity of jsonLdEntities) {
    const mediaType = mediaTypeFromJsonLdType(entity.type);
    if (mediaType === "unknown") continue;
    if (!entity.name || !entity.releaseDate) continue;
    releases.push({
      title: entity.name,
      year: entity.year,
      releaseDate: entity.releaseDate,
      providerId: NETFLIX_PROVIDER_ID,
      mediaType,
      source: SOURCE,
      sourceUrl: entity.url ?? TUDUM_URL,
    });
  }
  if (releases.length > 0) diagnostic.parseStrategy = "json-ld";

  // ---- Strategy 2: __NEXT_DATA__ tree walk -------------------------------
  // Netflix Tudum is a Next.js site. The article body is serialised into
  // a <script id="__NEXT_DATA__"> JSON blob for hydration. We recursively
  // walk the tree looking for objects with a plausible (title, date)
  // pair, which covers most ways Tudum could represent a "coming soon"
  // list regardless of its specific schema.
  const nextDataScript = root.querySelector('script#__NEXT_DATA__');
  if (nextDataScript?.rawText) {
    diagnostic.nextDataSample = nextDataScript.rawText.slice(0, 2000);
    try {
      const parsed = JSON.parse(nextDataScript.rawText);
      const walked = walkForTitleDatePairs(parsed);
      for (const item of walked) {
        releases.push({
          title: item.title,
          year: item.year,
          releaseDate: item.releaseDate,
          providerId: NETFLIX_PROVIDER_ID,
          mediaType: item.mediaType,
          source: SOURCE,
          sourceUrl: TUDUM_URL,
        });
      }
      if (walked.length > 0) {
        diagnostic.parseStrategy = diagnostic.parseStrategy
          ? `${diagnostic.parseStrategy}+next-data`
          : "next-data";
      }
    } catch (err) {
      diagnostic.error = `__NEXT_DATA__ parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  // Dedupe by (normalised title, releaseDate) since both strategies may
  // surface the same entry.
  const deduped = dedupeReleases(releases);

  diagnostic.itemsFound = deduped.length;
  diagnostic.samples = deduped.slice(0, 5).map((r) => ({
    title: r.title,
    releaseDate: r.releaseDate,
    mediaType: r.mediaType,
  }));

  return { releases: deduped, diagnostics: [diagnostic] };
}

// ---------- JSON tree walking ----------

interface WalkedItem {
  title: string;
  releaseDate: string;
  year?: number;
  mediaType: "movie" | "tv" | "unknown";
}

const TITLE_KEYS = new Set([
  "title",
  "name",
  "headline",
  "displayTitle",
  "displayName",
]);

const DATE_KEYS = new Set([
  "releaseDate",
  "availableDate",
  "availableFrom",
  "premiereDate",
  "premiere_date",
  "launchDate",
  "launch_date",
  "airDate",
  "air_date",
  "date",
  "publishedDate",
  "published_at",
  "datePublished",
]);

function pickStringField(obj: Record<string, unknown>, keys: Set<string>): string | null {
  for (const k of Object.keys(obj)) {
    if (!keys.has(k)) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function normaliseDateStringLocal(raw: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function looksLikeTitle(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 2 || trimmed.length > 200) return false;
  // Reject things that look like URLs, slugs, or sentences.
  if (/^https?:\/\//.test(trimmed)) return false;
  if (/\/[a-z0-9-]+\//.test(trimmed) && !/\s/.test(trimmed)) return false;
  return true;
}

function walkForTitleDatePairs(root: unknown): WalkedItem[] {
  const out: WalkedItem[] = [];
  const seen = new Set<unknown>();

  function visit(node: unknown): void {
    if (!node) return;
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const obj = node as Record<string, unknown>;
    const titleRaw = pickStringField(obj, TITLE_KEYS);
    const dateRaw = pickStringField(obj, DATE_KEYS);
    if (titleRaw && dateRaw && looksLikeTitle(titleRaw)) {
      const normalised = normaliseDateStringLocal(dateRaw);
      if (normalised) {
        // Infer media type from any `type`, `contentType`, or
        // `category` field on the same object.
        const typeField =
          pickStringField(obj, new Set(["type", "contentType", "category", "__typename"]))
            ?.toLowerCase() ?? "";
        const mediaType: "movie" | "tv" | "unknown" =
          /series|season|episode|show/.test(typeField)
            ? "tv"
            : /movie|film|feature/.test(typeField)
              ? "movie"
              : "unknown";
        out.push({
          title: titleRaw,
          releaseDate: normalised,
          mediaType,
          year: parseInt(normalised.slice(0, 4), 10) || undefined,
        });
      }
    }

    for (const key of Object.keys(obj)) visit(obj[key]);
  }

  visit(root);
  return out;
}

// ---------- Dedupe ----------

function dedupeReleases(list: ScrapedRelease[]): ScrapedRelease[] {
  const seen = new Set<string>();
  const out: ScrapedRelease[] = [];
  for (const r of list) {
    const key = `${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}::${r.releaseDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
