export type BookAnalysisProgress = { runId: string; stage: string; completedChunks: number; totalChunks: number };

const stages: Record<string, string> = {
  QUEUED: "等待开始", CHUNK_ANALYSIS: "分块理解", SECTION_ANALYSIS: "分节归并", CHAPTER_ANALYSIS: "章节综合", BOOK_SYNTHESIS: "全书综合", MEMORY_FINALIZATION: "整理理解结果", EMBEDDINGS: "生成检索索引", FINALIZING: "核验与保存", COMPLETED: "处理完成",
};
export function bookAnalysisProgressDisplay(progress: BookAnalysisProgress) {
  const percent = progress.totalChunks > 0 ? Math.min(100, Math.round(progress.completedChunks / progress.totalChunks * 1000) / 10) : null;
  return { stage: stages[progress.stage] ?? "处理中", percent, chunksComplete: progress.totalChunks > 0 && progress.completedChunks >= progress.totalChunks };
}

/** 阶段来自持久化任务，不按耗时推测全书百分比。 */
export function bookAnalysisPhaseDescription(stage: string): string {
  const descriptions: Record<string, string> = {
    SECTION_ANALYSIS: "分块理解已完成，当前阶段为分节归并。全书处理尚未完成。",
    CHAPTER_ANALYSIS: "分块理解已完成，当前阶段为章节综合。全书处理尚未完成。",
    BOOK_SYNTHESIS: "分块理解已完成，当前阶段是全书综合，之后还需整理结果、生成检索索引并核验保存。",
    MEMORY_FINALIZATION: "当前阶段为整理全书观点、记忆与原文关联，之后还需生成检索索引并核验保存。",
    EMBEDDINGS: "当前阶段为生成检索索引，完成后还需核验与保存。",
    FINALIZING: "当前阶段为核验结果完整性与保存；核验通过后才会标记理解完成。",
    COMPLETED: "全书处理已完成。",
  };
  return descriptions[stage] ?? "分块理解已完成，全书结果仍需后续处理，尚未全部完成。";
}
