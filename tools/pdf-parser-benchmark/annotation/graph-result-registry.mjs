/**
 * 03E-03B: code-authorized graph-result registry.
 * A crop is NOT reviewable because it exists. Exactly one registered result
 * backed by real source SHA and validated geometry grants REVIEW_DRAFT access.
 * No discovery of result directories, auto-authorization or paid API calls.
 *
 * Existing P127 uses the legacy reviewer/draft exclusively, so a second
 * region draft can never shadow it.
 */
const HASH=/^[0-9a-f]{64}$/u;
const FIXTURE=/^RB-PDF-(12|13)$/u;
const REGION=/^page-([0-9]{3})-region-([0-9]{2})$/u;
const ATTEMPT=/^[A-Z][A-Z0-9_]{6,72}$/u;
const MODEL="glm-5.3-flash";
const SOURCE="real-mineru-39440805765-1";
const LEGACY_RESULT="glm-cloud-v1-RB-PDF-13-page-002-region-01-retry-p127-r02-20261021/cloud-vision-proposals.json";
const LEGACY_ID="RB-PDF-13:page-002-region-01";
export class RegistryError extends Error {
  constructor(code){super(code);this.code=code;this.name="RegistryError";}
}
const reject=code=>{throw new RegistryError(code);};
function safeRelative(value){
  return typeof value==="string"&&value.length<220&&!value.includes("\\")&&
    value.split("/").every(part=>part.length>0&&part!=="."&&part!==".."&&
      /^[A-Za-z0-9._-]+$/u.test(part));
}
function validateOne(raw){
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||
     typeof raw.id!=="string"||raw.id.length>70||
     !FIXTURE.test(raw.fixtureId??"")||
     !REGION.test(raw.regionId??"")||
     raw.id!==raw.fixtureId+":"+raw.regionId||
     !Number.isSafeInteger(raw.physicalPage)||raw.physicalPage<1||raw.physicalPage>5000||
     raw.sourceRun!==SOURCE||raw.model!==MODEL||
     raw.provider!=="ZHIPU_GLMCLOUD_STANDARD_API"||
     !ATTEMPT.test(raw.attemptClass??"")||
     !safeRelative(raw.resultPath)||!["LEGACY_P127","REGISTERED_REGION"].includes(raw.kind))
    reject("GRAPH_REGISTRY_ENTRY_INVALID");
  const manifestPath="region-proposals-v1-"+raw.fixtureId+"/region-proposals.json";
  const cropPath="region-proposals-v1-"+raw.fixtureId+"/crops/"+raw.regionId+".png";
  if(raw.manifestPath!==manifestPath||raw.cropPath!==cropPath)
    reject("GRAPH_REGISTRY_SOURCE_PATH_INVALID");
  if(raw.kind==="LEGACY_P127"){
    if(raw.id!==LEGACY_ID||raw.physicalPage!==127||
       raw.resultPath!==LEGACY_RESULT||
       raw.attemptClass!=="EXPLICIT_P127_SECOND_ATTEMPT"||
       raw.resultSha256!==null||raw.cropSha256!==null||raw.manifestSha256!==null)
      reject("GRAPH_REGISTRY_LEGACY_PIN_INVALID");
  }else{
    if(raw.id===LEGACY_ID||!raw.resultPath.startsWith(
         "glm-cloud-v1-"+raw.fixtureId+"-"+raw.regionId+"-")||
       !raw.resultPath.endsWith("/cloud-vision-proposals.json")||
       ![raw.resultSha256,raw.cropSha256,raw.manifestSha256].every(
         x=>typeof x==="string"&&HASH.test(x)))
      reject("GRAPH_REGISTRY_EXACT_SHA_REQUIRED");
  }
  return Object.freeze({
    id:raw.id,fixtureId:raw.fixtureId,regionId:raw.regionId,
    physicalPage:raw.physicalPage,kind:raw.kind,sourceRun:raw.sourceRun,
    provider:raw.provider,model:raw.model,attemptClass:raw.attemptClass,
    resultPath:raw.resultPath,manifestPath,cropPath,
    resultSha256:raw.resultSha256,cropSha256:raw.cropSha256,
    manifestSha256:raw.manifestSha256
  });
}
export function compileTrustedGraphRegistry(entries){
  if(!Array.isArray(entries)||entries.length>32)
    reject("GRAPH_REGISTRY_SIZE_INVALID");
  const ids=new Set(),out=[];
  for(const candidate of entries){
    const item=validateOne(candidate);
    if(ids.has(item.id))reject("GRAPH_REGISTRY_DUPLICATE_ID");
    ids.add(item.id);out.push(item);
  }
  return Object.freeze(out.sort((a,b)=>a.id.localeCompare(b.id)));
}
const legacyEntry={
  id:LEGACY_ID,fixtureId:"RB-PDF-13",regionId:"page-002-region-01",
  physicalPage:127,kind:"LEGACY_P127",sourceRun:SOURCE,
  provider:"ZHIPU_GLMCLOUD_STANDARD_API",model:MODEL,
  attemptClass:"EXPLICIT_P127_SECOND_ATTEMPT",
  resultPath:LEGACY_RESULT,
  manifestPath:"region-proposals-v1-RB-PDF-13/region-proposals.json",
  cropPath:"region-proposals-v1-RB-PDF-13/crops/page-002-region-01.png",
  resultSha256:null,manifestSha256:null,cropSha256:null
};
// Adding a new entry MUST be an intentional reviewed code change and requires
// exact actual result, manifest and crop SHA. No public/write API can do it.
export const TRUSTED_GRAPH_RESULTS=compileTrustedGraphRegistry([legacyEntry]);
export function lookupTrustedGraphResult(id,registry=TRUSTED_GRAPH_RESULTS){
  if(typeof id!=="string"||id.length>70||!/^(RB-PDF-(?:12|13)):(page-[0-9]{3}-region-[0-9]{2})$/u.test(id))
    reject("GRAPH_REGISTRY_ID_INVALID");
  // Defense in depth: never accept unvalidated caller-owned entries.
  const validated=compileTrustedGraphRegistry(registry);
  return validated.find(item=>item.id===id)??null;
}
export function publicRegisteredGraphMetadata(registry=TRUSTED_GRAPH_RESULTS){
  const verified=compileTrustedGraphRegistry(registry);
  return {schemaVersion:"acs-trusted-graph-registration-v1",
    authority:"REGISTERED_SOURCE_ONLY_NOT_GROUND_TRUTH",
    entries:verified.map(item=>({
      id:item.id,fixtureId:item.fixtureId,
      regionId:item.regionId,sourcePhysicalPage1Based:item.physicalPage,
      reviewKind:item.kind,graphVerified:false,humanVerified:false
    }))};
}
