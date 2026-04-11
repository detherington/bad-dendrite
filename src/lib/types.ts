export type MediaType = "movie" | "tv";

/**
 * What kind of "event" this release represents. Used to power the Featured
 * banner, which shows entirely new shows and true season premieres but
 * excludes mid-season episodes of already-running shows.
 *
 * - series-premiere: brand new TV series (S1E1)
 * - season-premiere: new season of an existing series (S>1, episode 1)
 * - movie-release:   upcoming streaming movie release
 * - episode:         mid-season weekly episode drop (excluded from banner)
 */
export type HighlightKind =
  | "series-premiere"
  | "season-premiere"
  | "movie-release"
  | "episode";

export interface StreamingProvider {
  id: number;
  name: string;
  logoPath: string | null;
}

export interface CastMember {
  id: number;
  name: string;
  character: string | null;
  profilePath: string | null;
  popularity: number;
}

export interface Trailer {
  key: string;
  site: string;
  name: string;
  url: string;
}

export interface Release {
  id: string;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  /** Title without the "— Season N Premiere" annotation. */
  baseTitle: string;
  overview: string;
  releaseDate: string; // ISO YYYY-MM-DD
  releaseTime: string | null; // HH:MM (if derivable)
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number;
  /** TMDB popularity rolling score. Higher = more buzz. */
  popularity: number;
  /** Sum of the top 3 cast popularities - rough "star power" signal. */
  starPower: number;
  genres: string[];
  cast: CastMember[];
  trailer: Trailer | null;
  streamingProviders: StreamingProvider[];
  highlightKind: HighlightKind;
  /** Short label for the Featured banner, e.g. "Season 3 Premiere". */
  highlightLabel: string | null;
  tmdbUrl: string;
}

export interface ReleasesResponse {
  fetchedAt: string;
  region: string;
  releases: Release[];
}
