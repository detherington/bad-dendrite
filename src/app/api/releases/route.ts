import { NextResponse } from "next/server";
import { fetchUpcomingReleases, getRegion, TmdbConfigError } from "@/lib/tmdb";
import type { ReleasesResponse } from "@/lib/types";

export const revalidate = 21600; // 6 hours

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const daysAhead = Number(searchParams.get("days") ?? 90);
  const region = (searchParams.get("region") || getRegion()).toUpperCase();
  const includeMovies = searchParams.get("movies") !== "0";
  const includeTv = searchParams.get("tv") !== "0";

  try {
    const releases = await fetchUpcomingReleases({
      daysAhead: Number.isFinite(daysAhead) ? daysAhead : 90,
      region,
      includeMovies,
      includeTv,
    });
    const payload: ReleasesResponse = {
      fetchedAt: new Date().toISOString(),
      region,
      releases,
    };
    return NextResponse.json(payload, {
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
