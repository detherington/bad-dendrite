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
import { walkForTitleDatePairs } from "./json-walk";
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
