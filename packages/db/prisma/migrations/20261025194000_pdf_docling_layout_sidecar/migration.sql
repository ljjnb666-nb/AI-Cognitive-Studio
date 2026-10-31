-- PDF production Stage 2: immutable, non-authoritative Docling page layout sidecars.
-- Only successful completed PDF ingestions are eligible in the application.
-- No existing source, extraction, current marker or OCR attempt is updated.
CREATE TABLE "DoclingLayoutSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "physicalPageIndex" INTEGER NOT NULL,
  "routingGeneration" INTEGER NOT NULL,
  "sourceSha256" TEXT NOT NULL,
  "parserName" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "modelSha256" TEXT NOT NULL,
  "markdownSha256" TEXT NOT NULL,
  "markdownStorageKey" TEXT NOT NULL,
  "textItemCount" INTEGER NOT NULL,
  "pictureItemCount" INTEGER NOT NULL,
  "tableItemCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DoclingLayoutSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DoclingLayoutSnapshot_nonnegative" CHECK (
    "physicalPageIndex" >= 0 AND "routingGeneration" >= 0 AND
    "textItemCount" >= 0 AND "pictureItemCount" >= 0 AND "tableItemCount" >= 0
  )
);
CREATE UNIQUE INDEX "DoclingLayoutSnapshot_unique_page_model"
ON "DoclingLayoutSnapshot" ("ingestionRunId", "physicalPageIndex", "routingGeneration", "parserName", "parserVersion", "modelSha256");
CREATE INDEX "DoclingLayoutSnapshot_workspace_source_idx"
ON "DoclingLayoutSnapshot" ("workspaceId", "sourceDocumentId");
ALTER TABLE "DoclingLayoutSnapshot"
ADD CONSTRAINT "DoclingLayoutSnapshot_ingestion_source_workspace_fkey"
FOREIGN KEY ("ingestionRunId", "sourceDocumentId", "workspaceId")
REFERENCES "IngestionRun"("id", "sourceDocumentId", "workspaceId")
ON DELETE CASCADE ON UPDATE CASCADE;
