/**
 * @fileoverview faa_delays_list_advisories — the ATCSCC advisories issued on one UTC date, newest
 * first, from the advisories database's per-date index: number, control element, subject, further
 * title lines, and send time per row. Categories narrow the index the FAA returns; a control
 * element filters it here, and limit and offset page the result. Each row's number and date open
 * the full text with faa_delays_get_advisory.
 * @module mcp-server/tools/definitions/list-advisories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ADVISORY_CATEGORIES, type AdvisoryCategory } from '@/services/advisory/advisory-ref.js';
import { getAdvisoryService } from '@/services/advisory/advisory-service.js';
import { resolveAirportCode } from '@/services/airport-directory/airport-directory.js';
import { AdvisoryDateSchema, normalizeDate } from '../advisory-date.js';
import { inline } from '../format-helpers.js';

const AdvisoryCategorySchema = z
  .enum(ADVISORY_CATEGORIES)
  .describe('ATCSCC advisory index category.');

const CATEGORY_ALIASES: ReadonlyMap<string, AdvisoryCategory> = new Map<string, AdvisoryCategory>([
  ['afp', 'airspace_flow_program'],
  ['gdp', 'ground_delay_program'],
  ['gs', 'ground_stop'],
]);

/** Trimmed, lowercased, `-`/space → `_`, and the gs/gdp/afp aliases expanded. */
function normalizeCategory(item: string): string {
  const normalized = item
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return CATEGORY_ALIASES.get(normalized) ?? normalized;
}

/**
 * Drops duplicates, then cuts to one past the category count. A distinct list longer than the
 * category count names an invalid category within that many entries, so the cut never changes
 * whether it validates, and an oversized list fails with a handful of issues rather than one per
 * value sent.
 */
const distinctBounded = (values: unknown[]): unknown[] =>
  [...new Set(values)].slice(0, ADVISORY_CATEGORIES.length + 1);

/**
 * Splits on commas first: a piece naming one category stays whole (`ground stop`), and any other
 * piece splits on whitespace (`gs gdp`). Every value comes back normalized.
 */
function splitCategories(value: string): string[] {
  return value.split(',').flatMap((piece) => {
    const whole = normalizeCategory(piece);
    return AdvisoryCategorySchema.safeParse(whole).success
      ? [whole]
      : piece.split(/\s+/).filter(Boolean).map(normalizeCategory);
  });
}

/**
 * A string naming no categories (blank, or only commas) or an empty array → unset; a string is
 * split into categories; each value is normalized, then the list is deduped and bounded. Anything
 * else reaches the enum and fails with its options listed.
 */
function normalizeCategories(value: unknown): unknown {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    const categories = splitCategories(value);
    return categories.length > 0 ? distinctBounded(categories) : undefined;
  }
  if (!Array.isArray(value)) return value;
  if (value.length === 0) return;
  return distinctBounded(
    value.map((item) => (typeof item === 'string' ? normalizeCategory(item) : item)),
  );
}

/** A blank or null date means today; anything else is normalized for the date schema. */
function normalizeOptionalDate(value: unknown): unknown {
  const normalized = normalizeDate(value);
  return normalized === '' || normalized === null ? undefined : normalized;
}

/** Trimmed and uppercased; a blank or null value is unset. */
function normalizeControlElement(value: unknown): unknown {
  if (value === null) return;
  return typeof value === 'string' ? value.trim().toUpperCase() || undefined : value;
}

/** Whether a control element is `code` whole, or holds it as a `/`- or space-separated part. */
function hasControlElement(controlElement: string | undefined, code: string): boolean {
  if (!controlElement) return false;
  const element = controlElement.toUpperCase();
  return element === code || element.split(/[\s/]+/).includes(code);
}

const AdvisoryRowSchema = z
  .object({
    number: z
      .number()
      .int()
      .describe(
        'ATCSCC advisory number; pass it as advisory_number to faa_delays_get_advisory for the full text.',
      ),
    date: z
      .string()
      .describe('Advisory UTC date, YYYY-MM-DD; pass it as date to faa_delays_get_advisory.'),
    controlElement: z
      .string()
      .optional()
      .describe(
        'Airport/ARTCC pair or facility the advisory concerns, as the FAA lists it (BOS/ZBW, DCC for national advisories); absent when the index lists none.',
      ),
    subject: z
      .string()
      .optional()
      .describe(
        'First line of the brief title (FAA-authored) without its ATCSCC ADVZY prefix, e.g. CDM PROPOSED GROUND DELAY PROGRAM or ROUTE RQD /FL.',
      ),
    details: z
      .array(z.string())
      .optional()
      .describe(
        "Further brief-title lines (FAA-authored): a reroute's or flow constrained area's name, constrained area, and valid period.",
      ),
    sentAt: z.string().optional().describe('When the advisory was sent, ISO 8601 UTC.'),
  })
  .describe('One advisory from the index.');

export const listAdvisories = tool('faa_delays_list_advisories', {
  title: 'List ATCSCC Advisories',
  description:
    "List the ATCSCC advisories issued on one UTC date, newest first, from the FAA advisories database's per-date index: ground stops and delay programs as issued, proposed, revised, and canceled, required reroutes, flow constrained areas, operations plans, and CDM compression advisories, including those no longer active and those on past dates, which the NAS Status feed does not carry. Each row gives the advisory number, control element, subject, any further title lines (a reroute's name, constrained area, and valid period), and send time; its number and date open the full text with faa_delays_get_advisory. Narrow by categories or by control_element (an airport, its ICAO code, an ARTCC, or DCC for national advisories), and page with limit and offset.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    date: z
      .preprocess(normalizeOptionalDate, AdvisoryDateSchema.optional())
      .describe(
        'UTC date to list, YYYY-MM-DD; MM/DD/YYYY and M/D/YYYY are also accepted. Omit for today (UTC). No later than tomorrow (UTC); past dates remain available.',
      ),
    categories: z
      .preprocess(normalizeCategories, z.array(AdvisoryCategorySchema).optional())
      .describe(
        'Only advisories the FAA files under these categories: ground_stop, ground_delay_program, airspace_flow_program, ctop, route, other (flow constrained areas and operations plans file under other). Also accepts gs, gdp, afp, spelled-out names such as "ground stop", and a comma-separated string; case-insensitive. Omit for every advisory, including CDM compression advisories, which the FAA files under no category.',
      ),
    control_element: z
      .preprocess(normalizeControlElement, z.string().max(64).optional())
      .describe(
        'Only advisories whose control element is this facility or lists it as a part: an airport by FAA identifier (ORD) or ICAO code (KORD), an ARTCC (ZAU), a pair (ORD/ZAU or KORD/ZAU), or DCC for national advisories such as reroutes and the operations plan. Case-insensitive. Airports named only in a subject or details do not match.',
      ),
    limit: z.number().int().min(1).max(200).default(50).describe('Advisories per page, 1–200.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Matching advisories to skip, for paging: nextOffset from the previous page.'),
  }),
  output: z.object({
    date: z.string().describe('The UTC date read, YYYY-MM-DD; today (UTC) when date was omitted.'),
    advisories: z
      .array(AdvisoryRowSchema)
      .describe(
        'Advisories issued on date that match categories and control_element, newest first: up to limit of them, starting at offset.',
      ),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe('offset of the next page; present while matching advisories remain past this one.'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .int()
      .describe('Advisories on date that match categories and control_element, before paging.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when matching advisories remain past this page; absent otherwise.'),
    shown: z
      .number()
      .int()
      .optional()
      .describe('Advisories on this page; present only when more remain.'),
    cap: z
      .number()
      .int()
      .optional()
      .describe('The limit applied; present only when more advisories remain.'),
    appliedCategories: z
      .array(AdvisoryCategorySchema)
      .optional()
      .describe(
        'The categories filter as the server normalized it; absent when omitted, which reads every advisory, uncategorized ones included.',
      ),
    appliedControlElement: z
      .string()
      .optional()
      .describe(
        'The control_element filter as the server matched it: uppercased, each ICAO airport code in it mapped to its FAA identifier (KORD → ORD, KORD/ZAU → ORD/ZAU); absent when omitted.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on an empty date, a filter that matched nothing, an offset past the end, more pages, and index rows that could not be read.',
      ),
  },
  enrichmentTrailer: {
    // Rendered only when enriched, so never with an absent value.
    appliedCategories: {
      render: (categories: AdvisoryCategory[]) => `**Categories:** ${categories.join(', ')}`,
    },
    appliedControlElement: {
      render: (element: string) => `**Control element:** ${inline(element)}`,
    },
  },
  errors: [
    {
      reason: 'advisory_service_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'FAA advisories database unreachable, 5xx, an attempt timeout, or a page that is not an advisory index (an error page), after retries',
      recovery:
        'The FAA advisories database is temporarily unreachable; call faa_delays_list_advisories again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The advisories host returned 429 after retries, or this server's queue to it would wait past 10 s while backing off from that host's 429",
      recovery:
        "The FAA advisories database is limiting request rate; wait the retryAfter interval in this error's data (about a minute when it carries none), then call faa_delays_list_advisories again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The 20 s retry budget ran out',
      recovery:
        'The FAA advisories database is responding slowly; call faa_delays_list_advisories again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's queue to the advisories host would wait past 10 s with no 429 backoff in effect",
      recovery:
        "This server is pacing its requests to the FAA; wait the retryAfter seconds in this error's data, then call faa_delays_list_advisories again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'advisory_contract_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Advisory index found (caption present) but no row is readable, or the path returned 404/410',
      recovery:
        "The FAA changed the advisory index layout, so calling faa_delays_list_advisories again will not help; faa_delays_get_advisory still reads one advisory by number and UTC date (numbers restart at 1 each UTC day), and the index opens in a browser at the url in this error's data.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    const { categories, limit, offset } = input;
    // Each `/`- or space-separated ICAO airport part as its FAA identifier: KORD/ZAU → ORD/ZAU.
    const element = input.control_element?.replace(
      /[^\s/]+/g,
      (part) => resolveAirportCode(part)?.faaId ?? part,
    );

    const index = await getAdvisoryService().listAdvisories(date, categories, ctx);
    const matching = element
      ? index.rows.filter((row) => hasControlElement(row.controlElement, element))
      : index.rows;
    const advisories = matching.slice(offset, offset + limit);
    const end = offset + advisories.length;
    const nextOffset = end < matching.length ? end : undefined;

    ctx.enrich.total(matching.length);
    ctx.enrich({
      ...(categories && { appliedCategories: categories }),
      ...(element && { appliedControlElement: element }),
    });

    const notices: string[] = [];
    const inCategories = categories ? ` in ${categories.join(' or ')}` : '';
    if (index.rows.length === 0) {
      notices.push(
        categories
          ? `No ATCSCC advisories${inCategories} were issued on ${date} (UTC). Call faa_delays_list_advisories without categories to list every advisory issued that day.`
          : `The FAA advisories database lists no ATCSCC advisories issued on ${date} (UTC).`,
      );
    } else if (element && matching.length === 0) {
      notices.push(
        `No advisory${inCategories} issued on ${date} (UTC) has control element ${inline(element)}, out of ${index.rows.length} read. Call faa_delays_list_advisories without control_element to list them.`,
      );
    } else if (offset >= matching.length) {
      notices.push(
        `offset ${offset} is past the last matching advisory (totalCount ${matching.length}). Call faa_delays_list_advisories with an offset below ${matching.length}, or 0 for the first page.`,
      );
    }
    if (index.skippedRows > 0) {
      notices.push(
        index.skippedRows === 1
          ? '1 FAA advisory index row could not be read and was skipped.'
          : `${index.skippedRows} FAA advisory index rows could not be read and were skipped.`,
      );
    }
    if (nextOffset !== undefined) {
      const remaining = matching.length - nextOffset;
      notices.push(
        `${remaining === 1 ? '1 more advisory matches' : `${remaining} more advisories match`}; call faa_delays_list_advisories again with offset ${nextOffset} for the next page.`,
      );
      ctx.enrich.truncated({ shown: advisories.length, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('Advisories listed', { date, shown: advisories.length, total: matching.length });
    return { date, advisories, ...(nextOffset !== undefined && { nextOffset }) };
  },

  format: (result) => {
    const lines = [`## ATCSCC advisories · ${result.date}`, ''];
    if (result.advisories.length === 0) lines.push('No advisories on this page.');
    for (const advisory of result.advisories) {
      const parts = [
        `**ADVZY ${advisory.number}**`,
        ...(advisory.date === result.date ? [] : [advisory.date]),
        advisory.controlElement ? inline(advisory.controlElement) : 'control element not listed',
        ...(advisory.subject ? [inline(advisory.subject)] : []),
        ...(advisory.sentAt ? [`sent ${inline(advisory.sentAt)}`] : []),
      ];
      lines.push(`- ${parts.join(' · ')}`);
      if (advisory.details) lines.push(`  - Details: ${advisory.details.map(inline).join(' · ')}`);
    }
    if (result.nextOffset !== undefined) lines.push('', `**Next offset:** ${result.nextOffset}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
