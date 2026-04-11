import { NextResponse } from "next/server";
import {
  fetchUpcomingReleasesWithDiagnostics,
  getRegion,
  TmdbConfigError,
} from "@/lib/tmdb";

export const revalidate = 21600; // 6 hours

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const daysAhead = Number(searchParams.get("days") ?? 90);
  const region = (searchParams.get("region") || getRegion()).toUpperCase();
  const includeMovies = searchParams.get("movies") !== "0";
  const includeTv = searchParams.get("tv") !== "0";
  const debug = searchParams.get("debug") === "1";

  try {
    const { releases, diagnostics } = await fetchUpcomingReleasesWithDiagnostics({
      daysAhead: Number.isFinite(daysAhead) ? daysAhead : 90,
      region,
      includeMovies,
      includeTv,
    });
    // Serialize diagnostics: SaDiagnostics contains a Set-less shape,
    // but the top-level JSON serializer handles primitives cleanly.
    const body = debug
      ? {
          fetchedAt: new Date().toISOString(),
          region,
          releasesCount: releases.length,
          sources: diagnostics,
          // Keep the array tiny in debug mode so the diagnostic payload
          // is easy to read in a browser tab.
          sampleReleases: releases.slice(0, 5).map((r) => ({
            id: r.id,
            title: r.baseTitle,
            mediaType: r.mediaType,
            releaseDate: r.releaseDate,
            providers: r.streamingProviders.map((p) => p.name),
            highlightKind: r.highlightKind,
          })),
        }
      : {
          fetchedAt: new Date().toISOString(),
          region,
          releases,
          sources: diagnostics,
        };
    return NextResponse.json(body, {
      headers: {
        "cache-control": "public, s-maxage=21600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    if (err instanceof TmdbConfigError) {
      return NextResponse.json(
        { error: err.message, code: "tmdb_config_missing" },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
