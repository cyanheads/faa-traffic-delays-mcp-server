/**
 * @fileoverview The upstream failure classes every feed tool must surface with its declared
 * error reason: outage, maintenance page, malformed body, moved path, rate limit, hung upstream.
 * Each case says how the fake upstream misbehaves and which `data.reason` and code result.
 * @module tests/helpers/feed-failures
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { vi } from 'vitest';
import { hangUntilAborted, htmlResponse, jsonResponse, type Responder } from './faa-fakes.js';

export interface FeedFailureCase {
  code: number;
  label: string;
  reason: string;
  respond: Responder;
}

export const FEED_FAILURES: FeedFailureCase[] = [
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    label: 'HTTP 503 outage',
    reason: 'feed_unavailable',
    respond: () => new Response('down', { status: 503 }),
  },
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    label: '200 HTML maintenance page',
    reason: 'feed_unavailable',
    respond: () => htmlResponse('<html>Maintenance</html>'),
  },
  {
    code: JsonRpcErrorCode.ServiceUnavailable,
    label: 'truncated JSON body',
    reason: 'feed_unavailable',
    respond: () => jsonResponse('[{"airportId": "SE'),
  },
  {
    code: JsonRpcErrorCode.SerializationError,
    label: 'HTTP 404 on the known path',
    reason: 'feed_contract_changed',
    respond: () => new Response('Website Unavailable', { status: 404 }),
  },
  {
    code: JsonRpcErrorCode.RateLimited,
    label: 'HTTP 429 with a long Retry-After',
    reason: 'upstream_rate_limited',
    respond: () => new Response('slow', { headers: { 'retry-after': '300' }, status: 429 }),
  },
  {
    code: JsonRpcErrorCode.Timeout,
    label: 'hung upstream',
    reason: 'retry_deadline_exceeded',
    respond: hangUntilAborted,
  },
];

/** Runs `run` under fake timers, advancing past the whole retry ladder. Enable fake timers first. */
export async function withLadder<T>(run: () => Promise<T>): Promise<T> {
  const pending = run();
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  const settled = await outcome;
  if ('error' in settled) throw settled.error;
  return settled.value;
}
