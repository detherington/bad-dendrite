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

function pickTrailer(videos: TmdbVideo[] | undefined): Trailer | null {
  if (!videos || videos.length === 0) return null;
  const youtube = videos.filter((v) => v.site === "YouTube");
  const trailers = youtube.filter((v) => v.type === "Trailer");
  const teasers = youtube.filter((v) => v.type === "Teaser");
  const pool = trailers.length ? trailers : teasers.length ? teasers : youtube;
  const official = pool.filter((v) => v.official);
  const chosen = (official.length ? official : pool).sort((a, b) =>
    (b.published_at || "").localeCompare(a.published_at || ""),
  )[0];
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

async function discover(
  mediaType: MediaType,
  region: string,
  from: string,
  to: string,
  page: number,
): Promise<TmdbDiscoverResponse> {
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
    sort_by: isMovie ? "primary_release_date.asc" : "popularity.desc",
    watch_region: region,
    with_watch_monetization_types: "flatrate|free|ads",
    page,
  };
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
    },
  });
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
  const maxItems = opts.maxItems ?? 240;
  const includeMovies = opts.includeMovies ?? true;
  const includeTv = opts.includeTv ?? true;
  const pagesPerType = 3;

  const now = new Date();
  const from = toYmd(now);
  const endDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const to = toYmd(endDate);

  const discoverCalls: Array<Promise<TmdbDiscoverResponse>> = [];
  if (includeMovies) {
    for (let p = 1; p <= pagesPerType; p++) {
      discoverCalls.push(discover("movie", region, from, to, p));
    }
  }
  if (includeTv) {
    for (let p = 1; p <= pagesPerType; p++) {
      discoverCalls.push(discover("tv", region, from, to, p));
    }
  }

  const discoverResults = await Promise.allSettled(discoverCalls);

  type Candidate = { mediaType: MediaType; item: TmdbDiscoverItem };
  const candidates: Candidate[] = [];
  let resultIdx = 0;
  if (includeMovies) {
    for (let i = 0; i < pagesPerType; i++) {
      const r = discoverResults[resultIdx++];
      if (r.status === "fulfilled") {
        for (const item of r.value.results) candidates.push({ mediaType: "movie", item });
      }
    }
  }
  if (includeTv) {
    for (let i = 0; i < pagesPerType; i++) {
      const r = discoverResults[resultIdx++];
      if (r.status === "fulfilled") {
        for (const item of r.value.results) candidates.push({ mediaType: "tv", item });
      }
    }
  }

  // Dedupe candidates by (mediaType, id) before spending detail-fetch budget.
  const seenCandidate = new Set<string>();
  const uniqueCandidates = candidates.filter((c) => {
    const key = `${c.mediaType}-${c.item.id}`;
    if (seenCandidate.has(key)) return false;
    seenCandidate.add(key);
    return true;
  });

  const capped = uniqueCandidates.slice(0, maxItems);

  const detailResults = await Promise.allSettled(
    capped.map((c) => fetchDetails(c.mediaType, c.item.id)),
  );

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
      trailer: pickTrailer(d.videos?.results),
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
