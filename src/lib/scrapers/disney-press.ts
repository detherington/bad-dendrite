/** Disney+ press-site scraper. Disney runs a dedicated corporate press
 *  site at press.disneyplus.com with a "coming soon" / calendar view
 *  for upcoming Disney+ titles. Disney theatrical releases that land on
 *  Disney+ are surfaced here too. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const DISNEY_PROVIDER_ID = 337;

export async function scrapeDisneyPress(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "disney-press",
    providerId: DISNEY_PROVIDER_ID,
    urls: [
      "https://press.disneyplus.com/premiere-dates",
      "https://press.disneyplus.com/news",
    ],
    defaultMediaType: "unknown",
  });
}
