/**
 * @fileoverview Memory test for the AdvisoryService caches: a cached advisory page or index keeps
 * its parsed values without the fetched page they were read from. V8 keeps a sliced string's
 * parent alive, so a cached value sliced straight out of the page would pin the whole page for as
 * long as the entry lives (6 h for a settled date). Kept in its own file because it turns on
 * `--expose_gc` for the worker process it runs in.
 * @module tests/services/advisory/advisory-cache-memory.test
 */

import v8 from 'node:v8';
import vm from 'node:vm';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvisoryService } from '@/services/advisory/advisory-service.js';
import { htmlResponse, readFixture } from '../../helpers/faa-fakes.js';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;

/** Page size: large enough that holding it dwarfs measurement noise, under the 2 MiB body ceiling. */
const PAGE_BYTES = 1_500_000;
const WARM_UP_LOADS = 2;
const MEASURED_LOADS = 3;
/** Just over the advisories pacer's 500 ms minimum gap between request starts. */
const PACER_START_GAP_MS = 550;

/** `page` grown to `PAGE_BYTES` by a comment before its closing body tag. */
function padded(page: string): string {
  const at = page.search(/<\/body>/i);
  const comment = `<!--${'x'.repeat(PAGE_BYTES - page.length - 7)}-->`;
  return `${page.slice(0, at)}${comment}${page.slice(at)}`;
}

/**
 * A GDP advisory page. Its EFFECTIVE TIME value `300016-300659` passes through the cell reader
 * unchanged, so without a copy it would be a slice of the page.
 */
const advisoryPage = (): string => padded(readFixture('advisory-gdp.page'));

/**
 * The 2026-10-01 index, with advisory 154's control element lengthened to `JFK/LGA/EWR/ZNY`. Values
 * of 13 or more characters with no whitespace pass through the cell reader unchanged, so without a
 * copy that element would be a slice of the page.
 */
const indexPage = (): string =>
  padded(
    readFixture('advisory-index-2026-10-01.page').replace(
      '<td>PHLC/ZNY</td>',
      '<td>JFK/LGA/EWR/ZNY</td>',
    ),
  );

/**
 * Live V8 heap plus off-heap memory after full collections. Off-heap counts because Node decodes a
 * body over about 1 MB into an external string, whose characters sit outside the V8 heap.
 */
async function liveBytes(): Promise<number> {
  // V8 keeps the subject of the last RegExp match alive; point it at a short string first.
  /reset/.exec('reset');
  for (let pass = 0; pass < 3; pass++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const { external, heapUsed } = process.memoryUsage();
  return heapUsed + external;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdvisoryService cache memory', () => {
  let service: AdvisoryService | undefined;

  afterEach(() => {
    service?.dispose();
  });

  /** A service whose every response is a freshly built page, so the test holds no reference to one. */
  function serve(build: () => string): AdvisoryService {
    service = new AdvisoryService({
      fetch: createFetchMock([
        { match: /^https:\/\/www\.fly\.faa\.gov\//, respond: () => htmlResponse(build()) },
      ]).fetch,
    });
    return service;
  }

  /**
   * The fewest bytes one cached load leaves live, over `MEASURED_LOADS` loads under new keys, after
   * `WARM_UP_LOADS` unmeasured ones compile the code a load runs. A page the cache pins stays live
   * after every load; allocation by the test runner that lands in one measured window does not,
   * so the fewest is the cache's own share. Each measured load waits out the pacer's start gap
   * first, so its window spans the load alone.
   */
  async function fewestBytesRetained(load: (key: number) => Promise<unknown>): Promise<number> {
    for (let key = 0; key < WARM_UP_LOADS; key++) await load(key);
    let fewest = Number.POSITIVE_INFINITY;
    for (let key = WARM_UP_LOADS; key < WARM_UP_LOADS + MEASURED_LOADS; key++) {
      await new Promise((resolve) => setTimeout(resolve, PACER_START_GAP_MS));
      const before = await liveBytes();
      await load(key);
      fewest = Math.min(fewest, (await liveBytes()) - before);
    }
    return fewest;
  }

  it('keeps cached advisories without the pages they were read from', async () => {
    const advisories = serve(advisoryPage);
    const ctx = createMockContext();
    expect(advisoryPage().length).toBe(PAGE_BYTES);

    const retained = await fewestBytesRetained((key) =>
      advisories.getAdvisory(key + 1, '2026-09-30', ctx),
    );

    await expect(advisories.getAdvisory(1, '2026-09-30', ctx)).resolves.toMatchObject({
      effectiveTime: '300016-300659',
    });
    expect(retained, `${retained} bytes retained for a ${PAGE_BYTES}-byte page`).toBeLessThan(
      PAGE_BYTES / 4,
    );
  }, 20_000);

  it('keeps cached indexes without the pages they were read from', async () => {
    const indexes = serve(indexPage);
    const ctx = createMockContext();
    expect(indexPage().length).toBe(PAGE_BYTES);

    const retained = await fewestBytesRetained((key) =>
      indexes.listAdvisories(`2026-09-${String(key + 10)}`, undefined, ctx),
    );

    const index = await indexes.listAdvisories('2026-09-10', undefined, ctx);
    expect(index.rows[0]?.controlElement).toBe('JFK/LGA/EWR/ZNY');
    expect(retained, `${retained} bytes retained for a ${PAGE_BYTES}-byte page`).toBeLessThan(
      PAGE_BYTES / 4,
    );
  }, 20_000);
});
