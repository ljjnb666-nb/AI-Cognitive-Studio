/**
 * 03E-04B-02B: verify OPERATOR CONSENT evidence only, NOT a spend permit.
 * Production trusted signer keyring is intentionally EMPTY. A synthetic
 * keyring may be supplied by tests; neither path authorizes network calls.
 *
 * Positive signatures prove who signed specified bytes, not that the account
 * tariff/image token maximum, a money cap, or billable worker is trustworthy.
 */
import {createPublicKey,verify as cryptoVerify} from "node:crypto";
import {verifyBatchAuthorizationDraft,BatchAuthorizationError} from "./graph-batch-authorization.mjs";

export class ConsentProofError extends Error{
  constructor(code){super(code);this.name="ConsentProofError";this.code=code;}
}
const deny=code=>{throw new ConsentProofError(code);};
const HEX=/^[0-9a-f]{64}$/u;
const KEY_ID=/^[a-z][a-z0-9_-]{1,47}$/u;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u;
const exactKeys=(obj,keys)=>obj&&typeof obj==="object"&&!Array.isArray(obj)&&
  Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
const timestamp=s=>typeof s==="string"&&ISO.test(s)&&
  Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s?Date.parse(s):NaN;
export const TRUSTED_PRODUCTION_SIGNERS=Object.freeze({}); // explicitly not provisioned

/** Build bytes to be independently signed in an offline synthetic test. */
export function consentStatement(plan,draft,{issuedAt}={}){
  try{verifyBatchAuthorizationDraft(plan,draft);}
  catch(e){if(e instanceof BatchAuthorizationError)deny("CONSENT_DRAFT_INVALID");throw e;}
  if(!Number.isFinite(timestamp(issuedAt)) ||
     timestamp(issuedAt)>=timestamp(draft.expiresAt) ||
     timestamp(draft.expiresAt)-timestamp(issuedAt)>7*24*3600*1000)
    deny("CONSENT_TIME_INVALID");
  return {
    schemaVersion:"acs-batch-operator-consent-evidence-v1",
    purpose:"CONSENT_EVIDENCE_ONLY_NO_DISPATCH",
    planSha256:plan.planSha256,
    requestSha256:draft.requestSha256,
    sourceRun:plan.sourceRun,model:draft.model,
    selectedCropSha256:draft.items.map(x=>x.cropSha256),
    selectedRegionIds:draft.items.map(x=>x.id),
    maxCalls:draft.maxCalls,maxSpendMinorUnits:draft.maxSpendMinorUnits,
    currency:draft.currency,
    issuedAt,expiresAt:draft.expiresAt,
    providerExecutionApproved:false
  };
}
/**
 * Signature is verified against the caller's configured trusted keyring.
 * NEVER let HTTP body supply the keyring. Defaults to an EMPTY keyring.
 * A cryptographic match does not establish a valid billable approval.
 */
export function verifyConsentEvidence(plan,draft,evidence,{
  trustedKeys=TRUSTED_PRODUCTION_SIGNERS,now
}={}){
  if(!exactKeys(evidence,["statement","keyId","signatureBase64"])||
     !KEY_ID.test(evidence.keyId??"")||
     typeof evidence.signatureBase64!=="string"||
     !/^[A-Za-z0-9+/]{86}==$/u.test(evidence.signatureBase64))
    deny("CONSENT_ENVELOPE_INVALID");
  if(!trustedKeys||typeof trustedKeys!=="object"||Array.isArray(trustedKeys)||
     !Object.hasOwn(trustedKeys,evidence.keyId))
    deny("CONSENT_TRUSTED_SIGNER_NOT_CONFIGURED");
  const t=timestamp(now);
  if(!Number.isFinite(t))deny("CONSENT_CLOCK_INVALID");
  const statement=consentStatement(plan,draft,{issuedAt:evidence.statement?.issuedAt});
  if(JSON.stringify(statement)!==JSON.stringify(evidence.statement)||
     t<timestamp(statement.issuedAt)||t>=timestamp(statement.expiresAt))
    deny("CONSENT_SCOPE_OR_EXPIRY_INVALID");
  let key,ok=false;
  try{
    key=createPublicKey(trustedKeys[evidence.keyId]);
    if(key.asymmetricKeyType!=="ed25519")
      deny("CONSENT_SIGNER_KEY_TYPE_INVALID");
    const signed=Buffer.from(JSON.stringify(statement),"utf8");
    const signature=Buffer.from(evidence.signatureBase64,"base64");
    if(signature.length!==64||
       signature.toString("base64")!==evidence.signatureBase64)
      deny("CONSENT_SIGNATURE_ENCODING_INVALID");
    ok=cryptoVerify(null,signed,key,signature);
  }catch(e){
    if(e instanceof ConsentProofError)throw e;
    deny("CONSENT_SIGNATURE_INVALID");
  }
  if(!ok)deny("CONSENT_SIGNATURE_INVALID");
  return Object.freeze({
    schemaVersion:"acs-operator-consent-verification-v1",
    operatorSignatureVerified:true,planSha256:plan.planSha256,
    requestSha256:draft.requestSha256,keyId:evidence.keyId,
    imageTokenMaximumVerified:false,accountPriceVerified:false,
    billableBudgetVerified:false,productionSignerProvisioned:false,
    providerExecutionApproved:false,dispatchEnabled:false
  });
}
export function assertBillableReady(_proof){
  // A test-signed statement MUST NOT elevate itself into production authority.
  deny("CONSENT_BILLABLE_APPROVAL_NOT_IMPLEMENTED");
}
