/**
 * 03E-04B-02E: ephemeral, local-only intake for completed canonical results.
 * A verified byte tuple may be presented for *unattested* human draft review.
 * Nothing is written to the permanent trusted code registry, no model dispatch,
 * payment, source mutation, approval or graph verification is possible here.
 */
import {compileTrustedGraphRegistry,lookupTrustedGraphResult,TRUSTED_GRAPH_RESULTS} from "./graph-result-registry.mjs";
import {listPrivateGraphReviewQueue,inspectCanonicalGraphResultForRegistration,
  readRegisteredGraphBundle,saveRegisteredGraphReviewDraft,PrivateGraphError} from "./private-graph-local.mjs";
import {reconcileCloudEvidence} from "./graph-batch-reconcile.mjs";

const fail=code=>{throw new PrivateGraphError(code);};
const ID=/^RB-PDF-(?:12|13):page-[0-9]{3}-region-[0-9]{2}$/u;

/**
 * Rebuild from *current* verified bytes on every request. Deliberately do not
 * persist an authority manifest or trust stale client-provided SHA values.
 */
export async function resolveStagedGraphRegistration(root,itemId,registrations=TRUSTED_GRAPH_RESULTS){
  if(typeof itemId!=="string"||!ID.test(itemId)||
     itemId==="RB-PDF-13:page-002-region-01")
    fail("PRIVATE_STAGED_ITEM_INVALID");
  const trusted=compileTrustedGraphRegistry(registrations);
  if(lookupTrustedGraphResult(itemId,trusted))
    fail("PRIVATE_STAGED_ALREADY_REGISTERED");
  const queue=await listPrivateGraphReviewQueue(root,trusted);
  const item=queue.items.find(x=>x.id===itemId);
  if(!item||item.evidenceStatus!=="CROP_READY_NO_GRAPH"||item.reviewable)
    fail("PRIVATE_STAGED_CROP_NOT_READY");
  const reconciliation=await reconcileCloudEvidence(root,itemId);
  if(reconciliation.state!=="OUTPUT_PRESENT_REQUIRES_PRIVATE_VALIDATION")
    fail("PRIVATE_STAGED_RESULT_UNAVAILABLE_NO_REPLAY");
  const candidate=await inspectCanonicalGraphResultForRegistration(root,itemId);
  const reg=candidate.registration;
  if(candidate.state!=="REGISTRATION_CANDIDATE_NOT_APPROVED"||
     candidate.humanVerified!==false||candidate.graphVerified!==false||
     candidate.registered!==false||candidate.publishable!==false||
     reg.id!==item.id||reg.fixtureId!==item.fixtureId||
     reg.regionId!==item.regionId||reg.physicalPage!==item.sourcePhysicalPage1Based||
     reg.kind!=="REGISTERED_REGION")
    fail("PRIVATE_STAGED_IDENTITY_INVALID");
  // This is solely an in-memory SHA-pinned reader registration. It is never
  // added to TRUSTED_GRAPH_RESULTS or the public /registry endpoint.
  const ephemeral=compileTrustedGraphRegistry([...trusted,reg]);
  return {registration:reg,ephemeral};
}

export async function readStagedGraphBundle(root,itemId,registrations=TRUSTED_GRAPH_RESULTS){
  const {registration,ephemeral}=await resolveStagedGraphRegistration(root,itemId,registrations);
  const bundle=await readRegisteredGraphBundle(root,itemId,ephemeral);
  if(bundle.identity.resultSha256!==registration.resultSha256||
     bundle.identity.manifestSha256!==registration.manifestSha256||
     bundle.identity.cropSha256!==registration.cropSha256||
     bundle.view.graphVerified!==false)
    fail("PRIVATE_STAGED_SHA_CHANGED");
  return {...bundle,reviewKind:"STAGED_REGION",registered:false,publishable:false,
    humanVerified:false,graphVerified:false,providerRequestsIssuedThisRun:0};
}

export async function saveStagedGraphReviewDraft(root,itemId,input,revision,registrations=TRUSTED_GRAPH_RESULTS){
  // A re-read and exact SHA pin on each PUT prevents a stale candidate from
  // overwriting another book, region, result generation or a registered draft.
  const {ephemeral}=await resolveStagedGraphRegistration(root,itemId,registrations);
  const saved=await saveRegisteredGraphReviewDraft(root,itemId,input,revision,ephemeral);
  return {...saved,registered:false,graphVerified:false,humanVerified:false};
}
