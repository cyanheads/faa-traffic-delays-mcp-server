/**
 * @fileoverview Tests for AdvisoryService, parseAdvisoryPage, and parseAdvisoryIndex over
 * captured-shape advisory and index pages: field extraction, entity decoding, the miss /
 * layout-change / error-page outcomes, the 6 h and 60 s caches, fetch failure classes, and parse
 * time that grows linearly on hostile markup.
 * @module tests/services/advisory/advisory-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AdvisoryIndexRow,
  AdvisoryService,
  decodeEntities,
  getAdvisoryService,
  initAdvisoryService,
  parseAdvisoryIndex,
  parseAdvisoryPage,
} from '@/services/advisory/advisory-service.js';
import { advisoryUrl, createClock, htmlResponse, readFixture } from '../../helpers/faa-fakes.js';

const URL_UNDER_TEST = 'https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=09302026';

const INDEX = 'https://www.fly.faa.gov/adv/adv_list?whichAdvisories=ATCSCC';
const INDEX_URL = `${INDEX}&advisoryCategory=All&date=2026-10-01`;

const INDEX_HEAD =
  `<tr valign="top"><th class=caption colspan='5'>ATCSCC ADVISORIES FOR 2026-10-01</th></tr>` +
  '<tr valign="top"><th class=header>NUMBER</th><th class=header>CONTROL<BR>ELEMENT</th>' +
  '<th class=header>DATE</th><th class=header>BRIEF TITLE</th><th class=header>SEND TIME</th></tr>';

/** An index page whose result table holds `rows` after its caption and column-header rows. */
const indexPage = (rows: string): string =>
  `<html><body><TABLE border="1">${INDEX_HEAD}${rows}</TABLE></body></html>`;

/** One index row: the NUMBER link's query, then CONTROL ELEMENT, BRIEF TITLE, and SEND TIME. */
const indexRow = (query: string, element: string, title: string, sent: string): string =>
  `<tr><td><a href="/adv/adv_otherdis?${query}">x</a></td><td>${element}</td><td>10/01/26</td><td>${title}</td><td>${sent}</td></tr>`;

const page = (title: string | undefined, pre: string | undefined, extra = ''): string =>
  `<html><body><TABLE>${
    title === undefined ? '' : `<TR><TH class=header colspan=2>${title}</TH></TR>`
  }${pre === undefined ? '' : `<TR><TD class=val><PRE>${pre}</PRE></TD></TR>`}${extra}</TABLE></body></html>`;

const GDP_TEXT = [
  'CTL ELEMENT: SEA',
  'ELEMENT TYPE: APT',
  'ADL TIME: 0015Z',
  'DELAY ASSIGNMENT MODE: UDP',
  'ARRIVALS ESTIMATED FOR: 30/0100Z - 30/0559Z',
  'CUMULATIVE PROGRAM PERIOD: 30/0100Z - 30/0559Z',
  'PROGRAM RATE: 38/36/36/36/36',
  'FLT INCL: ALL CONTIGUOUS US DEP',
  'DEP SCOPE: 1200',
  'CANADIAN DEP ARPTS INCLUDED: CYEG CYVR CYYC CYYJ CYLW',
  'DELAY ASSIGNMENT TABLE APPLIES TO: ZSE',
  'MAXIMUM DELAY: 117',
  'AVERAGE DELAY: 55',
  'IMPACTING CONDITION: WEATHER / LOW CEILINGS',
  'COMMENTS: NORTH FLOW, PLAN CHARLIE. LOW POP UP. TIME+20 DUE TO TIME',
  ' CONSTRAINTS TO AVOID GROUND STOP POSTURE.',
].join('\n');

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('reads every field of a labelled-cell page exactly', () => {
    expect(parseAdvisoryPage(readFixture('advisory-gdp.page'), URL_UNDER_TEST)).toEqual({
      controlElement: 'SEA/ZSE',
      effectiveTime: '300016-300659',
      found: true,
      sentAt: '26/09/30 00:17',
      subject: 'CDM GROUND DELAY PROGRAM',
      text: GDP_TEXT,
      title: 'ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND DELAY PROGRAM',
    });
  });

  it('trims the literal trailing &nbsp; the FAA appends to the text block', () => {
    const result = parseAdvisoryPage(readFixture('advisory-gdp.page'), URL_UNDER_TEST);
    expect(result.text?.endsWith('POSTURE.')).toBe(true);
  });

  it('reads an operations plan: effective time and signature from its trailing lines', () => {
    const result = parseAdvisoryPage(readFixture('advisory-ops-plan.page'), URL_UNDER_TEST);

    expect(result).toMatchObject({
      controlElement: 'DCC',
      effectiveTime: '292353-301159',
      found: true,
      sentAt: '26/09/29 23:53',
      subject: 'OPERATIONS PLAN',
      title: 'ATCSCC ADVZY 082 DCC 09/29/2026 OPERATIONS PLAN',
    });
    expect(result.text).toContain('TERMINAL PLANNED:');
    expect(result.text?.endsWith('292353-301159\n26/09/29 23:53  DCCOPS.lxstn35')).toBe(true);
  });

  describe('raw-text layout: effective time and signature on the last lines', () => {
    const OPS_TITLE = 'ATCSCC ADVZY 144 DCC 10/01/2026 OPERATIONS PLAN';

    it('reads a required reroute (ROUTE RQD)', () => {
      expect(
        parseAdvisoryPage(readFixture('advisory-route-rqd.page'), URL_UNDER_TEST),
      ).toMatchObject({
        controlElement: 'DCC',
        effectiveTime: '012227-020000',
        sentAt: '26/10/01 22:27',
        subject: 'ROUTE RQD /FL',
        title: 'ATCSCC ADVZY 152 DCC 10/01/2026 ROUTE RQD /FL',
      });
    });

    it('skips the blank line between the effective time and the signature', () => {
      const result = parseAdvisoryPage(readFixture('advisory-ops-plan-2004.page'), URL_UNDER_TEST);

      expect(result).toMatchObject({
        effectiveTime: '152346-160559',
        sentAt: '04/06/15 23:44',
        title: 'ATCSCC ADVZY 155 DCC 06/15/2004 OPERATIONS PLAN',
      });
      expect(result.text?.endsWith('152346-160559\n\n04/06/15 23:44   FSA.//lxstn08a')).toBe(true);
    });

    it.each([
      [
        'a signature without an operator ID',
        'BODY\n012131-012359\n26/10/01 21:31',
        '012131-012359',
        '26/10/01 21:31',
      ],
      ['an effective time as the last line', 'BODY\n012131-012359', '012131-012359', undefined],
      [
        'a signature with no effective time',
        'BODY\n26/10/01 21:31  OP.x',
        undefined,
        '26/10/01 21:31',
      ],
      [
        'CRLF line ends and blank lines between and after',
        'BODY\r\n012131-012359\r\n \r\n26/10/01 21:31  OP\r\n\r\n',
        '012131-012359',
        '26/10/01 21:31',
      ],
    ])('reads %s', (_label, text, effectiveTime, sentAt) => {
      const result = parseAdvisoryPage(page(OPS_TITLE, text), URL_UNDER_TEST);
      expect(result.effectiveTime).toBe(effectiveTime);
      expect(result.sentAt).toBe(sentAt);
    });

    it.each([
      ['lines matching neither pattern', 'BODY\nNEXT PLANNING WEBINAR: 2315Z\nEND'],
      ['an effective time three lines up', 'BODY\n012131-012359\nA\nB'],
      ['an effective time with other text on its line', 'BODY\nEFF 012131-012359\nX'],
      ['a signature not on the last line', 'BODY\n26/10/01 21:31  OP\nEND'],
      ['a signature run into its operator ID', 'BODY\n26/10/01 21:31OP'],
    ])('leaves both times absent for %s', (_label, text) => {
      const result = parseAdvisoryPage(page(OPS_TITLE, text), URL_UNDER_TEST);
      expect(result).not.toHaveProperty('effectiveTime');
      expect(result).not.toHaveProperty('sentAt');
    });

    it('never lets a trailing line override a labelled cell', () => {
      const cells =
        '<TR><TD class=nam>EFFECTIVE TIME:</TD><TD class=val>300016-300659</TD></TR><TR><TD class=nam>SIGNATURE:</TD><TD class=val>26/09/30 00:17&nbsp;</TD></TR>';
      const result = parseAdvisoryPage(
        page(OPS_TITLE, 'BODY\n012131-012359\n26/10/01 21:31  OP', cells),
        URL_UNDER_TEST,
      );

      expect(result).toMatchObject({ effectiveTime: '300016-300659', sentAt: '26/09/30 00:17' });
    });

    it('fills only the field whose cell is missing', () => {
      const cells = '<TR><TD class=nam>EFFECTIVE TIME:</TD><TD class=val>300016-300659</TD></TR>';
      const result = parseAdvisoryPage(
        page(OPS_TITLE, 'BODY\n012131-012359\n26/10/01 21:31  OP', cells),
        URL_UNDER_TEST,
      );

      expect(result).toMatchObject({ effectiveTime: '300016-300659', sentAt: '26/10/01 21:31' });
    });
  });

  describe('title split', () => {
    it('reads a control element that holds spaces', () => {
      const result = parseAdvisoryPage(
        page(
          'ATCSCC&nbsp;ADVZY&nbsp;127&nbsp;EWR AND SATS/ZNY&nbsp;10/01/2026&nbsp;EWR AND SATS AIRPORT ARRIVAL DELAYS',
          'TEXT',
        ),
        URL_UNDER_TEST,
      );

      expect(result).toMatchObject({
        controlElement: 'EWR AND SATS/ZNY',
        subject: 'EWR AND SATS AIRPORT ARRIVAL DELAYS',
        title: 'ATCSCC ADVZY 127 EWR AND SATS/ZNY 10/01/2026 EWR AND SATS AIRPORT ARRIVAL DELAYS',
      });
    });

    it('ends the control element at the first date', () => {
      expect(
        parseAdvisoryPage(
          page('ATCSCC ADVZY 5 DCC 10/01/2026 MEETING 10/02/2026 RECAP', 'T'),
          URL_UNDER_TEST,
        ),
      ).toMatchObject({ controlElement: 'DCC', subject: 'MEETING 10/02/2026 RECAP' });
    });

    it.each([
      [
        'SEA/ZSE',
        'ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND DELAY PROGRAM',
        'CDM GROUND DELAY PROGRAM',
      ],
      ['DCC', 'ATCSCC ADVZY 082 DCC 09/29/2026 OPERATIONS PLAN', 'OPERATIONS PLAN'],
    ])('reads the single-token element %s as before', (element, title, subject) => {
      expect(parseAdvisoryPage(page(title, 'T'), URL_UNDER_TEST)).toMatchObject({
        controlElement: element,
        subject,
      });
    });

    it.each([
      ['no control element', 'ATCSCC ADVZY 127 10/01/2026 EWR AIRPORT ARRIVAL DELAYS'],
      ['an ISO date', 'ATCSCC ADVZY 127 EWR AND SATS/ZNY 2026-10-01 ARRIVAL DELAYS'],
      ['no subject after the date', 'ATCSCC ADVZY 127 EWR AND SATS/ZNY 10/01/2026'],
      ['no advisory number', 'ATCSCC ADVZY EWR AND SATS/ZNY 10/01/2026 ARRIVAL DELAYS'],
    ])('leaves control element and subject absent for a title with %s', (_label, title) => {
      const result = parseAdvisoryPage(page(title, 'T'), URL_UNDER_TEST);
      expect(result).not.toHaveProperty('controlElement');
      expect(result).not.toHaveProperty('subject');
    });
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

describe('parseAdvisoryIndex', () => {
  const read = (fixture: string) => parseAdvisoryIndex(readFixture(fixture), INDEX_URL);
  const numbers = (rows: AdvisoryIndexRow[]): number[] => rows.map((row) => row.number);
  const rowNumbered = (rows: AdvisoryIndexRow[], number: number) =>
    rows.find((row) => row.number === number);

  /** The error a parse throws, for asserting its code and data. */
  function parseError(html: string): McpError {
    try {
      parseAdvisoryIndex(html, INDEX_URL);
    } catch (error) {
      if (error instanceof McpError) return error;
      throw error;
    }
    throw new Error('Expected parseAdvisoryIndex to throw.');
  }

  describe('the 2026-10-01 index', () => {
    it('reads all 154 advisories under the link date, numbered 154 down to 1, none skipped', () => {
      const { rows, skippedRows } = read('advisory-index-2026-10-01.page');

      expect(skippedRows).toBe(0);
      expect(numbers(rows)).toEqual(Array.from({ length: 154 }, (_, i) => 154 - i));
      expect(new Set(rows.map((row) => row.date))).toEqual(new Set(['2026-10-01']));
    });

    it("splits a reroute's brief title into its subject and detail lines and reads the send time as ISO 8601", () => {
      expect(rowNumbered(read('advisory-index-2026-10-01.page').rows, 152)).toEqual({
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
    });

    it.each([
      [
        148,
        {
          controlElement: 'BOS/ZBW',
          date: '2026-10-01',
          number: 148,
          sentAt: '2026-10-01T22:03:00Z',
          subject: 'CDM PROPOSED GROUND DELAY PROGRAM',
        },
      ],
      [
        127,
        {
          controlElement: 'EWR AND SATS/ZNY',
          date: '2026-10-01',
          number: 127,
          sentAt: '2026-10-01T20:30:00Z',
          subject: 'EWR AND SATS AIRPORT ARRIVAL DELAYS',
        },
      ],
    ])('reads row %i, whose brief title carries no prefix, as it is', (number, expected) => {
      expect(rowNumbered(read('advisory-index-2026-10-01.page').rows, number)).toEqual(expected);
    });

    it("reads the number from the link's advn, not the zero-padded link text", () => {
      const html = readFixture('advisory-index-2026-10-01.page');
      expect(html).toContain('advn=98">098</a>');

      expect(rowNumbered(parseAdvisoryIndex(html, INDEX_URL).rows, 98)).toMatchObject({
        controlElement: 'ORD/ZAU',
        number: 98,
      });
      expect(
        parseAdvisoryIndex(
          indexPage(indexRow('advn=098&adv_date=10012026', 'DCC', 'X', '')),
          INDEX_URL,
        ).rows[0]?.number,
      ).toBe(98);
    });
  });

  describe('the 2026-10-01 category pages', () => {
    const CATEGORY_COUNTS = {
      'airspace-flow-program': 0,
      ctop: 0,
      'ground-delay-program': 26,
      'ground-stop': 33,
      other: 72,
      route: 23,
    };

    it('are disjoint, and their union is the full index row for row', () => {
      const full = read('advisory-index-2026-10-01.page').rows;
      const seen = new Map<number, string>();

      for (const [category, count] of Object.entries(CATEGORY_COUNTS)) {
        const { rows, skippedRows } = read(`advisory-index-2026-10-01-${category}.page`);
        expect([category, rows.length, skippedRows]).toEqual([category, count, 0]);
        for (const row of rows) {
          expect(seen.get(row.number), `advisory ${row.number}`).toBeUndefined();
          seen.set(row.number, category);
          expect(row).toEqual(rowNumbered(full, row.number));
        }
      }
      expect(seen.size).toBe(full.length);
    });

    it('re-sorts the category-grouped page of every category newest first, reading every table', () => {
      const html = readFixture('advisory-index-2026-10-01-all-categories.page');
      // Grouped by category table: ground stops (140 first) precede the later GDP advisories.
      expect(/advn=(\d+)/.exec(html)?.[1]).toBe('140');
      expect(html.match(/class=caption/g)).toHaveLength(6);

      expect(parseAdvisoryIndex(html, INDEX_URL)).toEqual(read('advisory-index-2026-10-01.page'));
    });
  });

  describe('the 2004-06-15 index', () => {
    it('reads 160 rows under the link date, including those whose DATE column reads 06/14/04', () => {
      const html = readFixture('advisory-index-2004-06-15.page');
      const { rows, skippedRows } = parseAdvisoryIndex(html, INDEX_URL);

      expect([rows.length, skippedRows]).toEqual([160, 0]);
      expect(new Set(rows.map((row) => row.date))).toEqual(new Set(['2004-06-15']));
      expect(html.match(/<td>06\/14\/04<\/td>/g)).toHaveLength(2);
      expect([rowNumbered(rows, 1), rowNumbered(rows, 10)]).toEqual([
        {
          controlElement: 'TEB/ZDC',
          date: '2004-06-15',
          number: 1,
          sentAt: '2004-06-15T00:03:00Z',
          subject: 'GROUND STOP',
        },
        {
          controlElement: 'DCC',
          date: '2004-06-15',
          number: 10,
          sentAt: '2004-06-15T01:07:00Z',
          subject: 'CLE ARRIVALS_FYI',
        },
      ]);
    });

    it('lists the CDM compression advisories, which the FAA files under no category', () => {
      const { rows } = read('advisory-index-2004-06-15.page');

      expect(
        [45, 46, 154, 158].map((number) => {
          const row = rowNumbered(rows, number);
          return [number, row?.controlElement, row?.subject];
        }),
      ).toEqual([
        [45, 'MDW/ZAU', 'CDM COMPRESSION'],
        [46, 'MDW/ZAU', 'CDM COMPRESSION'],
        [154, 'ATL/ZTL', 'CDM PROPOSED COMPRESSION'],
        [158, 'ATL/ZTL', 'CDM COMPRESSION'],
      ]);
    });

    it('leaves controlElement out of the rows whose element cell is empty (11, 25, 121)', () => {
      const { rows } = read('advisory-index-2004-06-15.page');

      expect(rows.filter((row) => row.controlElement === undefined)).toEqual([
        {
          date: '2004-06-15',
          number: 121,
          sentAt: '2004-06-15T21:07:00Z',
          subject: 'ROUTE UPDATE',
        },
        {
          date: '2004-06-15',
          number: 25,
          sentAt: '2004-06-15T10:58:00Z',
          subject: 'SCHEDULED FACILITY OUTAGES.',
        },
        {
          date: '2004-06-15',
          number: 11,
          sentAt: '2004-06-15T01:14:00Z',
          subject: 'SCHEDULED FACILITY OUTAGES.',
        },
      ]);
    });
  });

  describe('row cells', () => {
    it('strips the ATCSCC ADVZY prefix whose control element holds spaces, with a 2- or 4-digit year', () => {
      const { rows } = parseAdvisoryIndex(
        indexPage(
          indexRow(
            'advn=127&adv_date=10012026',
            'EWR AND SATS/ZNY',
            'ATCSCC&nbsp;ADVZY&nbsp;127&nbsp;EWR AND SATS/ZNY&nbsp;10/01/26&nbsp;EWR AND SATS AIRPORT ARRIVAL DELAYS',
            '',
          ) +
            indexRow(
              'advn=126&adv_date=10012026',
              'DCC',
              'ATCSCC ADVZY 126 DCC 10/01/2026 OPERATIONS PLAN',
              '',
            ),
        ),
        INDEX_URL,
      );

      expect(rows.map((row) => row.subject)).toEqual([
        'EWR AND SATS AIRPORT ARRIVAL DELAYS',
        'OPERATIONS PLAN',
      ]);
    });

    it('keeps a first line in another form whole as the subject', () => {
      const { rows } = parseAdvisoryIndex(
        indexPage(
          indexRow('advn=5&adv_date=10012026', 'DCC', 'ATCSCC ADVZY 5 DCC NO DATE HERE', ''),
        ),
        INDEX_URL,
      );
      expect(rows[0]?.subject).toBe('ATCSCC ADVZY 5 DCC NO DATE HERE');
    });

    it('splits detail lines on every BR spelling and drops blank ones', () => {
      const { rows } = parseAdvisoryIndex(
        indexPage(indexRow('advn=5&adv_date=10012026', 'DCC', 'A<BR><br/>B<Br />&nbsp;<bR>C', '')),
        INDEX_URL,
      );
      expect(rows[0]).toMatchObject({ details: ['B', 'C'], subject: 'A' });
    });

    it('drops markup nested in a cell and decodes its entities', () => {
      const { rows } = parseAdvisoryIndex(
        indexPage(
          indexRow(
            'advn=5&amp;adv_date=10012026',
            '<b><font color=red>PHL&#47;ZNY</font></b>',
            '<i><b>ARRIVAL&nbsp;&amp;&nbsp;DEPARTURE</b></i> DELAYS',
            '<span>10/01/26 22:42</span>',
          ),
        ),
        INDEX_URL,
      );
      expect(rows).toEqual([
        {
          controlElement: 'PHL/ZNY',
          date: '2026-10-01',
          number: 5,
          sentAt: '2026-10-01T22:42:00Z',
          subject: 'ARRIVAL & DEPARTURE DELAYS',
        },
      ]);
    });

    it.each([
      ['an empty cell', ''],
      ['a date with no time', '10/01/26'],
      ['February 30', '02/30/26 10:00'],
      ['hour 24', '10/01/26 24:00'],
      ['minute 60', '10/01/26 10:60'],
      ['a four-digit year', '10/01/2026 10:00'],
    ])('leaves sentAt out for %s', (_label, sent) => {
      const { rows } = parseAdvisoryIndex(
        indexPage(indexRow('advn=5&adv_date=10012026', 'DCC', 'X', sent)),
        INDEX_URL,
      );
      expect(rows[0]).toEqual({
        controlElement: 'DCC',
        date: '2026-10-01',
        number: 5,
        subject: 'X',
      });
    });

    it('reads a send time in the century nearest the advisory date', () => {
      const { rows } = parseAdvisoryIndex(
        indexPage(
          indexRow('advn=2&adv_date=01012000', 'DCC', 'X', '01/01/00 00:05') +
            indexRow('advn=1&adv_date=01012000', 'DCC', 'X', '12/31/99 23:59'),
        ),
        INDEX_URL,
      );
      expect(rows.map((row) => row.sentAt)).toEqual([
        '2000-01-01T00:05:00Z',
        '1999-12-31T23:59:00Z',
      ]);
    });

    it('reads only number and date from a row whose other cells are empty or missing', () => {
      const { rows } = parseAdvisoryIndex(
        indexPage(
          '<tr><td><a href="/adv/adv_otherdis?advn=7&adv_date=10012026">7</a></td></tr>' +
            indexRow('advn=6&adv_date=10012026', ' ', '&nbsp;<BR> ', ' '),
        ),
        INDEX_URL,
      );
      expect(rows).toEqual([
        { date: '2026-10-01', number: 7 },
        { date: '2026-10-01', number: 6 },
      ]);
    });
  });

  describe('outcomes', () => {
    it('reads the no-match page as no rows and none skipped', () => {
      expect(read('advisory-index-none.page')).toEqual({ rows: [], skippedRows: 0 });
    });

    it('raises advisory_service_unavailable, with the url, for the HTTP 200 error page', () => {
      const error = parseError(readFixture('advisory-index-error.page'));

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toMatch(/neither an advisory index nor its no-match notice/);
      expect(error.data).toMatchObject({ reason: 'advisory_service_unavailable', url: INDEX_URL });
    });

    it('raises advisory_contract_changed, with the url, for a caption with no row', () => {
      const error = parseError(indexPage(''));

      expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
      expect(error.data).toMatchObject({
        reason: 'advisory_contract_changed',
        retryable: false,
        url: INDEX_URL,
      });
    });

    it('raises advisory_contract_changed when every row is unreadable, even beside a no-match notice', () => {
      const error = parseError(
        indexPage(
          `${indexRow('adv_date=10012026', 'DCC', 'X', '')}<tr><th class=warning>NO ADVISORIES MATCH YOUR SELECTION CRITERIA!</th></tr>`,
        ),
      );
      expect(error.data).toMatchObject({ reason: 'advisory_contract_changed' });
    });

    it('skips and counts each row whose link carries no advisory number in 1–999, keeping the rest', () => {
      const { rows, skippedRows } = parseAdvisoryIndex(
        indexPage(
          indexRow('advn=4&adv_date=10012026', 'DCC', 'FOUR', '') +
            indexRow('adv_date=10012026', 'DCC', 'NO NUMBER', '') +
            indexRow('advn=1000&adv_date=10012026', 'DCC', 'OUT OF RANGE', '') +
            indexRow('advn=9&adv_date=1001', 'DCC', 'SHORT DATE', '') +
            indexRow('advn=5&adv_date=10012026', 'DCC', 'FIVE', ''),
        ),
        INDEX_URL,
      );

      expect([numbers(rows), skippedRows]).toEqual([[5, 4], 3]);
    });

    it.each([
      [
        'an advn only in the link text',
        '<tr><td><a href="/adv/adv_otherdis?adv_date=10012026">?advn=5&amp;</a></td><td>DCC</td></tr>',
      ],
      [
        'an advn only in another attribute',
        '<tr><td><a title="?advn=5&amp;" href="/adv/adv_otherdis?adv_date=10012026">x</a></td><td>DCC</td></tr>',
      ],
      ['an advn that runs into letters', indexRow('adv_date=10012026&advn=5abc', 'DCC', 'X', '')],
      ['an adv_date naming month 13 day 45', indexRow('advn=5&adv_date=13452026', 'DCC', 'X', '')],
      ['an adv_date naming February 30', indexRow('advn=5&adv_date=02302026', 'DCC', 'X', '')],
    ])('skips and counts a row with %s', (_label, row) => {
      const { rows, skippedRows } = parseAdvisoryIndex(
        indexPage(indexRow('advn=4&adv_date=10012026', 'DCC', 'FOUR', '') + row),
        INDEX_URL,
      );
      expect([numbers(rows), skippedRows]).toEqual([[4], 1]);
    });

    it.each([
      ['single-quoted', "<a href='/adv/adv_otherdis?advn=5&adv_date=10012026'>x</a>"],
      ['unquoted', '<a href=/adv/adv_otherdis?advn=5&amp;adv_date=10012026>x</a>'],
      ['uppercase', '<A HREF="/adv/adv_otherdis?adv_date=10012026&amp;advn=5">005</A>'],
      ['spaced', '<a class=x href = "/adv/adv_otherdis?adv_date=10012026&advn=5">x</a>'],
    ])('reads the number and date from a %s href', (_label, link) => {
      const { rows } = parseAdvisoryIndex(
        indexPage(`<tr><td>${link}</td><td>DCC</td></tr>`),
        INDEX_URL,
      );
      expect(rows).toEqual([{ controlElement: 'DCC', date: '2026-10-01', number: 5 }]);
    });

    describe('end tags HTML lets a page leave out or space', () => {
      const rows = [
        indexRow('advn=3&adv_date=10012026', 'AAA/ZAU', 'THREE', '10/01/26 12:03'),
        indexRow('advn=2&adv_date=10012026', 'BBB/ZNY', 'TWO', '10/01/26 12:02'),
        indexRow('advn=1&adv_date=10012026', 'CCC/ZBW', 'ONE', '10/01/26 12:01'),
      ];
      const expected = parseAdvisoryIndex(indexPage(rows.join('')), INDEX_URL);

      it('reads all three rows of the baseline, every field present', () => {
        expect(numbers(expected.rows)).toEqual([3, 2, 1]);
        expect(expected.rows.every((row) => row.controlElement && row.subject && row.sentAt)).toBe(
          true,
        );
      });

      it.each([
        ['row end tags with a space', rows.map((row) => row.replace('</tr>', '</tr >'))],
        ['cell end tags with a space', rows.map((row) => row.replaceAll('</td>', '</TD >'))],
        ['no row end tags', rows.map((row) => row.replace('</tr>', ''))],
        ['no cell end tags', rows.map((row) => row.replaceAll('</td>', ''))],
        [
          'one unclosed row in the middle',
          rows.map((row, i) => (i === 1 ? row.replace('</tr>', '') : row)),
        ],
      ])('reads every row and cell with %s', (_label, variant) => {
        expect(parseAdvisoryIndex(indexPage(variant.join('')), INDEX_URL)).toEqual(expected);
      });
    });

    it.each([
      ['an advisory row', indexRow('advn=4&adv_date=10012026', 'DCC', 'IN GROUND STOPS', '')],
      [
        'only the no-match notice',
        '<tr><th class=warning>NO ADVISORIES MATCH YOUR SELECTION CRITERIA!</th></tr>',
      ],
    ])(
      'raises advisory_contract_changed for a category table with neither rows nor the no-match notice, beside one holding %s',
      (_label, firstTable) => {
        const html = indexPage(
          `${firstTable}<tr><th class=caption colspan='5'>ROUTE ADVISORIES</th></tr><tr><th class=header>NUMBER</th></tr>`,
        );
        expect(parseError(html).data).toMatchObject({ reason: 'advisory_contract_changed' });
      },
    );

    it('reads only the table its first caption opens', () => {
      const html = indexPage(
        indexRow('advn=4&adv_date=10012026', 'DCC', 'IN THE INDEX', ''),
      ).replace(
        '</body>',
        `<TABLE>${indexRow('advn=8&adv_date=10012026', 'DCC', 'AFTER THE INDEX', '')}</TABLE></body>`,
      );
      expect(numbers(parseAdvisoryIndex(html, INDEX_URL).rows)).toEqual([4]);
    });
  });
});

describe('parse time grows linearly with input size', () => {
  const SIZES = [5_000, 20_000, 80_000] as const;
  const ROUNDS = 21;
  /** Slowest acceptable fastest-call time at 80k characters; the slowest case takes about 1.5 ms. */
  const MAX_80K_MS = 100;
  const LINK = '<a href="/adv/adv_otherdis?adv_date=10012026&advn=5">005</a>';

  const fill = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length));
  const attempt = (run: () => unknown): unknown => {
    try {
      return run();
    } catch (error) {
      return error;
    }
  };

  /**
   * Times `parse` on the input `build` makes at 5k, 20k, and 80k characters and keeps each size's
   * fastest per-call time over every round, so a pause that lands in one round never counts. Each
   * timed loop parses 80k characters in all (16 calls at 5k, 4 at 20k, 1 at 80k), so every size is
   * as exposed to a collection or a preemption, and the size order alternates each round. Linear
   * work grows 16× from 5k to 80k and quadratic work 256×, so the 64× bound sits between them.
   * Returns the parse of the largest input.
   */
  function expectLinear(build: (size: number) => string, parse: (html: string) => unknown) {
    const inputs = SIZES.map(build);
    const fastest = SIZES.map(() => Number.POSITIVE_INFINITY);
    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 === 0 ? [0, 1, 2] : [2, 1, 0];
      for (const i of order) {
        const input = inputs[i] as string;
        const calls = 80_000 / (SIZES[i] as number);
        const started = performance.now();
        for (let call = 0; call < calls; call++) parse(input);
        fastest[i] = Math.min(fastest[i] as number, (performance.now() - started) / calls);
      }
    }
    const [t5k, , t80k] = fastest as [number, number, number];
    expect(t80k / t5k, `${t5k.toFixed(3)} ms at 5k, ${t80k.toFixed(3)} ms at 80k`).toBeLessThan(64);
    expect(t80k).toBeLessThan(MAX_80K_MS);
    return parse(inputs[2] as string);
  }

  it('reads row and cell openers that never close', () => {
    const outcome = expectLinear(
      (size) => indexPage(fill('<tr><td>', size)),
      (html) => attempt(() => parseAdvisoryIndex(html, INDEX_URL)),
    );
    expect((outcome as McpError).data).toMatchObject({ reason: 'advisory_contract_changed' });
  });

  it('reads an unterminated row whose brief title runs to the end of the table', () => {
    const outcome = expectLinear(
      (size) =>
        indexPage(`<tr><td>${LINK}</td><td>DCC</td><td>10/01/26</td><td>${fill('WORD ', size)}`),
      (html) => parseAdvisoryIndex(html, INDEX_URL),
    );
    expect((outcome as { rows: AdvisoryIndexRow[] }).rows).toEqual([
      {
        controlElement: 'DCC',
        date: '2026-10-01',
        number: 5,
        subject: 'WORD '.repeat(16_000).trim(),
      },
    ]);
  });

  it('strips nested <a<a<a…>>> markup from a cell', () => {
    const nested = (depth: number) => `${'<a'.repeat(depth)}${'>'.repeat(depth)}`;
    const outcome = expectLinear(
      (size) =>
        indexPage(
          `<tr><td>${LINK}</td><td>DCC</td><td>10/01/26</td><td>${nested(size / 4)}</td></tr>`,
        ),
      (html) => parseAdvisoryIndex(html, INDEX_URL),
    );
    // Only the innermost `<a>` is a tag; every other `<a` and `>` is text.
    const depth = 80_000 / 4;
    expect((outcome as { rows: AdvisoryIndexRow[] }).rows[0]?.subject).toBe(
      `${'<a'.repeat(depth - 1)} ${'>'.repeat(depth - 1)}`,
    );
  });

  it('applies the title rule to a title with no date', () => {
    const outcome = expectLinear(
      (size) => page(`ATCSCC&nbsp;ADVZY&nbsp;001&nbsp;${fill('X 01/01/2', size)}`, 'TEXT'),
      (html) => parseAdvisoryPage(html, URL_UNDER_TEST),
    );
    expect(outcome).toMatchObject({ found: true, text: 'TEXT' });
    expect(outcome).not.toHaveProperty('controlElement');
    expect(outcome).not.toHaveProperty('subject');
  });

  it('reads the trailing effective time and signature after many lines', () => {
    const outcome = expectLinear(
      (size) =>
        page(
          'ATCSCC ADVZY 144 DCC 10/01/2026 OPERATIONS PLAN',
          `${fill('012131-012359\n \n', size)}26/10/01 21:31  DCCOPS.lxstn35`,
        ),
      (html) => parseAdvisoryPage(html, URL_UNDER_TEST),
    );
    expect(outcome).toMatchObject({ effectiveTime: '012131-012359', sentAt: '26/10/01 21:31' });
  });
});

describe('AdvisoryService', () => {
  let service: AdvisoryService;

  afterEach(() => {
    service?.dispose();
    vi.useRealTimers();
  });

  function makeService(pages: Record<string, () => Response | Promise<Response>>, start?: string) {
    const clock = createClock(start);
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

  describe('listAdvisories', () => {
    const FULL = () => htmlResponse(readFixture('advisory-index-2026-10-01.page'));
    /** 22:00Z on 2026-10-01: that date is still taking advisories. */
    const OPEN = '2026-10-01T22:00:00Z';
    const GROUND_STOP_URL = `${INDEX}&advisoryCategory=NotAll&date=2026-10-01&gStop=true&_gDelay=on&_airflow=on&_ctop=on&_route=on&_other=on`;

    it('fetches the All index with HTML headers when no category is given, and parses it', async () => {
      const { harness } = makeService({ [INDEX_URL]: FULL }, OPEN);

      const index = await service.listAdvisories('2026-10-01', undefined, createMockContext());

      expect([index.rows.length, index.skippedRows]).toEqual([154, 0]);
      expect(index.rows[0]).toMatchObject({ number: 154, controlElement: 'PHLC/ZNY' });
      const request = harness.calls[0]?.request as Request;
      expect(request.url).toBe(INDEX_URL);
      expect(request.headers.get('accept')).toBe('text/html');
      expect(request.headers.get('user-agent')).toBe('faa-test/9.9');
    });

    it('fetches the NotAll index for a category set, every other box sent unchecked', async () => {
      const { harness } = makeService(
        {
          [GROUND_STOP_URL]: () =>
            htmlResponse(readFixture('advisory-index-2026-10-01-ground-stop.page')),
        },
        OPEN,
      );

      const index = await service.listAdvisories(
        '2026-10-01',
        ['ground_stop'],
        createMockContext(),
      );

      expect(index.rows).toHaveLength(33);
      expect(harness.calls.map((call) => call.request.url)).toEqual([GROUND_STOP_URL]);
    });

    it('reads an empty category list as no filter: the All index, under the same cache entry', async () => {
      const { harness } = makeService({ [INDEX_URL]: FULL }, OPEN);
      const ctx = createMockContext();

      const empty = await service.listAdvisories('2026-10-01', [], ctx);
      const omitted = await service.listAdvisories('2026-10-01', undefined, ctx);

      expect(empty.rows).toHaveLength(154);
      expect(omitted).toBe(empty);
      expect(harness.calls.map((call) => call.request.url)).toEqual([INDEX_URL]);
    });

    it('keys the cache by category set, whatever its order, and by date', async () => {
      const routeAndStops = `${INDEX}&advisoryCategory=NotAll&date=2026-10-01&gStop=true&_gDelay=on&_airflow=on&_ctop=on&route=true&_other=on`;
      const otherDate = `${INDEX}&advisoryCategory=NotAll&date=2026-09-30&gStop=true&_gDelay=on&_airflow=on&_ctop=on&route=true&_other=on`;
      const page = () => htmlResponse(readFixture('advisory-index-2026-10-01-route.page'));
      const { harness } = makeService({ [otherDate]: page, [routeAndStops]: page }, OPEN);
      const ctx = createMockContext();

      await service.listAdvisories('2026-10-01', ['route', 'ground_stop'], ctx);
      await service.listAdvisories('2026-10-01', ['ground_stop', 'route'], ctx);
      expect(harness.calls).toHaveLength(1);

      await service.listAdvisories('2026-09-30', ['route', 'ground_stop'], ctx);
      expect(harness.calls.map((call) => call.request.url)).toEqual([routeAndStops, otherDate]);
    });

    it('caches the index of a date still open for 60 s', async () => {
      const { clock, harness } = makeService({ [INDEX_URL]: FULL }, OPEN);
      const ctx = createMockContext();

      await service.listAdvisories('2026-10-01', undefined, ctx);
      clock.advance(59_999);
      await service.listAdvisories('2026-10-01', undefined, ctx);
      expect(harness.calls).toHaveLength(1);

      clock.advance(1);
      await service.listAdvisories('2026-10-01', undefined, ctx);
      expect(harness.calls).toHaveLength(2);
    });

    it('caches the index of a date over for more than an hour for 6 h', async () => {
      const past = `${INDEX}&advisoryCategory=All&date=2026-09-30`;
      const { clock, harness } = makeService({ [past]: FULL }, OPEN);
      const ctx = createMockContext();

      await service.listAdvisories('2026-09-30', undefined, ctx);
      clock.advance(6 * 60 * 60_000 - 1);
      await service.listAdvisories('2026-09-30', undefined, ctx);
      expect(harness.calls).toHaveLength(1);

      clock.advance(1);
      await service.listAdvisories('2026-09-30', undefined, ctx);
      expect(harness.calls).toHaveLength(2);
    });

    it('keeps the 60 s lifetime until the hour after the UTC date ends has passed', async () => {
      // 00:59:59.999Z on 2026-10-02: the 2026-10-01 day ended just under an hour ago.
      const { clock, harness } = makeService({ [INDEX_URL]: FULL }, '2026-10-02T00:59:59.999Z');
      const ctx = createMockContext();

      await service.listAdvisories('2026-10-01', undefined, ctx);
      clock.advance(60_000);
      // Read at 01:00:59.999Z, past the hour, so this copy is kept for 6 h.
      await service.listAdvisories('2026-10-01', undefined, ctx);
      expect(harness.calls).toHaveLength(2);

      clock.advance(6 * 60 * 60_000 - 1);
      await service.listAdvisories('2026-10-01', undefined, ctx);
      expect(harness.calls).toHaveLength(2);

      clock.advance(1);
      await service.listAdvisories('2026-10-01', undefined, ctx);
      expect(harness.calls).toHaveLength(3);
    });

    it('keeps one shared read for the other caller when the first caller cancels', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { harness } = makeService(
        {
          [INDEX_URL]: async () => {
            await held;
            return FULL();
          },
        },
        OPEN,
      );
      const controller = new AbortController();

      const first = service.listAdvisories(
        '2026-10-01',
        undefined,
        createMockContext({ signal: controller.signal }),
      );
      const second = service.listAdvisories('2026-10-01', undefined, createMockContext());
      await vi.waitFor(() => expect(harness.calls).toHaveLength(1));

      controller.abort(new Error('client cancelled'));
      await expect(first).rejects.toThrow('client cancelled');
      expect(harness.calls[0]?.request.signal.aborted).toBe(false);

      release();
      await expect(second).resolves.toMatchObject({ skippedRows: 0 });
      expect((await second).rows).toHaveLength(154);
      await service.listAdvisories('2026-10-01', undefined, createMockContext());
      expect(harness.calls).toHaveLength(1);
    });

    it('raises advisory_contract_changed with the index url for a caption with no row, without retrying', async () => {
      vi.useFakeTimers();
      const { harness } = makeService({ [INDEX_URL]: () => htmlResponse(indexPage('')) }, OPEN);

      const { error } = await settle(
        service.listAdvisories('2026-10-01', undefined, createMockContext()),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect((error as McpError).data).toMatchObject({
        reason: 'advisory_contract_changed',
        url: INDEX_URL,
      });
      expect(harness.calls).toHaveLength(1);
    });

    it('retries the error page and then reports advisory_service_unavailable with the index url', async () => {
      vi.useFakeTimers();
      const { harness } = makeService(
        { [INDEX_URL]: () => htmlResponse(readFixture('advisory-index-error.page')) },
        OPEN,
      );

      const { error } = await settle(
        service.listAdvisories('2026-10-01', undefined, createMockContext()),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect((error as McpError).data).toMatchObject({
        reason: 'advisory_service_unavailable',
        url: INDEX_URL,
      });
      expect(harness.calls).toHaveLength(3);
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
