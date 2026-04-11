/** Max (Warner Bros. Discovery) press-site scraper. WBD runs
 *  press.wbd.com and press.hbo.com with media releases that routinely
 *  announce Max premiere dates for originals and day-and-date theatrical
 *  arrivals. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const MAX_PROVIDER_ID = 1899;

export async function scrapeMaxPress(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "max-press",
    providerId: MAX_PROVIDER_ID,
    urls: [
      "https://press.wbd.com/us/streaming",
      "https://press.wbd.com/us/max",
    ],
    defaultMediaType: "unknown",
  });
}
