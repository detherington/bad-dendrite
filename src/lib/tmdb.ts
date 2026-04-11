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
  next_episode_to_air?: TmdbEpisodeInfo | null;
  last_episode_to_air?: TmdbEpisodeInfo | null;
  videos?: { results: TmdbVideo[] };
  credits?: { cast: TmdbCastEntry[] };
  "watch/providers"?: { results: Record<string, TmdbWatchProviderRegion> };
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
 * The only streaming services this app considers. Discovery, display, and
 * filtering are all scoped to this set. Adding/removing an entry changes
 * what users see AND how deep the catalog scan goes (fewer providers ==
 * more pages per provider within the same API budget).
 *
 * Each provider can also declare `tvNetworkIds`, which are TMDB TV network
 * IDs that correspond to the service's originals. We use those for a second
 * discovery pass (`with_networks=<id>`) to catch upcoming shows that aren't
 * yet flagged with regional watch_providers data -- TMDB's per-region
 * availability tagging lags for unreleased titles, but the network tag is
 * set at the show record itself and is populated as soon as the show is
 * entered in TMDB.
 */
interface AllowedProvider {
  id: number;
  name: string;
  tvNetworkIds?: ReadonlyArray<number>;
}

const ALLOWED_PROVIDERS: ReadonlyArray<AllowedProvider> = [
  { id: 8, name: "Netflix", tvNetworkIds: [213] },
  { id: 350, name: "Apple TV+", tvNetworkIds: [2552] },
  { id: 337, name: "Disney+", tvNetworkIds: [2739] },
  { id: 9, name: "Amazon Prime Video", tvNetworkIds: [1024] },
  { id: 15, name: "Hulu", tvNetworkIds: [453] },
  { id: 386, name: "Peacock Premium", tvNetworkIds: [3353] },
  { id: 1899, name: "Max", tvNetworkIds: [49, 3186] },
];

const ALLOWED_PROVIDER_IDS: ReadonlyArray<number> = ALLOWED_PROVIDERS.map((p) => p.id);
const ALLOWED_PROVIDER_ID_SET = new Set<number>(ALLOWED_PROVIDER_IDS);
const ALLOWED_PROVIDER_NAME_BY_ID = new Map<number, string>(
  ALLOWED_PROVIDERS.map((p) => [p.id, p.name]),
);

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
  /** Optional release-type filter (pipe-separated), e.g. "4|6" for
   *  Digital OR TV release. Movies only. */
  releaseType?: string;
  /** Override the default TV sort (popularity.desc) for a second pass. */
  tvSort?: "popularity.desc" | "first_air_date.desc";
}

async function discover(args: DiscoverArgs): Promise<TmdbDiscoverResponse> {
  const { mediaType, region, from, to, page, providerId, networkId, releaseType, tvSort } = args;
  const isMovie = mediaType === "movie";
  // Movies: filter and sort by primary_release_date (simple case).
  // TV: filter by `air_date` so we catch new SEASONS and EPISODES of existing
  //     series, not just first-ever series launches. TMDB doesn't expose an
  //     episode-level sort on /discover/tv, so sort by popularity and let the
  //     client code re-sort by the actual next-episode date.
  const useRegionalRelease = isMovie && releaseType != null;
  const params: Record<string, string | number> = {
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    sort_by: isMovie
      ? useRegionalRelease
        ? "release_date.asc"
        : "primary_release_date.asc"
      : tvSort ?? "popularity.desc",
    page,
  };
  if (providerId != null) {
    // Availability-based pass: requires watch_region. Filters to what TMDB
    // has flagged as currently available on the given service in the region.
    params.watch_region = region;
    params.with_watch_providers = providerId;
    params.with_watch_monetization_types = "flatrate|free|ads";
  } else if (networkId != null) {
    // Production-based pass: no watch_region. Filters by the TV network that
    // owns the show, so Netflix originals surface even when their per-region
    // watch_providers data hasn't been populated yet.
    params.with_networks = networkId;
  } else if (useRegionalRelease) {
    // Release-type pass (movies only): finds movies with a Digital (4) or
    // TV (6) release type in the region, regardless of whether TMDB has
    // populated per-region watch_providers yet. Catches upcoming streaming
    // movies that are entered in TMDB with release dates but not yet
    // flagged on a specific provider.
    params.region = region;
    params.with_release_type = releaseType as string;
  }
  if (isMovie) {
    if (useRegionalRelease) {
      // Regional release date window — used with `region` + release_type.
      params["release_date.gte"] = from;
      params["release_date.lte"] = to;
    } else {
      params["primary_release_date.gte"] = from;
      params["primary_release_date.lte"] = to;
    }
  } else {
    params["air_date.gte"] = from;
    params["air_date.lte"] = to;
  }
  const endpoint = isMovie ? "/discover/movie" : "/discover/tv";
  return tmdbFetch<TmdbDiscoverResponse>(endpoint, { params });
}

async function fetchDetails(mediaType: MediaType, id: number): Promise<TmdbDetails> {
  const endpoint = mediaType === "movie" ? `/movie/${id}` : `/tv/${id}`;
  return tmdbFetch<TmdbDetails>(endpoint, {
    params: {
      language: "en-US",
      append_to_response: "videos,credits,watch/providers",
      // Include videos whose language is English OR unset, so language-tagged
      // trailers don't get filtered out by the parent language=en-US param.
      include_video_language: "en,null",
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

export async function fetchUpcomingReleases(
  opts: FetchReleasesOptions = {},
): Promise<Release[]> {
  const region = (opts.region || getRegion()).toUpperCase();
  const daysAhead = opts.daysAhead ?? 90;
  const maxItems = opts.maxItems ?? 500;
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
  }

  // Run TMDB discovery and TVmaze /schedule/web in parallel. TVmaze has no
  // dependency on TMDB's response, so there's no reason to serialize.
  const [discoverResults, tvmazeEpisodes] = await Promise.all([
    runWithConcurrency(discoverTasks, 10, (task) => discover(task)),
    includeTv
      ? fetchTvmazeWebSchedule(from, to, region).catch(() => [] as TvmazeEpisode[])
      : Promise.resolve([] as TvmazeEpisode[]),
  ]);

  // Track which allowed providers each candidate was discovered under. If
  // TMDB's watch/providers detail response later comes back empty for the
  // region, we use this as a fallback so the release still carries a
  // provider badge.
  type Candidate = {
    mediaType: MediaType;
    item: TmdbDiscoverItem;
    discoveredFrom: Set<number>;
  };
  const candidatesByKey = new Map<string, Candidate>();
  discoverResults.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const task = discoverTasks[i];
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
      } else {
        candidatesByKey.set(key, {
          mediaType: task.mediaType,
          item,
          discoveredFrom: new Set(
            task.attributedProviderId !== 0 ? [task.attributedProviderId] : [],
          ),
        });
      }
    }
  });
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
        candidatesByKey.set(key, {
          mediaType: "tv",
          item: tmdbItem,
          discoveredFrom: new Set([providerId]),
        });
      }
    }
  }

  const uniqueCandidates = Array.from(candidatesByKey.values());

  // --- Phase 2: detail fetches ---------------------------------------------
  // Keep a hard cap so a very crowded region can't run away, but the cap is
  // now generous enough to comfortably cover every MAJOR_PROVIDER_IDS entry.
  const capped = uniqueCandidates.slice(0, maxItems);

  const detailResults = await runWithConcurrency(capped, 15, (c) =>
    fetchDetails(c.mediaType, c.item.id),
  );

  // --- Phase 3: season-level videos (TV only) ------------------------------
  // For TV entries whose next event is a specific season, also fetch that
  // season's videos. Season-level trailers are often stored only on the
  // season endpoint (not the top-level /tv/{id}/videos), which is why
  // "Season 1 Trailer" used to leak through for Season 3 premieres.
  const seasonVideoResults = await runWithConcurrency(capped, 15, async (c, i) => {
    if (c.mediaType !== "tv") return null;
    const detail = detailResults[i];
    if (detail.status !== "fulfilled") return null;
    const season = detail.value.next_episode_to_air?.season_number;
    if (season == null || season <= 0) return null;
    return fetchSeasonVideos(c.item.id, season);
  });

  const releases: Release[] = [];
  for (let i = 0; i < capped.length; i++) {
    const { mediaType, item } = capped[i];
    const detailRes = detailResults[i];
    if (detailRes.status !== "fulfilled") continue;
    const d = detailRes.value;

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
      releaseDate = d.release_date || item.release_date;
      highlightKind = "movie-release";
      highlightLabel = "New Movie";
    } else {
      const nextEp = d.next_episode_to_air;
      if (nextEp?.air_date) {
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

    if (!releaseDate) continue;
    // Clamp to the requested window. TMDB's TV discover by air_date can return
    // shows whose *any* episode matches, but next_episode_to_air may be older
    // or further out than we asked for.
    if (releaseDate < from || releaseDate > to) continue;

    // Restrict to the ALLOWED_PROVIDERS list. If TMDB's watch/providers
    // response has no allowed entry for this item (data lag), fall back to
    // the set of allowed providers the discovery phase saw this item on.
    const rawProviders = pickProviders(region, d["watch/providers"]);
    let providers = rawProviders.filter((p) => ALLOWED_PROVIDER_ID_SET.has(p.id));
    if (providers.length === 0) {
      providers = Array.from(capped[i].discoveredFrom)
        .filter((id) => ALLOWED_PROVIDER_ID_SET.has(id))
        .map((id) => ({
          id,
          name: ALLOWED_PROVIDER_NAME_BY_ID.get(id) ?? `Provider ${id}`,
          logoPath: null,
        }));
    }
    // If we somehow still have nothing, skip the release entirely — it
    // doesn't belong to any of our tracked services.
    if (providers.length === 0) continue;

    const popularity = d.popularity ?? item.popularity ?? 0;
    const starPower = computeStarPower(d.credits?.cast);

    // Merge show-level and season-level videos, deduped by video id. Season
    // videos come first so that when two entries have equal scores, the
    // season-scoped one wins (tiebreak via sort stability).
    const showVideos = d.videos?.results ?? [];
    const seasonVideoRes = seasonVideoResults[i];
    const seasonVideos =
      seasonVideoRes?.status === "fulfilled" && seasonVideoRes.value
        ? seasonVideoRes.value
        : [];
    const mergedVideoMap = new Map<string, TmdbVideo>();
    for (const v of [...seasonVideos, ...showVideos]) {
      if (!mergedVideoMap.has(v.id)) mergedVideoMap.set(v.id, v);
    }
    const mergedVideos = Array.from(mergedVideoMap.values());
    const seasonNumber =
      mediaType === "tv" ? d.next_episode_to_air?.season_number ?? null : null;

    releases.push({
      id: `${mediaType}-${d.id}`,
      tmdbId: d.id,
      mediaType,
      title,
      baseTitle,
      overview: d.overview || item.overview || "",
      releaseDate,
      releaseTime: null, // TMDB doesn't expose a per-region time
      posterPath: d.poster_path ?? item.poster_path,
      backdropPath: d.backdrop_path ?? item.backdrop_path,
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

  return dedupeById(releases).sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
}

export function tmdbImage(path: string | null, size: "w92" | "w154" | "w185" | "w342" | "w500" | "original" = "w342"): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
