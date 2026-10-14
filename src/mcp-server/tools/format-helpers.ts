/**
 * @fileoverview Markdown rendering helpers for FAA-authored text in `format()`. Inline slots get
 * CR/LF/TAB flattened to one space, other control and bidi characters removed, and `[`, `]`, `<`,
 * `>` escaped to neutralize Markdown link/image syntax, angle-bracket autolinks, and HTML tags;
 * clients may still auto-link bare URLs. Table cells escape every `\` and
 * `|` as well. Free text renders as a `>` blockquote or a fenced block; a value the FAA did not
 * report is named or left out, never shown as a placeholder. `structuredContent` always keeps the
 * verbatim value.
 * @module mcp-server/tools/format-helpers
 */

import type { AdvisoryRef } from '@/services/advisory/advisory-ref.js';

/** C0 and C1 controls, DEL, and the bidi embedding, override, and isolate controls. */
const isControl = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** CR/LF/TAB runs → one space, then every remaining control or bidi character removed. */
function flatten(value: string): string {
  let kept = '';
  for (const char of value.replace(/[\r\n\t]+/g, ' ')) {
    if (!isControl(char.charCodeAt(0))) kept += char;
  }
  return kept;
}

/**
 * Text safe in a heading, label, or list item: flattened, with `[`, `]`, `<`, and `>` escaped and
 * a backslash run directly before one doubled, so the text cannot cancel the escape.
 */
export function inline(value: string): string {
  return flatten(value).replace(/(?<!\\)(\\*)([[\]<>])/g, '$1$1\\$2');
}

/** `start → end` for an upstream time window, naming whichever bound the FAA did not report. */
export function span(start: string | undefined, end: string | undefined): string {
  if (start && end) return `${inline(start)} → ${inline(end)}`;
  if (start) return `from ${inline(start)} (end not reported)`;
  if (end) return `until ${inline(end)} (start not reported)`;
  return 'times not reported';
}

/** `average 55 min, maximum 117 min`, leaving out a figure the FAA did not report. */
export function delayFigures(
  average: number | undefined,
  maximum: number | undefined,
): string | undefined {
  const figures = [
    ...(average !== undefined ? [`average ${average} min`] : []),
    ...(maximum !== undefined ? [`maximum ${maximum} min`] : []),
  ];
  return figures.length > 0 ? figures.join(', ') : undefined;
}

/** `16–30 min`, `at least 16 min`, or `up to 30 min`, by which bounds of a delay band the FAA reported. */
export function delayBand(min: number | undefined, max: number | undefined): string | undefined {
  if (min !== undefined && max !== undefined) return `${min}–${max} min`;
  if (min !== undefined) return `at least ${min} min`;
  if (max !== undefined) return `up to ${max} min`;
  return;
}

/** An inline value safe inside a Markdown table cell: every `\`, `|`, `[`, `]`, `<`, and `>` escaped. */
export function cell(value: string | number | boolean | undefined): string {
  if (value === undefined) return '—';
  return flatten(String(value)).replace(/[\\|[\]<>]/g, '\\$&');
}

/** Normalizes line endings and tabs, removing controls without merging original lines. */
function multiline(value: string): string {
  let kept = '';
  for (const char of value.replace(/\r\n|\r/g, '\n')) {
    if (char === '\n') kept += char;
    else if (char === '\t') kept += ' ';
    else if (!isControl(char.charCodeAt(0))) kept += char;
  }
  return kept;
}

/** Quotes each line with bracket/angle escaping, preserving emphasis and code characters. */
export function blockquote(value: string): string {
  return multiline(value)
    .split('\n')
    .map((line) => (line ? `> ${inline(line)}` : '>'))
    .join('\n');
}

/** Fences free text in a `text` block one backtick longer than its longest backtick run. */
export function fenced(value: string): string {
  const text = multiline(value);
  let longestRun = 0;
  let run = 0;
  for (const char of text) {
    run = char === '`' ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** `ADVZY 17 · 2026-07-15 · <url>` — the advisory reference line. */
export function advisoryLine(advisory: AdvisoryRef): string {
  return `ADVZY ${advisory.number} · ${advisory.date} · ${advisory.url}`;
}
