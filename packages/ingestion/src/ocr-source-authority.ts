import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@ai-cognitive/db";
import { parseRoutingPlan } from "./pdf-routing.js";

export type OcrSourceKey = {
  workspaceId: string; sourceDocumentId: string; ingestionRunId: string;
  physicalPageIndex: number; routingGeneration: number; runExecutionToken: string;
  pageClaimToken: string; sourceSha256: string; sourceSizeBytes: number;
};
export type OcrSourceAuthority = OcrSourceKey & { sourceBlobId: string; storageKey: string; planSha256: string };
export const OCR_SOURCE_AUTHORITY_INVALID = "SOURCE_OCR_SOURCE_AUTHORITY_INVALID";

/** Short authority transaction. Never hold row locks over OCR or object IO.
 * Lock order: run -> Job -> document -> blob -> page. Re-read predicates after
 * acquiring locks and use wall-clock time: a lock wait must not extend a lease.
 * The same function runs inside the final checkpoint transaction, keeping all
 * authority rows locked until the result commit. */
export async function lockOcrSourceAuthority(tx: Prisma.TransactionClient, key: OcrSourceKey, expected?: OcrSourceAuthority, checkpoint = false): Promise<OcrSourceAuthority | null> {
  if (!key.pageClaimToken || !/^[a-f0-9]{64}$/.test(key.sourceSha256)) return null;
  const runs = await tx.$queryRaw<Array<{jobId: string}>>`SELECT "jobId" FROM "IngestionRun" WHERE "id"=${key.ingestionRunId} AND "workspaceId"=${key.workspaceId} AND "sourceDocumentId"=${key.sourceDocumentId} FOR UPDATE`;
  if (runs.length !== 1) return null;
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${runs[0]!.jobId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "SourceDocument" WHERE "id"=${key.sourceDocumentId} AND "workspaceId"=${key.workspaceId} FOR SHARE`;
  await tx.$queryRaw`SELECT b."id" FROM "SourceBlob" b JOIN "SourceDocument" d ON d."sourceBlobId"=b."id" AND d."workspaceId"=b."workspaceId" WHERE d."id"=${key.sourceDocumentId} AND d."workspaceId"=${key.workspaceId} FOR SHARE OF b`;
  await tx.$queryRaw`SELECT "id" FROM "OcrPageAttempt" WHERE "ingestionRunId"=${key.ingestionRunId} AND "physicalPageIndex"=${key.physicalPageIndex} AND "routingGeneration"=${key.routingGeneration} FOR UPDATE`;
  const rows = await tx.$queryRaw<Array<{sourceBlobId:string; storageKey:string; routingPlan:unknown}>>`
    SELECT d."sourceBlobId", b."storageKey", r."routingPlan" FROM "IngestionRun" r
    JOIN "Job" j ON j."id"=r."jobId" AND j."workspaceId"=r."workspaceId"
    JOIN "SourceDocument" d ON d."id"=r."sourceDocumentId" AND d."workspaceId"=r."workspaceId"
    JOIN "SourceBlob" b ON b."id"=d."sourceBlobId" AND b."workspaceId"=d."workspaceId"
    JOIN "OcrPageAttempt" p ON p."ingestionRunId"=r."id" AND p."sourceDocumentId"=d."id" AND p."workspaceId"=r."workspaceId"
    WHERE r."id"=${key.ingestionRunId} AND r."workspaceId"=${key.workspaceId} AND d."id"=${key.sourceDocumentId}
      AND r."status"='RUNNING' AND j."status"='RUNNING'
      AND r."executionClaimToken"=${key.runExecutionToken} AND r."executionLeaseUntil">clock_timestamp()
      AND r."routingGeneration"=${key.routingGeneration}
      AND p."physicalPageIndex"=${key.physicalPageIndex} AND p."routingGeneration"=${key.routingGeneration}
      AND p."claimToken"=${key.pageClaimToken}
      AND ((p."status"='RUNNING' AND p."leaseUntil">clock_timestamp()) OR (${checkpoint} AND p."status"='SUCCEEDED'))
      AND b."sha256"=${key.sourceSha256} AND d."sha256"=b."sha256"
      AND b."sizeBytes"=${BigInt(key.sourceSizeBytes)} AND d."sizeBytes"=b."sizeBytes"
      AND b."mediaType"='application/pdf' AND d."mediaType"=b."mediaType" AND d."storageKey"=b."storageKey"`;
  if (rows.length !== 1) return null;
  const row=rows[0]!;
  let plan;
  try { plan=parseRoutingPlan(row.routingPlan); } catch { return null; }
  if (!plan.pages.some(p => p.physicalPageIndex===key.physicalPageIndex && p.route==="OCR_REQUIRED")) return null;
  const authority={...key,sourceBlobId:row.sourceBlobId,storageKey:row.storageKey,planSha256:createHash("sha256").update(JSON.stringify(row.routingPlan)).digest("hex")};
  if (expected && (authority.sourceSha256!==expected.sourceSha256 || authority.sourceSizeBytes!==expected.sourceSizeBytes || authority.sourceDocumentId!==expected.sourceDocumentId || authority.sourceBlobId!==expected.sourceBlobId || authority.storageKey!==expected.storageKey || authority.planSha256!==expected.planSha256)) return null;
  return authority;
}
export async function verifyOcrSourceAuthority(key: OcrSourceKey, expected?: OcrSourceAuthority): Promise<OcrSourceAuthority | null> {
  return prisma.$transaction(tx => lockOcrSourceAuthority(tx,key,expected));
}

/** Page lease renewal is subordinate to live run/source/plan ownership. */
export async function renewOcrSourcePageLease(authority: OcrSourceAuthority): Promise<boolean> {
  return prisma.$transaction(async tx => {
    if (!await lockOcrSourceAuthority(tx,authority,authority)) return false;
    return (await tx.$executeRaw`UPDATE "OcrPageAttempt" SET "leaseUntil"=clock_timestamp()+INTERVAL '180 seconds' WHERE "claimToken"=${authority.pageClaimToken} AND "ingestionRunId"=${authority.ingestionRunId} AND "physicalPageIndex"=${authority.physicalPageIndex} AND "routingGeneration"=${authority.routingGeneration}`)===1;
  });
}

/** Completed checkpoints need fresh run/source authority, not a revived old page lease. */
export async function verifyOcrCheckpointSource(key: OcrSourceKey, expected: OcrSourceAuthority): Promise<boolean> {
  return prisma.$transaction(async tx => (await lockOcrSourceAuthority(tx,key,expected,true))!==null);
}

/** Keep source locks through canonical/current publication as well as the
 * checkpoint write. A source change between those two commits must not turn
 * an old OCR artifact into the new source's canonical content. */
export async function lockOcrPublicationSources(tx: Prisma.TransactionClient, input: {
  workspaceId:string;sourceDocumentId:string;ingestionRunId:string;runExecutionToken:string;
  routingGeneration:number;sourceSha256:string;sourceSizeBytes:number;
}):Promise<boolean> {
 const pages=await tx.ocrPageAttempt.findMany({where:{ingestionRunId:input.ingestionRunId,workspaceId:input.workspaceId,routingGeneration:input.routingGeneration},orderBy:{physicalPageIndex:"asc"}});
 for(const page of pages) {
  if(!page.sourceIdentity) continue; // Historical checkpoints have no new receipt contract.
  if(page.status!=="SUCCEEDED" || page.qualityStatus!=="ACCEPTED") return false;
  const expected=page.sourceIdentity as {sourceBlobId:string;sourceDocumentId:string;sourceSha256:string;sourceSizeBytes:number;storageKey:string;planSha256:string};
  const key={...input,physicalPageIndex:page.physicalPageIndex,pageClaimToken:page.claimToken??""};
  if(!await lockOcrSourceAuthority(tx,key,{...key,...expected},true)) return false;
  const receipt=await tx.ocrPageExecution.findUnique({where:{pageClaimToken:key.pageClaimToken}});
  if(!receipt || receipt.executionStatus!=="SUCCEEDED" || receipt.resultTextSha256!==page.textSha256 || (receipt.qualityDecision as {status?:string}|null)?.status!=="ACCEPTED") return false;
 }
 return true;
}
