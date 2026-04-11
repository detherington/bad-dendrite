"use client";

import { useMemo, useState } from "react";
import type { Release } from "@/lib/types";
import { tmdbImage } from "@/lib/tmdb-client";

interface Props {
  releases: Release[];
  onSelect: (r: Release) => void;
}

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function buildGrid(year: number, month: number): Date[] {
  const first = startOfMonth(year, month);
  // Start grid on Sunday before (or equal to) the 1st
  const startWeekday = first.getDay();
  const gridStart = new Date(year, month, 1 - startWeekday);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }
  return days;
}

export function CalendarView({ releases, onSelect }: Props) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Pick initial month from the first release, or today
  const initial = useMemo(() => {
    const ref = releases[0]
      ? new Date(releases[0].releaseDate + "T00:00:00")
      : today;
    return { year: ref.getFullYear(), month: ref.getMonth() };
  }, [releases]);

  const [cursor, setCursor] = useState(initial);

  const byDate = useMemo(() => {
    const map = new Map<string, Release[]>();
    for (const r of releases) {
      const bucket = map.get(r.releaseDate) || [];
      bucket.push(r);
      map.set(r.releaseDate, bucket);
    }
    return map;
  }, [releases]);

  const grid = useMemo(() => buildGrid(cursor.year, cursor.month), [cursor]);
  const todayYmd = toYmd(today);

  const goPrev = () => {
    setCursor((c) => {
      const m = c.month - 1;
      return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
    });
  };
  const goNext = () => {
    setCursor((c) => {
      const m = c.month + 1;
      return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
    });
  };
  const goToday = () => setCursor({ year: today.getFullYear(), month: today.getMonth() });

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/40">
      <div className="flex items-center justify-between border-b border-ink-800 p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goPrev}
            className="rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1 text-sm text-ink-200 hover:border-ink-500"
            aria-label="Previous month"
          >
            &larr;
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs uppercase tracking-wide text-ink-200 hover:border-ink-500"
          >
            Today
          </button>
          <button
            type="button"
            onClick={goNext}
            className="rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1 text-sm text-ink-200 hover:border-ink-500"
            aria-label="Next month"
          >
            &rarr;
          </button>
        </div>
        <h2 className="text-base font-semibold text-ink-100">
          {monthLabel(cursor.year, cursor.month)}
        </h2>
        <div className="text-xs text-ink-400">{releases.length} total</div>
      </div>

      <div className="grid grid-cols-7 border-b border-ink-800 text-center text-[11px] font-medium uppercase tracking-wide text-ink-400">
        {weekdays.map((w) => (
          <div key={w} className="px-2 py-2">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {grid.map((date, idx) => {
          const ymd = toYmd(date);
          const inMonth = date.getMonth() === cursor.month;
          const isToday = ymd === todayYmd;
          const items = byDate.get(ymd) || [];
          return (
            <div
              key={idx}
              className={`min-h-[120px] border-b border-r border-ink-800 p-1.5 ${
                idx % 7 === 0 ? "border-l" : ""
              } ${inMonth ? "bg-ink-900/30" : "bg-ink-950/60"}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] ${
                    isToday
                      ? "bg-sky-500 font-semibold text-white"
                      : inMonth
                        ? "text-ink-200"
                        : "text-ink-500"
                  }`}
                >
                  {date.getDate()}
                </span>
                {items.length > 0 && (
                  <span className="text-[10px] text-ink-400">{items.length}</span>
                )}
              </div>
              <div className="mt-1 space-y-1">
                {items.slice(0, 3).map((r) => {
                  const poster = tmdbImage(r.posterPath, "w92");
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onSelect(r)}
                      className="flex w-full items-center gap-1.5 rounded border border-ink-800 bg-ink-900 px-1.5 py-1 text-left text-[11px] text-ink-100 hover:border-ink-500"
                      title={r.title}
                    >
                      {poster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={poster}
                          alt=""
                          className="h-6 w-4 shrink-0 rounded-sm object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <span
                          className={`h-6 w-4 shrink-0 rounded-sm ${
                            r.mediaType === "movie" ? "bg-sky-500/40" : "bg-violet-500/40"
                          }`}
                        />
                      )}
                      <span className="truncate">{r.title}</span>
                    </button>
                  );
                })}
                {items.length > 3 && (
                  <button
                    type="button"
                    onClick={() => onSelect(items[3])}
                    className="block w-full rounded px-1.5 text-left text-[10px] text-ink-400 hover:text-ink-200"
                  >
                    +{items.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
