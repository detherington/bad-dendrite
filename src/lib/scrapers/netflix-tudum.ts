/** Netflix Tudum scraper — parses the weekly "Coming to Netflix" article
 *  at netflix.com/tudum/articles/new-on-netflix to get scheduled Netflix
 *  additions. This is Netflix's own editorial source of truth and gets
 *  updated throughout the month.
 *
 *  Parse strategies, in order:
 *    1. JSON-LD entities on the article page (schema.org Article +
 *       optional itemList).
 *    2. Text pattern matching: repeating "Month Day, Year" headers
 *       followed by title lines, which is how Tudum structures the
 *       editorial copy when React is server-rendered for SEO.
 *
 *  If both strategies return zero items, diagnostics.parseStrategy stays
 *  null and the caller can see that we need site-specific tuning. */

import { parseFreeformDate } from "./date-parse";
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
  };

  const fetchResult = await fetchHtml(TUDUM_URL);
  diagnostic.httpStatus = fetchResult.status;
  diagnostic.htmlBytes = fetchResult.bytes;
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

  // ---- Strategy 2: heading + title text heuristic ------------------------
  // Tudum's "new on Netflix" editorial copy follows a repeating pattern:
  //
  //     <h2>Coming to Netflix on <Weekday>, <Month> <Day></h2>
  //     <h3><em>Title</em> — (Movie / Series / Limited Series)</h3>
  //     ...
  //
  // We walk the article body in document order and, every time we
  // encounter a heading that parses as a date, attribute all following
  // title-like headings to that date until we see the next one.
  if (releases.length === 0) {
    const article =
      root.querySelector("article") ||
      root.querySelector('[data-uia="article-body"]') ||
      root;
    const nodes = article.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li");

    let currentDate: string | null = null;
    for (const node of nodes) {
      const text = node.text.trim();
      if (!text) continue;

      // Is this heading a date? Try two forms: "Coming to Netflix on
      // Friday, May 12" (inline prefix) and a bare "Friday, May 12".
      const dateMatch =
        /\b(coming to netflix on|available (?:on )?|premier(?:e|ing) on|launch(?:es|ing)? on)\s+([a-z]+,\s*[a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i.exec(
          text,
        ) ||
        /^((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,\s*[a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i.exec(
          text,
        );
      if (dateMatch) {
        const datePart = dateMatch[dateMatch.length - 1];
        const ymd = parseFreeformDate(datePart);
        if (ymd) {
          currentDate = ymd;
          continue;
        }
      }

      // If we haven't locked a date yet, skip this node.
      if (!currentDate) continue;

      // Look for lines that look like "Title — Movie" / "Title (Series)".
      // Tudum typically wraps the title in <em> or <i> inside the heading.
      const italic =
        node.querySelector("em")?.text?.trim() ||
        node.querySelector("i")?.text?.trim();
      if (!italic) continue;

      const mediaTypeHint = /series|season/i.test(text)
        ? "tv"
        : /film|movie/i.test(text)
          ? "movie"
          : "unknown";

      // Strip trailing "— Series", "(Limited Series)", etc.
      const title = italic
        .replace(/\s*[—\-–]\s*(movie|series|limited series|film|special)\s*$/i, "")
        .trim();
      if (!title) continue;

      releases.push({
        title,
        releaseDate: currentDate,
        providerId: NETFLIX_PROVIDER_ID,
        mediaType: mediaTypeHint,
        source: SOURCE,
        sourceUrl: TUDUM_URL,
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
