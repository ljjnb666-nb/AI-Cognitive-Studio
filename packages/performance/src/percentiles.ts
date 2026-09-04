/** Nearest-rank percentile: rank=ceil(p*n), sorted ascending, with p in [0,1]. */
export function percentile(values: readonly number[], p: number): number | null { if (!values.length) return null; if (p < 0 || p > 1 || !Number.isFinite(p)) throw new Error("INVALID_PERCENTILE"); const ordered = [...values].sort((a, b) => a - b); return ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)] ?? null; }
export function p50p95(values: readonly number[]) { return { p50: percentile(values, .5), p95: percentile(values, .95) }; }
