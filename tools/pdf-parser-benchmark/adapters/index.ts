import type { Runner } from "../src/runner.js";
import type { ParserDescriptor } from "../src/schema.js";
import type { FixtureRecord } from "../src/harness.js";

export type ParserMode = string;

export type AdapterRunContext = {
  mode: ParserMode;
  fixture: FixtureRecord;
  /** Per-run working dir under D:\ai-cognitive-pdf-benchmark-data\temp — cleaned by the harness afterwards. */
  tempDir: string;
  rawDir: string;
  cold: boolean;
  timeoutOverrideMs?: number;
  pageCapOverride?: number | null;
  runner: Runner;
  warnings: string[];
};

export type AdapterMetrics = {
  wallTimeMs: number;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  peakRssMb: number | null;
  cpuTimeMs: number | null;
  peakGpuMb: number | null;
};

export type AdapterRunOutput = {
  parser: ParserDescriptor;
  normalizedCandidate: unknown | null;
  metrics: AdapterMetrics;
  stdout: string;
  stderr: string;
  warnings: string[];
};

export type ParserAdapter = {
  id: string;
  minRamAvailableGb: number;
  defaultTimeoutMs: number;
  /** null = whole document (native parsers). Number = first N pages for model parsers. */
  defaultPageCap: number | null;
  modes: ParserMode[];
  parserKey: (mode: ParserMode) => string;
  run: (context: AdapterRunContext) => Promise<AdapterRunOutput>;
};

export { pdfjsAdapter } from "./pdfjs.js";
export { liteparseAdapter } from "./liteparse.js";
export { doclingAdapter } from "./docling.js";
export { mineruAdapter } from "./mineru.js";
