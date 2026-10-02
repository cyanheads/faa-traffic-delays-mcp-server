/**
 * @fileoverview faa_delays_list_reference — decoder for the vocabulary the other faa_delays tools
 * return: event types, traffic-management terms, ARTCC codes, the FAA pacing airports (live), and
 * accepted identifier formats.
 * @module mcp-server/tools/definitions/list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDirectoryInfo } from '@/services/airport-directory/airport-directory.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import { cell } from '../format-helpers.js';
import { type EventType, EventTypeSchema } from '../schemas.js';

const TOPICS = ['event_types', 'terms', 'artccs', 'pacing_airports', 'identifiers'] as const;

/** Trims, lowercases, and maps `-`/space to `_` (`"Pacing Airports"` → `pacing_airports`). */
function normalizeTopic(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

const EVENT_TYPE_REFERENCE: {
  eventType: EventType;
  keyFields: string[];
  label: string;
  meaning: string;
}[] = [
  {
    eventType: 'airport_closure',
    label: 'Airport closure',
    meaning:
      'The local airport authority has closed the airport to all operations; the closure text lists exceptions (emergency, military, prior permission). The most severe status.',
    keyFields: ['closureText', 'startTime', 'endTime'],
  },
  {
    eventType: 'ground_stop',
    label: 'Ground stop',
    meaning:
      'Flights destined to the airport are held at their departure airports for the duration of the stop. The ATCSCC issues one when demand is expected to exceed what the airport can accept, to prepare a Ground Delay Program, or when the airport cannot accept arrivals.',
    keyFields: [
      'reason',
      'startTime',
      'endTime',
      'probabilityOfExtension (low <30 %, medium 30–60 %, high >60 %)',
      'includedFacilities',
      'advisory',
    ],
  },
  {
    eventType: 'ground_delay_program',
    label: 'Ground Delay Program (GDP)',
    meaning:
      "Flights destined to the airport are held at their departure airports until an assigned Expect Departure Clearance Time (EDCT), metering arrivals to the airport's acceptance rate over a longer period.",
    keyFields: [
      'reason',
      'averageDelayMinutes',
      'maximumDelayMinutes',
      'startTime (the current revision)',
      'programStartTime',
      'endTime',
      'delayProfile (per 15-minute arrival interval)',
      'departureScopeNm',
      'includedFacilities',
      'advisory',
    ],
  },
  {
    eventType: 'airspace_flow_program',
    label: 'Airspace Flow Program (AFP)',
    meaning:
      'An en-route traffic management initiative: flights planned through a Flow Constrained Area receive EDCTs that meter demand through that airspace.',
    keyFields: [
      'location (the AFP name)',
      'reason',
      'averageDelayMinutes',
      'afp.constrainedArea',
      'afp.departsFrom / arrivesTo',
      'afp.excludedDepartures / excludedArrivals',
      'afp.delayProfile',
      'advisory',
    ],
  },
  {
    eventType: 'arrival_delay',
    label: 'Arrival delay',
    meaning:
      'Arriving aircraft are delayed with airborne holding. FAA facilities report delays of 15 minutes or more in 15-minute increments with a trend, so each entry is a range (delayRangeMinutes / minMinutes–maxMinutes), not an average.',
    keyFields: ['reason', 'delayRangeMinutes', 'trend', 'updatedAt'],
  },
  {
    eventType: 'departure_delay',
    label: 'Departure delay',
    meaning:
      'Departing traffic sees longer than normal taxi times or gate holds. Reported like arrival delays: a 15-minute band with a trend. An entry can outlive the delay, so check updatedAt.',
    keyFields: ['reason', 'delayRangeMinutes', 'trend', 'updatedAt'],
  },
  {
    eventType: 'closure_notam',
    label: 'Closure NOTAM',
    meaning:
      'A NOTAM-worded closure or restriction, often narrow (for example closed to non-scheduled transient general aviation). The FAA dashboard labels it an airport closure; it is kept separate here because it rarely closes the airport to all traffic.',
    keyFields: ['closureText (the NOTAM text)', 'startTime', 'endTime'],
  },
  {
    eventType: 'deicing',
    label: 'Deicing',
    meaning:
      'The airport has a formal deicing program in effect; the ATCSCC monitors it so a deiced aircraft is not given further traffic management delay.',
    keyFields: ['startedAt (startTime on faa_delays_list_active_events rows)'],
  },
];

const TERMS: { meaning: string; term: string }[] = [
  {
    term: 'AAR',
    meaning:
      'Airport Arrival Rate: the number of arrivals an airport can accept per hour (arrivalRatePerHour).',
  },
  {
    term: 'ADVZY',
    meaning: 'ATCSCC advisory: a numbered message; numbers restart at 1 each UTC day.',
  },
  {
    term: 'AFP',
    meaning:
      'Airspace Flow Program: EDCTs assigned to flights planned through a Flow Constrained Area.',
  },
  {
    term: 'ARTCC',
    meaning:
      'Air Route Traffic Control Center: controls en-route traffic over a region; codes start with Z (ZSE Seattle). See topic artccs.',
  },
  {
    term: 'ATCSCC',
    meaning:
      'Air Traffic Control System Command Center: the FAA facility that manages traffic flow across the NAS and issues the advisories.',
  },
  {
    term: 'CDM',
    meaning:
      'Collaborative Decision Making: the cooperative effort of government and industry to exchange information for better decision making. Advisory subjects carry it (CDM GROUND STOP, CDM GROUND DELAY PROGRAM, CDM COMPRESSION).',
  },
  {
    term: 'CDR',
    meaning:
      'Coded Departure Route: a pre-coordinated alternative route used to move traffic around weather or congestion.',
  },
  {
    term: 'CNX',
    meaning:
      "Canceled, in advisory subjects (CDM GS CNX, CDM GROUND DELAY PROGRAM CNX): the advisory ends the program it names, and a canceled GDP's EDCTs no longer apply.",
  },
  {
    term: 'CTOP',
    meaning:
      'Collaborative Trajectory Options Program: a traffic management initiative that manages demand through one or more Flow Constrained Areas; from the trajectory options an operator ranks for a flight, it assigns either a route around the FCA or a route and EDCT through it. A faa_delays_list_advisories category.',
  },
  {
    term: 'DAS',
    meaning:
      'Delay Assignment: a GDP delay assignment mode, named in advisories under DELAY ASSIGNMENT MODE.',
  },
  {
    term: 'DEP SCOPE',
    meaning:
      'Departure scope of a GDP: the distance in nautical miles around the airport within which departures are included (departureScopeNm).',
  },
  {
    term: 'EDCT',
    meaning:
      'Expect Departure Clearance Time: the departure time a flight is assigned under a GDP or AFP. Per-flight EDCTs are not in the NAS Status feed.',
  },
  {
    term: 'FEA / FCA',
    meaning:
      'Flow Evaluation Area / Flow Constrained Area: an airspace volume the ATCSCC defines to evaluate (FEA) or manage (FCA) traffic; an FCA is the basis of an AFP.',
  },
  {
    term: 'GAAP',
    meaning:
      'General Aviation Airport Program: a GDP delay assignment mode, named in advisories under DELAY ASSIGNMENT MODE.',
  },
  {
    term: 'GDP',
    meaning:
      'Ground Delay Program: flights to an airport held at their departure points until an assigned EDCT.',
  },
  {
    term: 'GS',
    meaning:
      'Ground Stop: flights to an airport held at their departure points until the stop ends.',
  },
  {
    term: 'MINIT',
    meaning: 'Minutes-in-Trail: required spacing, in minutes, between successive aircraft.',
  },
  {
    term: 'MIT',
    meaning:
      'Miles-in-Trail: required spacing, in nautical miles, between successive aircraft on a route or at a fix.',
  },
  { term: 'NAS', meaning: 'National Airspace System: the US air traffic system as a whole.' },
  {
    term: 'NOTAM',
    meaning:
      'Notice to Air Missions: a published notice of a change to facilities, services, or procedures, such as a closure.',
  },
  {
    term: 'Pacing airport',
    meaning:
      'One of the major airports the FAA tracks to measure NAS performance; listed live under topic pacing_airports.',
  },
  {
    term: 'PROGRAM RATE',
    meaning:
      'In a GDP advisory, the hourly arrival rate the program meters to, listed hour by hour.',
  },
  {
    term: 'RQD / RMD / PLN / FYI',
    meaning:
      'The action every route advisory states, in its subject (ROUTE RQD, FCA FYI, ZMA SWAP_FYI): Required, stakeholders must take action to comply; Recommended, they should consider the initiatives it specifies; Planned, initiatives that may be implemented; For Your Information, no action.',
  },
  {
    term: 'SWAP',
    meaning:
      'Severe Weather Avoidance Plan: a coordinated set of reroutes used when thunderstorms block routes.',
  },
  {
    term: 'TMI',
    meaning:
      'Traffic Management Initiative: any measure (ground stop, GDP, AFP, MIT, reroute) used to balance demand with capacity.',
  },
  {
    term: 'TRACON',
    meaning:
      'Terminal Radar Approach Control: the facility handling arrivals and departures around busy airports.',
  },
  {
    term: 'UDP',
    meaning:
      'Unified Delay Program: a GDP delay assignment mode, named in advisories under DELAY ASSIGNMENT MODE.',
  },
];

const ARTCCS: { code: string; name: string }[] = [
  { code: 'NZZO', name: 'Auckland Oceanic FIR (New Zealand)' },
  { code: 'ZAB', name: 'Albuquerque Center' },
  { code: 'ZAK', name: 'Oakland Oceanic' },
  { code: 'ZAN', name: 'Anchorage Center' },
  { code: 'ZAP', name: 'Anchorage Oceanic' },
  { code: 'ZAU', name: 'Chicago Center' },
  { code: 'ZBW', name: 'Boston Center' },
  { code: 'ZDC', name: 'Washington Center' },
  { code: 'ZDV', name: 'Denver Center' },
  { code: 'ZFW', name: 'Fort Worth Center' },
  { code: 'ZHN', name: 'Honolulu Center' },
  { code: 'ZHU', name: 'Houston Center' },
  { code: 'ZID', name: 'Indianapolis Center' },
  { code: 'ZJX', name: 'Jacksonville Center' },
  { code: 'ZKC', name: 'Kansas City Center' },
  { code: 'ZLA', name: 'Los Angeles Center' },
  { code: 'ZLC', name: 'Salt Lake City Center' },
  { code: 'ZMA', name: 'Miami Center' },
  { code: 'ZME', name: 'Memphis Center' },
  { code: 'ZMP', name: 'Minneapolis Center' },
  { code: 'ZNY', name: 'New York Center' },
  { code: 'ZOA', name: 'Oakland Center' },
  { code: 'ZOB', name: 'Cleveland Center' },
  { code: 'ZSE', name: 'Seattle Center' },
  { code: 'ZSU', name: 'San Juan Center' },
  { code: 'ZTL', name: 'Atlanta Center' },
  { code: 'ZUA', name: 'Guam Center' },
  { code: 'ZVR', name: 'Vancouver Center (Canada)' },
  { code: 'ZWY', name: 'New York Oceanic' },
  { code: 'ZYZ', name: 'Toronto Center (Canada)' },
];

const IDENTIFIER_FORMATS: { example: string; format: string; identifier: string }[] = [
  {
    identifier: 'Airport code (input)',
    format:
      'A US airport as its 3-character FAA location identifier, or the ICAO code NASR assigns to it; case-insensitive. A code that names no US airport in the directory is rejected. City and airport names are not accepted.',
    example: 'SEA, ORD, 0S9, KSEA, PHNL, TJSJ',
  },
  {
    identifier: 'Airport code (output)',
    format: 'Always the 3-character FAA identifier; requestedAs echoes a submitted ICAO code.',
    example: 'HNL (requestedAs PHNL)',
  },
  {
    identifier: 'Advisory reference',
    format:
      'Advisory number plus UTC date (YYYY-MM-DD); numbers restart at 1 each UTC day. faa_delays_list_advisories is the per-date index of every advisory number issued that day. Pass number as advisory_number and date as date to faa_delays_get_advisory.',
    example: '{ number: 17, date: "2026-07-15" }',
  },
  {
    identifier: 'AFP name',
    format:
      'The Flow Constrained Area an Airspace Flow Program meters, as the FAA names it; it is the location of an airspace_flow_program event.',
    example: 'FCAA05',
  },
  {
    identifier: 'ARTCC code',
    format:
      'Three letters starting with Z, or the 4-letter ICAO code of a foreign oceanic FIR that NASR assigns a few US airports to; see topic artccs.',
    example: 'ZSE, NZZO',
  },
  {
    identifier: 'Event times',
    format:
      'UTC ISO 8601 as the FAA feed supplies them, except a delay profile start, which is rewritten to this form; never converted to local time.',
    example: '2026-07-15T19:00:00Z',
  },
  {
    identifier: 'Operations-plan time',
    format:
      "HHMM UTC with no date; its day comes from the plan's event window (the EVENT TIME line of the plan advisory), which can start on the UTC day after the advisory date.",
    example: '1600',
  },
  {
    identifier: 'Advisory effective time',
    format: 'DDHHMM-DDHHMM in UTC (day of month, hour, minute).',
    example: '151900-160159',
  },
  {
    identifier: 'Advisory signature time',
    format: 'YY/MM/DD HH:MM in UTC.',
    example: '26/07/15 18:52',
  },
];

export const listReference = tool('faa_delays_list_reference', {
  title: 'List FAA Delay Reference Data',
  description:
    'Decode the vocabulary the other faa_delays tools return: event types and their fields, traffic-management terms (AAR, EDCT, FCA, GDP, SWAP), ARTCC center codes, the FAA pacing airports with time zones, and accepted identifier formats.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .preprocess(normalizeTopic, z.enum(TOPICS))
      .describe(
        'What to decode: event_types (event types and their key fields), terms (traffic-management abbreviations), artccs (ARTCC center codes and names), pacing_airports (the FAA pacing airports with time zones, read live), or identifiers (accepted airport-code, advisory, and time formats). Case-insensitive; spaces and hyphens read as underscores.',
      ),
  }),
  output: z.object({
    topic: z.enum(TOPICS).describe('The topic this result decodes.'),
    eventTypes: z
      .array(
        z
          .object({
            eventType: EventTypeSchema,
            label: z.string().describe('Human-readable name.'),
            meaning: z
              .string()
              .describe('What the event means, per the FAA NAS Status user guide.'),
            keyFields: z
              .array(z.string().describe('Output field name, with a note where useful.'))
              .describe('Output fields that carry the detail of this event type.'),
          })
          .describe('One event type.'),
      )
      .optional()
      .describe('Present for topic event_types, in severity order.'),
    terms: z
      .array(
        z
          .object({
            term: z.string().describe('Abbreviation or term.'),
            meaning: z.string().describe('What it means in FAA traffic management.'),
          })
          .describe('One term.'),
      )
      .optional()
      .describe('Present for topic terms, alphabetical.'),
    artccs: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Facility code: three letters starting with Z (ZSE), or a 4-letter ICAO FIR code (NZZO).',
              ),
            name: z.string().describe('Facility name.'),
          })
          .describe('One air traffic control facility.'),
      )
      .optional()
      .describe(
        "Present for topic artccs, by code: the 25 US ARTCCs, including the New York and Oakland oceanic centers, plus Anchorage Oceanic, Guam, Auckland Oceanic, Toronto, and Vancouver, the other facilities NASR names as an airport's ARTCC. Every artcc faa_delays_get_airport_status returns is listed.",
      ),
    pacingAirports: z
      .array(
        z
          .object({
            airportId: z.string().describe('FAA 3-character identifier.'),
            timezone: z
              .string()
              .optional()
              .describe('IANA-style time zone the FAA assigns (US/Pacific); FAA-supplied text.'),
            latitude: z.number().optional().describe('Latitude in decimal degrees.'),
            longitude: z.number().optional().describe('Longitude in decimal degrees.'),
          })
          .describe('One pacing airport.'),
      )
      .optional()
      .describe(
        'Present for topic pacing_airports: the FAA pacing airports, read live and cached 6 h.',
      ),
    fetchedAt: z
      .string()
      .optional()
      .describe(
        'Present for topic pacing_airports: when this server fetched the list from the FAA (UTC ISO).',
      ),
    identifiers: z
      .object({
        airportDirectory: z
          .object({
            source: z.string().describe('FAA dataset the directory is built from.'),
            effectiveDate: z.string().describe('NASR cycle effective date, YYYY-MM-DD.'),
            airportCount: z.number().int().describe('US airports the directory lists.'),
          })
          .describe(
            'The bundled FAA NASR airport directory that validates airport codes. An identifier assigned after this cycle is rejected until the next refresh.',
          ),
        formats: z
          .array(
            z
              .object({
                identifier: z.string().describe('What is identified.'),
                format: z.string().describe('Accepted or returned form.'),
                example: z.string().describe('Example value.'),
              })
              .describe('One identifier format.'),
          )
          .describe('Identifier and time formats the faa_delays tools accept and return.'),
      })
      .optional()
      .describe('Present for topic identifiers.'),
  }),
  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NAS Status unreachable, 5xx, an attempt timeout, or an HTML maintenance page, after retries (topic pacing_airports only)',
      recovery:
        'The FAA NAS Status feed is temporarily unreachable; call faa_delays_list_reference again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The FAA returned 429 after retries, or this server's queue to the FAA would wait past 10 s while backing off from an FAA 429 (topic pacing_airports only)",
      recovery:
        "The FAA feed is limiting request rate; wait the retryAfter interval in this error's data (about a minute when it carries none), then call faa_delays_list_reference again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The 20 s retry budget ran out (topic pacing_airports only)',
      recovery:
        'The FAA NAS Status feed is responding slowly; call faa_delays_list_reference again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own queue to the FAA would wait past 10 s with no FAA 429 backoff in effect (topic pacing_airports only)",
      recovery:
        "This server is pacing its requests to the FAA; wait the retryAfter seconds in this error's data, then call faa_delays_list_reference again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'feed_contract_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The pacing-airports path returned 404/410, or a body whose shape this server no longer recognizes',
      recovery:
        'The FAA NAS Status feed is not serving the format this server reads, which usually means the FAA changed it, so an immediate retry will not help; the other reference topics are static and still answer.',
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    switch (input.topic) {
      case 'event_types':
        return { topic: input.topic, eventTypes: EVENT_TYPE_REFERENCE };
      case 'terms':
        return { topic: input.topic, terms: TERMS };
      case 'artccs':
        return { topic: input.topic, artccs: ARTCCS };
      case 'identifiers':
        return {
          topic: input.topic,
          identifiers: { airportDirectory: getDirectoryInfo(), formats: IDENTIFIER_FORMATS },
        };
      case 'pacing_airports': {
        const pacing = await getNasStatusService().getPacingAirports(ctx);
        ctx.log.info('Pacing airports read', { count: pacing.rows.length });
        return { topic: input.topic, fetchedAt: pacing.fetchedAt, pacingAirports: pacing.rows };
      }
    }
  },

  format: (result) => {
    const lines = [`# FAA reference: ${result.topic}`];
    if (result.eventTypes) {
      for (const entry of result.eventTypes) {
        lines.push('', `## ${entry.eventType} — ${entry.label}`, entry.meaning);
        lines.push(`**Key fields:** ${entry.keyFields.join(', ')}`);
      }
    }
    if (result.terms) {
      lines.push('', '| Term | Meaning |', '|:-----|:--------|');
      for (const term of result.terms) lines.push(`| ${cell(term.term)} | ${cell(term.meaning)} |`);
    }
    if (result.artccs) {
      lines.push('', '| Code | Center |', '|:-----|:-------|');
      for (const artcc of result.artccs)
        lines.push(`| ${cell(artcc.code)} | ${cell(artcc.name)} |`);
    }
    if (result.pacingAirports) {
      lines.push(
        '',
        `**Fetched:** ${result.fetchedAt ?? 'unknown'} · ${result.pacingAirports.length} pacing airports`,
        '',
        '| Airport | Time zone | Latitude | Longitude |',
        '|:--------|:----------|:---------|:----------|',
      );
      for (const airport of result.pacingAirports) {
        lines.push(
          `| ${cell(airport.airportId)} | ${cell(airport.timezone)} | ${cell(airport.latitude)} | ${cell(airport.longitude)} |`,
        );
      }
    }
    if (result.identifiers) {
      const directory = result.identifiers.airportDirectory;
      lines.push(
        '',
        `**Airport directory:** ${directory.source}, NASR cycle ${directory.effectiveDate}, ${directory.airportCount} US airports`,
        '',
        '| Identifier | Format | Example |',
        '|:-----------|:-------|:--------|',
      );
      for (const entry of result.identifiers.formats) {
        lines.push(
          `| ${cell(entry.identifier)} | ${cell(entry.format)} | ${cell(entry.example)} |`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
