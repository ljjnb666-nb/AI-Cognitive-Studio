import {describe,it,expect} from "vitest";
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileGraphBatchPlan} from "../annotation/graph-batch-plan.mjs";
import {draftBatchAuthorization,verifyBatchAuthorizationDraft,
  guardBatchDispatch,BatchAuthorizationError} from "../annotation/graph-batch-authorization.mjs";
import {reserveOfflineReviewItem,inspectOfflineReviewItem,BatchLedgerError}
  from "../annotation/graph-batch-offline-ledger.mjs";
const ids=["RB-PDF-12:page-001-region-01","RB-PDF-13:page-001-region-01"];
const hash=c=>c.repeat(64);
const makePlan=()=>{
  const queue={schemaVersion:"acs-private-graph-review-queue-v1",
    authority:"DISCOVERY_ONLY_NOT_GROUND_TRUTH",
    items:ids.map((id,i)=>({id,fixtureId:id.split(":")[0],regionId:id.split(":")[1],
      sourcePhysicalPage1Based:51+i,reviewable:false,
      evidenceStatus:"CROP_READY_NO_GRAPH",graphVerified:false,humanVerified:false})),
    counts:{total:2}};
  const proofs=ids.map((id,i)=>({id,sourcePhysicalPage1Based:51+i,
    authority:"CROP_ONLY_UNVERIFIED",graphVerified:false,humanVerified:false,
    cropSha256:hash(i?"b":"a"),byteLength:2048,width:120,height:80,
    priorAttemptBlocked:false}));
  return compileGraphBatchPlan(queue,proofs);
};
const opts={
  selectedIds:ids,maxCalls:2,maxSpendMinorUnits:3000,currency:"CNY",
  expiresAt:"2026-10-22T00:00:00.000Z"
};
const rejectCode=(fn,klass,code)=>{
  try{fn();throw new Error("SHOULD_REJECT");}
  catch(e){expect(e).toBeInstanceOf(klass);expect(e.code).toBe(code);}
};
const rejectAsync=async(fn,code)=>{
  try{await fn();throw new Error("SHOULD_REJECT");}
  catch(e){expect(e).toBeInstanceOf(BatchLedgerError);expect(e.code).toBe(code);}
};
const onTemp=async(fn)=>{
  const root=await mkdtemp(join(tmpdir(),"acs-batch-offline-only-"));
  try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}
};
describe("03E-04B-01 nonbillable authorization request and durable OFFLINE only ledger",()=>{
  it("creates SHA-bound, price-unverified request with NO approval or dispatch",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    expect(draft).toMatchObject({schemaVersion:"acs-cloud-batch-authorization-request-v1",
      status:"DRAFT_NOT_AUTHORIZED",pricingVerification:"NOT_VERIFIED",
      dispatchEnabled:false,approvalReceipt:null,providerRequestsIssued:0,
      maxCalls:2,maxSpendMinorUnits:3000,currency:"CNY",planSha256:plan.planSha256});
    expect(draft.items).toHaveLength(2);
    expect(verifyBatchAuthorizationDraft(plan,draft)).toEqual(draft);
    rejectCode(()=>guardBatchDispatch(plan,draft),BatchAuthorizationError,
      "BATCH_DISPATCH_REQUIRES_VERIFIED_PRICE_AND_EXPLICIT_APPROVAL");
  });
  it("forbids changing source SHA, order, spend cap, quote status or manufacturing approval",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    for(const invalid of [
      {...draft,status:"APPROVED"}, {...draft,dispatchEnabled:true},
      {...draft,providerRequestsIssued:1},
      {...draft,pricingVerification:"VERIFIED"},
      {...draft,approvalReceipt:{signed:true}},
      {...draft,maxSpendMinorUnits:50000}, {...draft,requestSha256:hash("f")},
      {...draft,items:[...draft.items].reverse()}
    ])rejectCode(()=>verifyBatchAuthorizationDraft(plan,invalid),
      BatchAuthorizationError,
      invalid.status!=="DRAFT_NOT_AUTHORIZED"||
      invalid.dispatchEnabled!==false||invalid.providerRequestsIssued!==0||
      invalid.pricingVerification!=="NOT_VERIFIED"||invalid.approvalReceipt!==null?
        "BATCH_AUTH_NOT_A_SPEND_APPROVAL":"BATCH_AUTH_TAMPERED");
    rejectCode(()=>verifyBatchAuthorizationDraft({...plan,planSha256:hash("d")},draft),
      BatchAuthorizationError,"BATCH_AUTH_PLAN_SHA_MISMATCH");
  });
  it("rejects arbitrary regions, duplicate IDs, oversized request count and invalid currency",()=>{
    const plan=makePlan();
    for(const input of [
      {...opts,selectedIds:[ids[0],ids[0]]},
      {...opts,selectedIds:["RB-PDF-12:page-002-region-99"]},
      {...opts,maxCalls:1}, {...opts,maxSpendMinorUnits:0},
      {...opts,currency:"DOGE"}, {...opts,expiresAt:"never"}
    ])expect(()=>draftBatchAuthorization(plan,input)).toThrow(BatchAuthorizationError);
    expect(draftBatchAuthorization(plan,{...opts,selectedIds:[ids[1]],maxCalls:1}).items)
      .toHaveLength(1);
  });
  it("persists a reservation without dispatch and denies repeat reservations even across concurrent writers",()=>onTemp(async root=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const results=await Promise.allSettled([
      reserveOfflineReviewItem(root,plan,draft,ids[0],{now:"2026-10-21T00:00:00.000Z"}),
      reserveOfflineReviewItem(root,plan,draft,ids[0],{now:"2026-10-21T00:00:00.000Z"})
    ]);
    expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(x=>x.status==="rejected")).toHaveLength(1);
    expect(results.find(x=>x.status==="rejected").reason.code)
      .toBe("BATCH_LEDGER_ITEM_ALREADY_RESERVED");
    const read=await inspectOfflineReviewItem(root,plan,draft,ids[0]);
    expect(read).toMatchObject({status:"OFFLINE_PREPARED_NOT_DISPATCHED",
      dispatchEnabled:false,providerRequestsIssued:0,id:ids[0]});
    expect((await inspectOfflineReviewItem(root,plan,draft,ids[1])).status)
      .toBe("NOT_PREPARED");
    await reserveOfflineReviewItem(root,plan,draft,ids[1],{now:"2026-10-21T00:00:00.000Z"});
    const saved=await inspectOfflineReviewItem(root,plan,draft,ids[1]);
    expect(saved.status).toBe("OFFLINE_PREPARED_NOT_DISPATCHED");
  }));
  it("refuses expired draft, unselected item, tampered approval or source lineage",()=>onTemp(async root=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    await rejectAsync(()=>reserveOfflineReviewItem(root,plan,draft,ids[0],
      {now:"2026-10-23T00:00:00.000Z"}),"BATCH_LEDGER_DRAFT_EXPIRED_OR_TOO_LONG");
    await rejectAsync(()=>reserveOfflineReviewItem(root,plan,draft,
      "RB-PDF-13:page-003-region-01",{now:"2026-10-21T00:00:00.000Z"}),
      "BATCH_LEDGER_ITEM_NOT_SELECTED");
    await rejectAsync(()=>reserveOfflineReviewItem(root,plan,
      {...draft,status:"APPROVED"},ids[0],{now:"2026-10-21T00:00:00.000Z"}),
      "BATCH_LEDGER_DRAFT_INVALID");
    await rejectAsync(()=>reserveOfflineReviewItem(root,
      {...plan,planSha256:hash("e")},draft,ids[0],{now:"2026-10-21T00:00:00.000Z"}),
      "BATCH_LEDGER_DRAFT_INVALID");
  }));
  it("does not follow a user-controlled symlink or trust a corrupted existing claim",()=>onTemp(async root=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const folder=join(root,"private-cloud-batch-offline-v1");
    const outside=join(root,"outside");await mkdir(outside);
    await symlink(outside,folder);
    await rejectAsync(()=>reserveOfflineReviewItem(root,plan,draft,ids[0],
      {now:"2026-10-21T00:00:00.000Z"}),"BATCH_LEDGER_DIR_UNSAFE");
    await rm(folder);
    const receipt=await reserveOfflineReviewItem(root,plan,draft,ids[0],
      {now:"2026-10-21T00:00:00.000Z"});
    const filename="offline-"+draft.requestSha256+"-"+ids[0].replace(":","-")+".json";
    await writeFile(join(folder,filename),"{ corrupt", {flag:"w"});
    await rejectAsync(()=>inspectOfflineReviewItem(root,plan,draft,ids[0]),
      "BATCH_LEDGER_CORRUPT");
    expect(receipt.dispatchEnabled).toBe(false);
    await rejectAsync(()=>reserveOfflineReviewItem(root,plan,draft,ids[0],
      {now:"2026-10-21T00:00:00.000Z"}),"BATCH_LEDGER_ITEM_ALREADY_RESERVED");
  }));
});
