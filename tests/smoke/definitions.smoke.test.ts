/**
 * @fileoverview Offline smoke coverage for the shipped tool definitions: the static
 * faa_delays_list_reference topics, faa_delays_get_airport_status rejecting an unknown code
 * before any upstream request, and every tool's rate-limit contract telling a shed during an
 * FAA-started backoff apart from this server's own pacing.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { getAirportStatus } from '@/mcp-server/tools/definitions/get-airport-status.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { listReference } from '@/mcp-server/tools/definitions/list-reference.tool.js';

describe('definition smoke test', () => {
  it.each(['event_types', 'terms', 'artccs', 'identifiers'])(
    'answers the static reference topic %s',
    async (topic) => {
      const ctx = createMockContext({ errors: listReference.errors });
      const result = await listReference.handler(listReference.input.parse({ topic }), ctx);
      const content = listReference.format?.(result);

      expect(result).toEqual(expect.schemaMatching(listReference.output));
      expect(result.topic).toBe(topic);
      expect(content?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining(topic) });
    },
  );

  it('rejects an unknown airport code without calling the FAA', async () => {
    const ctx = createMockContext({ errors: getAirportStatus.errors });
    const input = getAirportStatus.input.parse({ airports: ['SEA', 'ZZZ'] });

    await expect(getAirportStatus.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_airport', unknownCodes: ['ZZZ'] },
    });
  });

  it.each(allToolDefinitions.map((definition) => [definition.name, definition] as const))(
    '%s reports a shed during an FAA 429 backoff as upstream_rate_limited',
    (_name, definition) => {
      const errors = (definition.errors ?? []) as readonly { reason: string; when: string }[];
      const when = (reason: string) => errors.find((entry) => entry.reason === reason)?.when;

      expect(when('upstream_rate_limited')).toMatch(/while backing off from .*429/);
      expect(when('pacer_shed')).toMatch(/with no .*429 backoff in effect/);
    },
  );
});
