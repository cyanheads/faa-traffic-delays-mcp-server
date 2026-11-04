/**
 * @fileoverview Output schemas and vocabularies shared by more than one faa_delays tool: the
 * advisory reference, the per-15-minute delay profile, the operations plan's planned item, and the
 * event-type enum.
 * @module mcp-server/tools/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { inline } from './format-helpers.js';

/** Every event type the national list and the reference topic use, in severity order. */
export const EVENT_TYPES = [
  'airport_closure',
  'ground_stop',
  'ground_delay_program',
  'airspace_flow_program',
  'arrival_delay',
  'departure_delay',
  'closure_notam',
  'deicing',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EventTypeSchema = z.enum(EVENT_TYPES).describe('FAA traffic management event type.');

export const AdvisoryRefSchema = z
  .object({
    number: z.number().int().describe('ATCSCC advisory number; numbers restart at 1 each UTC day.'),
    date: z.string().describe('Advisory UTC date, YYYY-MM-DD.'),
    url: z
      .string()
      .describe(
        'Server-built advisory URL, the page faa_delays_get_advisory reads for this number and date.',
      ),
  })
  .describe(
    'Reference to the ATCSCC advisory behind this item, absent when the FAA feed links none. For the full text, call faa_delays_get_advisory with number as advisory_number and date as date.',
  );

export const DelayProfileSchema = z
  .object({
    startTime: z
      .string()
      .describe(
        'UTC ISO start of the first 15-minute interval. The FAA aligns intervals to the quarter hour, so it can precede the program start by up to 14 minutes.',
      ),
    intervalMinutes: z.literal(15).describe('Length of each interval in minutes; always 15.'),
    averageDelayMinutes: z
      .array(z.number().describe('Average delay in minutes for one 15-minute arrival interval.'))
      .describe('Average assigned delay per consecutive 15-minute arrival interval, in order.'),
  })
  .describe(
    'Delay trend: average assigned delay for each 15-minute arrival interval of the program.',
  );

/** `12, 14, 20 … (15-min intervals from <start>)` — the delay profile as one line. */
export function renderDelayProfile(profile: z.infer<typeof DelayProfileSchema>): string {
  return `${profile.averageDelayMinutes.join(', ')} min (${profile.intervalMinutes}-min intervals from ${inline(profile.startTime)})`;
}

export const PlannedItemSchema = z
  .object({
    text: z
      .string()
      .describe(
        'The planned item as the FAA wrote it, tabs flattened and the leading dash removed (FAA-authored).',
      ),
    timeQualifier: z
      .enum(['after', 'until', 'by', 'between'])
      .optional()
      .describe(
        'How the planned time bounds the item, parsed from the start of the text; for between, timeUtc is the start of the window and its end stays in text.',
      ),
    timeUtc: z
      .string()
      .optional()
      .describe(
        "Planned time as HHMM UTC, with no date. Its day comes from the plan's event window (the EVENT TIME line of the plan advisory, read with faa_delays_get_advisory), which can start on the UTC day after the advisory date.",
      ),
    likelihood: z
      .enum(['possible', 'probable', 'expected'])
      .optional()
      .describe(
        "The FAA's stated likelihood: possible (<30 %), probable (30–60 %), or expected (most likely). Absent when the text states none.",
      ),
  })
  .describe('One planned program or initiative.');

/** `after 1100 UTC · possible` — the parsed time and likelihood of one planned item. */
export function plannedMeta(item: z.infer<typeof PlannedItemSchema>): string {
  const time = item.timeUtc
    ? `${item.timeQualifier ? `${item.timeQualifier} ` : ''}${inline(item.timeUtc)} UTC`
    : undefined;
  const parts = [time, item.likelihood].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'no time or likelihood stated';
}
