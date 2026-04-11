"use client";

import { useMemo, useState } from "react";
import type { MediaType, Release, ReleasesResponse } from "@/lib/types";
import { ListView } from "./ListView";
import { CalendarView } from "./CalendarView";
import { ReleaseDetailModal } from "./ReleaseDetailModal";
import { Filters, type FilterState } from "./Filters";

type ViewMode = "list" | "calendar";

interface Props {
  initial: ReleasesResponse;
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

export function ReleasesApp({ initial }: Props) {
  const [view, setView] = useState<ViewMode>("list");
  const [filters, setFilters] = useState<FilterState>(() => defaultFilters(initial.releases));
  const [selected, setSelected] = useState<Release | null>(null);

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

      {selected && <ReleaseDetailModal release={selected} onClose={() => setSelected(null)} />}

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
