/**
 * @fileoverview Markdown rendering helpers for FAA-authored text in `format()`. Inline slots and
 * table cells collapse CR/LF/TAB runs to one space. Quotes and fenced blocks preserve line
 * boundaries. The helpers remove other control and bidi characters and encode normalized text
 * for literal rendering. Clients may still auto-link bare URLs. `structuredContent` keeps the
 * verbatim value.
 * @module mcp-server/tools/format-helpers
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { AdvisoryRef } from '@/services/advisory/advisory-ref.js';

/** C0 except LF, DEL, C1, and the bidi embedding, override, and isolate controls. */
const CONTROL_EXCEPT_LF = /(?!\n)[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;

/** CR/LF/TAB runs → one space, then every remaining control or bidi character removed. */
export function normalizeInline(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(CONTROL_EXCEPT_LF, '');
}

/** Flattens text for literal rendering in a heading, label, or list item. */
export function inline(value: string): string {
  return escapeMarkdownInline(normalizeInline(value));
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

/** An inline value in a Markdown table cell, with embedded pipes escaped. */
export function cell(value: string | number | boolean | undefined): string {
  if (value === undefined) return '—';
  return inline(String(value));
}

/** Normalizes line endings and tabs, removing controls without merging original lines. */
function multiline(value: string): string {
  return value.replace(/\r\n?/g, '\n').replaceAll('\t', ' ').replace(CONTROL_EXCEPT_LF, '');
}

/** Encodes the whole value before quoting so its original line boundaries render as breaks. */
export function blockquote(value: string): string {
  return escapeMarkdownInline(multiline(value))
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
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
