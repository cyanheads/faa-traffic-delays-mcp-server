/**
 * @fileoverview Tests for the Markdown helpers that render FAA-authored text: inline slots and
 * table cells flatten line breaks, drop control and bidi characters, and leave link, image, and
 * HTML syntax inert; a backslash in the text cannot cancel an escape.
 * @module tests/mcp-server/tools/format-helpers.test
 */

import { describe, expect, it } from 'vitest';
import { cell, inline, span } from '@/mcp-server/tools/format-helpers.js';

describe('inline', () => {
  it('flattens CR, LF, and TAB runs to one space', () => {
    expect(inline('A\r\n\tB\nC')).toBe('A B C');
  });

  it.each([
    ['an image', '![x](https://evil.example/p?q=1)', '!\\[x\\](https://evil.example/p?q=1)'],
    ['a link', '[click](https://evil.example)', '\\[click\\](https://evil.example)'],
    ['a reference link', '[x][ref]', '\\[x\\]\\[ref\\]'],
    ['an HTML tag', '<img src=x onerror=alert(1)>', '\\<img src=x onerror=alert(1)\\>'],
    ['an autolink', '<https://evil.example>', '\\<https://evil.example\\>'],
  ])('escapes %s so it renders as text', (_label, input, expected) => {
    expect(inline(input)).toBe(expected);
  });

  it('doubles a backslash run before an escaped character so it cannot cancel the escape', () => {
    expect(inline('a\\[b')).toBe('a\\\\\\[b');
    expect(inline('a\\\\](u)')).toBe('a\\\\\\\\\\](u)');
  });

  it('leaves a backslash that precedes no escaped character alone', () => {
    expect(inline('C:\\path\\*x')).toBe('C:\\path\\*x');
  });

  it('removes C0 and C1 controls and bidi embedding, override, and isolate controls', () => {
    expect(
      inline(
        'A\u{1B}[31mB\u{0}C\u{7F}D\u{85}E\u{9B}F\u{202A}G\u{202E}H\u{2066}I\u{2069}J\u{200B}K',
      ),
    ).toBe('A\\[31mBCDEFGHIJ\u{200B}K');
  });

  it('keeps ordinary FAA text unchanged', () => {
    expect(inline('RWY:Construction / LOW CEILINGS 16L/16R')).toBe(
      'RWY:Construction / LOW CEILINGS 16L/16R',
    );
  });

  it('runs in linear time on a long backslash run', () => {
    const started = performance.now();
    inline(`${'\\'.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('cell', () => {
  it('escapes every backslash, then pipes, brackets, and angle brackets', () => {
    expect(cell('a|b\\[c](u)<d>')).toBe('a\\|b\\\\\\[c\\](u)\\<d\\>');
  });

  it('removes control and bidi characters', () => {
    expect(cell('US/\u{1B}Pa\u{202E}cific')).toBe('US/Pacific');
  });

  it('renders an absent value as an em dash', () => {
    expect(cell(undefined)).toBe('—');
  });
});

describe('span', () => {
  it('renders both bounds through the inline escaping', () => {
    expect(span('[a](u)', '<b>')).toBe('\\[a\\](u) → \\<b\\>');
  });
});
