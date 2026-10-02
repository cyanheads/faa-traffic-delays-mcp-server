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

  /**
   * Times `inline` on a backslash run of 5k, 20k, and 80k characters and keeps each size's fastest
   * per-call time over every round, so a pause that lands in one round never counts. Each timed
   * loop renders 80k characters in all (16 calls at 5k, 4 at 20k, 1 at 80k), so every size is as
   * exposed to a collection or a preemption, and the size order alternates each round. Linear work
   * grows 16× from 5k to 80k and quadratic work 256×, so the 64× bound sits between them.
   */
  it('grows linearly with the length of a backslash run', () => {
    const SIZES = [5_000, 20_000, 80_000] as const;
    const ROUNDS = 21;
    /** Slowest acceptable fastest-call time at 80k characters; a linear pass takes about 1.5 ms. */
    const MAX_80K_MS = 100;
    const inputs = SIZES.map((size) => `${'\\'.repeat(size)}x`);
    const fastest = SIZES.map(() => Number.POSITIVE_INFINITY);
    for (let round = 0; round < ROUNDS; round++) {
      for (const i of round % 2 === 0 ? [0, 1, 2] : [2, 1, 0]) {
        const input = inputs[i] as string;
        const calls = 80_000 / (SIZES[i] as number);
        const started = performance.now();
        for (let call = 0; call < calls; call++) inline(input);
        fastest[i] = Math.min(fastest[i] as number, (performance.now() - started) / calls);
      }
    }
    const [t5k, , t80k] = fastest as [number, number, number];

    expect(t80k / t5k, `${t5k.toFixed(3)} ms at 5k, ${t80k.toFixed(3)} ms at 80k`).toBeLessThan(64);
    expect(t80k).toBeLessThan(MAX_80K_MS);
    expect(inline(inputs[2] as string)).toBe(inputs[2]);
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
