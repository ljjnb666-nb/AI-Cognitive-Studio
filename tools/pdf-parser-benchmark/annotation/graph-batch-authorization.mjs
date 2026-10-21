/**
 * 03E-04B-01: consent REQUEST drafts, NOT approvals.
 * No network execution or promotion function exists in this module.
 * Verified prices and a separately approved authorization are prerequisites
 * to any future dispatch implementation; a user-controlled JSON object alone
 * must never be accepted as grant of spend authority.
 */
import {createHash} from "node:crypto";
export class BatchAuthorizationError extends Error{
  constructor(code){super(code);this.code=code;this.name="BatchAuthorizationError";}
}
const block=code=>{throw new BatchAuthorizationError(code);};
const hex=/^[0-9a-f]{64}$/u;
const idPattern=/^RB-PDF-(?:12|13):page-[0-9]{3}-region-[0-9]{2}$/u;
const amount=v=>Number.isSafeInteger(v)&&v>0&&v<=10_000_000_00;
const digest=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function verifyOfflineBatchPlan(plan){
  if(!plan||typeof plan!=="object"||Array.isArray(plan)||
     plan.schemaVersion!=="acs-offline-graph-batch-plan-v1"||
     plan.sourceRun!=="real-mineru-39440805765-1"||
     plan.model!=="glm-5.3-flash"||
     plan.authority!=="PREVIEW_ONLY_NO_PROVIDER_DISPATCH"||
     plan.dispatchEnabled!==false||plan.providerRequestsIssued!==0||
     plan.needsExplicitPaidAuthorization!==true||plan.priceEstimate!==null||
     !hex.test(plan.planSha256??"")||
     !Number.isSafeInteger(plan.maxRequests)||plan.maxRequests<1||plan.maxRequests>14||
     !Number.isSafeInteger(plan.maxTotalBytes)||plan.maxTotalBytes<1||plan.maxTotalBytes>48_000_000||
     !Array.isArray(plan.planned)||plan.planned.length>14||
     !Array.isArray(plan.excluded)||plan.excluded.length>32||
     !Number.isSafeInteger(plan.totalCropBytes)||plan.totalCropBytes<0||
     !plan.counts||plan.counts.eligible!==plan.planned.length||
     plan.counts.discovered!==plan.planned.length+plan.excluded.length)
    block("BATCH_AUTH_PLAN_INVALID");
  const used=new Set(),cropHashes=new Set();
  let bytes=0;
  for(const item of plan.planned){
    if(!item||!idPattern.test(item.id??"")||
       item.id!==item.fixtureId+":"+item.regionId||used.has(item.id)||
       !Number.isSafeInteger(item.sourcePhysicalPage1Based)||
       item.sourcePhysicalPage1Based<1||item.sourcePhysicalPage1Based>5000||
       !hex.test(item.cropSha256??"")||cropHashes.has(item.cropSha256)||
       !Number.isSafeInteger(item.cropBytes)||item.cropBytes<33||item.cropBytes>7_000_000||
       !Number.isSafeInteger(item.requestUpperBoundBytes)||
       item.requestUpperBoundBytes!==4*Math.ceil(item.cropBytes/3)+100_000||
       item.requestUpperBoundBytes>12_000_000)
      block("BATCH_AUTH_REGION_INVALID");
    used.add(item.id);cropHashes.add(item.cropSha256);bytes+=item.cropBytes;
  }
  for(const e of plan.excluded){
    if(!e||!idPattern.test(e.id??"")||used.has(e.id)||
       !["ALREADY_HAS_GRAPH","SOURCE_BLOCKED","CROP_PROOF_NOT_READY",
         "PRIOR_ATTEMPT_OR_OUTPUT_PRESENT","DUPLICATE_IMAGE_SHA",
         "EXCEEDS_PER_REQUEST_LIMIT","EXCEEDS_BATCH_LIMIT"].includes(e.reason))
      block("BATCH_AUTH_EXCLUSION_INVALID");
    used.add(e.id);
  }
  if(bytes!==plan.totalCropBytes||bytes>plan.maxTotalBytes||
     plan.planned.length>plan.maxRequests)block("BATCH_AUTH_TOTAL_MISMATCH");
  const content={
    schemaVersion:plan.schemaVersion,sourceRun:plan.sourceRun,
    model:plan.model,authority:plan.authority,
    maxRequests:plan.maxRequests,maxTotalBytes:plan.maxTotalBytes,
    totalCropBytes:plan.totalCropBytes,planned:plan.planned,excluded:plan.excluded
  };
  if(digest(content)!==plan.planSha256)block("BATCH_AUTH_PLAN_SHA_MISMATCH");
  return plan;
}
export function draftBatchAuthorization(plan,{
  selectedIds,maxCalls,maxSpendMinorUnits,currency,expiresAt
}={}){
  verifyOfflineBatchPlan(plan);
  if(!Array.isArray(selectedIds)||selectedIds.length<1||
     selectedIds.length>plan.maxRequests||
     !Number.isSafeInteger(maxCalls)||maxCalls<1||
     maxCalls>plan.maxRequests||maxCalls<selectedIds.length||
     !amount(maxSpendMinorUnits)||!["CNY","USD"].includes(currency)||
     typeof expiresAt!=="string"||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(expiresAt)||
     !Number.isFinite(Date.parse(expiresAt))||
     new Date(expiresAt).toISOString()!==expiresAt)
    block("BATCH_AUTH_REQUEST_INVALID");
  const allowed=new Map(plan.planned.map(r=>[r.id,r]));
  const ids=new Set();
  const selected=selectedIds.map(id=>{
    if(typeof id!=="string"||ids.has(id)||!allowed.has(id))
      block("BATCH_AUTH_SELECTION_INVALID");
    ids.add(id);
    const i=allowed.get(id);
    return {id:i.id,cropSha256:i.cropSha256,
      sourcePhysicalPage1Based:i.sourcePhysicalPage1Based,
      requestUpperBoundBytes:i.requestUpperBoundBytes};
  });
  const request={
    schemaVersion:"acs-cloud-batch-authorization-request-v1",
    status:"DRAFT_NOT_AUTHORIZED",
    planSha256:plan.planSha256,
    model:plan.model,currency,maxCalls,maxSpendMinorUnits,expiresAt,
    items:selected,pricingVerification:"NOT_VERIFIED",
    providerRequestsIssued:0,dispatchEnabled:false,
    needsExplicitHumanConsent:true,approvalReceipt:null
  };
  return Object.freeze({...request,requestSha256:digest(request)});
}
export function verifyBatchAuthorizationDraft(plan,draft){
  verifyOfflineBatchPlan(plan);
  if(!draft||typeof draft!=="object"||Array.isArray(draft)||
     !hex.test(draft.requestSha256??"")||
     draft.planSha256!==plan.planSha256||
     draft.status!=="DRAFT_NOT_AUTHORIZED"||
     draft.pricingVerification!=="NOT_VERIFIED"||
     draft.providerRequestsIssued!==0||draft.dispatchEnabled!==false||
     draft.needsExplicitHumanConsent!==true||draft.approvalReceipt!==null||
     !Array.isArray(draft.items))
    block("BATCH_AUTH_NOT_A_SPEND_APPROVAL");
  const rebuilt=draftBatchAuthorization(plan,{
    selectedIds:draft.items.map(x=>x?.id),maxCalls:draft.maxCalls,
    maxSpendMinorUnits:draft.maxSpendMinorUnits,
    currency:draft.currency,expiresAt:draft.expiresAt
  });
  if(rebuilt.requestSha256!==draft.requestSha256||
     JSON.stringify(rebuilt)!==JSON.stringify(draft))
    block("BATCH_AUTH_TAMPERED");
  return rebuilt;
}
export function guardBatchDispatch(_plan,_draft){
  // This slice does not implement verification of live model tariff, signed
  // approval and durable billable reservation. It has NO dispatch capability.
  block("BATCH_DISPATCH_REQUIRES_VERIFIED_PRICE_AND_EXPLICIT_APPROVAL");
}
