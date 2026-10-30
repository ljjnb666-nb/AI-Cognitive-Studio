ALTER TABLE "OcrModelReviewEvent" ADD COLUMN "reportedModelId" TEXT;
ALTER INDEX "OcrModelReviewEvent_workspaceId_sourceDocumentId_ingestionRunId_physicalPageIndex_idx"
 RENAME TO "OcrModelReviewEvent_scope_page_idx";
