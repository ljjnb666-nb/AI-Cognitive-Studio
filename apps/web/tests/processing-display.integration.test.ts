import { describe, expect, it } from "vitest";
import { processingDisplay, processingWorkersDisplay } from "../lib/processing-display";
import { sourceProcessingSnapshot, type ProcessingState } from "../lib/processing-state";
import { generationStatusLabel } from "../lib/product-labels";

describe("shared product status presentation", () => {
  it("预算阻断说明处理额度不足，不误称模型或提取失败",()=>{
    const result=processingDisplay({state:"ANALYSIS_FAILED",stage:"BOOK_ANALYSIS",recoveryAction:"RETRY_ANALYSIS",stageAvailability:"AVAILABLE"},"BUDGET_EXCEEDED");expect(result).toMatchObject({label:"处理额度不足",active:false,description:expect.stringContaining("资源单位不是人民币金额")});expect(result.description).toContain("已完成分块保留");expect(result.description).toContain("不代表服务商账户余额不足");
  });
  it("模型格式异常明确展示，不混同超时或审核拒绝",()=>{
    const result=processingDisplay({state:"ANALYSIS_FAILED",stage:"BOOK_ANALYSIS",recoveryAction:"RETRY_ANALYSIS",stageAvailability:"AVAILABLE"},"INVALID_PROVIDER_RESPONSE");expect(result).toMatchObject({label:"模型响应异常",active:false,description:expect.stringContaining("未通过格式校验")});expect(result.description).toContain("可能已计费");expect(result.description).not.toContain("审核拒绝");
  });
  it("模型超时与服务离线或审核拒绝分开显示，并提示费用未知",()=>{
    const result=processingDisplay({state:"ANALYSIS_FAILED",stage:"BOOK_ANALYSIS",recoveryAction:"RETRY_ANALYSIS",stageAvailability:"AVAILABLE"},"TIMEOUT");
    expect(result).toMatchObject({label:"理解超时",active:false,description:expect.stringContaining("云端模型未在等待时限内返回")});expect(result.description).toContain("是否扣费暂无法确认");expect(result.description).not.toContain("审核拒绝");
  });
  it("explains a provider content rejection separately from extraction or worker availability", () => {
    const result = processingDisplay({ state: "ANALYSIS_FAILED", stage: "BOOK_ANALYSIS", recoveryAction: "RETRY_ANALYSIS", stageAvailability: "AVAILABLE" }, "CONTENT_REJECTED");
    expect(result).toMatchObject({ label: "理解失败", active: false, description: expect.stringContaining("模型服务商因内容审核拒绝") });
    expect(result.description).toContain("已完成结果保留");
  });
  it("explains unresolved scanned pages from durable routing without bypassing quality", () => {
    const input = { hasIntelligence: false, workerAvailability: "AVAILABLE" as const, ingestion: { status: "REJECTED", errorCode: "SOURCE_QUALITY_REJECTED", routingPlan: { schemaVersion: "pdf-routing-plan-v1", pages: [{ route: "OCR_REQUIRED", physicalPageIndex: 0 }, { route: "NATIVE_TEXT", physicalPageIndex: 1 }] }, routingOutcome: { schemaVersion: "pdf-routing-outcome-v1", unresolvedPhysicalPageIndexes: [0, 1] } } };
    const result = sourceProcessingSnapshot(input);
    expect(processingDisplay(result.processing, result.errorCode)).toMatchObject({ label: "质量未通过", active: false, description: expect.stringContaining("1 页需要 OCR") });
    expect(sourceProcessingSnapshot({ ...input, hasIntelligence: true }).processing.failureReason).toBeUndefined();
  });
  it("explains extraction failures without guessing that a generic parser error means corruption", () => {
    const status = { state: "INGESTION_FAILED", stage: "INGESTION", recoveryAction: "RETRY_INGESTION", stageAvailability: "AVAILABLE" } as const;
    expect(processingDisplay(status, "SOURCE_PARSE_ERROR")).toMatchObject({ label: "提取失败", description: expect.stringContaining("具体原因尚未确认") });
    expect(processingDisplay(status, "SOURCE_PARSE_TIMEOUT").description).toContain("处理时限");
    expect(processingDisplay(status, "SOURCE_STORAGE_ERROR").description).toContain("存储错误");
    expect(processingDisplay(status).description).toContain("没有记录具体错误原因");
  });
  it("separates available services from task execution and detects uncertain execution", () => {
    const base = { stage: "INGESTION", recoveryAction: "RECHECK" } as const;
    const queued = processingDisplay({ ...base, state: "QUEUED_FOR_INGESTION", stageAvailability: "AVAILABLE" });
    expect(queued).toMatchObject({ active: false, description: expect.stringContaining("等待后台服务接单") });
    expect(processingDisplay({ ...base, state: "INGESTING", stageAvailability: "AVAILABLE" })).toMatchObject({ active: true, label: "正文提取中" });
    for (const stageAvailability of ["DEGRADED", "UNKNOWN"] as const) {
      expect(processingDisplay({ ...base, state: "INGESTING", stageAvailability })).toMatchObject({ active: false, label: "执行待确认" });
    }
    const workers = processingWorkersDisplay({ ingestion: "AVAILABLE", bookAnalysis: "DEGRADED", podcastGeneration: "UNKNOWN", podcastAudio: "UNKNOWN", shortVideoGeneration: "UNKNOWN" });
    expect(workers.map(worker => worker.statusLabel)).toEqual(["在线", "不可用"]);
    expect(processingWorkersDisplay("UNKNOWN").every(worker => worker.statusLabel === "待确认")).toBe(true);
  });
  it.each([
    ["NOT_STARTED", "尚未开始", false], ["QUEUED_FOR_INGESTION", "提取排队中", false],
    ["INGESTING", "正文提取中", true], ["WAITING_FOR_ANALYSIS", "待开始理解", false],
    ["ANALYSIS_QUEUED", "理解排队中", false], ["ANALYZING", "AI 理解中", true],
    ["WAITING_FOR_PROVIDER", "待配置 AI", false], ["BOOTSTRAP_FAILED", "准备失败", false],
    ["BOOTSTRAP_SUCCEEDED", "待核对结果", false], ["SUCCEEDED", "理解完成", false],
    ["INGESTION_FAILED", "提取失败", false], ["ANALYSIS_FAILED", "理解失败", false],
    ["PROCESSING_DEGRADED", "需要处理", false],
  ] as const)("presents %s without fictional running progress", (state, label, active) => {
    expect(processingDisplay({ state: state as ProcessingState, stage: "BOOK_ANALYSIS", stageAvailability: "AVAILABLE", recoveryAction: "NONE" })).toMatchObject({ label, active });
  });
  it("distinguishes absent workers, unknown health and blocked content", () => {
    const status = { state: "ANALYSIS_QUEUED", stage: "BOOK_ANALYSIS", recoveryAction: "RECHECK" } as const;
    expect(processingDisplay({ ...status, stageAvailability: "DEGRADED" })).toMatchObject({ label: "等待服务", active: false, description: "正文提取已完成。AI 深度理解等待后台服务启动。" });
    expect(processingDisplay({ ...status, stageAvailability: "UNKNOWN" }).label).toBe("理解排队中");
    for (const [errorCode, label] of [["PASSWORD_REQUIRED", "需要密码"], ["OCR_REQUIRED", "需要 OCR"], ["SOURCE_PASSWORD_REQUIRED", "需要密码"], ["SOURCE_OCR_REQUIRED", "需要 OCR"], ["SOURCE_OCR_REVIEW_REQUIRED", "待人工复核"], ["SOURCE_QUALITY_REJECTED", "质量未通过"], ["SOURCE_QUALITY_GATE_BLOCKED", "质量未通过"]]) {
      expect(processingDisplay({ state: "INGESTION_FAILED", stage: "INGESTION", recoveryAction: "RETRY_INGESTION", stageAvailability: "AVAILABLE" }, errorCode)).toMatchObject({ label, group: "ATTENTION", active: false });
    }
  });
  it("uses the same bootstrap state and active-stage error across list, detail and API projections", () => {
    const ingestion = { status: "SUCCEEDED", errorCode: "OLD_INGESTION_ERROR", createdAt: new Date("2026-01-01") };
    const bootstrap = { status: "WAITING_FOR_PROVIDER", errorCode: "AI_PROVIDER_CONFIGURATION_REQUIRED", createdAt: new Date("2026-01-02") };
    const result = sourceProcessingSnapshot({ ingestion, bootstrap, hasIntelligence: false, workerAvailability: "AVAILABLE" });
    expect(result).toMatchObject({ processing: { state: "WAITING_FOR_PROVIDER" }, errorCode: bootstrap.errorCode, processingSince: bootstrap.createdAt.toISOString() });
    expect(sourceProcessingSnapshot({ ingestion, bootstrap, hasIntelligence: true, workerAvailability: "AVAILABLE" }).errorCode).toBeNull();
  });
  it("distinguishes a malformed ebook from a temporary upload or service error", () => {
    const status = { state: "INGESTION_FAILED", stage: "INGESTION", recoveryAction: "RETRY_INGESTION", stageAvailability: "AVAILABLE" } as const;
    expect(processingDisplay(status, "SOURCE_CORRUPTED")).toMatchObject({ label: "提取失败", active: false, description: expect.stringContaining("重新导出") });
    expect(processingDisplay(status, "SOURCE_ARCHIVE_UNSAFE").description).toContain("安全校验");
  });
  it("does not invent a queued run when no durable task exists", () => {
    expect(sourceProcessingSnapshot({ hasIntelligence: false, workerAvailability: "AVAILABLE" })).toMatchObject({ processing: { state: "NOT_STARTED" }, processingSince: null });
  });
  it("separates script success, audio progress, failure and a current playable artifact", () => {
    const podcast = { kind: "podcast", status: "SUCCEEDED", stage: "COMPLETED", hasScript: true } as const;
    expect(generationStatusLabel(podcast)).toBe("文稿已就绪，待生成音频");
    expect(generationStatusLabel({ ...podcast, audioStatus: "RUNNING", audioStage: "UTTERANCE_SYNTHESIS" })).toBe("语音合成中");
    expect(generationStatusLabel({ ...podcast, audioStatus: "FAILED" })).toBe("音频生成失败");
    expect(generationStatusLabel({ ...podcast, audioStatus: "FAILED", hasArtifact: true })).toBe("音频可播放");
    expect(generationStatusLabel({ kind: "video", status: "SUCCEEDED", stage: "COMPLETED", hasArtifact: false })).toBe("生成结果待核对");
    expect(generationStatusLabel({ kind: "video", status: "RUNNING", stage: "VIDEO_RENDERING" })).toBe("视频渲染中");
  });
});

it("截断输出显示明确中文原因，原始错误编号不进入错误类型文案", async () => {
  const { processingErrorType } = await import("../lib/product-errors");
  const status = {state:"ANALYSIS_FAILED" as const,stage:"BOOK_ANALYSIS" as const,recoveryAction:"RETRY_ANALYSIS" as const,stageAvailability:"AVAILABLE" as const};
  expect(processingDisplay(status,"OUTPUT_TRUNCATED")).toMatchObject({label:"模型输出不完整",description:expect.stringContaining("答案被截断")});
  expect(processingErrorType("INVALID_PROVIDER_RESPONSE")).toBe("模型返回格式异常");
  expect(processingErrorType("OUTPUT_TRUNCATED")).toBe("模型输出被截断");
  expect(processingErrorType("PRIVATE_UNKNOWN_ERROR")).toBe("处理异常，具体原因待核查");
});

it("分类不兼容与缺字段分开显示，不伪装为成功", async () => {
  const { processingErrorType } = await import("../lib/product-errors");
  const status = {state:"ANALYSIS_FAILED" as const,stage:"BOOK_ANALYSIS" as const,recoveryAction:"RETRY_ANALYSIS" as const,stageAvailability:"AVAILABLE" as const};
  expect(processingDisplay(status,"ANALYSIS_MEMORY_TYPE_UNSUPPORTED")).toMatchObject({label:"记忆分类异常",active:false});
  expect(processingErrorType("ANALYSIS_MEMORY_TYPE_UNSUPPORTED")).toBe("模型返回了不支持的记忆分类");
});
