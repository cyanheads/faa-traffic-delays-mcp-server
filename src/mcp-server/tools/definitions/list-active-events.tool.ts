/**
 * @fileoverview faa_delays_list_active_events — every active traffic management event across the
 * NAS in one call: airport events plus en-route Airspace Flow Programs, sorted by severity, with
 * per-type counts over the whole feed. The en-route leg degrades rather than failing the call,
 * unless Airspace Flow Programs are the only type requested.
 * @module mcp-server/tools/definitions/list-active-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import type { AirportEvents, AirspaceFlowProgram, DelayBand } from '@/services/nas-status/types.js';
import { advisoryLine, blockquote, inline, span } from '../format-helpers.js';
import {
  AdvisoryRefSchema,
  DelayProfileSchema,
  EVENT_TYPES,
  type EventType,
  EventTypeSchema,
  renderDelayProfile,
} from '../schemas.js';

const EVENT_TYPE_ALIASES: Record<string, EventType> = {
  afp: 'airspace_flow_program',
  gdp: 'ground_delay_program',
  gs: 'ground_stop',
};

/**
 * Blank string or empty array → unset; a string is split on commas/whitespace; each value is
 * trimmed, lowercased, `-`/space → `_`, and the gs/gdp/afp aliases expanded. Anything else reaches
 * the enum and fails with its options listed.
 */
function normalizeEventTypes(value: unknown): unknown {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && !value.trim()) return;
  if (Array.isArray(value) && value.length === 0) return;
  const items = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  if (!Array.isArray(items)) return value;
  return items.map((item) => {
    if (typeof item !== 'string') return item;
    const normalized = item
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    return EVENT_TYPE_ALIASES[normalized] ?? normalized;
  });
}

/** Sort rank: arrival and departure delays share one group, sorted together by band maximum. */
const SEVERITY_RANK: Record<EventType, number> = {
  airport_closure: 0,
  ground_stop: 1,
  ground_delay_program: 2,
  airspace_flow_program: 3,
  arrival_delay: 4,
  departure_delay: 4,
  closure_notam: 5,
  deicing: 6,
};

const CONSTRAINED_AREA_TYPES = [
  'airport',
  'artcc',
  'sector',
  'tracon',
  'special_use_airspace',
  'fix',
  'fca',
] as const;

const EventSchema = z
  .object({
    eventType: EventTypeSchema,
    location: z
      .string()
      .describe(
        'FAA airport identifier, or the AFP name for airspace_flow_program (FAA-authored).',
      ),
    locationName: z.string().optional().describe('Airport name (FAA-authored).'),
    reason: z.string().optional().describe('Stated cause (FAA-authored text).'),
    averageDelayMinutes: z
      .number()
      .optional()
      .describe('Average assigned delay in minutes (ground_delay_program, airspace_flow_program).'),
    maximumDelayMinutes: z
      .number()
      .optional()
      .describe('Maximum assigned delay in minutes (ground_delay_program).'),
    delayRangeMinutes: z
      .object({
        min: z.number().describe('Lower bound in minutes.'),
        max: z.number().describe('Upper bound in minutes.'),
      })
      .optional()
      .describe(
        'Delay band for arrival_delay and departure_delay (the FAA reports 15-minute bands).',
      ),
    trend: z
      .enum(['increasing', 'decreasing'])
      .optional()
      .describe('Direction an arrival or departure delay is moving.'),
    probabilityOfExtension: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe(
        'Ground stop extension likelihood: low <30 %, medium 30–60 %, high >60 % per the FAA.',
      ),
    startTime: z.string().optional().describe('Start (UTC ISO); for deicing, when it began.'),
    endTime: z.string().optional().describe('End (UTC ISO).'),
    updatedAt: z.string().optional().describe('Last FAA update (UTC ISO).'),
    closureText: z
      .string()
      .optional()
      .describe('airport_closure exceptions, or the closure_notam NOTAM text (FAA-authored).'),
    advisory: AdvisoryRefSchema.optional(),
    afp: z
      .object({
        constrainedArea: z
          .object({
            type: z
              .enum(CONSTRAINED_AREA_TYPES)
              .describe(
                'Kind of Flow Constrained Area; fca when the FAA names no specific element.',
              ),
            name: z.string().optional().describe('Name of the constrained element (FAA-authored).'),
          })
          .describe('The airspace the program meters.'),
        altitudeFloor: z
          .string()
          .optional()
          .describe('Lower altitude bound as the FAA reports it.'),
        altitudeCeiling: z
          .string()
          .optional()
          .describe('Upper altitude bound as the FAA reports it.'),
        departsFrom: z
          .string()
          .optional()
          .describe('Departure facilities included (FAA-authored).'),
        arrivesTo: z.string().optional().describe('Arrival facilities included (FAA-authored).'),
        excludedDepartures: z
          .string()
          .optional()
          .describe('Departure facilities excluded (FAA-authored).'),
        excludedArrivals: z
          .string()
          .optional()
          .describe('Arrival facilities excluded (FAA-authored).'),
        headingDirection: z
          .string()
          .optional()
          .describe('Direction of flights included, e.g. westbound (FAA-authored).'),
        filtersMatchAny: z
          .boolean()
          .optional()
          .describe('true: departs OR arrives filters apply; false: both must match.'),
        comments: z.string().optional().describe('Program comments (FAA-authored).'),
        delayProfile: DelayProfileSchema.optional(),
      })
      .optional()
      .describe('Airspace Flow Program detail; present only on airspace_flow_program rows.'),
  })
  .describe('One active event.');

type EventRow = z.infer<typeof EventSchema>;

const CountsSchema = z
  .object({
    ground_stop: z.number().int().describe('Active ground stops.'),
    ground_delay_program: z.number().int().describe('Active Ground Delay Programs.'),
    airspace_flow_program: z
      .number()
      .int()
      .optional()
      .describe('Active Airspace Flow Programs; absent when the en-route feed could not be read.'),
    arrival_delay: z.number().int().describe('Active arrival delays.'),
    departure_delay: z.number().int().describe('Active departure delays.'),
    airport_closure: z.number().int().describe('Airport closures.'),
    closure_notam: z.number().int().describe('Closure NOTAMs.'),
    deicing: z.number().int().describe('Airports deicing.'),
  })
  .describe(
    'Active events per type across the whole feed, counted before the event_types filter so types the filter excluded stay visible. airspace_flow_program is absent when the en-route feed could not be read.',
  );

type Counts = z.infer<typeof CountsSchema>;

const delayRange = (band: DelayBand) =>
  band.minMinutes !== undefined && band.maxMinutes !== undefined
    ? { delayRangeMinutes: { min: band.minMinutes, max: band.maxMinutes } }
    : {};

function airportRows(airport: AirportEvents): EventRow[] {
  const base = {
    location: airport.airportId,
    ...(airport.airportName && { locationName: airport.airportName }),
  };
  const rows: EventRow[] = [];
  const { closure, closureNotam, deicing, groundDelayProgram: gdp, groundStop: gs } = airport;
  if (closure) {
    const { text, ...times } = closure;
    rows.push({
      eventType: 'airport_closure',
      ...base,
      ...times,
      ...(text && { closureText: text }),
    });
  }
  if (gs) {
    rows.push({
      eventType: 'ground_stop',
      ...base,
      ...(gs.reason && { reason: gs.reason }),
      ...(gs.probabilityOfExtension && { probabilityOfExtension: gs.probabilityOfExtension }),
      ...(gs.startTime && { startTime: gs.startTime }),
      ...(gs.endTime && { endTime: gs.endTime }),
      ...(gs.updatedAt && { updatedAt: gs.updatedAt }),
      ...(gs.advisory && { advisory: gs.advisory }),
    });
  }
  if (gdp) {
    rows.push({
      eventType: 'ground_delay_program',
      ...base,
      ...(gdp.reason && { reason: gdp.reason }),
      ...(gdp.averageDelayMinutes !== undefined && {
        averageDelayMinutes: gdp.averageDelayMinutes,
      }),
      ...(gdp.maximumDelayMinutes !== undefined && {
        maximumDelayMinutes: gdp.maximumDelayMinutes,
      }),
      ...(gdp.startTime && { startTime: gdp.startTime }),
      ...(gdp.endTime && { endTime: gdp.endTime }),
      ...(gdp.updatedAt && { updatedAt: gdp.updatedAt }),
      ...(gdp.advisory && { advisory: gdp.advisory }),
    });
  }
  for (const [eventType, band] of [
    ['arrival_delay', airport.arrivalDelay],
    ['departure_delay', airport.departureDelay],
  ] as const) {
    if (!band) continue;
    rows.push({
      eventType,
      ...base,
      ...(band.reason && { reason: band.reason }),
      ...delayRange(band),
      ...(band.trend && { trend: band.trend }),
      ...(band.updatedAt && { updatedAt: band.updatedAt }),
    });
  }
  if (closureNotam) {
    rows.push({
      eventType: 'closure_notam',
      ...base,
      ...(closureNotam.startTime && { startTime: closureNotam.startTime }),
      ...(closureNotam.endTime && { endTime: closureNotam.endTime }),
      ...(closureNotam.updatedAt && { updatedAt: closureNotam.updatedAt }),
      ...(closureNotam.notamText && { closureText: closureNotam.notamText }),
    });
  }
  if (deicing) {
    rows.push({
      eventType: 'deicing',
      ...base,
      ...(deicing.startedAt && { startTime: deicing.startedAt }),
    });
  }
  return rows;
}

function afpRow(program: AirspaceFlowProgram): EventRow {
  const { advisory, averageDelayMinutes, endTime, name, reason, startTime, updatedAt, ...detail } =
    program;
  return {
    eventType: 'airspace_flow_program',
    location: name,
    ...(reason && { reason }),
    ...(averageDelayMinutes !== undefined && { averageDelayMinutes }),
    ...(startTime && { startTime }),
    ...(endTime && { endTime }),
    ...(updatedAt && { updatedAt }),
    ...(advisory && { advisory }),
    afp: detail,
  };
}

/** The delay a row sorts by within its rank: band maximum or average; undefined when unreported. */
const magnitude = (row: EventRow): number | undefined =>
  row.delayRangeMinutes?.max ?? row.averageDelayMinutes;

/**
 * Severity rank, then rows with a reported delay (largest first) before rows without one, then
 * location. Each key is a total order, so the comparison stays transitive.
 */
function compareEvents(a: EventRow, b: EventRow): number {
  const rank = SEVERITY_RANK[a.eventType] - SEVERITY_RANK[b.eventType];
  if (rank !== 0) return rank;
  const magnitudeA = magnitude(a);
  const magnitudeB = magnitude(b);
  if (magnitudeA !== magnitudeB) {
    if (magnitudeA === undefined) return 1;
    if (magnitudeB === undefined) return -1;
    return magnitudeB - magnitudeA;
  }
  return a.location.localeCompare(b.location) || a.eventType.localeCompare(b.eventType);
}

/** `data.reason` of a thrown feed error, when it carries one. */
function reasonOf(error: unknown): unknown {
  return isRecord(error) && isRecord(error.data) ? error.data.reason : undefined;
}

function renderCounts(counts: Counts): string {
  const parts = EVENT_TYPES.flatMap((type) => {
    const count = counts[type];
    if (count === undefined) return [`${type} unknown`];
    return count > 0 ? [`${type} ${count}`] : [];
  });
  return `**By type:** ${parts.length > 0 ? parts.join(' · ') : 'none'}`;
}

export const listActiveEvents = tool('faa_delays_list_active_events', {
  title: 'faa_delays_list_active_events',
  description:
    'List every active FAA traffic management event across the National Airspace System in one call: ground stops, Ground Delay Programs, Airspace Flow Programs, arrival and departure delays, airport closures, closure NOTAMs, and deicing. Rows are sorted by severity (closures, ground stops, then GDPs and then AFPs each by average delay, arrival/departure delays by band maximum, closure NOTAMs, deicing) and carry the reason, delay figures, times, and an advisory reference for faa_delays_get_advisory. Use faa_delays_get_airport_status for the full detail of one airport, including its GDP delay profile and runway configuration.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    event_types: z
      .preprocess(normalizeEventTypes, z.array(EventTypeSchema).optional())
      .describe(
        'Only these event types: ground_stop, ground_delay_program, airspace_flow_program, arrival_delay, departure_delay, airport_closure, closure_notam, deicing. Also accepts gs, gdp, afp and a comma-separated string; case-insensitive. Omit for every type. countsByType always covers the whole feed.',
      ),
  }),
  output: z.object({
    fetchedAt: z
      .string()
      .describe(
        'When this server fetched the airport events from the FAA (UTC ISO); with the 60 s cache it can trail the call by up to a minute.',
      ),
    events: z
      .array(EventSchema)
      .describe('Active events matching event_types, sorted by severity.'),
  }),
  enrichment: {
    totalActive: z
      .number()
      .int()
      .describe(
        'Every active event read, before the event_types filter; excludes AFPs when the en-route feed could not be read.',
      ),
    shown: z.number().int().describe('Events returned after the event_types filter.'),
    countsByType: CountsSchema,
    appliedEventTypes: z
      .array(EventTypeSchema)
      .describe('The event_types filter as the server normalized it, or every type when omitted.'),
    enRouteFeed: z
      .enum(['ok', 'unavailable', 'format_changed'])
      .describe(
        'Whether Airspace Flow Programs were read: ok, unavailable (the en-route feed failed), or format_changed (it returned a format this server does not read).',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance on empty or partial results and how to get the missing data.'),
  },
  enrichmentTrailer: {
    totalActive: { label: 'Total active' },
    shown: { label: 'Shown' },
    countsByType: { render: renderCounts },
    appliedEventTypes: {
      render: (types) =>
        `**Event types:** ${types.length === EVENT_TYPES.length ? 'all' : types.join(', ')}`,
    },
    enRouteFeed: { label: 'En-route feed' },
  },
  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NAS Status unreachable, 5xx, an attempt timeout, or an HTML maintenance page, after retries',
      recovery:
        'The FAA NAS Status feed is temporarily unreachable; call faa_delays_list_active_events again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The FAA returned 429 after retries',
      recovery:
        "The FAA feed is limiting request rate; wait the retryAfter interval in this error's data (about a minute when it carries none), then call faa_delays_list_active_events again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The 20 s retry budget ran out',
      recovery:
        'The FAA NAS Status feed is responding slowly; call faa_delays_list_active_events again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own queue to the FAA would wait past 10 s",
      recovery:
        "This server is pacing its requests to the FAA; wait the retryAfter seconds in this error's data, then call faa_delays_list_active_events again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'feed_contract_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The feed path returned 404/410, or a body whose shape this server no longer recognizes',
      recovery:
        "The FAA NAS Status feed is not serving the format this server reads, which usually means the FAA changed it, so an immediate retry will not help; faa_delays_get_advisory still reads ATCSCC advisories, numbered from 1 each UTC day, so today's program advisories can be read by advisory_number with today's UTC date.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const filter = input.event_types ? [...new Set(input.event_types)] : undefined;
    const applied: EventType[] = filter ?? [...EVENT_TYPES];
    const onlyAfp = filter?.length === 1 && filter[0] === 'airspace_flow_program';

    const nas = getNasStatusService();
    const [airportResult, enrouteResult] = await Promise.allSettled([
      nas.getAirportEvents(ctx),
      nas.getEnrouteEvents(ctx),
    ]);
    if (airportResult.status === 'rejected') throw airportResult.reason;
    if (enrouteResult.status === 'rejected' && (ctx.signal.aborted || onlyAfp)) {
      throw enrouteResult.reason;
    }

    const airportFeed = airportResult.value;
    const enRouteFeed =
      enrouteResult.status === 'fulfilled'
        ? 'ok'
        : reasonOf(enrouteResult.reason) === 'feed_contract_changed'
          ? 'format_changed'
          : 'unavailable';
    const programs = enrouteResult.status === 'fulfilled' ? enrouteResult.value.rows : [];
    const all = [...airportFeed.rows.flatMap(airportRows), ...programs.map(afpRow)];
    const countOf = (type: EventType): number => all.filter((row) => row.eventType === type).length;
    const countsByType: Counts = {
      ground_stop: countOf('ground_stop'),
      ground_delay_program: countOf('ground_delay_program'),
      ...(enRouteFeed === 'ok' && { airspace_flow_program: countOf('airspace_flow_program') }),
      arrival_delay: countOf('arrival_delay'),
      departure_delay: countOf('departure_delay'),
      airport_closure: countOf('airport_closure'),
      closure_notam: countOf('closure_notam'),
      deicing: countOf('deicing'),
    };
    const events = all.filter((row) => applied.includes(row.eventType)).sort(compareEvents);
    ctx.enrich({
      appliedEventTypes: applied,
      countsByType,
      enRouteFeed,
      shown: events.length,
      totalActive: all.length,
    });

    const notices: string[] = [];
    if (enRouteFeed === 'unavailable') {
      ctx.log.warning('En-route leg failed; omitting Airspace Flow Programs', {
        reason: String(
          reasonOf(enrouteResult.status === 'rejected' ? enrouteResult.reason : undefined),
        ),
      });
      notices.push(
        'The FAA en-route feed could not be read, so Airspace Flow Programs are missing from this list and from countsByType; call faa_delays_list_active_events again in about a minute for them.',
      );
    }
    if (enRouteFeed === 'format_changed') {
      notices.push(
        'The FAA en-route feed returned a format this server does not read, so Airspace Flow Programs are missing from this list; airport events are complete, and faa_delays_get_operations_plan names the en-route initiatives the FAA plans.',
      );
    }
    if (filter && events.length === 0 && all.length > 0) {
      notices.push(
        `No active ${filter.join(' or ')} events; ${all.length} other events are active (see countsByType). Call faa_delays_list_active_events without event_types to see them.`,
      );
    }
    if (all.length === 0 && enRouteFeed === 'ok') {
      notices.push(
        'The FAA reports no active traffic management events nationwide. Call faa_delays_get_operations_plan for programs expected later today.',
      );
    }
    if (
      filter?.includes('airspace_flow_program') &&
      programs.length === 0 &&
      enRouteFeed === 'ok'
    ) {
      notices.push(
        'No Airspace Flow Programs are active; en-route constraints the FAA expects later are in faa_delays_get_operations_plan.',
      );
    }
    const skipped =
      airportFeed.skippedRows +
      (enrouteResult.status === 'fulfilled' ? enrouteResult.value.skippedRows : 0);
    if (skipped > 0) notices.push(`${skipped} FAA feed rows could not be read and were skipped.`);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Active events listed', { enRouteFeed, shown: events.length, total: all.length });
    return { fetchedAt: airportFeed.fetchedAt, events };
  },

  format: (result) => {
    const lines = [`**Fetched:** ${result.fetchedAt}`];
    for (const event of result.events) {
      lines.push(
        '',
        `### ${event.eventType} — ${inline(event.location)}${event.locationName ? ` (${inline(event.locationName)})` : ''}`,
      );
      if (event.reason) lines.push(`- Reason: ${inline(event.reason)}`);
      if (event.averageDelayMinutes !== undefined || event.maximumDelayMinutes !== undefined) {
        lines.push(
          `- Delay: average ${event.averageDelayMinutes ?? '?'} min${event.maximumDelayMinutes !== undefined ? `, maximum ${event.maximumDelayMinutes} min` : ''}`,
        );
      }
      if (event.delayRangeMinutes) {
        lines.push(
          `- Delay band: ${event.delayRangeMinutes.min}–${event.delayRangeMinutes.max} min${event.trend ? `, ${event.trend}` : ''}`,
        );
      } else if (event.trend) {
        lines.push(`- Trend: ${event.trend}`);
      }
      if (event.probabilityOfExtension) {
        lines.push(`- Probability of extension: ${event.probabilityOfExtension}`);
      }
      if (event.startTime || event.endTime) {
        lines.push(`- Window: ${span(event.startTime, event.endTime)}`);
      }
      if (event.updatedAt) lines.push(`- Updated: ${inline(event.updatedAt)}`);
      if (event.advisory) lines.push(`- Advisory: ${advisoryLine(event.advisory)}`);
      const afp = event.afp;
      if (afp) {
        const area = afp.constrainedArea;
        lines.push(`- Constrained area: ${area.type}${area.name ? ` ${inline(area.name)}` : ''}`);
        if (afp.altitudeFloor || afp.altitudeCeiling) {
          lines.push(
            `- Altitudes: ${afp.altitudeFloor ? inline(afp.altitudeFloor) : '?'} / ${afp.altitudeCeiling ? inline(afp.altitudeCeiling) : '?'}`,
          );
        }
        if (afp.departsFrom) lines.push(`- Departs from: ${inline(afp.departsFrom)}`);
        if (afp.arrivesTo) lines.push(`- Arrives to: ${inline(afp.arrivesTo)}`);
        if (afp.filtersMatchAny !== undefined) {
          lines.push(`- Filters match: ${afp.filtersMatchAny ? 'any (OR)' : 'all (AND)'}`);
        }
        if (afp.excludedDepartures) {
          lines.push(`- Excluded departures: ${inline(afp.excludedDepartures)}`);
        }
        if (afp.excludedArrivals)
          lines.push(`- Excluded arrivals: ${inline(afp.excludedArrivals)}`);
        if (afp.headingDirection) lines.push(`- Heading: ${inline(afp.headingDirection)}`);
        if (afp.delayProfile)
          lines.push(`- Delay profile: ${renderDelayProfile(afp.delayProfile)}`);
        if (afp.comments) lines.push('', blockquote(afp.comments));
      }
      if (event.closureText) lines.push('', blockquote(event.closureText));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
