/**
 * @fileoverview Shared test seams: fixture loading, canned FAA responses, a fake fetch over the
 * real feed and advisory URLs, and helpers that initialise the two HTTP services against it.
 * @module tests/helpers/faa-fakes
 */

import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@cyanheads/mcp-ts-core';
import {
  createFetchMock,
  type FetchMockHarness,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';
import { initAdvisoryService } from '@/services/advisory/advisory-service.js';
import { initNasStatusService } from '@/services/nas-status/nas-status-service.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** Reads `tests/fixtures/<name>` as UTF-8 text. */
export const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

export const NAS_BASE = 'https://nasstatus.faa.gov/api/';
export const ADVISORY_BASE = 'https://www.fly.faa.gov/adv/adv_otherdis';

export type FeedName =
  | 'airport-events'
  | 'enroute-events'
  | 'operations-plan'
  | 'miscellaneous-info'
  | 'pacing-airports';

const FEED_FIXTURES: Record<FeedName, string> = {
  'airport-events': 'airport-events.json',
  'enroute-events': 'enroute-events.json',
  'miscellaneous-info': 'miscellaneous-info.json',
  'operations-plan': 'operations-plan.json',
  'pacing-airports': 'pacing-airports.json',
};

export const feedUrl = (feed: FeedName): string => `${NAS_BASE}${feed}`;

export const advisoryUrl = (advisoryNumber: number, mmddyyyy: string): string =>
  `${ADVISORY_BASE}?advn=${advisoryNumber}&adv_date=${mmddyyyy}`;

/** A 200 `application/json` response. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** A 200 `text/html;charset=UTF-8` response. */
export function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/html;charset=UTF-8', ...init.headers },
  });
}

/** The fixture body of one feed, parsed. */
export const feedFixture = (feed: FeedName): unknown =>
  JSON.parse(readFixture(FEED_FIXTURES[feed]));

/** A response factory: a fresh `Response` per request (bodies can only be read once). */
export type Responder = (request: Request) => Response | Promise<Response>;

/** What a feed override may be: a JSON body, or a factory of a fresh `Response` per request. */
export type FeedOverride = unknown;

/**
 * Routes for all five feeds, each defaulting to its fixture. An override is a body (served as
 * JSON) or a `Responder`. Failure responses must be factories: a `Response` body can be read once.
 */
export function feedRoutes(
  overrides: Partial<Record<FeedName, FeedOverride | Responder>> = {},
): FetchMockRoute[] {
  return (Object.keys(FEED_FIXTURES) as FeedName[]).map((feed) => ({
    match: feedUrl(feed),
    respond: (request) => {
      const override = feed in overrides ? overrides[feed] : readFixture(FEED_FIXTURES[feed]);
      return typeof override === 'function'
        ? (override as Responder)(request)
        : jsonResponse(override as string | object);
    },
  }));
}

/** A responder for a hung upstream: it settles only when the request is aborted. */
export const hangUntilAborted: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener(
      'abort',
      () => reject(request.signal.reason ?? new Error('aborted')),
      { once: true },
    );
  });

/** A fetch fake over the five feeds. */
export function feedHarness(
  overrides: Partial<Record<FeedName, FeedOverride | Responder>> = {},
): FetchMockHarness {
  return createFetchMock(feedRoutes(overrides));
}

/** Requests the harness saw for one feed. */
export const callsTo = (harness: FetchMockHarness, url: string): number =>
  harness.calls.filter((call) => call.request.url === url).length;

/** Adjustable clock for the services' `now` seam. */
export function createClock(start = '2026-09-30T02:00:00Z'): {
  advance: (ms: number) => void;
  now: () => number;
} {
  let current = Date.parse(start);
  return {
    advance: (ms) => {
      current += ms;
    },
    now: () => current,
  };
}

/** Initialises both service singletons over `fetch`; returns them for disposal. */
export function installServices(options: { fetch: typeof fetch; now?: () => number }): {
  dispose: () => void;
} {
  const nas = initNasStatusService(options);
  const advisory = initAdvisoryService(options);
  return {
    dispose: () => {
      nas.dispose();
      advisory.dispose();
    },
  };
}

/** Text of every `text` content block, joined by newlines. */
export function contentText(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** `structuredContent.error` of a failed contract run. */
export function errorOf(result: CallToolResult): {
  code: number;
  data?: Record<string, unknown>;
  message: string;
} {
  const error = (result.structuredContent as { error?: unknown } | undefined)?.error;
  if (!error) throw new Error('Expected an error result, got a success.');
  return error as { code: number; data?: Record<string, unknown>; message: string };
}

/** `data.recovery.hint` of an error result's error, when present. */
export function recoveryHint(error: { data?: Record<string, unknown> }): string | undefined {
  const recovery = error.data?.recovery as { hint?: string } | undefined;
  return recovery?.hint;
}
