/** Amazon Prime Video / Amazon MGM Studios "upcoming originals"
 *  scraper.
 *
 *  Amazon MGM runs a dedicated press site with two pages explicitly
 *  listing upcoming original series and upcoming original movies:
 *
 *    /us/en/upcoming-original-series
 *    /us/en/upcoming-original-movies
 *
 *  These pages are exactly what we want — curated schedule data, not
 *  a news listing. Split into two URLs so the series and movies are
 *  fetched independently. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const PRIME_PROVIDER_ID = 9;

export async function scrapePrimeVideo(): Promise<ScraperResult> {
  // Intentionally scrape series and movies as a single logical source
  // with two URLs so we can tune the mediaType hint per URL downstream
  // if needed.
  return scrapeGenericPress({
    source: "prime-video-upcoming",
    providerId: PRIME_PROVIDER_ID,
    urls: [
      "https://press.amazonmgmstudios.com/us/en/upcoming-original-series",
      "https://press.amazonmgmstudios.com/us/en/upcoming-original-movies",
    ],
    defaultMediaType: "unknown",
  });
}
