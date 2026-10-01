/**
 * @fileoverview Fetch boundary shared by the FAA HTTP services. One client per upstream host:
 * a pacer bounds the request rate, `withRetry` wraps fetch + parse under a 20 s deadline, and each
 * attempt runs its own timer across the header phase and body read. Statuses are classified here
 * against an accept-list of 200 only, because a 404 on a known path means the contract changed and a
 * 200 can carry an HTML maintenance page.
 * @module services/upstream/faa-http-client
 */

import {
  McpError,
  rateLimited,
  serializationError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  type PacerOptions,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

const ATTEMPT_TIMEOUT_MS = 8_000;
const MAX_QUEUE_WAIT_MS = 10_000;
const RETRY_DEADLINE_MS = 20_000;

/** Injectable seams shared by the HTTP services (tests pass a fake `fetch` and clock). */
export interface HttpServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Sent as `User-Agent`; `setup()` passes `faa-traffic-delays-mcp-server/<version>`. */
  userAgent?: string;
}

/** How one upstream host names itself and its failures. */
export interface UpstreamProfile {
  /** `Accept` header value. */
  accept: string;
  /** `data.reason` for a 404/410 or an unrecognized body. */
  contractChangedReason: string;
  /** A 200 `text/html` response is a maintenance page, not data (JSON feeds). */
  htmlIsMaintenance: boolean;
  /** Pacer settings; `name` reaches caller-facing shed messages, so write it as words. */
  pacer: PacerOptions;
  /** Name used in error messages. */
  service: string;
  /** `data.reason` for outages, 5xx, network errors, and attempt timeouts. */
  unavailableReason: string;
}

/** One request through the boundary. */
export interface UpstreamRequest<T> {
  /** Log context of the caller that started the (shared) load. */
  context: RequestContext;
  /** Extra fields merged into the `data` of every error this request raises. */
  errorData?: Record<string, unknown>;
  /**
   * Caller-readable name of what is fetched (`The FAA NAS Status airport events feed`): `withRetry`
   * puts it in the deadline message and in `data.operation` on exhaustion, both caller-facing.
   */
  operation: string;
  /** Reads the 200 body; throws a classified error when the body is unusable. */
  parse: (body: string) => T;
  url: string;
}

/** Paced, retried, timed fetch against one FAA host. */
export class FaaHttpClient implements Disposable {
  private readonly fetchImpl: typeof fetch;
  private readonly pacer: Pacer;
  private readonly userAgent: string;

  constructor(
    private readonly profile: UpstreamProfile,
    options: HttpServiceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? 'faa-traffic-delays-mcp-server';
    this.pacer = createPacer(profile.pacer);
  }

  /** Fetches and parses `request.url`, retrying transient failures inside the 20 s budget. */
  async request<T>(request: UpstreamRequest<T>): Promise<T> {
    try {
      return await withRetry(
        ({ remainingMs, signal }) =>
          this.pacer.run(
            (taskSignal) =>
              this.attempt(request, taskSignal, Math.min(ATTEMPT_TIMEOUT_MS, remainingMs)),
            { maxWaitMs: Math.min(MAX_QUEUE_WAIT_MS, remainingMs), signal },
          ),
        {
          baseDelayMs: 500,
          context: request.context,
          deadlineMs: RETRY_DEADLINE_MS,
          maxRetries: 2,
          operation: request.operation,
        },
      );
    } catch (error) {
      throw this.upstreamThrottle(error, request);
    }
  }

  dispose(): void {
    this.pacer.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private async attempt<T>(
    request: UpstreamRequest<T>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> {
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    const combined = AbortSignal.any([signal, timer.signal]);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(request.url, {
          headers: {
            Accept: this.profile.accept,
            'Accept-Encoding': 'gzip',
            'User-Agent': this.userAgent,
          },
          signal: combined,
        });
      } catch (error) {
        throw this.fetchFailure(error, request, signal, timer.signal, timeoutMs);
      }

      if (response.status !== 200) throw await this.statusFailure(response, request);

      const contentType = response.headers.get('content-type') ?? '';
      if (this.profile.htmlIsMaintenance && /html/i.test(contentType)) {
        await response.body?.cancel();
        throw serviceUnavailable(
          `${this.profile.service} returned an HTML page instead of data, likely a maintenance page.`,
          { ...request.errorData, reason: this.profile.unavailableReason, status: 200 },
        );
      }

      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw this.fetchFailure(error, request, signal, timer.signal, timeoutMs);
      }
      return request.parse(body);
    } finally {
      clearTimeout(handle);
    }
  }

  /**
   * Reads a pacer shed as the upstream's rate limit while the cooldown gate is closed, since only
   * an upstream 429 closes that gate. `retryAfter` stays the shed's value, the instant this server
   * next sends to the host, which never falls before the end of the host's own `Retry-After`.
   */
  private upstreamThrottle(error: unknown, request: UpstreamRequest<unknown>): unknown {
    if (
      !(error instanceof McpError) ||
      error.data?.reason !== 'pacer_shed' ||
      this.pacer.cooldown.remainingMs === 0
    ) {
      return error;
    }
    const { retryAfter } = error.data;
    return rateLimited(
      `${this.profile.service} returned HTTP 429, and this server is holding further requests to it for ${retryAfter} s.`,
      { ...request.errorData, reason: 'upstream_rate_limited', retryAfter },
      { cause: error },
    );
  }

  /**
   * Classifies a thrown fetch or body read. The attempt's own timer is a retried `Timeout`; an
   * abort from the retry deadline passes through for `withRetry` to report; anything else is a
   * network failure.
   */
  private fetchFailure(
    error: unknown,
    request: UpstreamRequest<unknown>,
    signal: AbortSignal,
    timerSignal: AbortSignal,
    timeoutMs: number,
  ): unknown {
    if (signal.aborted) return error;
    if (timerSignal.aborted) {
      return timeout(
        `${this.profile.service} did not respond within ${Math.round(timeoutMs / 1000)} s.`,
        { ...request.errorData, reason: this.profile.unavailableReason },
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    return serviceUnavailable(
      `${this.profile.service} is unreachable (${detail}).`,
      { ...request.errorData, reason: this.profile.unavailableReason },
      { cause: error },
    );
  }

  private async statusFailure(
    response: Response,
    request: UpstreamRequest<unknown>,
  ): Promise<McpError> {
    const { service } = this.profile;
    const status = response.status;
    if (status === 404 || status === 410) {
      await response.body?.cancel();
      return serializationError(
        `${service} returned HTTP ${status} for a known path, which usually means the FAA changed or moved it.`,
        {
          ...request.errorData,
          reason: this.profile.contractChangedReason,
          retryable: false,
          status,
        },
      );
    }
    if (status >= 400) {
      const reason = status === 429 ? 'upstream_rate_limited' : this.profile.unavailableReason;
      return httpErrorFromResponse(response, {
        captureBody: false,
        data: { ...request.errorData, reason },
        service,
      });
    }
    await response.body?.cancel();
    return serviceUnavailable(`${service} returned unexpected HTTP ${status}.`, {
      ...request.errorData,
      reason: this.profile.unavailableReason,
      status,
    });
  }
}
