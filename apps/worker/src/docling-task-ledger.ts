import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";

export const DOCLING_TASK_MAX_ATTEMPTS = 2;
export const DOCLING_TASK_LEASE_SECONDS = 300;
// Global across hosts sharing this PostgreSQL database, not per-process.
// Deliberately one Docling CPU-heavy candidate at a time until real capacity
// measurements allow a larger, operator-controlled setting.
export const DOCLING_GLOBAL_MAX_ACTIVE = 1;
// Reserved transaction-scoped advisory key for Docling admission in this DB.
// All Docling task claims MUST pass through the same serialized admission.
const DOCLING_CAPACITY_LOCK_A = 620031;
const DOCLING_CAPACITY_LOCK_B = 20261025;

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

/**
 * Across all hosts sharing PostgreSQL, at most one unexpired Docling task
 * lease may be admitted. A transaction-scoped advisory lock serializes
 * count+claim; Redis worker concurrency alone cannot enforce this bound.
 *
 * IMPORTANT: check capacity BEFORE consuming the durable attempt count. A
 * full pool returns null with the task still PENDING (zero model attempts).
 * The BullMQ processor must delay that delivery instead of completing it.
 */
export async function claimDoclingTask(id:string):Promise<DoclingTaskClaim|null> {
  const token=randomUUID();
  return prisma.$transaction(async tx=>{
    // Use the transaction's PostgreSQL connection for the entire admission.
    // Do not project the void-returning lock function directly: Prisma cannot
    // deserialize PostgreSQL's void type on some supported client versions.
    await tx.$queryRaw<Array<{locked:number}>>`
      SELECT 1::integer AS "locked"
      FROM pg_advisory_xact_lock(${DOCLING_CAPACITY_LOCK_A}::integer, ${DOCLING_CAPACITY_LOCK_B}::integer)
    `;
    const occupied=await tx.$queryRaw<Array<{active:number}>>`
      SELECT COUNT(*)::integer AS "active"
      FROM "DoclingLayoutTask"
      WHERE "status" = 'RUNNING'::"DoclingLayoutTaskStatus"
        AND "leaseUntil" > NOW()
    `;
    if((occupied[0]?.active??DOCLING_GLOBAL_MAX_ACTIVE)>=DOCLING_GLOBAL_MAX_ACTIVE)
      return null;
    const claimed=await tx.$queryRaw<Array<{id:string;attemptCount:number}>>`
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
  },{maxWait:10_000,timeout:15_000});
}

/**
 * Only the same live owner can extend its lease, using the database clock.
 * A timed-out token is never revived, and no attempt budget is changed.
 */
export async function renewDoclingTaskLease(claim:DoclingTaskClaim):Promise<boolean> {
  const rows=await prisma.$queryRaw<Array<{id:string}>>`
    UPDATE "DoclingLayoutTask"
    SET "leaseUntil" = NOW() + INTERVAL '300 seconds',
        "updatedAt" = NOW()
    WHERE "id" = ${claim.id}
      AND "claimToken" = ${claim.token}
      AND "attemptCount" = ${claim.attempt}
      AND "status" = 'RUNNING'::"DoclingLayoutTaskStatus"
      AND "leaseUntil" > NOW()
    RETURNING "id"
  `;
  return rows.length===1;
}

/**
 * Heartbeat transport errors are treated like a lost lease, not as a reason
 * to blindly retry a model or silently publish an overdue page.
 *
 * Stop + drain is mandatory before the caller settles task status. This
 * keeps an in-flight heartbeat from resurrecting a settled task.
 */
export async function withDoclingClaimHeartbeat<T>(
  claim:DoclingTaskClaim,
  operation:()=>Promise<T>,
  options:{intervalMs?:number;renew?:(claim:DoclingTaskClaim)=>Promise<boolean>}={},
):Promise<T> {
  const intervalMs=options.intervalMs??60_000;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1||intervalMs>120_000)
    throw new Error("DOCLING_LAYOUT_HEARTBEAT_INTERVAL_INVALID");
  const renew=options.renew??renewDoclingTaskLease;
  let stopped=false;
  let lost=false;
  let inFlight:Promise<void>=Promise.resolve();
  const heartbeat=()=>{
    if(stopped||lost)return;
    // Serial renewals only: callbacks cannot overlap and extend a lease
    // after the worker already settled or exited.
    inFlight=inFlight.then(async()=>{
      if(stopped||lost)return;
      try{
        if(!(await renew(claim)))lost=true;
      }catch{lost=true;}
    });
  };
  // Keep a live scheduling handle until the owned task is fully settled.
  // A hanging I/O promise must never silently stop all lease renewals.
  const timer=setInterval(heartbeat,intervalMs);
  let value!:T;
  let operationError:unknown;
  let failed=false;
  try{
    value=await operation();
  }catch(error){
    failed=true;
    operationError=error;
  }finally{
    stopped=true;
    clearInterval(timer);
    await inFlight;
  }
  if(failed)throw operationError;
  // Check only AFTER an in-flight database renewal has drained.
  // A rejected renewal must never allow a completed model output through.
  if(lost)throw new Error("DOCLING_LAYOUT_HEARTBEAT_LOST");
  return value;
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
  await prisma.$queryRaw<Array<{id:string}>>`
    UPDATE "DoclingLayoutTask"
    SET "status" = 'SUCCEEDED'::"DoclingLayoutTaskStatus",
        "claimToken" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW()
    WHERE "id" = ${id}
      AND ("status" = 'PENDING'::"DoclingLayoutTaskStatus" OR
           ("status" = 'RUNNING'::"DoclingLayoutTaskStatus"
            AND "leaseUntil" <= NOW()))
    RETURNING "id"
  `;
}
