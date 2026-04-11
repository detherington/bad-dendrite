import type {
  CastMember,
  HighlightKind,
  MediaType,
  Release,
  StreamingProvider,
  Trailer,
} from "./types";

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
 * TMDB watch-provider IDs for the streamers we explicitly fan out against.
 * Provider-agnostic /discover sorts globally by popularity, which means low-
 * profile titles from any single service (unscripted, docs, international,
 * mid-tier originals) never make the top pages. Fetching per provider gives
 * each service a guaranteed allocation so Netflix doesn't have to compete
 * with Prime Video for the same 60 slots.
 */
const MAJOR_PROVIDER_IDS: ReadonlyArray<number> = [
  8, // Netflix
  9, // Amazon Prime Video
  337, // Disney Plus
  1899, // Max (HBO)
  384, // HBO Max (legacy — still returns data in some regions)
  15, // Hulu
  350, // Apple TV+
  531, // Paramount+
  386, // Peacock Premium
  283, // Crunchyroll
  387, // Peacock Premium Plus
  1770, // Paramount+ with Showtime
];

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
  /** Optional TMDB provider id to scope to a single streamer. */
  providerId?: number;
  /** Override the default TV sort (popularity.desc) for a second pass. */
  tvSort?: "popularity.desc" | "first_air_date.desc";
}

async function discover(args: DiscoverArgs): Promise<TmdbDiscoverResponse> {
  const { mediaType, region, from, to, page, providerId, tvSort } = args;
  const isMovie = mediaType === "movie";
  // Movies: filter and sort by primary_release_date (simple case).
  // TV: filter by `air_date` so we catch new SEASONS and EPISODES of existing
  //     series, not just first-ever series launches. TMDB doesn't expose an
  //     episode-level sort on /discover/tv, so sort by popularity and let the
  //     client code re-sort by the actual next-episode date.
  const params: Record<string, string | number> = {
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    sort_by: isMovie ? "primary_release_date.asc" : tvSort ?? "popularity.desc",
    watch_region: region,
    with_watch_monetization_types: "flatrate|free|ads",
    page,
  };
  if (providerId != null) {
    params.with_watch_providers = providerId;
  }
  if (isMovie) {
    params["primary_release_date.gte"] = from;
    params["primary_release_date.lte"] = to;
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
  // We build a task list of discover calls:
  //   (a) Generic region-wide queries (3 pages per media type) to catch the
  //       long tail of smaller providers we don't explicitly enumerate.
  //   (b) Per-provider queries against MAJOR_PROVIDER_IDS (2 pages per
  //       (provider x media-type)). This guarantees each major streamer its
  //       own allocation instead of competing globally with blockbusters for
  //       the top 60 slots.
  //   (c) A second TV pass sorted by first_air_date.desc, to surface brand
  //       new series that popularity sort misses.
  const GENERIC_PAGES = 3;
  const PROVIDER_PAGES = 2;
  type DiscoverTask = DiscoverArgs & { mediaType: MediaType };
  const discoverTasks: DiscoverTask[] = [];

  if (includeMovies) {
    for (let p = 1; p <= GENERIC_PAGES; p++) {
      discoverTasks.push({ mediaType: "movie", region, from, to, page: p });
    }
  }
  if (includeTv) {
    for (let p = 1; p <= GENERIC_PAGES; p++) {
      discoverTasks.push({ mediaType: "tv", region, from, to, page: p });
    }
    // Second pass sorted by first_air_date.desc for new-series coverage.
    for (let p = 1; p <= 2; p++) {
      discoverTasks.push({
        mediaType: "tv",
        region,
        from,
        to,
        page: p,
        tvSort: "first_air_date.desc",
      });
    }
  }

  for (const providerId of MAJOR_PROVIDER_IDS) {
    if (includeMovies) {
      for (let p = 1; p <= PROVIDER_PAGES; p++) {
        discoverTasks.push({ mediaType: "movie", region, from, to, page: p, providerId });
      }
    }
    if (includeTv) {
      for (let p = 1; p <= PROVIDER_PAGES; p++) {
        discoverTasks.push({ mediaType: "tv", region, from, to, page: p, providerId });
      }
    }
  }

  const discoverResults = await runWithConcurrency(discoverTasks, 10, (task) =>
    discover(task),
  );

  type Candidate = { mediaType: MediaType; item: TmdbDiscoverItem };
  const candidatesByKey = new Map<string, Candidate>();
  discoverResults.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const mediaType = discoverTasks[i].mediaType;
    for (const item of res.value.results) {
      const key = `${mediaType}-${item.id}`;
      if (!candidatesByKey.has(key)) {
        candidatesByKey.set(key, { mediaType, item });
      }
    }
  });
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

    const providers = pickProviders(region, d["watch/providers"]);
    // We intentionally keep items whose provider list is empty for the region:
    // the discover call already filtered by streaming monetization, so these
    // ARE on a streaming service -- TMDB just hasn't populated the logos yet.

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
