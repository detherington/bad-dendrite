/** HBO / Max "What's New / What's Leaving" scraper.
 *
 *  Target: https://www.hbo.com/whats-new-whats-leaving
 *  HBO's own consumer page that lists current and upcoming Max
 *  additions. Server-rendered for SEO, so the aggressive script
 *  scanner should find titles + release dates in the embedded
 *  hydration blob. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const MAX_PROVIDER_ID = 1899;

export async function scrapeMaxPress(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "hbo-whats-new",
    providerId: MAX_PROVIDER_ID,
    urls: ["https://www.hbo.com/whats-new-whats-leaving"],
    defaultMediaType: "unknown",
  });
}
