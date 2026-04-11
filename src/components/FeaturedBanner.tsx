"use client";

import { useMemo } from "react";
import type { HighlightKind, Release } from "@/lib/types";
import { tmdbImage } from "@/lib/tmdb-client";

interface Props {
  releases: Release[];
  onSelect: (r: Release) => void;
}

function daysFromNow(iso: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso + "T00:00:00");
  const diff = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 0 && diff < 7) return `In ${diff} days`;
  if (diff > 0) return `In ${Math.round(diff / 7)}w`;
  return "";
}

function formatShortDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Ranking score: mixes TMDB popularity, star power, and vote average.
 *  All three are loose signals — multiplying by (voteAverage + 6) / 10 nudges
 *  well-reviewed things up without dominating a brand new release that has
 *  no votes yet. */
function featureScore(r: Release): number {
  const voteBoost = (r.voteAverage > 0 ? r.voteAverage + 6 : 7) / 10;
  return (r.popularity + r.starPower * 0.4) * voteBoost;
}

const HIGHLIGHT_BADGE_STYLES: Record<HighlightKind, { label: string; className: string }> = {
  "series-premiere": {
    label: "Series Premiere",
    className: "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40",
  },
  "season-premiere": {
    label: "Season Premiere",
    className: "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/40",
  },
  "movie-release": {
    label: "New Movie",
    className: "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40",
  },
  episode: {
    label: "Episode",
    className: "bg-ink-700 text-ink-200",
  },
};

export function FeaturedBanner({ releases, onSelect }: Props) {
  const featured = useMemo(() => {
    return releases
      // Exclude mid-season episodes — only true premieres and new movies.
      .filter((r) => r.highlightKind !== "episode")
      .sort((a, b) => featureScore(b) - featureScore(a))
      .slice(0, 8);
  }, [releases]);

  if (featured.length === 0) return null;

  return (
    <section
      className="relative mb-6 rounded-2xl border border-ink-800 bg-gradient-to-br from-ink-900 via-ink-900/80 to-ink-950 p-4 sm:p-5"
      aria-label="Featured upcoming releases"
    >
      <header className="mb-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-300/90">
            &#9733; Featured
          </span>
          <h2 className="text-sm font-semibold text-ink-100 sm:text-base">
            Coming soon &mdash; premieres &amp; headline movies
          </h2>
        </div>
        <span className="hidden text-[11px] text-ink-400 sm:inline">
          Scroll &rarr;
        </span>
      </header>

      <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
        {featured.map((r) => {
          const backdrop = tmdbImage(r.backdropPath, "w500") || tmdbImage(r.posterPath, "w500");
          const badge = r.highlightKind !== "episode" && HIGHLIGHT_BADGE_STYLES[r.highlightKind];
          const stars = r.cast.slice(0, 3).map((c) => c.name).join(", ");
          return (
            <button
              type="button"
              key={r.id}
              onClick={() => onSelect(r)}
              className="group relative aspect-[16/9] w-[280px] shrink-0 snap-start overflow-hidden rounded-xl border border-ink-800 bg-ink-900 text-left transition hover:border-ink-500 sm:w-[340px]"
              title={r.baseTitle}
            >
              {backdrop ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={backdrop}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
                  loading="lazy"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-ink-800 to-ink-950" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-black/10" />

              {badge && (
                <span
                  className={`absolute left-3 top-3 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badge.className}`}
                >
                  {r.highlightLabel || badge.label}
                </span>
              )}

              <div className="absolute inset-x-3 bottom-3 text-white">
                <h3 className="line-clamp-2 text-sm font-semibold leading-tight drop-shadow sm:text-base">
                  {r.baseTitle}
                </h3>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-white/80">
                  <span className="font-medium text-white">
                    {formatShortDate(r.releaseDate)}
                  </span>
                  {daysFromNow(r.releaseDate) && (
                    <>
                      <span aria-hidden>&middot;</span>
                      <span>{daysFromNow(r.releaseDate)}</span>
                    </>
                  )}
                  {r.voteAverage > 0 && (
                    <>
                      <span aria-hidden>&middot;</span>
                      <span className="text-amber-300">
                        &#9733; {r.voteAverage.toFixed(1)}
                      </span>
                    </>
                  )}
                </div>
                {stars && (
                  <div className="mt-0.5 line-clamp-1 text-[11px] text-white/70">{stars}</div>
                )}
                <div className="mt-2 flex items-center gap-1.5">
                  {r.streamingProviders.slice(0, 5).map((p) => {
                    const logo = tmdbImage(p.logoPath, "w92");
                    return (
                      <span
                        key={p.id}
                        title={p.name}
                        className="flex h-5 w-5 items-center justify-center overflow-hidden rounded bg-ink-950/80 ring-1 ring-white/20"
                      >
                        {logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logo} alt={p.name} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="text-[8px] text-white/80">{p.name.slice(0, 2)}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
