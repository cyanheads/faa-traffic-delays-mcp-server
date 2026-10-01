/**
 * @fileoverview NAS Status feed client (`https://nasstatus.faa.gov/api/*`): paced, retried,
 * cached (60 s per feed, 6 h for pacing airports), single-flight, and tolerantly parsed. Feed
 * failures throw with the `data.reason` each calling tool declares.
 * @module services/nas-status/nas-status-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger, type RequestContext, withExtra } from '@cyanheads/mcp-ts-core/utils';
import {
  FaaHttpClient,
  type HttpServiceOptions,
  type UpstreamProfile,
} from '@/services/upstream/faa-http-client.js';
import { TtlCache } from '@/services/upstream/ttl-cache.js';
import {
  type ParseReporter,
  parseAirportEvents,
  parseAnnouncements,
  parseEnrouteEvents,
  parseOperationsPlan,
  parsePacingAirports,
} from './feed-parsers.js';
import type {
  AirportEvents,
  AirspaceFlowProgram,
  FeedRows,
  FeedSnapshot,
  OperationsPlan,
  PacingAirport,
} from './types.js';

const BASE_URL = 'https://nasstatus.faa.gov/api/';
const FEED_TTL_MS = 60_000;
const PACING_TTL_MS = 6 * 60 * 60 * 1000;

const PROFILE: UpstreamProfile = {
  accept: 'application/json',
  contractChangedReason: 'feed_contract_changed',
  htmlIsMaintenance: true,
  pacer: {
    cooldown: { baseMs: 5_000, maxMs: 60_000 },
    limits: [{ perMs: 60_000, requests: 30 }],
    maxConcurrent: 4,
    name: 'FAA NAS Status',
  },
  service: 'The FAA NAS Status feed',
  unavailableReason: 'feed_unavailable',
};

type Feed =
  | 'airport-events'
  | 'enroute-events'
  | 'operations-plan'
  | 'miscellaneous-info'
  | 'pacing-airports';

/** How caller-facing messages name each feed: `The FAA NAS Status ${label} feed`. */
const FEED_LABELS: Record<Feed, string> = {
  'airport-events': 'airport events',
  'enroute-events': 'en-route events',
  'miscellaneous-info': 'announcements',
  'operations-plan': 'operations plan',
  'pacing-airports': 'pacing airports',
};

const feedName = (feed: Feed): string => `The FAA NAS Status ${FEED_LABELS[feed]} feed`;

/** Client for the five NAS Status feeds this server reads. */
export class NasStatusService implements Disposable {
  private readonly cache: TtlCache;
  private readonly client: FaaHttpClient;
  private readonly now: () => number;
  private readonly reported = new Set<string>();

  constructor(options: HttpServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache(this.now);
    this.client = new FaaHttpClient(PROFILE, options);
  }

  /** Airports with at least one active event. */
  getAirportEvents(ctx: Context): Promise<FeedSnapshot<FeedRows<AirportEvents>>> {
    return this.load('airport-events', FEED_TTL_MS, ctx, parseAirportEvents);
  }

  /** Active Airspace Flow Programs. */
  getEnrouteEvents(ctx: Context): Promise<FeedSnapshot<FeedRows<AirspaceFlowProgram>>> {
    return this.load('enroute-events', FEED_TTL_MS, ctx, parseEnrouteEvents);
  }

  /** The ATCSCC operations plan summary. */
  getOperationsPlan(ctx: Context): Promise<FeedSnapshot<OperationsPlan & { skippedRows: number }>> {
    return this.load('operations-plan', FEED_TTL_MS, ctx, parseOperationsPlan);
  }

  /** ATCSCC announcements (`/api/miscellaneous-info`). */
  getAnnouncements(ctx: Context): Promise<FeedSnapshot<FeedRows<string>>> {
    return this.load('miscellaneous-info', FEED_TTL_MS, ctx, parseAnnouncements);
  }

  /** The FAA pacing airports, cached for 6 h. */
  getPacingAirports(ctx: Context): Promise<FeedSnapshot<FeedRows<PacingAirport>>> {
    return this.load('pacing-airports', PACING_TTL_MS, ctx, parsePacingAirports);
  }

  dispose(): void {
    this.client.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Serves `feed` from cache or one shared, deadline-bound fetch. The shared fetch never takes a
   * caller's signal; each caller waits on it under its own `ctx.signal`.
   */
  private load<T extends { skippedRows: number }>(
    feed: Feed,
    ttlMs: number,
    ctx: Context,
    parse: (body: unknown, report: ParseReporter) => T,
  ): Promise<FeedSnapshot<T>> {
    return this.cache.get(
      feed,
      async () => {
        const logContext: RequestContext = {
          operation: `NasStatusService.${feed}`,
          requestId: ctx.requestId,
          timestamp: new Date(this.now()).toISOString(),
          ...(ctx.traceId && { traceId: ctx.traceId }),
        };
        const parsed = await this.client.request({
          context: logContext,
          operation: feedName(feed),
          parse: (text) => parse(parseJson(text, feed), this.reporter(logContext)),
          url: `${BASE_URL}${feed}`,
        });
        if (parsed.skippedRows > 0) {
          logger.warning(
            `Skipped ${parsed.skippedRows} unreadable ${feed} rows`,
            withExtra(logContext, { feed, skippedRows: parsed.skippedRows }),
          );
        }
        return { ttlMs, value: { ...parsed, fetchedAt: new Date(this.now()).toISOString() } };
      },
      ctx.signal,
    );
  }

  /** Logs each distinct drift signal once per process. */
  private reporter(logContext: RequestContext): ParseReporter {
    const once = (key: string, message: string, details: Record<string, unknown>): void => {
      if (this.reported.has(key)) return;
      this.reported.add(key);
      logger.warning(message, withExtra(logContext, details));
    };
    return {
      drift: (path, observedType) =>
        once(`drift:${path}:${observedType}`, 'NAS Status field has an unexpected type', {
          fieldPath: path,
          observedType,
        }),
      unknownKey: (feed, key) =>
        once(`key:${feed}:${key}`, 'NAS Status row carries an unknown key', { feed, key }),
    };
  }
}

/**
 * A JSON syntax error on a 200 response is read as a truncated or interrupted transfer
 * (`feed_unavailable`, retried), not a format change: a changed format still arrives as valid JSON.
 */
function parseJson(text: string, feed: Feed): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw serviceUnavailable(
      `${feedName(feed)} returned a malformed JSON body.`,
      { feed, reason: 'feed_unavailable' },
      { cause: error },
    );
  }
}

// --- Init/accessor ---

let service: NasStatusService | undefined;

/** Constructs the singleton; called from `createApp({ setup })`. */
export function initNasStatusService(options: HttpServiceOptions = {}): NasStatusService {
  service = new NasStatusService(options);
  return service;
}

/** The singleton; throws when `initNasStatusService()` has not run. */
export function getNasStatusService(): NasStatusService {
  if (!service) {
    throw new Error('NasStatusService not initialized — call initNasStatusService() in setup()');
  }
  return service;
}
