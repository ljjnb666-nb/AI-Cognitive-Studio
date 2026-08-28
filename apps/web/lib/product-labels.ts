export const statusLabel = (status: string, errorCode?: string | null) => {
  if (errorCode === "PASSWORD_REQUIRED" || status === "PASSWORD_REQUIRED") return "需要密码";
  if (errorCode === "OCR_REQUIRED" || status === "OCR_REQUIRED") return "需要 OCR";
  if (status === "SUCCEEDED" || status === "COMPLETED") return "理解完成";
  if (status === "FAILED" || status === "REJECTED") return "失败";
  if (status === "RUNNING") return "处理中";
  return "等待处理";
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
