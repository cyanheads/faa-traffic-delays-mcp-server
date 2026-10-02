/**
 * @fileoverview ATCSCC advisory references: mined from feed and index links, and the two URL forms
 * this server builds and fetches (one advisory, and the advisories issued on a UTC date). Feed links
 * carry unencoded spaces in their `title` parameter, so links are matched by pattern for `advn` and
 * `adv_date` only, never parsed as URLs, fetched, or returned.
 * @module services/advisory/advisory-ref
 */

const ADVISORY_BASE_URL = 'https://www.fly.faa.gov/adv/adv_otherdis';
const ADVISORY_INDEX_URL = 'https://www.fly.faa.gov/adv/adv_list';

/** Highest ATCSCC advisory number; numbers run from 1 each UTC day. */
export const MAX_ADVISORY_NUMBER = 999;

/** The advisory index categories, each one checkbox of the index form. */
export const ADVISORY_CATEGORIES = [
  'ground_stop',
  'ground_delay_program',
  'airspace_flow_program',
  'ctop',
  'route',
  'other',
] as const;

export type AdvisoryCategory = (typeof ADVISORY_CATEGORIES)[number];

/** The index form's checkbox name for each category. */
const CATEGORY_BOX: Record<AdvisoryCategory, string> = {
  airspace_flow_program: 'airflow',
  ctop: 'ctop',
  ground_delay_program: 'gDelay',
  ground_stop: 'gStop',
  other: 'other',
  route: 'route',
};

/** A pointer to one ATCSCC advisory: number, UTC date, and the server-built URL. */
export interface AdvisoryRef {
  /** Advisory UTC date, `YYYY-MM-DD`. */
  date: string;
  number: number;
  url: string;
}

/** `https://www.fly.faa.gov/adv/adv_otherdis?advn={n}&adv_date={MMDDYYYY}` for a `YYYY-MM-DD` date. */
export function buildAdvisoryUrl(advisoryNumber: number, date: string): string {
  const [year, month, day] = date.split('-');
  return `${ADVISORY_BASE_URL}?advn=${advisoryNumber}&adv_date=${month}${day}${year}`;
}

/**
 * The ATCSCC advisory index for a `YYYY-MM-DD` date. Without categories (none given, or an empty
 * list) it reads `advisoryCategory=All`, which also lists the advisories the FAA files under no
 * category (CDM compression). With categories it reads `NotAll`: each selected box `=true` and
 * every other box `_<box>=on`, since the index binds a box that is left out as checked. One set of
 * categories always builds the same URL, whatever order it was given in.
 */
export function buildAdvisoryIndexUrl(
  date: string,
  categories?: readonly AdvisoryCategory[],
): string {
  const filtered = categories !== undefined && categories.length > 0;
  const base = `${ADVISORY_INDEX_URL}?whichAdvisories=ATCSCC&advisoryCategory=${filtered ? 'NotAll' : 'All'}&date=${date}`;
  if (!filtered) return base;
  const boxes = ADVISORY_CATEGORIES.map((category) =>
    categories.includes(category)
      ? `${CATEGORY_BOX[category]}=true`
      : `_${CATEGORY_BOX[category]}=on`,
  );
  return `${base}&${boxes.join('&')}`;
}

/** Each parameter's value runs to the next `&` or the end of the link, so `advn=12abc` is no number. */
const ADVN = /[?&]advn=(\d+)(?=&|$)/;
const ADV_DATE = /[?&]adv_date=(\d{2})(\d{2})(\d{4})(?=&|$)/;

/** Whether `YYYY-MM-DD` is a real calendar day; `Date.parse` rolls `2026-02-30` into March. */
const isCalendarDate = (date: string): boolean => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(date);
};

/**
 * Reads `advn` and `adv_date` out of a feed link or an index link's href; `undefined` when either
 * is absent or runs into other characters, the date is not a real calendar day, or the number is
 * outside 1–999, the range `faa_delays_get_advisory` accepts.
 */
export function parseAdvisoryLink(link: string | undefined): AdvisoryRef | undefined {
  if (!link) return;
  const advn = ADVN.exec(link)?.[1];
  const advDate = ADV_DATE.exec(link);
  if (!advn || !advDate) return;
  const advisoryNumber = Number.parseInt(advn, 10);
  if (advisoryNumber < 1 || advisoryNumber > MAX_ADVISORY_NUMBER) return;
  const date = `${advDate[3]}-${advDate[1]}-${advDate[2]}`;
  if (!isCalendarDate(date)) return;
  return { date, number: advisoryNumber, url: buildAdvisoryUrl(advisoryNumber, date) };
}
