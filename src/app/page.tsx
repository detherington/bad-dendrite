import { Suspense } from "react";
import { ReleasesApp } from "@/components/ReleasesApp";
import { fetchUpcomingReleases, getRegion, TmdbConfigError } from "@/lib/tmdb";
import type { ReleasesResponse } from "@/lib/types";

// Don't prerender at build time (avoids build failure when TMDB env vars are
// absent locally). The data fetch itself is wrapped in `unstable_cache` (6h
// TTL) at the tmdb.ts layer, so only the first request after expiry pays
// the full ~20-30s pipeline cost — every subsequent request serves a
// prebuilt Release[] in milliseconds. Stale-while-revalidate semantics
// ensure no user ever sees the full cold fetch after the initial deploy.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function loadReleases(): Promise<
  { ok: true; data: ReleasesResponse } | { ok: false; error: string; code?: string }
> {
  try {
    const region = getRegion();
    const releases = await fetchUpcomingReleases({ region });
    return {
      ok: true,
      data: { fetchedAt: new Date().toISOString(), region, releases },
    };
  } catch (err) {
    if (err instanceof TmdbConfigError) {
      return { ok: false, error: err.message, code: "tmdb_config_missing" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Server component that awaits the data fetch. Kept in a separate
 *  component so the outer Page can render a loading skeleton via
 *  Suspense while this streams in. */
async function ReleasesData({ initialSelectedId }: { initialSelectedId?: string }) {
  const result = await loadReleases();

  if (!result.ok) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-2xl font-semibold text-ink-50">Streaming Releases</h1>
        <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-100">
          <p className="font-medium">Could not load releases.</p>
          <p className="mt-2 text-red-200/90">{result.error}</p>
          {result.code === "tmdb_config_missing" && (
            <div className="mt-4 space-y-2 text-red-100/90">
              <p>Set up a TMDB API key:</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Create a free account at{" "}
                  <a className="underline" href="https://www.themoviedb.org/signup">
                    themoviedb.org
                  </a>
                  .
                </li>
                <li>
                  Generate an API key or read access token at{" "}
                  <a className="underline" href="https://www.themoviedb.org/settings/api">
                    Settings &rarr; API
                  </a>
                  .
                </li>
                <li>
                  Copy <code className="rounded bg-black/30 px-1">.env.example</code> to{" "}
                  <code className="rounded bg-black/30 px-1">.env.local</code> and fill it in.
                </li>
                <li>
                  Restart <code className="rounded bg-black/30 px-1">npm run dev</code>.
                </li>
              </ol>
            </div>
          )}
        </div>
      </main>
    );
  }

  return <ReleasesApp initial={result.data} initialSelectedId={initialSelectedId} />;
}

/** Skeleton shown while ReleasesData streams in. Matches the real
 *  layout so the page shell doesn't shift when data lands. */
function ReleasesLoading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink-50 sm:text-3xl">Streaming Releases</h1>
        <div className="h-8 w-32 animate-pulse rounded-full bg-ink-800" />
      </div>
      <div className="mb-6 h-28 animate-pulse rounded-2xl bg-ink-900" />
      <div className="mb-4 flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-8 w-20 animate-pulse rounded-full bg-ink-800" />
        ))}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex gap-4 rounded-xl border border-ink-800 bg-ink-900/60 p-3"
          >
            <div className="h-[132px] w-[88px] shrink-0 animate-pulse rounded-md bg-ink-800" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="h-5 w-3/4 animate-pulse rounded bg-ink-800" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-ink-800" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-ink-800" />
              <div className="mt-auto h-6 w-20 animate-pulse rounded bg-ink-800" />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-6 text-center text-xs text-ink-500">
        Fetching upcoming releases&hellip;
      </p>
    </main>
  );
}

export default function Page({
  searchParams,
}: {
  searchParams?: { r?: string | string[] };
}) {
  const rawR = searchParams?.r;
  const initialSelectedId = Array.isArray(rawR) ? rawR[0] : rawR;

  return (
    <Suspense fallback={<ReleasesLoading />}>
      <ReleasesData initialSelectedId={initialSelectedId} />
    </Suspense>
  );
}
