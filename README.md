# Streaming Releases

A personal web app that shows upcoming streaming movie and TV show release
dates, with both **calendar** and **list** views. Each release card shows the
title, release date, streaming service, stars, poster, and — where available —
a trailer and full cast.

Data comes from [TMDB](https://www.themoviedb.org/) via its official API.

## Features

- **List view** grouped by day with relative time (Today, Tomorrow, In 3d, ...).
- **Calendar view** with a month grid and day-level pills for each release.
- **Filters** by media type (Movies / TV), streaming provider, or a free-text
  search across title, cast, and overview.
- **Detail modal** with backdrop, poster, overview, cast, providers, and an
  embedded YouTube trailer.
- **Region-aware** streaming provider lookups (default `US`, configurable).
- Server-side data fetching so your API key never reaches the browser.

## Getting started

### 1. Get a TMDB API key

1. Sign up at [themoviedb.org](https://www.themoviedb.org/signup).
2. Go to **Settings &rarr; API** and request a developer key.
3. Copy either the **API Key (v3 auth)** or the **API Read Access Token (v4)**.

### 2. Configure environment

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```
# Pick ONE of these:
TMDB_READ_TOKEN=<your v4 read access token>
TMDB_API_KEY=<your v3 api key>

# Optional: ISO 3166-1 country code for provider lookups
TMDB_REGION=US

# Optional: Streaming Availability API via RapidAPI. When set, the app
# supplements TMDB discovery with Movie of the Night's per-provider
# "upcoming additions" feed — the biggest single lift to Netflix /
# HBO / Apple TV+ coverage for "coming soon" titles that TMDB hasn't
# tagged with a regional provider yet.
STREAMING_AVAILABILITY_API_KEY=<your RapidAPI key>

# Optional: Watchmode API. When set, the app also pulls from
# Watchmode's /releases/ endpoint, which is purpose-built for
# "upcoming streaming releases per service" and returns TMDB ids +
# actual streamer release dates. 1,000 req/mo free tier; we call it
# once per 24h cache window.
WATCHMODE_API_KEY=<your Watchmode API key>
```

### Data sources

Discovery is layered across several free and paid APIs, each targeting
a different coverage gap. The app gracefully degrades if an optional
source is not configured.

| Source                          | Required | What it fills in                                                                                                         |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| TMDB `/discover/movie` + `/discover/tv` | Yes   | Base catalog: per-provider `watch_providers` + production-based `with_networks` + digital `with_release_type=4\|6` passes |
| TVmaze `/schedule/web`          | No (free, no key) | Weekly episode drops and near-term streaming TV that TMDB's availability layer hasn't flagged yet                         |
| Streaming Availability (RapidAPI) | No     | Per-provider "coming soon" feed sourced from JustWatch + each service directly. Biggest single coverage lift when enabled. |
| Watchmode `/releases/`          | No     | Purpose-built upcoming streaming releases feed per service with TMDB ids + actual streamer release dates.                 |

### 3. Install and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command            | What it does                           |
| ------------------ | -------------------------------------- |
| `npm run dev`      | Start the Next.js dev server.          |
| `npm run build`    | Production build.                      |
| `npm run start`    | Run the production build.              |
| `npm run lint`     | Lint with `eslint-config-next`.        |
| `npm run typecheck`| Type-check without emitting.           |

## API route

The app also exposes `GET /api/releases` which returns the same payload used
by the UI:

```
/api/releases?days=90&region=US&movies=1&tv=1
```

Response cached for 6 hours at the edge (`s-maxage=21600`).

## Deploying to Vercel

This app is a standard Next.js 14 App Router project with no custom runtime
config, so Vercel deploys it with zero changes.

1. Push this repo to GitHub (or GitLab / Bitbucket).
2. Go to [vercel.com/new](https://vercel.com/new) and import the repo. Vercel
   auto-detects the Next.js framework preset &mdash; accept the defaults.
3. Under **Environment Variables**, add:
   - `TMDB_READ_TOKEN` &mdash; your TMDB v4 read access token (recommended), **or**
   - `TMDB_API_KEY` &mdash; your TMDB v3 API key.
   - `TMDB_REGION` &mdash; optional, e.g. `US`, `GB`, `CA`, `AU`.

   Add them for all environments (Production, Preview, Development).
4. Click **Deploy**.

### How caching works on Vercel

- The page is marked `dynamic = "force-dynamic"` so it doesn't try to
  prerender at build time (no TMDB call happens during `next build`).
- At request time, the TMDB `fetch` calls in `src/lib/tmdb.ts` use
  `next: { revalidate: 21600 }`, so responses land in the Vercel Data Cache
  and are reused for 6 hours across requests and serverless instances.
- `GET /api/releases` additionally sets
  `Cache-Control: public, s-maxage=21600, stale-while-revalidate=86400`, so
  Vercel's edge cache will serve stale JSON while refreshing in the
  background.

Net result: TMDB is only called roughly every 6 hours per region/filter
combination, well inside TMDB's rate limits.

### Updating environment variables

If you change a TMDB env var in Vercel's dashboard, redeploy (the Data Cache
is built from the last deployment's environment). Re-clicking **Redeploy**
from the latest production deployment is the fastest way.

## Notes and limitations

- TMDB exposes release **dates** but not regional release **times**, so the
  "time available" field is surfaced only if TMDB provides it (most entries
  only have a date).
- Only releases with at least one streaming provider in the configured region
  are shown, which filters out theatrical-only releases.
- This product uses the TMDB API but is not endorsed or certified by TMDB.
