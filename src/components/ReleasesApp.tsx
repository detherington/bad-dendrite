"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MediaType, Release, ReleasesResponse } from "@/lib/types";
import { ListView } from "./ListView";
import { CalendarView } from "./CalendarView";
import { ReleaseDetailModal } from "./ReleaseDetailModal";
import { Filters, type FilterState } from "./Filters";
import { FeaturedBanner } from "./FeaturedBanner";

type ViewMode = "list" | "calendar";

interface Props {
  initial: ReleasesResponse;
  /** Optional release id from the `?r=` query param. When present the
   *  matching release is opened as a modal on mount, so shared links
   *  land directly on the record. */
  initialSelectedId?: string;
}

/** Read the `r` query param from the current URL. Safe on the server
 *  (returns null) thanks to the typeof guard. */
function readSelectedIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("r");
}

/** Update the URL so it matches the currently selected release.
 *  Uses replaceState so we don't spam the browser history when the
 *  user scrolls through several releases in a row. */
function syncSelectedToUrl(id: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const current = url.searchParams.get("r");
  if (id === current) return;
  if (id) {
    url.searchParams.set("r", id);
  } else {
    url.searchParams.delete("r");
  }
  window.history.replaceState(null, "", url.toString());
}

function defaultFilters(releases: Release[]): FilterState {
  return {
    mediaType: "all",
    providerIds: [],
    query: "",
    allProviders: collectProviders(releases),
  };
}

function collectProviders(releases: Release[]) {
  const map = new Map<number, { id: number; name: string; logoPath: string | null }>();
  for (const r of releases) {
    for (const p of r.streamingProviders) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function ReleasesApp({ initial, initialSelectedId }: Props) {
  const [view, setView] = useState<ViewMode>("list");
  const [filters, setFilters] = useState<FilterState>(() => defaultFilters(initial.releases));
  const [selected, setSelected] = useState<Release | null>(() => {
    if (!initialSelectedId) return null;
    return initial.releases.find((r) => r.id === initialSelectedId) ?? null;
  });

  // Keep the URL in sync with the selection so the current view is
  // always shareable. Runs only when `selected.id` actually changes.
  useEffect(() => {
    syncSelectedToUrl(selected?.id ?? null);
  }, [selected]);

  // Respond to history navigation (back/forward buttons, or another
  // tab/link updating the URL) by re-reading the `r` param.
  useEffect(() => {
    function onPopState() {
      const id = readSelectedIdFromUrl();
      if (!id) {
        setSelected(null);
        return;
      }
      const match = initial.releases.find((r) => r.id === id);
      if (match) setSelected(match);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [initial.releases]);

  const handleClose = useCallback(() => setSelected(null), []);

  const filtered = useMemo(() => {
    return initial.releases.filter((r) => {
      if (filters.mediaType !== "all" && r.mediaType !== filters.mediaType) return false;
      if (filters.providerIds.length > 0) {
        const set = new Set(filters.providerIds);
        if (!r.streamingProviders.some((p) => set.has(p.id))) return false;
      }
      if (filters.query.trim()) {
        const q = filters.query.trim().toLowerCase();
        const hay = `${r.title} ${r.overview} ${r.cast.map((c) => c.name).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [initial.releases, filters]);

  const counts = useMemo(() => {
    const movies = filtered.filter((r) => r.mediaType === "movie").length;
    const tv = filtered.filter((r) => r.mediaType === "tv").length;
    return { movies, tv, total: filtered.length };
  }, [filtered]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-50 sm:text-3xl">
            Streaming Releases
          </h1>
          <p className="mt-1 text-sm text-ink-300">
            Upcoming in {initial.region} &middot; {counts.total} titles ({counts.movies} movies,{" "}
            {counts.tv} shows)
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </header>

      <FeaturedBanner releases={initial.releases} onSelect={setSelected} />

      <Filters
        filters={filters}
        onChange={setFilters}
        totalCount={initial.releases.length}
        filteredCount={filtered.length}
      />

      <div className="mt-6">
        {view === "list" ? (
          <ListView releases={filtered} onSelect={setSelected} />
        ) : (
          <CalendarView releases={filtered} onSelect={setSelected} />
        )}
      </div>

      {selected && <ReleaseDetailModal release={selected} onClose={handleClose} />}

      <footer className="mt-12 border-t border-ink-800 pt-6 text-xs text-ink-400">
        Data provided by{" "}
        <a
          className="underline hover:text-ink-200"
          href="https://www.themoviedb.org/"
          target="_blank"
          rel="noreferrer"
        >
          The Movie Database (TMDB)
        </a>
        . This product uses the TMDB API but is not endorsed or certified by TMDB.
      </footer>
    </main>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
      {(["list", "calendar"] as ViewMode[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`px-4 py-2 text-sm font-medium capitalize transition ${
            view === v ? "bg-ink-700 text-ink-50" : "text-ink-300 hover:text-ink-100"
          }`}
          aria-pressed={view === v}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

// Re-export so the filter bar can provide the type
export type { MediaType };
