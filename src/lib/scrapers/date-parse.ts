/** Parse date strings that appear in marketing copy and press pages.
 *
 *  Handles:
 *    - ISO:           "2026-05-12"
 *    - US long:       "May 12, 2026"
 *    - US short:      "May 12" (infers current or next year if the
 *                      parsed month is in the past)
 *    - Weekday prefix:"Friday, May 12"
 *    - Day-month-year:"12 May 2026" */

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function toYmd(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** Attempt to parse a free-form date string. Returns a YYYY-MM-DD
 *  string or null. If the parsed date is missing a year, assumes the
 *  current year, or bumps to next year if the month/day has already
 *  passed (so "Dec 30" parsed in January means "this coming December",
 *  not "last December"). */
export function parseFreeformDate(input: string, reference?: Date): string | null {
  if (!input) return null;
  const now = reference ?? new Date();
  const trimmed = input.trim().replace(/\s+/g, " ");

  // ISO or slash/dot variants: 2026-05-12, 2026/05/12, 2026.05.12
  const iso = /^(\d{4})[-/.](\d{2})[-/.](\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Strip a leading weekday+comma ("Friday, May 12")
  const stripped = trimmed.replace(
    /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*/i,
    "",
  );

  // "Month Day, Year" or "Month Day Year"
  const monthFirst = /^([a-z]+)\s+(\d{1,2})(?:(?:st|nd|rd|th))?(?:[,\s]+(\d{4}))?$/i.exec(
    stripped,
  );
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month == null) return null;
    const day = parseInt(monthFirst[2], 10);
    const year = monthFirst[3]
      ? parseInt(monthFirst[3], 10)
      : inferYear(now, month, day);
    return toYmd(year, month, day);
  }

  // "Day Month Year" (British / ISO-ish)
  const dayFirst = /^(\d{1,2})(?:(?:st|nd|rd|th))?\s+([a-z]+)(?:\s+(\d{4}))?$/i.exec(
    stripped,
  );
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (month == null) return null;
    const day = parseInt(dayFirst[1], 10);
    const year = dayFirst[3]
      ? parseInt(dayFirst[3], 10)
      : inferYear(now, month, day);
    return toYmd(year, month, day);
  }

  // Fallback: let JS try.
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/** Infer the year for a month/day pair relative to `now`. If the
 *  resulting date would already be in the past by more than 14 days,
 *  bump to next year. */
function inferYear(now: Date, month: number, day: number): number {
  const thisYear = now.getFullYear();
  const candidate = new Date(thisYear, month, day);
  const graceMs = 14 * 24 * 60 * 60 * 1000;
  if (candidate.getTime() < now.getTime() - graceMs) {
    return thisYear + 1;
  }
  return thisYear;
}
