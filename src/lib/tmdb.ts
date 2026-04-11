import type {
  CastMember,
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
  genres: TmdbGenre[];
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
    }));
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
  const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
  const sortField = mediaType === "movie" ? "primary_release_date.asc" : "first_air_date.asc";
  const params: Record<string, string | number> = {
    include_adult: "false",
    include_video: "false",
    language: "en-US",
    sort_by: sortField,
    watch_region: region,
    with_watch_monetization_types: "flatrate|free|ads",
    page,
    [`${dateField}.gte`]: from,
    [`${dateField}.lte`]: to,
  };
  const endpoint = mediaType === "movie" ? "/discover/movie" : "/discover/tv";
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
  const maxItems = opts.maxItems ?? 120;
  const includeMovies = opts.includeMovies ?? true;
  const includeTv = opts.includeTv ?? true;

  const now = new Date();
  const from = toYmd(now);
  const endDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const to = toYmd(endDate);

  const discoverCalls: Array<Promise<TmdbDiscoverResponse>> = [];
  if (includeMovies) {
    discoverCalls.push(discover("movie", region, from, to, 1));
    discoverCalls.push(discover("movie", region, from, to, 2));
  }
  if (includeTv) {
    discoverCalls.push(discover("tv", region, from, to, 1));
    discoverCalls.push(discover("tv", region, from, to, 2));
  }

  const discoverResults = await Promise.allSettled(discoverCalls);

  type Candidate = { mediaType: MediaType; item: TmdbDiscoverItem };
  const candidates: Candidate[] = [];
  let resultIdx = 0;
  if (includeMovies) {
    for (let i = 0; i < 2; i++) {
      const r = discoverResults[resultIdx++];
      if (r.status === "fulfilled") {
        for (const item of r.value.results) candidates.push({ mediaType: "movie", item });
      }
    }
  }
  if (includeTv) {
    for (let i = 0; i < 2; i++) {
      const r = discoverResults[resultIdx++];
      if (r.status === "fulfilled") {
        for (const item of r.value.results) candidates.push({ mediaType: "tv", item });
      }
    }
  }

  // Sort by release date ascending and cap to maxItems before detail fetches
  candidates.sort((a, b) => {
    const da = a.item.release_date || a.item.first_air_date || "";
    const db = b.item.release_date || b.item.first_air_date || "";
    return da.localeCompare(db);
  });

  const capped = candidates.slice(0, maxItems);

  const detailResults = await Promise.allSettled(
    capped.map((c) => fetchDetails(c.mediaType, c.item.id)),
  );

  const releases: Release[] = [];
  for (let i = 0; i < capped.length; i++) {
    const { mediaType, item } = capped[i];
    const detailRes = detailResults[i];
    if (detailRes.status !== "fulfilled") continue;
    const d = detailRes.value;

    const title = d.title || d.name || item.title || item.name || "Untitled";
    const releaseDate = d.release_date || d.first_air_date || item.release_date || item.first_air_date;
    if (!releaseDate) continue;

    const providers = pickProviders(region, d["watch/providers"]);
    // Only include releases that have at least one streaming provider in the region
    if (providers.length === 0) continue;

    releases.push({
      id: `${mediaType}-${d.id}`,
      tmdbId: d.id,
      mediaType,
      title,
      overview: d.overview || item.overview || "",
      releaseDate,
      releaseTime: null, // TMDB doesn't expose a per-region time
      posterPath: d.poster_path ?? item.poster_path,
      backdropPath: d.backdrop_path ?? item.backdrop_path,
      voteAverage: d.vote_average ?? item.vote_average ?? 0,
      genres: (d.genres || []).map((g) => g.name),
      cast: pickCast(d.credits?.cast),
      trailer: pickTrailer(d.videos?.results),
      streamingProviders: providers,
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
