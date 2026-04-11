import { Suspense } from "react";
import { ReleasesApp } from "@/components/ReleasesApp";
import { fetchUpcomingReleases, getRegion, TmdbConfigError } from "@/lib/tmdb";
import type { ReleasesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

export default async function Page() {
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

  return (
    <Suspense>
      <ReleasesApp initial={result.data} />
    </Suspense>
  );
}
