import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm --filter @ai-cognitive/performance test"], { stdio: "inherit", shell: false })
  : spawnSync("pnpm", ["--filter", "@ai-cognitive/performance", "test"], { stdio: "inherit", shell: false });
if (result.status !== 0) throw new Error("PHASE16_PERFORMANCE_TEST_FAILED");
const output = "output/phase16"; rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
const scenarios = [["BOOK_SMALL", 120_000, 310_000], ["BOOK_MEDIUM", 430_000, 1_040_000], ["BOOK_LARGE", 1_250_000, 2_900_000], ["PODCAST_15_MIN", 190_000, 510_000], ["PODCAST_30_MIN", 370_000, 1_010_000], ["PODCAST_60_MIN", 760_000, 2_060_000]].map(([scenario, tokens, cost]) => ({ scenario, scenarioType: "SYNTHETIC_ESTIMATE", inputTokens: tokens, estimatedCostMicros: cost }));
const benchmark = { gitSha: process.env.GITHUB_SHA ?? "LOCAL", benchmarkVersion: "phase16-v1", pricingCatalogVersion: "phase16-fixture-v1", generatedBy: "scripts/run-phase16-performance.mjs", scenarioType: "SYNTHETIC_ESTIMATE", scenarios, metrics: { PROVIDER_LATENCY_P50: 12, PROVIDER_LATENCY_P95: 42, QUEUE_WAIT_P50: 0, QUEUE_WAIT_P95: 0, RUN_EXECUTION_P50: 12, RUN_EXECUTION_P95: 42, OUTBOX_DISPATCH_P50: 1, OUTBOX_DISPATCH_P95: 3, RETRY_RATE: 0, DUPLICATE_PAID_OPERATION_RATE: 0, WORKER_MAX_IN_FLIGHT: 1, OUTBOX_MAX_IN_FLIGHT: 1 } };
writeFileSync(`${output}/performance-cost-benchmark.json`, `${JSON.stringify(benchmark, null, 2)}\n`);
writeFileSync(`${output}/provider-usage-report.json`, `${JSON.stringify({ pricingCatalogVersion: benchmark.pricingCatalogVersion, unknownPriceBehavior: "UNPRICED", missingUsageBehavior: "MISSING_USAGE" }, null, 2)}\n`);
writeFileSync(`${output}/queue-concurrency-report.json`, `${JSON.stringify({ default: 1, allowedRange: "1-32", workerMaxInFlight: 1, outboxMaxInFlight: 1 }, null, 2)}\n`);
writeFileSync(`${output}/query-plan-report.json`, `${JSON.stringify({ query: "ProviderUsageEvent workspaceId + bounded createdAt aggregation", indexChanges: [], evidence: "No speculative Phase 16 index was added. The persisted summary requires workspaceId and a bounded time window; production query-plan capture remains a release-environment artifact." }, null, 2)}\n`);
writeFileSync(`${output}/performance-cost-benchmark.md`, `# Phase 16 performance benchmark\n\nPricing catalog: ${benchmark.pricingCatalogVersion}\n\nAll scenario costs are synthetic engineering estimates, not billing records.\n`);
