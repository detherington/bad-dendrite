/** Prime Video / Amazon MGM press-site scraper. Amazon publishes
 *  upcoming Prime Video / Amazon MGM Studios titles across two press
 *  sites, so we scrape both. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const PRIME_PROVIDER_ID = 9;

export async function scrapePrimeVideo(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "prime-video-press",
    providerId: PRIME_PROVIDER_ID,
    urls: [
      "https://press.amazonmgmstudios.com/us/en/news",
      "https://www.aboutamazon.com/news/entertainment",
    ],
    defaultMediaType: "unknown",
  });
}
