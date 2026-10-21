/**
 * 03E-04B-01: persistent OFFLINE preparation marks, never billable attempts.
 * No provider imports, no request method, no way to elevate this record.
 * Deliberately fail-closed on crash/duplicate claim: manual investigation only.
 */
import {constants} from "node:fs";
import {mkdir,lstat,realpath,open} from "node:fs/promises";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {verifyBatchAuthorizationDraft,BatchAuthorizationError} from "./graph-batch-authorization.mjs";

export class BatchLedgerError extends Error {
  constructor(code){super(code);this.name="BatchLedgerError";this.code=code;}
}
const reject=code=>{throw new BatchLedgerError(code);};
const sha=v=>createHash("sha256").update(v).digest("hex");
const verifiedTime=now=>{
  if(typeof now!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(now)||
     !Number.isFinite(Date.parse(now))||new Date(now).toISOString()!==now)
    reject("BATCH_LEDGER_TIME_INVALID");
  return Date.parse(now);
};
async function verifiedDir(path,allowMissing=false){
  try{
    const st=await lstat(path);
    if(!st.isDirectory()||st.isSymbolicLink()||
       resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())
      reject("BATCH_LEDGER_DIR_UNSAFE");
    return true;
  }catch(e){
    if(allowMissing&&e.code==="ENOENT")return false;
    if(e instanceof BatchLedgerError)throw e;
    reject("BATCH_LEDGER_DIR_NOT_READY");
  }
}
async function directory(root,create){
  if(typeof root!=="string"||!root||root.length>1024)reject("BATCH_LEDGER_ROOT_INVALID");
  const base=resolve(root);
  await verifiedDir(base);
  const dst=join(base,"private-cloud-batch-offline-v1");
  if(create){
    try{await mkdir(dst,{recursive:false,mode:0o700});}
    catch(e){if(e?.code!=="EEXIST")reject("BATCH_LEDGER_DIR_NOT_READY");}
  }
  if(!await verifiedDir(dst,!create))return null;
  return dst;
}
function nameFor(draft,id){
  const item=draft.items.find(x=>x.id===id);
  if(!item)reject("BATCH_LEDGER_ITEM_NOT_SELECTED");
  // Windows-safe, no colon, no user paths; exact SHA ties the whole request.
  return {name:"offline-"+draft.requestSha256+"-"+id.replace(":","-")+".json",item};
}
export async function reserveOfflineReviewItem(root,plan,draft,id,{now}={}){
  try{verifyBatchAuthorizationDraft(plan,draft);}
  catch(e){
    if(e instanceof BatchAuthorizationError)reject("BATCH_LEDGER_DRAFT_INVALID");
    throw e;
  }
  const epoch=verifiedTime(now);
  const expiry=Date.parse(draft.expiresAt);
  if(expiry<=epoch||expiry>epoch+7*24*60*60*1000)
    reject("BATCH_LEDGER_DRAFT_EXPIRED_OR_TOO_LONG");
  const {name,item}=nameFor(draft,id);
  const dir=await directory(root,true),dest=join(dir,name);
  const body={
    schemaVersion:"acs-offline-graph-batch-reservation-v1",
    status:"OFFLINE_PREPARED_NOT_DISPATCHED",
    planSha256:plan.planSha256,requestSha256:draft.requestSha256,
    id,cropSha256:item.cropSha256,preparedAt:now,
    providerRequestsIssued:0,dispatchEnabled:false,
    needsRealPriceAndSeparateApproval:true
  };
  const bytes=Buffer.from(JSON.stringify(body)+"\n","utf8");
  let handle;
  try{
    handle=await open(dest,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
    await handle.writeFile(bytes);await handle.sync();
  }catch(e){
    if(e?.code==="EEXIST")reject("BATCH_LEDGER_ITEM_ALREADY_RESERVED");
    reject("BATCH_LEDGER_RESERVATION_UNCERTAIN");
  }finally{await handle?.close().catch(()=>{});}
  return {status:body.status,providerRequestsIssued:0,dispatchEnabled:false,
    reservationSha256:sha(bytes),id};
}
export async function inspectOfflineReviewItem(root,plan,draft,id){
  try{verifyBatchAuthorizationDraft(plan,draft);}
  catch{reject("BATCH_LEDGER_DRAFT_INVALID");}
  const {name,item}=nameFor(draft,id);
  const dir=await directory(root,false);
  if(!dir)return {status:"NOT_PREPARED"};
  const path=join(dir,name);
  let fd;
  try{
    const st=await lstat(path);
    if(!st.isFile()||st.isSymbolicLink()||st.size<80||st.size>4000)
      reject("BATCH_LEDGER_RESERVATION_UNSAFE");
    fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const st2=await fd.stat();
    if(!st2.isFile()||st2.ino!==st.ino||st2.dev!==st.dev||st2.size!==st.size)
      reject("BATCH_LEDGER_RACE");
    const bytes=Buffer.alloc(st.size);let n=0;
    while(n<bytes.length){
      const got=await fd.read(bytes,n,bytes.length-n,n);
      if(!got.bytesRead)reject("BATCH_LEDGER_TRUNCATED");
      n+=got.bytesRead;
    }
    const check=await fd.stat();
    if(check.size!==st.size||check.mtimeMs!==st.mtimeMs)reject("BATCH_LEDGER_RACE");
    let doc;
    try{doc=JSON.parse(bytes.toString("utf8"));}
    catch{reject("BATCH_LEDGER_CORRUPT");}
    if(!doc||doc.schemaVersion!=="acs-offline-graph-batch-reservation-v1"||
       doc.status!=="OFFLINE_PREPARED_NOT_DISPATCHED"||
       doc.planSha256!==plan.planSha256||doc.requestSha256!==draft.requestSha256||
       doc.id!==id||doc.cropSha256!==item.cropSha256||
       doc.providerRequestsIssued!==0||doc.dispatchEnabled!==false||
       doc.needsRealPriceAndSeparateApproval!==true||
       typeof doc.preparedAt!=="string")
      reject("BATCH_LEDGER_CORRUPT");
    verifiedTime(doc.preparedAt);
    return {status:doc.status,id,reservationSha256:sha(bytes),
      providerRequestsIssued:0,dispatchEnabled:false};
  }catch(e){
    if(e?.code==="ENOENT")return {status:"NOT_PREPARED"};
    if(e instanceof BatchLedgerError)throw e;
    reject("BATCH_LEDGER_READ_FAILED");
  }finally{await fd?.close();}
}
