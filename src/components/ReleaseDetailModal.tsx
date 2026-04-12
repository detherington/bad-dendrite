"use client";

import { useEffect, useState } from "react";
import type { Release } from "@/lib/types";
import { tmdbImage } from "@/lib/tmdb-client";

interface Props {
  release: Release;
  onClose: () => void;
}

/** Build the canonical shareable URL for a release based on the current
 *  origin + path. We don't trust window.location.search since the user
 *  might have extra UI state in the query string someday. */
function buildShareUrl(releaseId: string): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.searchParams.set("r", releaseId);
  return url.toString();
}

function formatFullDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function ReleaseDetailModal({ release, onClose }: Props) {
  const [shareState, setShareState] = useState<"idle" | "copied" | "error">("idle");

  // Reset the Share button feedback whenever a different release is shown.
  useEffect(() => {
    setShareState("idle");
  }, [release.id]);

  async function handleShare() {
    const url = buildShareUrl(release.id);
    if (!url) return;

    // Prefer the native share sheet on mobile / supported desktops.
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav && typeof nav.share === "function") {
      try {
        await nav.share({ title: release.baseTitle, url });
        return;
      } catch (err) {
        // User cancelled the share sheet — not an error, just fall back
        // to clipboard so desktop users get "Copied!" feedback.
        if ((err as Error | null)?.name === "AbortError") return;
      }
    }

    try {
      await nav?.clipboard?.writeText(url);
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2000);
    } catch {
      setShareState("error");
      window.setTimeout(() => setShareState("idle"), 2500);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const backdrop = tmdbImage(release.backdropPath, "original");
  const poster =
    tmdbImage(release.posterPath, "w500") ??
    tmdbImage(release.backdropPath, "w500");
  const trailerEmbed = release.trailer
    ? `https://www.youtube.com/embed/${release.trailer.key}`
    : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/80 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={release.title}
    >
      <div
        className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-ink-700 bg-ink-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative h-56 w-full sm:h-72">
          {backdrop ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={backdrop} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-ink-800 to-ink-900" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/60 to-transparent" />
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 rounded-full border border-ink-600 bg-ink-950/70 px-3 py-1 text-xs text-ink-200 hover:bg-ink-900"
          >
            Close &times;
          </button>
        </div>

        <div className="relative -mt-20 flex flex-col gap-6 p-6 sm:flex-row">
          {poster && (
            <div className="mx-auto shrink-0 sm:mx-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={poster}
                alt={release.title}
                className="h-auto w-40 rounded-lg border border-ink-700 shadow-xl"
              />
            </div>
          )}
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold text-ink-50">{release.title}</h2>
              <span
                className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                  release.mediaType === "movie"
                    ? "bg-sky-500/20 text-sky-300"
                    : "bg-violet-500/20 text-violet-300"
                }`}
              >
                {release.mediaType === "movie" ? "Movie" : "TV"}
              </span>
              {release.voteAverage > 0 && (
                <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-medium text-amber-300">
                  &#9733; {release.voteAverage.toFixed(1)}
                </span>
              )}
            </div>

            <div className="mt-1 text-sm text-ink-300">
              {formatFullDate(release.releaseDate)}
              {release.releaseTime && ` \u00b7 ${release.releaseTime}`}
            </div>

            {release.genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {release.genres.map((g) => (
                  <span
                    key={g}
                    className="rounded-full border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {release.overview && (
              <p className="mt-3 text-sm leading-relaxed text-ink-200">{release.overview}</p>
            )}

            {release.streamingProviders.length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Where to watch
                </h3>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {release.streamingProviders.map((p) => {
                    const logo = tmdbImage(p.logoPath, "w92");
                    return (
                      <li
                        key={p.id}
                        className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100"
                      >
                        {logo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logo} alt="" className="h-5 w-5 rounded object-cover" />
                        )}
                        {p.name}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {release.trailer && (
                <a
                  href={release.trailer.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-400"
                >
                  Watch trailer
                </a>
              )}
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 text-sm text-ink-100 hover:bg-ink-800 disabled:opacity-60"
                aria-label="Share link to this release"
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                {shareState === "copied"
                  ? "Link copied"
                  : shareState === "error"
                    ? "Copy failed"
                    : "Share"}
              </button>
              <a
                href={release.tmdbUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 text-sm text-ink-100 hover:bg-ink-800"
              >
                View on TMDB
              </a>
            </div>
          </div>
        </div>

        {release.cast.length > 0 && (
          <div className="border-t border-ink-800 px-6 py-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Cast</h3>
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
              {release.cast.map((c) => {
                const profile = tmdbImage(c.profilePath, "w185");
                return (
                  <li key={c.id} className="text-center">
                    <div className="mx-auto h-20 w-20 overflow-hidden rounded-full border border-ink-700 bg-ink-800">
                      {profile ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={profile} alt={c.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-400">
                          No photo
                        </div>
                      )}
                    </div>
                    <div className="mt-2 text-xs font-medium text-ink-100">{c.name}</div>
                    {c.character && (
                      <div className="text-[11px] text-ink-400">{c.character}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {trailerEmbed && (
          <div className="border-t border-ink-800 px-6 py-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Trailer</h3>
            <div className="mt-3 aspect-video overflow-hidden rounded-lg border border-ink-800 bg-black">
              <iframe
                src={trailerEmbed}
                title={`${release.title} trailer`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="h-full w-full"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
