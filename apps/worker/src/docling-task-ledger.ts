import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";

export const DOCLING_TASK_MAX_ATTEMPTS = 2;
export const DOCLING_TASK_LEASE_SECONDS = 300;

export type DoclingTaskIdentity = {
  ingestionRunId: string;
  physicalPageIndex: number;
  routingGeneration: number;
  modelSha256: string;
};
export type DoclingTaskLineage = DoclingTaskIdentity & {
  workspaceId: string;
  sourceDocumentId: string;
};
export type DoclingTaskClaim = { id: string; token: string; attempt: number };

/** Unique composite key prevents Redis loss from creating new budgets. */
export async function ensureDoclingTask(lineage:DoclingTaskLineage) {
  return prisma.doclingLayoutTask.upsert({
    where:{byPageAndModel:{
      ingestionRunId:lineage.ingestionRunId,
      physicalPageIndex:lineage.physicalPageIndex,
      routingGeneration:lineage.routingGeneration,
      modelSha256:lineage.modelSha256,
    }},
    create:{
      ingestionRunId:lineage.ingestionRunId,
      sourceDocumentId:lineage.sourceDocumentId,
      workspaceId:lineage.workspaceId,
      physicalPageIndex:lineage.physicalPageIndex,
      routingGeneration:lineage.routingGeneration,
      modelSha256:lineage.modelSha256,
    },
    update:{},
  });
}

/** A single database-clock CAS grants execution ownership and consumes budget. */
export async function claimDoclingTask(id:string):Promise<DoclingTaskClaim|null> {
  const token=randomUUID();
  const claimed=await prisma.$queryRaw<Array<{id:string;attemptCount:number}>>`
    UPDATE "DoclingLayoutTask"
    SET "status" = 'RUNNING'::"DoclingLayoutTaskStatus",
        "claimToken" = ${token},
        "leaseUntil" = NOW() + INTERVAL '300 seconds',
        "attemptCount" = "attemptCount" + 1,
        "updatedAt" = NOW()
    WHERE "id" = ${id}
      AND "attemptCount" < ${DOCLING_TASK_MAX_ATTEMPTS}
      AND (
        "status" = 'PENDING'::"DoclingLayoutTaskStatus"
        OR ("status" = 'RUNNING'::"DoclingLayoutTaskStatus"
            AND "leaseUntil" <= NOW())
      )
    RETURNING "id", "attemptCount"
  `;
  return claimed.length===1?{id,token,attempt:claimed[0]!.attemptCount}:null;
}

/** Stale owners cannot settle a new owner's execution. */
export async function finishDoclingTask(
  claim:DoclingTaskClaim,success:boolean,
):Promise<boolean> {
  const desired=success?"SUCCEEDED":
    claim.attempt>=DOCLING_TASK_MAX_ATTEMPTS?"FAILED":"PENDING";
  const rows=await prisma.$queryRaw<Array<{id:string}>>`
    UPDATE "DoclingLayoutTask"
    SET "status" = ${desired}::"DoclingLayoutTaskStatus",
        "claimToken" = NULL, "leaseUntil" = NULL,
        "updatedAt" = NOW()
    WHERE "id" = ${claim.id}
      AND "claimToken" = ${claim.token}
      AND "status" = 'RUNNING'::"DoclingLayoutTaskStatus"
      AND "leaseUntil" > NOW()
    RETURNING "id"
  `;
  return rows.length===1;
}

/** Expired attempt number two is terminal even if Redis forgets the failure. */
export async function permanentlyFailExhaustedDoclingTask(id:string):Promise<boolean> {
  const rows=await prisma.$queryRaw<Array<{id:string}>>`
    UPDATE "DoclingLayoutTask"
    SET "status" = 'FAILED'::"DoclingLayoutTaskStatus",
        "claimToken" = NULL, "leaseUntil" = NULL,
        "updatedAt" = NOW()
    WHERE "id" = ${id}
      AND "attemptCount" >= ${DOCLING_TASK_MAX_ATTEMPTS}
      AND ("status" = 'PENDING'::"DoclingLayoutTaskStatus"
        OR ("status" = 'RUNNING'::"DoclingLayoutTaskStatus"
          AND "leaseUntil" <= NOW()))
    RETURNING "id"
  `;
  return rows.length===1;
}

/** Promote legacy immutable snapshot without changing the original extraction. */
export async function markLegacyDoclingSnapshotSettled(id:string):Promise<void> {
  await prisma.doclingLayoutTask.updateMany({
    where:{id,status:"PENDING"},
    data:{status:"SUCCEEDED",claimToken:null,leaseUntil:null},
  });
}
