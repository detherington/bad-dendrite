// Movie of the Night "Streaming Availability" API client (via RapidAPI).
//
// Docs: https://docs.movieofthenight.com/ (v4)
// Host: https://streaming-availability.p.rapidapi.com
//
// We use /changes with target_type=upcoming to get titles that are
// announced to be added to a given service in a given country but aren't
// available yet. Crucially, each returned show carries a `tmdbId` field
// ("movie/1234" or "tv/5678"), so we can inject them straight into our
// existing TMDB-driven candidate pipeline without a second round of
// search-by-name lookups.

const SA_BASE = "https://streaming-availability.p.rapidapi.com";
const SA_HOST = "streaming-availability.p.rapidapi.com";

/**
 * Cache TTL for Streaming Availability responses. Sized to keep total
 * monthly API usage comfortably under the RapidAPI free tier's 1,000
 * request/month cap.
 *
 * Budget math at 48h with current pagination (7 providers × 2
 * change_types × 3 pages × 15 refreshes/month) ≈ 630 calls/month,
 * leaving ~37% headroom for multi-region cache misses and occasional
 * early evictions. "Coming soon" data doesn't need to be more than a
 * couple of days fresh, so a 48h window is a safe cap.
 */
const SA_CACHE_SECONDS = 60 * 60 * 48; // 48h

export class StreamingAvailabilityConfigError extends Error {}

function getKey(): string | null {
  const key = process.env.STREAMING_AVAILABILITY_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function isStreamingAvailabilityConfigured(): boolean {
  return getKey() != null;
}

// ---------- Response shapes (only the fields we touch) ----------

interface SaServiceInfo {
  id?: string;
  name?: string;
}

interface SaStreamingOption {
  service?: SaServiceInfo;
  type?: string;
  availableSince?: number;
  expiresOn?: number;
  link?: string;
}

interface SaShow {
  itemType?: string;
  showType?: "movie" | "series";
  id?: string;
  tmdbId?: string;
  imdbId?: string;
  title?: string;
  overview?: string;
  releaseYear?: number;
  streamingOptions?: Record<string, SaStreamingOption[]>;
}

interface SaChangeEntry {
  changeType?: string;
  itemType?: string;
  /** SA's own show id (not the TMDB id). Used to join against the
   *  `shows` map in the same response body. */
  showId?: string;
  showType?: "movie" | "series";
  service?: { id?: string; name?: string };
  streamingOptionType?: string;
  /** Unix seconds timestamp of when the change takes effect -- for
   *  `target_type=upcoming` this is the scheduled "coming to X" date. */
  timestamp?: number;
  link?: string;
  // Legacy shapes where the show is inlined on the change entry.
  target?: SaShow;
  show?: SaShow;
}

/** Defensive union for /changes responses. The v4 API returns `shows`
 *  as a MAP keyed by SA's internal show id (NOT a TMDB id) plus a
 *  parallel `changes` index array. Each change entry carries a
 *  `showId` that joins against the map AND a `timestamp` that is the
 *  best signal we have for "this title arrives on date X." */
interface ChangesResponse {
  shows?: Record<string, SaShow> | SaShow[];
  changes?: SaChangeEntry[];
  hasMore?: boolean;
  nextCursor?: string;
}

/** Result of extracting one change entry joined with its show. */
interface SaExtractedEntry {
  show: SaShow;
  /** Change timestamp in YYYY-MM-DD, or null if not available. */
  releaseDate: string | null;
}

// ---------- Service-id mapping ----------

/** Our TMDB provider id -> SA catalog id. The SA docs use short slugs
 *  ("netflix", "prime", etc). If a provider is missing from this map we
 *  simply skip calling /changes for it. */
const TMDB_PROVIDER_TO_SA_CATALOG: Record<number, string> = {
  8: "netflix",
  350: "apple", // Apple TV+
  337: "disney", // Disney+
  9: "prime", // Amazon Prime Video
  15: "hulu", // Hulu
  386: "peacock", // Peacock
  1899: "hbo", // Max (formerly HBO Max)
};

// ---------- Helpers ----------

function parseTmdbIdString(
  raw: string | null | undefined,
): { mediaType: "movie" | "tv"; id: number } | null {
  if (!raw) return null;
  const match = /^(movie|tv)\/(\d+)$/.exec(raw);
  if (!match) return null;
  const id = parseInt(match[2], 10);
  if (!Number.isFinite(id)) return null;
  return { mediaType: match[1] as "movie" | "tv", id };
}

function unixToYmd(ts: number | null | undefined): string | null {
  if (typeof ts !== "number" || ts <= 0) return null;
  try {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Pick the earliest per-show streaming availability date for the
 *  target country from a full SaShow object. This is the authoritative
 *  "coming on date X" signal — `show.streamingOptions[country][].availableSince`
 *  is the scheduled-to-become-available timestamp. For an
 *  `target_type=upcoming` query that date is in the FUTURE.
 *
 *  Note: `change.timestamp` on the `changes` array entries is NOT the
 *  release date — it's the timestamp when SA recorded the change in
 *  its own database (i.e. when the "this is coming" announcement was
 *  indexed), and is typically in the past. Do not use it. */
function pickReleaseDateFromShow(show: SaShow, countryLc: string): string | null {
  const options = show.streamingOptions?.[countryLc];
  if (!options || options.length === 0) return null;
  const future = options
    .map((o) => o.availableSince)
    .filter((ts): ts is number => typeof ts === "number" && ts > 0)
    .sort((a, b) => a - b);
  return unixToYmd(future[0] ?? null);
}

/** Extract `{ show, releaseDate }` entries from a /changes response.
 *
 *  v4 primary shape: each `changes[i]` has a `showId`, and `shows` is a
 *  map keyed by those showIds. We iterate the changes array (which is
 *  the authoritative list of "these titles are changing"), look up the
 *  full show from the map, and pull the release date from
 *  `show.streamingOptions[country].availableSince` — NOT from
 *  `change.timestamp`, which is when SA recorded the change, not when
 *  the title becomes available.
 *
 *  Falls back gracefully to shows-as-array and shows-inlined-on-change
 *  shapes for older or future API revisions. */
function extractChangeEntries(
  res: ChangesResponse,
  countryLc: string,
): SaExtractedEntry[] {
  const showsMap =
    res.shows && typeof res.shows === "object" && !Array.isArray(res.shows)
      ? (res.shows as Record<string, SaShow>)
      : null;

  // v4 primary path: iterate changes[] and join against shows map.
  if (showsMap && Array.isArray(res.changes)) {
    const out: SaExtractedEntry[] = [];
    const seenShowIds = new Set<string>();
    for (const change of res.changes) {
      if (!change.showId || seenShowIds.has(change.showId)) continue;
      seenShowIds.add(change.showId);
      const show = showsMap[change.showId];
      if (!show) continue;
      out.push({
        show,
        releaseDate: pickReleaseDateFromShow(show, countryLc),
      });
    }
    return out;
  }

  // Fallback: shows-as-map without a usable changes array.
  if (showsMap) {
    return Object.values(showsMap).map((show) => ({
      show,
      releaseDate: pickReleaseDateFromShow(show, countryLc),
    }));
  }
  // Fallback: shows-as-array (older API revisions).
  if (Array.isArray(res.shows)) {
    return (res.shows as SaShow[]).map((show) => ({
      show,
      releaseDate: pickReleaseDateFromShow(show, countryLc),
    }));
  }
  // Fallback: shows inlined on each change as `target` or `show`.
  if (Array.isArray(res.changes)) {
    const out: SaExtractedEntry[] = [];
    for (const change of res.changes) {
      const show = change.target ?? change.show;
      if (show) {
        out.push({
          show,
          releaseDate: pickReleaseDateFromShow(show, countryLc),
        });
      }
    }
    return out;
  }
  return [];
}

/** Bounded-concurrency runner so we can fan out (catalog × change_type)
 *  pagination tasks in parallel without blasting RapidAPI's rate limits.
 *  Local copy to keep this module free of imports from tmdb.ts. */
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

async function saFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = getKey();
  if (!key) {
    throw new StreamingAvailabilityConfigError(
      "STREAMING_AVAILABILITY_API_KEY is not set.",
    );
  }
  const url = new URL(`${SA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      "x-rapidapi-key": key,
      "x-rapidapi-host": SA_HOST,
      accept: "application/json",
    },
    // See SA_CACHE_SECONDS: longer than the 6h cache used for TMDB /
    // TVmaze because SA is a paid API and we need to fit monthly usage
    // under the RapidAPI free tier's 1,000 request cap.
    next: { revalidate: SA_CACHE_SECONDS },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Streaming Availability ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

// ---------- Public API ----------

export interface SaUpcoming {
  mediaType: "movie" | "tv";
  tmdbId: number;
  /** Allowed TMDB provider ids that SA said this title is coming to. */
  providerIds: Set<number>;
  /** Earliest `availableSince` across any matching streaming option, in
   *  YYYY-MM-DD, if SA returned one. Used as a soft hint only — the actual
   *  release date is still taken from TMDB details downstream. */
  releaseDate: string | null;
}

/** Diagnostics captured during a /changes sweep. Exposed via the
 *  /api/releases debug response so the user can see at a glance whether
 *  SA is configured, whether calls are succeeding, and what went wrong
 *  when they aren't. */
export interface SaDiagnostics {
  configured: boolean;
  catalogsQueried: string[];
  callsAttempted: number;
  callsSucceeded: number;
  callsFailed: number;
  itemsReturned: number;
  /** Most recent failure message (if any), truncated to 500 chars. */
  lastError: string | null;
  /** HTTP status of the most recent failed call (if captured). */
  lastErrorStatus: number | null;
  /** First successful call's shape-detection breadcrumb so we can tell
   *  whether SA's response shape matches what we expected. */
  responseShape: "shows-array" | "shows-map" | "changes" | "unknown" | null;
  /** Top-level keys present on the first successful response, to help
   *  diagnose unexpected shapes without leaking full response bodies. */
  firstResponseKeys: string[] | null;
  /** First raw response, truncated to ~1500 chars, for deep debugging. */
  firstResponseSample: string | null;
  /** Truncated JSON of the first show in the first successful shows
   *  map, so we can inspect the exact SaShow shape (streamingOptions,
   *  tmdbId format, etc.) when results look wrong. */
  firstShowSample: string | null;
  /** How many extracted entries actually had a usable release date
   *  from the streaming options vs. dropped for lack of one. */
  itemsWithReleaseDate: number;
  itemsWithoutReleaseDate: number;
  /** Breakdown of extracted entries by showType (movie vs series). */
  moviesCount: number;
  seriesCount: number;
  /** Are SA's availableSince timestamps actually in the future (where
   *  "upcoming" should put them)? `now` = the query time in Unix ms. */
  releaseDatesInFuture: number;
  releaseDatesInPast: number;
  /** First 10 (tmdbId, releaseDate) pairs we extracted, for quick
   *  inspection in the debug endpoint. */
  sampleItems: Array<{ tmdbId: string; showType: string; releaseDate: string | null }>;
}

export interface SaFetchResult {
  items: SaUpcoming[];
  diagnostics: SaDiagnostics;
}

/** SA's /changes endpoint doesn't accept comma-separated change_type
 *  values (returns 400 Bad Request). We want BOTH "new" (brand-new
 *  catalog additions) and "updated" (additions to existing titles, e.g.
 *  a new season of an ongoing series), so we iterate over them as
 *  separate calls. */
const SA_CHANGE_TYPES = ["new", "updated"] as const;

/** Fetch upcoming additions for each allowed provider. Paginates up to
 *  `pagesPerProvider` pages per (provider × change_type) combination
 *  (25 items/page) and returns a deduped list keyed by TMDB id plus a
 *  diagnostics object describing exactly what happened. Never throws —
 *  failures are captured and reported via diagnostics. */
export async function fetchStreamingAvailabilityUpcoming(
  country: string,
  providerIds: ReadonlyArray<number>,
  pagesPerProvider: number = 3,
): Promise<SaFetchResult> {
  const diagnostics: SaDiagnostics = {
    configured: isStreamingAvailabilityConfigured(),
    catalogsQueried: [],
    callsAttempted: 0,
    callsSucceeded: 0,
    callsFailed: 0,
    itemsReturned: 0,
    lastError: null,
    lastErrorStatus: null,
    responseShape: null,
    firstResponseKeys: null,
    firstResponseSample: null,
    firstShowSample: null,
    itemsWithReleaseDate: 0,
    itemsWithoutReleaseDate: 0,
    moviesCount: 0,
    seriesCount: 0,
    releaseDatesInFuture: 0,
    releaseDatesInPast: 0,
    sampleItems: [],
  };
  const nowYmd = new Date().toISOString().slice(0, 10);

  if (!diagnostics.configured) {
    return { items: [], diagnostics };
  }

  // SA expects lowercase country codes.
  const countryLc = country.toLowerCase();
  const results = new Map<string, SaUpcoming>();

  // Enumerate all (provider, catalog, change_type) tasks up front so we
  // can fan them out in parallel via a concurrency-bounded runner.
  // Pagination within each task remains sequential (cursor-dependent).
  type SaTask = { providerId: number; catalog: string; changeType: string };
  const tasks: SaTask[] = [];
  for (const providerId of providerIds) {
    const catalog = TMDB_PROVIDER_TO_SA_CATALOG[providerId];
    if (!catalog) continue;
    diagnostics.catalogsQueried.push(catalog);
    for (const changeType of SA_CHANGE_TYPES) {
      tasks.push({ providerId, catalog, changeType });
    }
  }

  /** Per-task pagination loop. Mutates shared diagnostics + results. */
  const runOne = async ({ providerId, catalog, changeType }: SaTask): Promise<void> => {
    let cursor: string | undefined;
    for (let page = 0; page < pagesPerProvider; page++) {
      const params: Record<string, string> = {
        country: countryLc,
        change_type: changeType,
        item_type: "show",
        // Only titles that aren't available yet. Exactly what we want.
        target_type: "upcoming",
        catalogs: catalog,
        order_by: "release_date",
        order_direction: "asc",
        output_language: "en",
        limit: "25",
      };
      if (cursor) params.cursor = cursor;

      diagnostics.callsAttempted++;
      let res: ChangesResponse;
      try {
        res = await saFetch<ChangesResponse>("/changes", params);
        diagnostics.callsSucceeded++;
      } catch (err) {
        diagnostics.callsFailed++;
        const message = err instanceof Error ? err.message : String(err);
        diagnostics.lastError = message.slice(0, 500);
        const statusMatch = /^(?:Streaming Availability|SA)\s+(\d{3})/.exec(message);
        if (statusMatch) {
          diagnostics.lastErrorStatus = parseInt(statusMatch[1], 10);
        }
        console.error(
          `[streaming-availability] ${catalog}/${changeType} page ${page}: ${message}`,
        );
        return;
      }

      // Capture diagnostics about the first successful response so we
      // can tell whether our parser matches the current API contract.
      if (diagnostics.responseShape == null) {
        const shows = res.shows;
        if (shows && typeof shows === "object" && !Array.isArray(shows)) {
          diagnostics.responseShape = "shows-map";
        } else if (Array.isArray(shows)) {
          diagnostics.responseShape = "shows-array";
        } else if (Array.isArray(res.changes)) {
          diagnostics.responseShape = "changes";
        } else {
          diagnostics.responseShape = "unknown";
        }
        try {
          diagnostics.firstResponseKeys = Object.keys(res as object);
          diagnostics.firstResponseSample = JSON.stringify(res).slice(0, 1500);
          if (shows && typeof shows === "object") {
            const firstShow = Array.isArray(shows)
              ? (shows as SaShow[])[0]
              : Object.values(shows as Record<string, SaShow>)[0];
            if (firstShow) {
              diagnostics.firstShowSample = JSON.stringify(firstShow).slice(0, 1500);
            }
          }
        } catch {
          /* ignore — just diagnostic */
        }
      }

      const entries = extractChangeEntries(res, countryLc);
      for (const { show, releaseDate } of entries) {
        const parsed = parseTmdbIdString(show.tmdbId);
        if (!parsed) continue;
        if (releaseDate) {
          diagnostics.itemsWithReleaseDate++;
          if (releaseDate >= nowYmd) {
            diagnostics.releaseDatesInFuture++;
          } else {
            diagnostics.releaseDatesInPast++;
          }
        } else {
          diagnostics.itemsWithoutReleaseDate++;
        }
        if (show.showType === "movie") diagnostics.moviesCount++;
        else if (show.showType === "series") diagnostics.seriesCount++;
        if (diagnostics.sampleItems.length < 10) {
          diagnostics.sampleItems.push({
            tmdbId: show.tmdbId ?? "",
            showType: show.showType ?? "",
            releaseDate,
          });
        }
        const key = `${parsed.mediaType}-${parsed.id}`;
        const existing = results.get(key);
        if (existing) {
          existing.providerIds.add(providerId);
          // Prefer the earliest known release date across all matched
          // catalogs (a title can be announced for the same day on
          // multiple services).
          if (
            releaseDate &&
            (!existing.releaseDate || releaseDate < existing.releaseDate)
          ) {
            existing.releaseDate = releaseDate;
          }
          continue;
        }

        results.set(key, {
          mediaType: parsed.mediaType,
          tmdbId: parsed.id,
          providerIds: new Set([providerId]),
          releaseDate,
        });
      }

      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
  };

  // RapidAPI basic/free plans cap around 5 req/sec. Concurrency 3 keeps
  // us safely inside that even during the burst at the start of a cold
  // fetch, while still cutting wall-clock latency ~3× vs. sequential.
  await runWithConcurrency(tasks, 3, runOne);

  diagnostics.itemsReturned = results.size;
  return { items: Array.from(results.values()), diagnostics };
}
