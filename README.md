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
```

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

## Notes and limitations

- TMDB exposes release **dates** but not regional release **times**, so the
  "time available" field is surfaced only if TMDB provides it (most entries
  only have a date).
- Only releases with at least one streaming provider in the configured region
  are shown, which filters out theatrical-only releases.
- This product uses the TMDB API but is not endorsed or certified by TMDB.
