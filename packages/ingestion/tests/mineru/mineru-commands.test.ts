import { describe, expect, it } from "vitest";
import { sep as osPathSep } from "node:path";
import { buildMineruParseArgs, buildMineruServerArgs, judgeMineruParseExit, mineruFailureForOutcome, mineruPageSelector, parseMineruEndpoint, parseMineruParseEnvelope } from "../../src/mineru/mineru-commands.js";
import { resolveMineruExecutorConfig } from "../../src/mineru/mineru-config.js";
import { readEnvironment } from "@ai-cognitive/shared/server";

describe("MinerU page selector binding (04B-3 off-by-one contract)", () => {
  it("converts canonical 0-based physicalPageIndex to MinerU's 1-based inclusive selector", () => {
    expect(mineruPageSelector(0)).toBe("1-1");
    expect(mineruPageSelector(1)).toBe("2-2");
    expect(mineruPageSelector(4)).toBe("5-5");
    expect(mineruPageSelector(1999)).toBe("2000-2000");
  });

  it("refuses non-integer and negative page indexes (fail closed)", () => {
    expect(() => mineruPageSelector(-1)).toThrow();
    expect(() => mineruPageSelector(1.5)).toThrow();
    expect(() => mineruPageSelector(Number.NaN)).toThrow();
  });

  it("embeds the exact selector in the parse argv", () => {
    expect(buildMineruParseArgs({ inputPdfPath: "in.pdf", tier: "flash", physicalPageIndex: 4, outputMarkdownPath: "out/result.md" })).toEqual([
      "parse", "in.pdf", "--tier", "flash", "--pages", "5-5", "--output", "out/result.md", "--json", "--force",
    ]);
  });

  it("builds the verified server subcommand argv", () => {
    expect(buildMineruServerArgs("start")).toEqual(["server", "start"]);
    expect(buildMineruServerArgs("stop")).toEqual(["server", "stop"]);
  });
});

describe("MinerU endpoint identity validation", () => {
  it("accepts the verified version-2 endpoint envelope", () => {
    const endpoint = parseMineruEndpoint(JSON.stringify({ version: 2, pid: 66128, server_id: "b47d77ab-cfbe-4aba-8c70-c6fbf4946628", transports: [{ type: "tcp", base_url: "http://127.0.0.1:15980" }] }));
    expect(endpoint).toEqual({ version: 2, pid: 66128, serverId: "b47d77ab-cfbe-4aba-8c70-c6fbf4946628", transports: [{ type: "tcp", base_url: "http://127.0.0.1:15980" }] });
  });

  it.each([
    ["not json", "garbage{"],
    ["missing version", JSON.stringify({ pid: 1, server_id: "s", transports: [] })],
    ["wrong version", JSON.stringify({ version: 1, pid: 1, server_id: "s", transports: [] })],
    ["non-positive pid", JSON.stringify({ version: 2, pid: 0, server_id: "s", transports: [] })],
    ["missing server_id", JSON.stringify({ version: 2, pid: 5, transports: [] })],
    ["missing transports", JSON.stringify({ version: 2, pid: 5, server_id: "s" })],
    ["empty input", ""],
  ])("rejects %s", (_name, raw) => {
    expect(parseMineruEndpoint(raw)).toBeNull();
  });
});

describe("MinerU parse outcome judgment (evidence-based classification)", () => {
  const successStdout = JSON.stringify({ parse: { sha256: "x", status: "done" }, content: null, output: { status: "written", path: "C:\\claim\\out\\result.md" } });

  it("classifies a verified success envelope", () => {
    expect(judgeMineruParseExit({ exitCode: 0, stdout: successStdout })).toEqual({ kind: "OUTPUT_WRITTEN", markdownPath: "C:\\claim\\out\\result.md" });
  });

  it("classifies the deterministic missing-local-model error as MODEL_NOT_FOUND", () => {
    const stdout = JSON.stringify({ error: { type: "engine_error", code: "parse_failed", message: "Model repo MinerU-4_models_onnx is not ready under C:\\models\\MinerU-4_models_onnx; missing: OCR/paddleocr/ch_PP-OCRv6_tiny_det_infer.onnx", param: null } });
    expect(judgeMineruParseExit({ exitCode: 1, stdout })).toEqual({ kind: "MODEL_NOT_FOUND" });
    expect(mineruFailureForOutcome({ kind: "MODEL_NOT_FOUND" })).toEqual({ errorCode: "SOURCE_OCR_MODEL_NOT_FOUND", kind: "terminal" });
  });

  it("classifies server_not_running as a transient process failure", () => {
    const stdout = JSON.stringify({ error: { type: "api_error", code: "server_not_running", message: "本地 mineru 服务未运行。请先运行 'mineru server start'。", param: null } });
    expect(judgeMineruParseExit({ exitCode: 1, stdout })).toEqual({ kind: "SERVER_UNAVAILABLE" });
    expect(mineruFailureForOutcome({ kind: "SERVER_UNAVAILABLE" })).toEqual({ errorCode: "SOURCE_OCR_PROCESS_FAILED", kind: "transient" });
  });

  it("classifies exit 0 without a written output as a terminal invalid-output failure", () => {
    const stdout = JSON.stringify({ parse: { status: "done" }, output: { status: "failed" } });
    expect(judgeMineruParseExit({ exitCode: 0, stdout })).toEqual({ kind: "OUTPUT_NOT_WRITTEN" });
    expect(mineruFailureForOutcome({ kind: "OUTPUT_NOT_WRITTEN" })).toEqual({ errorCode: "SOURCE_OCR_OUTPUT_INVALID", kind: "terminal" });
  });

  it.each([
    ["nonzero exit with garbage stdout", { exitCode: 7, stdout: "traceback ..." }],
    ["nonzero exit with unrelated json", { exitCode: 1, stdout: JSON.stringify({ error: { code: "mystery", message: "boom" } }) }],
    ["exit 0 with malformed stdout", { exitCode: 0, stdout: "no json" }],
    ["exit 0 with parse not done", { exitCode: 0, stdout: JSON.stringify({ parse: { status: "failed" }, output: { status: "written", path: "p" } }) }],
  ])("classifies %s as a transient process failure", (_name, input) => {
    expect(judgeMineruParseExit(input)).toEqual({ kind: "PROCESS_FAILED" });
    expect(mineruFailureForOutcome({ kind: "PROCESS_FAILED" })).toEqual({ errorCode: "SOURCE_OCR_PROCESS_FAILED", kind: "transient" });
  });

  it("ignores page-comment identity in output (invocation binding is the only lineage)", () => {
    const stdout = successStdout;
    const envelope = parseMineruParseEnvelope(stdout);
    expect(envelope && JSON.stringify(envelope)).not.toContain("physicalPage");
  });
});

function baseEnvironment(overrides: Partial<Record<string, unknown>> = {}): ReturnType<typeof readEnvironment> {
  return readEnvironment({ DATABASE_URL: "postgresql://app:app@localhost:5432/ai_cognitive_studio_test", REDIS_URL: "redis://localhost:6379", ...overrides } as never);
}

describe("MinerU executor configuration resolution (fail-fast contract)", () => {
  const executable = process.execPath;
  const configured = {
    OCR_PROVIDER: "mineru",
    MINERU_MODEL_SOURCE: "local",
    MINERU_MODEL_PATH: import.meta.dirname,
    MINERU_EXECUTABLE: executable,
  };

  it("returns null when OCR is entirely unconfigured (04B-2 no-OCR behavior preserved)", () => {
    expect(resolveMineruExecutorConfig(baseEnvironment())).toBeNull();
  });

  it("fails fast when MinerU variables are set without OCR_PROVIDER", () => {
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ MINERU_MODEL_PATH: "D:\\models" } as never))).toThrow(/^OCR_PROVIDER_REQUIRED:MINERU_MODEL_PATH$/);
  });

  it("resolves a full valid configuration with pinned defaults", () => {
    const config = resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_EXECUTABLE_ARGS: JSON.stringify(["-x", "y"]) } as never))!;
    expect(config).toMatchObject({ executable, executableArgs: ["-x", "y"], modelSource: "local", tier: "flash", version: "4.0.3", modelPath: import.meta.dirname, timeoutMs: 300_000 });
    expect(config.hostId).toMatch(/^mineru-/);
    expect(config).not.toHaveProperty("modelRevision");
  });

  it("fails fast when the model source is not exactly local", () => {
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_SOURCE: "auto" } as never))).toThrow();
  });

  it("ignores a declared MINERU_VERSION: provenance is the pinned 4.0.3, never operator text (RF01 P1-08)", () => {
    const config = resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_VERSION: "9.9.9-custom" } as never))!;
    expect(config.version).toBe("4.0.3");
  });

  it("rejects model root / claim temp root overlaps in BOTH directions, equality, and Windows case differences (RF01 P1-09)", () => {
    const anyDir = { directoryExists: () => true };
    const modelRoot = import.meta.dirname;
    const homeRoot = import.meta.dirname + osPathSep + "homes";
    // model inside home / equality → reject
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_PATH: modelRoot, MINERU_HOME_ROOT: modelRoot } as never), anyDir)).toThrow(/^OCR_PATH_OVERLAP/);
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_PATH: modelRoot, MINERU_HOME_ROOT: modelRoot + osPathSep + "nested" } as never), anyDir)).toThrow(/^OCR_PATH_OVERLAP/);
    // home inside model → reject
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_PATH: homeRoot, MINERU_HOME_ROOT: homeRoot + osPathSep + "claims" + osPathSep + "inner" } as never), anyDir)).toThrow(/^OCR_PATH_OVERLAP/);
    // same path with different Windows casing → reject where applicable
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_PATH: modelRoot.toUpperCase(), MINERU_HOME_ROOT: modelRoot.toLowerCase() + osPathSep + "homes" } as never), anyDir)).toThrow(/^OCR_PATH_OVERLAP/);
    // disjoint paths → accept
    const elsewhere = import.meta.dirname + osPathSep + "disjoint-models";
    const config = resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_PATH: elsewhere, MINERU_HOME_ROOT: homeRoot } as never), { directoryExists: (path) => path === elsewhere })!;
    expect(config.modelPath).toBe(elsewhere);
    expect(config.homeRoot).toBe(homeRoot);
  });

  it("treats OCR_HOST_ID as explicit OCR configuration for the provider-required fail-fast rule (RF01 P2)", () => {
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ OCR_HOST_ID: "mineru-host-x" } as never))).toThrow(/^OCR_PROVIDER_REQUIRED:OCR_HOST_ID$/);
  });

  it("fails fast when MINERU_MODEL_PATH is absent or does not exist", () => {
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ OCR_PROVIDER: "mineru", MINERU_MODEL_SOURCE: "local" } as never))).toThrow(/^OCR_MODEL_PATH_REQUIRED/);
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_MODEL_PATH: "D:\\definitely\\missing\\dir\\xyz" } as never))).toThrow(/^OCR_MODEL_PATH_INVALID/);
  });

  it("fails fast on any tier other than the pinned flash (schema gate and resolver guard)", () => {
    // The environment schema itself rejects non-flash tiers at startup...
    expect(() => readEnvironment({ ...configured, MINERU_TIER: "standard" } as never)).toThrow();
    // ...and the resolver keeps its own guard for direct callers.
    const environment = { ...configured, MINERU_TIER: "standard", MINERU_MODEL_PATH: import.meta.dirname } as unknown as ReturnType<typeof readEnvironment>;
    expect(() => resolveMineruExecutorConfig(environment)).toThrow(/^OCR_TIER_UNSUPPORTED/);
  });

  it("fails fast when the executable cannot be resolved", () => {
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_EXECUTABLE: "definitely-not-mineru-xyz" } as never))).toThrow(/^OCR_EXECUTABLE_NOT_FOUND/);
  });

  it("fails fast on malformed MINERU_EXECUTABLE_ARGS", () => {
    expect(() => resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_EXECUTABLE_ARGS: "{nope" } as never))).toThrow(/^OCR_EXECUTABLE_ARGS_INVALID/);
  });

  it("resolves a bare executable name against explicit PATH directories", () => {
    const config = resolveMineruExecutorConfig(baseEnvironment({ ...configured, MINERU_EXECUTABLE: "fake-mineru-detective" } as never), { pathDirectories: ["D:\\\\tools"], fileExists: (path) => path === "D:\\\\tools\\\\fake-mineru-detective.exe" || path === "D:\\tools\\fake-mineru-detective.exe" })!;
    expect(config.executable).toMatch(/fake-mineru-detective\.exe$/);
  });
});
