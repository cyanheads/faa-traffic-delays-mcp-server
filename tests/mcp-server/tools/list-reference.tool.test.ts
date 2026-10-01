/**
 * @fileoverview Tests for faa_delays_list_reference: topic normalization, the static topics'
 * content invariants, the live pacing_airports topic (cache, degrade-free error surface, sparse
 * rows), declared feed errors, and format() fidelity and table escaping.
 * @module tests/mcp-server/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { EVENT_TYPES } from '@/mcp-server/tools/schemas.js';
import { getDirectoryInfo } from '@/services/airport-directory/airport-directory.js';
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

beforeEach(() => setup());
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

  it('artccs lists the 25 centers with names', async () => {
    const artccs: { code: string; name: string }[] = structured(await run('artccs')).artccs;

    expect(artccs).toHaveLength(25);
    expect(new Set(artccs.map((entry) => entry.code)).size).toBe(25);
    expect(artccs.every((entry) => /^Z[A-Z]{2}$/.test(entry.code) && entry.name.length > 0)).toBe(
      true,
    );
    expect(artccs).toContainEqual({ code: 'ZSE', name: 'Seattle Center' });
  });

  it('identifiers reports the bundled directory and the accepted formats', async () => {
    const data = structured(await run('identifiers'));

    expect(data.identifiers.airportDirectory).toEqual(getDirectoryInfo());
    expect(
      data.identifiers.formats.map((entry: { identifier: string }) => entry.identifier),
    ).toEqual(expect.arrayContaining(['Airport code (input)', 'Advisory reference', 'ARTCC code']));
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
    expect(contentText(await run('artccs'))).toContain('| ZSE | Seattle Center |');
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
