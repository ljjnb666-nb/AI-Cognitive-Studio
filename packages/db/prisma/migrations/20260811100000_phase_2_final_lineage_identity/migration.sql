-- Additive Phase 2 closure: durable semantic lineage and exact embedding identity.
ALTER TABLE "AnalysisArtifact" ADD COLUMN "extractionId" TEXT;
ALTER TABLE "AnalysisArtifact" ADD COLUMN "structureVersion" TEXT;

UPDATE "AnalysisArtifact" AS artifact
SET "extractionId" = run."extractionId"
FROM "BookAnalysisRun" AS run
WHERE artifact."analysisRunId" = run."id";

UPDATE "AnalysisArtifact" AS artifact
SET "structureVersion" = node."structureVersion"
FROM "DocumentStructureNode" AS node
WHERE artifact."structureNodeId" = node."id";

ALTER TABLE "AnalysisArtifact" ALTER COLUMN "extractionId" SET NOT NULL;
ALTER TABLE "AnalysisArtifact" ADD CONSTRAINT "AnalysisArtifact_structure_lineage_fkey"
  FOREIGN KEY ("structureNodeId", "extractionId", "structureVersion")
  REFERENCES "DocumentStructureNode"("id", "extractionId", "structureVersion")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnalysisArtifact" ADD CONSTRAINT "AnalysisArtifact_scope_identity_check" CHECK (
  ("scope" = 'CHUNK' AND "chunkId" IS NOT NULL) OR
  ("scope" IN ('SECTION', 'CHAPTER') AND "structureNodeId" IS NOT NULL AND "structureVersion" IS NOT NULL) OR
  ("scope" = 'BOOK' AND "chunkId" IS NULL AND "structureNodeId" IS NULL)
);

ALTER TABLE "BookMemoryItem" ADD CONSTRAINT "BookMemoryItem_source_artifact_lineage_fkey"
  FOREIGN KEY ("sourceArtifactId", "analysisRunId")
  REFERENCES "AnalysisArtifact"("id", "analysisRunId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "BookMemoryItem" AS item
SET "sourceArtifactId" = (
  SELECT artifact."id"
  FROM "AnalysisArtifact" AS artifact
  WHERE artifact."analysisRunId" = item."analysisRunId"
  ORDER BY CASE artifact."scope" WHEN 'BOOK' THEN 0 ELSE 1 END, artifact."ordinal", artifact."id"
  LIMIT 1
)
WHERE item."sourceArtifactId" IS NULL;

UPDATE "BookMemoryItem"
SET "memoryKey" = 'legacy:' || "id"
WHERE "memoryKey" IS NULL;
ALTER TABLE "BookMemoryItem" ALTER COLUMN "memoryKey" SET NOT NULL;
ALTER TABLE "BookMemoryItem" ALTER COLUMN "sourceArtifactId" SET NOT NULL;

UPDATE "DocumentChunkEmbedding"
SET "embeddingIdentityHash" = 'legacy:' || "provider" || ':' || "model" || ':' || COALESCE("modelVersion", '') || ':' || "embeddingVersion" || ':' || "dimensions"::text
WHERE "embeddingIdentityHash" IS NULL;
UPDATE "BookMemoryEmbedding"
SET "embeddingIdentityHash" = 'legacy:' || "provider" || ':' || "model" || ':' || COALESCE("modelVersion", '') || ':' || "embeddingVersion" || ':' || "dimensions"::text
WHERE "embeddingIdentityHash" IS NULL;

ALTER TABLE "DocumentChunkEmbedding" ALTER COLUMN "embeddingIdentityHash" SET NOT NULL;
ALTER TABLE "BookMemoryEmbedding" ALTER COLUMN "embeddingIdentityHash" SET NOT NULL;
ALTER TABLE "DocumentChunkEmbedding" DROP CONSTRAINT "DocumentChunkEmbedding_chunkId_embeddingVersion_key";
ALTER TABLE "BookMemoryEmbedding" DROP CONSTRAINT "BookMemoryEmbedding_memoryItemId_embeddingVersion_key";
