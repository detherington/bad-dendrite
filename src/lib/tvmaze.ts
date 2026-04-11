// Minimal TVmaze client. No auth required, free tier.
//
// TVmaze indexes streaming ("web channel") shows more aggressively than
// TMDB's per-region watch_providers layer, so we use /schedule/web as a
// discovery supplement to catch upcoming TV that TMDB's availability-based
// discovery misses (especially weekly episode drops and near-term launches).
//
// Docs: https://www.tvmaze.com/api

const TVMAZE_BASE = "https://api.tvmaze.com";

export interface TvmazeWebChannel {
  id: number;
  name: string;
  country: { code: string; name?: string } | null;
  officialSite?: string | null;
}

export interface TvmazeShow {
  id: number;
  name: string;
  type: string;
  language: string | null;
  genres: string[];
  status: string;
  premiered: string | null;
  webChannel: TvmazeWebChannel | null;
  network: { name: string } | null;
  image: { medium: string; original: string } | null;
  summary: string | null;
  externals?: { tvrage?: number | null; thetvdb?: number | null; imdb?: string | null };
}

export interface TvmazeEpisode {
  id: number;
  name: string;
  season: number;
  number: number;
  type: string; // "regular" | "significant_special" | ...
  airdate: string; // YYYY-MM-DD
  airtime: string; // HH:MM (may be "")
  airstamp: string; // ISO with timezone
  runtime: number | null;
  _embedded?: { show?: TvmazeShow };
}

// TVmaze webChannel.name (lowercased) → our TMDB provider id. Cover the
// string variants we've seen in the wild — TVmaze isn't perfectly
// consistent across records.
const CHANNEL_TO_PROVIDER_ID: Record<string, number> = {
  "netflix": 8,
  "apple tv+": 350,
  "apple tv plus": 350,
  "apple tv": 350,
  "disney+": 337,
  "disney plus": 337,
  "amazon prime video": 9,
  "amazon prime": 9,
  "prime video": 9,
  "amazon": 9,
  "hulu": 15,
  "peacock": 386,
  "peacock premium": 386,
  "max": 1899,
  "hbo max": 1899,
  "hbo": 1899,
};

export function mapTvmazeChannelToProviderId(name: string | null | undefined): number | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return CHANNEL_TO_PROVIDER_ID[key] ?? null;
}

async function tvmazeFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${TVMAZE_BASE}${path}`, {
    // Match the 6h Data Cache window we use for TMDB so per-day lookups
    // are reused between requests on Vercel.
    next: { revalidate: 60 * 60 * 6 },
  });
  if (!res.ok) {
    throw new Error(`TVmaze ${res.status} ${res.statusText} for ${path}`);
  }
  return (await res.json()) as T;
}

function enumerateDates(fromYmd: string, toYmd: string): string[] {
  const dates: string[] = [];
  const start = new Date(fromYmd + "T00:00:00Z");
  const end = new Date(toYmd + "T00:00:00Z");
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Bounded-concurrency runner (local copy so this module stays
 *  self-contained). */
async function runWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetch /schedule/web for each day in the window and return the flattened
 *  episode list. TVmaze rate-limits around 20 calls / 10 seconds per IP,
 *  so we cap parallelism at 5 to stay well inside that limit — failed
 *  days are silently dropped rather than retried. */
export async function fetchTvmazeWebSchedule(
  fromYmd: string,
  toYmd: string,
  country: string,
): Promise<TvmazeEpisode[]> {
  const dates = enumerateDates(fromYmd, toYmd);
  const results = await runWithConcurrency(dates, 5, async (date) => {
    const q = country ? `?date=${date}&country=${encodeURIComponent(country)}` : `?date=${date}`;
    return tvmazeFetch<TvmazeEpisode[]>(`/schedule/web${q}`);
  });

  const episodes: TvmazeEpisode[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      episodes.push(...r.value);
    }
  }
  return episodes;
}
