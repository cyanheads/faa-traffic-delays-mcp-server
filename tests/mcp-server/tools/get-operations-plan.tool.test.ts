/**
 * @fileoverview Tests for faa_delays_get_operations_plan: planned-item parsing, the announcements
 * degrade path, empty and partial plans, notices, declared feed errors, and format() fidelity and
 * sanitizing.
 * @module tests/mcp-server/tools/get-operations-plan.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdvisory } from '@/mcp-server/tools/definitions/get-advisory.tool.js';
import { getOperationsPlan } from '@/mcp-server/tools/definitions/get-operations-plan.tool.js';
import { getAdvisoryService } from '@/services/advisory/advisory-service.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import {
  advisoryUrl,
  callsTo,
  contentText,
  createClock,
  errorOf,
  type FeedName,
  type FeedOverride,
  feedRoutes,
  htmlResponse,
  installServices,
  jsonResponse,
  type Responder,
  readFixture,
  recoveryHint,
} from '../../helpers/faa-fakes.js';
import { FEED_FAILURES, withLadder } from '../../helpers/feed-failures.js';

type Overrides = Partial<Record<FeedName, FeedOverride | Responder>>;

let services: { dispose: () => void };

const historicalAdvisory = advisoryUrl(3, '11042026');
const historicalPlan = {
  link: historicalAdvisory,
  terminalPlanned: [{ event: 'UNTIL 0500\t-MEM GROUND STOP PROBABLE' }],
  enRoutePlanned: [],
};
const historicalItem = {
  airports: ['MEM'],
  likelihood: 'probable',
  text: 'UNTIL 0500 MEM GROUND STOP PROBABLE',
  timeQualifier: 'until',
  timeUtc: '0500',
};
const signedAdvisory = () =>
  htmlResponse(
    '<PRE>UNTIL 0500 -MEM GROUND STOP PROBABLE\n040025-041000\n26/11/04 00:25  DCCOPS</PRE>',
  );

function setup(
  overrides: Overrides = {},
  respond: Responder = signedAdvisory,
  clock = createClock(),
) {
  const fixture = readFixture('advisory-ops-plan.page');
  const harness = createFetchMock([
    ...feedRoutes(overrides),
    { match: advisoryUrl(82, '09292026'), respond: () => htmlResponse(fixture) },
    {
      match: advisoryUrl(5, '09302026'),
      respond: () => htmlResponse(fixture.replace('26/09/29 23:53', '26/09/30 23:53')),
    },
    { match: historicalAdvisory, respond },
  ]);
  services = installServices({ fetch: harness.fetch, now: clock.now });
  return harness;
}

const run = () => runToolContract(getOperationsPlan, {});

interface Structured {
  advisory?: { date: string; number: number; url: string };
  announcements?: { text: string }[];
  enRoutePlanned: { likelihood?: string; text: string; timeQualifier?: string; timeUtc?: string }[];
  fetchedAt: string;
  notice?: string;
  sentAt?: string;
  terminalPlanned: {
    airports?: string[];
    likelihood?: string;
    text: string;
    timeQualifier?: string;
    timeUtc?: string;
  }[];
}
const structured = (result: Awaited<ReturnType<typeof run>>) =>
  result.structuredContent as unknown as Structured;

const commonmark = new MarkdownIt('commonmark');

function quotedText(tokens: ReturnType<typeof commonmark.parse>, prefix: string): string {
  const index = tokens.findIndex(
    (token) => token.type === 'inline' && token.content.startsWith(prefix),
  );
  expect(tokens.slice(index - 2, index + 3).map((token) => token.type)).toEqual([
    'blockquote_open',
    'paragraph_open',
    'inline',
    'paragraph_close',
    'blockquote_close',
  ]);
  return (tokens[index]?.children ?? [])
    .map((child) => {
      expect(['text', 'hardbreak']).toContain(child.type);
      return child.type === 'hardbreak' ? '\n' : child.content;
    })
    .join('');
}

beforeEach(() => setup());
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('plan', () => {
  it('rejects a non-object argument before starting FAA requests', async () => {
    services.dispose();
    const harness = setup();

    const result = await runToolContract(getOperationsPlan, 'invalid' as never);

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(harness.calls).toHaveLength(0);
  });

  it('keeps a published UNTIL item even after its stated UTC clock time', async () => {
    services.dispose();
    setup(
      { 'operations-plan': historicalPlan },
      signedAdvisory,
      createClock('2026-11-04T08:54:00Z'),
    );

    const result = await run();

    expect(structured(result).terminalPlanned).toEqual([historicalItem]);
    expect(contentText(result)).toContain('1. until 0500 UTC · probable · airports: MEM');
  });
  it('discloses malformed planned sections without calling them empty or complete', async () => {
    services.dispose();
    setup({
      'operations-plan': { terminalPlanned: 'AFTER 1500 BOS GDP EXPECTED', enRoutePlanned: [] },
    });
    const result = await run();
    for (const text of [structured(result).notice, contentText(result)]) {
      expect(text).toContain('operations-plan.terminalPlanned');
      expect(text).toContain('unknown, not confirmed empty');
      expect(text).not.toContain('lists no planned programs');
      expect(text).not.toContain('above is complete');
    }
  });
  it('reads planned items with qualifier, UTC time, and stated likelihood', async () => {
    const data = structured(await run());

    expect(data.terminalPlanned).toEqual([
      {
        airports: ['DCA'],
        likelihood: 'possible',
        text: 'AFTER 1100 DCA GROUND STOP/DELAY PROGRAM POSSIBLE',
        timeQualifier: 'after',
        timeUtc: '1100',
      },
      {
        airports: ['BOS'],
        likelihood: 'expected',
        text: 'AFTER 1600 BOS GROUND STOP/DELAY PROGRAM EXPECTED',
        timeQualifier: 'after',
        timeUtc: '1600',
      },
      {
        airports: ['MIA', 'FLL'],
        likelihood: 'probable',
        text: 'AFTER 1800 MIA/FLL GROUND STOP PROBABLE',
        timeQualifier: 'after',
        timeUtc: '1800',
      },
    ]);
    expect(data.enRoutePlanned).toHaveLength(2);
    expect(data.enRoutePlanned[1]?.text).toBe('AFTER 1700 DEN CDRS/SWAP/ARRIVAL ROUTES POSSIBLE');
    expect(data.advisory).toEqual({
      date: '2026-09-29',
      number: 82,
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=82&adv_date=09292026',
    });
    expect(data.fetchedAt).toBe('2026-09-30T02:00:00.000Z');
  });

  it('names the airports of each terminal item, leaving the field out when none resolve', async () => {
    services.dispose();
    setup({
      'operations-plan': {
        enRoutePlanned: [],
        link: 'https://x.test/?advn=3&adv_date=11042026',
        terminalPlanned: [
          { event: 'AFTER 1600\t-SEA/BFI GROUND STOP/DELAY PROGRAM POSSIBLE', time: '' },
          { event: 'AFTER 1600\t-NEW YORK METROS GROUND STOP POSSIBLE', time: '' },
          { event: 'AFTER 1700\t-ZNY GROUND STOP' },
        ],
      },
    });

    const result = await run();
    const items = structured(result).terminalPlanned;

    expect(result.isError).toBeFalsy();
    expect(items[0]?.airports).toEqual(['SEA', 'BFI']);
    expect(items[1]).not.toHaveProperty('airports');
    expect(items[2]).toEqual({
      text: 'AFTER 1700 ZNY GROUND STOP',
      timeQualifier: 'after',
      timeUtc: '1700',
    });
    const lines = contentText(result).split('\n');
    expect(lines).toContain('1. after 1600 UTC · possible · airports: SEA, BFI');
    expect(lines).toContain('2. after 1600 UTC · possible');
    expect(lines).toContain('3. after 1700 UTC');
  });

  it('keeps en-route items to text, time, and likelihood', async () => {
    services.dispose();
    setup({
      'operations-plan': {
        enRoutePlanned: [{ event: 'AFTER 1500\t-DEN GROUND STOP POSSIBLE', time: '' }],
        link: 'https://x.test/?advn=3&adv_date=11042026',
        terminalPlanned: [],
      },
    });

    const result = await run();

    expect(structured(result).enRoutePlanned).toEqual([
      {
        likelihood: 'possible',
        text: 'AFTER 1500 DEN GROUND STOP POSSIBLE',
        timeQualifier: 'after',
        timeUtc: '1500',
      },
    ]);
    expect(contentText(result).split('\n')).toContain('1. after 1500 UTC · possible');
  });

  it('declares airports on terminal items only', () => {
    const { enRoutePlanned, terminalPlanned } = getOperationsPlan.output.shape;

    expect(terminalPlanned.element.shape.airports.description).toContain('NASR');
    expect(enRoutePlanned.element.shape).not.toHaveProperty('airports');
  });

  it('carries the announcements list', async () => {
    expect(structured(await run()).announcements).toEqual([
      { text: 'NEXT PLANNING WEBINAR 1115Z' },
    ]);
  });

  it('returns an empty announcements array, not an absent one, when there are none', async () => {
    services.dispose();
    setup({ 'miscellaneous-info': [] });

    const data = structured(await run());

    expect(data.announcements).toEqual([]);
    expect(data.notice).toBeUndefined();
  });

  it('is quiet when the plan is complete', async () => {
    expect(structured(await run()).notice).toBeUndefined();
  });

  it('notes an empty plan on the zero-result page', async () => {
    services.dispose();
    setup({
      'operations-plan': {
        enRoutePlanned: [],
        link: 'https://x.test/?advn=5&adv_date=09302026',
        terminalPlanned: [],
      },
      'miscellaneous-info': [],
    });

    const result = await run();
    const data = structured(result);

    expect(result.isError).toBeFalsy();
    expect(data.terminalPlanned).toEqual([]);
    expect(data.enRoutePlanned).toEqual([]);
    expect(data.notice).toBe(
      'The operations plan lists no planned programs. faa_delays_list_active_events shows what is active now.',
    );
    expect(contentText(result)).toContain('## Terminal planned (0)');
    expect(contentText(result)).toContain('None listed.');
  });

  it('notes a missing advisory link', async () => {
    services.dispose();
    const harness = setup({
      'operations-plan': {
        enRoutePlanned: [],
        terminalPlanned: [{ event: 'AFTER 1100\t-DCA GS POSSIBLE' }],
      },
    });

    const result = await run();

    expect(structured(result).advisory).toBeUndefined();
    expect(structured(result)).not.toHaveProperty('sentAt');
    expect(structured(result).notice).toBe('The feed carried no advisory link for this plan.');
    expect(contentText(result)).toContain('**Plan advisory:** none linked');
    expect(
      harness.calls.every(({ request }) => new URL(request.url).host === 'nasstatus.faa.gov'),
    ).toBe(true);
  });

  it('counts skipped plan and announcement rows together', async () => {
    services.dispose();
    setup({
      'miscellaneous-info': [{ event: 'A' }, { junk: true }],
      'operations-plan': {
        enRoutePlanned: [],
        link: 'https://x.test/?advn=5&adv_date=09302026',
        terminalPlanned: [{ event: 'AFTER 1100\t-DCA GS POSSIBLE' }, { time: '1200' }],
      },
    });

    expect(structured(await run()).notice).toContain(
      '2 FAA feed rows could not be read and were skipped.',
    );
  });

  it('reports one skipped row in the singular', async () => {
    services.dispose();
    setup({ 'miscellaneous-info': [{ event: 'A' }, { junk: true }] });

    expect(structured(await run()).notice).toBe(
      '1 FAA feed row could not be read and was skipped.',
    );
  });

  it('describes timeUtc as dated by the plan event window, not the advisory date', () => {
    const description = getOperationsPlan.output.shape.terminalPlanned.element.shape.timeUtc
      .description as string;

    expect(description).toContain('EVENT TIME');
    expect(description).toContain('UTC day after the advisory date');
    expect(description).not.toContain('covers the UTC day of its advisory');
  });

  it('keeps an item that states no time or likelihood', async () => {
    services.dispose();
    setup({
      'operations-plan': {
        enRoutePlanned: [{ event: 'GULF ROUTE CLOSURES WERE EXTENDED', time: '' }],
        link: 'https://x.test/?advn=5&adv_date=09302026',
        terminalPlanned: [],
      },
    });

    const result = await run();

    expect(structured(result).enRoutePlanned).toEqual([
      { text: 'GULF ROUTE CLOSURES WERE EXTENDED' },
    ]);
    expect(contentText(result)).toContain('no time or likelihood stated');
  });
});

describe('plan advisory send time', () => {
  it('returns the signature on both surfaces and reuses the full advisory cache', async () => {
    services.dispose();
    const harness = setup({ 'operations-plan': historicalPlan });

    const result = await run();

    expect(structured(result).sentAt).toBe('2026-11-04T00:25:00Z');
    expect(structured(result).terminalPlanned).toEqual([historicalItem]);
    expect(contentText(result)).toContain('sent 2026-11-04T00:25:00Z');
    const advisory = await runToolContract(getAdvisory, {
      advisory_number: 3,
      date: '2026-11-04',
    });
    expect(advisory.structuredContent).toMatchObject({ sentAt: '2026-11-04T00:25:00Z' });
    expect(callsTo(harness, historicalAdvisory)).toBe(1);
  });

  it.each([
    ['a page miss', () => htmlResponse(readFixture('advisory-miss.page')), 'has no page'],
    [
      'an absent signature',
      () => htmlResponse('<PRE>Plan text</PRE>'),
      'has no readable signature',
    ],
    [
      'an invalid signature',
      () => htmlResponse('<PRE>Plan text\n26/11/04 24:25</PRE>'),
      'has no readable signature',
    ],
    ['an unavailable service', () => new Response('down', { status: 503 }), 'could not be read'],
    ['a changed path', () => new Response('gone', { status: 404 }), 'could not be read'],
  ])('keeps the plan and announcements with %s', async (_label, respond, notice) => {
    vi.useFakeTimers();
    services.dispose();
    setup({ 'operations-plan': historicalPlan }, respond);

    const result = await withLadder(run);
    const data = structured(result);

    expect(result.isError).toBeFalsy();
    expect(data).not.toHaveProperty('sentAt');
    expect(data.advisory).toEqual({ number: 3, date: '2026-11-04', url: historicalAdvisory });
    expect(data.terminalPlanned).toEqual([historicalItem]);
    expect(data.announcements).toEqual([{ text: 'NEXT PLANNING WEBINAR 1115Z' }]);
    expect(data.notice).toContain('Plan send time is unavailable');
    expect(data.notice).toContain('ADVZY 3 (2026-11-04)');
    expect(data.notice).toContain(notice);
    expect(contentText(result)).toContain(notice);
    if (notice === 'could not be read') {
      expect(contentText(result)).toContain('faa_delays_get_advisory');
    }
  });

  it('starts the advisory lookup while announcements are pending', async () => {
    services.dispose();
    vi.useFakeTimers();
    const announcements = Promise.withResolvers<Response>();
    const harness = setup({
      'operations-plan': historicalPlan,
      'miscellaneous-info': () => announcements.promise,
    });
    const pending = run();
    await vi.advanceTimersByTimeAsync(0);
    const advisoryCallsBeforeAnnouncements = callsTo(harness, historicalAdvisory);
    announcements.resolve(jsonResponse([]));

    const result = await pending;

    expect(advisoryCallsBeforeAnnouncements).toBe(1);
    expect(structured(result)).toMatchObject({ sentAt: '2026-11-04T00:25:00Z', announcements: [] });
  });

  it('propagates unexpected advisory errors', async () => {
    vi.spyOn(getAdvisoryService(), 'getAdvisory').mockRejectedValue(
      new TypeError('unexpected advisory error'),
    );

    expect(errorOf(await run()).code).toBe(JsonRpcErrorCode.InternalError);
  });

  it('propagates caller cancellation while waiting for the advisory read', async () => {
    services.dispose();
    const started = Promise.withResolvers<void>();
    const page = Promise.withResolvers<Response>();
    const harness = setup({ 'operations-plan': historicalPlan }, () => {
      started.resolve();
      return page.promise;
    });
    const controller = new AbortController();
    const pending = runToolContract(
      getOperationsPlan,
      {},
      { context: { signal: controller.signal } },
    );
    await started.promise;
    controller.abort(new Error('client cancelled'));

    const result = await pending;
    page.resolve(signedAdvisory());
    const later = await run();

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(contentText(result)).toContain('client cancelled');
    expect(structured(later).sentAt).toBe('2026-11-04T00:25:00Z');
    expect(callsTo(harness, historicalAdvisory)).toBe(1);
  });
});

describe('announcements degrade path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    ['an outage', () => new Response('down', { status: 503 })],
    ['a moved path', () => new Response('gone', { status: 404 })],
  ])('omits announcements with a notice on %s', async (_label, respond) => {
    services.dispose();
    setup({ 'miscellaneous-info': respond });

    const result = await withLadder(() => run());
    const data = structured(result);

    expect(result.isError).toBeFalsy();
    expect(data).not.toHaveProperty('announcements');
    expect(data.sentAt).toBe('2026-09-29T23:53:00Z');
    expect(data.terminalPlanned).toHaveLength(3);
    expect(data.notice).toBe(
      'ATCSCC announcements are omitted because that FAA list could not be read.',
    );
    expect(contentText(result)).toContain('Not available: that FAA list could not be read.');
  });

  it('rejects an already-cancelled caller even when the plan is cached', async () => {
    const controller = new AbortController();
    await getNasStatusService().getOperationsPlan(createMockContext());
    controller.abort(new Error('client cancelled'));

    const result = await runToolContract(
      getOperationsPlan,
      {},
      { context: { signal: controller.signal } },
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('fails the call when the plan leg fails, even if announcements are fine', async () => {
    services.dispose();
    const harness = setup({ 'operations-plan': () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run());

    expect(errorOf(result).data?.reason).toBe('feed_contract_changed');
    expect(
      harness.calls.every(({ request }) => new URL(request.url).host === 'nasstatus.faa.gov'),
    ).toBe(true);
  });
});

describe('declared feed errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each(FEED_FAILURES)(
    '$label on operations-plan reaches the result as $reason',
    async ({ code, reason, respond }) => {
      services.dispose();
      setup({ 'operations-plan': respond });

      const result = await withLadder(() => run());

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data?.reason).toBe(reason);
      const declared = getOperationsPlan.errors?.find((entry) => entry.reason === reason);
      expect(recoveryHint(error)).toBe(declared?.recovery);
      expect(contentText(result)).toContain(recoveryHint(error));
      expect(declared?.recovery).toContain(
        reason === 'feed_contract_changed'
          ? 'faa_delays_get_advisory'
          : 'faa_delays_get_operations_plan',
      );
    },
  );

  it('rejects a wrong-shaped plan body as feed_contract_changed', async () => {
    services.dispose();
    setup({ 'operations-plan': [] });

    const result = await withLadder(() => run());

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: { reason: 'feed_contract_changed' },
    });
  });

  it('carries pacer_shed with retryAfter', async () => {
    vi.spyOn(getNasStatusService(), 'getOperationsPlan').mockRejectedValue(
      rateLimited('queue full', { reason: 'pacer_shed', retryAfter: 4 }),
    );

    expect(errorOf(await run())).toMatchObject({ data: { reason: 'pacer_shed', retryAfter: 4 } });
  });
});

describe('format', () => {
  it('renders announcement links literally and keeps structured text verbatim', async () => {
    const text =
      'USE <FIX> [route](u) *literal*\n\n## Heading\n1. List\n---\nFCA005:NO_AR_ATLANTIC\t\u202e';
    services.dispose();
    setup({ 'miscellaneous-info': [{ event: text }] });
    const result = await run();
    expect(structured(result).announcements).toEqual([{ text }]);
    const tokens = commonmark.parse(contentText(result), {});
    expect(quotedText(tokens, 'USE')).toBe(text.replace('\t\u202e', ' '));
  });
  it('carries the same data as structuredContent', async () => {
    const text = contentText(await run());

    expect(text).toContain('**Fetched:** 2026-09-30T02:00:00.000Z');
    expect(text).toContain(
      '**Plan advisory:** ADVZY 82 · 2026-09-29 · https://www.fly.faa.gov/adv/adv_otherdis?advn=82&adv_date=09292026',
    );
    expect(text).toContain('## Terminal planned (3)');
    expect(text).toContain('1. after 1100 UTC · possible · airports: DCA');
    expect(text).toContain('> AFTER 1600 BOS GROUND STOP/DELAY PROGRAM EXPECTED');
    expect(text).toContain('2. after 1600 UTC · expected · airports: BOS');
    expect(text).toContain('3. after 1800 UTC · probable · airports: MIA, FLL');
    expect(text).toContain('## En-route planned (2)');
    expect(text).toContain('## ATCSCC announcements (1)');
    expect(text).toContain('> NEXT PLANNING WEBINAR 1115Z');
  });

  it('renders an empty announcements list as None', async () => {
    services.dispose();
    setup({ 'miscellaneous-info': [] });

    const text = contentText(await run());

    expect(text).toContain('## ATCSCC announcements (0)');
    expect(text).toContain('None.');
  });

  it('quotes multi-line plan and announcement text, every line prefixed', async () => {
    services.dispose();
    setup({
      'miscellaneous-info': [{ event: 'WEBINAR 1115Z\r\n## Injected\nSECOND LINE' }],
      'operations-plan': {
        enRoutePlanned: [],
        link: 'https://x.test/?advn=5&adv_date=09302026',
        terminalPlanned: [{ event: 'AFTER 1100\t-DCA GS\r\n## Plan injection POSSIBLE' }],
      },
    });

    const tokens = commonmark.parse(contentText(await run()), {});

    expect(quotedText(tokens, 'WEBINAR 1115Z')).toBe('WEBINAR 1115Z\n## Injected\nSECOND LINE');
    expect(quotedText(tokens, 'AFTER 1100')).toBe('AFTER 1100 DCA GS\n## Plan injection POSSIBLE');
  });

  it('keeps the parsed time out of an inline slot when upstream time carries a newline', async () => {
    services.dispose();
    setup({
      'operations-plan': {
        enRoutePlanned: [],
        link: 'https://x.test/?advn=5&adv_date=09302026',
        terminalPlanned: [
          { event: 'AFTER 1100\t-DCA GS POSSIBLE', time: '1215\r\n## Time injection' },
        ],
      },
    });

    const lines = contentText(await run()).split('\n');

    expect(lines.some((line) => line.startsWith('## Time injection'))).toBe(false);
  });
});
