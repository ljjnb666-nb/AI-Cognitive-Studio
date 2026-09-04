import { p50p95 } from "./percentiles.js";

export type RunTiming = { id: string; workspaceId: string; createdAt: Date; startedAt?: Date | null; completedAt?: Date | null; dispatchedAt?: Date | null; providerLatencyMs?: number | null; retryCount?: number };
const duration = (start: Date | null | undefined, end: Date | null | undefined) => start && end ? Math.max(0, end.getTime() - start.getTime()) : null;
/** Uses durable run timestamps only; incomplete runs are classified rather than given invented durations. */
export function summarizeRunPerformance(workspaceId: string, runs: readonly RunTiming[]) {
  const selected = runs.filter(run => run.workspaceId === workspaceId);
  const complete = selected.filter(run => run.completedAt);
  const values = (make: (run: RunTiming) => number | null) => selected.flatMap(run => { const value = make(run); return value === null ? [] : [value]; });
  return { runCount: selected.length, completedRunCount: complete.length, incompleteRunCount: selected.length - complete.length, queueWait: p50p95(values(run => duration(run.createdAt, run.startedAt))), execution: p50p95(values(run => duration(run.startedAt, run.completedAt))), endToEnd: p50p95(values(run => duration(run.createdAt, run.completedAt))), outboxDispatch: p50p95(values(run => duration(run.createdAt, run.dispatchedAt))), providerLatency: p50p95(values(run => run.providerLatencyMs ?? null)), retryCount: selected.reduce((sum, run) => sum + (run.retryCount ?? 0), 0) };
}
