/**
 * @fileoverview The advisory date input shared by faa_delays_get_advisory and
 * faa_delays_list_advisories: `MM/DD/YYYY` and `M/D/YYYY` rewritten to `YYYY-MM-DD`, then a real
 * calendar date no later than tomorrow (UTC).
 * @module mcp-server/tools/advisory-date
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Trims, and rewrites `MM/DD/YYYY` (the form advisory titles print), or its unpadded `M/D/YYYY`, to
 * `YYYY-MM-DD`.
 */
export function normalizeDate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .replace(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      (_, month: string, day: string, year: string) =>
        `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    );
}

/**
 * Latest date accepted, `YYYY-MM-DD`: tomorrow in UTC. An advisory carries the UTC date it was
 * issued, so a later date holds none yet; the extra day covers a caller whose clock runs ahead of
 * UTC.
 */
const latestAdvisoryDate = (): string =>
  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** A real UTC date, `YYYY-MM-DD`, no later than tomorrow (UTC); apply after `normalizeDate`. */
export const AdvisoryDateSchema = z.iso
  .date({
    abort: true,
    error: 'Must be a real UTC date as YYYY-MM-DD, MM/DD/YYYY, or M/D/YYYY.',
  })
  .refine((date) => date <= latestAdvisoryDate(), {
    error: 'Must be no later than tomorrow (UTC): an advisory carries the UTC date it was issued.',
  });
