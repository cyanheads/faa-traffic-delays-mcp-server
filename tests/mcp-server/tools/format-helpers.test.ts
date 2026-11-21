/**
 * @fileoverview Tests for literal Markdown rendering and whitespace normalization of FAA text.
 * @module tests/mcp-server/tools/format-helpers.test
 */

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { blockquote, cell, fenced, inline, span } from '@/mcp-server/tools/format-helpers.js';
import { measureThreadCpuMicros } from '../../helpers/measure-thread-cpu.js';

const commonmark = new MarkdownIt('commonmark');

function readLiteral(markdown: string, blocks: string[]): string {
  const tokens = commonmark.parse(markdown, {});
  expect(tokens.map((token) => token.type)).toEqual(blocks);
  return tokens
    .flatMap((token) => token.children ?? [])
    .map((token) => {
      if (token.type === 'hardbreak') return '\n';
      expect(token.type).toBe('text');
      return token.content;
    })
    .join('');
}

function readQuote(value: string): string {
  return readLiteral(blockquote(value), [
    'blockquote_open',
    'paragraph_open',
    'inline',
    'paragraph_close',
    'blockquote_close',
  ]);
}

describe('multiline FAA text', () => {
  it('preserves literal markers, edge whitespace, and blank lines after CommonMark parsing', () => {
    const value = [
      '',
      '# North route',
      '- West route',
      '1. East route',
      '---',
      '',
      'South route',
      '===',
      '  Mention *literal* and `token` and FCA005:NO_AR_ATLANTIC.  ',
      '',
      '',
    ].join('\n');
    expect(readQuote(value)).toBe(value);
  });

  it.each([blockquote, fenced])(
    'bounds worst-case rendering CPU across a 64-fold input span',
    (render) => {
      const sizes = [5_000, 20_000, 80_000, 320_000];
      const fastest = sizes.map(() => Infinity);
      for (let round = 0; round < 7; round++) {
        for (const [index, size] of sizes.entries()) {
          const input = `${'\\'.repeat(size)}[x]\t\u202e\n${'`'.repeat(size)}`;
          fastest[index] = Math.min(
            fastest[index] as number,
            measureThreadCpuMicros(() => render(input), 1),
          );
        }
      }
      expect((fastest[3] as number) / (fastest[0] as number)).toBeLessThan(256);
    },
  );
  it('escapes links and HTML after backslash runs on every quoted line', () => {
    const value = 'USE <FIX> [route](u)\n![x](u)\n\\[x]';
    expect(readQuote(value)).toBe(value);
  });
  it.each([blockquote, fenced])(
    'normalizes tabs and removes controls without merging lines',
    (render) => {
      const text = render('A\tB\u0000\u0085\u202e\r\nC\u2066\rD\nE');
      expect(text).toContain('A B');
      expect(text).not.toMatch(/[\u0000\u0085\u202e\u2066\t\r]/);
      expect(text.split('\n').filter((line) => /[CDE]/.test(line))).toHaveLength(3);
    },
  );
  it('uses a fence longer than the longest run in the text', () => {
    expect(fenced('a```b')).toBe('````text\na```b\n````');
  });
});

describe('inline', () => {
  it('preserves punctuation and edge spaces in a heading after CommonMark parsing', () => {
    const value = '  FCA005:NO_AR_ATLANTIC *literal* `token` #  ';
    expect(readLiteral(`## ${inline(value)}`, ['heading_open', 'inline', 'heading_close'])).toBe(
      value,
    );
  });

  it('flattens CR, LF, and TAB runs to one space', () => {
    expect(inline('A\r\n\tB\nC')).toBe('A B C');
  });

  it.each([
    ['an image', '![x](https://example.com/diagram.png)'],
    ['a link', '[route](https://example.com)'],
    ['a reference link', '[route][ref]'],
    ['an HTML tag', '<strong>North</strong>'],
    ['an autolink', '<https://example.com>'],
  ])('escapes %s so it renders as text', (_label, input) => {
    expect(readLiteral(inline(input), ['paragraph_open', 'inline', 'paragraph_close'])).toBe(input);
  });

  it('doubles a backslash run before an escaped character so it cannot cancel the escape', () => {
    expect(inline('a\\[b')).toBe('a\\\\\\[b');
    expect(inline('a\\\\](u)')).toBe('a\\\\\\\\\\](u)');
    const value = `${'\\'.repeat(16)}x`;
    expect(readLiteral(inline(value), ['paragraph_open', 'inline', 'paragraph_close'])).toBe(value);
  });

  it('leaves backslashes before ordinary text alone', () => {
    expect(inline('C:\\path\\x')).toBe('C:\\path\\x');
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
   * batch starts with 80k characters (16 calls at 5k, 4 at 20k, 1 at 80k), and the size order
   * alternates each round. Linear work grows 16× from 5k to 80k and quadratic work 256×, so the
   * 64× bound sits between them.
   */
  it('grows linearly with the length of a backslash run', () => {
    const SIZES = [5_000, 20_000, 80_000] as const;
    const ROUNDS = 21;
    /** Slowest acceptable fastest-call time at 80k characters. */
    const MAX_80K_MS = 100;
    const inputs = SIZES.map((size) => `${'\\'.repeat(size)}x`);
    const fastest = SIZES.map(() => Number.POSITIVE_INFINITY);
    for (let round = 0; round < ROUNDS; round++) {
      for (const i of round % 2 === 0 ? [0, 1, 2] : [2, 1, 0]) {
        const input = inputs[i] as string;
        const calls = 80_000 / (SIZES[i] as number);
        const elapsedMs = measureThreadCpuMicros(() => inline(input), calls) / 1_000;
        fastest[i] = Math.min(fastest[i] as number, elapsedMs);
      }
    }
    const [t5k, , t80k] = fastest as [number, number, number];

    expect(t80k / t5k, `${t5k.toFixed(3)} ms at 5k, ${t80k.toFixed(3)} ms at 80k`).toBeLessThan(64);
    expect(t80k).toBeLessThan(MAX_80K_MS);
  });
});

describe('cell', () => {
  it('keeps an embedded pipe and backslashes inside one table cell', () => {
    const value = 'a|b\\[c](u)<d>';
    const tokens = new MarkdownIt().parse(
      ['| Route | Status |', '| --- | --- |', `| ${cell(value)} | Active |`].join('\n'),
      {},
    );
    expect(tokens.filter((token) => token.type === 'td_open')).toHaveLength(2);
    expect(tokens.flatMap((token) => token.children ?? []).map((token) => token.content)).toEqual([
      'Route',
      'Status',
      value,
      'Active',
    ]);
  });

  it('renders emphasis and backticks literally next to an embedded pipe', () => {
    const value = '  East\\|West *literal* `token`  ';
    const tokens = new MarkdownIt().parse(`| Route |\n| --- |\n| ${cell(value)} |`, {});
    const body = tokens.slice(tokens.findIndex((token) => token.type === 'tbody_open'));
    const children = body.flatMap((token) => token.children ?? []);
    expect(children.map((token) => [token.type, token.content])).toEqual([['text', value]]);
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
    expect(
      readLiteral(span('[a](u)', '<b>'), ['paragraph_open', 'inline', 'paragraph_close']),
    ).toBe('[a](u) → <b>');
  });
});
