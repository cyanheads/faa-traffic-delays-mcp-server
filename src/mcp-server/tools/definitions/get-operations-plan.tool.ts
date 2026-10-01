/**
 * @fileoverview faa_delays_get_operations_plan — the ATCSCC operations plan: terminal and en-route
 * programs the FAA expects later in the day, each with its planned UTC time and stated likelihood,
 * plus current Command Center announcements. The announcements leg degrades rather than failing
 * the call.
 * @module mcp-server/tools/definitions/get-operations-plan
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNasStatusService } from '@/services/nas-status/nas-status-service.js';
import { advisoryLine, blockquote, inline } from '../format-helpers.js';
import { AdvisoryRefSchema } from '../schemas.js';

const PlannedItemSchema = z
  .object({
    text: z
      .string()
      .describe(
        'The planned item as the FAA wrote it, tabs flattened and the leading dash removed (FAA-authored).',
      ),
    timeQualifier: z
      .enum(['after', 'until', 'by', 'between'])
      .optional()
      .describe(
        'How the planned time bounds the item, parsed from the start of the text; for between, timeUtc is the start of the window and its end stays in text.',
      ),
    timeUtc: z
      .string()
      .optional()
      .describe(
        'Planned time as HHMM UTC with no date; the plan covers the UTC day of its advisory.',
      ),
    likelihood: z
      .enum(['possible', 'probable', 'expected'])
      .optional()
      .describe(
        "The FAA's stated likelihood: possible (<30 %), probable (30–60 %), or expected (most likely). Absent when the text states none.",
      ),
  })
  .describe('One planned program or initiative.');

type PlannedItem = z.infer<typeof PlannedItemSchema>;

/** `after 1100 UTC · possible` — the parsed time and likelihood of one planned item. */
function plannedMeta(item: PlannedItem): string {
  const time = item.timeUtc
    ? `${item.timeQualifier ? `${item.timeQualifier} ` : ''}${inline(item.timeUtc)} UTC`
    : undefined;
  const parts = [time, item.likelihood].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'no time or likelihood stated';
}

function renderPlanned(heading: string, items: PlannedItem[]): string[] {
  const lines = ['', `## ${heading} (${items.length})`];
  if (items.length === 0) return [...lines, '', 'None listed.'];
  items.forEach((item, index) => {
    lines.push('', `${index + 1}. ${plannedMeta(item)}`, blockquote(item.text));
  });
  return lines;
}

export const getOperationsPlan = tool('faa_delays_get_operations_plan', {
  title: 'faa_delays_get_operations_plan',
  description:
    "Get the FAA Command Center's current operations plan: terminal programs (possible ground stops and delay programs by airport) and en-route initiatives (route closures, severe-weather avoidance plans) expected later in the day, each with its planned UTC time and stated likelihood, plus current ATCSCC announcements. The advisory reference opens the full plan text with faa_delays_get_advisory, including active constraints and runway closures this summary omits.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({}),
  output: z.object({
    fetchedAt: z
      .string()
      .describe(
        'When this server fetched the operations plan from the FAA (UTC ISO); with the 60 s cache it can trail the call by up to a minute.',
      ),
    advisory: AdvisoryRefSchema.optional(),
    terminalPlanned: z
      .array(PlannedItemSchema)
      .describe(
        'Terminal programs the FAA expects later today: possible ground stops and delay programs by airport, in plan order.',
      ),
    enRoutePlanned: z
      .array(PlannedItemSchema)
      .describe(
        'En-route initiatives the FAA expects later today: route closures, severe-weather avoidance plans (SWAP), and coded departure routes (CDRs), in plan order.',
      ),
    announcements: z
      .array(
        z
          .object({
            text: z.string().describe('Announcement text (FAA-authored).'),
          })
          .describe('One ATCSCC announcement.'),
      )
      .optional()
      .describe(
        'Current ATCSCC announcements; [] when there are none, absent when that FAA list could not be read.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance on an empty plan, a missing advisory link, or partial data.'),
  },
  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NAS Status unreachable, 5xx, an attempt timeout, or an HTML maintenance page, after retries',
      recovery:
        'The FAA NAS Status feed is temporarily unreachable; call faa_delays_get_operations_plan again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The FAA returned 429 after retries',
      recovery:
        "The FAA feed is limiting request rate; wait the retryAfter interval in this error's data (about a minute when it carries none), then call faa_delays_get_operations_plan again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The 20 s retry budget ran out',
      recovery:
        'The FAA NAS Status feed is responding slowly; call faa_delays_get_operations_plan again in about a minute.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own queue to the FAA would wait past 10 s",
      recovery:
        "This server is pacing its requests to the FAA; wait the retryAfter seconds in this error's data, then call faa_delays_get_operations_plan again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'feed_contract_changed',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The feed path returned 404/410, or a body whose shape this server no longer recognizes',
      recovery:
        "The FAA NAS Status feed is not serving the format this server reads, which usually means the FAA changed it, so an immediate retry will not help; faa_delays_get_advisory still reads ATCSCC advisories, numbered from 1 each UTC day, so today's operations plan advisory can be found by advisory_number with today's UTC date.",
      retryable: false,
      thrownBy: 'service',
    },
  ],

  async handler(_input, ctx) {
    const nas = getNasStatusService();
    const [planResult, announcementsResult] = await Promise.allSettled([
      nas.getOperationsPlan(ctx),
      nas.getAnnouncements(ctx),
    ]);
    if (planResult.status === 'rejected') throw planResult.reason;
    if (announcementsResult.status === 'rejected' && ctx.signal.aborted) {
      throw announcementsResult.reason;
    }

    const plan = planResult.value;
    const announcements =
      announcementsResult.status === 'fulfilled'
        ? announcementsResult.value.rows.map((text) => ({ text }))
        : undefined;

    const notices: string[] = [];
    if (plan.terminalPlanned.length === 0 && plan.enRoutePlanned.length === 0) {
      notices.push(
        'The operations plan lists no planned programs. faa_delays_list_active_events shows what is active now.',
      );
    }
    if (!plan.advisory) notices.push('The feed carried no advisory link for this plan.');
    if (announcementsResult.status === 'rejected') {
      ctx.log.warning('Announcements leg failed; omitting announcements', {
        error:
          announcementsResult.reason instanceof Error
            ? announcementsResult.reason.message
            : String(announcementsResult.reason),
      });
      notices.push(
        'ATCSCC announcements are omitted because that FAA list could not be read; the operations plan above is complete.',
      );
    }
    const skipped =
      plan.skippedRows +
      (announcementsResult.status === 'fulfilled' ? announcementsResult.value.skippedRows : 0);
    if (skipped > 0) notices.push(`${skipped} FAA feed rows could not be read and were skipped.`);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Operations plan read', {
      announcements: announcements?.length ?? 'unavailable',
      enRoute: plan.enRoutePlanned.length,
      terminal: plan.terminalPlanned.length,
    });
    return {
      fetchedAt: plan.fetchedAt,
      ...(plan.advisory && { advisory: plan.advisory }),
      terminalPlanned: plan.terminalPlanned,
      enRoutePlanned: plan.enRoutePlanned,
      ...(announcements && { announcements }),
    };
  },

  format: (result) => {
    const lines = [`**Fetched:** ${result.fetchedAt}`];
    lines.push(
      result.advisory
        ? `**Plan advisory:** ${advisoryLine(result.advisory)}`
        : '**Plan advisory:** none linked',
    );
    lines.push(...renderPlanned('Terminal planned', result.terminalPlanned));
    lines.push(...renderPlanned('En-route planned', result.enRoutePlanned));
    if (result.announcements) {
      lines.push('', `## ATCSCC announcements (${result.announcements.length})`);
      if (result.announcements.length === 0) lines.push('', 'None.');
      for (const announcement of result.announcements) {
        lines.push('', blockquote(announcement.text));
      }
    } else {
      lines.push(
        '',
        '## ATCSCC announcements',
        '',
        'Not available: that FAA list could not be read.',
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
