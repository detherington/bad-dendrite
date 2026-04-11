/** Apple TV+ "Coming to Apple TV+" room scraper.
 *
 *  Apple TV's web app at tv.apple.com is a React SPA, but each "room"
 *  URL (a curated list) is server-rendered for SEO by embedding the
 *  underlying API response as one or more JSON `shoebox` scripts in
 *  the initial HTML. Apple's shoebox pattern looks like:
 *
 *    <script type="fastboot/shoebox" id="shoebox-uts-api-cache-..."">
 *      { ... JSON payload ... }
 *    </script>
 *
 *  Depending on the page, the payload is either plain JSON or a
 *  `{"d":{"data":{...}}}` wrapper around the actual API response.
 *  Both are handled by recursively walking the tree for `{title,
 *  releaseDate}` pairs — Apple's canonical content schema uses
 *  `title` and `releaseDate` (YYYY-MM-DD), which the shared walker
 *  already knows about.
 *
 *  URL: the "Coming to Apple TV+" room. The id is stable because it's
 *  Apple's editorial slot for the rolling upcoming list. If Apple ever
 *  rebrands the room, the id changes and we update this constant. */

import { fetchHtml, parseDocument } from "./fetch";
import { extractJsonLdEntities, mediaTypeFromJsonLdType } from "./json-ld";
import { walkForTitleDatePairs } from "./json-walk";
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

  // ---- Strategy 1: JSON-LD (Apple sometimes emits schema.org blocks) ----
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

  // ---- Strategy 2: shoebox scripts ---------------------------------------
  // Find every <script> whose id starts with "shoebox". Each of these
  // carries a JSON cache of an Apple API response — parse and walk.
  const shoeboxScripts = root.querySelectorAll('script[id^="shoebox"]');
  let shoeboxMatched = 0;
  for (const script of shoeboxScripts) {
    const raw = script.rawText;
    if (!raw || raw.length < 10) continue;
    // Capture the first non-empty shoebox script for diagnostics.
    if (!diagnostic.nextDataSample) {
      diagnostic.nextDataSample = raw.slice(0, 2000);
    }
    const parsed = safeJsonParse(raw);
    if (!parsed) continue;
    const items = walkForTitleDatePairs(parsed);
    shoeboxMatched += items.length;
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
  if (shoeboxMatched > 0) {
    diagnostic.parseStrategy = diagnostic.parseStrategy
      ? `${diagnostic.parseStrategy}+shoebox`
      : "shoebox";
  }

  // ---- Strategy 3: any <script type="application/json"> ------------------
  // Fallback catch-all for initial-data blobs Apple may emit under a
  // different id/type than "shoebox". We only run this if the shoebox
  // pass found nothing, to avoid duplicating the same data.
  if (shoeboxMatched === 0) {
    const jsonScripts = root.querySelectorAll('script[type="application/json"]');
    for (const script of jsonScripts) {
      const raw = script.rawText;
      if (!raw || raw.length < 10) continue;
      const parsed = safeJsonParse(raw);
      if (!parsed) continue;
      const items = walkForTitleDatePairs(parsed);
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
      if (items.length > 0 && !diagnostic.nextDataSample) {
        diagnostic.nextDataSample = raw.slice(0, 2000);
      }
    }
    if (releases.length > 0 && !diagnostic.parseStrategy) {
      diagnostic.parseStrategy = "application-json";
    }
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

// Shoebox content is typically plain JSON, but Apple wraps some caches
// in an outer `{"d": ...}` envelope and occasionally HTML-escapes
// quotes. Try the raw string first, then retry with entity-decoded
// content.
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(decodeEntities(raw));
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
