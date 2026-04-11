export type MediaType = "movie" | "tv";

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
  overview: string;
  releaseDate: string; // ISO YYYY-MM-DD
  releaseTime: string | null; // HH:MM (if derivable)
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number;
  genres: string[];
  cast: CastMember[];
  trailer: Trailer | null;
  streamingProviders: StreamingProvider[];
  tmdbUrl: string;
}

export interface ReleasesResponse {
  fetchedAt: string;
  region: string;
  releases: Release[];
}
