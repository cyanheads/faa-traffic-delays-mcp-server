/**
 * @fileoverview ATCSCC advisories database client (`https://www.fly.faa.gov/adv/`): fetches one
 * advisory page by number and UTC date, or the index of the advisories issued on a UTC date,
 * through the paced, retried fetch boundary. An advisory page yields its title, text block,
 * effective time, and signature; an index page yields one row per advisory. Issued advisories, and
 * misses and indexes for a UTC date over for an hour, are cached for 6 h (none can change); other
 * misses and indexes for 60 s. At most 200 pages and 50 indexes are cached, each as a copy of its
 * parsed values that shares no memory with the page it was read from.
 * @module services/advisory/advisory-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import {
  FaaHttpClient,
  type HttpServiceOptions,
  type UpstreamProfile,
} from '@/services/upstream/faa-http-client.js';
import { TtlCache } from '@/services/upstream/ttl-cache.js';
import {
  type AdvisoryCategory,
  buildAdvisoryIndexUrl,
  buildAdvisoryUrl,
  parseAdvisoryLink,
} from './advisory-ref.js';

/** Lifetime of what can no longer change: an issued advisory, or anything for a settled date. */
const FINAL_TTL_MS = 6 * 60 * 60 * 1000;
/** Lifetime of what can still change: a miss or an index for a date still open. */
const OPEN_TTL_MS = 60_000;
const MAX_CACHED_PAGES = 200;
const MAX_CACHED_INDEXES = 50;
/** How long after a UTC day ends before that date takes no new advisory, allowing for late entry. */
const DATE_SETTLES_AFTER_MS = 60 * 60 * 1000;

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const PROFILE: UpstreamProfile = {
  accept: 'text/html',
  contractChangedReason: 'advisory_contract_changed',
  htmlIsMaintenance: false,
  maxBodyBytes: 2 * 1024 * 1024,
  pacer: {
    cooldown: { baseMs: 5_000, maxMs: 60_000 },
    limits: [{ perMs: 60_000, requests: 20 }],
    maxConcurrent: 2,
    minStartGapMs: 500,
    name: 'FAA advisories database',
  },
  service: 'The FAA advisories database',
  unavailableReason: 'advisory_service_unavailable',
};

/** What an advisory page yields. `found: false` is the database's own "NO Advisory." page. */
export interface AdvisoryPage {
  controlElement?: string;
  effectiveTime?: string;
  found: boolean;
  sentAt?: string;
  subject?: string;
  text?: string;
  title?: string;
}

/** One row of the advisory index. */
export interface AdvisoryIndexRow {
  controlElement?: string;
  /** Advisory UTC date, `YYYY-MM-DD`, from the row's link. */
  date: string;
  /** Brief-title lines after the first (a reroute or FCA name, constrained area, valid period). */
  details?: string[];
  number: number;
  /** Send time, ISO 8601 UTC. */
  sentAt?: string;
  subject?: string;
}

/** The advisories issued on one UTC date, newest first, and the rows that could not be read. */
export interface AdvisoryIndex {
  rows: AdvisoryIndexRow[];
  skippedRows: number;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"'],
]);

/** Code points a numeric entity stays encoded for: controls except TAB, LF, CR; bidi controls. */
const isUndecoded = (code: number): boolean =>
  (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * Decodes the HTML entities the advisory pages use (named, decimal, and hex). A numeric entity for
 * a control or bidi character stays encoded, so the decoded text carries none it did not already.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isInteger(code) || code > 0x10ffff || isUndecoded(code)) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

const cellText = (html: string): string =>
  decodeEntities(html.replace(/<[^<>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The content of the first element whose opening tag matches `open`, up to the next `</tag>`, and
 * the offset just past that closing tag. Each tag is found by its own search, so the work stays
 * linear in the page; one lazy `open([\s\S]*?)close` pattern rescans the rest of the page from
 * every opening tag that has no closing tag.
 */
function element(
  html: string,
  open: RegExp,
  tag: string,
): { content: string; end: number } | undefined {
  const opening = open.exec(html);
  if (!opening) return;
  const start = opening.index + opening[0].length;
  const closing = new RegExp(`</${tag}>`, 'gi');
  closing.lastIndex = start;
  const close = closing.exec(html);
  if (!close) return;
  return { content: html.slice(start, close.index), end: closing.lastIndex };
}

/**
 * The markup after each opening tag `open` matches, up to the next one or the end of `html`. A
 * table row or cell ends where the next begins, as HTML lets it omit its end tag, so an end tag
 * left out or written with spaces (`</TD >`) never merges two rows or two cells into one.
 */
const sections = (html: string, open: RegExp): string[] => html.split(open).slice(1);

const HEADER_CELL = /<TH\s+class=["']?header["']?[^<>]*>/i;
const PRE_BLOCK = /<PRE[^<>]*>/i;
const VALUE_CELL = /<TD\s+class=["']?val["']?[^<>]*>/i;

/** The `TD class=val` cell that follows a `LABEL:` cell, as plain text. */
function labelledValue(html: string, label: string): string | undefined {
  const at = html.search(new RegExp(`${label}:`, 'i'));
  const value = at < 0 ? undefined : element(html.slice(at), VALUE_CELL, 'TD')?.content;
  const text = value === undefined ? undefined : cellText(value);
  return text || undefined;
}

/**
 * `ATCSCC ADVZY <n> <control element> <date> <subject>`, the title form of advisory pages
 * (`MM/DD/YYYY`) and of the index's brief titles (`MM/DD/YY`). The control element runs to the
 * first date, so it can hold spaces (`EWR AND SATS/ZNY`).
 */
const TITLE_PATTERN = /^ATCSCC ADVZY \d+ (.+?) \d{2}\/\d{2}\/\d{2}(?:\d{2})? (.+)$/s;

/** Control element and subject of an `ATCSCC ADVZY …` title; undefined for a title in another form. */
function splitTitle(title: string): { controlElement: string; subject: string } | undefined {
  const [, controlElement, subject] = TITLE_PATTERN.exec(title) ?? [];
  return controlElement && subject ? { controlElement, subject } : undefined;
}

const EFFECTIVE_LINE = /^\d{6}-\d{6}$/;
const SIGNATURE_LINE = /^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}(?=\s|$)/;

/**
 * The effective time and signature a raw-text advisory (an operations plan, a required reroute)
 * prints as the last non-blank lines of its text, `012131-012359` then
 * `26/10/01 21:31  DCCOPS.lxstn35`, in the shape the labelled cells carry: whichever of the last
 * two lines is exactly `DDHHMM-DDHHMM`, and the last line's `YY/MM/DD HH:MM` prefix.
 */
function trailingTimes(text: string): {
  effectiveTime: string | undefined;
  sentAt: string | undefined;
} {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  const effectiveTime = [lines.at(-2) ?? '', last].find((line) => EFFECTIVE_LINE.test(line));
  const sentAt = SIGNATURE_LINE.exec(last)?.[0];
  return { effectiveTime, sentAt };
}

/**
 * Reads one advisory page. No title and no text block with the database's "NO Advisory." marker
 * is a miss; a title without a text block means the layout changed; a page with none of the
 * three is not an advisory page at all (an error or maintenance page) and reads as unavailable.
 * The effective time and signature come from their labelled cells, or, for a field whose cell the
 * page lacks, from the last lines of the text.
 */
export function parseAdvisoryPage(html: string, url: string): AdvisoryPage {
  const titleCell = element(html, HEADER_CELL, 'TH')?.content;
  const title = titleCell === undefined ? undefined : cellText(titleCell) || undefined;
  const pre = element(html, PRE_BLOCK, 'PRE');
  if (!pre) {
    if (title) {
      throw serializationError(
        'The FAA advisory page has a title but no advisory text block, so its layout has changed.',
        { reason: 'advisory_contract_changed', retryable: false, url },
      );
    }
    if (/NO\s+Advisory\./i.test(html)) return { found: false };
    throw serviceUnavailable(
      'The FAA advisories database returned a page that is neither an advisory nor its "NO Advisory." notice, likely an error or maintenance page.',
      { reason: 'advisory_service_unavailable', url },
    );
  }
  const text = decodeEntities(pre.content).trim();
  const afterText = html.slice(pre.end);
  const titleParts = title ? splitTitle(title) : undefined;
  let effectiveTime = labelledValue(afterText, 'EFFECTIVE TIME');
  let sentAt = labelledValue(afterText, 'SIGNATURE');
  if (!effectiveTime || !sentAt) {
    const trailing = trailingTimes(text);
    effectiveTime ??= trailing.effectiveTime;
    sentAt ??= trailing.sentAt;
  }
  return {
    found: true,
    ...(title && { title }),
    ...titleParts,
    ...(effectiveTime && { effectiveTime }),
    ...(sentAt && { sentAt }),
    ...(text && { text }),
  };
}

const CAPTION_CELL = /<TH\s+class=["']?caption["']?[^<>]*>/i;
const ROW = /<TR\b[^<>]*>/i;
const CELL = /<TD\b[^<>]*>/i;
const LINE_BREAK = /<BR\s*\/?>/i;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i;
const NO_MATCH = /NO\s+ADVISORIES\s+MATCH\s+YOUR\s+SELECTION/i;
const SEND_TIME = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;

/**
 * A `MM/DD/YY HH:MM` send time (UTC) as ISO 8601, in the century that puts it nearest the
 * advisory's own date; undefined unless it names a real minute.
 */
function sendTime(value: string, advisoryDate: string): string | undefined {
  const match = SEND_TIME.exec(value);
  if (!match) return;
  const [, month, day, yy, hour, minute] = match;
  const advisoryYear = Number(advisoryDate.slice(0, 4));
  const year = advisoryYear + ((Number(yy) - (advisoryYear % 100) + 150) % 100) - 50;
  const iso = `${String(year).padStart(4, '0')}-${month}-${day}T${hour}:${minute}:00Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso.replace('Z', '.000Z')
    ? iso
    : undefined;
}

/**
 * One index row from its cells: NUMBER (whose link's href carries the advisory number and date),
 * CONTROL ELEMENT, DATE (the date typed in the title, not read), BRIEF TITLE, SEND TIME. A row
 * whose href lacks an advisory number in 1–999 or a real calendar date is unreadable; the link text
 * and other attributes are never read for either.
 */
function indexRow([numberCell = '', elementCell = '', , titleCell = '', sendCell = '']: string[]):
  | AdvisoryIndexRow
  | undefined {
  const [, doubleQuoted, singleQuoted, bare] = HREF.exec(numberCell) ?? [];
  const href = doubleQuoted ?? singleQuoted ?? bare;
  const ref = parseAdvisoryLink(href && decodeEntities(href));
  if (!ref) return;
  const controlElement = cellText(elementCell);
  const [first, ...details] = titleCell.split(LINE_BREAK).map(cellText).filter(Boolean);
  const subject = first && (splitTitle(first)?.subject ?? first);
  const sentAt = sendTime(cellText(sendCell), ref.date);
  return {
    number: ref.number,
    date: ref.date,
    ...(controlElement && { controlElement }),
    ...(subject && { subject }),
    ...(details.length > 0 && { details }),
    ...(sentAt && { sentAt }),
  };
}

/**
 * Reads an advisory index page: every row of the result table that opens at the first caption
 * (one caption for the whole date, or one per category table), newest first. A row without an
 * advisory link is skipped and counted. No caption means the page is not an index at all (an error
 * or maintenance page) and reads as unavailable. A caption with neither an advisory row nor the
 * no-match notice under it, or rows none of which is readable, means the layout changed.
 */
export function parseAdvisoryIndex(html: string, url: string): AdvisoryIndex {
  const caption = CAPTION_CELL.exec(html);
  if (!caption) {
    throw serviceUnavailable(
      'The FAA advisories database returned a page that is neither an advisory index nor its no-match notice, likely an error or maintenance page.',
      { reason: 'advisory_service_unavailable', url },
    );
  }
  const tableEnd = /<\/TABLE>/gi;
  tableEnd.lastIndex = caption.index;
  const table = html.slice(caption.index, tableEnd.exec(html)?.index ?? html.length);
  const rows: AdvisoryIndexRow[] = [];
  let skippedRows = 0;
  let emptyCaptions = 0;
  for (const captioned of sections(table, CAPTION_CELL)) {
    let advisoryRows = 0;
    for (const row of sections(captioned, ROW)) {
      const cells = sections(row, CELL);
      // Caption, column-header, and no-match rows hold TH cells only.
      if (cells.length === 0) continue;
      advisoryRows++;
      const parsed = indexRow(cells);
      if (parsed) rows.push(parsed);
      else skippedRows++;
    }
    if (advisoryRows === 0 && !NO_MATCH.test(captioned)) emptyCaptions++;
  }
  if (emptyCaptions > 0 || (rows.length === 0 && skippedRows > 0)) {
    throw serializationError(
      'The FAA advisory index has its caption but no readable advisory row, so its layout has changed.',
      { reason: 'advisory_contract_changed', retryable: false, url },
    );
  }
  rows.sort((a, b) => b.number - a.number);
  return { rows, skippedRows };
}

/** Client for ATCSCC advisory pages and the per-date advisory index. */
export class AdvisoryService implements Disposable {
  private readonly client: FaaHttpClient;
  private readonly indexes: TtlCache;
  private readonly now: () => number;
  private readonly pages: TtlCache;

  constructor(options: HttpServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pages = new TtlCache(this.now, MAX_CACHED_PAGES);
    this.indexes = new TtlCache(this.now, MAX_CACHED_INDEXES);
    this.client = new FaaHttpClient(PROFILE, options);
  }

  /** One advisory by number and UTC date (`YYYY-MM-DD`). */
  getAdvisory(advisoryNumber: number, date: string, ctx: Context): Promise<AdvisoryPage> {
    const url = buildAdvisoryUrl(advisoryNumber, date);
    return this.pages.get(
      `${date}/${advisoryNumber}`,
      async () => {
        const page = await this.client.request({
          context: this.logContext('AdvisoryService.getAdvisory', ctx),
          errorData: { url },
          operation: PROFILE.service,
          parse: (html) => parseAdvisoryPage(html, url),
          url,
        });
        const ttlMs = page.found || this.isSettled(date) ? FINAL_TTL_MS : OPEN_TTL_MS;
        return { ttlMs, value: structuredClone(page) };
      },
      ctx.signal,
    );
  }

  /**
   * The ATCSCC advisories issued on one UTC date (`YYYY-MM-DD`), newest first. `categories`
   * narrows the read to those category tables, and an empty list reads every advisory, as none
   * does; each date and category set is its own cache entry.
   */
  listAdvisories(
    date: string,
    categories: readonly AdvisoryCategory[] | undefined,
    ctx: Context,
  ): Promise<AdvisoryIndex> {
    const url = buildAdvisoryIndexUrl(date, categories);
    return this.indexes.get(
      url,
      async () => {
        const index = await this.client.request({
          context: this.logContext('AdvisoryService.listAdvisories', ctx),
          errorData: { url },
          operation: PROFILE.service,
          parse: (html) => parseAdvisoryIndex(html, url),
          url,
        });
        const ttlMs = this.isSettled(date) ? FINAL_TTL_MS : OPEN_TTL_MS;
        return { ttlMs, value: structuredClone(index) };
      },
      ctx.signal,
    );
  }

  dispose(): void {
    this.client.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  /** Whether the UTC day `date` ended over an hour ago, so no advisory can join it. */
  private isSettled(date: string): boolean {
    return date < utcDate(this.now() - DATE_SETTLES_AFTER_MS);
  }

  /** Log context of the caller that starts a shared load. */
  private logContext(operation: string, ctx: Context): RequestContext {
    return {
      operation,
      requestId: ctx.requestId,
      timestamp: new Date(this.now()).toISOString(),
      ...(ctx.traceId && { traceId: ctx.traceId }),
    };
  }
}

// --- Init/accessor ---

let service: AdvisoryService | undefined;

/** Constructs the singleton; called from `createApp({ setup })`. */
export function initAdvisoryService(options: HttpServiceOptions = {}): AdvisoryService {
  service = new AdvisoryService(options);
  return service;
}

/** The singleton; throws when `initAdvisoryService()` has not run. */
export function getAdvisoryService(): AdvisoryService {
  if (!service) {
    throw new Error('AdvisoryService not initialized — call initAdvisoryService() in setup()');
  }
  return service;
}
