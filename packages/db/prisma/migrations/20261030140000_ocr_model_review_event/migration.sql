CREATE TABLE "OcrModelReviewEvent" (
 "id" TEXT PRIMARY KEY, "jobId" TEXT NOT NULL UNIQUE,
 "workspaceId" TEXT NOT NULL, "sourceDocumentId" TEXT NOT NULL,
 "ingestionRunId" TEXT NOT NULL, "physicalPageIndex" INTEGER NOT NULL CHECK ("physicalPageIndex">=0),
 "receiptId" TEXT NOT NULL, "sourcePdfSha256" TEXT NOT NULL,
 "sourcePngSha256" TEXT NOT NULL, "ocrTextSha256" TEXT NOT NULL,
 "evidenceSha256" TEXT NOT NULL, "invocationId" TEXT NOT NULL UNIQUE,
 "snapshotId" TEXT NOT NULL, "providerKey" TEXT NOT NULL, "modelId" TEXT NOT NULL,
 "decision" TEXT NOT NULL CHECK ("decision" IN ('PASSED','REJECTED','REVIEW_REQUIRED')),
 "reasons" JSONB NOT NULL, "usage" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE,
 FOREIGN KEY ("receiptId") REFERENCES "OcrPageExecution"("id") ON DELETE CASCADE,
 FOREIGN KEY ("invocationId","workspaceId") REFERENCES "ProviderInvocation"("id","workspaceId") ON DELETE RESTRICT
);
CREATE INDEX "OcrModelReviewEvent_workspaceId_sourceDocumentId_ingestionRunId_physicalPageIndex_idx"
 ON "OcrModelReviewEvent"("workspaceId","sourceDocumentId","ingestionRunId","physicalPageIndex");
CREATE FUNCTION reject_ocr_model_review_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OCR_MODEL_REVIEW_IMMUTABLE' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER "OcrModelReviewEvent_immutable" BEFORE UPDATE ON "OcrModelReviewEvent"
 FOR EACH ROW EXECUTE FUNCTION reject_ocr_model_review_update();
