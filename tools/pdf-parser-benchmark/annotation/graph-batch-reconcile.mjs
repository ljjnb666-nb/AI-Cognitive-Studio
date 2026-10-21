/**
 * 03E-04B-02A: fixed-path, read-only reconciliation of old provider evidence.
 * Any marker is an indeterminate potentially billable attempt; NEVER retry.
 * No file content, paths, or private labels are exposed to HTTP or CI.
 */
import {lstat,realpath} from "node:fs/promises";
import {resolve,join} from "node:path";
import {verifyOfflineBatchPlan,BatchAuthorizationError} from "./graph-batch-authorization.mjs";
const ITEM=/^(RB-PDF-(?:12|13)):(page-[0-9]{3}-region-[0-9]{2})$/u;
export class ReconcileError extends Error{
  constructor(code){super(code);this.name="ReconcileError";this.code=code;}
}
const block=code=>{throw new ReconcileError(code);};
async function existing(path) {
  try{
    const st=await lstat(path);
    if(st.isSymbolicLink())block("RECONCILE_SYMLINK_UNSAFE");
    if(!st.isFile()&&!st.isDirectory())block("RECONCILE_NODE_UNSAFE");
    return true;
  }catch(e){
    if(e?.code==="ENOENT")return false;
    if(e instanceof ReconcileError)throw e;
    block("RECONCILE_SOURCE_IO_UNCERTAIN");
  }
}
async function safeRoot(root) {
  if(typeof root!=="string"||!root||root.length>1024)block("RECONCILE_ROOT_INVALID");
  const base=resolve(root);
  try{
    const resolved=resolve(await realpath(base));
    if(resolved.toLowerCase()!==base.toLowerCase())block("RECONCILE_ROOT_UNSAFE");
    const st=await lstat(base);
    if(!st.isDirectory()||st.isSymbolicLink())block("RECONCILE_ROOT_UNSAFE");
    return base;
  }catch(e){
    if(e instanceof ReconcileError)throw e;
    block("RECONCILE_ROOT_UNAVAILABLE");
  }
}
/** One crop only. We never walk directories or inspect receipts' contents. */
export async function reconcileCloudEvidence(root,id){
  const m=typeof id==="string"?ITEM.exec(id):null;
  if(!m)block("RECONCILE_ITEM_INVALID");
  const base=await safeRoot(root);
  const [,fixture,region]=m;
  const prefix="glm-cloud-v1-"+fixture+"-"+region;
  const batch="glm-cloud-v1-"+fixture+"-batch";
  const variants=[prefix,batch];
  if(id==="RB-PDF-13:page-002-region-01")
    variants.push(prefix+"-retry-p127-r02-20261021");
  let result=false,attempt=false,staging=false;
  for(const part of variants){
    const output=await existing(join(base,part));
    const receipt=await existing(join(base,"."+part+".cloud-attempted"));
    const stage=await existing(join(base,"."+part+"-stage"));
    // Suspicious files are not enough to certify a valid model response.
    result ||=output;attempt ||=receipt;staging ||=stage;
  }
  let state;
  if(result)state="OUTPUT_PRESENT_REQUIRES_PRIVATE_VALIDATION";
  else if(attempt||staging)state="PRIOR_ATTEMPT_OUTCOME_UNCERTAIN";
  else state="NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED";
  return {
    schemaVersion:"acs-cloud-evidence-reconciliation-v1",id,
    state,canAutoRetry:false,dispatchAuthorized:false,
    resultObserved:result,attemptMarkerObserved:attempt,stageObserved:staging,
    providerRequestsIssuedThisRun:0
  };
}
export async function reconcileBatchCandidates(root,plan){
  try{verifyOfflineBatchPlan(plan);}
  catch(e){if(e instanceof BatchAuthorizationError)block("RECONCILE_PLAN_INVALID");throw e;}
  // The offline planner must still be rerun immediately before an actual
  // attempt in a future implementation. This is report-only reconciliation.
  const items=[];
  // Crucial: inspection must include previously BLOCKED attempts, not only
  // fresh planned candidates. Otherwise the most important unknown charge
  // states disappear from the operator's forensic overview.
  for(const item of [...plan.planned,...plan.excluded]){
    const observed=await reconcileCloudEvidence(root,item.id);
    items.push({...observed,planningStatus:plan.planned.some(p=>p.id===item.id)?
      "WAITING_FOR_AUTHORIZATION":"EXCLUDED_FROM_PLAN",
      exclusionReason:plan.excluded.find(p=>p.id===item.id)?.reason??null});
  }
  return {
    schemaVersion:"acs-cloud-batch-reconciliation-v1",
    authority:"READ_ONLY_OBSERVATION_NOT_AUTHORIZATION",
    planSha256:plan.planSha256,
    inspected:items.length,
    noPreviousEvidence:items.filter(x=>x.state==="NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED").length,
    unsafeToReplay:items.filter(x=>x.state!=="NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED").length,
    items,
    dispatchEnabled:false,
    providerRequestsIssued:0
  };
}
