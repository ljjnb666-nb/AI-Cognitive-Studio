/**
 * 03E-04B-02C: safe operator overview of LOCAL existing, canonical outputs.
 * No provider, no filesystem search, no result text/pixels, no public listing
 * of private paths. A valid result remains a UNAPPROVED registration candidate.
 */
import {
  listPrivateGraphReviewQueue,
  inspectCanonicalGraphResultForRegistration
} from "./private-graph-local.mjs";
import {reconcileCloudEvidence} from "./graph-batch-reconcile.mjs";
import {readStagedGraphBundle} from "./graph-result-staged-review.mjs";

export class IntakeQueueError extends Error{
  constructor(code){super(code);this.code=code;this.name="IntakeQueueError";}
}
const reject=code=>{throw new IntakeQueueError(code);};

export async function readOnlyCanonicalIntakeOverview(root,registrations){
  const queue=await listPrivateGraphReviewQueue(root,registrations);
  if(queue?.authority!=="DISCOVERY_ONLY_NOT_GROUND_TRUTH"||
     !Array.isArray(queue.items)||queue.items.length>32)
    reject("INTAKE_QUEUE_INVALID");
  const items=[];
  for(const item of queue.items){
    let state="SOURCE_BLOCKED";
    let nodeCount=null,edgeCount=null;
    let stageState=null,stagedAvailable=false;
    let reviewedCount=null,reviewKind=null;
    if(item.reviewable&&item.evidenceStatus==="GRAPH_READY_FOR_HUMAN_REVIEW"){
      state="REGISTERED_PENDING_HUMAN_REVIEW";
      nodeCount=item.nodeCount;
      edgeCount=item.edgeCount;
      reviewedCount=item.reviewedCount;
      reviewKind=item.reviewKind;
    }else if(item.evidenceStatus==="CROP_READY_NO_GRAPH"){
      // P127 is protected by the legacy registered review path and can
      // never be proposed as a second canonical generic registration.
      if(item.id==="RB-PDF-13:page-002-region-01"){
        state="LEGACY_P127_EVIDENCE_BLOCKED";
      }else{
        let prior;
        try{prior=await reconcileCloudEvidence(root,item.id);}
        catch{state="MODEL_EVIDENCE_UNSAFE";}
        if(prior){
          if(prior.state==="NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED")
            state="WAITING_FOR_EXPLICIT_PAID_AUTHORIZATION";
          else if(prior.state==="PRIOR_ATTEMPT_OUTCOME_UNCERTAIN")
            state="PRIOR_ATTEMPT_UNCERTAIN_NO_REPLAY";
          else{
            try{
              const candidate=await inspectCanonicalGraphResultForRegistration(root,item.id);
              if(candidate?.state!=="REGISTRATION_CANDIDATE_NOT_APPROVED"||
                 candidate.registered!==false||candidate.graphVerified!==false)
                reject("INTAKE_CANDIDATE_AUTHORITY_INVALID");
              const staged=await readStagedGraphBundle(root,item.id,registrations);
              if(staged.reviewKind!=="STAGED_REGION"||staged.graphVerified!==false||
                 staged.humanVerified!==false||staged.registered!==false||
                 staged.identity.resultSha256!==candidate.sourceSha256.resultSha256||
                 staged.identity.manifestSha256!==candidate.sourceSha256.manifestSha256||
                 staged.identity.cropSha256!==candidate.sourceSha256.cropSha256)
                reject("INTAKE_STAGED_SOURCE_INVALID");
              state="SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED";
              nodeCount=candidate.modelCandidateNodes;
              edgeCount=candidate.modelCandidateEdges;
              stageState=staged.saved.draft?"REVIEW_DRAFT_UNATTESTED":"WAITING_FOR_REVIEW";
              reviewedCount=staged.saved.draft?.decisions.filter(x=>x.decision!=="UNREVIEWED").length??0;
              reviewKind="STAGED_REGION";
              stagedAvailable=true;
            }catch{
              state="MODEL_RESULT_BLOCKED_MANUAL_INVESTIGATION";
            }
          }
        }
      }
    }
    if(reviewKind!==null && (!Number.isSafeInteger(nodeCount)||
      !Number.isSafeInteger(edgeCount)||!Number.isSafeInteger(reviewedCount)||
      nodeCount<0||edgeCount<0||reviewedCount<0||
      reviewedCount>nodeCount+edgeCount||
      !["LEGACY_P127","REGISTERED_REGION","STAGED_REGION"].includes(reviewKind)))
      reject("INTAKE_REVIEW_PROGRESS_INVALID");
    items.push({
      id:item.id,fixtureId:item.fixtureId,regionId:item.regionId,
      physicalPage:item.sourcePhysicalPage1Based,
      state,nodeCount,edgeCount,stageState,stagedAvailable,
      reviewKind,reviewedCount,
      humanVerified:false,graphVerified:false,
      dispatchEnabled:false,providerRequestsIssuedThisRun:0
    });
  }
  const counts={
    total:items.length,
    reviewable:items.filter(x=>x.state==="REGISTERED_PENDING_HUMAN_REVIEW").length,
    awaitingAuthorization:items.filter(x=>x.state==="WAITING_FOR_EXPLICIT_PAID_AUTHORIZATION").length,
    registrationPending:items.filter(x=>x.state==="SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED").length,
    blocked:items.filter(x=>!["REGISTERED_PENDING_HUMAN_REVIEW",
      "WAITING_FOR_EXPLICIT_PAID_AUTHORIZATION",
      "SOURCE_VERIFIED_REGISTRATION_NOT_APPROVED"].includes(x.state)).length
  };
  // This is only persisted DRAFT completion, not trusted graph verification.
  // A model response is never permitted to supply these counts.
  const eligible=items.filter(x=>x.reviewKind!==null);
  const pending=eligible.filter(x=>x.reviewedCount<x.nodeCount+x.edgeCount);
  const next=[...pending].sort((a,b)=>
    (b.reviewedCount>0?1:0)-(a.reviewedCount>0?1:0)||
    a.fixtureId.localeCompare(b.fixtureId)||
    a.physicalPage-b.physicalPage||
    a.regionId.localeCompare(b.regionId))[0];
  const progress={
    eligibleRegions:eligible.length,
    completedDraftRegions:eligible.length-pending.length,
    incompleteDraftRegions:pending.length,
    totalDecisions:eligible.reduce((sum,x)=>sum+x.nodeCount+x.edgeCount,0),
    reviewedDecisions:eligible.reduce((sum,x)=>sum+x.reviewedCount,0),
    nextItemId:next?.id??null,
    certifiedRegions:0,
    authority:"DRAFT_PROGRESS_ONLY_NOT_HUMAN_VERIFICATION"
  };
  if(Object.values(counts).slice(1).reduce((a,b)=>a+b,0)!==counts.total)
    reject("INTAKE_COVERAGE_INVALID");
  return {
    schemaVersion:"acs-safe-graph-intake-overview-v1",
    authority:"READ_ONLY_CANDIDATES_NO_DISPATCH",
    counts,items,progress,
    dispatchEnabled:false,providerRequestsIssuedThisRun:0,
    priceAuthorized:false,autoRegistered:false,autoVerified:false
  };
}
