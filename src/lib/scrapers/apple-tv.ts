/** Apple TV+ "coming soon" scraper. Apple publishes its upcoming slate
 *  on the apple.com marketing site and links it from the Apple TV app.
 *  They maintain a dedicated "coming soon" section with dates. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const APPLE_TV_PROVIDER_ID = 350;

export async function scrapeAppleTv(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "apple-tv",
    providerId: APPLE_TV_PROVIDER_ID,
    urls: [
      "https://www.apple.com/apple-tv-plus/",
      "https://www.apple.com/newsroom/apple-tv-plus/",
    ],
    defaultMediaType: "unknown",
  });
}
