export type BookAnalysisProgress = { runId: string; stage: string; completedChunks: number; totalChunks: number };

const stages: Record<string, string> = {
  QUEUED: "等待开始", CHUNK_ANALYSIS: "分块理解", SECTION_ANALYSIS: "分节归并", CHAPTER_ANALYSIS: "章节综合", BOOK_SYNTHESIS: "全书综合", MEMORY_FINALIZATION: "整理理解结果", EMBEDDINGS: "生成检索索引", FINALIZING: "核验与保存", COMPLETED: "处理完成",
};
export function bookAnalysisProgressDisplay(progress: BookAnalysisProgress) {
  const percent = progress.totalChunks > 0 ? Math.min(100, Math.round(progress.completedChunks / progress.totalChunks * 1000) / 10) : null;
  return { stage: stages[progress.stage] ?? "处理中", percent, chunksComplete: progress.totalChunks > 0 && progress.completedChunks >= progress.totalChunks };
}
