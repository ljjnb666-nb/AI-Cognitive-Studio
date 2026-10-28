-- Human verdict is append-only and never changes candidate/canonical text/Gold.
ALTER TABLE "PdfVisualReviewCandidate"
  ADD CONSTRAINT "PdfVisualReviewCandidate_review_parent_uq" UNIQUE ("id", "workspaceId", "sourceDocumentId");

CREATE TABLE "PdfVisualHumanReviewEvent" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "reviewerUserId" TEXT NOT NULL,
  "sourcePdfSha256" TEXT NOT NULL,
  "candidateSha256" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PdfVisualHumanReviewEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PdfVisualHumanReviewEvent_validity" CHECK (
    "action" IN ('CONFIRM_STRUCTURE','REJECT_STRUCTURE','WITHDRAW') AND
    "sourcePdfSha256" ~ '^[0-9a-f]{64}$' AND
    "candidateSha256" ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX "PdfVisualHumanReviewEvent_candidate_idx"
  ON "PdfVisualHumanReviewEvent" ("candidateId","createdAt","id");
CREATE INDEX "PdfVisualHumanReviewEvent_scope_idx"
  ON "PdfVisualHumanReviewEvent" ("workspaceId","sourceDocumentId");
ALTER TABLE "PdfVisualHumanReviewEvent"
  ADD CONSTRAINT "PdfVisualHumanReviewEvent_candidate_fkey"
  FOREIGN KEY ("candidateId","workspaceId","sourceDocumentId")
  REFERENCES "PdfVisualReviewCandidate"("id","workspaceId","sourceDocumentId")
  ON DELETE CASCADE ON UPDATE CASCADE;
