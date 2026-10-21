/**
 * 03E-04B-02A reference pricing: authoritative publicly listed Zhipu rates,
 * but never proof of image-token upper bounds or the user's account tariff.
 * NO DISPATCH. No real authorization. Never call it a hard monetary cap.
 */
import {verifyOfflineBatchPlan,verifyBatchAuthorizationDraft,BatchAuthorizationError} from "./graph-batch-authorization.mjs";

export class PricingGateError extends Error {
  constructor(code){super(code);this.name="PricingGateError";this.code=code;}
}
const block=code=>{throw new PricingGateError(code);};
export const OFFICIAL_REFERENCE_RATES=Object.freeze({
  schemaVersion:"acs-glm-flash-reference-price-v1",
  model:"glm-5.3-flash",currency:"CNY",
  inputFenPerMillionTokens:80,
  outputFenPerMillionTokens:280,
  cachedInputFenPerMillionTokens:23,
  source:"https://docs.bigmodel.cn/cn/guide/start/pricing",
  checkedDate:"2026-10-21",
  accountTariffVerified:false,
  imageTokenUpperBoundVerified:false,
  cachingStorageFeeBoundVerified:false,
  eligibleForPaidDispatch:false
});
const uint=(x,max)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
function fen(tokens,perMillion){
  return Number((BigInt(tokens)*BigInt(perMillion)+999999n)/1000000n);
}
/**
 * Compute sample token-accounting using token *ASSUMPTIONS* rather than a
 * provider-verifiable preflight. No usage or rate may be accepted as consent.
 */
export function quoteOfflineReferenceUsage(plan,draft,usage){
  try{verifyOfflineBatchPlan(plan);verifyBatchAuthorizationDraft(plan,draft);}
  catch(e){
    if(e instanceof BatchAuthorizationError)block("PRICING_PLAN_OR_DRAFT_INVALID");
    throw e;
  }
  if(draft.currency!=="CNY"||!Array.isArray(usage)||
     usage.length!==draft.items.length)
    block("PRICING_REFERENCE_INPUT_INVALID");
  const selected=new Map(draft.items.map(x=>[x.id,x]));
  const seen=new Set();
  let input=0,output=0,cached=0;
  let inputFen=0,outputFen=0,cacheFen=0;
  for(const row of usage){
    if(!row||typeof row!=="object"||Array.isArray(row)||
       typeof row.id!=="string"||!selected.has(row.id)||seen.has(row.id)||
       !uint(row.inputTokens,1_048_576)||
       !uint(row.outputTokens,6000)||
       !uint(row.cachedInputTokens,1_048_576)||
       row.cachedInputTokens>row.inputTokens)
      block("PRICING_TOKEN_ASSUMPTION_INVALID");
    seen.add(row.id);
    input+=row.inputTokens-row.cachedInputTokens;
    output+=row.outputTokens;
    cached+=row.cachedInputTokens;
    // Round each hypothetical request's charge upward to a whole fen.
    // Rounding only once across a batch can understate individually rounded
    // provider bills. This is still NOT a verified spend upper bound.
    inputFen+=fen(row.inputTokens-row.cachedInputTokens,80);
    outputFen+=fen(row.outputTokens,280);
    cacheFen+=fen(row.cachedInputTokens,23);
  }
  const referenceTotalFen=inputFen+outputFen+cacheFen;
  return Object.freeze({
    schemaVersion:"acs-glm-batch-reference-quote-v1",
    planSha256:plan.planSha256,requestSha256:draft.requestSha256,
    model:"glm-5.3-flash",currency:"CNY",
    tokenAssumptionsProvidedByCaller:true,
    imageTokenUpperBoundVerified:false,
    accountTariffVerified:false,
    cachingStorageFeeBoundVerified:false,
    providerSpendUpperBoundVerified:false,
    officialReferenceCheckedDate:OFFICIAL_REFERENCE_RATES.checkedDate,
    referenceSource:OFFICIAL_REFERENCE_RATES.source,
    modeledUsage:{nonCachedInputTokens:input,cachedInputTokens:cached,outputTokens:output},
    listRateComponentsFen:{input:inputFen,cachedInput:cacheFen,output:outputFen},
    referenceTotalFen,
    withinRequestedDraftCapForIllustration:referenceTotalFen<=draft.maxSpendMinorUnits,
    approved:false,dispatchEnabled:false,providerRequestsIssued:0,
    warningCode:"PRICING_REFERENCE_NOT_A_BILLING_CAP"
  });
}
export function requireActualSpendBound(quote){
  if(!quote||quote.schemaVersion!=="acs-glm-batch-reference-quote-v1")
    block("PRICING_QUOTE_INVALID");
  // Actual image token upper bound + account tariff and storage can only be
  // verified by an independently reviewed execution gate, not this estimator.
  block("PRICING_ACTUAL_MAXIMUM_NOT_VERIFIED");
}
