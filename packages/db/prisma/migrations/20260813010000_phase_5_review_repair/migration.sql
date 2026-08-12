-- Phase 5 review repair: bind plan and evidence provenance to authoritative lineage.
ALTER TABLE "ShortVideoPlan"
  ADD CONSTRAINT "ShortVideoPlan_id_workspaceId_key" UNIQUE ("id", "workspaceId");
ALTER TABLE "ShortVideoGenerationRun"
  ADD CONSTRAINT "ShortVideoGenerationRun_id_workspaceId_key" UNIQUE ("id", "workspaceId");
ALTER TABLE "ShortVideoPlan"
  ADD CONSTRAINT "ShortVideoPlan_run_workspace_key" UNIQUE ("shortVideoGenerationRunId", "workspaceId");
ALTER TABLE "ShortVideoPlan"
  DROP CONSTRAINT "ShortVideoPlan_shortVideoGenerationRunId_fkey",
  ADD CONSTRAINT "ShortVideoPlan_run_workspace_fkey"
  FOREIGN KEY ("shortVideoGenerationRunId", "workspaceId")
  REFERENCES "ShortVideoGenerationRun"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShortVideoNarrationEvidence"
  DROP CONSTRAINT "ShortVideoNarrationEvidence_sourceBlockId_fkey",
  ADD CONSTRAINT "ShortVideoNarrationEvidence_sourceBlock_extraction_fkey"
  FOREIGN KEY ("sourceBlockId", "extractionId")
  REFERENCES "SourceBlock"("id", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ShortVideoNarrationEvidence_pinned_lineage_idx"
  ON "ShortVideoNarrationEvidence"("workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId");
ALTER TABLE "ShortVideoGenerationSource"
  ADD CONSTRAINT "ShortVideoGenerationSource_pinned_lineage_key"
  UNIQUE ("shortVideoGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId");
ALTER TABLE "ShortVideoGenerationSource"
  ADD CONSTRAINT "ShortVideoGenerationSource_extraction_lineage_fkey"
  FOREIGN KEY ("extractionId", "sourceDocumentId", "workspaceId")
  REFERENCES "DocumentExtraction"("id", "sourceDocumentId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShortVideoGenerationSource_chunk_lineage_fkey"
  FOREIGN KEY ("chunkSetId", "workspaceId", "sourceDocumentId", "extractionId")
  REFERENCES "ChunkSet"("id", "workspaceId", "sourceDocumentId", "extractionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShortVideoGenerationSource_analysis_lineage_fkey"
  FOREIGN KEY ("analysisRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId")
  REFERENCES "BookAnalysisRun"("id", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShortVideoNarrationEvidence"
  ADD CONSTRAINT "ShortVideoNarrationEvidence_pinned_source_fkey"
  FOREIGN KEY ("shortVideoGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId")
  REFERENCES "ShortVideoGenerationSource"("shortVideoGenerationRunId", "workspaceId", "sourceDocumentId", "extractionId", "chunkSetId", "analysisRunId") ON DELETE RESTRICT ON UPDATE CASCADE;
