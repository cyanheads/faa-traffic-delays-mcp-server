/**
 * @fileoverview Tests for advisory references: the server-built URL and mining `advn` and
 * `adv_date` out of feed links whose title parameter carries unencoded spaces.
 * @module tests/services/advisory/advisory-ref.test
 */

import { describe, expect, it } from 'vitest';
import { buildAdvisoryUrl, parseAdvisoryLink } from '@/services/advisory/advisory-ref.js';

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
    ['a non-numeric advn', 'https://x.test/a?advn=abc&adv_date=09302026'],
  ])('returns undefined for %s', (_label, link) => {
    expect(parseAdvisoryLink(link)).toBeUndefined();
  });

  it('does not match advn as the tail of another parameter', () => {
    expect(parseAdvisoryLink('https://x.test/a?xadvn=3&adv_date=09302026')).toBeUndefined();
  });
});
