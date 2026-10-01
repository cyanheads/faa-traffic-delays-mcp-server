/**
 * @fileoverview Notice fragments shared by the feed tools: the stale arrival/departure delay
 * warning (an entry last updated more than 6 h before the snapshot) and the skipped-rows count.
 * @module mcp-server/tools/notices
 */

import { inline } from './format-helpers.js';

const STALE_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * `ORD departure delay was last updated 8 h ago; …` when `updatedAt` is more than 6 h older than
 * `fetchedAt`, else undefined. The FAA feed can keep a delay entry after the delay lapses.
 */
export function staleDelayNotice(
  airportId: string,
  kind: 'arrival' | 'departure',
  updatedAt: string | undefined,
  fetchedAt: string,
): string | undefined {
  if (!updatedAt) return;
  const age = Date.parse(fetchedAt) - Date.parse(updatedAt);
  if (!Number.isFinite(age) || age <= STALE_DELAY_MS) return;
  return `${inline(airportId)} ${kind} delay was last updated ${Math.floor(age / 3_600_000)} h ago; the FAA feed can keep a delay entry after it lapses.`;
}

/** `N FAA feed rows could not be read and were skipped.`, singular for one row. */
export function skippedRowsNotice(count: number): string {
  return count === 1
    ? '1 FAA feed row could not be read and was skipped.'
    : `${count} FAA feed rows could not be read and were skipped.`;
}
