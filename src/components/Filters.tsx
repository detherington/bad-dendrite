"use client";

import { useState } from "react";
import type { MediaType, StreamingProvider } from "@/lib/types";
import { tmdbImage } from "@/lib/tmdb-client";

export interface FilterState {
  mediaType: MediaType | "all";
  providerIds: number[];
  query: string;
  allProviders: StreamingProvider[];
}

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  totalCount: number;
  filteredCount: number;
}

export function Filters({ filters, onChange, totalCount, filteredCount }: Props) {
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);

  const toggleProvider = (id: number) => {
    const set = new Set(filters.providerIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange({ ...filters, providerIds: Array.from(set) });
  };

  const clearProviders = () => onChange({ ...filters, providerIds: [] });

  const selectedProviderNames = filters.providerIds
    .map((id) => filters.allProviders.find((p) => p.id === id)?.name)
    .filter(Boolean) as string[];

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/60 p-3">
      <div className="inline-flex overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
        {(["all", "movie", "tv"] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => onChange({ ...filters, mediaType: type })}
            className={`px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition ${
              filters.mediaType === type
                ? "bg-ink-700 text-ink-50"
                : "text-ink-300 hover:text-ink-100"
            }`}
          >
            {type === "all" ? "All" : type === "movie" ? "Movies" : "TV"}
          </button>
        ))}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setProviderPickerOpen((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-xs font-medium text-ink-200 hover:border-ink-500"
        >
          {filters.providerIds.length === 0
            ? "All providers"
            : `${filters.providerIds.length} provider${
                filters.providerIds.length === 1 ? "" : "s"
              }`}
          <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.24 4.38a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" />
          </svg>
        </button>
        {providerPickerOpen && (
          <div
            className="absolute left-0 top-full z-30 mt-2 max-h-80 w-72 overflow-auto rounded-xl border border-ink-700 bg-ink-900 p-2 shadow-2xl"
            onMouseLeave={() => setProviderPickerOpen(false)}
          >
            <div className="flex items-center justify-between px-2 pb-2 text-xs text-ink-300">
              <span>Streaming providers</span>
              {filters.providerIds.length > 0 && (
                <button
                  type="button"
                  onClick={clearProviders}
                  className="text-ink-200 underline hover:text-ink-50"
                >
                  Clear
                </button>
              )}
            </div>
            <ul className="space-y-1">
              {filters.allProviders.map((p) => {
                const checked = filters.providerIds.includes(p.id);
                const logo = tmdbImage(p.logoPath, "w92");
                return (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-ink-100 hover:bg-ink-800">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProvider(p.id)}
                        className="h-4 w-4 rounded border-ink-600 bg-ink-950"
                      />
                      {logo && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={logo}
                          alt=""
                          className="h-5 w-5 rounded object-cover"
                          loading="lazy"
                        />
                      )}
                      <span className="truncate">{p.name}</span>
                    </label>
                  </li>
                );
              })}
              {filters.allProviders.length === 0 && (
                <li className="px-2 py-3 text-xs text-ink-400">No providers found.</li>
              )}
            </ul>
          </div>
        )}
      </div>

      <div className="relative flex-1 min-w-[180px]">
        <input
          type="search"
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          placeholder="Search title, cast, description..."
          className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-ink-100 placeholder:text-ink-400 focus:border-ink-500 focus:outline-none"
        />
      </div>

      <div className="ml-auto text-xs text-ink-400">
        Showing {filteredCount} of {totalCount}
      </div>

      {selectedProviderNames.length > 0 && (
        <div className="flex w-full flex-wrap gap-1.5 pt-2">
          {selectedProviderNames.map((name) => (
            <span
              key={name}
              className="rounded-full bg-ink-800 px-2.5 py-0.5 text-[11px] text-ink-100"
            >
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
