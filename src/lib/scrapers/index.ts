/** Orchestrator — runs every streamer scraper in parallel and merges
 *  the results. Each scraper is isolated with its own try/catch so a
 *  single broken site can't take down the whole pipeline. */

import { scrapeAppleTv } from "./apple-tv";
import { scrapeDisneyPress } from "./disney-press";
import { scrapeHuluPress } from "./hulu-press";
import { scrapeMaxPress } from "./max-press";
import { scrapeNetflixTudum } from "./netflix-tudum";
import { scrapePeacock } from "./peacock";
import { scrapePrimeVideo } from "./prime-video";
import { scrapeWikipedia } from "./wikipedia";
import type {
  Scraper,
  ScrapedRelease,
  ScraperDiagnostic,
  ScraperResult,
} from "./types";

const SCRAPERS: Array<{ name: string; fn: Scraper }> = [
  // Wikipedia is the primary source -- curated "Upcoming" sections
  // on "List of <streamer> original programming" pages are the only
  // place that reliably has server-rendered, parseable data for all
  // streamers. Every other scraper below is a secondary source that
  // may or may not find anything depending on whether the streamer's
  // site is an SPA with no SSR content (most of them currently are).
  { name: "wikipedia", fn: scrapeWikipedia },
  { name: "netflix-tudum", fn: scrapeNetflixTudum },
  { name: "disney-press", fn: scrapeDisneyPress },
  { name: "apple-tv", fn: scrapeAppleTv },
  { name: "max-press", fn: scrapeMaxPress },
  { name: "prime-video-press", fn: scrapePrimeVideo },
  { name: "peacock", fn: scrapePeacock },
  { name: "hulu-press", fn: scrapeHuluPress },
];

export async function runAllScrapers(): Promise<ScraperResult> {
  const settled = await Promise.allSettled(SCRAPERS.map((s) => s.fn()));
  const releases: ScrapedRelease[] = [];
  const diagnostics: ScraperDiagnostic[] = [];

  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    const name = SCRAPERS[i].name;
    if (entry.status === "fulfilled") {
      releases.push(...entry.value.releases);
      diagnostics.push(...entry.value.diagnostics);
    } else {
      diagnostics.push({
        source: name,
        providerId: 0,
        url: "",
        fetched: false,
        httpStatus: null,
        itemsFound: 0,
        error:
          entry.reason instanceof Error
            ? entry.reason.message
            : String(entry.reason),
        samples: [],
        parseStrategy: null,
        htmlBytes: 0,
        fetchedHtmlSample: null,
        nextDataSample: null,
        scriptInventory: [],
      });
    }
  }

  return { releases, diagnostics };
}

export type { ScrapedRelease, ScraperDiagnostic, ScraperResult };
