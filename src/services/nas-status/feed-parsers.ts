/**
 * @fileoverview Tolerant parsers for the NAS Status feeds. Bodies are `unknown` and read field by
 * field: a wrong top-level shape is `feed_contract_changed`, a row without its key is skipped and
 * counted, a known field with an unexpected type is omitted and reported as drift (never coerced),
 * and an unknown row key is reported and otherwise ignored.
 * @module services/nas-status/feed-parsers
 */

import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import { parseAdvisoryLink } from '@/services/advisory/advisory-ref.js';
import type {
  AirportEvents,
  AirspaceFlowProgram,
  Closure,
  ClosureNotam,
  ConstrainedAreaType,
  DelayBand,
  DelayProfile,
  FeedRows,
  GroundDelayProgram,
  GroundStop,
  Likelihood,
  OperationsPlan,
  PacingAirport,
  PlannedItem,
  ProbabilityOfExtension,
  RunwayConfiguration,
  TimeQualifier,
  Trend,
} from './types.js';

/** Receives drift signals; the service logs each distinct one once per process. */
export interface ParseReporter {
  /** A known field arrived with an unexpected type and was omitted. `path` has no row indices. */
  drift(path: string, observedType: string): void;
  /** A row carried a key this server does not read. */
  unknownKey(feed: string, key: string): void;
}

/** A NAS Status feed, by its `/api/` path segment. */
export type Feed =
  | 'airport-events'
  | 'enroute-events'
  | 'operations-plan'
  | 'miscellaneous-info'
  | 'pacing-airports';

/** How caller-facing messages name each feed: `The FAA NAS Status ${label} feed`. */
const FEED_LABELS: Record<Feed, string> = {
  'airport-events': 'airport events',
  'enroute-events': 'en-route events',
  'miscellaneous-info': 'announcements',
  'operations-plan': 'operations plan',
  'pacing-airports': 'pacing airports',
};

/** `The FAA NAS Status operations plan feed`: the feed as caller-facing messages name it. */
export const feedName = (feed: Feed): string => `The FAA NAS Status ${FEED_LABELS[feed]} feed`;

type Obj = Record<string, unknown>;

const describeType = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** The error every unrecognizable feed body raises. */
function feedContractChanged(feed: Feed, detail: string): Error {
  return serializationError(
    `${feedName(feed)} returned a shape this server does not recognize (${detail}).`,
    { feed, reason: 'feed_contract_changed', retryable: false },
  );
}

/** Typed field access over one upstream object, reporting wrong-typed fields as drift. */
class Fields {
  constructor(
    private readonly obj: Obj,
    private readonly path: string,
    private readonly report: ParseReporter,
  ) {}

  private read(key: string): unknown {
    const value = this.obj[key];
    return value === null ? undefined : value;
  }

  /** Reports `key` as drifted to the observed type of `value`; always returns `undefined`. */
  flag(key: string, value: unknown): undefined {
    this.report.drift(`${this.path}.${key}`, describeType(value));
    return;
  }

  /** A non-blank string, verbatim. Blank strings read as absent. */
  string(key: string): string | undefined {
    const value = this.read(key);
    if (value === undefined) return;
    if (typeof value !== 'string') return this.flag(key, value);
    return value.trim() ? value : undefined;
  }

  number(key: string): number | undefined {
    const value = this.read(key);
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.flag(key, value);
    return value;
  }

  boolean(key: string): boolean | undefined {
    const value = this.read(key);
    if (value === undefined) return;
    if (typeof value !== 'boolean') return this.flag(key, value);
    return value;
  }

  /** A coordinate the feed sends as a numeric string (a number is accepted too). */
  coordinate(key: string): number | undefined {
    const value = this.read(key);
    if (value === undefined) return;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return this.flag(key, value);
    const parsed = Number(value.trim());
    return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * A string array; non-string items are dropped and reported as drift, blank strings dropped
   * silently. Empty arrays read as absent.
   */
  stringList(key: string): string[] | undefined {
    const value = this.read(key);
    if (value === undefined) return;
    if (!Array.isArray(value)) return this.flag(key, value);
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') this.flag(`${key}[]`, item);
      else if (item.trim()) items.push(item);
    }
    return items.length > 0 ? items : undefined;
  }

  /** A flight-filter value: a string, or a string array joined with spaces. */
  filterText(key: string): string | undefined {
    const value = this.read(key);
    if (Array.isArray(value)) return this.stringList(key)?.join(' ');
    return this.string(key);
  }

  object(key: string): Fields | undefined {
    const value = this.read(key);
    if (value === undefined) return;
    if (!isRecord(value)) return this.flag(key, value);
    return new Fields(value, `${this.path}.${key}`, this.report);
  }

  /** The raw value, for fields read in more than one shape. */
  raw(key: string): unknown {
    return this.read(key);
  }

  sub(path: string, value: Obj): Fields {
    return new Fields(value, `${this.path}.${path}`, this.report);
  }
}

/** Walks an array feed: rows missing their key are skipped; all-skipped is a contract change. */
function parseRows<T>(
  body: unknown,
  feed: Feed,
  report: ParseReporter,
  knownKeys: ReadonlySet<string>,
  parseRow: (row: Fields) => T | undefined,
): FeedRows<T> {
  if (!Array.isArray(body))
    throw feedContractChanged(feed, `expected an array, got ${describeType(body)}`);
  const rows: T[] = [];
  let skippedRows = 0;
  for (const item of body) {
    if (!isRecord(item)) {
      skippedRows++;
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!knownKeys.has(key)) report.unknownKey(feed, key);
    }
    const row = parseRow(new Fields(item, `${feed}[]`, report));
    if (row) rows.push(row);
    else skippedRows++;
  }
  if (body.length > 0 && rows.length === 0) {
    throw feedContractChanged(feed, `none of its ${body.length} rows could be read`);
  }
  return { rows, skippedRows };
}

/** `": ALL CONTIGUOUS US DEP"` → `"ALL CONTIGUOUS US DEP"`. */
function stripFlightsPrefix(value: string | undefined): string | undefined {
  const stripped = value?.replace(/^\s*:\s*/, '');
  return stripped?.trim() ? stripped : undefined;
}

/** `dasDelays.dasDelay[]` ordered by `seq` → per-15-minute averages; any unreadable entry drops the profile. */
function parseDelayProfile(fields: Fields | undefined): DelayProfile | undefined {
  if (!fields) return;
  const startTime = fields.string('startTime');
  const dasDelays = fields.object('dasDelays');
  const rawDelays = dasDelays?.raw('dasDelay');
  if (!startTime || rawDelays === undefined) return;
  const entries = Array.isArray(rawDelays) ? rawDelays : [rawDelays];
  const values: { delay: number; seq: number }[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.delay !== 'number' || typeof entry.seq !== 'number') {
      return dasDelays?.flag('dasDelay[]', entry);
    }
    values.push({ delay: entry.delay, seq: entry.seq });
  }
  if (values.length === 0) return;
  values.sort((a, b) => a.seq - b.seq);
  return {
    averageDelayMinutes: values.map((v) => v.delay),
    intervalMinutes: 15,
    startTime,
  };
}

function parseProbability(value: string | undefined): ProbabilityOfExtension | undefined {
  const lower = value?.trim().toLowerCase();
  return lower === 'low' || lower === 'medium' || lower === 'high' ? lower : undefined;
}

function parseTrend(value: string | undefined): Trend | undefined {
  const lower = value?.trim().toLowerCase();
  return lower === 'increasing' || lower === 'decreasing' ? lower : undefined;
}

/** `"16 minutes"`, `"1 hour and 57 minutes"` → minutes; `undefined` when neither unit appears. */
export function parseDurationMinutes(value: string | undefined): number | undefined {
  if (!value) return;
  const hours = /(\d+)\s*hours?/i.exec(value)?.[1];
  const minutes = /(\d+)\s*minutes?/i.exec(value)?.[1];
  if (hours === undefined && minutes === undefined) return;
  return Number(hours ?? 0) * 60 + Number(minutes ?? 0);
}

function parseGroundStop(f: Fields): GroundStop {
  const probabilityOfExtension = parseProbability(f.string('probabilityOfExtension'));
  const includedFacilities = f.stringList('includedFacilities');
  const includedFlights = stripFlightsPrefix(f.string('includedFlights'));
  const advisory = parseAdvisoryLink(f.string('advisoryUrl'));
  const reason = f.string('impactingCondition');
  const startTime = f.string('startTime');
  const endTime = f.string('endTime');
  const updatedAt = f.string('updatedAt');
  const controllingCenter = f.string('center');
  return {
    ...(reason && { reason }),
    ...(startTime && { startTime }),
    ...(endTime && { endTime }),
    ...(probabilityOfExtension && { probabilityOfExtension }),
    ...(includedFacilities && { includedFacilities }),
    ...(updatedAt && { updatedAt }),
    ...(advisory && { advisory }),
    ...(includedFlights && { includedFlights }),
    ...(controllingCenter && { controllingCenter }),
  };
}

function parseGroundDelay(f: Fields): GroundDelayProgram {
  const reason = f.string('impactingCondition');
  const averageDelayMinutes = f.number('avgDelay');
  const maximumDelayMinutes = f.number('maxDelay');
  const startTime = f.string('startTime');
  const endTime = f.string('endTime');
  const updatedAt = f.string('updatedAt');
  const controllingCenter = f.string('center');
  const departureScopeNm = f.number('departureScope');
  const includedFacilities = f.stringList('includedFacilities');
  const includedFlights = stripFlightsPrefix(f.string('includedFlights'));
  const delayProfile = parseDelayProfile(f.object('fuelFlowAdvisoryDelayTime'));
  const advisory = parseAdvisoryLink(f.string('advisoryUrl'));
  return {
    ...(reason && { reason }),
    ...(averageDelayMinutes !== undefined && { averageDelayMinutes }),
    ...(maximumDelayMinutes !== undefined && { maximumDelayMinutes }),
    ...(startTime && { startTime }),
    ...(endTime && { endTime }),
    ...(updatedAt && { updatedAt }),
    ...(controllingCenter && { controllingCenter }),
    ...(departureScopeNm !== undefined && { departureScopeNm }),
    ...(includedFacilities && { includedFacilities }),
    ...(includedFlights && { includedFlights }),
    ...(delayProfile && { delayProfile }),
    ...(advisory && { advisory }),
  };
}

/**
 * Arrival/departure delay band. `arrivalDeparture.min`/`max` when present; otherwise the FAA's
 * documented rule from `averageDelay` + `trend` (increasing: avg+1 to avg+15; decreasing: avg−14
 * to avg). `averageDelay` itself is never surfaced.
 */
function parseDelayBand(f: Fields): DelayBand {
  const reason = f.string('reason');
  const updatedAt = f.string('updateTime');
  const band = f.object('arrivalDeparture');
  const trend = parseTrend(f.string('trend') ?? band?.string('trend'));
  let minMinutes: number | undefined;
  let maxMinutes: number | undefined;
  if (band) {
    minMinutes = parseDurationMinutes(band.string('min'));
    maxMinutes = parseDurationMinutes(band.string('max'));
  } else {
    const rawAverage = f.raw('averageDelay');
    const average =
      typeof rawAverage === 'number'
        ? rawAverage
        : typeof rawAverage === 'string' && /^\s*\d+\s*$/.test(rawAverage)
          ? Number(rawAverage)
          : undefined;
    if (average !== undefined && trend === 'increasing') {
      minMinutes = average + 1;
      maxMinutes = average + 15;
    } else if (average !== undefined && trend === 'decreasing') {
      minMinutes = Math.max(0, average - 14);
      maxMinutes = average;
    }
  }
  return {
    ...(reason && { reason }),
    ...(minMinutes !== undefined && { minMinutes }),
    ...(maxMinutes !== undefined && { maxMinutes }),
    ...(trend && { trend }),
    ...(updatedAt && { updatedAt }),
  };
}

function parseClosure(f: Fields): Closure {
  const text = f.string('text');
  const startTime = f.string('startTime');
  const endTime = f.string('endTime');
  const updatedAt = f.string('updatedAt');
  return {
    ...(text && { text }),
    ...(startTime && { startTime }),
    ...(endTime && { endTime }),
    ...(updatedAt && { updatedAt }),
  };
}

function parseClosureNotam(f: Fields): ClosureNotam {
  const notamText = f.string('simpleText');
  const text = f.string('text');
  const notamNumber = f.number('notamNumber');
  const issuedAt = f.string('issuedDate');
  const startTime = f.string('startTime');
  const endTime = f.string('endTime');
  const updatedAt = f.string('updatedAt');
  return {
    ...(notamText && { notamText }),
    ...(text && { text }),
    ...(notamNumber !== undefined && { notamNumber }),
    ...(issuedAt && { issuedAt }),
    ...(startTime && { startTime }),
    ...(endTime && { endTime }),
    ...(updatedAt && { updatedAt }),
  };
}

function parseRunwayConfiguration(f: Fields): RunwayConfiguration {
  const arrivalRunways = f.string('arrivalRunwayConfig')?.trim();
  const departureRunways = f.string('departureRunwayConfig')?.trim();
  const arrivalRatePerHour = f.number('arrivalRate');
  const reportedAt = f.string('sourceTimeStamp') ?? f.string('updatedAt');
  return {
    ...(arrivalRunways && { arrivalRunways }),
    ...(departureRunways && { departureRunways }),
    ...(arrivalRatePerHour !== undefined && { arrivalRatePerHour }),
    ...(reportedAt && { reportedAt }),
  };
}

const AIRPORT_ROW_KEYS: ReadonlySet<string> = new Set([
  'airportId',
  'airportLongName',
  'latitude',
  'longitude',
  'groundStop',
  'groundDelay',
  'airportClosure',
  'freeForm',
  'arrivalDelay',
  'departureDelay',
  'airportConfig',
  'deicing',
]);

/** `/api/airport-events` → one normalized row per airport with an active event. */
export function parseAirportEvents(body: unknown, report: ParseReporter): FeedRows<AirportEvents> {
  return parseRows(body, 'airport-events', report, AIRPORT_ROW_KEYS, (f) => {
    const airportId = f.string('airportId')?.trim().toUpperCase();
    if (!airportId) return;
    const airportName = f.string('airportLongName');
    const latitude = f.coordinate('latitude');
    const longitude = f.coordinate('longitude');
    const groundStop = f.object('groundStop');
    const groundDelay = f.object('groundDelay');
    const closure = f.object('airportClosure');
    const freeForm = f.object('freeForm');
    const arrivalDelay = f.object('arrivalDelay');
    const departureDelay = f.object('departureDelay');
    const config = f.object('airportConfig');
    const deicing = f.object('deicing');
    const deicingStartedAt = deicing?.string('eventTime');
    return {
      airportId,
      ...(airportName && { airportName }),
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
      ...(groundStop && { groundStop: parseGroundStop(groundStop) }),
      ...(groundDelay && { groundDelayProgram: parseGroundDelay(groundDelay) }),
      ...(arrivalDelay && { arrivalDelay: parseDelayBand(arrivalDelay) }),
      ...(departureDelay && { departureDelay: parseDelayBand(departureDelay) }),
      ...(closure && { closure: parseClosure(closure) }),
      ...(freeForm && { closureNotam: parseClosureNotam(freeForm) }),
      ...(deicing && { deicing: deicingStartedAt ? { startedAt: deicingStartedAt } : {} }),
      ...(config && { runwayConfiguration: parseRunwayConfiguration(config) }),
    };
  });
}

const ENROUTE_ROW_KEYS: ReadonlySet<string> = new Set([
  'airspaceFlowProgram',
  'advisoryUrl',
  'polygon',
  'circle',
  'line',
  'fcaAirport',
  'fcaArtcc',
  'fcaSectorName',
  'fcaBaseSector',
  'fcaTraconName',
  'fcaBaseTracon',
  'fcaSuaName',
  'fcaFixName',
  'departsAny',
  'arrivesAny',
  'departsNone',
  'arrivesNone',
  'isAnyConditions',
  'fcaHeadingDirection',
  'comments',
]);

/** The constrained area, in the dashboard's precedence; generic `fca` when nothing names it. */
function resolveConstrainedArea(f: Fields): AirspaceFlowProgram['constrainedArea'] {
  const candidates: [ConstrainedAreaType, () => string | undefined][] = [
    ['airport', () => f.object('fcaAirport')?.string('fcaAirportName')],
    ['artcc', () => f.object('fcaArtcc')?.string('fcaArtccName')],
    ['sector', () => f.string('fcaSectorName')],
    ['sector', () => f.string('fcaBaseSector')],
    ['tracon', () => f.string('fcaTraconName')],
    ['tracon', () => f.string('fcaBaseTracon')],
    ['special_use_airspace', () => f.string('fcaSuaName')],
    ['fix', () => f.string('fcaFixName')],
  ];
  for (const [type, read] of candidates) {
    const name = read();
    if (name) return { name, type };
  }
  return { type: 'fca' };
}

/** `/api/enroute-events` → Airspace Flow Programs, keyed on `airspaceFlowProgram.afpName`. */
export function parseEnrouteEvents(
  body: unknown,
  report: ParseReporter,
): FeedRows<AirspaceFlowProgram> {
  return parseRows(body, 'enroute-events', report, ENROUTE_ROW_KEYS, (f) => {
    const afp = f.object('airspaceFlowProgram');
    const name = afp?.string('afpName');
    if (!afp || !name) return;
    const reason = afp.string('impactingCondition');
    const averageDelayMinutes = afp.number('avgDelay');
    const startTime = afp.string('startTime');
    const endTime = afp.string('endTime');
    const updatedAt = afp.string('updatedAt');
    const altitudeFloor = afp.string('lowerAltitude');
    const altitudeCeiling = afp.string('upperAltitude');
    const delayProfile = parseDelayProfile(afp.object('fuelFlowAdvisoryDelayTime'));
    const advisory = parseAdvisoryLink(f.string('advisoryUrl'));
    const departsFrom = f.filterText('departsAny');
    const arrivesTo = f.filterText('arrivesAny');
    const excludedDepartures = f.filterText('departsNone');
    const excludedArrivals = f.filterText('arrivesNone');
    const filtersMatchAny = f.boolean('isAnyConditions');
    const headingDirection = f.string('fcaHeadingDirection');
    const comments = f.string('comments');
    return {
      constrainedArea: resolveConstrainedArea(f),
      name,
      ...(reason && { reason }),
      ...(averageDelayMinutes !== undefined && { averageDelayMinutes }),
      ...(startTime && { startTime }),
      ...(endTime && { endTime }),
      ...(updatedAt && { updatedAt }),
      ...(advisory && { advisory }),
      ...(altitudeFloor && { altitudeFloor }),
      ...(altitudeCeiling && { altitudeCeiling }),
      ...(departsFrom && { departsFrom }),
      ...(arrivesTo && { arrivesTo }),
      ...(excludedDepartures && { excludedDepartures }),
      ...(excludedArrivals && { excludedArrivals }),
      ...(headingDirection && { headingDirection }),
      ...(filtersMatchAny !== undefined && { filtersMatchAny }),
      ...(comments && { comments }),
      ...(delayProfile && { delayProfile }),
    };
  });
}

const QUALIFIER_PATTERN = /^(AFTER|UNTIL|BY|BETWEEN)\s+(\d{4})/i;
const LIKELIHOODS: ReadonlySet<string> = new Set(['possible', 'probable', 'expected']);

/** `"AFTER 1600\t-BOS GROUND STOP/DELAY PROGRAM EXPECTED"` → text, qualifier, HHMM, likelihood. */
export function parsePlannedEvent(event: string, time: string | undefined): PlannedItem {
  const text = event
    .replace(/\t+\s*-?\s*/g, ' ')
    .replace(/^\s*-\s*/, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const match = QUALIFIER_PATTERN.exec(text);
  const timeQualifier = match?.[1]?.toLowerCase() as TimeQualifier | undefined;
  const timeUtc = time?.trim() || match?.[2];
  const lastWord = text.split(/\s+/).at(-1)?.toLowerCase();
  const likelihood = lastWord && LIKELIHOODS.has(lastWord) ? (lastWord as Likelihood) : undefined;
  return {
    text,
    ...(timeQualifier && { timeQualifier }),
    ...(timeUtc && { timeUtc }),
    ...(likelihood && { likelihood }),
  };
}

function parsePlannedList(
  f: Fields,
  key: 'terminalPlanned' | 'enRoutePlanned',
): FeedRows<PlannedItem> {
  const value = f.raw(key);
  if (value === undefined) return { rows: [], skippedRows: 0 };
  if (!Array.isArray(value)) {
    f.flag(key, value);
    return { rows: [], skippedRows: 0 };
  }
  const rows: PlannedItem[] = [];
  let skippedRows = 0;
  for (const item of value) {
    const row = isRecord(item) ? f.sub(`${key}[]`, item) : undefined;
    const event = row?.string('event');
    if (row && event) rows.push(parsePlannedEvent(event, row.string('time')));
    else skippedRows++;
  }
  if (value.length > 0 && rows.length === 0) {
    throw feedContractChanged(
      'operations-plan',
      `none of its ${value.length} ${key} rows could be read`,
    );
  }
  return { rows, skippedRows };
}

/** `/api/operations-plan` → planned terminal and en-route items plus the plan's advisory ref. */
export function parseOperationsPlan(
  body: unknown,
  report: ParseReporter,
): OperationsPlan & { skippedRows: number } {
  if (
    !isRecord(body) ||
    !('link' in body || 'terminalPlanned' in body || 'enRoutePlanned' in body)
  ) {
    throw feedContractChanged(
      'operations-plan',
      `expected an object with link, terminalPlanned, or enRoutePlanned, got ${describeType(body)}`,
    );
  }
  const f = new Fields(body, 'operations-plan', report);
  const advisory = parseAdvisoryLink(f.string('link'));
  const terminal = parsePlannedList(f, 'terminalPlanned');
  const enRoute = parsePlannedList(f, 'enRoutePlanned');
  return {
    enRoutePlanned: enRoute.rows,
    skippedRows: terminal.skippedRows + enRoute.skippedRows,
    terminalPlanned: terminal.rows,
    ...(advisory && { advisory }),
  };
}

/** `/api/miscellaneous-info` → ATCSCC announcement texts. */
export function parseAnnouncements(body: unknown, report: ParseReporter): FeedRows<string> {
  return parseRows(body, 'miscellaneous-info', report, new Set(['event']), (f) =>
    f.string('event'),
  );
}

/** `/api/pacing-airports` → the FAA pacing airports (rows flagged `isPacing: false` excluded). */
export function parsePacingAirports(body: unknown, report: ParseReporter): FeedRows<PacingAirport> {
  const keys = new Set(['airportId', 'timezone', 'isPacing', 'latitude', 'longitude']);
  const parsed = parseRows(body, 'pacing-airports', report, keys, (f) => {
    const airportId = f.string('airportId')?.trim().toUpperCase();
    if (!airportId) return;
    const timezone = f.string('timezone');
    const latitude = f.coordinate('latitude');
    const longitude = f.coordinate('longitude');
    const isPacing = f.boolean('isPacing');
    return {
      airportId,
      isPacing,
      ...(timezone && { timezone }),
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
    };
  });
  return {
    rows: parsed.rows
      .filter((row) => row.isPacing !== false)
      .map(({ isPacing: _isPacing, ...row }) => row),
    skippedRows: parsed.skippedRows,
  };
}
