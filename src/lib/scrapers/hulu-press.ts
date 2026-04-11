/** Hulu press-site schedule scraper.
 *
 *  Target: https://press.hulu.com/schedule/
 *  Hulu's press site publishes a dedicated schedule page with upcoming
 *  premieres, including release dates. Exactly the curated calendar
 *  data we want — not a generic news listing. */

import { scrapeGenericPress } from "./generic-press";
import type { ScraperResult } from "./types";

const HULU_PROVIDER_ID = 15;

export async function scrapeHuluPress(): Promise<ScraperResult> {
  return scrapeGenericPress({
    source: "hulu-schedule",
    providerId: HULU_PROVIDER_ID,
    urls: ["https://press.hulu.com/schedule/"],
    defaultMediaType: "unknown",
  });
}
