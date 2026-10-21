/**
 * 03E-04B-02B: durable per-region synthetic attempt state.
 * NOT the real billable attempt ledger and NEVER imports the GLM provider.
 * Root must contain an exact, synthetic-only marker (not in private D: data).
 * The marker and O_EXCL permanent record let Windows crash/parallel tests
 * prove first-write-wins. No reset, retry or network dispatch method exists.
 */
import {constants} from "node:fs";
import {lstat,realpath,mkdir,open,readFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {verifyBatchAuthorizationDraft,BatchAuthorizationError}
  from "./graph-batch-authorization.mjs";
import {reconcileCloudEvidence} from "./graph-batch-reconcile.mjs";
export class SyntheticAttemptError extends Error{
  constructor(code){super(code);this.name="SyntheticAttemptError";this.code=code;}
}
const deny=code=>{throw new SyntheticAttemptError(code);};
const hash=v=>createHash("sha256").update(v).digest("hex");
const MARKER="ACS_SYNTHETIC_CLOUD_ROOT_V1\n";
const ITEM=/^RB-PDF-(?:12|13):page-[0-9]{3}-region-[0-9]{2}$/u;
function fn(id){
  if(typeof id!=="string"||!ITEM.test(id))
    deny("SYNTHETIC_ATTEMPT_ID_INVALID");
  return "simulation-"+id.replace(":","-")+".json";
}
async function safeDir(dir,allowMissing=false){
  try{
    const st=await lstat(dir);
    if(!st.isDirectory()||st.isSymbolicLink()||
       resolve(await realpath(dir)).toLowerCase()!==resolve(dir).toLowerCase())
      deny("SYNTHETIC_ATTEMPT_DIR_UNSAFE");
    return true;
  }catch(e){
    if(allowMissing&&e?.code==="ENOENT")return false;
    if(e instanceof SyntheticAttemptError)throw e;
    deny("SYNTHETIC_ATTEMPT_DIR_MISSING");
  }
}
async function prepare(root,create){
  if(typeof root!=="string"||!root||root.length>1024)
    deny("SYNTHETIC_ATTEMPT_ROOT_INVALID");
  const base=resolve(root);
  await safeDir(base);
  const markerPath=join(base,"ACS_SYNTHETIC_ONLY.marker");
  let stat;
  try{
    stat=await lstat(markerPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==Buffer.byteLength(MARKER))
      deny("SYNTHETIC_ATTEMPT_MARKER_INVALID");
    const h=await open(markerPath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const x=await h.stat();
      if(x.ino!==stat.ino||x.dev!==stat.dev||x.size!==stat.size)
        deny("SYNTHETIC_ATTEMPT_MARKER_INVALID");
      const bytes=await h.readFile();
      if(bytes.toString("utf8")!==MARKER)
        deny("SYNTHETIC_ATTEMPT_MARKER_INVALID");
    }finally{await h.close();}
  }catch(e){
    if(e instanceof SyntheticAttemptError)throw e;
    deny("SYNTHETIC_ATTEMPT_MARKER_INVALID");
  }
  const dir=join(base,"private-synthetic-attempts-04b02b");
  if(create){
    try{await mkdir(dir,{recursive:false,mode:0o700});}
    catch(e){if(e.code!=="EEXIST")deny("SYNTHETIC_ATTEMPT_DIRECTORY_FAILED");}
  }
  if(!await safeDir(dir,!create))return {base,dir:null};
  return {base,dir};
}
function getSelected(plan,draft,id){
  try{verifyBatchAuthorizationDraft(plan,draft);}
  catch(e){if(e instanceof BatchAuthorizationError)deny("SYNTHETIC_ATTEMPT_DRAFT_INVALID");throw e;}
  const item=draft.items.find(x=>x.id===id);
  if(!item||!ITEM.test(id))deny("SYNTHETIC_ATTEMPT_NOT_SELECTED");
  return item;
}
/**
 * Only a crash/duplication rehearsal. No approval verification, charge
 * reservation, provider callback or request handler is present.
 */
export async function claimSyntheticAttempt(root,plan,draft,id){
  const item=getSelected(plan,draft,id);
  const {base,dir}=await prepare(root,true);
  const prior=await reconcileCloudEvidence(base,id);
  if(prior.state!=="NO_PRIOR_PROVIDER_EVIDENCE_NOT_AUTHORIZED")
    deny("SYNTHETIC_ATTEMPT_PRIOR_PROVIDER_EVIDENCE");
  const path=join(dir,fn(id));
  const record={
    schemaVersion:"acs-graph-synthetic-attempt-v1",
    status:"SIMULATED_UNCERTAIN_OUTCOME_NO_NETWORK",
    id,cropSha256:item.cropSha256,planSha256:plan.planSha256,
    requestSha256:draft.requestSha256,
    model:draft.model,providerRequestsIssued:0,
    networkAllowed:false,mayAutoReplay:false,
    billableReceipt:false
  };
  const bytes=Buffer.from(JSON.stringify(record)+"\n","utf8");
  let handle;
  try{
    handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  }catch(e){
    if(e?.code==="EEXIST")
      deny("SYNTHETIC_ATTEMPT_ALREADY_CLAIMED");
    if(e instanceof SyntheticAttemptError)throw e;
    deny("SYNTHETIC_ATTEMPT_WRITE_UNCERTAIN");
  }finally{await handle?.close().catch(()=>{});}
  return {id,status:record.status,claimSha256:hash(bytes),
    providerRequestsIssued:0,networkAllowed:false,mayAutoReplay:false};
}
export async function inspectSyntheticAttempt(root,plan,draft,id){
  const item=getSelected(plan,draft,id);
  const {dir}=await prepare(root,false);
  if(!dir)return {status:"NOT_CLAIMED",mayAutoReplay:false};
  let handle;
  try{
    const path=join(dir,fn(id));
    const st=await lstat(path);
    if(!st.isFile()||st.isSymbolicLink()||st.size<90||st.size>4096)
      deny("SYNTHETIC_ATTEMPT_FILE_UNSAFE");
    handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const checked=await handle.stat();
    if(!checked.isFile()||checked.ino!==st.ino||
       checked.dev!==st.dev||checked.size!==st.size)
      deny("SYNTHETIC_ATTEMPT_READ_RACE");
    const bytes=await handle.readFile();
    const final=await handle.stat();
    if(final.size!==st.size||final.mtimeMs!==st.mtimeMs)
      deny("SYNTHETIC_ATTEMPT_READ_RACE");
    let data;
    try{data=JSON.parse(bytes.toString("utf8"));}
    catch{deny("SYNTHETIC_ATTEMPT_CORRUPT");}
    if(!data||data.schemaVersion!=="acs-graph-synthetic-attempt-v1"||
       data.status!=="SIMULATED_UNCERTAIN_OUTCOME_NO_NETWORK"||
       data.id!==id||data.cropSha256!==item.cropSha256||
       data.planSha256!==plan.planSha256||
       data.requestSha256!==draft.requestSha256||data.model!==draft.model||
       data.providerRequestsIssued!==0||data.networkAllowed!==false||
       data.mayAutoReplay!==false||data.billableReceipt!==false)
      deny("SYNTHETIC_ATTEMPT_TAMPERED");
    return {id,status:data.status,claimSha256:hash(bytes),
      networkAllowed:false,mayAutoReplay:false};
  }catch(e){
    if(e?.code==="ENOENT")return {status:"NOT_CLAIMED",mayAutoReplay:false};
    if(e instanceof SyntheticAttemptError)throw e;
    deny("SYNTHETIC_ATTEMPT_READ_FAILED");
  }finally{await handle?.close();}
}
