"use client";

import { useMemo } from "react";
import type { Release } from "@/lib/types";
import { ReleaseCard } from "./ReleaseCard";

interface Props {
  releases: Release[];
  onSelect: (r: Release) => void;
}

function formatDayHeading(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function daysFromNow(iso: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso + "T00:00:00");
  const diff = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 0) return `${Math.abs(diff)}d ago`;
  if (diff < 7) return `In ${diff}d`;
  if (diff < 30) return `In ${Math.round(diff / 7)}w`;
  return `In ${Math.round(diff / 30)}mo`;
}

export function ListView({ releases, onSelect }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<string, Release[]>();
    for (const r of releases) {
      const bucket = map.get(r.releaseDate) || [];
      bucket.push(r);
      map.set(r.releaseDate, bucket);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [releases]);

  if (grouped.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-ink-700 bg-ink-900/30 p-12 text-center text-sm text-ink-400">
        No releases match your filters.
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {grouped.map(([date, items]) => (
        <section key={date}>
          <div className="mb-3 flex items-baseline justify-between border-b border-ink-800 pb-2">
            <h2 className="text-lg font-semibold text-ink-100">{formatDayHeading(date)}</h2>
            <span className="text-xs uppercase tracking-wide text-ink-400">
              {daysFromNow(date)} &middot; {items.length}{" "}
              {items.length === 1 ? "release" : "releases"}
            </span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((r) => (
              <ReleaseCard key={r.id} release={r} onClick={() => onSelect(r)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
