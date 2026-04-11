/** Generic streamer press-page scraper.
 *
 *  Used by the Disney+, Max, Apple TV+, Prime Video, Peacock, and Hulu
 *  scrapers. Each streamer only configures its URL list; the fetch +
 *  JSON-LD parse lives here.
 *
 *  Design note: an earlier version of this file also ran a
 *  "heading + date" DOM heuristic as a fallback. In practice that
 *  heuristic picked up press-release headlines and publish dates on
 *  press sites instead of actual release schedules (e.g. it returned
 *  "ESPN Continues Global Expansion on Disney+" dated 2026-04-08 — the
 *  press article title and publish date, not a release). We've removed
 *  the fallback entirely: either the page has schema.org data we can
 *  trust, or we report 0 items and the debug endpoint surfaces the
 *  HTML sample so we can tune. */

import { fetchHtml, parseDocument } from "./fetch";
import {
  extractJsonLdEntities,
  mediaTypeFromJsonLdType,
} from "./json-ld";
import { walkForTitleDatePairs } from "./json-walk";
import {
  inventoryScripts,
  scanScriptsForJsonPayloads,
} from "./script-scan";
import type { ScrapedRelease, ScraperDiagnostic, ScraperResult } from "./types";

export interface GenericPressSpec {
  /** Source name, e.g. "disney-press". Used in diagnostics. */
  source: string;
  /** TMDB provider id this scraper is attributed to. */
  providerId: number;
  /** One or more URLs to scrape. Results are merged and deduped by
   *  (title, releaseDate). Use multiple when a streamer splits its
   *  coming-soon info across several pages. */
  urls: ReadonlyArray<string>;
  /** Optional hint so we don't have to guess media type from text.
   *  "movie" / "tv" / "unknown". Defaults to "unknown". */
  defaultMediaType?: "movie" | "tv" | "unknown";
}

export async function scrapeGenericPress(
  spec: GenericPressSpec,
): Promise<ScraperResult> {
  const results = await Promise.all(
    spec.urls.map((url) => scrapeOne(spec, url)),
  );
  const releases = dedupe(results.flatMap((r) => r.releases));
  const diagnostics = results.flatMap((r) => r.diagnostics);
  return { releases, diagnostics };
}

async function scrapeOne(
  spec: GenericPressSpec,
  url: string,
): Promise<ScraperResult> {
  const diagnostic: ScraperDiagnostic = {
    source: spec.source,
    providerId: spec.providerId,
    url,
    fetched: false,
    httpStatus: null,
    itemsFound: 0,
    error: null,
    samples: [],
    parseStrategy: null,
    htmlBytes: 0,
    fetchedHtmlSample: null,
    nextDataSample: null,
    scriptInventory: [],
  };

  const fetchResult = await fetchHtml(url);
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
  diagnostic.scriptInventory = inventoryScripts(root);
  const releases: ScrapedRelease[] = [];
  const defaultMediaType = spec.defaultMediaType ?? "unknown";

  // ---- Strategy 1: JSON-LD -----------------------------------------------
  const jsonLdEntities = extractJsonLdEntities(root);
  for (const entity of jsonLdEntities) {
    if (!entity.name || !entity.releaseDate) continue;
    const mediaType = mediaTypeFromJsonLdType(entity.type);
    // Only accept Movie / TVSeries / TVSeason entities from JSON-LD.
    // Press sites emit NewsArticle / Article / BlogPosting entities
    // that would pollute the candidate pool with press release titles.
    if (mediaType === "unknown") continue;
    releases.push({
      title: entity.name,
      year: entity.year,
      releaseDate: entity.releaseDate,
      providerId: spec.providerId,
      mediaType: mediaType,
      source: spec.source,
      sourceUrl: entity.url ?? url,
    });
  }
  if (releases.length > 0) diagnostic.parseStrategy = "json-ld";

  // ---- Strategy 2: aggressive <script> scan -----------------------------
  // Run the same brute-force scanner used by Netflix Tudum and Apple TV
  // against every script tag on the page. Any parseable JSON payload
  // goes through walkForTitleDatePairs, which finds nested objects
  // carrying {title, releaseDate} pairs regardless of the surrounding
  // schema. Covers Apollo / Redux / SvelteKit / __NEXT_DATA__ / custom
  // hydration.
  const payloads = scanScriptsForJsonPayloads(root);
  let firstMatchingPayload: string | null = null;
  let scannedMatches = 0;
  for (const { value, source } of payloads) {
    const items = walkForTitleDatePairs(value);
    if (items.length === 0) continue;
    if (!firstMatchingPayload) {
      firstMatchingPayload = source;
      try {
        diagnostic.nextDataSample = JSON.stringify(value).slice(0, 2000);
      } catch {
        /* ignore */
      }
    }
    scannedMatches += items.length;
    for (const item of items) {
      releases.push({
        title: item.title,
        year: item.year,
        releaseDate: item.releaseDate,
        providerId: spec.providerId,
        mediaType:
          item.mediaType !== "unknown" ? item.mediaType : defaultMediaType,
        source: spec.source,
        sourceUrl: url,
      });
    }
  }
  if (scannedMatches > 0) {
    diagnostic.parseStrategy = diagnostic.parseStrategy
      ? `${diagnostic.parseStrategy}+script-scan(${firstMatchingPayload})`
      : `script-scan(${firstMatchingPayload})`;
  }

  diagnostic.itemsFound = releases.length;
  diagnostic.samples = releases.slice(0, 5).map((r) => ({
    title: r.title,
    releaseDate: r.releaseDate,
    mediaType: r.mediaType,
  }));
  return { releases, diagnostics: [diagnostic] };
}

/** Dedupe by (normalised title, releaseDate) so we don't carry the
 *  same title across multiple URLs on the same streamer. */
function dedupe(list: ScrapedRelease[]): ScrapedRelease[] {
  const seen = new Set<string>();
  const out: ScrapedRelease[] = [];
  for (const r of list) {
    const key = `${normalise(r.title)}::${r.releaseDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
