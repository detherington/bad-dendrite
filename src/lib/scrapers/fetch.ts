/** Shared HTTP + HTML-parsing helpers for the streamer scrapers.
 *
 *  Fetches go through Next.js's Data Cache at 24h, so each source page
 *  is hit at most once per day per region no matter how often the
 *  route is called. Every scraper uses a realistic desktop User-Agent
 *  so press sites don't flag us as a bot and serve a challenge page. */

import { parse as parseHtml, type HTMLElement } from "node-html-parser";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export interface FetchHtmlResult {
  ok: boolean;
  status: number;
  html: string;
  bytes: number;
  error?: string;
}

export async function fetchHtml(
  url: string,
  opts: { revalidate?: number } = {},
): Promise<FetchHtmlResult> {
  const revalidate = opts.revalidate ?? 60 * 60 * 24; // 24h
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": DESKTOP_UA,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      next: { revalidate },
    });
    const html = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      html,
      bytes: html.length,
      error: res.ok ? undefined : `${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      html: "",
      bytes: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Parse an HTML string and return the root element. Thin wrapper so
 *  scrapers don't each import node-html-parser directly. */
export function parseDocument(html: string): HTMLElement {
  return parseHtml(html, {
    lowerCaseTagName: false,
    comment: false,
    voidTag: {
      closingSlash: true,
      tags: [
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
      ],
    },
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
      pre: false,
    },
  });
}

export type { HTMLElement };
