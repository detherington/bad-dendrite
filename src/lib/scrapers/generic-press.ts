/** Generic streamer press-page scraper.
 *
 *  Used by the Disney+, Max, Apple TV+, Prime Video, Peacock, and Hulu
 *  scrapers. Each streamer only configures its URL list and a few
 *  site-specific hints; the heavy lifting (HTML fetch, JSON-LD, heading
 *  + date heuristic) lives here. This keeps per-site code minimal and
 *  lets us iterate the parsing strategies in one place.
 *
 *  Parse strategy order, per URL:
 *    1. JSON-LD schema.org Movie/TVSeries entities on the page.
 *    2. Heuristic walk: find headings that parse as dates, then attach
 *       following list items / title-like nodes to the most recent
 *       date until the next date-heading appears. */

import { parseFreeformDate } from "./date-parse";
import { fetchHtml, parseDocument } from "./fetch";
import {
  extractJsonLdEntities,
  mediaTypeFromJsonLdType,
} from "./json-ld";
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
  };

  const fetchResult = await fetchHtml(url);
  diagnostic.httpStatus = fetchResult.status;
  diagnostic.htmlBytes = fetchResult.bytes;
  if (!fetchResult.ok) {
    diagnostic.error = fetchResult.error ?? "fetch failed";
    return { releases: [], diagnostics: [diagnostic] };
  }
  diagnostic.fetched = true;

  const root = parseDocument(fetchResult.html);
  const releases: ScrapedRelease[] = [];
  const defaultMediaType = spec.defaultMediaType ?? "unknown";

  // ---- Strategy 1: JSON-LD ------------------------------------------------
  const jsonLdEntities = extractJsonLdEntities(root);
  for (const entity of jsonLdEntities) {
    if (!entity.name || !entity.releaseDate) continue;
    const mediaType = mediaTypeFromJsonLdType(entity.type);
    // Press sites sometimes publish Event entities for premieres; if
    // the type doesn't map cleanly, fall back to the spec's default.
    const effectiveMediaType =
      mediaType !== "unknown" ? mediaType : defaultMediaType;
    releases.push({
      title: entity.name,
      year: entity.year,
      releaseDate: entity.releaseDate,
      providerId: spec.providerId,
      mediaType: effectiveMediaType,
      source: spec.source,
      sourceUrl: entity.url ?? url,
    });
  }
  if (releases.length > 0) diagnostic.parseStrategy = "json-ld";

  // ---- Strategy 2: heading + date heuristic ------------------------------
  if (releases.length === 0) {
    const nodes = root.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,p,li,div[class*='date' i],time",
    );
    let currentDate: string | null = null;
    for (const node of nodes) {
      const text = node.text.trim();
      if (!text || text.length > 240) continue;

      // A `time` element with a datetime attribute is the most reliable
      // signal — trust it as-is.
      if (node.tagName === "TIME") {
        const dt = node.getAttribute("datetime");
        const ymd = parseFreeformDate(dt || text);
        if (ymd) {
          currentDate = ymd;
          continue;
        }
      }

      // Plain text dates: "May 12, 2026", "Friday, May 12", etc.
      const ymd = parseFreeformDate(text);
      if (
        ymd &&
        /[a-z]/i.test(text) &&
        text.length < 80 &&
        /\d/.test(text)
      ) {
        currentDate = ymd;
        continue;
      }

      if (!currentDate) continue;

      // Candidate title nodes: headings and list items that contain
      // enough text to look like a title but not so much that they're
      // paragraphs of description.
      const isHeadingOrLi =
        node.tagName === "H2" ||
        node.tagName === "H3" ||
        node.tagName === "H4" ||
        node.tagName === "H5" ||
        node.tagName === "LI";
      if (!isHeadingOrLi) continue;
      if (text.length < 2 || text.length > 120) continue;

      // Skip obvious non-titles: sentences ending with a period, nav
      // labels, calls-to-action.
      if (/\.\s*$/.test(text)) continue;
      if (/^(read more|watch now|coming soon|learn more|subscribe)$/i.test(text)) continue;

      // Strip trailing " — Series" / "(Movie)" etc to normalise titles.
      const title = text
        .replace(/\s*[—\-–]\s*(movie|series|limited series|film|special|documentary)\s*$/i, "")
        .trim();
      if (!title) continue;

      const mediaTypeHint = /series|season|episodes?/i.test(text)
        ? "tv"
        : /film|movie|documentary/i.test(text)
          ? "movie"
          : defaultMediaType;

      releases.push({
        title,
        releaseDate: currentDate,
        providerId: spec.providerId,
        mediaType: mediaTypeHint,
        source: spec.source,
        sourceUrl: url,
      });
    }
    if (releases.length > 0) {
      diagnostic.parseStrategy = diagnostic.parseStrategy
        ? `${diagnostic.parseStrategy}+headings`
        : "headings";
    }
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
