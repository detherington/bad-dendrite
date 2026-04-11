import type {
  CastMember,
  HighlightKind,
  MediaType,
  Release,
  StreamingProvider,
  Trailer,
} from "./types";
import {
  fetchTvmazeWebSchedule,
  mapTvmazeChannelToProviderId,
  type TvmazeEpisode,
  type TvmazeShow,
} from "./tvmaze";
import {
  fetchStreamingAvailabilityUpcoming,
  isStreamingAvailabilityConfigured,
  type SaDiagnostics,
  type SaFetchResult,
} from "./streaming-availability";
import {
  fetchWatchmodeUpcoming,
  isWatchmodeConfigured,
  type WatchmodeDiagnostics,
  type WatchmodeFetchResult,
} from "./watchmode";
import { runAllScrapers } from "./scrapers";
import type {
  ScrapedRelease,
  ScraperDiagnostic,
  ScraperResult,
} from "./scrapers/types";

const TMDB_BASE = "https://api.themoviedb.org/3";

export class TmdbConfigError extends Error {}

interface TmdbFetchOptions {
  params?: Record<string, string | number | undefined>;
  revalidate?: number;
}

function getAuth() {
  const readToken = process.env.TMDB_READ_TOKEN?.trim();
  const apiKey = process.env.TMDB_API_KEY?.trim();
  if (!readToken && !apiKey) {
    throw new TmdbConfigError(
      "TMDB credentials missing. Set TMDB_READ_TOKEN or TMDB_API_KEY in .env.local.",
    );
  }
  return { readToken, apiKey };
}

export function getRegion(): string {
  return (process.env.TMDB_REGION || "US").trim().toUpperCase();
}

async function tmdbFetch<T>(path: string, opts: TmdbFetchOptions = {}): Promise<T> {
  const { readToken, apiKey } = getAuth();
  const url = new URL(`${TMDB_BASE}${path}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  if (!readToken && apiKey) {
    url.searchParams.set("api_key", apiKey);
  }

  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (readToken) {
    headers.authorization = `Bearer ${readToken}`;
  }

  const res = await fetch(url.toString(), {
    headers,
    next: { revalidate: opts.revalidate ?? 60 * 60 * 6 }, // 6h cache
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} ${res.statusText} for ${path}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ---------- Raw TMDB shapes (only fields we touch) ----------

interface TmdbDiscoverItem {
  id: number;
  title?: string;
  name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  popularity: number;
  genre_ids: number[];
}

interface TmdbDiscoverResponse {
  page: number;
  results: TmdbDiscoverItem[];
  total_pages: number;
  total_results: number;
}

interface TmdbGenre {
  id: number;
  name: string;
}

interface TmdbVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
  published_at: string;
}

interface TmdbCastEntry {
  id: number;
  name: string;
  character?: string;
  profile_path: string | null;
  order: number;
  popularity?: number;
  known_for_department?: string;
}

interface TmdbWatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

interface TmdbWatchProviderRegion {
  flatrate?: TmdbWatchProvider[];
  ads?: TmdbWatchProvider[];
  free?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
}

interface TmdbEpisodeInfo {
  air_date: string | null;
  episode_number: number;
  season_number: number;
  name: string;
}

/** One row inside `movie.release_dates[].release_dates` for a region.
 *  `type`: 1=Premiere 2=Theatrical(limited) 3=Theatrical 4=Digital
 *          5=Physical 6=TV
 *  We care about 4 and 6 for "coming to streaming" display dates. */
interface TmdbRegionalReleaseDate {
  release_date: string; // full ISO-8601 timestamp
  type: number;
  certification?: string;
  note?: string;
}

interface TmdbReleaseDatesRegion {
  iso_3166_1: string;
  release_dates: TmdbRegionalReleaseDate[];
}

interface TmdbProductionCompanyRef {
  id: number;
  name: string;
  logo_path?: string | null;
  origin_country?: string;
}

interface TmdbNetworkRef {
  id: number;
  name: string;
  logo_path?: string | null;
  origin_country?: string;
}

/** One image row from TMDB's `/images` endpoint. TMDB returns these
 *  for every appendable media kind (movies, TV, seasons). We only
 *  touch the file_path, language, and vote_average fields — the rest
 *  (width/height/aspect_ratio/vote_count) are diagnostic.
 *
 *  `iso_639_1` is the image's language code. An English poster has
 *  `"en"`, a language-neutral poster (no text, international art) has
 *  `null`, and everything else is the localised variant. */
interface TmdbImage {
  file_path: string;
  iso_639_1: string | null;
  vote_average?: number;
  width?: number;
  height?: number;
}

interface TmdbImages {
  posters?: TmdbImage[];
  backdrops?: TmdbImage[];
}

interface TmdbDetails {
  id: number;
  title?: string;
  name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  popularity: number;
  genres: TmdbGenre[];
  /** Present on movie detail responses. */
  production_companies?: TmdbProductionCompanyRef[];
  /** Present on TV detail responses. */
  networks?: TmdbNetworkRef[];
  next_episode_to_air?: TmdbEpisodeInfo | null;
  last_episode_to_air?: TmdbEpisodeInfo | null;
  videos?: { results: TmdbVideo[] };
  credits?: { cast: TmdbCastEntry[] };
  release_dates?: { results: TmdbReleaseDatesRegion[] };
  "watch/providers"?: { results: Record<string, TmdbWatchProviderRegion> };
  /** Populated via append_to_response=images. Contains posters and
   *  backdrops in any of the languages we pass via include_image_language
   *  (en, null, and the original language). Used as the fallback when
   *  the default localised `poster_path` is null. */
  images?: TmdbImages;
}

// ---------- Helpers ----------

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Video type -> base score. Types not listed (Behind the Scenes, Bloopers,
// Opening Credits, etc.) are explicitly rejected so we never surface junk.
const VIDEO_TYPE_SCORES: Record<string, number> = {
  Trailer: 2000,
  Teaser: 1200,
  Clip: 300,
  Featurette: 200,
};

/** Pick the best poster file_path from the `/images` endpoint's posters
 *  array. Used as a fallback when `d.poster_path` is null (common for
 *  very new entries and international titles where TMDB has posters but
 *  only in non-English languages that `language=en-US` hides).
 *
 *  Preference:
 *    1. English-language poster — matches what the user would see in a
 *       US-locale browser.
 *    2. Language-neutral poster (iso_639_1 === null) — international art
 *       with no text; always looks fine.
 *    3. Any remaining poster — a non-English poster is vastly better
 *       than no poster.
 *
 *  Within each language tier, pick the one with the highest vote_average
 *  (community-curated quality signal). */
function pickPosterFromImages(images: TmdbImages | undefined): string | null {
  if (!images?.posters?.length) return null;
  let bestEn: TmdbImage | null = null;
  let bestNull: TmdbImage | null = null;
  let bestAny: TmdbImage | null = null;
  for (const p of images.posters) {
    if (!p.file_path) continue;
    const score = p.vote_average ?? 0;
    if (p.iso_639_1 === "en") {
      if (!bestEn || score > (bestEn.vote_average ?? 0)) bestEn = p;
    } else if (p.iso_639_1 == null) {
      if (!bestNull || score > (bestNull.vote_average ?? 0)) bestNull = p;
    } else {
      if (!bestAny || score > (bestAny.vote_average ?? 0)) bestAny = p;
    }
  }
  return (bestEn ?? bestNull ?? bestAny)?.file_path ?? null;
}

/** Same logic as pickPosterFromImages but for backdrops. */
function pickBackdropFromImages(images: TmdbImages | undefined): string | null {
  if (!images?.backdrops?.length) return null;
  let bestEn: TmdbImage | null = null;
  let bestNull: TmdbImage | null = null;
  let bestAny: TmdbImage | null = null;
  for (const b of images.backdrops) {
    if (!b.file_path) continue;
    const score = b.vote_average ?? 0;
    if (b.iso_639_1 === "en") {
      if (!bestEn || score > (bestEn.vote_average ?? 0)) bestEn = b;
    } else if (b.iso_639_1 == null) {
      if (!bestNull || score > (bestNull.vote_average ?? 0)) bestNull = b;
    } else {
      if (!bestAny || score > (bestAny.vote_average ?? 0)) bestAny = b;
    }
  }
  return (bestEn ?? bestNull ?? bestAny)?.file_path ?? null;
}

interface PickTrailerOpts {
  /** When known, prefer videos whose name matches this TV season number. */
  seasonNumber?: number | null;
}

function pickTrailer(
  videos: TmdbVideo[] | undefined,
  opts: PickTrailerOpts = {},
): Trailer | null {
  if (!videos || videos.length === 0) return null;
  const youtube = videos.filter((v) => v.site === "YouTube");
  if (youtube.length === 0) return null;

  const now = Date.now();
  const targetSeason = opts.seasonNumber ?? null;

  // Build a regex that matches a given season number as a whole token, to
  // avoid "Season 1" matching "Season 10". Examples it matches:
  //   "Season 3", "season   3", "S3", "S03"
  const seasonRegex = (n: number) =>
    new RegExp(`(^|[^a-z0-9])(season\\s*0*${n}|s0*${n})(?![0-9])`, "i");

  function scoreOne(v: TmdbVideo): number {
    const typeScore = VIDEO_TYPE_SCORES[v.type];
    if (typeScore == null) return Number.NEGATIVE_INFINITY;

    let score = typeScore;

    if (v.official) score += 250;

    // Recency: linear decay from +200 (today) to 0 (two years old or more).
    if (v.published_at) {
      const daysOld = (now - new Date(v.published_at).getTime()) / 86_400_000;
      score += Math.max(0, 200 - daysOld * (200 / 730));
    }

    // Season-number matching (TV only).
    if (targetSeason != null && targetSeason > 0 && v.name) {
      if (seasonRegex(targetSeason).test(v.name)) {
        score += 900;
      } else {
        // Penalise videos that explicitly reference a DIFFERENT season, so a
        // leftover "Season 1 Trailer" can't win for a Season 3 premiere.
        for (let other = 1; other <= 25; other++) {
          if (other === targetSeason) continue;
          if (seasonRegex(other).test(v.name)) {
            score -= 700;
            break;
          }
        }
      }
    }

    return score;
  }

  const ranked = youtube
    .map((v) => ({ v, score: scoreOne(v) }))
    .filter((x) => x.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score);

  const chosen = ranked[0]?.v;
  if (!chosen) return null;
  return {
    key: chosen.key,
    name: chosen.name,
    site: chosen.site,
    url: `https://www.youtube.com/watch?v=${chosen.key}`,
  };
}

function pickCast(cast: TmdbCastEntry[] | undefined, limit = 6): CastMember[] {
  if (!cast) return [];
  return [...cast]
    .sort((a, b) => a.order - b.order)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character || null,
      profilePath: c.profile_path,
      popularity: c.popularity ?? 0,
    }));
}

function computeStarPower(cast: TmdbCastEntry[] | undefined): number {
  if (!cast || cast.length === 0) return 0;
  // Sum the top 3 cast popularities as a rough proxy for "big stars attached."
  const sorted = [...cast].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  return sorted.slice(0, 3).reduce((acc, c) => acc + (c.popularity ?? 0), 0);
}

/** Pick the display date for a movie from TMDB's regional release_dates.
 *  Prefers Digital (type 4) / TV (type 6) release dates in window.
 *  Falls back to the primary release_date field in window.
 *
 *  `trustPrimary` controls whether the primary fallback is allowed when
 *  the movie has any theatrical release (type 2 or 3) in its release_dates:
 *    - `false` (default): strict. Primary fallback only fires when the
 *      movie has NO theatrical entries anywhere. This excludes
 *      theatrical-first licensed films whose primary field equals
 *      their cinema date.
 *    - `true` (for verified-original candidates): trust the primary
 *      date whenever it's in window. Netflix / Max / Disney+ originals
 *      frequently have Oscar-qualifying theatrical entries that would
 *      otherwise block the fallback even though the movie is clearly
 *      the streamer's own production.
 *
 *  Returns null to signal "drop this item". */
function pickMovieReleaseDate(
  details: TmdbDetails,
  region: string,
  from: string,
  to: string,
  trustPrimary: boolean = false,
): string | null {
  const regional = details.release_dates?.results?.find(
    (r) => r.iso_3166_1 === region,
  );
  if (regional?.release_dates?.length) {
    const streamingInWindow = regional.release_dates
      .map((rd) => ({
        date: (rd.release_date || "").slice(0, 10),
        type: rd.type,
      }))
      .filter((rd) => rd.date && rd.date >= from && rd.date <= to)
      .filter((rd) => rd.type === 4 || rd.type === 6)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (streamingInWindow.length > 0) return streamingInWindow[0].date;
  }

  const primary = (details.release_date || "").slice(0, 10);
  if (primary && primary >= from && primary <= to) {
    if (trustPrimary) return primary;
    const hasAnyTheatrical = details.release_dates?.results?.some((r) =>
      r.release_dates?.some((rd) => rd.type === 2 || rd.type === 3),
    );
    if (!hasAnyTheatrical) return primary;
  }

  return null;
}

/** Check whether a TMDB detail response matches at least one allowed
 *  provider's production_companies (movies) or networks (TV). Returns
 *  the set of ALLOWED_PROVIDER ids whose markers appear in the detail.
 *  An empty set means "not an original, drop it."
 *
 *  Matching is layered: we first check TMDB company/network ids against
 *  the provider's hardcoded id list, then fall back to case-insensitive
 *  substring matching on the company/network name. The name fallback
 *  exists because TMDB's id tagging for streamer production arms is
 *  inconsistent — e.g. some Netflix movies list "Netflix" under an id
 *  that doesn't appear in any widely-cited reference, but the string
 *  "Netflix" is always somewhere in the production_companies names.
 *
 *  This is the ONLY signal used to decide what counts as a streaming
 *  original — watch_providers is purely informational downstream. */
function verifyAndAttributeOriginal(
  details: TmdbDetails,
  mediaType: MediaType,
): Set<number> {
  const matched = new Set<number>();

  if (mediaType === "movie") {
    const companies = details.production_companies ?? [];
    if (companies.length === 0) return matched;
    const companyIds = companies.map((c) => c.id);
    const companyNames = companies.map((c) => (c.name || "").toLowerCase());

    for (const provider of ALLOWED_PROVIDERS) {
      let hit = false;
      if (provider.movieCompanyIds) {
        for (const id of provider.movieCompanyIds) {
          if (companyIds.includes(id)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit && provider.movieCompanyNamePatterns) {
        for (const pat of provider.movieCompanyNamePatterns) {
          const needle = pat.toLowerCase();
          if (companyNames.some((n) => n.includes(needle))) {
            hit = true;
            break;
          }
        }
      }
      if (hit) matched.add(provider.id);
    }
    return matched;
  }

  const networks = details.networks ?? [];
  if (networks.length === 0) return matched;
  const networkIds = networks.map((n) => n.id);
  const networkNames = networks.map((n) => (n.name || "").toLowerCase());

  for (const provider of ALLOWED_PROVIDERS) {
    let hit = false;
    if (provider.tvNetworkIds) {
      for (const id of provider.tvNetworkIds) {
        if (networkIds.includes(id)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit && provider.tvNetworkNamePatterns) {
      for (const pat of provider.tvNetworkNamePatterns) {
        const needle = pat.toLowerCase();
        if (networkNames.some((n) => n.includes(needle))) {
          hit = true;
          break;
        }
      }
    }
    if (hit) matched.add(provider.id);
  }
  return matched;
}

function pickProviders(
  region: string,
  providers: TmdbDetails["watch/providers"] | undefined,
): StreamingProvider[] {
  const regionData = providers?.results?.[region];
  if (!regionData) return [];
  const seen = new Map<number, StreamingProvider>();
  const order: Array<keyof TmdbWatchProviderRegion> = ["flatrate", "ads", "free", "rent", "buy"];
  for (const key of order) {
    const list = regionData[key];
    if (!list) continue;
    for (const p of list) {
      if (!seen.has(p.provider_id)) {
        seen.set(p.provider_id, {
          id: p.provider_id,
          name: p.provider_name,
          logoPath: p.logo_path,
        });
      }
    }
  }
  return Array.from(seen.values());
}

// ---------- Public API ----------

export interface FetchReleasesOptions {
  daysAhead?: number;
  maxItems?: number;
  includeMovies?: boolean;
  includeTv?: boolean;
  region?: string;
}

/**
 * The only streaming services this app considers. The app's purpose is to
 * surface ORIGINAL streaming productions, so each provider declares the
 * TMDB identifiers that mark content as coming from that service:
 *
 *   - `tvNetworkIds`:     TV networks on TMDB whose shows are this
 *                         service's originals (use with `with_networks`).
 *   - `movieCompanyIds`:  production companies on TMDB whose movies count
 *                         as this service's originals (use with
 *                         `with_companies`).
 *
 * Both lists feed discovery (via `with_networks` / `with_companies`) AND
 * the post-detail originality filter: a candidate only survives if one of
 * these ids appears in its `networks` / `production_companies` detail
 * response. Licensed content that happens to be available on a service
 * is dropped.
 *
 * IDs are best-effort from publicly-cited TMDB records. If a specific
 * title you expect to see is missing, check its production_companies on
 * themoviedb.org and add the relevant id here.
 */
interface AllowedProvider {
  id: number;
  name: string;
  tvNetworkIds?: ReadonlyArray<number>;
  movieCompanyIds?: ReadonlyArray<number>;
  /** Case-insensitive substring patterns matched against a movie's
   *  production_companies[].name. Fallback when TMDB id tagging is
   *  inconsistent (which is common for streamer production arms). */
  movieCompanyNamePatterns?: ReadonlyArray<string>;
  /** Case-insensitive substring patterns matched against a TV show's
   *  networks[].name. Fallback for the same id-tagging reason. */
  tvNetworkNamePatterns?: ReadonlyArray<string>;
}

const ALLOWED_PROVIDERS: ReadonlyArray<AllowedProvider> = [
  {
    id: 8,
    name: "Netflix",
    tvNetworkIds: [213],
    tvNetworkNamePatterns: ["netflix"],
    movieCompanyIds: [145174, 178464, 224344, 137351],
    movieCompanyNamePatterns: ["netflix"],
  },
  {
    id: 350,
    name: "Apple TV+",
    tvNetworkIds: [2552],
    tvNetworkNamePatterns: ["apple tv"],
    movieCompanyIds: [151998, 194232],
    movieCompanyNamePatterns: ["apple original", "apple studios", "apple tv"],
  },
  {
    id: 337,
    name: "Disney+",
    tvNetworkIds: [2739],
    tvNetworkNamePatterns: ["disney+", "disney plus"],
    // Disney theatrical content that lands on Disney+ counts per the
    // user's definition since Disney owns the studio.
    movieCompanyIds: [2, 3, 420, 1, 6125, 10342],
    movieCompanyNamePatterns: [
      "walt disney",
      "pixar",
      "marvel studios",
      "lucasfilm",
      "disney+",
    ],
  },
  {
    id: 9,
    name: "Amazon Prime Video",
    tvNetworkIds: [1024],
    tvNetworkNamePatterns: ["prime video", "amazon"],
    movieCompanyIds: [20580, 200554, 21, 1632],
    movieCompanyNamePatterns: ["amazon studios", "amazon mgm", "prime video"],
  },
  {
    id: 15,
    name: "Hulu",
    tvNetworkIds: [453],
    tvNetworkNamePatterns: ["hulu"],
    movieCompanyIds: [19366],
    movieCompanyNamePatterns: ["hulu"],
  },
  {
    id: 386,
    name: "Peacock Premium",
    tvNetworkIds: [3353],
    tvNetworkNamePatterns: ["peacock"],
    movieCompanyIds: [33, 3268],
    movieCompanyNamePatterns: ["peacock", "universal pictures", "focus features"],
  },
  {
    id: 1899,
    name: "Max",
    tvNetworkIds: [49, 3186],
    tvNetworkNamePatterns: ["hbo", "max"],
    movieCompanyIds: [174, 12, 9993, 429, 2785, 5820],
    movieCompanyNamePatterns: [
      "warner bros",
      "new line",
      "hbo films",
      "hbo max",
      "dc entertainment",
      "dc studios",
    ],
  },
];

const ALLOWED_PROVIDER_IDS: ReadonlyArray<number> = ALLOWED_PROVIDERS.map((p) => p.id);
const ALLOWED_PROVIDER_ID_SET = new Set<number>(ALLOWED_PROVIDER_IDS);
const ALLOWED_PROVIDER_NAME_BY_ID = new Map<number, string>(
  ALLOWED_PROVIDERS.map((p) => [p.id, p.name]),
);

/** Hardcoded TMDB logo_path for each allowed provider. Used as a
 *  fallback when a provider is attributed via company/network/SA/
 *  Watchmode but the title hasn't been tagged in TMDB's
 *  `watch/providers` response yet (so `pickProviders` returns nothing
 *  for this provider_id and the logo would otherwise be null, leaving
 *  the UI to render initials like "Ne" or "Di"). These paths are
 *  stable TMDB CDN asset ids. */
const ALLOWED_PROVIDER_LOGO: Record<number, string> = {
  8: "/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg", // Netflix
  350: "/6uhKBfmtzFqOcLousHwZuzcrScK.jpg", // Apple TV+
  337: "/7rwgEs15tFwyR9NPQ5vpzxTj19Q.jpg", // Disney+
  9: "/emthp39XA2YScoYL1p0sdbAH2WA.jpg", // Amazon Prime Video
  15: "/zxrVdFjIjLqkfnwyghnfywTn3Lh.jpg", // Hulu
  386: "/xTHltMrZPAJFLQ6qyCBjAnXSmZt.jpg", // Peacock
  1899: "/6Q3KKKLC5RlFhubXgazRgN1a2Jb.jpg", // Max
};

/** Bounded-concurrency runner so we don't blast TMDB with hundreds of
 *  parallel requests and get rate-limited. */
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
        const value = await fn(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

interface DiscoverArgs {
  mediaType: MediaType;
  region: string;
  from: string;
  to: string;
  page: number;
  /** Optional TMDB provider id for an availability-based (watch_providers) pass. */
  providerId?: number;
  /** Optional TMDB TV network id for a production-based (with_networks) pass.
   *  Only meaningful when mediaType === "tv". */
  networkId?: number;
  /** Optional TMDB production company id for a production-based
   *  (with_companies) pass. Only meaningful when mediaType === "movie". */
  companyId?: number;
  /** Optional release-type filter (pipe-separated), e.g. "4|6" for
   *  Digital OR TV release. Movies only. */
  releaseType?: string;
  /** Override the default TV sort (popularity.desc) for a second pass. */
  tvSort?: "popularity.desc" | "first_air_date.desc";
}

async function discover(args: DiscoverArgs): Promise<TmdbDiscoverResponse> {
  const { mediaType, region, from, to, page, providerId, networkId, companyId, releaseType, tvSort } = args;
  const isMovie = mediaType === "movie";
  // MOVIES: always filter and sort by REGIONAL `release_date.*` instead of
  // `primary_release_date.*`. Primary is the earliest worldwide theatrical
  // date, so a movie that hit cinemas 6 months ago and is *now* arriving on
  // Netflix has a primary date in the past and gets filtered out of a
  // 90-day future window. `release_date` with `region=US` covers every
  // US-scoped release type (theatrical, digital, TV), so the movie's
  // digital arrival date puts it inside the window as expected.
  //
  // TV: still filter by `air_date` so we catch new SEASONS and EPISODES of
  // existing series, not just first-ever series launches. TMDB doesn't
  // expose an episode-level sort on /discover/tv, so sort by popularity
  // (or first_air_date.desc for the second pass) and let the client code
  // re-sort by the actual next-episode date downstream.
  const params: Record<string, string | number> = {
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    sort_by: isMovie ? "release_date.asc" : tvSort ?? "popularity.desc",
    page,
  };
  if (providerId != null) {
    // Availability-based pass: scopes to what TMDB has flagged as currently
    // available on the given service in the region.
    params.watch_region = region;
    params.with_watch_providers = providerId;
    params.with_watch_monetization_types = "flatrate|free|ads";
    // For movies we ALSO pass `region` so `release_date.*` narrows to that
    // country's release windows (which include the digital/TV release
    // types, not just the original theatrical date).
    if (isMovie) {
      params.region = region;
    }
  } else if (networkId != null) {
    // Production-based pass (TV): filters by the TV network that owns the
    // show, so Netflix originals surface even when their per-region
    // watch_providers data hasn't been populated yet.
    params.with_networks = networkId;
  } else if (companyId != null && isMovie) {
    // Production-based pass (movies): filters by the production company
    // that made the movie. This is the primary signal for "streaming
    // original" — a movie is a Netflix original iff Netflix Productions
    // (or similar) is in its production_companies list.
    params.with_companies = companyId;
    // Keep regional release windows so the digital release date (not the
    // theatrical one) controls what falls in the window.
    params.region = region;
  } else if (releaseType != null && isMovie) {
    // Release-type pass (movies only): finds movies with a Digital (4) or
    // TV (6) release type in the region, regardless of whether TMDB has
    // populated per-region watch_providers yet.
    params.region = region;
    params.with_release_type = releaseType as string;
  }
  if (isMovie) {
    params["release_date.gte"] = from;
    params["release_date.lte"] = to;
  } else {
    params["air_date.gte"] = from;
    params["air_date.lte"] = to;
  }
  const endpoint = isMovie ? "/discover/movie" : "/discover/tv";
  return tmdbFetch<TmdbDiscoverResponse>(endpoint, { params });
}

async function fetchDetails(mediaType: MediaType, id: number): Promise<TmdbDetails> {
  const endpoint = mediaType === "movie" ? `/movie/${id}` : `/tv/${id}`;
  // Movies also pull `release_dates` so we can pick the regional digital/TV
  // release for display instead of the primary (theatrical) date.
  //
  // `images` is always appended so we can fall back to a non-English
  // poster when the localised `poster_path` is null. Very new or
  // international titles often have posters tagged with the original
  // language but not English — the default `poster_path` on a
  // `language=en-US` detail response can be null in those cases, but
  // `images.posters` typically still has entries we can use.
  const append = mediaType === "movie"
    ? "videos,credits,watch/providers,release_dates,images"
    : "videos,credits,watch/providers,images";
  return tmdbFetch<TmdbDetails>(endpoint, {
    params: {
      language: "en-US",
      append_to_response: append,
      // Include videos whose language is English OR unset, so language-tagged
      // trailers don't get filtered out by the parent language=en-US param.
      include_video_language: "en,null",
      // Include posters/backdrops whose language is English, unset
      // (language-neutral international art), or the title's original
      // language. `xx` is TMDB's wildcard-ish accept for any language —
      // using it via `null,en,xx`-style comma lists would conflict with
      // `null`, so we pass en + null + the big-coverage languages we
      // care about most for our region scope.
      include_image_language: "en,null",
    },
  });
}

/** Normalised form of a title used for cross-source dedup.
 *  Lowercase, strip punctuation, collapse whitespace, drop a leading "the".
 *  Good enough to match "The Bear" vs "Bear, The" vs "THE BEAR" without
 *  being so lossy that distinct shows collide. */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
}

/** Search TMDB for a TV show by name. Returns the highest-ranked result
 *  that plausibly matches, or null. `year` is the show's first-air year
 *  (optional) — passing it dramatically improves match quality. */
export async function searchTvByName(
  query: string,
  year?: number,
): Promise<TmdbDiscoverItem | null> {
  const params: Record<string, string | number> = {
    query,
    language: "en-US",
    include_adult: "false",
    page: 1,
  };
  if (year && Number.isFinite(year)) {
    params.first_air_date_year = year;
  }
  try {
    const res = await tmdbFetch<{ results: TmdbDiscoverItem[] }>("/search/tv", {
      params,
    });
    if (!res.results || res.results.length === 0) return null;
    const normalized = normalizeTitle(query);
    // Prefer an exact normalized match on any of the top 5 results before
    // falling back to TMDB's popularity-sorted first result.
    const top = res.results.slice(0, 5);
    const exact = top.find((r) => normalizeTitle(r.name ?? r.title ?? "") === normalized);
    return exact ?? top[0] ?? null;
  } catch {
    return null;
  }
}

/** Search TMDB for a movie by name. Same semantics as `searchTvByName`
 *  but against the /search/movie endpoint. */
export async function searchMovieByName(
  query: string,
  year?: number,
): Promise<TmdbDiscoverItem | null> {
  const params: Record<string, string | number> = {
    query,
    language: "en-US",
    include_adult: "false",
    page: 1,
  };
  if (year && Number.isFinite(year)) {
    params.primary_release_year = year;
  }
  try {
    const res = await tmdbFetch<{ results: TmdbDiscoverItem[] }>("/search/movie", {
      params,
    });
    if (!res.results || res.results.length === 0) return null;
    const normalized = normalizeTitle(query);
    const top = res.results.slice(0, 5);
    const exact = top.find(
      (r) => normalizeTitle(r.title ?? r.name ?? "") === normalized,
    );
    return exact ?? top[0] ?? null;
  } catch {
    return null;
  }
}

/** Dispatch a TMDB search based on a media-type hint from a scraper.
 *  When the hint is "unknown" we try movie first (the streamer press
 *  pages are more movie-heavy) then fall back to TV. */
export async function searchByName(
  query: string,
  year: number | undefined,
  hint: "movie" | "tv" | "unknown",
): Promise<{ mediaType: "movie" | "tv"; item: TmdbDiscoverItem } | null> {
  if (hint === "movie") {
    const m = await searchMovieByName(query, year);
    if (m) return { mediaType: "movie", item: m };
    const t = await searchTvByName(query, year);
    return t ? { mediaType: "tv", item: t } : null;
  }
  if (hint === "tv") {
    const t = await searchTvByName(query, year);
    if (t) return { mediaType: "tv", item: t };
    const m = await searchMovieByName(query, year);
    return m ? { mediaType: "movie", item: m } : null;
  }
  const m = await searchMovieByName(query, year);
  if (m) return { mediaType: "movie", item: m };
  const t = await searchTvByName(query, year);
  return t ? { mediaType: "tv", item: t } : null;
}

async function fetchSeasonVideos(
  tvId: number,
  seasonNumber: number,
): Promise<TmdbVideo[]> {
  try {
    const res = await tmdbFetch<{ id: number; results: TmdbVideo[] }>(
      `/tv/${tvId}/season/${seasonNumber}/videos`,
      {
        params: {
          language: "en-US",
          include_video_language: "en,null",
        },
      },
    );
    return res.results || [];
  } catch {
    // Season-videos endpoint 404s for some shows; just fall back silently.
    return [];
  }
}

function dedupeById(releases: Release[]): Release[] {
  const seen = new Set<string>();
  const out: Release[] = [];
  for (const r of releases) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/** Top-level diagnostic surface exposed on /api/releases for debugging
 *  source coverage and configuration issues (especially Streaming
 *  Availability API wiring, which is silent by design). */
export interface ReleaseSourceDiagnostics {
  region: string;
  daysAhead: number;
  window: { from: string; to: string };
  tmdb: {
    discoverTasks: number;
    discoverFulfilled: number;
    discoverRejected: number;
    uniqueCandidates: number;
    candidatesVerifiedOriginal: number;
    detailFulfilled: number;
    detailRejected: number;
  };
  tvmaze: {
    episodes: number;
  };
  streamingAvailability: SaDiagnostics;
  watchmode: WatchmodeDiagnostics;
  scrapers: {
    perSource: ScraperDiagnostic[];
    injection: {
      attempted: number;
      resolved: number;
      matchedExisting: number;
      addedNew: number;
      unresolved: number;
      droppedOutsideWindow: number;
    };
    resolvedBySource: Record<string, number>;
  };
  releaseLoop: {
    entered: number;
    droppedDetailFailed: number;
    droppedPostFilter: number;
    droppedNoReleaseDate: number;
    droppedOutsideWindow: number;
    droppedNoProviders: number;
    kept: number;
    keptMovies: number;
    keptTv: number;
    /** Breakdown of kept items by media type × verifiedOriginal source,
     *  so we can see whether SA/company/network items are actually
     *  contributing to the output. */
    keptVerifiedOriginalMovies: number;
    keptVerifiedOriginalTv: number;
  };
  releasesAfterOriginalityFilter: number;
  releasesAfterDateClamp: number;
}

export interface FetchUpcomingReleasesResult {
  releases: Release[];
  diagnostics: ReleaseSourceDiagnostics;
}

/** Backward-compatible wrapper — returns just the releases. Used by the
 *  server component page.tsx so the UI doesn't have to know about
 *  diagnostics. */
export async function fetchUpcomingReleases(
  opts: FetchReleasesOptions = {},
): Promise<Release[]> {
  const { releases } = await fetchUpcomingReleasesWithDiagnostics(opts);
  return releases;
}

/** Full-fat entry point that returns both releases and diagnostics.
 *  /api/releases uses this to expose the diagnostics in the JSON body
 *  so the user can debug SA/TVmaze/TMDB wiring by curling the route. */
export async function fetchUpcomingReleasesWithDiagnostics(
  opts: FetchReleasesOptions = {},
): Promise<FetchUpcomingReleasesResult> {
  const region = (opts.region || getRegion()).toUpperCase();
  const daysAhead = opts.daysAhead ?? 90;
  // With Streaming Availability contributing hundreds of extra
  // candidates, the old cap of 500 was slicing off the SA-discovered
  // Netflix movies before they got details fetched. Raise to 2000 and
  // rely on verifiedOriginal sorting to keep the most trustworthy
  // candidates at the top of the list if we ever DO hit the ceiling.
  const maxItems = opts.maxItems ?? 2000;
  const includeMovies = opts.includeMovies ?? true;
  const includeTv = opts.includeTv ?? true;

  const now = new Date();
  const from = toYmd(now);
  const endDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const to = toYmd(endDate);

  // --- Phase 1: discovery ---------------------------------------------------
  // Two parallel passes per provider:
  //
  //   A) AVAILABILITY-BASED (watch_region + with_watch_providers): finds
  //      titles TMDB has flagged as available on the service in the region.
  //      This lags for upcoming content -- TMDB contributors often add the
  //      regional provider tag on/near release day -- so it alone misses
  //      many "coming soon" titles.
  //
  //   B) PRODUCTION-BASED (with_networks, TV only): finds TV shows whose
  //      network matches a hardcoded list per provider (Netflix = 213,
  //      Apple TV+ = 2552, etc). This catches originals long before the
  //      per-region watch_providers flag lands.
  //
  // Each task carries an `attributedProviderId` used by the discoveredFrom
  // fallback when TMDB's detail watch/providers response is empty.
  const MOVIE_PAGES = 5;
  const TV_POP_PAGES = 4;
  const TV_NEW_PAGES = 3;
  const NETWORK_POP_PAGES = 3;
  const NETWORK_NEW_PAGES = 3;
  const COMPANY_MOVIE_PAGES = 4;
  const RELEASE_TYPE_MOVIE_PAGES = 4;
  type DiscoverTask = DiscoverArgs & {
    mediaType: MediaType;
    attributedProviderId: number;
  };
  const discoverTasks: DiscoverTask[] = [];

  // --- C) Release-type pass (provider-agnostic movies) ---
  // attributedProviderId=0 means "unknown provider" — the detail fetch's
  // watch/providers response has to tell us which allowed service this
  // belongs to, or the release is dropped downstream.
  if (includeMovies) {
    for (let p = 1; p <= RELEASE_TYPE_MOVIE_PAGES; p++) {
      discoverTasks.push({
        mediaType: "movie",
        region,
        from,
        to,
        page: p,
        releaseType: "4|6",
        attributedProviderId: 0,
      });
    }
  }

  for (const provider of ALLOWED_PROVIDERS) {
    // --- A) Availability-based ---
    if (includeMovies) {
      for (let p = 1; p <= MOVIE_PAGES; p++) {
        discoverTasks.push({
          mediaType: "movie",
          region,
          from,
          to,
          page: p,
          providerId: provider.id,
          attributedProviderId: provider.id,
        });
      }
    }
    if (includeTv) {
      for (let p = 1; p <= TV_POP_PAGES; p++) {
        discoverTasks.push({
          mediaType: "tv",
          region,
          from,
          to,
          page: p,
          providerId: provider.id,
          attributedProviderId: provider.id,
        });
      }
      for (let p = 1; p <= TV_NEW_PAGES; p++) {
        discoverTasks.push({
          mediaType: "tv",
          region,
          from,
          to,
          page: p,
          providerId: provider.id,
          tvSort: "first_air_date.desc",
          attributedProviderId: provider.id,
        });
      }

      // --- B) Production-based (TV networks) ---
      if (provider.tvNetworkIds) {
        for (const networkId of provider.tvNetworkIds) {
          for (let p = 1; p <= NETWORK_POP_PAGES; p++) {
            discoverTasks.push({
              mediaType: "tv",
              region,
              from,
              to,
              page: p,
              networkId,
              attributedProviderId: provider.id,
            });
          }
          for (let p = 1; p <= NETWORK_NEW_PAGES; p++) {
            discoverTasks.push({
              mediaType: "tv",
              region,
              from,
              to,
              page: p,
              networkId,
              tvSort: "first_air_date.desc",
              attributedProviderId: provider.id,
            });
          }
        }
      }
    }

    // --- D) Production-based (movie companies) ---
    // This is the primary signal for movie ORIGINALS. Hitting
    // with_companies=<id> per production entity is far more precise than
    // relying on watch_providers lag for upcoming streaming movies.
    if (includeMovies && provider.movieCompanyIds) {
      for (const companyId of provider.movieCompanyIds) {
        for (let p = 1; p <= COMPANY_MOVIE_PAGES; p++) {
          discoverTasks.push({
            mediaType: "movie",
            region,
            from,
            to,
            page: p,
            companyId,
            attributedProviderId: provider.id,
          });
        }
      }
    }
  }

  // Run TMDB discovery, TVmaze /schedule/web, and Streaming Availability
  // /changes in parallel. None of them depend on each other's output at
  // this phase, so cold-fetch latency is max(A, B, C) rather than A+B+C.
  //
  // SA returns a { items, diagnostics } object. We still wrap the call in
  // a .catch in case an unexpected error escapes the client (it shouldn't
  // — the client captures errors into diagnostics.lastError — but defense
  // in depth).
  const emptySaDiagnostics: SaDiagnostics = {
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
  // Empty Watchmode diagnostics shell for graceful fallback when the
  // call rejects outright -- keeps the shape of the debug response
  // stable so consumers don't have to handle `undefined` legs.
  const emptyWatchmodeDiagnostics: WatchmodeDiagnostics = {
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
  const [
    discoverResults,
    tvmazeEpisodes,
    saResult,
    watchmodeResult,
    scraperResult,
  ] = await Promise.all([
    runWithConcurrency(discoverTasks, 10, (task) => discover(task)),
    includeTv
      ? fetchTvmazeWebSchedule(from, to, region).catch(() => [] as TvmazeEpisode[])
      : Promise.resolve([] as TvmazeEpisode[]),
    fetchStreamingAvailabilityUpcoming(region, ALLOWED_PROVIDER_IDS).catch(
      (err): SaFetchResult => ({
        items: [],
        diagnostics: {
          ...emptySaDiagnostics,
          callsAttempted: 1,
          callsFailed: 1,
          lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
      }),
    ),
    fetchWatchmodeUpcoming(from, to).catch(
      (err): WatchmodeFetchResult => ({
        items: [],
        diagnostics: {
          ...emptyWatchmodeDiagnostics,
          callsAttempted: 1,
          callsFailed: 1,
          lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
      }),
    ),
    runAllScrapers().catch(
      (err): ScraperResult => ({
        releases: [],
        diagnostics: [
          {
            source: "runAllScrapers",
            providerId: 0,
            url: "",
            fetched: false,
            httpStatus: null,
            itemsFound: 0,
            error: err instanceof Error ? err.message : String(err),
            samples: [],
            parseStrategy: null,
            htmlBytes: 0,
            fetchedHtmlSample: null,
            nextDataSample: null,
            scriptInventory: [],
          },
        ],
      }),
    ),
  ]);
  const saResults = saResult.items;
  const saDiagnostics = saResult.diagnostics;
  const watchmodeResults = watchmodeResult.items;
  const watchmodeDiagnostics = watchmodeResult.diagnostics;
  const scrapedReleases = scraperResult.releases;
  const scraperDiagnostics = scraperResult.diagnostics;

  // Track which allowed providers each candidate was discovered under. If
  // TMDB's watch/providers detail response later comes back empty for the
  // region, we use this as a fallback so the release still carries a
  // provider badge.
  type Candidate = {
    mediaType: MediaType;
    item: TmdbDiscoverItem;
    discoveredFrom: Set<number>;
    /** True if the candidate was discovered via a source that inherently
     *  verifies it is an original on one of our streamers:
     *  `with_companies` (movies), `with_networks` (TV), or the Streaming
     *  Availability /changes?target_type=upcoming feed. Items with this
     *  flag skip the post-detail production_companies filter. */
    verifiedOriginal: boolean;
    /** Release date hint (YYYY-MM-DD) from Streaming Availability's
     *  change entry timestamp. Used as the primary movie release date
     *  when present -- SA knows "X arrives on date Y" more reliably
     *  than TMDB's crowdsourced release_dates. */
    saReleaseDate: string | null;
    /** Season number from Watchmode for TV rows that reference a
     *  specific season drop. Used as a hint when fetching season-
     *  level poster art to fill in a missing show-level poster. */
    watchmodeSeasonNumber: number | null;
  };
  const candidatesByKey = new Map<string, Candidate>();
  discoverResults.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const task = discoverTasks[i];
    // company / network passes use TMDB's authoritative server-side
    // filter, so any item they return is by definition an original for
    // the corresponding streamer.
    const verifiedByTaskKind = task.companyId != null || task.networkId != null;
    for (const item of res.value.results) {
      const key = `${task.mediaType}-${item.id}`;
      const existing = candidatesByKey.get(key);
      // attributedProviderId === 0 is the sentinel for "unknown provider"
      // used by the release-type pass. We don't want the 0 to leak into
      // discoveredFrom, where it would bypass the ALLOWED_PROVIDER_ID_SET
      // filter and produce a bogus backfill entry.
      if (existing) {
        if (task.attributedProviderId !== 0) {
          existing.discoveredFrom.add(task.attributedProviderId);
        }
        if (verifiedByTaskKind) existing.verifiedOriginal = true;
      } else {
        candidatesByKey.set(key, {
          mediaType: task.mediaType,
          item,
          discoveredFrom: new Set(
            task.attributedProviderId !== 0 ? [task.attributedProviderId] : [],
          ),
          verifiedOriginal: verifiedByTaskKind,
          saReleaseDate: null,
          watchmodeSeasonNumber: null,
        });
      }
    }
  });
  // --- Phase 1a': Streaming Availability injection ------------------------
  // SA returns TMDB ids directly AND a reliable "coming on date X"
  // timestamp per change. We inject matches into candidatesByKey as
  // verifiedOriginal: true so they skip the downstream production_companies
  // filter -- SA's /changes?target_type=upcoming has already confirmed the
  // title is scheduled to land on the service, which is a stronger signal
  // than TMDB's crowdsourced production_companies field.
  if (saResults.length > 0) {
    for (const sa of saResults) {
      const key = `${sa.mediaType}-${sa.tmdbId}`;
      const existing = candidatesByKey.get(key);
      if (existing) {
        for (const pid of sa.providerIds) existing.discoveredFrom.add(pid);
        existing.verifiedOriginal = true;
        if (sa.releaseDate && !existing.saReleaseDate) {
          existing.saReleaseDate = sa.releaseDate;
        }
        continue;
      }
      const stubItem: TmdbDiscoverItem = {
        id: sa.tmdbId,
        overview: "",
        poster_path: null,
        backdrop_path: null,
        vote_average: 0,
        popularity: 0,
        genre_ids: [],
      };
      candidatesByKey.set(key, {
        mediaType: sa.mediaType,
        item: stubItem,
        discoveredFrom: new Set(sa.providerIds),
        verifiedOriginal: true,
        saReleaseDate: sa.releaseDate,
        watchmodeSeasonNumber: null,
      });
    }
  }

  // --- Phase 1a.5: Watchmode injection ------------------------------------
  // Watchmode's /releases/ endpoint is purpose-built for "upcoming
  // streaming releases per service" and returns TMDB ids plus actual
  // streamer release dates directly -- no title search required.
  //
  // Every Watchmode match is injected as `verifiedOriginal: true`. The
  // reasoning: the /releases/ feed is a curated upcoming-schedule, not
  // a catalog-additions feed, so by definition every entry is "coming
  // to this service on this date" — which is exactly what the user
  // wants to see. We deliberately do NOT gate on Watchmode's own
  // `is_original` flag because in practice it's very conservative
  // (only ~30% of entries in a typical refresh are flagged, missing
  // many true originals) and our downstream `production_companies`
  // filter is too strict to fill the gap on its own. Trusting the
  // feed unconditionally is what closes the Netflix-movie coverage
  // gap that motivated adding Watchmode in the first place.
  if (watchmodeResults.length > 0) {
    for (const wm of watchmodeResults) {
      const key = `${wm.mediaType}-${wm.tmdbId}`;
      const existing = candidatesByKey.get(key);
      if (existing) {
        for (const pid of wm.providerIds) existing.discoveredFrom.add(pid);
        existing.verifiedOriginal = true;
        if (wm.releaseDate && !existing.saReleaseDate) {
          existing.saReleaseDate = wm.releaseDate;
        }
        // Backfill the discover stub's poster_path from Watchmode
        // when TMDB discovery didn't carry one. Harmless when it did.
        if (wm.posterPath && !existing.item.poster_path) {
          existing.item.poster_path = wm.posterPath;
        }
        if (wm.seasonNumber != null && existing.watchmodeSeasonNumber == null) {
          existing.watchmodeSeasonNumber = wm.seasonNumber;
        }
        continue;
      }
      const stubItem: TmdbDiscoverItem = {
        id: wm.tmdbId,
        overview: "",
        poster_path: wm.posterPath,
        backdrop_path: null,
        vote_average: 0,
        popularity: 0,
        genre_ids: [],
      };
      candidatesByKey.set(key, {
        mediaType: wm.mediaType,
        item: stubItem,
        discoveredFrom: new Set(wm.providerIds),
        verifiedOriginal: true,
        saReleaseDate: wm.releaseDate,
        watchmodeSeasonNumber: wm.seasonNumber,
      });
    }
  }

  // --- Phase 1a'': Scraper injection --------------------------------------
  // Results from the per-streamer press/editorial scrapers (Netflix
  // Tudum, Disney+ press, Max press, Apple TV+ coming-soon, Prime Video
  // press, Peacock, Hulu press). Each scraped release has a title and
  // a scheduled release date from an authoritative source. We resolve
  // each title to a TMDB id via /search/{movie|tv} (cached 6h at the
  // fetch layer) and inject as a verifiedOriginal candidate with the
  // scraper's date as `saReleaseDate` (which the movie branch of the
  // release-building loop uses as its primary date source).
  //
  // Budget: the scraper search step is capped and concurrency-limited
  // to avoid spending the whole cold-fetch window on TMDB search calls.
  const scraperSearchCountsBySource = new Map<string, number>();
  const scraperInjectionStats = {
    attempted: 0,
    resolved: 0,
    matchedExisting: 0,
    addedNew: 0,
    unresolved: 0,
    droppedOutsideWindow: 0,
  };

  if (scrapedReleases.length > 0) {
    // Drop scraped releases whose date is already outside the window —
    // no point paying for a TMDB search we'd throw away downstream.
    const inWindow = scrapedReleases.filter(
      (s) => s.releaseDate >= from && s.releaseDate <= to,
    );
    scraperInjectionStats.droppedOutsideWindow =
      scrapedReleases.length - inWindow.length;

    // Cap and run the TMDB searches with bounded concurrency.
    const SCRAPER_SEARCH_CAP = 300;
    const toSearch = inWindow.slice(0, SCRAPER_SEARCH_CAP);
    scraperInjectionStats.attempted = toSearch.length;

    const searchResults = await runWithConcurrency(toSearch, 8, (s) =>
      searchByName(s.title, s.year, s.mediaType),
    );

    for (let i = 0; i < toSearch.length; i++) {
      const scraped = toSearch[i];
      const searchRes = searchResults[i];
      if (searchRes.status !== "fulfilled" || searchRes.value == null) {
        scraperInjectionStats.unresolved++;
        continue;
      }
      scraperInjectionStats.resolved++;
      scraperSearchCountsBySource.set(
        scraped.source,
        (scraperSearchCountsBySource.get(scraped.source) ?? 0) + 1,
      );
      const { mediaType: resolvedMediaType, item: resolvedItem } = searchRes.value;
      const key = `${resolvedMediaType}-${resolvedItem.id}`;
      const existing = candidatesByKey.get(key);
      if (existing) {
        existing.verifiedOriginal = true;
        existing.discoveredFrom.add(scraped.providerId);
        // Prefer the scraped date as authoritative for movies — press
        // sites publish the actual streamer release date.
        if (!existing.saReleaseDate) {
          existing.saReleaseDate = scraped.releaseDate;
        }
        scraperInjectionStats.matchedExisting++;
      } else {
        candidatesByKey.set(key, {
          mediaType: resolvedMediaType,
          item: resolvedItem,
          discoveredFrom: new Set([scraped.providerId]),
          verifiedOriginal: true,
          saReleaseDate: scraped.releaseDate,
          watchmodeSeasonNumber: null,
        });
        scraperInjectionStats.addedNew++;
      }
    }
  }

  // --- Phase 1b: TVmaze supplementation ------------------------------------
  // TVmaze's per-day /schedule/web is aggressively maintained for streaming
  // ("web channel") shows, so it catches upcoming TV that TMDB's availability
  // or network discovery passes miss. We match TVmaze shows to our existing
  // TMDB candidates by normalized title and, for unmatched shows, hit TMDB's
  // /search/tv endpoint to pull them into the candidate pool (capped so one
  // fetch can't blow through the API budget).
  if (tvmazeEpisodes.length > 0) {
    // 1. Index TMDB TV candidates by normalized title.
    const tmdbTvNameIndex = new Set<string>();
    for (const candidate of candidatesByKey.values()) {
      if (candidate.mediaType !== "tv") continue;
      const name = candidate.item.name ?? candidate.item.title;
      if (name) tmdbTvNameIndex.add(normalizeTitle(name));
    }

    // 2. Group TVmaze episodes by show and keep only those on an allowed
    //    web channel. Each show carries its provider attribution so we can
    //    backfill watch_providers later if TMDB has no regional data yet.
    type TvmazeShowGroup = {
      show: TvmazeShow;
      episodes: TvmazeEpisode[];
      providerId: number;
    };
    const tvmazeShows = new Map<number, TvmazeShowGroup>();
    for (const ep of tvmazeEpisodes) {
      const show = ep._embedded?.show;
      if (!show) continue;
      const providerId = mapTvmazeChannelToProviderId(show.webChannel?.name);
      if (providerId == null) continue;
      const entry = tvmazeShows.get(show.id);
      if (entry) {
        entry.episodes.push(ep);
      } else {
        tvmazeShows.set(show.id, { show, episodes: [ep], providerId });
      }
    }

    // 3. Skip shows already covered by TMDB discovery. Sort the rest by
    //    number of upcoming episodes descending so active shows get first
    //    crack at the search budget.
    const unmatched = Array.from(tvmazeShows.values())
      .filter((entry) => !tmdbTvNameIndex.has(normalizeTitle(entry.show.name)))
      .sort((a, b) => b.episodes.length - a.episodes.length);

    // 4. TMDB search budget: each unmatched show costs 1 search call +
    //    (downstream) 1 detail + possibly 1 season-videos call. Capping
    //    keeps cold-fetch latency bounded.
    const TVMAZE_SEARCH_CAP = 120;
    const toSearch = unmatched.slice(0, TVMAZE_SEARCH_CAP);

    const searchResults = await runWithConcurrency(toSearch, 8, async (entry) => {
      const year = entry.show.premiered
        ? parseInt(entry.show.premiered.slice(0, 4), 10)
        : undefined;
      return searchTvByName(entry.show.name, Number.isFinite(year) ? year : undefined);
    });

    // 5. Inject successful matches into candidatesByKey attributed to the
    //    TVmaze-derived provider. They then flow through the regular detail
    //    + season-videos pipeline.
    for (let i = 0; i < toSearch.length; i++) {
      const searchRes = searchResults[i];
      if (searchRes.status !== "fulfilled" || searchRes.value == null) continue;
      const tmdbItem = searchRes.value;
      const providerId = toSearch[i].providerId;
      const key = `tv-${tmdbItem.id}`;
      const existing = candidatesByKey.get(key);
      if (existing) {
        existing.discoveredFrom.add(providerId);
      } else {
        // TVmaze matches are not authoritative "is this an original" —
        // they confirm a show has an upcoming episode on the provider's
        // web channel, which is a strong signal but not equivalent to
        // production/network tagging. Run the post-detail check.
        candidatesByKey.set(key, {
          mediaType: "tv",
          item: tmdbItem,
          discoveredFrom: new Set([providerId]),
          verifiedOriginal: false,
          saReleaseDate: null,
          watchmodeSeasonNumber: null,
        });
      }
    }
  }

  const uniqueCandidates = Array.from(candidatesByKey.values());

  // --- Phase 2: detail fetches ---------------------------------------------
  // Sort so verifiedOriginal candidates come first -- if we ever hit the
  // cap they're the ones we most want to keep. Within the verified and
  // unverified groups, preserve insertion order so SA/company/network
  // candidates (which enter the map first) stay on top.
  const prioritized = [...uniqueCandidates].sort((a, b) => {
    if (a.verifiedOriginal === b.verifiedOriginal) return 0;
    return a.verifiedOriginal ? -1 : 1;
  });
  const capped = prioritized.slice(0, maxItems);

  const detailResults = await runWithConcurrency(capped, 25, (c) =>
    fetchDetails(c.mediaType, c.item.id),
  );

  // --- Phase 3: season-level videos + poster fallback (TV only) -----------
  // For TV entries whose next event is a specific season, also fetch that
  // season's videos. Season-level trailers are often stored only on the
  // season endpoint (not the top-level /tv/{id}/videos), which is why
  // "Season 1 Trailer" used to leak through for Season 3 premieres.
  //
  // Additionally, when the show-level poster_path is still null after
  // the images fallback, fetch `/tv/{id}/season/{n}` — which carries
  // `poster_path` — and use its poster. Season art is often uploaded
  // before the show-level art for new series.
  type SeasonExtra = {
    videos: TmdbVideo[];
    seasonPosterPath: string | null;
  };
  const seasonVideoResults = await runWithConcurrency(capped, 25, async (c, i): Promise<SeasonExtra | null> => {
    if (c.mediaType !== "tv") return null;
    const detail = detailResults[i];
    if (detail.status !== "fulfilled") return null;
    const season =
      detail.value.next_episode_to_air?.season_number ??
      c.watchmodeSeasonNumber;
    if (season == null || season <= 0) return null;
    const hasPoster =
      detail.value.poster_path != null ||
      pickPosterFromImages(detail.value.images) != null ||
      c.item.poster_path != null;
    // If we already have a poster, only fetch videos.
    if (hasPoster) {
      const videos = await fetchSeasonVideos(c.item.id, season);
      return { videos, seasonPosterPath: null };
    }
    // No poster yet: fetch the full season detail (which includes
    // poster_path AND videos) in one shot via append_to_response.
    try {
      const res = await tmdbFetch<{
        poster_path?: string | null;
        videos?: { results: TmdbVideo[] };
      }>(`/tv/${c.item.id}/season/${season}`, {
        params: {
          language: "en-US",
          append_to_response: "videos",
          include_video_language: "en,null",
        },
      });
      return {
        videos: res.videos?.results ?? [],
        seasonPosterPath: res.poster_path ?? null,
      };
    } catch {
      return null;
    }
  });

  // Counters for the release-loop drop reasons. Threaded into the
  // diagnostics object so the debug endpoint shows exactly where each
  // candidate died.
  const loopCounts = {
    entered: 0,
    droppedDetailFailed: 0,
    droppedPostFilter: 0,
    droppedNoReleaseDate: 0,
    droppedOutsideWindow: 0,
    droppedNoProviders: 0,
    kept: 0,
    keptMovies: 0,
    keptTv: 0,
    keptVerifiedOriginalMovies: 0,
    keptVerifiedOriginalTv: 0,
  };
  let candidatesVerifiedOriginal = 0;
  for (const c of capped) {
    if (c.verifiedOriginal) candidatesVerifiedOriginal++;
  }

  const releases: Release[] = [];
  for (let i = 0; i < capped.length; i++) {
    loopCounts.entered++;
    const candidate = capped[i];
    const { mediaType, item } = candidate;
    const detailRes = detailResults[i];
    if (detailRes.status !== "fulfilled") {
      loopCounts.droppedDetailFailed++;
      continue;
    }
    const d = detailRes.value;

    // ORIGINALITY GATE: items flagged `verifiedOriginal` (discovered via
    // `with_companies`, `with_networks`, or Streaming Availability's
    // per-provider /changes feed) are trusted -- the discovery source
    // itself already confirms the title is coming from the streamer,
    // which is a stronger signal than TMDB's crowdsourced
    // production_companies field. For those, we use discoveredFrom as
    // the provider attribution.
    //
    // For everything else (availability pass, release-type pass,
    // TVmaze-discovered), run the post-detail check against
    // production_companies / networks.
    let attributedProviderIds: Set<number>;
    if (candidate.verifiedOriginal) {
      attributedProviderIds = new Set(candidate.discoveredFrom);
    } else {
      attributedProviderIds = verifyAndAttributeOriginal(d, mediaType);
    }
    if (attributedProviderIds.size === 0) {
      loopCounts.droppedPostFilter++;
      continue;
    }

    const baseTitle = d.title || d.name || item.title || item.name || "Untitled";
    let title = baseTitle;

    // Choose the release date AND classify the "event kind":
    // - Movies: primary release date; kind = movie-release.
    // - TV: prefer next_episode_to_air.air_date so we surface upcoming seasons
    //   and episodes rather than the show's original launch date.
    //     - S1E1      -> series-premiere
    //     - S>1 E1    -> season-premiere
    //     - E>1       -> episode (mid-season; excluded from banner)
    //   If there is no next_episode_to_air but the first_air_date is in the
    //   future, treat as a brand-new series that simply has no schedule yet.
    let releaseDate: string | undefined;
    let highlightKind: HighlightKind;
    let highlightLabel: string | null = null;

    if (mediaType === "movie") {
      // Prefer the injected `saReleaseDate` when it's in window. This
      // is populated by Watchmode (authoritative), Streaming
      // Availability, or a scraper -- each of which tracks the actual
      // streamer release schedule better than TMDB's crowdsourced
      // release_dates. Fall through to pickMovieReleaseDate otherwise.
      const saDate = candidate.saReleaseDate;
      if (saDate && saDate >= from && saDate <= to) {
        releaseDate = saDate;
      } else {
        // For verified-original candidates, allow the primary release
        // date fallback even when the movie has theatrical entries
        // (Netflix Oscar-run titles, Max WB-theatrical-owned content,
        // Disney+ theatrical-tagged content -- all rightfully originals
        // in our model). For unverified candidates keep the strict
        // "no theatrical anywhere" rule to reject licensed theatrical
        // releases.
        releaseDate =
          pickMovieReleaseDate(d, region, from, to, candidate.verifiedOriginal) ??
          undefined;
      }
      highlightKind = "movie-release";
      highlightLabel = "New Movie";
    } else {
      const nextEp = d.next_episode_to_air;
      const saDate = candidate.saReleaseDate;
      // An in-window saReleaseDate from SA/Watchmode/scrapers is a
      // stronger signal than TMDB's next_episode_to_air when they
      // disagree, because those sources track the actual streamer
      // release schedule — TMDB's next_episode_to_air often lags for
      // upcoming seasons (set to the currently-airing season's next
      // episode, or null entirely when a new season hasn't been
      // entered yet). Prefer the TMDB schedule only when it points
      // to a premiere (E1) that's already in window; otherwise fall
      // back to saReleaseDate as a Season N Premiere.
      const nextEpAirDate =
        nextEp?.air_date != null ? nextEp.air_date : null;
      const nextEpInWindow =
        nextEpAirDate != null && nextEpAirDate >= from && nextEpAirDate <= to;
      const saInWindow = saDate != null && saDate >= from && saDate <= to;

      if (nextEpInWindow && nextEp && nextEpAirDate) {
        releaseDate = nextEpAirDate;
        if (nextEp.episode_number === 1 && nextEp.season_number === 1) {
          highlightKind = "series-premiere";
          highlightLabel = "Series Premiere";
          title = `${baseTitle} \u2014 Series Premiere`;
        } else if (nextEp.episode_number === 1) {
          highlightKind = "season-premiere";
          highlightLabel = `Season ${nextEp.season_number} Premiere`;
          title = `${baseTitle} \u2014 Season ${nextEp.season_number} Premiere`;
        } else {
          highlightKind = "episode";
          highlightLabel = null;
          title = `${baseTitle} \u2014 S${nextEp.season_number} \u00b7 E${nextEp.episode_number}`;
        }
      } else if (saInWindow && saDate) {
        // Watchmode / SA / scraper date: we don't know the exact
        // season number, so label as a generic season premiere. For
        // brand-new series with no prior aired seasons, the TMDB
        // first_air_date may equal saDate in which case it's really a
        // series premiere — we can't always tell them apart here, so
        // use "Season Premiere" as the conservative label.
        releaseDate = saDate;
        const firstAir = d.first_air_date || item.first_air_date;
        const isBrandNew =
          !firstAir || firstAir >= from || firstAir === saDate;
        if (isBrandNew) {
          highlightKind = "series-premiere";
          highlightLabel = "Series Premiere";
          title = `${baseTitle} \u2014 Series Premiere`;
        } else {
          highlightKind = "season-premiere";
          highlightLabel = "Season Premiere";
          title = `${baseTitle} \u2014 Season Premiere`;
        }
      } else if (nextEp?.air_date) {
        // Out-of-window TMDB schedule — use it anyway; the window
        // clamp below will drop it if truly out of range.
        releaseDate = nextEp.air_date;
        if (nextEp.episode_number === 1 && nextEp.season_number === 1) {
          highlightKind = "series-premiere";
          highlightLabel = "Series Premiere";
          title = `${baseTitle} \u2014 Series Premiere`;
        } else if (nextEp.episode_number === 1) {
          highlightKind = "season-premiere";
          highlightLabel = `Season ${nextEp.season_number} Premiere`;
          title = `${baseTitle} \u2014 Season ${nextEp.season_number} Premiere`;
        } else {
          highlightKind = "episode";
          highlightLabel = null;
          title = `${baseTitle} \u2014 S${nextEp.season_number} \u00b7 E${nextEp.episode_number}`;
        }
      } else {
        releaseDate = d.first_air_date || item.first_air_date;
        highlightKind = "series-premiere";
        highlightLabel = "Series Premiere";
        title = `${baseTitle} \u2014 Series Premiere`;
      }
    }

    if (!releaseDate) {
      loopCounts.droppedNoReleaseDate++;
      continue;
    }
    // Clamp to the requested window. TMDB's TV discover by air_date can return
    // shows whose *any* episode matches, but next_episode_to_air may be older
    // or further out than we asked for.
    if (releaseDate < from || releaseDate > to) {
      loopCounts.droppedOutsideWindow++;
      continue;
    }

    // Build the displayed provider list as the UNION of:
    //   (a) TMDB watch/providers entries filtered to our allow-list
    //       (real-time "where to watch" data from TMDB)
    //   (b) The attributedProviderIds we just verified via
    //       production_companies / networks
    // (a) alone would lose the badge when TMDB's per-region provider
    // data hasn't landed yet (common for upcoming originals). (b) alone
    // would ignore genuinely multi-service availability.
    const rawProviders = pickProviders(region, d["watch/providers"]);
    const providerMap = new Map<number, StreamingProvider>();
    for (const p of rawProviders) {
      if (ALLOWED_PROVIDER_ID_SET.has(p.id)) providerMap.set(p.id, p);
    }
    for (const id of attributedProviderIds) {
      if (!providerMap.has(id)) {
        providerMap.set(id, {
          id,
          name: ALLOWED_PROVIDER_NAME_BY_ID.get(id) ?? `Provider ${id}`,
          logoPath: ALLOWED_PROVIDER_LOGO[id] ?? null,
        });
      }
    }
    const providers = Array.from(providerMap.values());
    // Attribution guarantees a non-empty set -- verifyAndAttributeOriginal
    // already returned matches -- but keep the defensive drop.
    if (providers.length === 0) {
      loopCounts.droppedNoProviders++;
      continue;
    }

    loopCounts.kept++;
    if (mediaType === "movie") {
      loopCounts.keptMovies++;
      if (candidate.verifiedOriginal) loopCounts.keptVerifiedOriginalMovies++;
    } else {
      loopCounts.keptTv++;
      if (candidate.verifiedOriginal) loopCounts.keptVerifiedOriginalTv++;
    }

    const popularity = d.popularity ?? item.popularity ?? 0;
    const starPower = computeStarPower(d.credits?.cast);

    // Merge show-level and season-level videos, deduped by video id. Season
    // videos come first so that when two entries have equal scores, the
    // season-scoped one wins (tiebreak via sort stability).
    const showVideos = d.videos?.results ?? [];
    const seasonVideoRes = seasonVideoResults[i];
    const seasonExtra: SeasonExtra | null =
      seasonVideoRes?.status === "fulfilled" ? seasonVideoRes.value : null;
    const seasonVideos = seasonExtra?.videos ?? [];
    const mergedVideoMap = new Map<string, TmdbVideo>();
    for (const v of [...seasonVideos, ...showVideos]) {
      if (!mergedVideoMap.has(v.id)) mergedVideoMap.set(v.id, v);
    }
    const mergedVideos = Array.from(mergedVideoMap.values());
    const seasonNumber =
      mediaType === "tv"
        ? d.next_episode_to_air?.season_number ?? candidate.watchmodeSeasonNumber ?? null
        : null;

    // Poster resolution order:
    //   1. d.poster_path — TMDB detail's localised poster (en-US)
    //   2. images fallback — picks best available from /images append
    //   3. season poster — from /tv/{id}/season/{n} (new shows often
    //      have season art before the show-level poster)
    //   4. item.poster_path — discover stub / Watchmode's poster_url
    const posterPath =
      d.poster_path ??
      pickPosterFromImages(d.images) ??
      seasonExtra?.seasonPosterPath ??
      item.poster_path;
    const backdropPath =
      d.backdrop_path ??
      pickBackdropFromImages(d.images) ??
      item.backdrop_path;

    releases.push({
      id: `${mediaType}-${d.id}`,
      tmdbId: d.id,
      mediaType,
      title,
      baseTitle,
      overview: d.overview || item.overview || "",
      releaseDate,
      releaseTime: null, // TMDB doesn't expose a per-region time
      posterPath,
      backdropPath,
      voteAverage: d.vote_average ?? item.vote_average ?? 0,
      popularity,
      starPower,
      genres: (d.genres || []).map((g) => g.name),
      cast: pickCast(d.credits?.cast),
      trailer: pickTrailer(mergedVideos, { seasonNumber }),
      streamingProviders: providers,
      highlightKind,
      highlightLabel,
      tmdbUrl:
        mediaType === "movie"
          ? `https://www.themoviedb.org/movie/${d.id}`
          : `https://www.themoviedb.org/tv/${d.id}`,
    });
  }

  const deduped = dedupeById(releases).sort((a, b) =>
    a.releaseDate.localeCompare(b.releaseDate),
  );

  const diagnostics: ReleaseSourceDiagnostics = {
    region,
    daysAhead,
    window: { from, to },
    tmdb: {
      discoverTasks: discoverTasks.length,
      discoverFulfilled: discoverResults.filter((r) => r.status === "fulfilled").length,
      discoverRejected: discoverResults.filter((r) => r.status === "rejected").length,
      uniqueCandidates: uniqueCandidates.length,
      candidatesVerifiedOriginal,
      detailFulfilled: detailResults.filter((r) => r.status === "fulfilled").length,
      detailRejected: detailResults.filter((r) => r.status === "rejected").length,
    },
    tvmaze: {
      episodes: tvmazeEpisodes.length,
    },
    streamingAvailability: saDiagnostics,
    watchmode: watchmodeDiagnostics,
    scrapers: {
      perSource: scraperDiagnostics,
      injection: scraperInjectionStats,
      resolvedBySource: Object.fromEntries(scraperSearchCountsBySource),
    },
    releaseLoop: loopCounts,
    releasesAfterOriginalityFilter: releases.length,
    releasesAfterDateClamp: deduped.length,
  };

  return { releases: deduped, diagnostics };
}

export function tmdbImage(path: string | null, size: "w92" | "w154" | "w185" | "w342" | "w500" | "original" = "w342"): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
