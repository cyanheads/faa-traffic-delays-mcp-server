/**
 * @fileoverview faa_delays_get_airport_status — current FAA traffic management status for 1–25 US
 * airports: headline status, every active event with full detail, and the runway configuration
 * with arrival rate. Codes are validated against the bundled NASR directory before any upstream
 * request.
 * @module mcp-server/tools/definitions/get-airport-status
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  type DirectoryAirport,
  normalizeAirportCode,
  resolveAirportCode,
} from '@/services/airport-directory/airport-directory.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import type { AirportEvents } from '@/services/nas-status/types.js';
import {
  advisoryLine,
  blockquote,
  delayBand,
  delayFigures,
  inline,
  span,
} from '../format-helpers.js';
import { skippedRowsNotice, staleDelayNotice } from '../notices.js';
import { AdvisoryRefSchema, DelayProfileSchema, renderDelayProfile } from '../schemas.js';

const STATUSES = [
  'closed',
  'ground_stop',
  'ground_delay_program',
  'delays',
  'restrictions_only',
  'no_active_events',
] as const;

/** Most airports one call accepts. */
const MAX_AIRPORTS = 25;

/**
 * Splits a comma- or whitespace-separated string into codes; other values pass through. A list is
 * cut to one past MAX_AIRPORTS, so an oversized one fails the size check with at most that many
 * code issues rather than one per code sent.
 */
function splitList(value: unknown): unknown {
  const list = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
  return Array.isArray(list) ? list.slice(0, MAX_AIRPORTS + 1) : list;
}

const AirportCode = z
  .preprocess(
    normalizeAirportCode,
    z
      .string()
      .regex(/^[A-Z0-9]{3,4}$/)
      .describe(
        'US airport: 3-character FAA identifier (SEA) or its ICAO code (KSEA); trimmed and uppercased before validation.',
      ),
  )
  .describe(
    'US airport: 3-character FAA identifier (SEA) or its ICAO code (KSEA); trimmed and uppercased before validation.',
  );

const DelayBandSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe('Stated cause (FAA-authored text), e.g. "RWY:Construction".'),
  minMinutes: z
    .number()
    .optional()
    .describe(
      'Lower bound of the delay band in minutes (the FAA reports delays in 15-minute bands).',
    ),
  maxMinutes: z.number().optional().describe('Upper bound of the delay band in minutes.'),
  trend: z.enum(['increasing', 'decreasing']).optional().describe('Direction the delay is moving.'),
  updatedAt: z
    .string()
    .optional()
    .describe('When the FAA last updated this delay (UTC ISO); an entry can outlive the delay.'),
});

const RowSchema = z
  .object({
    airportId: z.string().describe('Normalized 3-character FAA identifier.'),
    requestedAs: z
      .string()
      .optional()
      .describe(
        'The code as submitted (an ICAO code), present only when it differs from airportId.',
      ),
    airportName: z
      .string()
      .describe(
        'Airport name: the feed name when listed, else the FAA NASR directory name. It shows which airport the requested code resolved to.',
      ),
    city: z.string().optional().describe('City from the NASR directory.'),
    state: z.string().optional().describe('State or territory code from the NASR directory.'),
    artcc: z
      .string()
      .optional()
      .describe(
        "Air Route Traffic Control Center responsible for the airport, from the NASR directory (ZSE), in the form a program's includedFacilities lists ARTCCs. A few airports belong to a foreign or oceanic facility (ZVR, NZZO); faa_delays_list_reference topic artccs decodes every code.",
      ),
    status: z
      .enum(STATUSES)
      .describe(
        'Headline status, first match wins: closed (airport closure) → ground_stop → ground_delay_program → delays (arrival or departure delay) → restrictions_only (listed with only a closure NOTAM, deicing, or runway configuration) → no_active_events (absent from the feed: no FAA program, which does not guarantee on-time flights).',
      ),
    listedInFeed: z
      .boolean()
      .describe(
        'Whether the FAA feed lists this airport; it lists only airports with an active event.',
      ),
    latitude: z
      .number()
      .optional()
      .describe(
        "Latitude in decimal degrees: the feed's value for a listed airport, else the NASR directory's (4 decimal places).",
      ),
    longitude: z
      .number()
      .optional()
      .describe(
        "Longitude in decimal degrees: the feed's value for a listed airport, else the NASR directory's (4 decimal places).",
      ),
    isPacingAirport: z
      .boolean()
      .optional()
      .describe(
        'Whether the FAA tracks this as a pacing airport; omitted when that list could not be read.',
      ),
    timezone: z
      .string()
      .optional()
      .describe('IANA-style time zone the FAA assigns to a pacing airport (US/Pacific).'),
    runwayConfiguration: z
      .object({
        arrivalRunways: z
          .string()
          .optional()
          .describe('Arrival runways in use (FAA-authored text).'),
        departureRunways: z
          .string()
          .optional()
          .describe('Departure runways in use (FAA-authored text).'),
        arrivalRatePerHour: z
          .number()
          .optional()
          .describe('Airport arrival rate (AAR): arrivals the airport accepts per hour.'),
        reportedAt: z
          .string()
          .optional()
          .describe('When the FAA recorded this configuration (UTC ISO).'),
      })
      .optional()
      .describe(
        'Runway configuration and arrival rate; reported only for airports the feed lists.',
      ),
    groundStop: z
      .object({
        reason: z.string().optional().describe('Stated cause (FAA-authored text).'),
        startTime: z.string().optional().describe('Start (UTC ISO).'),
        endTime: z.string().optional().describe('Scheduled end (UTC ISO).'),
        probabilityOfExtension: z
          .enum(['low', 'medium', 'high'])
          .optional()
          .describe(
            'Likelihood the stop is extended: low <30 %, medium 30–60 %, high >60 % per the FAA.',
          ),
        includedFacilities: z
          .array(z.string().describe('ARTCC code, as in artcc, or 4-character ICAO airport code.'))
          .optional()
          .describe(
            "Departure facilities in scope: ARTCC codes for a tier-scoped stop, in the form of each row's artcc, and 4-character ICAO codes for named airports.",
          ),
        updatedAt: z.string().optional().describe('Last FAA update (UTC ISO).'),
        advisory: AdvisoryRefSchema.optional(),
        includedFlights: z
          .string()
          .optional()
          .describe('Flights included, such as ALL CONTIGUOUS US DEP (FAA-authored text).'),
        controllingCenter: z.string().optional().describe('Controlling ARTCC code (ZSE).'),
      })
      .optional()
      .describe(
        'Active ground stop: flights to this airport are held at their departure airports.',
      ),
    groundDelayProgram: z
      .object({
        reason: z.string().optional().describe('Stated cause (FAA-authored text).'),
        averageDelayMinutes: z.number().optional().describe('Average assigned delay in minutes.'),
        maximumDelayMinutes: z.number().optional().describe('Maximum assigned delay in minutes.'),
        startTime: z
          .string()
          .optional()
          .describe(
            "Start of the current revision's arrival window (UTC ISO); a revised program keeps its earlier start in programStartTime.",
          ),
        programStartTime: z
          .string()
          .optional()
          .describe('When the program began, before any revision (UTC ISO).'),
        endTime: z.string().optional().describe('Program end (UTC ISO).'),
        updatedAt: z.string().optional().describe('Last FAA update (UTC ISO).'),
        controllingCenter: z.string().optional().describe('Controlling ARTCC code (ZSE).'),
        departureScopeNm: z
          .number()
          .optional()
          .describe('Departure scope: departures within this many nautical miles are included.'),
        includedFacilities: z
          .array(z.string().describe('ARTCC code, as in artcc, or 4-character ICAO airport code.'))
          .optional()
          .describe(
            "Departure facilities in scope: ARTCC codes, in the form of each row's artcc, and 4-character ICAO codes for named airports, such as Canadian airports.",
          ),
        includedFlights: z
          .string()
          .optional()
          .describe('Flights included, such as ALL CONTIGUOUS US DEP (FAA-authored text).'),
        delayProfile: DelayProfileSchema.optional(),
        advisory: AdvisoryRefSchema.optional(),
      })
      .optional()
      .describe(
        'Active Ground Delay Program: flights to this airport receive assigned departure delays.',
      ),
    arrivalDelay: DelayBandSchema.optional().describe('Active arrival delay (airborne holding).'),
    departureDelay: DelayBandSchema.optional().describe(
      'Active departure delay (taxi or gate holds).',
    ),
    closure: z
      .object({
        text: z.string().optional().describe('Closure detail and exceptions (FAA-authored text).'),
        startTime: z.string().optional().describe('Start (UTC ISO).'),
        endTime: z.string().optional().describe('End (UTC ISO).'),
        updatedAt: z.string().optional().describe('Last FAA update (UTC ISO).'),
      })
      .optional()
      .describe('Airport closed to all operations; text lists exceptions.'),
    closureNotam: z
      .object({
        notamText: z.string().optional().describe('Full NOTAM text (FAA-authored).'),
        text: z.string().optional().describe('The restriction wording (FAA-authored).'),
        notamNumber: z.number().optional().describe('NOTAM number.'),
        issuedAt: z.string().optional().describe('NOTAM issue time (UTC ISO).'),
        startTime: z.string().optional().describe('Start (UTC ISO).'),
        endTime: z.string().optional().describe('End (UTC ISO).'),
        updatedAt: z.string().optional().describe('Last FAA update (UTC ISO).'),
      })
      .optional()
      .describe(
        'NOTAM-worded closure or restriction, often narrow (for example closed to transient GA).',
      ),
    deicing: z
      .object({
        startedAt: z.string().optional().describe('When deicing began (UTC ISO).'),
      })
      .optional()
      .describe('A formal deicing program is in effect.'),
  })
  .describe('Status of one requested airport.');

type Row = z.infer<typeof RowSchema>;

function deriveStatus(events: AirportEvents | undefined): Row['status'] {
  if (!events) return 'no_active_events';
  if (events.closure) return 'closed';
  if (events.groundStop) return 'ground_stop';
  if (events.groundDelayProgram) return 'ground_delay_program';
  if (events.arrivalDelay || events.departureDelay) return 'delays';
  return 'restrictions_only';
}

function buildRow(
  airport: DirectoryAirport,
  requestedAs: string | undefined,
  events: AirportEvents | undefined,
  pacing: Map<string, { timezone?: string }> | undefined,
): Row {
  const pacingEntry = pacing?.get(airport.faaId);
  const located = events ?? airport;
  return {
    airportId: airport.faaId,
    ...(requestedAs && { requestedAs }),
    airportName: events?.airportName ?? airport.name,
    ...(airport.city && { city: airport.city }),
    ...(airport.state && { state: airport.state }),
    ...(airport.artcc && { artcc: airport.artcc }),
    status: deriveStatus(events),
    listedInFeed: events !== undefined,
    ...(located.latitude !== undefined && { latitude: located.latitude }),
    ...(located.longitude !== undefined && { longitude: located.longitude }),
    ...(pacing && { isPacingAirport: pacingEntry !== undefined }),
    ...(pacingEntry?.timezone && { timezone: pacingEntry.timezone }),
    ...(events?.runwayConfiguration && { runwayConfiguration: events.runwayConfiguration }),
    ...(events?.groundStop && { groundStop: events.groundStop }),
    ...(events?.groundDelayProgram && { groundDelayProgram: events.groundDelayProgram }),
    ...(events?.arrivalDelay && { arrivalDelay: events.arrivalDelay }),
    ...(events?.departureDelay && { departureDelay: events.departureDelay }),
    ...(events?.closure && { closure: events.closure }),
    ...(events?.closureNotam && { closureNotam: events.closureNotam }),
    ...(events?.deicing && { deicing: events.deicing }),
  };
}

/** `47.4502, -122.3088`, or the one coordinate a row carries, named. */
function coordinates(
  latitude: number | undefined,
  longitude: number | undefined,
): string | undefined {
  if (latitude !== undefined && longitude !== undefined) return `${latitude}, ${longitude}`;
  if (latitude !== undefined) return `latitude ${latitude}`;
  if (longitude !== undefined) return `longitude ${longitude}`;
  return;
}

function renderDelayBand(label: string, band: z.infer<typeof DelayBandSchema>): string[] {
  const range = delayBand(band.minMinutes, band.maxMinutes) ?? 'band not reported';
  const lines = [`**${label}:** ${range}${band.trend ? `, ${band.trend}` : ''}`];
  if (band.reason) lines.push(`- Reason: ${inline(band.reason)}`);
  if (band.updatedAt) lines.push(`- Updated: ${inline(band.updatedAt)}`);
  return lines;
}

export const getAirportStatus = tool('faa_delays_get_airport_status', {
  title: 'Get FAA Airport Status',
  description:
    "Get the current FAA traffic management status for one or more US airports: a headline status, every active event (ground stop, Ground Delay Program with its delay profile, arrival or departure delay, closure, deicing) with reason and times, and the runway configuration and airport arrival rate. Every row carries the airport's ARTCC, and its coordinates come from the feed when the airport is listed (absent when the feed omits them) and from the NASR directory otherwise; both place a departure airport against a program's includedFacilities and departureScopeNm. Airports are FAA 3-character identifiers (SEA, ORD, JFK) or their ICAO codes (KSEA, PHNL); a code that names no US airport is rejected. The FAA feed lists only airports with an active event, so a known airport absent from it returns status no_active_events, and runway configuration is available only for listed airports.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    airports: z
      .preprocess(splitList, z.array(AirportCode).min(1).max(MAX_AIRPORTS))
      .describe(
        '1–25 US airports, each a 3-character FAA location identifier (SEA, ORD, 0S9) or its ICAO code (KSEA, PHNL, TJSJ), case-insensitive; a comma-separated string is also accepted. City and airport names are not accepted.',
      ),
  }),
  output: z.object({
    fetchedAt: z
      .string()
      .describe(
        'When this server fetched the snapshot from the FAA (UTC ISO); with the 60 s cache it can trail the call by up to a minute.',
      ),
    airports: z
      .array(RowSchema)
      .describe('One row per requested airport, in request order, duplicates dropped.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance on quiet results, stale delay entries, or partial data.'),
  },
  errors: [
    {
      reason: 'unknown_airport',
      code: JsonRpcErrorCode.NotFound,
      when: 'A requested code is not a 3-character identifier in the FAA NASR airport directory, or a 4-character code that is not the ICAO code of one',
      severity: 'notice',
      recovery:
        'Send each airport as its 3-character FAA identifier (SEA) or ICAO code (KSEA); faa_delays_list_reference topic identifiers explains the accepted forms and topic pacing_airports lists the FAA major airports.',
    },
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NAS Status unreachable, 5xx, an attempt timeout, or an HTML maintenance page, after retries',
      recovery:
        'The FAA NAS Status feed is temporarily unreachable; call faa_delays_get_airport_status again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The FAA returned 429 after retries, or this server's queue to the FAA would wait past 10 s while backing off from an FAA 429",
      recovery:
        "The FAA feed is limiting request rate; wait the retryAfter interval in this error's data (about a minute when it carries none), then call faa_delays_get_airport_status again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The 20 s retry budget ran out',
      recovery:
        'The FAA NAS Status feed is responding slowly; call faa_delays_get_airport_status again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own queue to the FAA would wait past 10 s with no FAA 429 backoff in effect",
      recovery:
        "This server is pacing its requests to the FAA; wait the retryAfter seconds in this error's data, then call faa_delays_get_airport_status again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'feed_contract_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The feed path returned 404/410, or a body whose shape this server no longer recognizes',
      recovery:
        "The FAA NAS Status feed is not serving the format this server reads, which usually means the FAA changed it, so an immediate retry will not help; faa_delays_list_advisories with control_element set to the airport still lists today's ATCSCC advisories for it (ground stops, delay programs, and their cancellations), and faa_delays_get_advisory reads any of them in full by number and date.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const requested: { airport: DirectoryAirport; requestedAs?: string }[] = [];
    const unknownCodes: string[] = [];
    const seen = new Set<string>();
    for (const code of input.airports) {
      const airport = resolveAirportCode(code);
      if (!airport) {
        if (!unknownCodes.includes(code)) unknownCodes.push(code);
        continue;
      }
      if (seen.has(airport.faaId)) continue;
      seen.add(airport.faaId);
      requested.push({ airport, ...(code !== airport.faaId && { requestedAs: code }) });
    }
    if (unknownCodes.length > 0) {
      const described = unknownCodes.map((code) =>
        code.length === 4
          ? `${code} (not the ICAO code of a US airport with a 3-character FAA identifier)`
          : `${code} (not a US FAA location identifier)`,
      );
      throw ctx.fail('unknown_airport', `Unknown airport code: ${described.join('; ')}.`, {
        unknownCodes,
      });
    }

    const nas = getNasStatusService();
    const [eventsResult, pacingResult] = await Promise.allSettled([
      nas.getAirportEvents(ctx),
      nas.getPacingAirports(ctx),
    ]);
    if (eventsResult.status === 'rejected') throw eventsResult.reason;
    if (pacingResult.status === 'rejected' && ctx.signal.aborted) throw pacingResult.reason;

    const feed = eventsResult.value;
    const eventsById = new Map(feed.rows.map((row) => [row.airportId, row]));
    const pacing =
      pacingResult.status === 'fulfilled'
        ? new Map(pacingResult.value.rows.map((row) => [row.airportId, row]))
        : undefined;
    const airports = requested.map(({ airport, requestedAs }) =>
      buildRow(airport, requestedAs, eventsById.get(airport.faaId), pacing),
    );

    const notices: string[] = [];
    if (airports.every((row) => row.status === 'no_active_events')) {
      notices.push(
        'None of the requested airports has an active FAA traffic management event. faa_delays_get_operations_plan lists programs the FAA expects later today.',
      );
    }
    for (const row of airports) {
      for (const [kind, band] of [
        ['arrival', row.arrivalDelay],
        ['departure', row.departureDelay],
      ] as const) {
        const stale = staleDelayNotice(row.airportId, kind, band?.updatedAt, feed.fetchedAt);
        if (stale) notices.push(stale);
      }
    }
    if (pacingResult.status === 'rejected') {
      ctx.log.warning('Pacing-airport leg failed; omitting pacing fields', {
        error:
          pacingResult.reason instanceof Error
            ? pacingResult.reason.message
            : String(pacingResult.reason),
      });
      notices.push(
        'Pacing-airport flags and time zones are omitted because that FAA list could not be fetched.',
      );
    }
    if (feed.skippedRows > 0) notices.push(skippedRowsNotice(feed.skippedRows));
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Airport status resolved', {
      airports: airports.map((row) => row.airportId),
      listed: airports.filter((row) => row.listedInFeed).length,
    });
    return { fetchedAt: feed.fetchedAt, airports };
  },

  format: (result) => {
    const lines = [`**Fetched:** ${result.fetchedAt}`];
    for (const row of result.airports) {
      const place = [row.city, row.state].flatMap((part) => (part ? [inline(part)] : []));
      lines.push(
        '',
        `## ${row.airportId} — ${inline(row.airportName)}${place.length > 0 ? ` (${place.join(', ')})` : ''}`,
        `**Status:** ${row.status} · **Listed in feed:** ${row.listedInFeed ? 'yes' : 'no'}${row.requestedAs ? ` · **Requested as:** ${row.requestedAs}` : ''}`,
      );
      const position = coordinates(row.latitude, row.longitude);
      const location = [
        ...(row.artcc ? [`**ARTCC:** ${inline(row.artcc)}`] : []),
        ...(position ? [`**Coordinates:** ${position}`] : []),
      ];
      if (location.length > 0) lines.push(location.join(' · '));
      if (row.isPacingAirport !== undefined) {
        lines.push(
          `**Pacing airport:** ${row.isPacingAirport ? 'yes' : 'no'}${row.timezone ? ` · **Time zone:** ${inline(row.timezone)}` : ''}`,
        );
      } else if (row.timezone) {
        lines.push(`**Time zone:** ${inline(row.timezone)}`);
      }

      const config = row.runwayConfiguration;
      if (config) {
        lines.push('', '**Runway configuration:**');
        if (config.arrivalRunways)
          lines.push(`- Arrival runways: ${inline(config.arrivalRunways)}`);
        if (config.departureRunways)
          lines.push(`- Departure runways: ${inline(config.departureRunways)}`);
        if (config.arrivalRatePerHour !== undefined) {
          lines.push(`- Arrival rate: ${config.arrivalRatePerHour} per hour`);
        }
        if (config.reportedAt) lines.push(`- Reported: ${inline(config.reportedAt)}`);
      }

      const stop = row.groundStop;
      if (stop) {
        lines.push('', `**Ground stop:** ${span(stop.startTime, stop.endTime)}`);
        if (stop.reason) lines.push(`- Reason: ${inline(stop.reason)}`);
        if (stop.probabilityOfExtension) {
          lines.push(`- Probability of extension: ${stop.probabilityOfExtension}`);
        }
        if (stop.includedFacilities) {
          lines.push(`- Included facilities: ${stop.includedFacilities.map(inline).join(' ')}`);
        }
        if (stop.includedFlights) lines.push(`- Included flights: ${inline(stop.includedFlights)}`);
        if (stop.controllingCenter)
          lines.push(`- Controlling center: ${inline(stop.controllingCenter)}`);
        if (stop.updatedAt) lines.push(`- Updated: ${inline(stop.updatedAt)}`);
        if (stop.advisory) lines.push(`- Advisory: ${advisoryLine(stop.advisory)}`);
      }

      const gdp = row.groundDelayProgram;
      if (gdp) {
        lines.push('', `**Ground Delay Program:** ${span(gdp.startTime, gdp.endTime)}`);
        if (gdp.programStartTime) {
          const revised = gdp.startTime !== undefined && gdp.startTime !== gdp.programStartTime;
          lines.push(
            `- Program start: ${inline(gdp.programStartTime)}${revised ? ' (the window above is the current revision)' : ''}`,
          );
        }
        if (gdp.reason) lines.push(`- Reason: ${inline(gdp.reason)}`);
        const delay = delayFigures(gdp.averageDelayMinutes, gdp.maximumDelayMinutes);
        if (delay) lines.push(`- Delay: ${delay}`);
        if (gdp.delayProfile)
          lines.push(`- Delay profile: ${renderDelayProfile(gdp.delayProfile)}`);
        if (gdp.controllingCenter)
          lines.push(`- Controlling center: ${inline(gdp.controllingCenter)}`);
        if (gdp.departureScopeNm !== undefined) {
          lines.push(`- Departure scope: ${gdp.departureScopeNm} nm`);
        }
        if (gdp.includedFacilities) {
          lines.push(`- Included facilities: ${gdp.includedFacilities.map(inline).join(' ')}`);
        }
        if (gdp.includedFlights) lines.push(`- Included flights: ${inline(gdp.includedFlights)}`);
        if (gdp.updatedAt) lines.push(`- Updated: ${inline(gdp.updatedAt)}`);
        if (gdp.advisory) lines.push(`- Advisory: ${advisoryLine(gdp.advisory)}`);
      }

      if (row.arrivalDelay) lines.push('', ...renderDelayBand('Arrival delay', row.arrivalDelay));
      if (row.departureDelay) {
        lines.push('', ...renderDelayBand('Departure delay', row.departureDelay));
      }

      const closure = row.closure;
      if (closure) {
        lines.push('', `**Airport closed:** ${span(closure.startTime, closure.endTime)}`);
        if (closure.updatedAt) lines.push(`- Updated: ${inline(closure.updatedAt)}`);
        if (closure.text) lines.push(blockquote(closure.text));
      }

      const notam = row.closureNotam;
      if (notam) {
        lines.push(
          '',
          `**Closure NOTAM${notam.notamNumber !== undefined ? ` ${notam.notamNumber}` : ''}:** ${span(notam.startTime, notam.endTime)}`,
        );
        if (notam.issuedAt) lines.push(`- Issued: ${inline(notam.issuedAt)}`);
        if (notam.updatedAt) lines.push(`- Updated: ${inline(notam.updatedAt)}`);
        if (notam.text) lines.push(`- Restriction: ${inline(notam.text)}`);
        if (notam.notamText) lines.push(blockquote(notam.notamText));
      }

      if (row.deicing)
        lines.push(
          '',
          `**Deicing:** in effect since ${row.deicing.startedAt ? inline(row.deicing.startedAt) : 'unknown'}`,
        );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
