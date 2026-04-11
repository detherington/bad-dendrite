/** Shared types for the streamer "coming soon" scrapers.
 *
 *  Each scraper fetches an official or semi-official source page (Netflix
 *  Tudum, Disney+ press, Max press, Apple TV+ coming-soon, etc.) and
 *  returns a list of ScrapedRelease records describing what's scheduled
 *  to be added to the service in the near future. The orchestrator in
 *  `./index.ts` runs all scrapers in parallel and merges the results
 *  into the same candidate pipeline that TMDB and TVmaze feed. */

export type ScrapedMediaType = "movie" | "tv" | "unknown";

export interface ScrapedRelease {
  /** Title as it appears on the source page. Will be TMDB-searched
   *  downstream to resolve the canonical id. */
  title: string;
  /** First-release year hint from the source, if known. Dramatically
   *  improves TMDB search precision when present. */
  year?: number;
  /** Scheduled release date on the streamer, YYYY-MM-DD. */
  releaseDate: string;
  /** TMDB provider id this scraper is attributed to (Netflix=8, etc.). */
  providerId: number;
  /** Hint from the source ("movie" vs "tv"). Unknown means both
   *  /search/movie and /search/tv are tried. */
  mediaType: ScrapedMediaType;
  /** Which scraper produced the record — used for diagnostics. */
  source: string;
  /** Absolute URL of the source page (used for debugging). */
  sourceUrl?: string;
}

export interface ScraperDiagnostic {
  source: string;
  providerId: number;
  url: string;
  /** Was the HTTP fetch successful? */
  fetched: boolean;
  httpStatus: number | null;
  /** How many ScrapedRelease records came out of this scraper. */
  itemsFound: number;
  /** Human-readable error message if fetch or parse failed. */
  error: string | null;
  /** First 5 scraped titles + dates, for eyeballing in the debug
   *  endpoint. */
  samples: Array<{ title: string; releaseDate: string; mediaType: ScrapedMediaType }>;
  /** Which parse strategy actually produced results. Scrapers try
   *  several strategies (JSON-LD, heading + date, fall back to regex)
   *  and record which one succeeded here. */
  parseStrategy: string | null;
  /** HTML size in bytes, so we can tell whether the page was blocked
   *  (small body, e.g. Cloudflare challenge) or fetched normally. */
  htmlBytes: number;
  /** First ~2000 chars of the fetched HTML, for eyeballing in the debug
   *  endpoint when a scraper returns zero items despite a successful
   *  fetch. Lets us confirm the page structure without needing to
   *  reproduce the request locally. */
  fetchedHtmlSample: string | null;
  /** First ~2000 chars of the `__NEXT_DATA__` JSON payload if present
   *  on the page (Netflix Tudum is a Next.js site and puts article
   *  content there). null when the page isn't Next.js. */
  nextDataSample: string | null;
}

export interface ScraperResult {
  releases: ScrapedRelease[];
  diagnostics: ScraperDiagnostic[];
}

/** Signature every scraper in this directory must implement. */
export type Scraper = () => Promise<ScraperResult>;
