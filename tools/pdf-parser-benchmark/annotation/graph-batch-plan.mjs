/**
 * 03E-04A: deterministic READ-ONLY offline planning for existing private crops.
 * Never calls a provider, grants consent, reserves spend or publishes content.
 * The plan is a digest of exact crop source SHA, one-request-per-crop ceilings,
 * and explicit exclusions. All private images stay on the local Windows host.
 */
import {createHash} from "node:crypto";
import {lstat,realpath} from "node:fs/promises";
import {resolve,join} from "node:path";
import {listPrivateGraphReviewQueue,readPrivateGraphCropPreview} from "./private-graph-local.mjs";

const MAX_REQUESTS=14;
const MAX_BATCH_BYTES=48_000_000;
const MAX_IMAGE_BYTES=7_000_000; // b64 payload must remain under adapter's 12 MB request cap
const MAX_REQUEST_BYTES=12_000_000;
const REQUEST_OVERHEAD_BYTES=100_000; // conservative allowance for prompt + JSON
const HASH=/^[0-9a-f]{64}$/u;
const ITEM=/^RB-PDF-(?:12|13):page-[0-9]{3}-region-[0-9]{2}$/u;
const sha=v=>createHash("sha256").update(v).digest("hex");
export class BatchPlanError extends Error {
  constructor(code){super(code);this.name="BatchPlanError";this.code=code;}
}
const block=code=>{throw new BatchPlanError(code);};
function positiveInt(x,min,max){
  return Number.isSafeInteger(x)&&x>=min&&x<=max;
}
export function compileGraphBatchPlan(queue,evidence,{
  maxRequests=MAX_REQUESTS,maxTotalBytes=MAX_BATCH_BYTES
}={}){
  if(!positiveInt(maxRequests,1,MAX_REQUESTS)||
     !positiveInt(maxTotalBytes,1,MAX_BATCH_BYTES))
    block("BATCH_LIMIT_INVALID");
  if(!queue||queue.schemaVersion!=="acs-private-graph-review-queue-v1"||
     queue.authority!=="DISCOVERY_ONLY_NOT_GROUND_TRUTH"||
     !Array.isArray(queue.items)||queue.items.length>32||
     !queue.counts||queue.counts.total!==queue.items.length||
     !Array.isArray(evidence)||evidence.length!==queue.items.length)
    block("BATCH_DISCOVERY_INVALID");
  const ids=new Set(),seen=new Set(),planned=[],excluded=[];
  let totalBytes=0;
  for(let i=0;i<queue.items.length;i++){
    const item=queue.items[i],proof=evidence[i];
    if(!item||!ITEM.test(item.id??"")||ids.has(item.id)||
       item.id!==item.fixtureId+":"+item.regionId||
       !positiveInt(item.sourcePhysicalPage1Based,1,5000)||
       typeof item.reviewable!=="boolean"||
       item.graphVerified!==false||item.humanVerified!==false||
       !["CROP_READY_NO_GRAPH","GRAPH_READY_FOR_HUMAN_REVIEW",
         "CROP_MISSING_OR_BLOCKED","GRAPH_EVIDENCE_BLOCKED"].includes(item.evidenceStatus))
      block("BATCH_ITEM_INVALID");
    ids.add(item.id);
    const hasProof=proof!==null;
    let duplicate=false;
    if(proof!==null){
      if(!proof||proof.id!==item.id||proof.sourcePhysicalPage1Based!==item.sourcePhysicalPage1Based||
         proof.authority!=="CROP_ONLY_UNVERIFIED"||
         proof.graphVerified!==false||proof.humanVerified!==false||
         !HASH.test(proof.cropSha256??"")||
         typeof proof.priorAttemptBlocked!=="boolean"||
         !positiveInt(proof.byteLength,33,MAX_IMAGE_BYTES*2)||
         !positiveInt(proof.width,20,12000)||
         !positiveInt(proof.height,20,12000)||
         proof.width*proof.height>18_000_000)
        block("BATCH_CROP_PROOF_INVALID");
      // Two different regions may contain byte-identical crops. Do not bill
      // twice or fail the entire book when only one row is duplicated.
      duplicate=seen.has(proof.cropSha256);
      seen.add(proof.cropSha256);
    }
    const identity={id:item.id,fixtureId:item.fixtureId,
      sourcePhysicalPage1Based:item.sourcePhysicalPage1Based,
      regionId:item.regionId};
    if(item.evidenceStatus!=="CROP_READY_NO_GRAPH"||item.reviewable){
      excluded.push({...identity,reason:item.reviewable?
        "ALREADY_HAS_GRAPH":"SOURCE_BLOCKED"});
      continue;
    }
    if(!hasProof){excluded.push({...identity,reason:"CROP_PROOF_NOT_READY"});continue;}
    if(proof.priorAttemptBlocked){excluded.push({...identity,reason:"PRIOR_ATTEMPT_OR_OUTPUT_PRESENT"});continue;}
    if(duplicate){excluded.push({...identity,reason:"DUPLICATE_IMAGE_SHA"});continue;}
    const requestCeiling=4*Math.ceil(proof.byteLength/3)+REQUEST_OVERHEAD_BYTES;
    if(proof.byteLength>MAX_IMAGE_BYTES||requestCeiling>MAX_REQUEST_BYTES){
      excluded.push({...identity,reason:"EXCEEDS_PER_REQUEST_LIMIT"});continue;
    }
    if(planned.length>=maxRequests||totalBytes+proof.byteLength>maxTotalBytes){
      excluded.push({...identity,reason:"EXCEEDS_BATCH_LIMIT"});continue;
    }
    planned.push({...identity,cropSha256:proof.cropSha256,
      cropBytes:proof.byteLength,requestUpperBoundBytes:requestCeiling});
    totalBytes+=proof.byteLength;
  }
  const covered=planned.length+excluded.length;
  if(covered!==queue.items.length)block("BATCH_COVERAGE_INCOMPLETE");
  const content={
    schemaVersion:"acs-offline-graph-batch-plan-v1",
    sourceRun:"real-mineru-39440805765-1",
    model:"glm-5.3-flash",
    authority:"PREVIEW_ONLY_NO_PROVIDER_DISPATCH",
    maxRequests,maxTotalBytes,totalCropBytes:totalBytes,
    planned,excluded
  };
  const planSha256=sha(Buffer.from(JSON.stringify(content),"utf8"));
  return {
    ...content,planSha256,needsExplicitPaidAuthorization:true,
    providerRequestsIssued:0,dispatchEnabled:false,
    priceEstimate:null,
    counts:{discovered:covered,eligible:planned.length,
      excluded:excluded.length,alreadyHasGraph:excluded.filter(e=>e.reason==="ALREADY_HAS_GRAPH").length,
      blocked:excluded.filter(e=>e.reason==="SOURCE_BLOCKED"||
        e.reason==="CROP_PROOF_NOT_READY"||e.reason==="EXCEEDS_PER_REQUEST_LIMIT"||
        e.reason==="PRIOR_ATTEMPT_OR_OUTPUT_PRESENT"||e.reason==="DUPLICATE_IMAGE_SHA").length,
      limitExcluded:excluded.filter(e=>e.reason==="EXCEEDS_BATCH_LIMIT").length}
  };
}
/**
 * Read ONLY exact output/receipt/stage paths that the existing cloud adapter
 * itself uses. An attempted network request can be billable even if its output
 * never arrived. Never retry, move, remove, or overwrite such evidence.
 * Batch-namespace markers block all regions in that fixture conservatively.
 */
async function priorAttemptPresent(root,fixture,regionId){
  const base=resolve(root);
  const suffixes=[
    "glm-cloud-v1-"+fixture+"-"+regionId,
    "glm-cloud-v1-"+fixture+"-batch"
  ];
  let rootReal;
  try{rootReal=resolve(await realpath(base));}
  catch{return true;}
  if(rootReal.toLowerCase()!==base.toLowerCase())return true;
  for(const item of suffixes){
    for(const name of [
      item,"."+item+".cloud-attempted","."+item+"-stage"
    ]){
      const pathname=join(base,name);
      try{
        const stat=await lstat(pathname);
        // Any unexpected path type also blocks dispatch; do not follow links.
        if(stat)return true;
      }catch(e){
        if(e?.code!=="ENOENT")return true;
      }
    }
  }
  return false;
}
export async function buildPrivateGraphBatchPlan(root,limits,registrations){
  const queue=await listPrivateGraphReviewQueue(root,registrations);
  const proofs=[];
  // No bulk image payload in the response. Read one trusted crop and discard it.
  for(const item of queue.items){
    if(item.evidenceStatus!=="CROP_READY_NO_GRAPH"||item.reviewable){
      proofs.push(null);continue;
    }
    try{
      const image=await readPrivateGraphCropPreview(root,item.id);
      const bytes=Buffer.from(image.pngBase64,"base64");
      if(sha(bytes)!==image.cropSha256)block("BATCH_IMAGE_SHA_INVALID");
      const priorAttemptBlocked=await priorAttemptPresent(root,item.fixtureId,item.regionId);
      proofs.push({id:item.id,sourcePhysicalPage1Based:item.sourcePhysicalPage1Based,
        authority:image.authority,graphVerified:image.graphVerified,
        humanVerified:image.humanVerified,cropSha256:image.cropSha256,
        width:image.width,height:image.height,byteLength:bytes.length,
        priorAttemptBlocked});
    }catch(e){
      if(e instanceof BatchPlanError)throw e;
      proofs.push(null);
    }
  }
  return compileGraphBatchPlan(queue,proofs,limits);
}
export function publicGraphBatchSummary(plan){
  if(!plan||plan.schemaVersion!=="acs-offline-graph-batch-plan-v1"||
     plan.dispatchEnabled!==false||plan.providerRequestsIssued!==0||
     !HASH.test(plan.planSha256??""))block("BATCH_PUBLIC_SUMMARY_INVALID");
  // No raw crop bytes, human notes, private file paths, or API keys.
  return {schemaVersion:plan.schemaVersion,authority:plan.authority,
    planSha256:plan.planSha256,model:plan.model,counts:plan.counts,
    maxRequests:plan.maxRequests,maxTotalBytes:plan.maxTotalBytes,
    needsExplicitPaidAuthorization:true,providerRequestsIssued:0,
    dispatchEnabled:false,priceEstimate:null,
    items:plan.planned.map(x=>({id:x.id,fixtureId:x.fixtureId,
      physicalPage:x.sourcePhysicalPage1Based,regionId:x.regionId,
      status:"WAITING_FOR_AUTHORIZATION"})),
    exclusions:plan.excluded.map(x=>({id:x.id,reason:x.reason}))};
}
