/** Disney+ "Coming Soon" scraper.
 *
 *  Target: the in-app "Coming Soon" browse collection at
 *  https://www.disneyplus.com/en-ca/browse/page-36541dc7-6961-4bbb-a07b-ef97d7da7995
 *
 *  Disney+ web is a React SPA and this URL is a curated collection
 *  page ("page-<uuid>"). The web client serialises its initial data
 *  for server-side rendering, so the aggressive script scanner should
 *  find the collection items in whichever hydration blob the app
 *  ships with the SSR response. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const DISNEY_PROVIDER_ID = 337;

export async function scrapeDisneyPress(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "disney-plus-coming",
    providerId: DISNEY_PROVIDER_ID,
    urls: [
      "https://www.disneyplus.com/en-ca/browse/page-36541dc7-6961-4bbb-a07b-ef97d7da7995",
    ],
    defaultMediaType: "unknown",
  });
}
