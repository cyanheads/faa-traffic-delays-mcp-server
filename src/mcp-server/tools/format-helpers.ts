/**
 * @fileoverview Markdown rendering helpers for FAA-authored text in `format()`. Inline slots get
 * CR/LF/TAB flattened to one space; table cells also escape `\` then `|`; free text renders as a
 * `>` blockquote or a fenced block. `structuredContent` always keeps the verbatim value.
 * @module mcp-server/tools/format-helpers
 */

import type { AdvisoryRef } from '@/services/advisory/advisory-ref.js';

/** Flattens CR, LF, and TAB runs to a single space for headings, labels, and list items. */
export function inline(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ');
}

/** `start → end` for an upstream time window, `?` for a bound the FAA did not report. */
export function span(start: string | undefined, end: string | undefined): string {
  return `${start ? inline(start) : '?'} → ${end ? inline(end) : '?'}`;
}

/** An inline value safe inside a Markdown table cell. */
export function cell(value: string | number | boolean | undefined): string {
  if (value === undefined) return '—';
  return inline(String(value)).replaceAll('\\', '\\\\').replaceAll('|', '\\|');
}

/** Renders free text as a blockquote, every line prefixed. */
export function blockquote(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** Fences free text in a `text` block one backtick longer than its longest backtick run. */
export function fenced(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${value}\n${fence}`;
}

/** `ADVZY 17 · 2026-07-15 · <url>` — the advisory reference line. */
export function advisoryLine(advisory: AdvisoryRef): string {
  return `ADVZY ${advisory.number} · ${advisory.date} · ${advisory.url}`;
}
