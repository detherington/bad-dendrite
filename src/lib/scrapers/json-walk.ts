/** Generic recursive walker for nested JSON payloads embedded in
 *  Next.js `__NEXT_DATA__`, Apple TV "shoebox" script tags, and
 *  similar client-side hydration blobs.
 *
 *  The walker visits every nested object and array, looking for
 *  objects that carry BOTH a plausible title string (under a key
 *  like `title`, `name`, `headline`, ...) AND a parseable date
 *  string (under a key like `releaseDate`, `premiereDate`,
 *  `availableDate`, ...). Any matching object is emitted as a
 *  WalkedItem. Cycles are broken via a WeakSet. */

export interface WalkedItem {
  title: string;
  releaseDate: string;
  year?: number;
  mediaType: "movie" | "tv" | "unknown";
}

const TITLE_KEYS = new Set([
  "title",
  "name",
  "headline",
  "displayTitle",
  "displayName",
  "artistName",
  "longTitle",
  "shortTitle",
  "seoTitle",
  "cardTitle",
  "contentTitle",
  "programmeTitle",
  "programTitle",
  "showTitle",
  "episodeTitle",
  "mediaTitle",
  "primaryTitle",
  "fullTitle",
  "titleName",
  "label",
]);

const DATE_KEYS = new Set([
  "releaseDate",
  "originalReleaseDate",
  "expectedReleaseDate",
  "availableDate",
  "availableFrom",
  "availableAt",
  "availableStartDate",
  "firstAvailableDate",
  "premiereDate",
  "premiere_date",
  "launchDate",
  "launch_date",
  "airDate",
  "air_date",
  "originalAirDate",
  "date",
  "publishedDate",
  "published_at",
  "datePublished",
  "startTime",
  "startDate",
  "scheduledAt",
  "scheduledDate",
  "bookingDate",
  "playbackDate",
  "streamingDate",
  "onAir",
  "onAirDate",
  "onAirFrom",
  "expectedDate",
  "initialDate",
  "broadcastDate",
  "offerStartDate",
  "contentWindowStart",
]);

const TYPE_KEYS = new Set([
  "type",
  "contentType",
  "category",
  "__typename",
  "itemType",
  "showType",
  "kind",
]);

function pickStringField(
  obj: Record<string, unknown>,
  keys: Set<string>,
): string | null {
  for (const k of Object.keys(obj)) {
    if (!keys.has(k)) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function normaliseDateString(raw: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Apple TV sometimes returns ms epoch ints rendered as strings.
  if (/^\d{13}$/.test(raw)) {
    const d = new Date(parseInt(raw, 10));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (/^\d{10}$/.test(raw)) {
    const d = new Date(parseInt(raw, 10) * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function looksLikeTitle(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 2 || trimmed.length > 200) return false;
  if (/^https?:\/\//.test(trimmed)) return false;
  // Slug-like strings ("my-great-show") with no whitespace are usually
  // URL fragments, not titles.
  if (/\/[a-z0-9-]+\//.test(trimmed) && !/\s/.test(trimmed)) return false;
  return true;
}

function inferMediaType(typeHint: string): "movie" | "tv" | "unknown" {
  const t = typeHint.toLowerCase();
  if (/series|season|episode|show|tvshow|tvseries/.test(t)) return "tv";
  if (/movie|film|feature/.test(t)) return "movie";
  return "unknown";
}

export function walkForTitleDatePairs(root: unknown): WalkedItem[] {
  const out: WalkedItem[] = [];
  const seen = new WeakSet<object>();

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const objRef = node as object;
    if (seen.has(objRef)) return;
    seen.add(objRef);

    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const obj = node as Record<string, unknown>;
    const titleRaw = pickStringField(obj, TITLE_KEYS);
    const dateRaw = pickStringField(obj, DATE_KEYS);
    if (titleRaw && dateRaw && looksLikeTitle(titleRaw)) {
      const normalised = normaliseDateString(dateRaw);
      if (normalised) {
        const typeField = pickStringField(obj, TYPE_KEYS) ?? "";
        const mediaType = inferMediaType(typeField);
        out.push({
          title: titleRaw,
          releaseDate: normalised,
          mediaType,
          year: parseInt(normalised.slice(0, 4), 10) || undefined,
        });
      }
    }

    for (const key of Object.keys(obj)) visit(obj[key]);
  }

  visit(root);
  return out;
}
