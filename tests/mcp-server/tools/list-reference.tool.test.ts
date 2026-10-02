/**
 * @fileoverview Tests for faa_delays_list_reference: topic normalization, the static topics'
 * content invariants (artccs covering every ARTCC the bundled directory assigns), the live
 * pacing_airports topic (cache, degrade-free error surface, sparse rows), declared feed errors,
 * and format() fidelity and table escaping.
 * @module tests/mcp-server/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { EVENT_TYPES } from '@/mcp-server/tools/schemas.js';
import {
  getDirectoryInfo,
  resolveAirportCode,
} from '@/services/airport-directory/airport-directory.js';
import { NASR_AIRPORTS_TSV } from '@/services/airport-directory/nasr-airports.generated.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import {
  callsTo,
  contentText,
  createClock,
  errorOf,
  type FeedName,
  type FeedOverride,
  feedHarness,
  feedUrl,
  installServices,
  type Responder,
  recoveryHint,
} from '../../helpers/faa-fakes.js';
import { FEED_FAILURES, withLadder } from '../../helpers/feed-failures.js';

type Overrides = Partial<Record<FeedName, FeedOverride | Responder>>;

let harness: ReturnType<typeof feedHarness>;
let services: { dispose: () => void };

function setup(overrides: Overrides = {}): void {
  harness = feedHarness(overrides);
  services = installServices({ fetch: harness.fetch, now: createClock().now });
}

const run = (topic: unknown) => runToolContract(listReference, { topic } as never);
const structured = (result: Awaited<ReturnType<typeof run>>) =>
  result.structuredContent as Record<string, any>;

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  setup();
});
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('topic input', () => {
  it.each([
    ['pacing_airports', 'pacing_airports'],
    ['Pacing Airports', 'pacing_airports'],
    ['  PACING-AIRPORTS ', 'pacing_airports'],
    ['Event-Types', 'event_types'],
    ['TERMS', 'terms'],
  ])('reads %j as %s', (input, expected) => {
    const parsed = listReference.input.safeParse({ topic: input });
    expect(parsed.success && parsed.data.topic).toBe(expected);
  });

  it.each([
    ['', 'blank'],
    ['weather', 'unknown'],
    [null, 'null'],
    [3, 'number'],
    [undefined, 'missing'],
  ])('rejects %j (%s)', (value, _label) => {
    expect(listReference.input.safeParse({ topic: value }).success).toBe(false);
  });

  it('rejects an unknown topic on the wire as InvalidParams', async () => {
    const result = await run('weather');
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
  });
});

describe('static topics', () => {
  it('never call the FAA', async () => {
    for (const topic of ['event_types', 'terms', 'artccs', 'identifiers']) {
      const result = await run(topic);
      expect(result.isError).toBeFalsy();
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('event_types covers every event type once, in severity order', async () => {
    const data = structured(await run('event_types'));

    expect(data.topic).toBe('event_types');
    expect(data.eventTypes.map((entry: { eventType: string }) => entry.eventType)).toEqual([
      ...EVENT_TYPES,
    ]);
    for (const entry of data.eventTypes) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.meaning.length).toBeGreaterThan(0);
      expect(entry.keyFields.length).toBeGreaterThan(0);
    }
    expect(data).not.toHaveProperty('terms');
  });

  it('event_types names programStartTime among the Ground Delay Program key fields', async () => {
    const result = await run('event_types');
    const gdp = structured(result).eventTypes.find(
      (entry: { eventType: string }) => entry.eventType === 'ground_delay_program',
    );

    expect(gdp.keyFields).toContain('programStartTime');
    expect(contentText(result)).toMatch(/\*\*Key fields:\*\* reason, .*programStartTime/);
  });

  it('terms lists the glossary alphabetically with the vocabulary the tools use', async () => {
    const terms: { term: string }[] = structured(await run('terms')).terms;
    const names = terms.map((entry) => entry.term);

    expect(names).toEqual(
      expect.arrayContaining(['AAR', 'AFP', 'ARTCC', 'EDCT', 'GDP', 'GS', 'SWAP', 'UDP']),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === name.toUpperCase())).toEqual(
      [...names.filter((name) => name === name.toUpperCase())].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('terms decodes the advisory-subject vocabulary faa_delays_list_advisories rows carry, in both surfaces', async () => {
    const result = await run('terms');
    const terms: { meaning: string; term: string }[] = structured(result).terms;
    const meaningOf = (term: string) => terms.find((entry) => entry.term === term)?.meaning;

    expect(meaningOf('CDM')).toMatch(/^Collaborative Decision Making: /);
    expect(meaningOf('CNX')).toMatch(/^Canceled, in advisory subjects/);
    expect(meaningOf('CTOP')).toMatch(
      /^Collaborative Trajectory Options Program: .*faa_delays_list_advisories/,
    );
    expect(meaningOf('RQD / RMD / PLN / FYI')).toMatch(
      /Required.*Recommended.*Planned.*For Your Information/,
    );
    const text = contentText(result);
    for (const term of ['CDM', 'CNX', 'CTOP', 'RQD / RMD / PLN / FYI']) {
      expect(text).toContain(`| ${term} | ${meaningOf(term)} |`);
    }
  });

  it('identifiers names the delay profile start as the one event time the server rewrites', async () => {
    const result = await run('identifiers');
    const eventTimes = structured(result).identifiers.formats.find(
      (entry: { identifier: string }) => entry.identifier === 'Event times',
    );

    expect(eventTimes.format).toMatch(/except a delay profile start, which is rewritten/);
    expect(contentText(result)).toContain(eventTimes.format);
  });

  it('artccs lists the 25 US centers and the 5 other NASR facilities by code, with names', async () => {
    const artccs: { code: string; name: string }[] = structured(await run('artccs')).artccs;
    const codes = artccs.map((entry) => entry.code);

    expect(artccs).toHaveLength(30);
    expect(new Set(codes).size).toBe(30);
    expect(codes).toEqual([...codes].sort());
    expect(
      artccs.every((entry) => /^(Z[A-Z]{2}|[A-Z]{4})$/.test(entry.code) && entry.name.length > 0),
    ).toBe(true);
    expect(codes.filter((code) => /^Z[A-Z]{2}$/.test(code))).toHaveLength(29);
    expect(artccs).toContainEqual({ code: 'ZSE', name: 'Seattle Center' });
    expect(codes).toEqual(expect.arrayContaining(['NZZO', 'ZAP', 'ZUA', 'ZVR', 'ZYZ']));
  });

  it('artccs decodes every artcc the bundled directory assigns an airport', async () => {
    const decoded = new Set(
      structured(await run('artccs')).artccs.map((entry: { code: string }) => entry.code),
    );
    const assigned = new Set(
      NASR_AIRPORTS_TSV.split('\n').map(
        (line) => resolveAirportCode(line.split('\t')[0] as string)?.artcc,
      ),
    );

    expect(assigned.has(undefined)).toBe(false);
    expect(assigned.size).toBeGreaterThan(25);
    expect([...assigned].filter((code) => !decoded.has(code))).toEqual([]);
  });

  it('identifiers reports the bundled directory and the accepted formats', async () => {
    const data = structured(await run('identifiers'));

    expect(data.identifiers.airportDirectory).toEqual(getDirectoryInfo());
    expect(
      data.identifiers.formats.map((entry: { identifier: string }) => entry.identifier),
    ).toEqual(expect.arrayContaining(['Airport code (input)', 'Advisory reference', 'ARTCC code']));
    expect(
      data.identifiers.formats.find(
        (entry: { identifier: string }) => entry.identifier === 'ARTCC code',
      ),
    ).toMatchObject({ example: 'ZSE, NZZO', format: expect.stringContaining('4-letter ICAO') });
  });
});

describe('pacing_airports', () => {
  it('returns the live list without the isPacing flag, stamped with the fetch time', async () => {
    const data = structured(await run('pacing_airports'));

    expect(data.fetchedAt).toBe('2026-09-30T02:00:00.000Z');
    expect(data.pacingAirports.map((row: { airportId: string }) => row.airportId)).toEqual([
      'STL',
      'SEA',
      'ORD',
      'DEN',
      'TEB',
    ]);
    expect(data.pacingAirports[1]).toEqual({
      airportId: 'SEA',
      latitude: 47.4502,
      longitude: -122.3088,
      timezone: 'US/Pacific',
    });
    expect(harness.calls).toHaveLength(1);
    expect(callsTo(harness, feedUrl('pacing-airports'))).toBe(1);
  });

  it('serves a repeat call from the 6 h cache', async () => {
    await run('pacing_airports');
    await run('Pacing Airports');
    expect(harness.calls).toHaveLength(1);
  });

  it('returns an empty list for an empty feed', async () => {
    services.dispose();
    setup({ 'pacing-airports': [] });

    const result = await run('pacing_airports');

    expect(result.isError).toBeFalsy();
    expect(structured(result).pacingAirports).toEqual([]);
    expect(contentText(result)).toContain('0 pacing airports');
  });

  it('keeps sparse rows and renders their gaps as a dash', async () => {
    services.dispose();
    setup({ 'pacing-airports': [{ airportId: 'SEA' }] });

    const result = await run('pacing_airports');

    expect(structured(result).pacingAirports).toEqual([{ airportId: 'SEA' }]);
    expect(contentText(result)).toContain('| SEA | — | — | — |');
  });
});

describe('pacing_airports feed errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each(FEED_FAILURES)(
    '$label reaches the result as $reason',
    async ({ code, reason, respond }) => {
      services.dispose();
      setup({ 'pacing-airports': respond });

      const result = await withLadder(() => run('pacing_airports'));

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data?.reason).toBe(reason);
      const declared = listReference.errors?.find((entry) => entry.reason === reason);
      expect(recoveryHint(error)).toBe(declared?.recovery);
    },
  );

  it('carries pacer_shed with retryAfter', async () => {
    vi.spyOn(getNasStatusService(), 'getPacingAirports').mockRejectedValue(
      rateLimited('queue full', { reason: 'pacer_shed', retryAfter: 3 }),
    );

    expect(errorOf(await run('pacing_airports'))).toMatchObject({
      data: { reason: 'pacer_shed', retryAfter: 3 },
    });
  });

  it('keeps the static topics answering while the feed is down', async () => {
    services.dispose();
    setup({ 'pacing-airports': () => new Response('gone', { status: 404 }) });

    expect((await run('terms')).isError).toBeFalsy();
  });
});

describe('format', () => {
  it('renders each static topic with its identifying content', async () => {
    expect(contentText(await run('event_types'))).toContain(
      '## ground_delay_program — Ground Delay Program (GDP)',
    );
    expect(contentText(await run('terms'))).toMatch(/\| AAR \| /);
    const artccs = contentText(await run('artccs'));
    expect(artccs).toContain('| ZSE | Seattle Center |');
    expect(artccs).toContain('| NZZO | Auckland Oceanic FIR (New Zealand) |');
    expect(artccs).toContain('| ZUA | Guam Center |');
    expect(artccs.split('\n').filter((line) => /^\| [A-Z]{3,4} \|/.test(line))).toHaveLength(30);
    expect(contentText(await run('identifiers'))).toContain(
      `NASR cycle ${getDirectoryInfo().effectiveDate}, ${getDirectoryInfo().airportCount} US airports`,
    );
  });

  it('renders the pacing table with the same rows as structuredContent', async () => {
    const text = contentText(await run('pacing_airports'));

    expect(text).toContain('**Fetched:** 2026-09-30T02:00:00.000Z · 5 pacing airports');
    expect(text).toContain('| SEA | US/Pacific | 47.4502 | -122.3088 |');
    expect(text).toContain('| TEB | US/Eastern | 40.8501 | -74.0608 |');
  });

  it('escapes pipes and flattens newlines and tabs in table cells', async () => {
    services.dispose();
    setup({
      'pacing-airports': [{ airportId: 'SEA', timezone: 'US/Pa|cific\r\n| injected |\tx' }],
    });

    const result = await run('pacing_airports');
    const rows = contentText(result)
      .split('\n')
      .filter((line) => line.startsWith('| SEA'));

    expect(rows).toEqual(['| SEA | US/Pa\\|cific \\| injected \\| x | — | — |']);
    expect(structured(result).pacingAirports[0].timezone).toBe('US/Pa|cific\r\n| injected |\tx');
  });
});
