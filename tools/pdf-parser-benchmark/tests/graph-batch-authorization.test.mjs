import {describe,it,expect} from "vitest";
import {generateKeyPairSync,sign as edSign} from "node:crypto";
import {consentStatement,verifyConsentEvidence,assertBillableReady,
  TRUSTED_PRODUCTION_SIGNERS,ConsentProofError}
  from "../annotation/graph-batch-consent-proof.mjs";
import {claimSyntheticAttempt,inspectSyntheticAttempt,SyntheticAttemptError}
  from "../annotation/graph-batch-simulated-attempt.mjs";
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileGraphBatchPlan} from "../annotation/graph-batch-plan.mjs";
import {draftBatchAuthorization,verifyBatchAuthorizationDraft,
  guardBatchDispatch,BatchAuthorizationError} from "../annotation/graph-batch-authorization.mjs";
import {OFFICIAL_REFERENCE_RATES,quoteOfflineReferenceUsage,requireActualSpendBound,PricingGateError}
  from "../annotation/graph-batch-pricing.mjs";
import {reconcileCloudEvidence,reconcileBatchCandidates,ReconcileError}
  from "../annotation/graph-batch-reconcile.mjs";
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
      "BATCH_LEDGER_RESERVATION_UNSAFE");
    expect(receipt.dispatchEnabled).toBe(false);
    await rejectAsync(()=>reserveOfflineReviewItem(root,plan,draft,ids[0],
      {now:"2026-10-21T00:00:00.000Z"}),"BATCH_LEDGER_ITEM_ALREADY_RESERVED");
  }));
});


describe("03E-04B-02A exact list-rate estimation and uncertain-result fail-closed",()=>{
  it("publishes official CNY per-million reference but cannot certify account rate or image tokens",()=>{
    expect(OFFICIAL_REFERENCE_RATES).toMatchObject({
      model:"glm-5.3-flash",currency:"CNY",
      inputFenPerMillionTokens:80,outputFenPerMillionTokens:280,
      cachedInputFenPerMillionTokens:23,accountTariffVerified:false,
      imageTokenUpperBoundVerified:false,eligibleForPaidDispatch:false
    });
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const quote=quoteOfflineReferenceUsage(plan,draft,[
      {id:ids[0],inputTokens:1_000_000,cachedInputTokens:0,outputTokens:6000},
      {id:ids[1],inputTokens:0,cachedInputTokens:0,outputTokens:0}
    ]);
    expect(quote.listRateComponentsFen).toEqual({input:80,cachedInput:0,output:2});
    expect(quote.referenceTotalFen).toBe(82);
    expect(quote).toMatchObject({withinRequestedDraftCapForIllustration:true,
      providerSpendUpperBoundVerified:false,approved:false,dispatchEnabled:false,
      imageTokenUpperBoundVerified:false,accountTariffVerified:false});
    rejectCode(()=>requireActualSpendBound(quote),PricingGateError,
      "PRICING_ACTUAL_MAXIMUM_NOT_VERIFIED");
  });
  it("uses separate cache rates and round-up without hiding fractional fen",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const q=quoteOfflineReferenceUsage(plan,draft,[
      {id:ids[0],inputTokens:1,cachedInputTokens:0,outputTokens:1},
      {id:ids[1],inputTokens:1_000_000,cachedInputTokens:1_000_000,outputTokens:0}
    ]);
    expect(q.listRateComponentsFen).toEqual({input:1,cachedInput:23,output:1});
    expect(q.referenceTotalFen).toBe(25);
    rejectCode(()=>guardBatchDispatch(plan,draft),BatchAuthorizationError,
      "BATCH_DISPATCH_REQUIRES_VERIFIED_PRICE_AND_EXPLICIT_APPROVAL");
  });
  it("rounds each call independently in the non-binding price illustration",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const quote=quoteOfflineReferenceUsage(plan,draft,ids.map(id=>({
      id,inputTokens:1,cachedInputTokens:0,outputTokens:1
    })));
    expect(quote.listRateComponentsFen).toEqual({input:2,cachedInput:0,output:2});
    expect(quote.referenceTotalFen).toBe(4);
    expect(quote.providerSpendUpperBoundVerified).toBe(false);
  });
  it("rejects made-up input token bounds, incomplete usage or out-of-scope rows",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    for(const rows of [
      [{id:ids[0],inputTokens:0,cachedInputTokens:0,outputTokens:0}],
      [{id:ids[0],inputTokens:1_048_577,cachedInputTokens:0,outputTokens:0},
       {id:ids[1],inputTokens:0,cachedInputTokens:0,outputTokens:0}],
      [{id:ids[0],inputTokens:20,cachedInputTokens:21,outputTokens:0},
       {id:ids[1],inputTokens:0,cachedInputTokens:0,outputTokens:0}],
      [{id:ids[0],inputTokens:10,cachedInputTokens:0,outputTokens:6001},
       {id:ids[1],inputTokens:0,cachedInputTokens:0,outputTokens:0}],
      [{id:ids[0],inputTokens:10,cachedInputTokens:0,outputTokens:0},
       {id:ids[0],inputTokens:10,cachedInputTokens:0,outputTokens:0}]
    ])expect(()=>quoteOfflineReferenceUsage(plan,draft,rows)).toThrow(PricingGateError);
    expect(()=>quoteOfflineReferenceUsage(plan,draft,{
      model:"fake",approved:true})).toThrow(PricingGateError);
  });
  it("refuses to classify a reserved receipt or half-written stage as retryable",()=>onTemp(async root=>{
    const id=ids[0];
    expect(await reconcileCloudEvidence(root,id)).toMatchObject({
      state:"NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED",
      canAutoRetry:false,dispatchAuthorized:false,providerRequestsIssuedThisRun:0});
    const prefix="glm-cloud-v1-RB-PDF-12-page-001-region-01";
    await writeFile(join(root,"."+prefix+".cloud-attempted"),"REQUEST_MAY_HAVE_COST");
    expect(await reconcileCloudEvidence(root,id)).toMatchObject({
      state:"PRIOR_ATTEMPT_OUTCOME_UNCERTAIN",attemptMarkerObserved:true,canAutoRetry:false});
    await rm(join(root,"."+prefix+".cloud-attempted"));
    await mkdir(join(root,"."+prefix+"-stage"));
    expect((await reconcileCloudEvidence(root,id)).state).toBe("PRIOR_ATTEMPT_OUTCOME_UNCERTAIN");
    await rm(join(root,"."+prefix+"-stage"),{recursive:true});
    await mkdir(join(root,prefix));
    expect(await reconcileCloudEvidence(root,id)).toMatchObject({
      state:"OUTPUT_PRESENT_REQUIRES_PRIVATE_VALIDATION",resultObserved:true,
      dispatchAuthorized:false,canAutoRetry:false});
    const report=await reconcileBatchCandidates(root,makePlan());
    expect(report).toMatchObject({inspected:2,unsafeToReplay:1,noPreviousEvidence:1,
      dispatchEnabled:false,providerRequestsIssued:0});
    expect(JSON.stringify(report)).not.toContain("REQUEST_MAY_HAVE_COST");
  }));
  it("recognizes legacy P127 retry and same-book batch markers without reading their contents",()=>onTemp(async root=>{
    const id="RB-PDF-13:page-002-region-01";
    const prefix="glm-cloud-v1-RB-PDF-13-page-002-region-01";
    await writeFile(join(root,"."+prefix+"-retry-p127-r02-20261021.cloud-attempted"),"PRIVATE");
    expect(await reconcileCloudEvidence(root,id)).toMatchObject({
      state:"PRIOR_ATTEMPT_OUTCOME_UNCERTAIN",canAutoRetry:false});
    await rm(join(root,"."+prefix+"-retry-p127-r02-20261021.cloud-attempted"));
    await mkdir(join(root,"glm-cloud-v1-RB-PDF-13-batch"));
    expect((await reconcileCloudEvidence(root,id)).state).toBe("OUTPUT_PRESENT_REQUIRES_PRIVATE_VALIDATION");
  }));
  it("reconciles excluded uncertain attempts as well as eligible new crops",()=>onTemp(async root=>{
    const id=ids[0];
    const queue={schemaVersion:"acs-private-graph-review-queue-v1",
      authority:"DISCOVERY_ONLY_NOT_GROUND_TRUTH",
      counts:{total:2},
      items:ids.map((v,i)=>({id:v,fixtureId:v.split(":")[0],
        regionId:v.split(":")[1],sourcePhysicalPage1Based:i+51,
        evidenceStatus:"CROP_READY_NO_GRAPH",reviewable:false,
        graphVerified:false,humanVerified:false}))};
    const proofs=ids.map((v,i)=>({id:v,sourcePhysicalPage1Based:i+51,
      authority:"CROP_ONLY_UNVERIFIED",graphVerified:false,humanVerified:false,
      cropSha256:(i?"b":"a").repeat(64),byteLength:120,
      width:120,height:80,priorAttemptBlocked:i===0}));
    const plan=compileGraphBatchPlan(queue,proofs);
    expect(plan.counts).toMatchObject({eligible:1,excluded:1,blocked:1});
    const marker=join(root,".glm-cloud-v1-RB-PDF-12-page-001-region-01.cloud-attempted");
    await writeFile(marker,"CHARGE_OUTCOME_UNKNOWN");
    const result=await reconcileBatchCandidates(root,plan);
    expect(result).toMatchObject({inspected:2,unsafeToReplay:1,noPreviousEvidence:1,
      dispatchEnabled:false});
    expect(result.items.find(x=>x.id===id)).toMatchObject({
      state:"PRIOR_ATTEMPT_OUTCOME_UNCERTAIN",planningStatus:"EXCLUDED_FROM_PLAN",
      exclusionReason:"PRIOR_ATTEMPT_OR_OUTPUT_PRESENT",canAutoRetry:false});
    expect(JSON.stringify(result)).not.toContain("CHARGE_OUTCOME_UNKNOWN");
  }));
  it("fails closed on symlink and unknown item, never suggests auto-replay",()=>onTemp(async root=>{
    const marker=join(root,".glm-cloud-v1-RB-PDF-12-page-001-region-01.cloud-attempted");
    const outside=join(root,"other.txt");
    await writeFile(outside,"DO_NOT_READ");
    await symlink(outside,marker);
    await rejectAsync(async()=>{
      try{await reconcileCloudEvidence(root,ids[0]);}
      catch(e){if(e instanceof ReconcileError)throw new BatchLedgerError(e.code);throw e;}
    },"RECONCILE_SYMLINK_UNSAFE");
    await expect(reconcileCloudEvidence(root,"../secrets")).rejects
      .toMatchObject({code:"RECONCILE_ITEM_INVALID"});
  }));
});


describe("03E-04B-02B signed proof and permanent synthetic claim — NO provider calls",()=>{
  const makeEvidence=(plan,draft,overrides={})=>{
    const keys=generateKeyPairSync("ed25519");
    const statement=consentStatement(plan,draft,{
      issuedAt:"2026-10-21T01:00:00.000Z"});
    const signatureBase64=edSign(null,Buffer.from(JSON.stringify(statement),"utf8"),
      keys.privateKey).toString("base64");
    const evidence={statement,keyId:"synthetic_only",signatureBase64,...overrides};
    return {evidence,publicKey:keys.publicKey};
  };
  const testRoot=async root=>{
    await writeFile(join(root,"ACS_SYNTHETIC_ONLY.marker"),
      "ACS_SYNTHETIC_CLOUD_ROOT_V1\n");
  };
  const mustReject=async(job,code)=>{
    try{await job();throw new Error("EXPECTED_REJECTION");}
    catch(e){expect(e).toBeInstanceOf(SyntheticAttemptError);expect(e.code).toBe(code);}
  };
  it("proves Ed25519 signature in synthetic keyring without granting spend",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const {evidence,publicKey}=makeEvidence(plan,draft);
    expect(Object.keys(TRUSTED_PRODUCTION_SIGNERS)).toHaveLength(0);
    rejectCode(()=>verifyConsentEvidence(plan,draft,evidence,{
      now:"2026-10-21T02:00:00.000Z"}),ConsentProofError,
      "CONSENT_TRUSTED_SIGNER_NOT_CONFIGURED");
    const verified=verifyConsentEvidence(plan,draft,evidence,{
      now:"2026-10-21T02:00:00.000Z",
      trustedKeys:{synthetic_only:publicKey}
    });
    expect(verified).toMatchObject({operatorSignatureVerified:true,
      providerExecutionApproved:false,dispatchEnabled:false,
      billableBudgetVerified:false,accountPriceVerified:false,
      imageTokenMaximumVerified:false,productionSignerProvisioned:false});
    rejectCode(()=>assertBillableReady(verified),ConsentProofError,
      "CONSENT_BILLABLE_APPROVAL_NOT_IMPLEMENTED");
  });
  it("refuses wrong signer, changed amount, changed crop SHA and fake approval",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const {evidence,publicKey}=makeEvidence(plan,draft);
    const verify=e=>verifyConsentEvidence(plan,draft,e,{
      now:"2026-10-21T02:00:00.000Z",trustedKeys:{synthetic_only:publicKey}
    });
    for(const mutation of [
      {...evidence,signatureBase64:(evidence.signatureBase64[0]==="A"?"B":"A")+evidence.signatureBase64.slice(1)},
      {...evidence,statement:{...evidence.statement,maxSpendMinorUnits:100000}},
      {...evidence,statement:{...evidence.statement,selectedCropSha256:["a".repeat(64)]}},
      {...evidence,statement:{...evidence.statement,providerExecutionApproved:true}}
    ])expect(()=>verify(mutation)).toThrow(ConsentProofError);
    const other=generateKeyPairSync("ed25519");
    rejectCode(()=>verifyConsentEvidence(plan,draft,evidence,{
      now:"2026-10-21T02:00:00.000Z",
      trustedKeys:{synthetic_only:other.publicKey}
    }),ConsentProofError,"CONSENT_SIGNATURE_INVALID");
  });
  it("refuses expired signature, before-issue and bad public key type",()=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const {evidence,publicKey}=makeEvidence(plan,draft);
    for(const now of ["2026-10-20T23:59:59.000Z","2026-10-22T00:00:00.000Z"]){
      rejectCode(()=>verifyConsentEvidence(plan,draft,evidence,{
        trustedKeys:{synthetic_only:publicKey},now
      }),ConsentProofError,"CONSENT_SCOPE_OR_EXPIRY_INVALID");
    }
    const wrong=generateKeyPairSync("rsa",{modulusLength:2048});
    rejectCode(()=>verifyConsentEvidence(plan,draft,evidence,{
      trustedKeys:{synthetic_only:wrong.publicKey},now:"2026-10-21T02:00:00.000Z"
    }),ConsentProofError,"CONSENT_SIGNER_KEY_TYPE_INVALID");
  });
  it("uses one permanent per-region simulation claim across concurrent processes",()=>onTemp(async root=>{
    await testRoot(root);
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    const all=await Promise.allSettled([
      claimSyntheticAttempt(root,plan,draft,ids[0]),
      claimSyntheticAttempt(root,plan,draft,ids[0]),
      claimSyntheticAttempt(root,plan,draft,ids[0])
    ]);
    expect(all.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect(all.filter(x=>x.status==="rejected")).toHaveLength(2);
    expect(all.filter(x=>x.status==="rejected").map(x=>x.reason.code))
      .toEqual(["SYNTHETIC_ATTEMPT_ALREADY_CLAIMED","SYNTHETIC_ATTEMPT_ALREADY_CLAIMED"]);
    const state=await inspectSyntheticAttempt(root,plan,draft,ids[0]);
    expect(state).toMatchObject({status:"SIMULATED_UNCERTAIN_OUTCOME_NO_NETWORK",
      networkAllowed:false,mayAutoReplay:false});
    expect((await inspectSyntheticAttempt(root,plan,draft,ids[1])).status).toBe("NOT_CLAIMED");
    expect((await claimSyntheticAttempt(root,plan,draft,ids[1])).providerRequestsIssued).toBe(0);
  }));
  it("requires isolated marker and blocks any prior billable receipt",()=>onTemp(async root=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    await mustReject(()=>claimSyntheticAttempt(root,plan,draft,ids[0]),
      "SYNTHETIC_ATTEMPT_MARKER_INVALID");
    await testRoot(root);
    const marker=join(root,".glm-cloud-v1-RB-PDF-12-page-001-region-01.cloud-attempted");
    await writeFile(marker,"POSSIBLY_BILLED");
    await mustReject(()=>claimSyntheticAttempt(root,plan,draft,ids[0]),
      "SYNTHETIC_ATTEMPT_PRIOR_PROVIDER_EVIDENCE");
    await rm(marker);
    await claimSyntheticAttempt(root,plan,draft,ids[0]);
    await mustReject(()=>claimSyntheticAttempt(root,plan,draft,ids[0]),
      "SYNTHETIC_ATTEMPT_ALREADY_CLAIMED");
  }));
  it("rejects cross-authorization reuse and truncated claims after crash",()=>onTemp(async root=>{
    await testRoot(root);
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    await claimSyntheticAttempt(root,plan,draft,ids[0]);
    const different=draftBatchAuthorization(plan,{...opts,maxSpendMinorUnits:3300});
    await mustReject(()=>inspectSyntheticAttempt(root,plan,different,ids[0]),
      "SYNTHETIC_ATTEMPT_TAMPERED");
    const path=join(root,"private-synthetic-attempts-04b02b",
      "simulation-"+ids[0].replace(":","-")+".json");
    await writeFile(path,"x");
    await mustReject(()=>inspectSyntheticAttempt(root,plan,draft,ids[0]),
      "SYNTHETIC_ATTEMPT_FILE_UNSAFE");
    await mustReject(()=>claimSyntheticAttempt(root,plan,draft,ids[0]),
      "SYNTHETIC_ATTEMPT_ALREADY_CLAIMED");
  }));
  it("does not accept marker symlink or non-selected region",()=>onTemp(async root=>{
    const plan=makePlan(),draft=draftBatchAuthorization(plan,opts);
    await writeFile(join(root,"original.txt"),"ACS_SYNTHETIC_CLOUD_ROOT_V1\n");
    await symlink(join(root,"original.txt"),join(root,"ACS_SYNTHETIC_ONLY.marker"));
    await mustReject(()=>claimSyntheticAttempt(root,plan,draft,ids[0]),
      "SYNTHETIC_ATTEMPT_MARKER_INVALID");
    await mustReject(()=>claimSyntheticAttempt(root,plan,draft,
      "RB-PDF-12:page-003-region-99"),"SYNTHETIC_ATTEMPT_NOT_SELECTED");
  }));
});
