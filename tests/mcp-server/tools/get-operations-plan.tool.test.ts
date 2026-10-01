/**
 * @fileoverview Tests for faa_delays_get_operations_plan: planned-item parsing, the announcements
 * degrade path, empty and partial plans, notices, declared feed errors, and format() fidelity and
 * sanitizing.
 * @module tests/mcp-server/tools/get-operations-plan.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOperationsPlan } from '@/mcp-server/tools/definitions/get-operations-plan.tool.js';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import {
  contentText,
  createClock,
  errorOf,
  type FeedName,
  type FeedOverride,
  feedHarness,
  installServices,
  type Responder,
  recoveryHint,
} from '../../helpers/faa-fakes.js';
import { FEED_FAILURES, withLadder } from '../../helpers/feed-failures.js';

type Overrides = Partial<Record<FeedName, FeedOverride | Responder>>;

let services: { dispose: () => void };

function setup(overrides: Overrides = {}): void {
  services = installServices({ fetch: feedHarness(overrides).fetch, now: createClock().now });
}

const run = () => runToolContract(getOperationsPlan, {});

interface Structured {
  advisory?: { date: string; number: number; url: string };
  announcements?: { text: string }[];
  enRoutePlanned: { likelihood?: string; text: string; timeQualifier?: string; timeUtc?: string }[];
  fetchedAt: string;
  notice?: string;
  terminalPlanned: {
    likelihood?: string;
    text: string;
    timeQualifier?: string;
    timeUtc?: string;
  }[];
}
const structured = (result: Awaited<ReturnType<typeof run>>) =>
  result.structuredContent as unknown as Structured;

beforeEach(() => setup());
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('plan', () => {
  it('reads planned items with qualifier, UTC time, and stated likelihood', async () => {
    const data = structured(await run());

    expect(data.terminalPlanned).toEqual([
      {
        likelihood: 'possible',
        text: 'AFTER 1100 DCA GROUND STOP/DELAY PROGRAM POSSIBLE',
        timeQualifier: 'after',
        timeUtc: '1100',
      },
      {
        likelihood: 'expected',
        text: 'AFTER 1600 BOS GROUND STOP/DELAY PROGRAM EXPECTED',
        timeQualifier: 'after',
        timeUtc: '1600',
      },
      {
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
    setup({
      'operations-plan': {
        enRoutePlanned: [],
        terminalPlanned: [{ event: 'AFTER 1100\t-DCA GS POSSIBLE' }],
      },
    });

    const result = await run();

    expect(structured(result).advisory).toBeUndefined();
    expect(structured(result).notice).toBe('The feed carried no advisory link for this plan.');
    expect(contentText(result)).toContain('**Plan advisory:** none linked');
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
    expect(data.terminalPlanned).toHaveLength(3);
    expect(data.notice).toBe(
      'ATCSCC announcements are omitted because that FAA list could not be read; the operations plan above is complete.',
    );
    expect(contentText(result)).toContain('Not available: that FAA list could not be read.');
  });

  it('rethrows a failed announcements leg when the caller was cancelled', async () => {
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
    setup({ 'operations-plan': () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run());

    expect(errorOf(result).data?.reason).toBe('feed_contract_changed');
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
  it('carries the same data as structuredContent', async () => {
    const text = contentText(await run());

    expect(text).toContain('**Fetched:** 2026-09-30T02:00:00.000Z');
    expect(text).toContain(
      '**Plan advisory:** ADVZY 82 · 2026-09-29 · https://www.fly.faa.gov/adv/adv_otherdis?advn=82&adv_date=09292026',
    );
    expect(text).toContain('## Terminal planned (3)');
    expect(text).toContain('1. after 1100 UTC · possible');
    expect(text).toContain('> AFTER 1600 BOS GROUND STOP/DELAY PROGRAM EXPECTED');
    expect(text).toContain('2. after 1600 UTC · expected');
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

    const lines = contentText(await run()).split('\n');

    expect(lines.filter((line) => line.startsWith('##') && line.includes('injection'))).toEqual([]);
    expect(lines).toContain('> WEBINAR 1115Z');
    expect(lines).toContain('> ## Injected');
    expect(lines).toContain('> SECOND LINE');
    expect(lines).toContain('> ## Plan injection POSSIBLE');
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
