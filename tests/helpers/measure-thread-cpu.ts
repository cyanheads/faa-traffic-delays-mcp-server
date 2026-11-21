/**
 * @fileoverview CPU timing for performance regressions on the test worker thread.
 * @module tests/helpers/measure-thread-cpu
 */

import { platform, threadCpuUsage } from 'node:process';

// Linux can report sub-millisecond batches as zero. Span several accounting intervals.
const MIN_BATCH_MICROS = platform === 'linux' ? 10_000 : 1;
const MAX_BATCH_MULTIPLIER = 1_024;

/** Measures CPU microseconds per call, batching repeats when the timer needs more work. */
export function measureThreadCpuMicros(run: () => unknown, initialCalls: number): number {
  for (let multiplier = 1; multiplier <= MAX_BATCH_MULTIPLIER; multiplier *= 2) {
    const calls = initialCalls * multiplier;
    const started = threadCpuUsage();
    for (let call = 0; call < calls; call++) run();
    const { user, system } = threadCpuUsage(started);
    const elapsed = user + system;
    if (elapsed >= MIN_BATCH_MICROS) return elapsed / calls;
  }
  throw new Error('Thread CPU timer did not reach its sampling window within the batch limit.');
}
