/** Apple TV+ "Coming to Apple TV+" room scraper.
 *
 *  tv.apple.com is now built with SvelteKit (HTML comments from the
 *  last debug run show `HEAD_svelte-*` markers, not the old shoebox
 *  Ember stack). Rather than guess at Svelte's hydration format, we
 *  use the shared `scanScriptsForJsonPayloads` helper which brute-
 *  forces every `<script>` tag on the page and feeds any successful
 *  JSON.parse through `walkForTitleDatePairs()`.
 *
 *  URL: the "Coming to Apple TV+" room. The id is stable because it's
 *  Apple's editorial slot for the rolling upcoming list. If Apple ever
 *  rebrands the room, the id changes and we update this constant. */

import { fetchHtml, parseDocument } from "./fetch";
import { extractJsonLdEntities, mediaTypeFromJsonLdType } from "./json-ld";
import { walkForTitleDatePairs } from "./json-walk";
import {
  inventoryScripts,
  scanScriptsForJsonPayloads,
} from "./script-scan";
import type { ScrapedRelease, ScraperDiagnostic, ScraperResult } from "./types";

const SOURCE = "apple-tv-coming";
const APPLE_PROVIDER_ID = 350;
const ROOM_URL =
  "https://tv.apple.com/us/room/coming-to-apple-tv/edt.item.634859dd-55a5-44a0-91d5-f9ec0d181bae";

export async function scrapeAppleTv(): Promise<ScraperResult> {
  const diagnostic: ScraperDiagnostic = {
    source: SOURCE,
    providerId: APPLE_PROVIDER_ID,
    url: ROOM_URL,
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

  const fetchResult = await fetchHtml(ROOM_URL);
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
      providerId: APPLE_PROVIDER_ID,
      mediaType,
      source: SOURCE,
      sourceUrl: entity.url ?? ROOM_URL,
    });
  }
  if (releases.length > 0) diagnostic.parseStrategy = "json-ld";

  // ---- Strategy 2: aggressive <script> scan ------------------------------
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
        providerId: APPLE_PROVIDER_ID,
        mediaType: item.mediaType,
        source: SOURCE,
        sourceUrl: ROOM_URL,
      });
    }
  }
  if (scannedMatches > 0) {
    diagnostic.parseStrategy = diagnostic.parseStrategy
      ? `${diagnostic.parseStrategy}+script-scan(${firstMatchingPayload})`
      : `script-scan(${firstMatchingPayload})`;
  }

  const deduped = dedupe(releases);
  diagnostic.itemsFound = deduped.length;
  diagnostic.samples = deduped.slice(0, 5).map((r) => ({
    title: r.title,
    releaseDate: r.releaseDate,
    mediaType: r.mediaType,
  }));
  return { releases: deduped, diagnostics: [diagnostic] };
}

function dedupe(list: ScrapedRelease[]): ScrapedRelease[] {
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
