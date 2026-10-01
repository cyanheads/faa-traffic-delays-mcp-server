/**
 * @fileoverview Tests for faa_delays_get_advisory: number and date normalization, the found and
 * miss outcomes, 50,000-character truncation with its optional enrichment, declared service
 * errors, and format() fidelity and fencing.
 * @module tests/mcp-server/tools/get-advisory.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdvisory } from '@/mcp-server/tools/definitions/get-advisory.tool.js';
import { getAdvisoryService } from '@/services/advisory/advisory-service.js';
import {
  advisoryUrl,
  contentText,
  createClock,
  errorOf,
  hangUntilAborted,
  htmlResponse,
  installServices,
  readFixture,
  recoveryHint,
} from '../../helpers/faa-fakes.js';
import { withLadder } from '../../helpers/feed-failures.js';

const GDP_URL = advisoryUrl(3, '09302026');

let harness: ReturnType<typeof createFetchMock>;
let services: { dispose: () => void };

function setup(pages: Record<string, () => Response | Promise<Response>>): void {
  harness = createFetchMock(Object.entries(pages).map(([match, respond]) => ({ match, respond })));
  services = installServices({ fetch: harness.fetch, now: createClock().now });
}

const run = (input: Record<string, unknown>) => runToolContract(getAdvisory, input as never);
const structured = (result: Awaited<ReturnType<typeof run>>) =>
  result.structuredContent as Record<string, unknown>;

const advisoryPage = (
  text: string,
  title = 'ATCSCC&nbsp;ADVZY&nbsp;003&nbsp;SEA/ZSE&nbsp;09/30/2026&nbsp;CDM GROUND DELAY PROGRAM',
) =>
  `<html><body><TABLE><TR><TH class=header>${title}</TH></TR><TR><TD class=val><PRE>${text}</PRE></TD></TR></TABLE></body></html>`;

beforeEach(() => setup({ [GDP_URL]: () => htmlResponse(readFixture('advisory-gdp.page')) }));
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('input', () => {
  const parse = (input: Record<string, unknown>) => getAdvisory.input.safeParse(input);

  it.each([
    [3, 3],
    ['3', 3],
    ['082', 82],
    ['ADVZY 082', 82],
    ['advzy082', 82],
    ['  ADVZY 12  ', 12],
    [999, 999],
  ])('reads advisory_number %j as %j', (input, expected) => {
    const parsed = parse({ advisory_number: input, date: '2026-09-30' });
    expect(parsed.success && parsed.data.advisory_number).toBe(expected);
  });

  it.each([
    ['zero', 0],
    ['1000', 1000],
    ['a negative number', -3],
    ['a fraction', 2.5],
    ['a non-numeric string', 'ADVZY abc'],
    ['a blank string', ''],
    ['null', null],
    ['missing', undefined],
  ])('rejects advisory_number %s', (_label, value) => {
    expect(parse({ advisory_number: value, date: '2026-09-30' }).success).toBe(false);
  });

  it.each([
    ['2026-09-30', '2026-09-30'],
    ['09/30/2026', '2026-09-30'],
    ['9/30/2026', '2026-09-30'],
    ['9/3/2026', '2026-09-03'],
    ['  2026-09-30 ', '2026-09-30'],
  ])('reads date %j as %j', (input, expected) => {
    const parsed = parse({ advisory_number: 3, date: input });
    expect(parsed.success && parsed.data.date).toBe(expected);
  });

  it.each([
    ['an impossible date', '2026-02-30'],
    ['09302026', '09302026'],
    ['a two-digit year', '09/30/26'],
    ['a blank string', ''],
    ['a number', 20260930],
    ['missing', undefined],
  ])('rejects date %s', (_label, value) => {
    expect(parse({ advisory_number: 3, date: value }).success).toBe(false);
  });

  it('rejects invalid input on the wire as InvalidParams', async () => {
    const result = await run({ advisory_number: 3, date: '2026-13-01' });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_arguments' },
    });
    expect(harness.calls).toHaveLength(0);
  });

  it('names the accepted date forms when a date is malformed', async () => {
    const result = await run({ advisory_number: 3, date: '30-09-2026' });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(contentText(result)).toContain('YYYY-MM-DD');
    expect(contentText(result)).toContain('M/D/YYYY');
  });
});

describe('found advisory', () => {
  it('returns the parsed advisory with the server-built url', async () => {
    const result = await run({ advisory_number: 3, date: '2026-09-30' });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      advisoryNumber: 3,
      controlElement: 'SEA/ZSE',
      date: '2026-09-30',
      effectiveTime: '300016-300659',
      found: true,
      sentAt: '26/09/30 00:17',
      subject: 'CDM GROUND DELAY PROGRAM',
      title: 'ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND DELAY PROGRAM',
      url: GDP_URL,
    });
    expect(structured(result).text).toContain('PROGRAM RATE: 38/36/36/36/36');
    expect(structured(result)).not.toHaveProperty('guidance');
    expect(structured(result)).not.toHaveProperty('truncated');
  });

  it('fetches only the constant-host URL built from validated inputs', async () => {
    await run({ advisory_number: 'ADVZY 003', date: '09/30/2026' });
    expect(harness.calls.map((call) => call.request.url)).toEqual([GDP_URL]);
  });

  it('serves a repeat call from cache', async () => {
    await run({ advisory_number: 3, date: '2026-09-30' });
    await run({ advisory_number: 3, date: '2026-09-30' });
    expect(harness.calls).toHaveLength(1);
  });

  it('omits fields the page does not carry', async () => {
    services.dispose();
    setup({
      [advisoryUrl(9, '10012026')]: () =>
        htmlResponse(advisoryPage('BODY ONLY', 'NAV CANADA&nbsp;ADVISORY')),
    });

    const data = structured(await run({ advisory_number: 9, date: '2026-10-01' }));

    expect(data).toMatchObject({ found: true, text: 'BODY ONLY', title: 'NAV CANADA ADVISORY' });
    for (const key of ['controlElement', 'subject', 'effectiveTime', 'sentAt']) {
      expect(data).not.toHaveProperty(key);
    }
  });
});

describe('miss', () => {
  beforeEach(() => {
    services.dispose();
    setup({
      [advisoryUrl(999, '09302026')]: () => htmlResponse(readFixture('advisory-miss.page')),
    });
  });

  it('returns found: false with guidance, not an error', async () => {
    const result = await run({ advisory_number: 999, date: '2026-09-30' });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toEqual({
      advisoryNumber: 999,
      date: '2026-09-30',
      found: false,
      guidance:
        'No ATCSCC advisory 999 exists for 2026-09-30 (UTC). Take the number and date from an advisory reference on faa_delays_list_active_events, faa_delays_get_airport_status, or faa_delays_get_operations_plan; numbers restart at 1 each UTC day.',
      url: advisoryUrl(999, '09302026'),
    });
  });

  it('renders the guidance and no text block', async () => {
    const text = contentText(await run({ advisory_number: 999, date: '2026-09-30' }));
    expect(text).toContain('**Found:** no');
    expect(text).toContain('No ATCSCC advisory 999 exists for 2026-09-30 (UTC).');
    expect(text).not.toContain('```');
  });
});

describe('truncation', () => {
  it('returns text at exactly 50,000 characters untouched, with no truncation fields', async () => {
    services.dispose();
    setup({ [GDP_URL]: () => htmlResponse(advisoryPage('x'.repeat(50_000))) });

    const data = structured(await run({ advisory_number: 3, date: '2026-09-30' }));

    expect((data.text as string).length).toBe(50_000);
    for (const key of ['truncated', 'shown', 'cap', 'totalChars', 'notice']) {
      expect(data).not.toHaveProperty(key);
    }
  });

  it('cuts longer text at 50,000 and reports the cut', async () => {
    services.dispose();
    setup({ [GDP_URL]: () => htmlResponse(advisoryPage('y'.repeat(60_000))) });

    const result = await run({ advisory_number: 3, date: '2026-09-30' });
    const data = structured(result);

    expect((data.text as string).length).toBe(50_000);
    expect(data).toMatchObject({
      cap: 50_000,
      shown: 50_000,
      totalChars: 60_000,
      truncated: true,
    });
    expect(data.notice).toBe(
      'Advisory text was cut at 50,000 of 60,000 characters; the full advisory is at the url field.',
    );
    expect(contentText(result)).toContain('**Total characters:** 60000');
  });
});

describe('declared service errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const cases = [
    {
      code: JsonRpcErrorCode.ServiceUnavailable,
      label: 'HTTP 503',
      reason: 'advisory_service_unavailable',
      respond: () => new Response('down', { status: 503 }),
    },
    {
      code: JsonRpcErrorCode.ServiceUnavailable,
      label: 'an error page with no advisory marker',
      reason: 'advisory_service_unavailable',
      respond: () => htmlResponse(readFixture('advisory-error.page')),
    },
    {
      code: JsonRpcErrorCode.SerializationError,
      label: 'HTTP 404',
      reason: 'advisory_contract_changed',
      respond: () => new Response('gone', { status: 404 }),
    },
    {
      code: JsonRpcErrorCode.SerializationError,
      label: 'a title with no text block',
      reason: 'advisory_contract_changed',
      respond: () => htmlResponse('<TH class=header>ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 GDP</TH>'),
    },
    {
      code: JsonRpcErrorCode.RateLimited,
      label: 'HTTP 429 with a long Retry-After',
      reason: 'upstream_rate_limited',
      respond: () => new Response('slow', { headers: { 'retry-after': '300' }, status: 429 }),
    },
    {
      code: JsonRpcErrorCode.Timeout,
      label: 'a hung upstream',
      reason: 'retry_deadline_exceeded',
      respond: hangUntilAborted,
    },
  ];

  it.each(cases)('$label reaches the result as $reason', async ({ code, reason, respond }) => {
    services.dispose();
    setup({ [GDP_URL]: respond as never });

    const result = await withLadder(() => run({ advisory_number: 3, date: '2026-09-30' }));

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(code);
    expect(error.data?.reason).toBe(reason);
    const declared = getAdvisory.errors?.find((entry) => entry.reason === reason);
    expect(recoveryHint(error)).toBe(declared?.recovery);
    expect(contentText(result)).toContain(`reason ${reason}`);
  });

  it('exposes the server-built url on advisory_contract_changed', async () => {
    services.dispose();
    setup({ [GDP_URL]: () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run({ advisory_number: 3, date: '2026-09-30' }));

    expect(errorOf(result).data?.url).toBe(GDP_URL);
  });

  it('carries pacer_shed with retryAfter', async () => {
    vi.spyOn(getAdvisoryService(), 'getAdvisory').mockRejectedValue(
      rateLimited('queue full', { reason: 'pacer_shed', retryAfter: 6 }),
    );

    const result = await run({ advisory_number: 3, date: '2026-09-30' });

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryAfter: 6 },
    });
  });

  it('reports a cancelled caller as RequestCancelled', async () => {
    vi.useRealTimers();
    services.dispose();
    setup({ [GDP_URL]: hangUntilAborted as never });
    const controller = new AbortController();

    const pending = runToolContract(
      getAdvisory,
      { advisory_number: 3, date: '2026-09-30' },
      { context: { signal: controller.signal } },
    );
    controller.abort(new Error('client cancelled'));

    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('format', () => {
  it('carries the same data as structuredContent', async () => {
    const result = await run({ advisory_number: 3, date: '2026-09-30' });
    const text = contentText(result);

    expect(text).toContain('## ATCSCC advisory 3 · 2026-09-30');
    expect(text).toContain(`**Found:** yes · **URL:** ${GDP_URL}`);
    expect(text).toContain(
      '**Title:** ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND DELAY PROGRAM',
    );
    expect(text).toContain('**Control element:** SEA/ZSE · **Subject:** CDM GROUND DELAY PROGRAM');
    expect(text).toContain('**Effective:** 300016-300659 · **Sent:** 26/09/30 00:17');
    expect(text).toContain('```text\nCTL ELEMENT: SEA');
    expect(text).toContain(structured(result).text as string);
  });

  it('fences with a run longer than any backtick run in the body', async () => {
    services.dispose();
    setup({ [GDP_URL]: () => htmlResponse(advisoryPage('before ```` after\n```\nend')) });

    const text = contentText(await run({ advisory_number: 3, date: '2026-09-30' }));

    expect(text).toContain('`````text\nbefore ```` after');
    expect(text.trimEnd().endsWith('\n`````')).toBe(true);
  });

  it('flattens CR/LF/TAB in inline slots but leaves the fenced text verbatim', async () => {
    services.dispose();
    setup({
      [GDP_URL]: () =>
        htmlResponse(
          `<TH class=header>ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 GDP\r\n## Title injection</TH><PRE>LINE 1\r\n## Body</PRE><TD class=nam>EFFECTIVE TIME:</TD><TD class=val>300016\r\n## Time injection</TD>`,
        ),
    });

    const lines = contentText(await run({ advisory_number: 3, date: '2026-09-30' })).split('\n');

    expect(lines.some((line) => line.startsWith('## Title injection'))).toBe(false);
    expect(lines.some((line) => line.startsWith('## Time injection'))).toBe(false);
    expect(lines).toContain('## Body');
  });
});
