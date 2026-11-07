export const statusLabel = (status: string, errorCode?: string | null) => {
  if (errorCode === "PASSWORD_REQUIRED" || status === "PASSWORD_REQUIRED") return "需要密码";
  if (errorCode === "OCR_REQUIRED" || status === "OCR_REQUIRED") return "需要 OCR";
  if (status === "INTELLIGENCE_READY") return "理解完成";
  if (status === "INGESTED") return "正文已提取，待理解";
  if (status === "SUCCEEDED" || status === "COMPLETED") return "已完成";
  if (status === "CANCELLED") return "已取消";
  if (status === "FAILED" || status === "REJECTED") return "失败";
  if (status === "RUNNING") return "处理中";
  return "等待处理";
};

/** Text extraction success is independent of a current AI understanding result. */
export const sourceStatusLabel = (status: string, hasIntelligence: boolean, errorCode?: string | null) => {
  if (hasIntelligence) return "理解完成";
  if (errorCode === "PASSWORD_REQUIRED" || errorCode === "OCR_REQUIRED") return statusLabel(status, errorCode);
  return status === "SUCCEEDED" || status === "COMPLETED" ? "正文已提取" : statusLabel(status, errorCode);
};

export const podcastStageLabel = (stage: string) => {
  if (stage === "COMPLETED") return "成片已就绪";
  if (stage === "SCRIPTING") return "脚本生成中";
  if (stage === "SYNTHESIZING") return "语音合成中";
  return "等待中";
};

export const videoStageLabel = (stage: string) => {
  if (stage === "COMPLETED") return "成片已就绪";
  if (stage === "SCRIPTING") return "分镜生成中";
  if (stage === "SYNTHESIZING") return "视频合成中";
  return "等待中";
};

const generationStages: Record<string, string> = {
  QUEUED: "等待生成", EPISODE_PLANNING: "节目规划中", NARRATIVE_DESIGN: "叙事设计中",
  SEGMENT_OUTLINE: "对话大纲生成中", SEGMENT_DRAFTING: "对话撰写中", HUMANIZATION: "对话润色中",
  GROUNDING_VALIDATION: "原文依据核验中", FINALIZING: "结果整理中", CONTEXT_RETRIEVAL: "资料检索中",
  VIDEO_PLANNING: "视频规划中", NARRATIVE_GENERATION: "讲述内容生成中", SCENE_PLANNING: "分镜生成中",
  NARRATION_SYNTHESIS: "旁白合成中", VISUAL_PREPARATION: "画面准备中", CAPTION_GENERATION: "字幕生成中",
  VIDEO_RENDERING: "视频渲染中", QUALITY_VALIDATION: "质量检查中", SPEECH_PREPARATION: "语音准备中",
  UTTERANCE_SYNTHESIS: "语音合成中", SEGMENT_ASSEMBLY: "片段组装中", EPISODE_ASSEMBLY: "音频组装中",
  AUDIO_NORMALIZATION: "音量调整中",
};

/** A finished script is not a playable artifact. Current pointers remain authoritative. */
export function generationStatusLabel(input: { kind: "podcast" | "video"; status: string; stage: string; hasArtifact?: boolean; hasScript?: boolean; audioStatus?: string | null; audioStage?: string | null }) {
  if (input.hasArtifact) return input.kind === "podcast" ? "音频可播放" : "视频可播放";
  if (input.kind === "podcast" && input.hasScript) {
    if (input.audioStatus === "FAILED") return "音频生成失败";
    if (input.audioStatus === "RUNNING") return generationStages[input.audioStage ?? ""] ?? "语音合成中";
    if (input.audioStatus === "QUEUED") return "等待语音合成";
    if (input.audioStatus === "SUCCEEDED") return "音频结果待核对";
    return "文稿已就绪，待生成音频";
  }
  if (input.status === "FAILED") return "生成失败";
  if (input.status === "SUCCEEDED" || input.stage === "COMPLETED") return "生成结果待核对";
  if (input.status === "RUNNING" || input.status === "GENERATING") return generationStages[input.stage] ?? "生成中";
  if (input.status === "QUEUED") return "等待生成";
  if (input.status === "DRAFT") return "尚未开始";
  return "状态待确认";
}
