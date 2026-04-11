/** Peacock "what's new" scraper. Peacock maintains an in-app "what's
 *  new" page that's server-rendered for SEO, plus NBCUniversal press
 *  releases for bigger premieres. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const PEACOCK_PROVIDER_ID = 386;

export async function scrapePeacock(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "peacock",
    providerId: PEACOCK_PROVIDER_ID,
    urls: [
      "https://www.peacocktv.com/whats-new-on-peacock",
      "https://www.nbcuniversal.com/news",
    ],
    defaultMediaType: "unknown",
  });
}
