/**
 * @fileoverview Tests for faa_delays_list_advisories over the real advisory index fixtures: date,
 * category, and control element normalization; paging and its truncation disclosure; the empty,
 * no-match, past-the-end, and skipped-row notices; declared service errors; and format() fidelity
 * on both client surfaces.
 * @module tests/mcp-server/tools/list-advisories.tool.test
 */

import { JsonRpcErrorCode, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdvisory } from '@/mcp-server/tools/definitions/get-advisory.tool.js';
import { listAdvisories } from '@/mcp-server/tools/definitions/list-advisories.tool.js';
import { getAdvisoryService } from '@/services/advisory/advisory-service.js';
import {
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

const INDEX = 'https://www.fly.faa.gov/adv/adv_list?whichAdvisories=ATCSCC';
const allUrl = (date: string) => `${INDEX}&advisoryCategory=All&date=${date}`;
const notAllUrl = (date: string, boxes: string) =>
  `${INDEX}&advisoryCategory=NotAll&date=${date}&${boxes}`;

const ALL_URL = allUrl('2026-10-01');
const GROUND_STOP_URL = notAllUrl(
  '2026-10-01',
  'gStop=true&_gDelay=on&_airflow=on&_ctop=on&_route=on&_other=on',
);
const GROUND_STOP_ROUTE_URL = notAllUrl(
  '2026-10-01',
  'gStop=true&_gDelay=on&_airflow=on&_ctop=on&route=true&_other=on',
);
const AFP_URL = notAllUrl(
  '2026-10-01',
  '_gStop=on&_gDelay=on&airflow=true&_ctop=on&_route=on&_other=on',
);
const EVERY_BOX_URL = notAllUrl(
  '2026-10-01',
  'gStop=true&gDelay=true&airflow=true&ctop=true&route=true&other=true',
);

const FIXTURE_PAGES: Record<string, string> = {
  [ALL_URL]: 'advisory-index-2026-10-01.page',
  [GROUND_STOP_URL]: 'advisory-index-2026-10-01-ground-stop.page',
  [GROUND_STOP_ROUTE_URL]: 'advisory-index-2026-10-01-ground-stop.page',
  [AFP_URL]: 'advisory-index-2026-10-01-airspace-flow-program.page',
  [EVERY_BOX_URL]: 'advisory-index-2026-10-01-all-categories.page',
  [allUrl('2004-06-15')]: 'advisory-index-2004-06-15.page',
  [allUrl('1999-06-15')]: 'advisory-index-none.page',
};

/** The nine ORD/ZAU advisories of the 2026-10-01 fixture, newest first. */
const ORD_ROWS = [146, 129, 124, 100, 98, 84, 81, 79, 35];

let harness: ReturnType<typeof createFetchMock>;
let services: { dispose: () => void };

function setup(pages: Record<string, () => Response | Promise<Response>>): void {
  harness = createFetchMock(Object.entries(pages).map(([match, respond]) => ({ match, respond })));
  services = installServices({ fetch: harness.fetch, now: createClock().now });
}

const fixtureRoutes = () =>
  Object.fromEntries(
    Object.entries(FIXTURE_PAGES).map(([url, file]) => [
      url,
      () => htmlResponse(readFixture(file)),
    ]),
  );

const indexPage = (rows: string) =>
  `<html><body><TABLE><tr><th class=caption colspan='5'>ATCSCC ADVISORIES FOR 2026-10-01</th></tr>${rows}</TABLE></body></html>`;
const indexRow = (link: string, element: string, title: string, sent: string) =>
  `<tr><td><a href="/adv/adv_otherdis?${link}">x</a></td><td>${element}</td><td>10/01/26</td><td>${title}</td><td>${sent}</td></tr>`;

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  setup(fixtureRoutes());
});
afterEach(() => {
  services.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const run = (input: Record<string, unknown>) => runToolContract(listAdvisories, input as never);
const structured = (result: Awaited<ReturnType<typeof run>>) =>
  result.structuredContent as Record<string, unknown> & {
    advisories: Record<string, unknown>[];
  };
const numbers = (result: Awaited<ReturnType<typeof run>>) =>
  structured(result).advisories.map((advisory) => advisory.number);
const descending = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => from - i);
const fetchedUrls = () => harness.calls.map((call) => call.request.url);

describe('input', () => {
  const parse = (input: Record<string, unknown>) => listAdvisories.input.safeParse(input);

  it('defaults limit to 50 and offset to 0, and leaves every filter unset', () => {
    expect(parse({}).data).toEqual({ limit: 50, offset: 0 });
  });

  it.each([
    ['2026-10-01', '2026-10-01'],
    ['10/01/2026', '2026-10-01'],
    ['10/1/2026', '2026-10-01'],
    ['  2004-06-15 ', '2004-06-15'],
    ['', undefined],
    ['   ', undefined],
    [null, undefined],
  ])('reads date %j as %j', (date, expected) => {
    const parsed = parse({ date });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.date).toBe(expected);
  });

  it.each([
    ['an impossible date', '2026-02-30'],
    ['a two-digit year', '10/01/26'],
    ['a far-future date', '9999-12-31'],
    ['a number', 20261001],
  ])('rejects date %s', (_label, date) => {
    expect(parse({ date }).success).toBe(false);
  });

  it.each([
    ['gs', ['ground_stop']],
    ['GS, gdp', ['ground_stop', 'ground_delay_program']],
    ['gs gdp afp', ['ground_stop', 'ground_delay_program', 'airspace_flow_program']],
    ['ground stop, route', ['ground_stop', 'route']],
    ['ground-delay-program', ['ground_delay_program']],
    [['AFP', 'airspace_flow_program', ' afp '], ['airspace_flow_program']],
    [
      ['CTOP', 'Other'],
      ['ctop', 'other'],
    ],
    ['', undefined],
    [',', undefined],
    [[], undefined],
    [null, undefined],
  ])('reads categories %j as %j', (categories, expected) => {
    const parsed = parse({ categories });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.categories).toEqual(expected);
  });

  it.each([
    ['an unknown category', ['reroute']],
    ['an unknown category in a string', 'gs, bogus'],
    ['a number', 7],
  ])('rejects categories with %s', (_label, categories) => {
    expect(parse({ categories }).success).toBe(false);
  });

  it('bounds an oversized category list to a handful of issues', () => {
    const categories = Array.from({ length: 50 }, (_, i) => `bogus_${i}`);
    const parsed = parse({ categories });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.length).toBeLessThanOrEqual(7);
  });

  it.each([
    [' kord ', 'KORD'],
    ['ord/zau', 'ORD/ZAU'],
    ['', undefined],
    ['  ', undefined],
    [null, undefined],
  ])('reads control_element %j as %j', (control_element, expected) => {
    const parsed = parse({ control_element });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.control_element).toBe(expected);
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 201', { limit: 201 }],
    ['a fractional limit', { limit: 2.5 }],
    ['a negative offset', { offset: -1 }],
    ['a control_element over 64 characters', { control_element: 'X'.repeat(65) }],
  ])('rejects %s', (_label, input) => {
    expect(parse(input).success).toBe(false);
  });

  it.each([
    ['a malformed date', { date: '2026-13-01' }],
    ['an unknown category', { categories: ['reroute'] }],
    ['limit 201', { limit: 201 }],
  ])('rejects %s on the wire as InvalidParams, before any request', async (_label, input) => {
    const result = await run(input);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(harness.calls).toHaveLength(0);
  });

  describe('today', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2004-06-15T23:30:00Z'));
    });

    it.each([
      ['omitted', {}],
      ['blank', { date: '' }],
      ['whitespace', { date: '  ' }],
    ])('reads today (UTC) when date is %s, and echoes it', async (_label, input) => {
      const result = await run(input);

      expect(result.isError).toBeFalsy();
      expect(structured(result).date).toBe('2004-06-15');
      expect(fetchedUrls()).toEqual([allUrl('2004-06-15')]);
    });

    it('accepts tomorrow (UTC), for a caller whose clock runs ahead of UTC', () => {
      expect(parse({ date: '2004-06-16' }).success).toBe(true);
    });

    it('rejects the day after tomorrow (UTC) before any request', async () => {
      const result = await run({ date: '2004-06-17' });

      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(contentText(result)).toContain('later than tomorrow');
      expect(harness.calls).toHaveLength(0);
    });
  });
});

describe('the 2026-10-01 index', () => {
  it('returns every advisory newest first from one read of the All index', async () => {
    const result = await run({ date: '2026-10-01', limit: 200 });
    const data = structured(result);

    expect(result.isError).toBeFalsy();
    expect(data.date).toBe('2026-10-01');
    expect(numbers(result)).toEqual(descending(154, 1));
    expect(data.totalCount).toBe(154);
    for (const key of ['nextOffset', 'truncated', 'shown', 'cap', 'notice']) {
      expect(data).not.toHaveProperty(key);
    }
    expect(fetchedUrls()).toEqual([ALL_URL]);
  });

  it('reads number and date from the row link and splits the brief title into subject and details', async () => {
    const advisories = structured(await run({ date: '10/01/2026', limit: 200 })).advisories;
    const row = (n: number) => advisories.find((advisory) => advisory.number === n);

    expect(row(152)).toEqual({
      controlElement: 'DCC',
      date: '2026-10-01',
      details: [
        'NAME: IAH_DOOBI_NORTH_PARTIAL',
        'CONSTRAINED AREA: ZHU',
        'VALID: ETD 011830 TO 020000',
      ],
      number: 152,
      sentAt: '2026-10-01T22:27:00Z',
      subject: 'ROUTE RQD /FL',
    });
    expect(row(148)).toEqual({
      controlElement: 'BOS/ZBW',
      date: '2026-10-01',
      number: 148,
      sentAt: '2026-10-01T22:03:00Z',
      subject: 'CDM PROPOSED GROUND DELAY PROGRAM',
    });
    expect(row(98)).toMatchObject({ controlElement: 'ORD/ZAU', number: 98 });
  });

  it("hands each row's number and date to faa_delays_get_advisory as they are", async () => {
    const [first] = structured(await run({ date: '2026-10-01', limit: 1 })).advisories;
    const parsed = getAdvisory.input.safeParse({
      advisory_number: first?.number,
      date: first?.date,
    });
    expect(parsed.data).toEqual({ advisory_number: 154, date: '2026-10-01' });
  });

  describe('paging', () => {
    it('returns 50 advisories by default and discloses the rest', async () => {
      const result = await run({ date: '2026-10-01' });
      const data = structured(result);

      expect(numbers(result)).toEqual(descending(154, 105));
      expect(data).toMatchObject({
        cap: 50,
        nextOffset: 50,
        shown: 50,
        totalCount: 154,
        truncated: true,
      });
      expect(data.notice).toBe(
        '104 more advisories match; call faa_delays_list_advisories again with offset 50 for the next page.',
      );
    });

    it('walks every page past the first with nextOffset, on one upstream read', async () => {
      const seen: unknown[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined && pages < 10) {
        const result = await run({ date: '2026-10-01', limit: 40, offset });
        seen.push(...numbers(result));
        offset = structured(result).nextOffset as number | undefined;
        pages++;
      }

      expect(pages).toBe(4);
      expect(seen).toEqual(descending(154, 1));
      expect(harness.calls).toHaveLength(1);
    });

    it('reads a middle page from its offset', async () => {
      const result = await run({ date: '2026-10-01', offset: 50 });
      expect(numbers(result)).toEqual(descending(104, 55));
      expect(structured(result)).toMatchObject({ nextOffset: 100, totalCount: 154 });
    });

    it('stops disclosing truncation on the last page', async () => {
      const result = await run({ date: '2026-10-01', offset: 150 });
      const data = structured(result);

      expect(numbers(result)).toEqual([4, 3, 2, 1]);
      expect(data.totalCount).toBe(154);
      for (const key of ['nextOffset', 'truncated', 'notice']) expect(data).not.toHaveProperty(key);
    });

    it('does not report a page that ends exactly at the last advisory as truncated', async () => {
      const data = structured(await run({ date: '2026-10-01', limit: 154 }));
      expect(data.advisories).toHaveLength(154);
      expect(data).not.toHaveProperty('nextOffset');
      expect(data).not.toHaveProperty('truncated');
    });

    it('reports the one advisory left past a full page', async () => {
      const data = structured(await run({ date: '2026-10-01', limit: 153 }));
      expect(data).toMatchObject({ nextOffset: 153, shown: 153, truncated: true });
      expect(data.notice).toBe(
        '1 more advisory matches; call faa_delays_list_advisories again with offset 153 for the next page.',
      );
    });

    it.each([154, 1000])('names offset %i as past the end', async (offset) => {
      const result = await run({ date: '2026-10-01', offset });
      const data = structured(result);

      expect(data.advisories).toEqual([]);
      expect(data.totalCount).toBe(154);
      expect(data).not.toHaveProperty('nextOffset');
      expect(data.notice).toBe(
        `offset ${offset} is past the last matching advisory (totalCount 154). Call faa_delays_list_advisories with an offset below 154, or 0 for the first page.`,
      );
      expect(contentText(result)).toContain('No advisories on this page.');
    });
  });

  it('serves repeat calls within 60 s from one read, whatever the control element, limit, and offset', async () => {
    await run({ date: '2026-10-01' });
    await run({ date: '2026-10-01', control_element: 'ORD' });
    await run({ date: '2026-10-01', limit: 5, offset: 20 });
    await run({ date: '2026-10-01', control_element: 'DCC', limit: 200 });

    expect(fetchedUrls()).toEqual([ALL_URL]);
  });
});

describe('control_element', () => {
  it.each(['ORD', 'ord', 'KORD', ' kord ', 'ZAU', 'ORD/ZAU', 'ord/zau', 'KORD/ZAU', 'kord/zau'])(
    '%j selects the nine ORD/ZAU advisories',
    async (control_element) => {
      const result = await run({ date: '2026-10-01', control_element });

      expect(numbers(result)).toEqual(ORD_ROWS);
      expect(structured(result).totalCount).toBe(9);
      expect(structured(result)).not.toHaveProperty('notice');
    },
  );

  it.each([
    ['KORD', 'ORD'],
    ['zau', 'ZAU'],
    ['ord/zau', 'ORD/ZAU'],
    ['KORD/ZAU', 'ORD/ZAU'],
    ['kewr and sats/zny', 'EWR AND SATS/ZNY'],
  ])('echoes %j as the element it matched, %j', async (control_element, applied) => {
    const result = await run({ date: '2026-10-01', control_element });
    expect(structured(result).appliedControlElement).toBe(applied);
    expect(contentText(result)).toContain(`**Control element:** ${applied}`);
  });

  it('maps every ICAO airport part of a multi-part element, past the first', async () => {
    const result = await run({ date: '2026-10-01', control_element: 'KEWR AND SATS/ZNY' });

    expect(numbers(result)).toEqual([127]);
    expect(structured(result).appliedControlElement).toBe('EWR AND SATS/ZNY');
  });

  it('names the mapped element when a pair with an ICAO part matches nothing', async () => {
    const result = await run({ date: '2026-10-01', control_element: 'KORD/ZNY' });
    const data = structured(result);

    expect(data.advisories).toEqual([]);
    expect(data.notice).toBe(
      'No advisory issued on 2026-10-01 (UTC) has control element ORD/ZNY, out of 154 read. Call faa_delays_list_advisories without control_element to list them.',
    );
    expect(contentText(result)).toContain('control element ORD/ZNY, out of 154 read');
  });

  it.each([
    ['PHLC', [154]],
    ['ZNY', 2],
    ['EWR', 1],
    ['ZMA', 3],
    ['DCC', 78],
    ['EWR AND SATS/ZNY', [127]],
  ] as const)(
    '%j matches a whole element or a part split on / or a space',
    async (control_element, expected) => {
      const result = await run({ date: '2026-10-01', control_element, limit: 200 });
      if (typeof expected === 'number') expect(numbers(result)).toHaveLength(expected);
      else expect(numbers(result)).toEqual(expected);
    },
  );

  it('does not match PHL to PHLC/ZNY, and names the call without the filter', async () => {
    const result = await run({ date: '2026-10-01', control_element: 'PHL' });
    const data = structured(result);

    expect(data.advisories).toEqual([]);
    expect(data.totalCount).toBe(0);
    expect(data.appliedControlElement).toBe('PHL');
    expect(data.notice).toBe(
      'No advisory issued on 2026-10-01 (UTC) has control element PHL, out of 154 read. Call faa_delays_list_advisories without control_element to list them.',
    );
  });

  it('never matches a row that lists no control element', async () => {
    const unfiltered = structured(await run({ date: '2004-06-15', limit: 200 })).advisories;
    const bare = unfiltered
      .filter((advisory) => advisory.controlElement === undefined)
      .map((advisory) => advisory.number);
    expect(bare).toEqual([121, 25, 11]);

    for (const control_element of ['ATL', 'ZTL', 'MDW', 'ZAU', 'DCC', 'ROUTE']) {
      const matched = numbers(await run({ date: '2004-06-15', control_element, limit: 200 }));
      expect(matched.filter((n) => bare.includes(n as number))).toEqual([]);
    }
  });
});

describe('categories', () => {
  it('reads one category table from the NotAll index', async () => {
    const result = await run({ date: '2026-10-01', categories: 'gs', limit: 200 });
    const data = structured(result);

    expect(fetchedUrls()).toEqual([GROUND_STOP_URL]);
    expect(data.advisories).toHaveLength(33);
    expect(data.totalCount).toBe(33);
    expect(data.appliedCategories).toEqual(['ground_stop']);
    expect(contentText(result)).toContain('**Categories:** ground_stop');
  });

  it('reads a category set as one cached index, whatever its order and spelling', async () => {
    await run({ date: '2026-10-01', categories: ['route', 'gs'] });
    await run({ date: '2026-10-01', categories: 'ground stop, ROUTE' });

    expect(fetchedUrls()).toEqual([GROUND_STOP_ROUTE_URL]);
  });

  it('re-sorts the category-grouped rows of every category newest first', async () => {
    const result = await run({
      date: '2026-10-01',
      categories: ['other', 'route', 'ctop', 'afp', 'gdp', 'gs'],
      limit: 200,
    });

    expect(fetchedUrls()).toEqual([EVERY_BOX_URL]);
    expect(numbers(result)).toEqual(descending(154, 1));
  });

  it('names the call without categories when a category had no advisories that day', async () => {
    const result = await run({ date: '2026-10-01', categories: ['afp'] });
    const data = structured(result);

    expect(data.advisories).toEqual([]);
    expect(data.totalCount).toBe(0);
    expect(data.notice).toBe(
      'No ATCSCC advisories in airspace_flow_program were issued on 2026-10-01 (UTC). Call faa_delays_list_advisories without categories to list every advisory issued that day.',
    );
  });

  it('names the categories read when a control element matches none of their rows', async () => {
    const data = structured(
      await run({ date: '2026-10-01', categories: 'gs', control_element: 'PHL' }),
    );
    expect(data.notice).toBe(
      'No advisory in ground_stop issued on 2026-10-01 (UTC) has control element PHL, out of 33 read. Call faa_delays_list_advisories without control_element to list them.',
    );
  });
});

describe('other dates', () => {
  it('lists the 2004-06-15 index, compression advisories included, under the link date', async () => {
    const result = await run({ date: '2004-06-15', limit: 200 });
    const advisories = structured(result).advisories;

    expect(advisories).toHaveLength(160);
    expect(new Set(advisories.map((advisory) => advisory.date))).toEqual(new Set(['2004-06-15']));
    expect(
      advisories
        .filter((advisory) => String(advisory.subject).includes('COMPRESSION'))
        .map((advisory) => [advisory.number, advisory.controlElement, advisory.subject]),
    ).toEqual([
      [158, 'ATL/ZTL', 'CDM COMPRESSION'],
      [154, 'ATL/ZTL', 'CDM PROPOSED COMPRESSION'],
      [46, 'MDW/ZAU', 'CDM COMPRESSION'],
      [45, 'MDW/ZAU', 'CDM COMPRESSION'],
    ]);
    expect(contentText(result)).toContain('- **ADVZY 121** · control element not listed · ');
  });

  it('returns no advisories and a notice when the index lists none for the date', async () => {
    const result = await run({ date: '1999-06-15' });
    const data = structured(result);

    expect(result.isError).toBeFalsy();
    expect(data).toEqual({
      advisories: [],
      date: '1999-06-15',
      notice: 'The FAA advisories database lists no ATCSCC advisories issued on 1999-06-15 (UTC).',
      totalCount: 0,
    });
    expect(contentText(result)).toContain('No advisories on this page.');
    expect(contentText(result)).toContain(
      '> The FAA advisories database lists no ATCSCC advisories issued on 1999-06-15 (UTC).',
    );
  });
});

describe('skipped rows', () => {
  beforeEach(() => {
    services.dispose();
    const page = readFixture('advisory-index-2026-10-01.page').replace('&advn=153"', '"');
    setup({ [ALL_URL]: () => htmlResponse(page) });
  });

  it('counts an unreadable row in the one combined notice, beside the paging guidance', async () => {
    const data = structured(await run({ date: '2026-10-01' }));

    expect(data.totalCount).toBe(153);
    expect(data.advisories.map((advisory) => advisory.number)).not.toContain(153);
    expect(data).toMatchObject({ nextOffset: 50, truncated: true });
    expect(data.notice).toBe(
      '1 FAA advisory index row could not be read and was skipped. 103 more advisories match; call faa_delays_list_advisories again with offset 50 for the next page.',
    );
  });

  it('reports an unreadable row on a complete page too', async () => {
    const data = structured(await run({ date: '2026-10-01', limit: 200 }));
    expect(data).not.toHaveProperty('truncated');
    expect(data.notice).toBe('1 FAA advisory index row could not be read and was skipped.');
  });

  it('joins past-the-end and skipped-row segments', async () => {
    const data = structured(await run({ date: '2026-10-01', offset: 500 }));
    expect(data.notice).toBe(
      'offset 500 is past the last matching advisory (totalCount 153). Call faa_delays_list_advisories with an offset below 153, or 0 for the first page. 1 FAA advisory index row could not be read and was skipped.',
    );
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
      label: 'the HTTP 200 error page',
      reason: 'advisory_service_unavailable',
      respond: () => htmlResponse(readFixture('advisory-index-error.page')),
    },
    {
      code: JsonRpcErrorCode.SerializationError,
      label: 'HTTP 404',
      reason: 'advisory_contract_changed',
      respond: () => new Response('gone', { status: 404 }),
    },
    {
      code: JsonRpcErrorCode.SerializationError,
      label: 'a caption with no readable row',
      reason: 'advisory_contract_changed',
      respond: () =>
        htmlResponse(indexPage('<tr><th class=header>NUMBER</th><th class=header>DATE</th></tr>')),
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
    setup({ [ALL_URL]: respond as never });

    const result = await withLadder(() => run({ date: '2026-10-01' }));

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(code);
    expect(error.data?.reason).toBe(reason);
    const declared = listAdvisories.errors?.find((entry) => entry.reason === reason);
    expect(declared?.recovery).toContain('faa_delays_list_advisories');
    expect(recoveryHint(error)).toBe(declared?.recovery);
    expect(contentText(result)).toContain(`reason ${reason}`);
  });

  it('exposes the server-built index url on advisory_contract_changed', async () => {
    services.dispose();
    setup({ [GROUND_STOP_URL]: () => new Response('gone', { status: 404 }) });

    const result = await withLadder(() => run({ date: '2026-10-01', categories: 'gs' }));

    expect(errorOf(result).data?.url).toBe(GROUND_STOP_URL);
  });

  it('carries pacer_shed with retryAfter', async () => {
    vi.spyOn(getAdvisoryService(), 'listAdvisories').mockRejectedValue(
      rateLimited('queue full', { reason: 'pacer_shed', retryAfter: 6 }),
    );

    const result = await run({ date: '2026-10-01' });

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryAfter: 6 },
    });
    expect(recoveryHint(errorOf(result))).toContain('call faa_delays_list_advisories again');
  });

  it('reports a cancelled caller as RequestCancelled', async () => {
    vi.useRealTimers();
    services.dispose();
    setup({ [ALL_URL]: hangUntilAborted as never });
    const controller = new AbortController();

    const pending = runToolContract(
      listAdvisories,
      { date: '2026-10-01' },
      { context: { signal: controller.signal } },
    );
    controller.abort(new Error('client cancelled'));

    expect(errorOf(await pending).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('format', () => {
  it('carries the same page on both surfaces', async () => {
    const result = await run({ date: '2026-10-01', limit: 3 });

    expect(result.structuredContent).toEqual({
      advisories: [
        {
          controlElement: 'PHLC/ZNY',
          date: '2026-10-01',
          number: 154,
          sentAt: '2026-10-01T22:42:00Z',
          subject: 'EWR AND SATELLITE AIRPORTS ARRIVAL DELAYS',
        },
        {
          controlElement: 'BOS/ZBW',
          date: '2026-10-01',
          number: 153,
          sentAt: '2026-10-01T22:30:00Z',
          subject: 'CDM GROUND DELAY PROGRAM',
        },
        {
          controlElement: 'DCC',
          date: '2026-10-01',
          details: [
            'NAME: IAH_DOOBI_NORTH_PARTIAL',
            'CONSTRAINED AREA: ZHU',
            'VALID: ETD 011830 TO 020000',
          ],
          number: 152,
          sentAt: '2026-10-01T22:27:00Z',
          subject: 'ROUTE RQD /FL',
        },
      ],
      cap: 3,
      date: '2026-10-01',
      nextOffset: 3,
      notice:
        '151 more advisories match; call faa_delays_list_advisories again with offset 3 for the next page.',
      shown: 3,
      totalCount: 154,
      truncated: true,
    });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: [
        '## ATCSCC advisories · 2026-10-01',
        '',
        '- **ADVZY 154** · PHLC/ZNY · EWR AND SATELLITE AIRPORTS ARRIVAL DELAYS · sent 2026-10-01T22:42:00Z',
        '- **ADVZY 153** · BOS/ZBW · CDM GROUND DELAY PROGRAM · sent 2026-10-01T22:30:00Z',
        '- **ADVZY 152** · DCC · ROUTE RQD /FL · sent 2026-10-01T22:27:00Z',
        '  - Details: NAME: IAH_DOOBI_NORTH_PARTIAL · CONSTRAINED AREA: ZHU · VALID: ETD 011830 TO 020000',
        '',
        '**Next offset:** 3',
      ].join('\n'),
    });
    const text = contentText(result);
    expect(text).toContain('**154 total**');
    expect(text).toContain(
      '> 151 more advisories match; call faa_delays_list_advisories again with offset 3 for the next page.',
    );
  });

  it('names a missing control element, leaves out other missing fields, and shows a row date that differs', async () => {
    services.dispose();
    setup({
      [ALL_URL]: () =>
        htmlResponse(
          indexPage(
            indexRow('adv_date=10012026&advn=7', '', '', '') +
              indexRow(
                'adv_date=09302026&advn=999',
                'SEA/ZSE',
                'CDM GROUND STOP',
                '09/30/26 23:59',
              ),
          ),
        ),
    });

    const result = await run({ date: '2026-10-01' });

    expect(structured(result).advisories).toEqual([
      {
        controlElement: 'SEA/ZSE',
        date: '2026-09-30',
        number: 999,
        sentAt: '2026-09-30T23:59:00Z',
        subject: 'CDM GROUND STOP',
      },
      { date: '2026-10-01', number: 7 },
    ]);
    expect(result.content[0]).toMatchObject({
      text: [
        '## ATCSCC advisories · 2026-10-01',
        '',
        '- **ADVZY 999** · 2026-09-30 · SEA/ZSE · CDM GROUND STOP · sent 2026-09-30T23:59:00Z',
        '- **ADVZY 7** · control element not listed',
      ].join('\n'),
    });
  });

  it('renders link, HTML, and block syntax in FAA text as inert text, keeping it verbatim in structuredContent', async () => {
    services.dispose();
    setup({
      [ALL_URL]: () =>
        htmlResponse(
          indexPage(
            indexRow(
              'adv_date=10012026&advn=5',
              'ORD/ZAU',
              '[click](https://e.test) &lt;b&gt;bold&lt;/b&gt;<BR>```js<BR># heading',
              '10/01/26 12:00',
            ),
          ),
        ),
    });

    const result = await run({ date: '2026-10-01' });
    const [advisory] = structured(result).advisories;

    expect(advisory).toMatchObject({
      details: ['```js', '# heading'],
      subject: '[click](https://e.test) <b>bold</b>',
    });
    const lines = (result.content[0] as { text: string }).text.split('\n');
    expect(lines[2]).toBe(
      '- **ADVZY 5** · ORD/ZAU · \\[click\\](https://e.test) \\<b\\>bold\\</b\\> · sent 2026-10-01T12:00:00Z',
    );
    expect(lines[3]).toBe('  - Details: ```js · # heading');
  });
});
