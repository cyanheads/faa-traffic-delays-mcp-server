/**
 * @fileoverview ATCSCC advisory references: mined from feed links, and the one URL form this server
 * builds and fetches. Feed links carry unencoded spaces in their `title` parameter, so they are
 * matched by pattern for `advn` and `adv_date` only, never parsed as URLs, fetched, or returned.
 * @module services/advisory/advisory-ref
 */

const ADVISORY_BASE_URL = 'https://www.fly.faa.gov/adv/adv_otherdis';

/** Highest ATCSCC advisory number; numbers run from 1 each UTC day. */
export const MAX_ADVISORY_NUMBER = 999;

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
 * Reads `advn` and `adv_date` out of a feed link; `undefined` when either is absent or the number
 * is outside 1–999, the range `faa_delays_get_advisory` accepts.
 */
export function parseAdvisoryLink(link: string | undefined): AdvisoryRef | undefined {
  if (!link) return;
  const advn = /[?&]advn=(\d+)/.exec(link)?.[1];
  const advDate = /[?&]adv_date=(\d{2})(\d{2})(\d{4})/.exec(link);
  if (!advn || !advDate) return;
  const advisoryNumber = Number.parseInt(advn, 10);
  if (advisoryNumber < 1 || advisoryNumber > MAX_ADVISORY_NUMBER) return;
  const date = `${advDate[3]}-${advDate[1]}-${advDate[2]}`;
  return { date, number: advisoryNumber, url: buildAdvisoryUrl(advisoryNumber, date) };
}
