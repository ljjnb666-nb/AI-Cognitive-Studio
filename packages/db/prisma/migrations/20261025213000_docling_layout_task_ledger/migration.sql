-- Durable attempt ledger: Redis is only a delivery transport.
CREATE TYPE "DoclingLayoutTaskStatus" AS ENUM ('PENDING','RUNNING','SUCCEEDED','FAILED');
CREATE TABLE "DoclingLayoutTask" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "physicalPageIndex" INTEGER NOT NULL,
  "routingGeneration" INTEGER NOT NULL,
  "modelSha256" TEXT NOT NULL,
  "status" "DoclingLayoutTaskStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DoclingLayoutTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DoclingLayoutTask_nonnegative" CHECK (
    "physicalPageIndex" >= 0 AND "routingGeneration" >= 0 AND
    "attemptCount" BETWEEN 0 AND 2
  ),
  CONSTRAINT "DoclingLayoutTask_claim_state" CHECK (
    ("status" = 'RUNNING' AND "claimToken" IS NOT NULL AND "leaseUntil" IS NOT NULL)
    OR
    ("status" <> 'RUNNING' AND "claimToken" IS NULL AND "leaseUntil" IS NULL)
  ),
  CONSTRAINT "DoclingLayoutTask_model_sha" CHECK ("modelSha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "DoclingLayoutTask_unique_page_model"
  ON "DoclingLayoutTask" ("ingestionRunId", "physicalPageIndex", "routingGeneration", "modelSha256");
CREATE INDEX "DoclingLayoutTask_status_lease_idx"
  ON "DoclingLayoutTask" ("status", "leaseUntil");
CREATE INDEX "DoclingLayoutTask_workspace_source_idx"
  ON "DoclingLayoutTask" ("workspaceId", "sourceDocumentId");
ALTER TABLE "DoclingLayoutTask"
  ADD CONSTRAINT "DoclingLayoutTask_ingestion_source_workspace_fkey"
  FOREIGN KEY ("ingestionRunId","sourceDocumentId","workspaceId")
  REFERENCES "IngestionRun"("id","sourceDocumentId","workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
