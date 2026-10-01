/**
 * @fileoverview Output schemas and vocabularies shared by more than one faa_delays tool: the
 * advisory reference, the per-15-minute delay profile, and the event-type enum.
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
    startTime: z.string().describe('UTC ISO start of the first interval, as the FAA reports it.'),
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
