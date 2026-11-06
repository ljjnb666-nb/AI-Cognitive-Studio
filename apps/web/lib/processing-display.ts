import { processingCopy, type ProcessingStatus, type ProcessingWorkerAvailability, type WorkerAvailability } from "./processing-state";

export type StatusTone = "success" | "warning" | "danger" | "muted";
export type ProcessingGroup = "READY" | "ACTIVE" | "WAITING" | "ATTENTION";

/** Capability heartbeats indicate service availability, not ownership of this book's task. */
export function processingWorkersDisplay(availability: WorkerAvailability | ProcessingWorkerAvailability) {
  return ([['ingestion', '正文提取'], ['bookAnalysis', 'AI 深度理解']] as const).map(([capability, label]) => {
    const status = typeof availability === "string" ? availability : availability[capability];
    return { capability, label, status, statusLabel: status === "AVAILABLE" ? "在线" : status === "DEGRADED" ? "不可用" : "待确认", tone: (status === "AVAILABLE" ? "success" : "warning") as StatusTone };
  });
}

/** Presentation of the server's durable processing contract, shared by every surface. */
export function processingDisplay(processing: ProcessingStatus, errorCode?: string | null) {
  const { state, stageAvailability, stage } = processing;
  const code = errorCode?.replace(/^SOURCE_/, "");
  let label: string;
  let group: ProcessingGroup;
  let description = processingCopy[state];
  switch (state) {
    case "SUCCEEDED": label = "理解完成"; group = "READY"; break;
    case "INGESTION_FAILED":
      label = code === "PASSWORD_REQUIRED" ? "需要密码" : code === "OCR_REQUIRED" ? "需要 OCR" : code === "OCR_REVIEW_REQUIRED" ? "待人工复核" : code === "QUALITY_REJECTED" || code === "QUALITY_GATE_BLOCKED" ? "质量未通过" : "提取失败";
      description = code === "PASSWORD_REQUIRED" ? "文件受到密码保护，请使用可读取的文件重新导入。" : code === "OCR_REQUIRED" ? "这份文件需要 OCR 识别，当前尚未提取出可用正文。" : code === "OCR_REVIEW_REQUIRED" ? "识别结果需要人工复核，尚未作为正式正文使用。" : code === "QUALITY_REJECTED" || code === "QUALITY_GATE_BLOCKED" ? "识别结果未通过质量检查，尚不能用于 AI 理解或播客生成。" : description;
      if (code === "CORRUPTED") description = "文件内部结构或正文语法未通过校验，请修复或重新导出文件后再导入。重复解析同一文件通常无法解决。";
      if (code === "ARCHIVE_UNSAFE") description = "电子书内部结构未通过安全校验，尚未提取正文。请使用可信工具重新导出后再导入。";
      if (code === "PARSE_ERROR") description = "提取程序未能完成文件读取。后台仅记录了通用提取错误，具体原因尚未确认；这不代表文件一定损坏。可尝试重新提取，若仍失败，请重新导出 PDF / EPUB 后导入。";
      if (code === "PARSE_TIMEOUT") description = "正文提取超过处理时限，任务已停止。可尝试重新提取，或拆分较大的文件后导入。";
      const otherReasons: Record<string, string> = {
        TOO_LARGE: "文件或提取结果超过大小限制，请拆分文件后导入。",
        UNSUPPORTED_TYPE: "当前不支持此文件格式，请转换为 PDF 或 EPUB 后导入。",
        TYPE_MISMATCH: "文件实际格式与扩展名不一致，请使用正确格式重新导出。",
        OBJECT_MISSING: "后台无法找到已上传的原文件，请重新上传。",
        STORAGE_ERROR: "后台读取或保存文件时发生存储错误，请检查存储服务后重新提取。",
        EPUB_FIXED_LAYOUT_UNSUPPORTED: "此 EPUB 为固定版式且没有可用正文，请导出可提取文字的 PDF 或 EPUB 后导入。",
        EPUB_NO_USABLE_TEXT: "此 EPUB 未包含可使用的正文文字，可能是图片内容，请换用包含文字的版本。",
        CANONICAL_BLOCK_CONTRACT_INVALID: "提取结果未通过内部数据校验，尚未发布正文，请检查后台日志。",
        FORMAT_METADATA_CONTRACT_INVALID: "提取出的格式信息未通过内部校验，尚未发布正文，请检查后台日志。",
      };
      if (code && otherReasons[code]) description = otherReasons[code];
      if (!code) description = "正文提取失败，但后台没有记录具体错误原因。可尝试重新提取；若仍失败，请检查后台提取日志。";
      group = "ATTENTION"; break;
    case "ANALYSIS_FAILED":
      label = "理解失败"; group = "ATTENTION";
      if (code === "TIMEOUT") { label = "理解超时"; description = "云端模型未在等待时限内返回，AI 理解已停止。正文与已完成结果保留；超时请求是否扣费暂无法确认。请勿连续点击恢复。"; }
      if (code === "INVALID_PROVIDER_RESPONSE") { label = "模型响应异常"; description = "模型返回内容未通过格式校验，不能作为理解结果使用，任务已停止。正文与已完成结果保留；本次请求可能已计费，请勿连续点击恢复。"; }
      if (code === "ANALYSIS_MEMORY_TYPE_UNSUPPORTED") { label = "记忆分类异常"; description = "模型返回了系统不支持的记忆分类，该分块尚未作为有效理解成果保存。已完成分块保留；需要按约定分类重新生成，已发出的请求可能已计费。"; }
      if (code === "ANALYSIS_PROVIDER_RESPONSE_INVALID") { label = "理解结果校验失败"; description = "模型已返回内容，但其中的字段、分类或数据类型未通过理解结果校验；这不代表正文损坏。已完成分块与原回执保留，请核查具体字段后恢复。"; }
      if (code === "OUTPUT_TRUNCATED") { label = "模型输出不完整"; description = "模型达到单次输出长度限制，答案被截断，未作为有效理解结果保存。已完成分块保留；请在修复生成设置后恢复，已发出的请求可能已计费。"; }
      if (code === "BUDGET_EXCEEDED") { label = "处理额度不足"; description = "当前预算或处理额度不足，AI 理解已停止。正文与已完成分块保留；请核对本机任务额度、当日额度及预算设置后再恢复。资源单位不是人民币金额，此提示不代表服务商账户余额不足。"; }
      if (code === "CONTENT_REJECTED") description = "模型服务商因内容审核拒绝了本次理解请求。已完成结果保留，全书理解尚未完成。请联系服务商核实；重复提交不能保证解决。";
      break;
    case "BOOTSTRAP_FAILED": label = "准备失败"; group = "ATTENTION"; break;
    case "PROCESSING_DEGRADED": label = "需要处理"; group = "ATTENTION"; break;
    case "WAITING_FOR_PROVIDER": label = "待配置 AI"; group = "WAITING"; break;
    case "NOT_STARTED": label = "尚未开始"; group = "WAITING"; break;
    case "WAITING_FOR_ANALYSIS": label = "待开始理解"; group = "WAITING"; break;
    case "BOOTSTRAP_SUCCEEDED": label = "待核对结果"; group = "ATTENTION"; break;
    case "QUEUED_FOR_INGESTION": label = "提取排队中"; group = "WAITING"; break;
    case "ANALYSIS_QUEUED": label = "理解排队中"; group = "WAITING"; break;
    case "INGESTING": label = "正文提取中"; group = "ACTIVE"; break;
    case "ANALYZING": label = "AI 理解中"; group = "ACTIVE"; break;
  }
  if (state === "QUEUED_FOR_INGESTION" || state === "ANALYSIS_QUEUED") {
    const task = state === "QUEUED_FOR_INGESTION" ? "正文提取" : "AI 深度理解";
    description = stageAvailability === "AVAILABLE" ? `${task}任务已排队，后台服务在线，等待后台服务接单。` : `${task}任务已排队，暂时无法确认后台服务状态。`;
  }
  const waitingForService = stageAvailability === "DEGRADED" && ["QUEUED_FOR_INGESTION", "ANALYSIS_QUEUED", "WAITING_FOR_ANALYSIS"].includes(state);
  if (waitingForService) {
    label = "等待服务";
    group = "WAITING";
    description = stage === "BOOK_ANALYSIS" ? "正文提取已完成。AI 深度理解等待后台服务启动。" : "文件已保存，正文提取等待后台服务启动。";
  }
  if ((state === "INGESTING" || state === "ANALYZING") && stageAvailability !== "AVAILABLE") {
    label = "执行待确认";
    group = "WAITING";
    description = "任务记录显示已开始执行，但当前无法确认后台服务是否在线，正在核对执行状态。";
  }
  if (state === "INGESTION_FAILED" && processing.failureReason) description = processing.failureReason;
  const tone: StatusTone = group === "READY" ? "success" : group === "ATTENTION" ? "danger" : group === "ACTIVE" || state === "WAITING_FOR_PROVIDER" ? "warning" : "muted";
  return { label, group, tone, description, active: group === "ACTIVE" };
}
