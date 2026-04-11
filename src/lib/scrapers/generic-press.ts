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
import { inventoryScripts } from "./script-scan";
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

  // ---- JSON-LD (the only strategy we trust on press pages) -------------
  const jsonLdEntities = extractJsonLdEntities(root);
  for (const entity of jsonLdEntities) {
    if (!entity.name || !entity.releaseDate) continue;
    const mediaType = mediaTypeFromJsonLdType(entity.type);
    // Only accept Movie / TVSeries / TVSeason entities. Press sites
    // have lots of NewsArticle / Article / BlogPosting entities that
    // would pollute the candidate pool with press release headlines.
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

  // Capture __NEXT_DATA__ sample for debugging (helps tune scrapers for
  // Next.js-backed press sites where the real content lives in a JSON
  // blob rather than rendered HTML).
  const nextDataScript = root.querySelector('script#__NEXT_DATA__');
  if (nextDataScript?.rawText) {
    diagnostic.nextDataSample = nextDataScript.rawText.slice(0, 2000);
  }

  // `defaultMediaType` is unused now that the heuristic is gone; keep
  // it on the spec for future strategies and silence the lint.
  void defaultMediaType;

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
