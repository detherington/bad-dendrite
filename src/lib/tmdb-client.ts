// Client-safe helpers. Anything in ./tmdb.ts may touch process.env and
// should not be imported from client components.

export type TmdbImageSize = "w92" | "w154" | "w185" | "w342" | "w500" | "original";

export function tmdbImage(path: string | null, size: TmdbImageSize = "w342"): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
