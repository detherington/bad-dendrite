// Watchmode API client.
//
// Docs: https://api.watchmode.com/docs/
// Base: https://api.watchmode.com/v1/
//
// We use the /releases/ endpoint, which returns upcoming (and recent)
// streaming releases across all services. Crucially each release row
// carries `tmdb_id` + `tmdb_type` directly, so we can inject matches
// straight into our TMDB-driven candidate pipeline without a second
// round of search-by-name lookups — the same shortcut we use with the
// Streaming Availability /changes endpoint, but Watchmode's coverage
// is much better on "this is coming to service X on date Y" data.
//
// The endpoint doesn't accept a source filter, so we make ONE call per
// cache window and filter client-side against our allowed provider set.
// That's ~1 call per refresh, which is trivial on Watchmode's 1,000
// req/month free tier.

const WATCHMODE_BASE = "https://api.watchmode.com/v1";

/** Cache TTL for Watchmode /releases. 24h is comfortable under the
 *  1,000 req/month free-tier cap (≈30 calls/month even with frequent
 *  refreshes) and "coming soon" data doesn't need to be fresher than
 *  once a day. */
const WATCHMODE_CACHE_SECONDS = 60 * 60 * 24; // 24h

export class WatchmodeConfigError extends Error {}

function getKey(): string | null {
  const key = process.env.WATCHMODE_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function isWatchmodeConfigured(): boolean {
  return getKey() != null;
}

// ---------- Response shapes (only the fields we touch) ----------

/** One row from Watchmode's /releases/ endpoint. */
interface WatchmodeReleaseRow {
  id?: number;
  title?: string;
  /** "movie" or "tv_series". */
  type?: string;
  /** TMDB id. Watchmode indexes most titles against TMDB, but a small
   *  fraction have no match — those come through with tmdb_id: 0 or
   *  missing, and we drop them. */
  tmdb_id?: number;
  /** "movie" or "tv". */
  tmdb_type?: string;
  season_number?: number | null;
  poster_url?: string | null;
  /** YYYY-MM-DD. This is Watchmode's authoritative "arrives on date X"
   *  signal for the corresponding source, and is the whole reason we
   *  bother with this API. */
  source_release_date?: string;
  /** Watchmode's source id (NOT a TMDB id). See WATCHMODE_SOURCE_TO_TMDB. */
  source_id?: number;
  source_name?: string;
  /** 1 if the title is marked as an original production of the source,
   *  0 otherwise. Used to flip the `verifiedOriginal` bit so originals
   *  skip the downstream production_companies filter. */
  is_original?: number;
}

interface WatchmodeReleasesResponse {
  releases?: WatchmodeReleaseRow[];
}

// ---------- Source-id mapping ----------

/** Watchmode source id -> our TMDB provider id. Any row whose source id
 *  isn't in this map is discarded (other services aren't in our
 *  ALLOWED_PROVIDERS list).
 *
 *  Source ids were pulled from Watchmode's /sources/ endpoint: Netflix
 *  is 203, Hulu 157, Amazon Prime Video 26, Disney+ 372, HBO Max 387,
 *  Apple TV+ 371, Peacock 389. If any of these drift we'll see zero
 *  matches in `perSource` diagnostics and can re-verify. */
const WATCHMODE_SOURCE_TO_TMDB: Record<number, number> = {
  203: 8, // Netflix
  157: 15, // Hulu
  26: 9, // Amazon Prime Video
  372: 337, // Disney+
  387: 1899, // HBO Max / Max
  371: 350, // Apple TV+
  389: 386, // Peacock
};

// ---------- Helpers ----------

function normaliseTmdbType(raw: string | undefined): "movie" | "tv" | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "movie") return "movie";
  if (lower === "tv" || lower === "tv_series" || lower === "series") return "tv";
  return null;
}

function isYmd(raw: string | undefined): raw is string {
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

/** Watchmode's `poster_url` is typically a full TMDB CDN URL like
 *  `https://image.tmdb.org/t/p/w185/abc123.jpg`. Strip the scheme,
 *  host, and size segment to extract just the path portion (`/abc123.jpg`)
 *  so it can be used with our existing `tmdbImage(path, size)` helper,
 *  which prepends its own base + size. Returns null for non-TMDB URLs
 *  (rare) or when the URL is missing. */
function extractTmdbPosterPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/[^?#]+)/.exec(url);
  return match ? match[1] : null;
}

async function watchmodeFetch<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const key = getKey();
  if (!key) {
    throw new WatchmodeConfigError("WATCHMODE_API_KEY is not set.");
  }
  const url = new URL(`${WATCHMODE_BASE}${path}`);
  url.searchParams.set("apiKey", key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    next: { revalidate: WATCHMODE_CACHE_SECONDS },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Watchmode ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

// ---------- Public API ----------

export interface WatchmodeUpcoming {
  mediaType: "movie" | "tv";
  tmdbId: number;
  /** Allowed TMDB provider ids that Watchmode said this title is
   *  coming to. Usually one, but a title can be attributed to more
   *  than one service on the same refresh if the releases feed lists
   *  it multiple times. */
  providerIds: Set<number>;
  /** Earliest `source_release_date` across any matching service, in
   *  YYYY-MM-DD. Used as the authoritative movie release date
   *  downstream — Watchmode tracks actual streamer release dates,
   *  which TMDB's crowdsourced release_dates field often misses. */
  releaseDate: string | null;
  /** True if ANY matching row had `is_original === 1`. Flips the
   *  verifiedOriginal bit on the injected candidate so it skips the
   *  production_companies filter. */
  isOriginal: boolean;
  /** TMDB poster path extracted from Watchmode's `poster_url` field
   *  (e.g. `/abc123.jpg`). Used as a fallback when the downstream
   *  TMDB detail fetch returns no poster_path for the title. Null
   *  when Watchmode has no poster either. */
  posterPath: string | null;
  /** Season number from Watchmode when the release row is for a
   *  specific season (e.g. Season 2 drop of an ongoing show). Used
   *  downstream to fetch season-specific poster art when the show-
   *  level poster is missing. Null for movies and for series where
   *  Watchmode doesn't specify a season. */
  seasonNumber: number | null;
}

/** Diagnostics captured during one Watchmode /releases sweep. Surfaced
 *  via /api/releases?debug=1 so we can tell whether the key is wired,
 *  whether calls are succeeding, and which sources are contributing. */
export interface WatchmodeDiagnostics {
  configured: boolean;
  callsAttempted: number;
  callsSucceeded: number;
  callsFailed: number;
  /** Total rows in the raw `releases` array of the response, before
   *  any filtering. */
  rowsReturned: number;
  /** Rows dropped because their source_id isn't in WATCHMODE_SOURCE_TO_TMDB. */
  rowsDroppedUnknownSource: number;
  /** Rows dropped because tmdb_id was missing / 0. */
  rowsDroppedNoTmdbId: number;
  /** Rows dropped because tmdb_type wasn't movie/tv. */
  rowsDroppedBadType: number;
  /** Rows dropped because source_release_date wasn't a YYYY-MM-DD string. */
  rowsDroppedBadDate: number;
  /** Rows dropped because their date fell outside the current window. */
  rowsDroppedOutsideWindow: number;
  /** Unique (mediaType, tmdbId) items returned after all filtering. */
  itemsReturned: number;
  /** Breakdown of returned items by our TMDB provider id. */
  perProvider: Record<number, number>;
  /** Count of returned items whose is_original flag was 1. */
  originalsCount: number;
  /** Most recent failure message (if any), truncated to 500 chars. */
  lastError: string | null;
  /** Top-level keys present on the first response body. */
  firstResponseKeys: string[] | null;
  /** First 1500 chars of the first successful response body, for deep
   *  shape debugging. */
  firstResponseSample: string | null;
  /** First 5 accepted items for quick inspection. */
  sampleItems: Array<{
    mediaType: "movie" | "tv";
    tmdbId: number;
    providerId: number;
    releaseDate: string;
    isOriginal: boolean;
  }>;
}

export interface WatchmodeFetchResult {
  items: WatchmodeUpcoming[];
  diagnostics: WatchmodeDiagnostics;
}

/** Fetch upcoming releases from Watchmode, filter against our allowed
 *  provider set and the active date window, and return a deduped list
 *  keyed by TMDB (mediaType, id) plus a diagnostics object.
 *
 *  Never throws — any error is captured and reported via diagnostics. */
export async function fetchWatchmodeUpcoming(
  from: string,
  to: string,
): Promise<WatchmodeFetchResult> {
  const diagnostics: WatchmodeDiagnostics = {
    configured: isWatchmodeConfigured(),
    callsAttempted: 0,
    callsSucceeded: 0,
    callsFailed: 0,
    rowsReturned: 0,
    rowsDroppedUnknownSource: 0,
    rowsDroppedNoTmdbId: 0,
    rowsDroppedBadType: 0,
    rowsDroppedBadDate: 0,
    rowsDroppedOutsideWindow: 0,
    itemsReturned: 0,
    perProvider: {},
    originalsCount: 0,
    lastError: null,
    firstResponseKeys: null,
    firstResponseSample: null,
    sampleItems: [],
  };

  if (!diagnostics.configured) {
    return { items: [], diagnostics };
  }

  diagnostics.callsAttempted++;
  let res: WatchmodeReleasesResponse;
  try {
    // Watchmode's /releases/ endpoint returns up to 250 rows per call
    // spanning both recent and upcoming releases across ALL sources.
    // That's plenty of headroom for the 7 providers we care about over
    // a ~90-day forward window. No pagination or source filter is
    // supported by the endpoint, so one call per cache window is it.
    res = await watchmodeFetch<WatchmodeReleasesResponse>("/releases/", {
      limit: "250",
    });
    diagnostics.callsSucceeded++;
  } catch (err) {
    diagnostics.callsFailed++;
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.lastError = message.slice(0, 500);
    console.error(`[watchmode] /releases failed: ${message}`);
    return { items: [], diagnostics };
  }

  try {
    diagnostics.firstResponseKeys = Object.keys(res as object);
    diagnostics.firstResponseSample = JSON.stringify(res).slice(0, 1500);
  } catch {
    /* diagnostic-only */
  }

  const rows = Array.isArray(res.releases) ? res.releases : [];
  diagnostics.rowsReturned = rows.length;

  const merged = new Map<string, WatchmodeUpcoming>();
  for (const row of rows) {
    const tmdbProviderId =
      typeof row.source_id === "number"
        ? WATCHMODE_SOURCE_TO_TMDB[row.source_id]
        : undefined;
    if (tmdbProviderId == null) {
      diagnostics.rowsDroppedUnknownSource++;
      continue;
    }
    if (typeof row.tmdb_id !== "number" || row.tmdb_id <= 0) {
      diagnostics.rowsDroppedNoTmdbId++;
      continue;
    }
    const mediaType = normaliseTmdbType(row.tmdb_type);
    if (!mediaType) {
      diagnostics.rowsDroppedBadType++;
      continue;
    }
    if (!isYmd(row.source_release_date)) {
      diagnostics.rowsDroppedBadDate++;
      continue;
    }
    const releaseDate = row.source_release_date;
    if (releaseDate < from || releaseDate > to) {
      diagnostics.rowsDroppedOutsideWindow++;
      continue;
    }

    const isOriginal = row.is_original === 1;
    const posterPath = extractTmdbPosterPath(row.poster_url);
    const seasonNumber =
      typeof row.season_number === "number" && row.season_number > 0
        ? row.season_number
        : null;
    const key = `${mediaType}-${row.tmdb_id}`;
    const existing = merged.get(key);
    if (existing) {
      existing.providerIds.add(tmdbProviderId);
      if (!existing.releaseDate || releaseDate < existing.releaseDate) {
        existing.releaseDate = releaseDate;
      }
      if (isOriginal) existing.isOriginal = true;
      // Prefer the highest season number we see, on the assumption
      // that Watchmode is listing the newest drop when multiple rows
      // exist for the same TMDB id.
      if (
        seasonNumber != null &&
        (existing.seasonNumber == null || seasonNumber > existing.seasonNumber)
      ) {
        existing.seasonNumber = seasonNumber;
      }
      if (posterPath && !existing.posterPath) {
        existing.posterPath = posterPath;
      }
    } else {
      merged.set(key, {
        mediaType,
        tmdbId: row.tmdb_id,
        providerIds: new Set([tmdbProviderId]),
        releaseDate,
        isOriginal,
        posterPath,
        seasonNumber,
      });
    }
  }

  const items = Array.from(merged.values());
  diagnostics.itemsReturned = items.length;
  for (const item of items) {
    if (item.isOriginal) diagnostics.originalsCount++;
    for (const pid of item.providerIds) {
      diagnostics.perProvider[pid] = (diagnostics.perProvider[pid] ?? 0) + 1;
    }
  }
  diagnostics.sampleItems = items.slice(0, 5).map((item) => ({
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    providerId: Array.from(item.providerIds)[0],
    releaseDate: item.releaseDate ?? "",
    isOriginal: item.isOriginal,
  }));

  return { items, diagnostics };
}
