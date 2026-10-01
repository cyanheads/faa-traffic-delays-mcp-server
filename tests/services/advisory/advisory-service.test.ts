/**
 * @fileoverview Tests for AdvisoryService and parseAdvisoryPage over captured-shape advisory
 * pages: field extraction, entity decoding, the miss / layout-change / error-page outcomes, the
 * 6 h and 60 s caches, and fetch failure classes.
 * @module tests/services/advisory/advisory-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdvisoryService,
  decodeEntities,
  getAdvisoryService,
  initAdvisoryService,
  parseAdvisoryPage,
} from '@/services/advisory/advisory-service.js';
import { advisoryUrl, createClock, htmlResponse, readFixture } from '../../helpers/faa-fakes.js';

const URL_UNDER_TEST = 'https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=09302026';

const page = (title: string | undefined, pre: string | undefined, extra = ''): string =>
  `<html><body><TABLE>${
    title === undefined ? '' : `<TR><TH class=header colspan=2>${title}</TH></TR>`
  }${pre === undefined ? '' : `<TR><TD class=val><PRE>${pre}</PRE></TD></TR>`}${extra}</TABLE></body></html>`;

describe('decodeEntities', () => {
  it.each([
    ['&nbsp;', ' '],
    ['&amp;&lt;&gt;&quot;&apos;', `&<>"'`],
    ['&#65;&#x42;&#X43;', 'ABC'],
    ['&NBSP;', ' '],
    ['&unknown;', '&unknown;'],
    ['&#0;', '&#0;'],
    ['&#x110000;', '&#x110000;'],
    ['A&constructor;B', 'A&constructor;B'],
    ['plain text', 'plain text'],
  ])('decodes %j to %j', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it.each([
    ['ESC', '&#27;[2J'],
    ['ESC in hex', '&#x1b;'],
    ['NUL-range C0', '&#1;&#8;&#11;&#31;'],
    ['DEL and C1', '&#127;&#133;&#x9B;'],
    ['bidi overrides and isolates', '&#x202A;&#8238;&#x2066;&#x2069;'],
  ])('leaves %s encoded', (_label, input) => {
    expect(decodeEntities(input)).toBe(input);
  });

  it('decodes tab, line feed, and carriage return', () => {
    expect(decodeEntities('A&#9;B&#10;C&#x0D;D')).toBe('A\tB\nC\rD');
  });
});

describe('parseAdvisoryPage', () => {
  it('reads a GDP advisory: title parts, effective time, signature, and text', () => {
    const result = parseAdvisoryPage(readFixture('advisory-gdp.page'), URL_UNDER_TEST);

    expect(result).toMatchObject({
      controlElement: 'SEA/ZSE',
      effectiveTime: '300016-300659',
      found: true,
      sentAt: '26/09/30 00:17',
      subject: 'CDM GROUND DELAY PROGRAM',
      title: 'ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND DELAY PROGRAM',
    });
    expect(result.text).toMatch(/^CTL ELEMENT: SEA\n/);
    expect(result.text).toContain('PROGRAM RATE: 38/36/36/36/36');
    expect(result.text).toContain('CONSTRAINTS TO AVOID GROUND STOP POSTURE.');
  });

  it('trims the literal trailing &nbsp; the FAA appends to the text block', () => {
    const result = parseAdvisoryPage(readFixture('advisory-gdp.page'), URL_UNDER_TEST);
    expect(result.text?.endsWith('POSTURE.')).toBe(true);
  });

  it('reads an operations plan: no effective time or signature cells', () => {
    const result = parseAdvisoryPage(readFixture('advisory-ops-plan.page'), URL_UNDER_TEST);

    expect(result).toMatchObject({
      controlElement: 'DCC',
      found: true,
      subject: 'OPERATIONS PLAN',
      title: 'ATCSCC ADVZY 082 DCC 09/29/2026 OPERATIONS PLAN',
    });
    expect(result.effectiveTime).toBeUndefined();
    expect(result.sentAt).toBeUndefined();
    expect(result.text).toContain('TERMINAL PLANNED:');
  });

  it('decodes entities inside the text block', () => {
    const result = parseAdvisoryPage(
      page('ATCSCC&nbsp;ADVZY&nbsp;001&nbsp;DCC&nbsp;09/30/2026&nbsp;NOTE', 'A &amp; B &lt;C&gt;'),
      URL_UNDER_TEST,
    );
    expect(result.text).toBe('A & B <C>');
  });

  it('leaves control element and subject absent for a title in another form', () => {
    const result = parseAdvisoryPage(
      page('NAV CANADA&nbsp;ADVISORY&nbsp;12', 'TEXT BODY'),
      URL_UNDER_TEST,
    );

    expect(result).toEqual({ found: true, text: 'TEXT BODY', title: 'NAV CANADA ADVISORY 12' });
  });

  it('reads a text block without a title', () => {
    expect(parseAdvisoryPage(page(undefined, 'ORPHAN TEXT'), URL_UNDER_TEST)).toEqual({
      found: true,
      text: 'ORPHAN TEXT',
    });
  });

  it('omits text when the block is empty or only whitespace and &nbsp;', () => {
    const result = parseAdvisoryPage(
      page('ATCSCC ADVZY 001 DCC 09/30/2026 NOTE', '  &nbsp; \n'),
      URL_UNDER_TEST,
    );
    expect(result.found).toBe(true);
    expect(result).not.toHaveProperty('text');
  });

  it('matches PRE and header tags case-insensitively and with attributes', () => {
    const html =
      "<th CLASS='header' align=center>ATCSCC ADVZY 005 ZNY/ZNY 09/30/2026 FCA</th><pre id=x>lower</pre>";
    expect(parseAdvisoryPage(html, URL_UNDER_TEST)).toMatchObject({
      found: true,
      subject: 'FCA',
      text: 'lower',
    });
  });

  it('reads the miss page as found: false with nothing else', () => {
    expect(parseAdvisoryPage(readFixture('advisory-miss.page'), URL_UNDER_TEST)).toEqual({
      found: false,
    });
  });

  it('raises advisory_contract_changed, carrying the url, when a title has no text block', () => {
    try {
      parseAdvisoryPage(page('ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 GDP', undefined), URL_UNDER_TEST);
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
      expect((error as McpError).data).toEqual({
        reason: 'advisory_contract_changed',
        retryable: false,
        url: URL_UNDER_TEST,
      });
      return;
    }
    throw new Error('Expected advisory_contract_changed.');
  });

  it.each([['the invalid-input error page', 'advisory-error.page']])(
    'raises advisory_service_unavailable for %s',
    (_label, fixture) => {
      try {
        parseAdvisoryPage(readFixture(fixture), URL_UNDER_TEST);
      } catch (error) {
        expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect((error as McpError).data).toMatchObject({
          reason: 'advisory_service_unavailable',
          url: URL_UNDER_TEST,
        });
        return;
      }
      throw new Error('Expected advisory_service_unavailable.');
    },
  );

  it('raises advisory_service_unavailable for an empty page', () => {
    expect(() => parseAdvisoryPage('', URL_UNDER_TEST)).toThrow(/neither an advisory/);
  });

  describe('time on hostile markup', () => {
    const TITLE = 'ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 GDP';

    function elapsedMs(run: () => void): number {
      const started = performance.now();
      run();
      return performance.now() - started;
    }

    it.each([
      ['label cells with no value cell', page(TITLE, 'TEXT', 'EFFECTIVE TIME:'.repeat(20_000))],
      [
        'value cells with no closing tag',
        page(TITLE, 'TEXT', `EFFECTIVE TIME:${'<TD class=val>'.repeat(20_000)}`),
      ],
      [
        'unclosed tags inside a value cell',
        page(
          TITLE,
          'TEXT',
          `<TD class=nam>EFFECTIVE TIME:</TD><TD class=val>${'<'.repeat(40_000)}</TD>`,
        ),
      ],
      ['header cells with no closing tag', `${'<TH class=header>'.repeat(20_000)}<PRE>T</PRE>`],
    ])('reads a page of %s in linear time', (_label, html) => {
      expect(
        elapsedMs(() => expect(parseAdvisoryPage(html, URL_UNDER_TEST).found).toBe(true)),
      ).toBeLessThan(250);
    });

    it.each([
      ['unterminated PRE tags', '<PRE'.repeat(30_000)],
      ['PRE blocks with no closing tag', '<PRE>'.repeat(30_000)],
    ])('rejects a page of %s in linear time', (_label, html) => {
      expect(
        elapsedMs(() =>
          expect(() => parseAdvisoryPage(html, URL_UNDER_TEST)).toThrow(/neither an advisory/),
        ),
      ).toBeLessThan(250);
    });
  });
});

describe('AdvisoryService', () => {
  let service: AdvisoryService;

  afterEach(() => {
    service?.dispose();
    vi.useRealTimers();
  });

  function makeService(pages: Record<string, () => Response>) {
    const clock = createClock();
    const harness = createFetchMock(
      Object.entries(pages).map(([url, respond]) => ({ match: url, respond })),
    );
    service = new AdvisoryService({
      fetch: harness.fetch,
      now: clock.now,
      userAgent: 'faa-test/9.9',
    });
    return { clock, harness };
  }

  async function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    return outcome;
  }

  it('fetches the server-built URL with HTML headers and parses the page', async () => {
    const { harness } = makeService({
      [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-gdp.page')),
    });

    const result = await service.getAdvisory(3, '2026-09-30', createMockContext());

    expect(result).toMatchObject({ found: true, subject: 'CDM GROUND DELAY PROGRAM' });
    const request = harness.calls[0]?.request as Request;
    expect(request.url).toBe(URL_UNDER_TEST);
    expect(request.headers.get('accept')).toBe('text/html');
    expect(request.headers.get('user-agent')).toBe('faa-test/9.9');
  });

  it('caches an issued advisory for 6 h', async () => {
    const { clock, harness } = makeService({
      [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-gdp.page')),
    });
    const ctx = createMockContext();

    await service.getAdvisory(3, '2026-09-30', ctx);
    clock.advance(6 * 60 * 60_000 - 1);
    await service.getAdvisory(3, '2026-09-30', ctx);
    expect(harness.calls).toHaveLength(1);

    clock.advance(1);
    await service.getAdvisory(3, '2026-09-30', ctx);
    expect(harness.calls).toHaveLength(2);
  });

  it('caches a miss for only 60 s, since the next number may appear', async () => {
    const { clock, harness } = makeService({
      [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-miss.page')),
    });
    const ctx = createMockContext();

    await expect(service.getAdvisory(3, '2026-09-30', ctx)).resolves.toEqual({ found: false });
    clock.advance(59_999);
    await service.getAdvisory(3, '2026-09-30', ctx);
    expect(harness.calls).toHaveLength(1);

    clock.advance(1);
    await service.getAdvisory(3, '2026-09-30', ctx);
    expect(harness.calls).toHaveLength(2);
  });

  it('caches a miss for 6 h once its UTC date has been over for an hour', async () => {
    const past = advisoryUrl(3, '09282026');
    const { clock, harness } = makeService({
      [past]: () => htmlResponse(readFixture('advisory-miss.page')),
    });
    const ctx = createMockContext();

    await expect(service.getAdvisory(3, '2026-09-28', ctx)).resolves.toEqual({ found: false });
    clock.advance(6 * 60 * 60_000 - 1);
    await service.getAdvisory(3, '2026-09-28', ctx);
    expect(harness.calls).toHaveLength(1);

    clock.advance(1);
    await service.getAdvisory(3, '2026-09-28', ctx);
    expect(harness.calls).toHaveLength(2);
  });

  it('keeps the 60 s miss cache until the UTC date has been over for an hour', async () => {
    const { clock, harness } = makeService({
      [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-miss.page')),
    });
    const ctx = createMockContext();
    // 2026-10-01T00:30Z: the 2026-09-30 UTC day ended 30 minutes ago.
    clock.advance(22.5 * 60 * 60_000);

    await service.getAdvisory(3, '2026-09-30', ctx);
    clock.advance(60_000);
    await service.getAdvisory(3, '2026-09-30', ctx);
    expect(harness.calls).toHaveLength(2);

    // 01:01Z: over an hour since the day ended, so this miss is kept for 6 h.
    clock.advance(30 * 60_000);
    await service.getAdvisory(3, '2026-09-30', ctx);
    clock.advance(60 * 60_000);
    await service.getAdvisory(3, '2026-09-30', ctx);
    expect(harness.calls).toHaveLength(3);
  });

  it('keys the cache by date and number', async () => {
    const other = advisoryUrl(3, '09292026');
    const { harness } = makeService({
      [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-gdp.page')),
      [other]: () => htmlResponse(readFixture('advisory-ops-plan.page')),
    });
    const ctx = createMockContext();

    const a = await service.getAdvisory(3, '2026-09-30', ctx);
    const b = await service.getAdvisory(3, '2026-09-29', ctx);

    expect(a.subject).toBe('CDM GROUND DELAY PROGRAM');
    expect(b.subject).toBe('OPERATIONS PLAN');
    expect(harness.calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent callers of the same advisory', async () => {
    const { harness } = makeService({
      [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-gdp.page')),
    });

    await Promise.all([
      service.getAdvisory(3, '2026-09-30', createMockContext()),
      service.getAdvisory(3, '2026-09-30', createMockContext()),
    ]);

    expect(harness.calls).toHaveLength(1);
  });

  it('rejects a cancelled caller with its own reason', async () => {
    makeService({ [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-gdp.page')) });
    const controller = new AbortController();

    const call = service.getAdvisory(
      3,
      '2026-09-30',
      createMockContext({ signal: controller.signal }),
    );
    controller.abort(new Error('client cancelled'));

    await expect(call).rejects.toThrow('client cancelled');
  });

  it('accepts an HTML 200 page (the profile does not treat HTML as maintenance)', async () => {
    makeService({ [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-ops-plan.page')) });
    await expect(service.getAdvisory(3, '2026-09-30', createMockContext())).resolves.toMatchObject({
      found: true,
    });
  });

  describe('failures', () => {
    it.each([404, 410])(
      'reads HTTP %i as advisory_contract_changed without retrying',
      async (status) => {
        vi.useFakeTimers();
        const { harness } = makeService({
          [URL_UNDER_TEST]: () => new Response('Website Unavailable', { status }),
        });

        const { error } = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));

        expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
        expect((error as McpError).data).toMatchObject({
          reason: 'advisory_contract_changed',
          retryable: false,
          url: URL_UNDER_TEST,
        });
        expect(harness.calls).toHaveLength(1);
      },
    );

    it('reports a 503 as advisory_service_unavailable after the retry ladder, with the url', async () => {
      vi.useFakeTimers();
      const { harness } = makeService({
        [URL_UNDER_TEST]: () => new Response('down', { status: 503 }),
      });

      const { error } = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect((error as McpError).data).toMatchObject({
        operation: 'The FAA advisories database',
        reason: 'advisory_service_unavailable',
        url: URL_UNDER_TEST,
      });
      expect(harness.calls).toHaveLength(3);
    });

    it('reports a 429 with a long Retry-After as upstream_rate_limited immediately', async () => {
      vi.useFakeTimers();
      const { harness } = makeService({
        [URL_UNDER_TEST]: () =>
          new Response('slow', { headers: { 'retry-after': '300' }, status: 429 }),
      });

      const { error } = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      expect((error as McpError).data).toMatchObject({
        reason: 'upstream_rate_limited',
        url: URL_UNDER_TEST,
      });
      expect(harness.calls).toHaveLength(1);
    });

    it('retries an error page (no title, no text, no marker) and then reports it unavailable', async () => {
      vi.useFakeTimers();
      const { harness } = makeService({
        [URL_UNDER_TEST]: () => htmlResponse(readFixture('advisory-error.page')),
      });

      const { error } = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));

      expect((error as McpError).data).toMatchObject({ reason: 'advisory_service_unavailable' });
      expect(harness.calls).toHaveLength(3);
    });

    it('raises advisory_contract_changed for a title with no text block, without retrying', async () => {
      vi.useFakeTimers();
      const { harness } = makeService({
        [URL_UNDER_TEST]: () =>
          htmlResponse(
            page('ATCSCC&nbsp;ADVZY&nbsp;003&nbsp;SEA/ZSE&nbsp;09/30/2026&nbsp;GDP', undefined),
          ),
      });

      const { error } = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));

      expect((error as McpError).data).toMatchObject({
        reason: 'advisory_contract_changed',
        url: URL_UNDER_TEST,
      });
      expect(harness.calls).toHaveLength(1);
    });

    it('reads a page over 2 MiB as advisory_service_unavailable, with the url', async () => {
      vi.useFakeTimers();
      const { harness } = makeService({
        [URL_UNDER_TEST]: () =>
          htmlResponse(readFixture('advisory-gdp.page').padEnd(2 * 1024 * 1024 + 1)),
      });

      const { error } = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect((error as McpError).data).toMatchObject({
        reason: 'advisory_service_unavailable',
        url: URL_UNDER_TEST,
      });
      expect(harness.calls).toHaveLength(3);
    });

    it('does not cache a failure', async () => {
      vi.useFakeTimers();
      let healthy = false;
      makeService({
        [URL_UNDER_TEST]: () =>
          healthy
            ? htmlResponse(readFixture('advisory-gdp.page'))
            : new Response('x', { status: 404 }),
      });

      const failed = await settle(service.getAdvisory(3, '2026-09-30', createMockContext()));
      expect(failed.error).toBeDefined();

      healthy = true;
      await expect(
        service.getAdvisory(3, '2026-09-30', createMockContext()),
      ).resolves.toMatchObject({ found: true });
    });
  });

  describe('singleton accessor', () => {
    it('returns the instance initAdvisoryService constructed', () => {
      service = initAdvisoryService({ fetch: createFetchMock().fetch });
      expect(getAdvisoryService()).toBe(service);
    });

    it('throws an actionable error before initialisation', async () => {
      vi.resetModules();
      const fresh = await import('@/services/advisory/advisory-service.js');
      expect(() => fresh.getAdvisoryService()).toThrow(/not initialized.*initAdvisoryService/);
    });
  });
});
