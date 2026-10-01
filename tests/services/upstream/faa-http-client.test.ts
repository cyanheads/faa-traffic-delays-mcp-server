/**
 * @fileoverview Tests for FaaHttpClient, the shared fetch boundary: header contract, the
 * 200-only accept-list, HTML maintenance pages, 404/410 as contract changes, 429 handling, retry
 * of transient failures, attempt and deadline timeouts, and error-data propagation.
 * @module tests/services/upstream/faa-http-client.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaaHttpClient, type UpstreamProfile } from '@/services/upstream/faa-http-client.js';
import { htmlResponse, jsonResponse } from '../../helpers/faa-fakes.js';

const URL_UNDER_TEST = 'https://feeds.example.test/data';

const PROFILE: UpstreamProfile = {
  accept: 'application/json',
  contractChangedReason: 'feed_contract_changed',
  htmlIsMaintenance: true,
  pacer: {
    cooldown: { baseMs: 5_000, maxMs: 60_000 },
    limits: [{ perMs: 60_000, requests: 1_000 }],
    maxConcurrent: 4,
    name: 'test-feed',
  },
  service: 'The test feed',
  unavailableReason: 'feed_unavailable',
};

const context: RequestContext = {
  operation: 'test',
  requestId: 'test-request',
  timestamp: new Date(0).toISOString(),
};

type Responder = (init: {
  signal?: AbortSignal | null | undefined;
}) => Promise<Response> | Response;

/** Sequential fake fetch: each call takes the next responder (the last one repeats). */
function fakeFetch(...responders: Responder[]) {
  const seen: { headers: Headers; url: string }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ headers: new Headers(init?.headers), url: String(input) });
    const responder = responders[Math.min(seen.length - 1, responders.length - 1)] as Responder;
    return responder({ signal: init?.signal });
  });
  return { impl: impl as unknown as typeof fetch, mock: impl, seen };
}

function makeClient(fetchImpl: typeof fetch, profile: UpstreamProfile = PROFILE) {
  return new FaaHttpClient(profile, { fetch: fetchImpl, userAgent: 'test-agent/1.0' });
}

const read = (body: string): string => body;

/** Runs `promise` to completion while advancing fake timers past the whole retry ladder. */
async function settle<T>(promise: Promise<T>): Promise<{ error?: unknown; value?: T }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  return outcome;
}

const mcpData = (error: unknown): Record<string, unknown> => {
  expect(error).toBeInstanceOf(McpError);
  return (error as McpError).data ?? {};
};

/** A fetch that only ends when its signal aborts, like a hung upstream. */
const hang: Responder = ({ signal }) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    });
  });

describe('FaaHttpClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful requests', () => {
    it('parses the 200 body and sends the Accept, Accept-Encoding, and User-Agent headers', async () => {
      const { impl, seen } = fakeFetch(() => jsonResponse('{"ok":true}'));
      const client = makeClient(impl);

      const result = await client.request({
        context,
        operation: 'op',
        parse: read,
        url: URL_UNDER_TEST,
      });

      expect(result).toBe('{"ok":true}');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(URL_UNDER_TEST);
      expect(seen[0]?.headers.get('accept')).toBe('application/json');
      expect(seen[0]?.headers.get('accept-encoding')).toBe('gzip');
      expect(seen[0]?.headers.get('user-agent')).toBe('test-agent/1.0');
      client.dispose();
    });

    it('accepts an HTML 200 when the profile does not treat HTML as maintenance', async () => {
      const { impl } = fakeFetch(() => htmlResponse('<html>advisory</html>'));
      const client = makeClient(impl, { ...PROFILE, htmlIsMaintenance: false });

      await expect(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      ).resolves.toBe('<html>advisory</html>');
      client.dispose();
    });

    it('recovers when a transient failure is followed by a 200', async () => {
      const { impl, mock } = fakeFetch(
        () => new Response('busy', { status: 503 }),
        () => jsonResponse('{"ok":true}'),
      );
      const client = makeClient(impl);

      const outcome = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(outcome.value).toBe('{"ok":true}');
      expect(mock).toHaveBeenCalledTimes(2);
      client.dispose();
    });

    it('retries when parsing raises a transient error', async () => {
      const { impl, mock } = fakeFetch(() => jsonResponse('{}'));
      const client = makeClient(impl);
      const parse = vi
        .fn<(body: string) => string>()
        .mockImplementationOnce(() => {
          throw serviceUnavailable('truncated body', { reason: 'feed_unavailable' });
        })
        .mockImplementation((body) => body);

      const outcome = await settle(
        client.request({ context, operation: 'op', parse, url: URL_UNDER_TEST }),
      );

      expect(outcome.value).toBe('{}');
      expect(mock).toHaveBeenCalledTimes(2);
      client.dispose();
    });
  });

  describe('failure classification', () => {
    it('reports a 200 HTML page as unavailable, merging errorData', async () => {
      const { impl, mock } = fakeFetch(() => htmlResponse('<html>Maintenance</html>'));
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({
          context,
          errorData: { feed: 'demo' },
          operation: 'op',
          parse: read,
          url: URL_UNDER_TEST,
        }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(mcpData(error)).toMatchObject({
        feed: 'demo',
        reason: 'feed_unavailable',
        status: 200,
      });
      expect(mock).toHaveBeenCalledTimes(3);
      client.dispose();
    });

    it.each([404, 410])('reads HTTP %i as a contract change and does not retry', async (status) => {
      const { impl, mock } = fakeFetch(
        () => new Response('<html>Website Unavailable</html>', { status }),
      );
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({
          context,
          errorData: { feed: 'demo' },
          operation: 'op',
          parse: read,
          url: URL_UNDER_TEST,
        }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect(mcpData(error)).toMatchObject({
        feed: 'demo',
        reason: 'feed_contract_changed',
        retryable: false,
        status,
      });
      expect(mock).toHaveBeenCalledTimes(1);
      client.dispose();
    });

    it('fails fast with upstream_rate_limited when Retry-After outlasts the retry cap', async () => {
      const { impl, mock } = fakeFetch(
        () => new Response('slow down', { headers: { 'retry-after': '120' }, status: 429 }),
      );
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      expect(mcpData(error)).toMatchObject({ reason: 'upstream_rate_limited' });
      expect(mock).toHaveBeenCalledTimes(1);
      client.dispose();
    });

    it('backs off through the pacer cooldown on a 429 without Retry-After, then reports upstream_rate_limited', async () => {
      const { impl, mock } = fakeFetch(() => new Response('slow down', { status: 429 }));
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      expect(mcpData(error)).toMatchObject({ reason: 'upstream_rate_limited', retryAttempts: 3 });
      expect(mock).toHaveBeenCalledTimes(3);
      client.dispose();
    });

    it('sheds a request the pacer cannot start within 10 s as pacer_shed, without retrying it', async () => {
      const { impl, mock } = fakeFetch(() => jsonResponse('{}'));
      const client = makeClient(impl, {
        ...PROFILE,
        pacer: { ...PROFILE.pacer, limits: [{ perMs: 60_000, requests: 2 }] },
      });
      const request = () =>
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST });

      const admitted = Promise.all([request(), request()]);
      const { error } = await settle(request());
      await expect(admitted).resolves.toEqual(['{}', '{}']);

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      expect(mcpData(error)).toMatchObject({ reason: 'pacer_shed' });
      expect(mcpData(error).retryAfter).toEqual(expect.any(Number));
      expect(mock).toHaveBeenCalledTimes(2);
      client.dispose();
    });

    it('never captures the upstream error body into error data', async () => {
      const { impl } = fakeFetch(
        () =>
          new Response('SECRET-BODY-MARKER', { headers: { 'retry-after': '120' }, status: 429 }),
      );
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(JSON.stringify((error as McpError).data)).not.toContain('SECRET-BODY-MARKER');
      client.dispose();
    });

    it('retries a 503 through the whole ladder and then reports feed_unavailable', async () => {
      const { impl, mock } = fakeFetch(() => new Response('down', { status: 503 }));
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(mcpData(error)).toMatchObject({ reason: 'feed_unavailable', retryAttempts: 3 });
      expect(mock).toHaveBeenCalledTimes(3);
      client.dispose();
    });

    it('uses the profile unavailable reason for a non-retryable 4xx', async () => {
      const { impl, mock } = fakeFetch(() => new Response('nope', { status: 403 }));
      const client = makeClient(impl, {
        ...PROFILE,
        unavailableReason: 'advisory_service_unavailable',
      });

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(mcpData(error)).toMatchObject({ reason: 'advisory_service_unavailable' });
      expect(mock).toHaveBeenCalledTimes(1);
      client.dispose();
    });

    it('treats a non-200 success status as unavailable and keeps the status', async () => {
      const { impl } = fakeFetch(() => new Response(null, { status: 204 }));
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(mcpData(error)).toMatchObject({ reason: 'feed_unavailable', status: 204 });
      expect((error as McpError).message).toContain('unexpected HTTP 204');
      client.dispose();
    });

    it('reports a network failure as unavailable with the cause kept', async () => {
      const cause = new TypeError('fetch failed: ECONNRESET');
      const { impl } = fakeFetch(() => {
        throw cause;
      });
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({
          context,
          errorData: { feed: 'demo' },
          operation: 'op',
          parse: read,
          url: URL_UNDER_TEST,
        }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(mcpData(error)).toMatchObject({ feed: 'demo', reason: 'feed_unavailable' });
      expect((error as McpError).message).toContain('ECONNRESET');
      client.dispose();
    });

    it('reports an interrupted body read as unavailable', async () => {
      const broken = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      });
      const { impl } = fakeFetch(
        () =>
          new Response(broken, { headers: { 'content-type': 'application/json' }, status: 200 }),
      );
      const client = makeClient(impl);

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(mcpData(error)).toMatchObject({ reason: 'feed_unavailable' });
      client.dispose();
    });

    it('passes a non-retryable parse error through untouched after one attempt', async () => {
      const { impl, mock } = fakeFetch(() => jsonResponse('[]'));
      const client = makeClient(impl);
      const parse = () => {
        throw serializationError('shape changed', {
          reason: 'feed_contract_changed',
          retryable: false,
        });
      };

      const { error } = await settle(
        client.request({ context, operation: 'op', parse, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect(mcpData(error)).toMatchObject({ reason: 'feed_contract_changed' });
      expect(mock).toHaveBeenCalledTimes(1);
      client.dispose();
    });
  });

  describe('timeouts', () => {
    it('ends a hung upstream with retry_deadline_exceeded inside the 20 s budget', async () => {
      const { impl } = fakeFetch(hang);
      const client = makeClient(impl);
      const startedAt = Date.now();

      const { error } = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect(mcpData(error)).toMatchObject({ reason: 'retry_deadline_exceeded' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20_000 - 1);
      client.dispose();
    });

    it('times out one hung attempt after 8 s and retries', async () => {
      const { impl, mock } = fakeFetch(hang, () => jsonResponse('{"ok":true}'));
      const client = makeClient(impl);

      const outcome = await settle(
        client.request({ context, operation: 'op', parse: read, url: URL_UNDER_TEST }),
      );

      expect(outcome.value).toBe('{"ok":true}');
      expect(mock).toHaveBeenCalledTimes(2);
      client.dispose();
    });
  });

  it('can be disposed twice', () => {
    const client = makeClient(fakeFetch(() => jsonResponse('{}')).impl);
    client.dispose();
    expect(() => client[Symbol.dispose]()).not.toThrow();
  });
});
