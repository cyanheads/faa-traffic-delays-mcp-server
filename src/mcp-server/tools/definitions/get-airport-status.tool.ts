/**
 * @fileoverview faa_delays_get_airport_status — current FAA traffic management status for up to 25 US
 * airports: headline status, every active event with full detail, the runway configuration with
 * arrival rate, and the operations plan's planned programs naming each airport. Codes are
 * validated against the bundled NASR directory before any upstream request; the pacing and plan
 * legs degrade rather than failing the call.
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
import type { AirportEvents, Closure, OperationsPlan } from '@/services/nas-status/types.js';
import { DailyWindowFields, dailyWindowState, dailyWindowSuffix } from '../closure-window.js';
import {
  advisoryLine,
  blockquote,
  delayBand,
  delayFigures,
  inline,
  span,
} from '../format-helpers.js';
import {
  closureWindowNotice,
  skippedRowsNotice,
  staleDelayNotice,
  unreadableSectionsNotice,
} from '../notices.js';
import {
  AdvisoryRefSchema,
  DelayProfileSchema,
  PlannedItemSchema,
  plannedMeta,
  renderDelayProfile,
} from '../schemas.js';

const STATUSES = [
  'closed',
  'ground_stop',
  'ground_delay_program',
  'delays',
  'restrictions_only',
  'no_active_events',
] as const;

/** Most distinct airports one call processes. */
const MAX_AIRPORTS = 25;
const MAX_SUBMITTED_AIRPORTS = 100;

/**
 * Splits a comma- or whitespace-separated string into codes; other values pass through. Zod checks
 * the array's `.max()` before its elements, so an oversized list fails as one `too_big` issue
 * without any code being validated.
 */
function splitList(value: unknown): unknown {
  return typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
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

/** `closure` and `closureNotam`: the feed sends both as the same NOTAM record. */
const ClosureSchema = z.object({
  notamText: z.string().optional().describe('Full NOTAM text (FAA-authored).'),
  text: z
    .string()
    .optional()
    .describe(
      'The NOTAM wording without its header and effective period: the restriction or the closure exceptions (FAA-authored).',
    ),
  notamNumber: z.number().optional().describe('NOTAM number.'),
  issuedAt: z.string().optional().describe('NOTAM issue time (UTC ISO).'),
  startTime: z.string().optional().describe('Start (UTC ISO).'),
  endTime: z.string().optional().describe('End (UTC ISO).'),
  updatedAt: z.string().optional().describe('Last FAA update (UTC ISO).'),
  ...DailyWindowFields,
});

const PlannedProgramSchema = PlannedItemSchema.extend({
  advisory: AdvisoryRefSchema.optional(),
}).describe(
  'One terminal item of the current operations plan that names this airport, with the advisory reference of the plan.',
);

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
        'Headline status, first match wins: closed (an airport closure in effect; one outside its daily window, closure.inEffect false, is skipped) → ground_stop → ground_delay_program → delays (arrival or departure delay) → restrictions_only (listed with only a closure NOTAM, deicing, runway configuration, or an airport closure outside its daily window) → no_active_events (absent from the feed: no FAA program, which does not guarantee on-time flights).',
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
      .describe(
        'Effective IANA time zone; PHX reported as US/Mountain is corrected to America/Phoenix.',
      ),
    reportedTimezone: z
      .string()
      .optional()
      .describe('Original FAA time zone when a verified correction was applied.'),
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
    closure: ClosureSchema.optional().describe(
      'Airport closed to all operations, with its NOTAM; text lists the exceptions. A closure scheduled daily is closed only inside dailyWindowUtc, and inEffect says whether it is at fetchedAt.',
    ),
    closureNotam: ClosureSchema.optional().describe(
      'NOTAM-worded closure or restriction, often narrow (for example closed to transient GA).',
    ),
    deicing: z
      .object({
        startedAt: z.string().optional().describe('When deicing began (UTC ISO).'),
      })
      .optional()
      .describe('A formal deicing program is in effect.'),
    plannedPrograms: z
      .array(PlannedProgramSchema)
      .optional()
      .describe(
        "The current operations plan's terminal ground-stop and delay-program items that name this airport, each identical item once, with times as the plan states them (see timeUtc; an item past its time is not filtered out). [] when the plan names the airport nowhere, which does not mean no trouble is expected: en-route items, constraints, and runway closures stay in faa_delays_get_operations_plan and the plan advisory. Absent when the operations plan could not be read. Never changes status.",
      ),
  })
  .describe('Status of one requested airport.');

type Row = z.infer<typeof RowSchema>;

type ClosureRow = z.infer<typeof ClosureSchema>;

type PlannedProgram = z.infer<typeof PlannedProgramSchema>;

/** The parser's name for the plan's terminal list when it could not be read. */
const TERMINAL_PLANNED_SECTION = 'operations-plan.terminalPlanned';

/**
 * The plan's terminal items under each airport they name, an identical item once per airport;
 * undefined when the terminal list could not be read, so no row reads as named nowhere.
 */
function plannedByAirport(plan: OperationsPlan): Map<string, PlannedProgram[]> | undefined {
  if (plan.unreadableSections?.includes(TERMINAL_PLANNED_SECTION)) return;
  const byAirport = new Map<string, PlannedProgram[]>();
  for (const { airports = [], ...item } of plan.terminalPlanned) {
    for (const airportId of airports) {
      const programs = byAirport.get(airportId) ?? [];
      if (programs.some((seen) => seen.text === item.text && seen.timeUtc === item.timeUtc)) {
        continue;
      }
      programs.push(plan.advisory ? { ...item, advisory: plan.advisory } : item);
      byAirport.set(airportId, programs);
    }
  }
  return byAirport;
}

/** The closure with `inEffect` at `fetchedAt` when its NOTAM schedules a daily window. */
function withWindowState(closure: Closure, fetchedAt: string): ClosureRow {
  const state = dailyWindowState(closure, fetchedAt);
  return state ? { ...closure, inEffect: state.inEffect } : closure;
}

/** A closure outside its daily window does not close the airport, so the precedence moves on. */
function deriveStatus(
  events: AirportEvents | undefined,
  closure: ClosureRow | undefined,
): Row['status'] {
  if (!events) return 'no_active_events';
  if (closure && closure.inEffect !== false) return 'closed';
  if (events.groundStop) return 'ground_stop';
  if (events.groundDelayProgram) return 'ground_delay_program';
  if (events.arrivalDelay || events.departureDelay) return 'delays';
  return 'restrictions_only';
}

function buildRow(
  airport: DirectoryAirport,
  requestedAs: string | undefined,
  events: AirportEvents | undefined,
  pacing: Map<string, { timezone?: string; reportedTimezone?: string }> | undefined,
  plannedPrograms: PlannedProgram[] | undefined,
  fetchedAt: string,
): Row {
  const pacingEntry = pacing?.get(airport.faaId);
  const located = events ?? airport;
  const closure = events?.closure && withWindowState(events.closure, fetchedAt);
  const closureNotam = events?.closureNotam && withWindowState(events.closureNotam, fetchedAt);
  return {
    airportId: airport.faaId,
    ...(requestedAs && { requestedAs }),
    airportName: events?.airportName ?? airport.name,
    ...(airport.city && { city: airport.city }),
    ...(airport.state && { state: airport.state }),
    ...(airport.artcc && { artcc: airport.artcc }),
    status: deriveStatus(events, closure),
    listedInFeed: events !== undefined,
    ...(located.latitude !== undefined && { latitude: located.latitude }),
    ...(located.longitude !== undefined && { longitude: located.longitude }),
    ...(pacing && { isPacingAirport: pacingEntry !== undefined }),
    ...(pacingEntry?.timezone && { timezone: pacingEntry.timezone }),
    ...(pacingEntry?.reportedTimezone && { reportedTimezone: pacingEntry.reportedTimezone }),
    ...(events?.runwayConfiguration && { runwayConfiguration: events.runwayConfiguration }),
    ...(events?.groundStop && { groundStop: events.groundStop }),
    ...(events?.groundDelayProgram && { groundDelayProgram: events.groundDelayProgram }),
    ...(events?.arrivalDelay && { arrivalDelay: events.arrivalDelay }),
    ...(events?.departureDelay && { departureDelay: events.departureDelay }),
    ...(closure && { closure }),
    ...(closureNotam && { closureNotam }),
    ...(events?.deicing && { deicing: events.deicing }),
    ...(plannedPrograms && { plannedPrograms }),
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

/**
 * `- Detail: text` for one line of FAA text; a multi-line text keeps its line breaks as a quote
 * nested under the label, so a CommonMark reader gets the lines `structuredContent` carries.
 */
function labeledText(label: string, text: string): string[] {
  if (!/[\r\n]/.test(text)) return [`- ${label}: ${inline(text)}`];
  return [
    `- ${label}:`,
    ...blockquote(text)
      .split('\n')
      .map((line) => `  ${line}`),
  ];
}

/** A closure or closure NOTAM: its window, issue and update times, wording, and quoted NOTAM. */
function renderClosure(heading: string, textLabel: string, closure: ClosureRow): string[] {
  const lines = [
    `**${heading}:** ${span(closure.startTime, closure.endTime)}${dailyWindowSuffix(closure)}`,
  ];
  if (closure.issuedAt) lines.push(`- Issued: ${inline(closure.issuedAt)}`);
  if (closure.updatedAt) lines.push(`- Updated: ${inline(closure.updatedAt)}`);
  if (closure.text) lines.push(...labeledText(textLabel, closure.text));
  if (closure.notamText) lines.push(blockquote(closure.notamText));
  return lines;
}

/** The plan items naming one airport, each with its time, likelihood, and advisory line. */
function renderPlannedPrograms(programs: PlannedProgram[]): string[] {
  if (programs.length === 0) return ['**Planned programs:** none named in the operations plan'];
  const lines = [`**Planned programs (${programs.length}):**`];
  programs.forEach((program, index) => {
    const advisory = program.advisory ? ` · ${advisoryLine(program.advisory)}` : '';
    lines.push('', `${index + 1}. ${plannedMeta(program)}${advisory}`, blockquote(program.text));
  });
  return lines;
}

export const getAirportStatus = tool('faa_delays_get_airport_status', {
  title: 'Get FAA Airport Status',
  description:
    "Get the current FAA traffic management status for one or more US airports: a headline status, every active event (ground stop, Ground Delay Program with its delay profile, arrival or departure delay, closure, deicing) with reason and times, and the runway configuration and airport arrival rate. Each row also carries plannedPrograms, the current operations plan's terminal ground-stop and delay-program items that name the airport, with the plan's times as written. Every row carries the airport's ARTCC, and its coordinates come from the feed when the airport is listed (absent when the feed omits them) and from the NASR directory otherwise; both place a departure airport against a program's includedFacilities and departureScopeNm. Airports are FAA 3-character identifiers (SEA, ORD, JFK) or their ICAO codes (KSEA, PHNL); a code that names no US airport is rejected. The FAA feed lists only airports with an active event, so a known airport absent from it returns status no_active_events, and runway configuration is available only for listed airports.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    airports: z
      .preprocess(splitList, z.array(AirportCode).min(1).max(MAX_SUBMITTED_AIRPORTS))
      .describe(
        '1–100 submitted US airport codes, each a 3-character FAA location identifier (SEA, ORD, 0S9) or its ICAO code (KSEA, PHNL, TJSJ), case-insensitive; a comma-separated string is also accepted. Validates every code, deduplicates FAA/ICAO equivalents, and processes the first 25 distinct airports with the canonical remainder returned as omittedAirports. City and airport names are not accepted.',
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
      .describe(
        'One row per processed airport, in first-seen request order, up to 25 distinct FAA identifiers.',
      ),
  }),
  enrichment: {
    cap: z.number().int().describe('Maximum distinct airports processed: 25.'),
    processedCount: z.number().int().describe('Distinct airports processed in this response.'),
    omittedAirports: z
      .array(z.string())
      .describe(
        'Canonical FAA identifiers left after the first 25 distinct airports, in first-seen order; empty when all were processed.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance on quiet results, stale delay entries, or partial data.'),
  },
  enrichmentTrailer: {
    cap: { label: 'Cap' },
    processedCount: { label: 'Processed count' },
    omittedAirports: {
      render: (codes: string[]) =>
        `**Omitted airports:** ${codes.length ? codes.join(', ') : 'none'}`,
    },
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
    const [eventsResult, pacingResult, planResult] = await Promise.allSettled([
      nas.getAirportEvents(ctx),
      nas.getPacingAirports(ctx),
      nas.getOperationsPlan(ctx),
    ]);
    if (eventsResult.status === 'rejected') throw eventsResult.reason;
    if (pacingResult.status === 'rejected' && ctx.signal.aborted) throw pacingResult.reason;
    if (planResult.status === 'rejected' && ctx.signal.aborted) throw planResult.reason;

    const feed = eventsResult.value;
    const eventsById = new Map(feed.rows.map((row) => [row.airportId, row]));
    const pacing =
      pacingResult.status === 'fulfilled'
        ? new Map(pacingResult.value.rows.map((row) => [row.airportId, row]))
        : undefined;
    const plan = planResult.status === 'fulfilled' ? planResult.value : undefined;
    const planned = plan && plannedByAirport(plan);
    const omittedAirports = requested.slice(MAX_AIRPORTS).map(({ airport }) => airport.faaId);
    const airports = requested
      .slice(0, MAX_AIRPORTS)
      .map(({ airport, requestedAs }) =>
        buildRow(
          airport,
          requestedAs,
          eventsById.get(airport.faaId),
          pacing,
          planned && (planned.get(airport.faaId) ?? []),
          feed.fetchedAt,
        ),
      );

    const notices = unreadableSectionsNotice([
      ...(feed.unreadableSections ?? []),
      ...(plan && !planned ? [TERMINAL_PLANNED_SECTION] : []),
    ]);
    ctx.enrich({ cap: MAX_AIRPORTS, processedCount: airports.length, omittedAirports });
    if (omittedAirports.length > 0)
      notices.push(
        'Call faa_delays_get_airport_status again with omittedAirports as airports to process the remainder.',
      );
    if (airports.every((row) => row.status === 'no_active_events')) {
      notices.push('None of the processed airports has an active FAA traffic management event.');
    }
    for (const row of airports) {
      for (const [kind, band] of [
        ['arrival', row.arrivalDelay],
        ['departure', row.departureDelay],
      ] as const) {
        const stale = staleDelayNotice(row.airportId, kind, band?.updatedAt, feed.fetchedAt);
        if (stale) notices.push(stale);
      }
      for (const [kind, closure] of [
        ['airport closure', row.closure],
        ['closure NOTAM', row.closureNotam],
      ] as const) {
        const outside =
          closure && closureWindowNotice(row.airportId, kind, closure, feed.fetchedAt);
        if (outside) notices.push(outside);
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
    if (planResult.status === 'rejected') {
      ctx.log.warning('Operations-plan leg failed; omitting plannedPrograms', {
        error:
          planResult.reason instanceof Error
            ? planResult.reason.message
            : String(planResult.reason),
      });
      notices.push(
        'plannedPrograms is omitted because the FAA operations plan could not be read; faa_delays_get_operations_plan returns the reason and when to retry.',
      );
    }
    const skipped =
      feed.skippedRows +
      (pacingResult.status === 'fulfilled' ? pacingResult.value.skippedRows : 0) +
      (plan?.skippedRows ?? 0);
    if (skipped > 0) notices.push(skippedRowsNotice(skipped));
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
      if (row.reportedTimezone)
        lines.push(`**FAA-reported time zone:** ${inline(row.reportedTimezone)}`);
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
        const number = closure.notamNumber !== undefined ? ` (NOTAM ${closure.notamNumber})` : '';
        // Outside its daily window the closure does not close the airport, so the heading names it.
        const heading = closure.inEffect === false ? 'Airport closure' : 'Airport closed';
        lines.push('', ...renderClosure(`${heading}${number}`, 'Detail', closure));
      }

      const notam = row.closureNotam;
      if (notam) {
        const number = notam.notamNumber !== undefined ? ` ${notam.notamNumber}` : '';
        lines.push('', ...renderClosure(`Closure NOTAM${number}`, 'Restriction', notam));
      }

      if (row.deicing)
        lines.push(
          '',
          `**Deicing:** in effect since ${row.deicing.startedAt ? inline(row.deicing.startedAt) : 'unknown'}`,
        );

      if (row.plannedPrograms) lines.push('', ...renderPlannedPrograms(row.plannedPrograms));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
