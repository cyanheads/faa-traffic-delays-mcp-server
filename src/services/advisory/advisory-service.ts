/**
 * @fileoverview ATCSCC advisories database client (`https://www.fly.faa.gov/adv/adv_otherdis`):
 * fetches one advisory page by number and UTC date through the paced, retried fetch boundary and
 * reads its title, text block, effective time, and signature. Issued advisories, and misses on a UTC
 * date over for an hour, are cached for 6 h (neither can change); other misses for 60 s; at most
 * 200 entries.
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
import { buildAdvisoryUrl } from './advisory-ref.js';

const FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 60_000;
const MAX_CACHED = 200;
/** How long after a UTC day ends before a miss on that date is final, allowing for late entry. */
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

const TITLE_PATTERN = /^ATCSCC ADVZY (\d+) (\S+) (\d{2}\/\d{2}\/\d{4}) (.+)$/;

/**
 * Reads one advisory page. No title and no text block with the database's "NO Advisory." marker
 * is a miss; a title without a text block means the layout changed; a page with none of the
 * three is not an advisory page at all (an error or maintenance page) and reads as unavailable.
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
  const titleMatch = title ? TITLE_PATTERN.exec(title) : null;
  const effectiveTime = labelledValue(afterText, 'EFFECTIVE TIME');
  const sentAt = labelledValue(afterText, 'SIGNATURE');
  return {
    found: true,
    ...(title && { title }),
    ...(titleMatch?.[2] && { controlElement: titleMatch[2] }),
    ...(titleMatch?.[4] && { subject: titleMatch[4] }),
    ...(effectiveTime && { effectiveTime }),
    ...(sentAt && { sentAt }),
    ...(text && { text }),
  };
}

/** Client for single ATCSCC advisory pages. */
export class AdvisoryService implements Disposable {
  private readonly cache: TtlCache;
  private readonly client: FaaHttpClient;
  private readonly now: () => number;

  constructor(options: HttpServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache(this.now, MAX_CACHED);
    this.client = new FaaHttpClient(PROFILE, options);
  }

  /** One advisory by number and UTC date (`YYYY-MM-DD`). */
  getAdvisory(advisoryNumber: number, date: string, ctx: Context): Promise<AdvisoryPage> {
    const url = buildAdvisoryUrl(advisoryNumber, date);
    return this.cache.get(
      `${date}/${advisoryNumber}`,
      async () => {
        const context: RequestContext = {
          operation: 'AdvisoryService.getAdvisory',
          requestId: ctx.requestId,
          timestamp: new Date(this.now()).toISOString(),
          ...(ctx.traceId && { traceId: ctx.traceId }),
        };
        const page = await this.client.request({
          context,
          errorData: { url },
          operation: PROFILE.service,
          parse: (html) => parseAdvisoryPage(html, url),
          url,
        });
        const settled = date < utcDate(this.now() - DATE_SETTLES_AFTER_MS);
        return { ttlMs: page.found || settled ? FOUND_TTL_MS : MISS_TTL_MS, value: page };
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
