/** Hulu press-site scraper. Hulu maintains press.hulu.com with
 *  releases that announce upcoming original premieres. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const HULU_PROVIDER_ID = 15;

export async function scrapeHuluPress(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "hulu-press",
    providerId: HULU_PROVIDER_ID,
    urls: ["https://press.hulu.com/news/"],
    defaultMediaType: "unknown",
  });
}
