"use client";

import type { Release } from "@/lib/types";
import { tmdbImage } from "@/lib/tmdb-client";

interface Props {
  release: Release;
  onClick: () => void;
  compact?: boolean;
}

export function ReleaseCard({ release, onClick, compact = false }: Props) {
  const poster = tmdbImage(release.posterPath, compact ? "w185" : "w342");
  const stars = release.cast.slice(0, 3).map((c) => c.name).join(", ");

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full gap-4 rounded-xl border border-ink-800 bg-ink-900/60 p-3 text-left transition hover:border-ink-600 hover:bg-ink-800/60"
    >
      <div className="relative h-[132px] w-[88px] shrink-0 overflow-hidden rounded-md bg-ink-800">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt={release.title}
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] uppercase text-ink-400">
            No poster
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold text-ink-50">{release.title}</h3>
          <MediaBadge type={release.mediaType} />
          {release.voteAverage > 0 && (
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              &#9733; {release.voteAverage.toFixed(1)}
            </span>
          )}
        </div>

        {release.genres.length > 0 && (
          <div className="mt-1 truncate text-xs text-ink-300">{release.genres.slice(0, 3).join(" \u00b7 ")}</div>
        )}

        {stars && (
          <div className="mt-1 truncate text-xs text-ink-400">
            <span className="text-ink-500">With </span>
            {stars}
          </div>
        )}

        {!compact && release.overview && (
          <p className="mt-2 line-clamp-2 text-xs text-ink-300">{release.overview}</p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          {release.streamingProviders.slice(0, 6).map((p) => {
            const logo = tmdbImage(p.logoPath, "w92");
            return (
              <span
                key={p.id}
                title={p.name}
                className="flex h-6 w-6 items-center justify-center overflow-hidden rounded bg-ink-800 ring-1 ring-ink-700"
              >
                {logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logo} alt={p.name} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="text-[9px] text-ink-300">{p.name.slice(0, 2)}</span>
                )}
              </span>
            );
          })}
          {release.streamingProviders.length > 6 && (
            <span className="text-[11px] text-ink-400">+{release.streamingProviders.length - 6}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function MediaBadge({ type }: { type: Release["mediaType"] }) {
  const isMovie = type === "movie";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        isMovie ? "bg-sky-500/15 text-sky-300" : "bg-violet-500/15 text-violet-300"
      }`}
    >
      {isMovie ? "Movie" : "TV"}
    </span>
  );
}
