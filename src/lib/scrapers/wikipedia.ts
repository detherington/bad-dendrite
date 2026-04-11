/** Wikipedia "List of <streamer> original programming" scraper.
 *
 *  Every streamer's own "coming soon" page turned out to be an SPA
 *  shell that fetches content via an authenticated API after page
 *  load — their server-side HTML has zero show data in it. Scraping
 *  that without running JavaScript is impossible.
 *
 *  Wikipedia, by contrast, maintains:
 *    - Server-rendered HTML
 *    - Curated "Upcoming" sections on every "List of ___ original
 *      programming" / "original films" page
 *    - Clean <table class="wikitable sortable"> markup with
 *      data-sort-value attributes on date cells (YYYYMMDD or
 *      YYYY-MM-DD) so dates are trivially parseable
 *    - Hyperlinked titles in the first column that preserve the
 *      canonical show name
 *
 *  This scraper fetches a set of per-streamer list pages in parallel,
 *  finds the tables under any heading containing "Upcoming", and
 *  extracts {title, releaseDate} rows. Downstream, the existing
 *  in-window filter + TMDB search step converts scraped titles into
 *  TMDB candidates with `verifiedOriginal: true`.
 *
 *  Wikipedia isn't the source of truth — individual pages can be
 *  incomplete or out of date — but it's DRAMATICALLY better than
 *  nothing, and the data actually exists in a parseable form. */

import { parseFreeformDate } from "./date-parse";
import { fetchHtml, parseDocument } from "./fetch";
import { inventoryScripts } from "./script-scan";
import type { HTMLElement } from "node-html-parser";
import type {
  ScrapedMediaType,
  ScrapedRelease,
  ScraperDiagnostic,
  ScraperResult,
} from "./types";

interface WikipediaSource {
  /** Short identifier used in diagnostics (e.g. "netflix-films"). */
  name: string;
  /** Full Wikipedia page URL. */
  url: string;
  /** TMDB provider id to attribute scraped titles to. */
  providerId: number;
  /** Media type hint to pass to TMDB search — improves match quality. */
  mediaType: ScrapedMediaType;
}

const WIKIPEDIA_SOURCES: ReadonlyArray<WikipediaSource> = [
  // Netflix: `List_of_Netflix_original_films` redirects to a plural
  // disambiguation page that only links out to per-year articles.
  // Target the per-year pages directly for the current and next
  // calendar year so the 90-day window is guaranteed to overlap at
  // least one of them.
  {
    name: "wikipedia-netflix-films-2026",
    url: "https://en.wikipedia.org/wiki/List_of_Netflix_original_films_(2026)",
    providerId: 8,
    mediaType: "movie",
  },
  {
    name: "wikipedia-netflix-films-2027",
    url: "https://en.wikipedia.org/wiki/List_of_Netflix_original_films_(2027)",
    providerId: 8,
    mediaType: "movie",
  },
  {
    name: "wikipedia-netflix-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Netflix_original_programming",
    providerId: 8,
    mediaType: "tv",
  },
  // Apple TV+
  {
    name: "wikipedia-apple-tv-films",
    url: "https://en.wikipedia.org/wiki/List_of_Apple_TV%2B_original_films",
    providerId: 350,
    mediaType: "movie",
  },
  {
    name: "wikipedia-apple-tv-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Apple_TV%2B_original_programming",
    providerId: 350,
    mediaType: "tv",
  },
  // Disney+
  {
    name: "wikipedia-disney-films",
    url: "https://en.wikipedia.org/wiki/List_of_Disney%2B_original_films",
    providerId: 337,
    mediaType: "movie",
  },
  {
    name: "wikipedia-disney-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Disney%2B_original_programming",
    providerId: 337,
    mediaType: "tv",
  },
  // Max / HBO Max
  {
    name: "wikipedia-max-films",
    url: "https://en.wikipedia.org/wiki/List_of_Max_original_films",
    providerId: 1899,
    mediaType: "movie",
  },
  {
    name: "wikipedia-max-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Max_original_programming",
    providerId: 1899,
    mediaType: "tv",
  },
  // Amazon Prime Video
  {
    name: "wikipedia-prime-films",
    url: "https://en.wikipedia.org/wiki/List_of_Amazon_Prime_Video_original_films",
    providerId: 9,
    mediaType: "movie",
  },
  {
    name: "wikipedia-prime-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Amazon_Prime_Video_original_programming",
    providerId: 9,
    mediaType: "tv",
  },
  // Hulu
  {
    name: "wikipedia-hulu-films",
    url: "https://en.wikipedia.org/wiki/List_of_Hulu_original_films",
    providerId: 15,
    mediaType: "movie",
  },
  {
    name: "wikipedia-hulu-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Hulu_original_programming",
    providerId: 15,
    mediaType: "tv",
  },
  // Peacock
  {
    name: "wikipedia-peacock-films",
    url: "https://en.wikipedia.org/wiki/List_of_Peacock_original_films",
    providerId: 386,
    mediaType: "movie",
  },
  {
    name: "wikipedia-peacock-programming",
    url: "https://en.wikipedia.org/wiki/List_of_Peacock_original_programming",
    providerId: 386,
    mediaType: "tv",
  },
];

export async function scrapeWikipedia(): Promise<ScraperResult> {
  const results = await Promise.all(
    WIKIPEDIA_SOURCES.map((spec) => scrapeOnePage(spec)),
  );
  const releases = results.flatMap((r) => r.releases);
  const diagnostics = results.flatMap((r) => r.diagnostics);
  return { releases, diagnostics };
}

async function scrapeOnePage(spec: WikipediaSource): Promise<ScraperResult> {
  const diagnostic: ScraperDiagnostic = {
    source: spec.name,
    providerId: spec.providerId,
    url: spec.url,
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

  const fetchResult = await fetchHtml(spec.url);
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

  // Wikipedia wraps article content in `.mw-parser-output`. Prefer
  // that to avoid picking up navigation/footer tables.
  const contentRoot = root.querySelector(".mw-parser-output") ?? root;

  const tables = findUpcomingTables(contentRoot);
  diagnostic.parseStrategy = tables.length > 0 ? `upcoming-tables:${tables.length}` : null;

  const releases: ScrapedRelease[] = [];
  for (const table of tables) {
    releases.push(...parseWikipediaTable(table, spec));
  }

  // If no "Upcoming" heading was found, fall back to walking EVERY
  // wikitable on the page. Downstream date filtering will discard
  // past entries anyway.
  if (releases.length === 0) {
    const allTables = contentRoot.querySelectorAll("table.wikitable");
    for (const table of allTables) {
      releases.push(...parseWikipediaTable(table, spec));
    }
    if (releases.length > 0) diagnostic.parseStrategy = "all-wikitables";
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

/** Walk the `.mw-parser-output` container in document order, tracking
 *  the most recent heading, and return every `table.wikitable` that
 *  appears while we're inside an "Upcoming" section. Uses
 *  querySelectorAll with a combined selector since node-html-parser
 *  returns results in document order. */
function findUpcomingTables(root: HTMLElement): HTMLElement[] {
  const elements = root.querySelectorAll("h2, h3, h4, table");
  const out: HTMLElement[] = [];
  let currentHeading = "";
  for (const el of elements) {
    const tag = el.tagName;
    if (tag && /^H[1-6]$/i.test(tag)) {
      currentHeading = el.text.trim();
      continue;
    }
    if (tag === "TABLE") {
      const classAttr = el.getAttribute("class") ?? "";
      if (!classAttr.includes("wikitable")) continue;
      if (/upcoming/i.test(currentHeading)) {
        out.push(el);
      }
    }
  }
  return out;
}

/** Extract ScrapedReleases from one `<table class="wikitable">`.
 *
 *  Wikipedia tables in these "list of X programming" pages vary a lot
 *  in column layout — some put the date first, some put the title
 *  first, some have caption rows that look like data rows, and some
 *  have genre sub-headers embedded as rows. Rather than assume any
 *  specific column order, we:
 *
 *    1. Find a *title cell* by scanning all cells for an italicised
 *       wiki link (`<td><i><a href="/wiki/...">Title</a></i></td>`),
 *       which is Wikipedia's convention for show/film titles. Fall
 *       back to any italicised text, then any `/wiki/` link. Skip
 *       rows where no cell looks like a title — that drops caption
 *       rows, genre headers, and date-header-only rows.
 *    2. Find a *date cell* by scanning every OTHER cell (never the
 *       title cell) for a `data-sort-value` first, then free-form
 *       date text. Validate dates against a plausible year range so
 *       bogus sort values like "0000-00-00" never propagate.
 *    3. Reject rows where the "title" itself parses as a date — a
 *       sanity check that catches rows where Disney+ put the date
 *       first and the parser somehow promoted it.
 *
 *  Strip citation footnotes like `[1]` everywhere. Cap title length. */
function parseWikipediaTable(
  table: HTMLElement,
  spec: WikipediaSource,
): ScrapedRelease[] {
  const out: ScrapedRelease[] = [];
  const rows = table.querySelectorAll("tr");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.querySelectorAll("td");
    if (cells.length === 0) continue; // header row (only <th>)

    // ---- Find title cell ----
    let titleCell: HTMLElement | null = null;
    let titleText = "";
    // Preference 1: italicised wiki link.
    for (const cell of cells) {
      const italicLink = cell.querySelector('i a[href^="/wiki/"]');
      if (italicLink) {
        const text = italicLink.text.trim();
        if (text.length >= 2) {
          titleCell = cell;
          titleText = text;
          break;
        }
      }
    }
    // Preference 2: any italicised text.
    if (!titleCell) {
      for (const cell of cells) {
        const italic = cell.querySelector("i");
        if (italic) {
          const text = italic.text.trim();
          if (text.length >= 2) {
            titleCell = cell;
            titleText = text;
            break;
          }
        }
      }
    }
    // Preference 3: any /wiki/ link (not pointing to a date page).
    if (!titleCell) {
      for (const cell of cells) {
        const link = cell.querySelector('a[href^="/wiki/"]');
        if (!link) continue;
        const text = link.text.trim();
        if (text.length < 2) continue;
        // Skip links that look like date pages (/wiki/April_15,_2026, etc).
        const href = link.getAttribute("href") ?? "";
        if (/\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(href)) {
          continue;
        }
        titleCell = cell;
        titleText = text;
        break;
      }
    }
    if (!titleCell || !titleText) continue;

    // Clean up: strip `[12]`-style citation footnotes, quoted chars.
    titleText = titleText.replace(/\[[\d\s,]+\]/g, "").trim();
    if (!titleText || titleText.length < 2 || titleText.length > 200) continue;
    // Sanity check: if the "title" parses as a date, it's a header row
    // or a mis-identified cell. Drop it.
    if (parseFreeformDate(titleText)) continue;

    // ---- Find date cell ----
    let releaseDate: string | null = null;
    // Preference 1: any cell (other than the title cell) with a
    // data-sort-value that parses as a valid date.
    for (const cell of cells) {
      if (cell === titleCell) continue;
      const sortNode = cell.querySelector("[data-sort-value]");
      if (!sortNode) continue;
      const val = sortNode.getAttribute("data-sort-value");
      if (!val) continue;
      const parsed = parseSortValue(val);
      if (parsed && isValidDate(parsed)) {
        releaseDate = parsed;
        break;
      }
    }
    // Preference 2: any cell's text content that parses as a free-form
    // date, again excluding the title cell.
    if (!releaseDate) {
      for (const cell of cells) {
        if (cell === titleCell) continue;
        const text = cell.text.replace(/\[[\d\s,]+\]/g, "").trim();
        if (!text || text.length > 120) continue;
        const parsed = parseFreeformDate(text);
        if (parsed && isValidDate(parsed)) {
          releaseDate = parsed;
          break;
        }
      }
    }
    if (!releaseDate) continue;

    out.push({
      title: titleText,
      year: parseInt(releaseDate.slice(0, 4), 10) || undefined,
      releaseDate,
      providerId: spec.providerId,
      mediaType: spec.mediaType,
      source: spec.name,
      sourceUrl: spec.url,
    });
  }
  return out;
}

/** Guard against bogus dates like "0000-00-00" or year 1900. */
function isValidDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const year = parseInt(ymd.slice(0, 4), 10);
  if (year < 2000 || year > 2100) return false;
  const month = parseInt(ymd.slice(5, 7), 10);
  if (month < 1 || month > 12) return false;
  const day = parseInt(ymd.slice(8, 10), 10);
  if (day < 1 || day > 31) return false;
  return true;
}

/** Normalise a Wikipedia `data-sort-value` string to YYYY-MM-DD. */
function parseSortValue(val: string): string | null {
  // Wikipedia sort values sometimes have a leading "!" trick to
  // force a sort order. Strip it.
  const stripped = val.replace(/^!+/, "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(stripped);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(stripped);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
}

function dedupe(list: ScrapedRelease[]): ScrapedRelease[] {
  const seen = new Set<string>();
  const out: ScrapedRelease[] = [];
  for (const r of list) {
    const key = `${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}::${r.releaseDate}::${r.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
