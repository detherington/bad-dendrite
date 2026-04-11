/** Netflix Tudum scraper.
 *
 *  Tudum is Netflix's own editorial site. The /new-on-netflix URL
 *  redirects to whichever month-specific article is current (e.g.
 *  "New on Netflix in April 2026"). Tudum is a React + Apollo GraphQL
 *  app, NOT Next.js — so the hydration payload lives in something
 *  like `window.__APOLLO_STATE__` or a similar state-assignment script,
 *  not in `<script id="__NEXT_DATA__">`.
 *
 *  Rather than guess the exact script pattern, we use the shared
 *  `scanScriptsForJsonPayloads` helper which tries every plausible
 *  extractor (typed JSON scripts, plain-JSON scripts, inline
 *  `window.__FOO__ = { ... };` assignments) against every
 *  `<script>` tag on the page. Anything that parses is fed through
 *  `walkForTitleDatePairs()`, which finds nested objects with
 *  `{ title, releaseDate }` pairs regardless of the surrounding
 *  schema. */

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
    scriptInventory: [],
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

  // Always populate the script inventory for diagnostics.
  diagnostic.scriptInventory = inventoryScripts(root);

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

  // ---- Strategy 2: aggressive <script> scan ------------------------------
  // Try every plausible JSON-payload extractor against every script tag.
  // Capture the first payload that produces any title/date pairs in the
  // diagnostics so we can inspect the source when items look wrong.
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
        providerId: NETFLIX_PROVIDER_ID,
        mediaType: item.mediaType,
        source: SOURCE,
        sourceUrl: TUDUM_URL,
      });
    }
  }
  if (scannedMatches > 0) {
    diagnostic.parseStrategy = diagnostic.parseStrategy
      ? `${diagnostic.parseStrategy}+script-scan(${firstMatchingPayload})`
      : `script-scan(${firstMatchingPayload})`;
  }

  const deduped = dedupeReleases(releases);
  diagnostic.itemsFound = deduped.length;
  diagnostic.samples = deduped.slice(0, 5).map((r) => ({
    title: r.title,
    releaseDate: r.releaseDate,
    mediaType: r.mediaType,
  }));

  return { releases: deduped, diagnostics: [diagnostic] };
}

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
