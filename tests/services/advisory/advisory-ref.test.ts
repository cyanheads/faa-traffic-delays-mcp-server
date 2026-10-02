/**
 * @fileoverview Tests for advisory references: the server-built advisory and index URLs, and
 * mining `advn` and `adv_date` out of feed links whose title parameter carries unencoded spaces.
 * @module tests/services/advisory/advisory-ref.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildAdvisoryIndexUrl,
  buildAdvisoryUrl,
  parseAdvisoryLink,
} from '@/services/advisory/advisory-ref.js';

describe('buildAdvisoryUrl', () => {
  it('builds the https advisory URL with MMDDYYYY from a YYYY-MM-DD date', () => {
    expect(buildAdvisoryUrl(3, '2026-09-30')).toBe(
      'https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=09302026',
    );
  });

  it('does not zero-pad the advisory number', () => {
    expect(buildAdvisoryUrl(82, '2026-01-05')).toBe(
      'https://www.fly.faa.gov/adv/adv_otherdis?advn=82&adv_date=01052026',
    );
  });
});

describe('buildAdvisoryIndexUrl', () => {
  const INDEX = 'https://www.fly.faa.gov/adv/adv_list?whichAdvisories=ATCSCC';

  it('reads every advisory, uncategorized ones included, when no category is given', () => {
    expect(buildAdvisoryIndexUrl('2026-10-01')).toBe(
      `${INDEX}&advisoryCategory=All&date=2026-10-01`,
    );
  });

  it('reads an empty category list as no filter, the same All index', () => {
    expect(buildAdvisoryIndexUrl('2026-10-01', [])).toBe(
      `${INDEX}&advisoryCategory=All&date=2026-10-01`,
    );
  });

  it('checks the selected box and sends every other box as unchecked', () => {
    expect(buildAdvisoryIndexUrl('2026-10-01', ['ground_stop'])).toBe(
      `${INDEX}&advisoryCategory=NotAll&date=2026-10-01&gStop=true&_gDelay=on&_airflow=on&_ctop=on&_route=on&_other=on`,
    );
  });

  it.each([
    ['ground_delay_program', 'gDelay'],
    ['airspace_flow_program', 'airflow'],
    ['ctop', 'ctop'],
    ['route', 'route'],
    ['other', 'other'],
  ] as const)('names the %s box %s', (category, box) => {
    const url = buildAdvisoryIndexUrl('2026-10-01', [category]);
    expect(url).toContain(`&${box}=true`);
    expect(url).not.toContain(`_${box}=on`);
    expect(url.match(/=true/g)).toHaveLength(1);
    expect(url.match(/_[a-zA-Z]+=on/g)).toHaveLength(5);
  });

  it('builds one URL for one category set, whatever its order', () => {
    expect(buildAdvisoryIndexUrl('2026-10-01', ['route', 'ground_stop'])).toBe(
      buildAdvisoryIndexUrl('2026-10-01', ['ground_stop', 'route']),
    );
    expect(buildAdvisoryIndexUrl('2026-10-01', ['route', 'ground_stop'])).toBe(
      `${INDEX}&advisoryCategory=NotAll&date=2026-10-01&gStop=true&_gDelay=on&_airflow=on&_ctop=on&route=true&_other=on`,
    );
  });

  it('reads every category box as NotAll, which leaves out uncategorized advisories', () => {
    expect(
      buildAdvisoryIndexUrl('2004-06-15', [
        'other',
        'route',
        'ctop',
        'airspace_flow_program',
        'ground_delay_program',
        'ground_stop',
      ]),
    ).toBe(
      `${INDEX}&advisoryCategory=NotAll&date=2004-06-15&gStop=true&gDelay=true&airflow=true&ctop=true&route=true&other=true`,
    );
  });
});

describe('parseAdvisoryLink', () => {
  const feedLink =
    'https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=003&adv_date=09302026&facId=SEA&title=ATCSCC ADVZY 003 SEA/ZSE 09/30/2026 CDM GROUND DELAY PROGRAM&titleDate=09/30/2026';

  it('reads the number and date from a feed link with unencoded spaces', () => {
    expect(parseAdvisoryLink(feedLink)).toEqual({
      date: '2026-09-30',
      number: 3,
      url: 'https://www.fly.faa.gov/adv/adv_otherdis?advn=3&adv_date=09302026',
    });
  });

  it('never returns the feed link itself', () => {
    expect(JSON.stringify(parseAdvisoryLink(feedLink))).not.toContain('title=');
  });

  it('accepts the parameters in either order', () => {
    expect(parseAdvisoryLink('https://x.test/a?adv_date=01022026&advn=12')).toMatchObject({
      date: '2026-01-02',
      number: 12,
    });
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a link without advn', 'https://x.test/a?adv_date=09302026'],
    ['a link without adv_date', 'https://x.test/a?advn=3'],
    ['a malformed adv_date', 'https://x.test/a?advn=3&adv_date=2026-09-30'],
    ['advn 0', 'https://x.test/a?advn=0&adv_date=09302026'],
    ['advn 1000, past the last advisory number', 'https://x.test/a?advn=1000&adv_date=09302026'],
    ['a 25-digit advn', `https://x.test/a?advn=${'9'.repeat(25)}&adv_date=09302026`],
    ['a non-numeric advn', 'https://x.test/a?advn=abc&adv_date=09302026'],
    ['an advn that runs into letters', 'https://x.test/a?advn=12abc&adv_date=09302026'],
    ['an advn that runs into letters at the end', 'https://x.test/a?adv_date=09302026&advn=12abc'],
    ['an adv_date with a ninth digit', 'https://x.test/a?advn=3&adv_date=093020261'],
    ['an adv_date naming month 13 day 45', 'https://x.test/a?advn=3&adv_date=13452026'],
    ['an adv_date naming February 30', 'https://x.test/a?advn=3&adv_date=02302026&facId=SEA'],
    [
      'an adv_date naming February 29 of a common year',
      'https://x.test/a?advn=3&adv_date=02292026',
    ],
    ['an adv_date naming day 0', 'https://x.test/a?advn=3&adv_date=09002026'],
  ])('returns undefined for %s', (_label, link) => {
    expect(parseAdvisoryLink(link)).toBeUndefined();
  });

  it('reads advn 999, the last advisory number', () => {
    expect(parseAdvisoryLink('https://x.test/a?advn=999&adv_date=09302026')?.number).toBe(999);
  });

  it.each([
    ['last in the link', 'https://x.test/a?adv_date=02292028&advn=7', 7, '2028-02-29'],
    [
      'before another parameter',
      'https://x.test/a?advn=7&adv_date=12312026&facId=SEA',
      7,
      '2026-12-31',
    ],
    ['in an index link', '/adv/adv_otherdis?adv_date=10012026&advn=154', 154, '2026-10-01'],
  ])('reads a number and real date %s', (_label, link, number, date) => {
    expect(parseAdvisoryLink(link)).toEqual({
      date,
      number,
      url: `https://www.fly.faa.gov/adv/adv_otherdis?advn=${number}&adv_date=${date.slice(5, 7)}${date.slice(8)}${date.slice(0, 4)}`,
    });
  });

  it('does not match advn as the tail of another parameter', () => {
    expect(parseAdvisoryLink('https://x.test/a?xadvn=3&adv_date=09302026')).toBeUndefined();
  });
});
