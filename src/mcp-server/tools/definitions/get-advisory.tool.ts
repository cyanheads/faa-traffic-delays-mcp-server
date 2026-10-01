/**
 * @fileoverview faa_delays_get_advisory — the full text of one ATCSCC advisory by number and UTC
 * date: program rate, delay assignment mode, scope, comments, and the operations plan's active
 * constraints, which the status feed omits. A number the database does not hold for that date
 * returns `found: false` with guidance rather than an error.
 * @module mcp-server/tools/definitions/get-advisory
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { buildAdvisoryUrl } from '@/services/advisory/advisory-ref.js';
import { getAdvisoryService } from '@/services/advisory/advisory-service.js';
import { fenced, inline } from '../format-helpers.js';

/** Longest advisory text returned; above every probed advisory. */
const TEXT_CAP = 50_000;

/** `"ADVZY 082"` / `"082"` → `82`; any other value passes through to the schema unchanged. */
function stripAdvzy(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = value
    .trim()
    .replace(/^ADVZY/i, '')
    .trim();
  return /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : value;
}

/**
 * Trims, and rewrites `MM/DD/YYYY` (the form advisory titles print), or its unpadded `M/D/YYYY`, to
 * `YYYY-MM-DD`.
 */
function normalizeDate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .trim()
    .replace(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      (_, month: string, day: string, year: string) =>
        `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    );
}

export const getAdvisory = tool('faa_delays_get_advisory', {
  title: 'faa_delays_get_advisory',
  description:
    "Get the full text of one ATCSCC advisory by its number and UTC date, read from the advisory reference that faa_delays_list_active_events and faa_delays_get_airport_status return on program rows and faa_delays_get_operations_plan returns for the plan. Advisory text carries what the status feed omits: program rate by hour, delay assignment mode, scope, comments, and the operations plan's active constraints and runway closures. Advisory numbers restart at 1 each UTC day, and older advisories remain available.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    advisory_number: z
      .preprocess(stripAdvzy, z.number().int().min(1).max(999))
      .describe(
        'ATCSCC advisory number, 1–999: advisory.number from an advisory reference on faa_delays_list_active_events, faa_delays_get_airport_status, or faa_delays_get_operations_plan. The printed forms "ADVZY 082" and "082" are also accepted.',
      ),
    date: z
      .preprocess(
        normalizeDate,
        z.iso.date({ error: 'Must be a real UTC date as YYYY-MM-DD, MM/DD/YYYY, or M/D/YYYY.' }),
      )
      .describe(
        'UTC date the advisory was issued, YYYY-MM-DD: advisory.date from the same advisory reference. MM/DD/YYYY, as advisory titles print it, and M/D/YYYY are also accepted.',
      ),
  }),
  inputAliases: { number: 'advisory_number' },
  output: z.object({
    found: z
      .boolean()
      .describe('Whether the FAA advisories database holds this advisory number on this UTC date.'),
    advisoryNumber: z.number().int().describe('The advisory number read.'),
    date: z.string().describe('The advisory UTC date read, YYYY-MM-DD.'),
    url: z
      .string()
      .describe('Server-built advisory URL this tool read; it also opens in a browser.'),
    title: z
      .string()
      .optional()
      .describe(
        'Advisory title line as the FAA prints it (FAA-authored), e.g. ATCSCC ADVZY 082 DCC 09/29/2026 OPERATIONS PLAN.',
      ),
    controlElement: z
      .string()
      .optional()
      .describe(
        'Airport/ARTCC pair or facility the advisory concerns, parsed from the title (SEA/ZSE, DCC); absent when the title has another form.',
      ),
    subject: z
      .string()
      .optional()
      .describe(
        'Advisory subject parsed from the title (CDM GROUND DELAY PROGRAM, OPERATIONS PLAN); absent when the title has another form.',
      ),
    effectiveTime: z
      .string()
      .optional()
      .describe('Effective period as the FAA prints it, DDHHMM-DDHHMM in UTC.'),
    sentAt: z
      .string()
      .optional()
      .describe('When the advisory was signed, as the FAA prints it: YY/MM/DD HH:MM in UTC.'),
    text: z
      .string()
      .optional()
      .describe(
        'Full advisory text (FAA-authored), cut at 50,000 characters when longer; truncated then reports the cut.',
      ),
    guidance: z
      .string()
      .optional()
      .describe('Present when found is false: where to get a valid advisory number and date.'),
  }),
  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the advisory text was cut at the 50,000-character ceiling; absent otherwise.',
      ),
    shown: z
      .number()
      .int()
      .optional()
      .describe('Characters of advisory text returned; present only when the text was cut.'),
    cap: z
      .number()
      .int()
      .optional()
      .describe('The character ceiling applied; present only when the text was cut.'),
    totalChars: z
      .number()
      .int()
      .optional()
      .describe(
        'Full length of the advisory text in characters; present only when the text was cut.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance on a cut advisory text; present only when the text was cut.'),
  },
  enrichmentTrailer: {
    totalChars: { label: 'Total characters' },
  },
  errors: [
    {
      reason: 'advisory_service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'FAA advisories database unreachable, 5xx, an attempt timeout, or an error page, after retries',
      recovery:
        'The FAA advisories database is temporarily unreachable; call faa_delays_get_advisory again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The advisories host returned 429 after retries',
      recovery:
        "The FAA advisories database is limiting request rate; wait the retryAfter interval in this error's data (about a minute when it carries none), then call faa_delays_get_advisory again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The 20 s retry budget ran out',
      recovery:
        'The FAA advisories database is responding slowly; call faa_delays_get_advisory again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's queue to the advisories host would wait past 10 s",
      recovery:
        "This server is pacing its requests to the FAA; wait the retryAfter seconds in this error's data, then call faa_delays_get_advisory again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'advisory_contract_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Advisory page found (title present) but its text block is missing, or the path returned 404/410',
      recovery:
        "The FAA changed the advisory page layout, so retrying will not help; faa_delays_get_airport_status and faa_delays_list_active_events still report each program's reason, times, and delays, and the advisory opens in a browser at the url in this error's data.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { advisory_number: advisoryNumber, date } = input;
    const page = await getAdvisoryService().getAdvisory(advisoryNumber, date, ctx);
    const url = buildAdvisoryUrl(advisoryNumber, date);

    if (!page.found) {
      ctx.log.info('Advisory not found', { advisoryNumber, date });
      return {
        found: false,
        advisoryNumber,
        date,
        url,
        guidance: `No ATCSCC advisory ${advisoryNumber} exists for ${date} (UTC). Take the number and date from an advisory reference on faa_delays_list_active_events, faa_delays_get_airport_status, or faa_delays_get_operations_plan; numbers restart at 1 each UTC day.`,
      };
    }

    let text = page.text;
    if (text && text.length > TEXT_CAP) {
      ctx.enrich.truncated({
        shown: TEXT_CAP,
        cap: TEXT_CAP,
        guidance: `Advisory text was cut at 50,000 of ${text.length.toLocaleString('en-US')} characters; the full advisory is at the url field.`,
      });
      ctx.enrich({ totalChars: text.length });
      text = text.slice(0, TEXT_CAP);
    }

    ctx.log.info('Advisory read', { advisoryNumber, date, subject: page.subject });
    return {
      found: true,
      advisoryNumber,
      date,
      url,
      ...(page.title && { title: page.title }),
      ...(page.controlElement && { controlElement: page.controlElement }),
      ...(page.subject && { subject: page.subject }),
      ...(page.effectiveTime && { effectiveTime: page.effectiveTime }),
      ...(page.sentAt && { sentAt: page.sentAt }),
      ...(text && { text }),
    };
  },

  format: (result) => {
    const lines = [
      `## ATCSCC advisory ${result.advisoryNumber} · ${result.date}`,
      `**Found:** ${result.found ? 'yes' : 'no'} · **URL:** ${result.url}`,
    ];
    if (result.title) lines.push(`**Title:** ${inline(result.title)}`);
    const parsed = [
      result.controlElement && `**Control element:** ${inline(result.controlElement)}`,
      result.subject && `**Subject:** ${inline(result.subject)}`,
    ].filter(Boolean);
    if (parsed.length > 0) lines.push(parsed.join(' · '));
    const times = [
      result.effectiveTime && `**Effective:** ${inline(result.effectiveTime)}`,
      result.sentAt && `**Sent:** ${inline(result.sentAt)}`,
    ].filter(Boolean);
    if (times.length > 0) lines.push(times.join(' · '));
    if (result.text) lines.push('', fenced(result.text));
    if (result.guidance) lines.push('', result.guidance);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
