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
 * Budget math at 48h: 7 providers × 4 pages × (30 days / 2 days) =
 * ~420 calls/month, leaving ~58% headroom for multi-region cache misses
 * and the occasional early eviction. "Coming soon" data doesn't need to
 * be more than a couple of days fresh, so a 48h window is a safe cap.
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

/** Defensive union for /changes — the v4 docs show a `shows` array at the
 *  top level, but older/newer revisions have wrapped each entry in a
 *  `change` object. Handle either. */
interface ChangesResponse {
  shows?: SaShow[];
  changes?: Array<{ target?: SaShow; change_type?: string; target_type?: string }>;
  hasMore?: boolean;
  nextCursor?: string;
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

function extractShowsFromChanges(res: ChangesResponse): SaShow[] {
  if (Array.isArray(res.shows)) return res.shows;
  if (Array.isArray(res.changes)) {
    return res.changes
      .map((c) => c.target)
      .filter((s): s is SaShow => s != null);
  }
  return [];
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
  responseShape: "shows" | "changes" | "unknown" | null;
}

export interface SaFetchResult {
  items: SaUpcoming[];
  diagnostics: SaDiagnostics;
}

/** Fetch upcoming additions for each allowed provider. Paginates up to
 *  `pagesPerProvider` pages per provider (25 items/page) and returns a
 *  deduped list keyed by TMDB id plus a diagnostics object describing
 *  exactly what happened. Never throws — failures are captured and
 *  reported via diagnostics. */
export async function fetchStreamingAvailabilityUpcoming(
  country: string,
  providerIds: ReadonlyArray<number>,
  pagesPerProvider: number = 4,
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
  };

  if (!diagnostics.configured) {
    return { items: [], diagnostics };
  }

  // SA expects lowercase country codes.
  const countryLc = country.toLowerCase();
  const results = new Map<string, SaUpcoming>();

  for (const providerId of providerIds) {
    const catalog = TMDB_PROVIDER_TO_SA_CATALOG[providerId];
    if (!catalog) continue;
    diagnostics.catalogsQueried.push(catalog);

    let cursor: string | undefined;
    for (let page = 0; page < pagesPerProvider; page++) {
      const params: Record<string, string> = {
        country: countryLc,
        // "new" covers brand-new additions; "updated" covers additions to
        // shows that already exist in the catalog (e.g. new seasons).
        change_type: "new,updated",
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
        // Parse status out of a "SA 401 Unauthorized: ..." message if present.
        const statusMatch = /^(?:Streaming Availability|SA)\s+(\d{3})/.exec(message);
        if (statusMatch) {
          diagnostics.lastErrorStatus = parseInt(statusMatch[1], 10);
        }
        // Surface the error in Vercel function logs so users can see it
        // from the deployment console without curling /api/releases.
        console.error(`[streaming-availability] ${catalog} page ${page}: ${message}`);
        // Stop paginating this provider on error, but keep going with
        // the remaining providers — partial data is still useful.
        break;
      }

      // Record which top-level shape SA actually returned so we can tell
      // whether our parser matches the current API contract.
      if (diagnostics.responseShape == null) {
        if (Array.isArray((res as ChangesResponse).shows)) {
          diagnostics.responseShape = "shows";
        } else if (Array.isArray((res as ChangesResponse).changes)) {
          diagnostics.responseShape = "changes";
        } else {
          diagnostics.responseShape = "unknown";
        }
      }

      const shows = extractShowsFromChanges(res);
      for (const show of shows) {
        const parsed = parseTmdbIdString(show.tmdbId);
        if (!parsed) continue;
        const key = `${parsed.mediaType}-${parsed.id}`;
        const existing = results.get(key);
        if (existing) {
          existing.providerIds.add(providerId);
          continue;
        }

        // Derive the soonest release date from streamingOptions[country]
        // availableSince timestamps, if any.
        const options = show.streamingOptions?.[countryLc] ?? [];
        const earliest = options
          .map((o) => o.availableSince)
          .filter((ts): ts is number => typeof ts === "number" && ts > 0)
          .sort((a, b) => a - b)[0];
        const releaseDate = earliest
          ? new Date(earliest * 1000).toISOString().slice(0, 10)
          : null;

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
  }

  diagnostics.itemsReturned = results.size;
  return { items: Array.from(results.values()), diagnostics };
}
