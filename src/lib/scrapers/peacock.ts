/** Peacock "New on Peacock" scraper.
 *
 *  Target: https://www.peacocktv.com/collections/new-on-peacock
 *  Peacock's own in-app collection page listing upcoming additions.
 *  Server-rendered for SEO; the aggressive script scanner handles
 *  whichever hydration mechanism Peacock uses. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const PEACOCK_PROVIDER_ID = 386;

export async function scrapePeacock(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "peacock-new",
    providerId: PEACOCK_PROVIDER_ID,
    urls: ["https://www.peacocktv.com/collections/new-on-peacock"],
    defaultMediaType: "unknown",
  });
}
