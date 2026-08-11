-- Additive repair: version all derived structure and give durable work explicit ownership.
ALTER TABLE "DocumentStructureNode" ADD COLUMN "structureVersion" TEXT NOT NULL DEFAULT 'structure-aware-v1';
ALTER TABLE "DocumentStructureNode" ADD CONSTRAINT "DocumentStructureNode_id_extractionId_structureVersion_key" UNIQUE ("id", "extractionId", "structureVersion");
ALTER TABLE "DocumentStructureNode" ADD CONSTRAINT "DocumentStructureNode_extractionId_structureVersion_ordinal_key" UNIQUE ("extractionId", "structureVersion", "ordinal");
ALTER TABLE "DocumentStructureNode" DROP CONSTRAINT "DocumentStructureNode_parent_lineage_fkey";
ALTER TABLE "DocumentStructureNode" ADD CONSTRAINT "DocumentStructureNode_parent_version_lineage_fkey" FOREIGN KEY ("parentId", "extractionId", "structureVersion") REFERENCES "DocumentStructureNode"("id", "extractionId", "structureVersion") ON DELETE CASCADE;
ALTER TABLE "DocumentChunk" ADD COLUMN "structureVersion" TEXT NOT NULL DEFAULT 'structure-aware-v1';
ALTER TABLE "DocumentChunk" DROP CONSTRAINT "DocumentChunk_structure_lineage_fkey";
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_structure_version_lineage_fkey" FOREIGN KEY ("structureNodeId", "extractionId", "structureVersion") REFERENCES "DocumentStructureNode"("id", "extractionId", "structureVersion") ON DELETE RESTRICT;

ALTER TABLE "ChunkSet" ADD COLUMN "materializationClaimToken" TEXT, ADD COLUMN "materializationClaimedAt" TIMESTAMP(3), ADD COLUMN "materializationLeaseUntil" TIMESTAMP(3);
ALTER TABLE "BookAnalysisRun" ADD COLUMN "analysisIdentityHash" TEXT, ADD COLUMN "executionClaimToken" TEXT, ADD COLUMN "executionClaimedAt" TIMESTAMP(3), ADD COLUMN "executionLeaseUntil" TIMESTAMP(3);
UPDATE "BookAnalysisRun" SET "analysisIdentityHash" = md5(concat_ws('|', "chunkSetId", "pipelineVersion", "promptVersion", "provider", "model", COALESCE("modelVersion", ''))) WHERE "analysisIdentityHash" IS NULL;
ALTER TABLE "BookAnalysisRun" ALTER COLUMN "analysisIdentityHash" SET NOT NULL;
ALTER TABLE "BookAnalysisRun" ADD CONSTRAINT "BookAnalysisRun_analysisIdentityHash_key" UNIQUE ("analysisIdentityHash");
ALTER TABLE "BookAnalysisRun" DROP CONSTRAINT "BookAnalysisRun_chunkSetId_pipelineVersion_promptVersion_pr_key";
