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
  // Netflix
  {
    name: "wikipedia-netflix-films",
    url: "https://en.wikipedia.org/wiki/List_of_Netflix_original_films",
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
 *  Wikipedia's `sortable` wikitables mark date cells with a
 *  `data-sort-value` attribute containing ISO-ish strings we can
 *  parse cheaply (e.g. "2026-03-15-0000" or "20260315"). Falls back
 *  to free-form date parsing on raw cell text. */
function parseWikipediaTable(
  table: HTMLElement,
  spec: WikipediaSource,
): ScrapedRelease[] {
  const out: ScrapedRelease[] = [];
  const rows = table.querySelectorAll("tr");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.querySelectorAll("td");
    if (cells.length === 0) continue; // header row has only <th>

    // Title: the first `<td>`. Prefer the text of the first `<i>` or
    // `<a>` inside it (Wikipedia italicises show titles and links
    // them to the show's page). Fall back to plain cell text.
    const firstCell = cells[0];
    const italicEl = firstCell.querySelector("i a") || firstCell.querySelector("i");
    const linkEl = firstCell.querySelector("a");
    let title = "";
    if (italicEl) title = italicEl.text.trim();
    else if (linkEl) title = linkEl.text.trim();
    else title = firstCell.text.trim();
    title = title.replace(/\[[\d\s]+\]/g, "").trim(); // strip citation footnotes
    if (!title || title.length < 2 || title.length > 200) continue;

    // Release date: scan every cell for a data-sort-value first, then
    // fall back to free-form parsing.
    let releaseDate: string | null = null;
    for (const cell of cells) {
      const sortNode = cell.querySelector("[data-sort-value]");
      if (sortNode) {
        const val = sortNode.getAttribute("data-sort-value");
        if (val) {
          const parsed = parseSortValue(val);
          if (parsed) {
            releaseDate = parsed;
            break;
          }
        }
      }
    }
    if (!releaseDate) {
      for (const cell of cells) {
        const text = cell.text.replace(/\[[\d\s]+\]/g, "").trim();
        const parsed = parseFreeformDate(text);
        if (parsed) {
          releaseDate = parsed;
          break;
        }
      }
    }
    if (!releaseDate) continue;

    out.push({
      title,
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

/** Normalise a Wikipedia `data-sort-value` string to YYYY-MM-DD. */
function parseSortValue(val: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(val);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(val);
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
