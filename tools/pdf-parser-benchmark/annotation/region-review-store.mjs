/**
 * 03E-03 internal, offline store for VERIFIED-SOURCE graph proposals only.
 * Source view is constructed by validateRegionGraphCandidate in trusted code;
 * NEVER accept it from an HTTP body. Not exposed by the P127 API yet.
 * Per-book/per-region/per-result SHA isolation, no silent stale-lock recovery.
 */
import {constants} from "node:fs";
import {open,lstat,realpath,mkdir,rename,unlink} from "node:fs/promises";
import {randomBytes,createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {regionReviewDraftFilename,parseRegionReviewDraft} from "./region-graph-review.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const limit=100_000;
export class RegionStoreError extends Error{
  constructor(code){super(code);this.name="RegionStoreError";this.code=code;}
}
const block=code=>{throw new RegionStoreError(code);};
async function safeDirectory(path,{create=false}={}){
  if(create){
    try{await mkdir(path,{recursive:false,mode:0o700});}
    catch(e){if(e?.code!=="EEXIST")block("REGION_STORE_DIRECTORY_NOT_READY");}
  }
  try{
    const st=await lstat(path);
    if(!st.isDirectory()||st.isSymbolicLink()||
       resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())
      block("REGION_STORE_DIRECTORY_UNSAFE");
    return true;
  }catch(e){
    if(!create&&e?.code==="ENOENT")return false;
    if(e instanceof RegionStoreError)throw e;
    block("REGION_STORE_DIRECTORY_NOT_READY");
  }
}
async function directory(root,create){
  if(typeof root!=="string"||!root)block("REGION_STORE_ROOT_INVALID");
  const base=resolve(root);
  if(!await safeDirectory(base))block("REGION_STORE_ROOT_NOT_READY");
  const dir=join(base,"private-region-reviews-v1");
  if(!await safeDirectory(dir,{create}))return null;
  return dir;
}
async function boundedRead(dir,name){
  const path=join(dir,name);
  let st;
  try{
    st=await lstat(path);
    if(!st.isFile()||st.isSymbolicLink()||
       resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())
      block("REGION_STORE_FILE_UNSAFE");
  }catch(e){
    if(e?.code==="ENOENT")return null;
    if(e instanceof RegionStoreError)throw e;
    block("REGION_STORE_FILE_UNAVAILABLE");
  }
  if(st.size<8||st.size>limit)block("REGION_STORE_SIZE_INVALID");
  let fd;
  try{
    fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const fs=await fd.stat();
    if(!fs.isFile()||fs.size!==st.size||fs.ino!==st.ino||fs.dev!==st.dev)
      block("REGION_STORE_FILE_RACE");
    const bytes=Buffer.allocUnsafe(st.size);
    let count=0;
    while(count<bytes.length){
      const r=await fd.read(bytes,count,bytes.length-count,count);
      if(r.bytesRead<=0)block("REGION_STORE_FILE_TRUNCATED");
      count+=r.bytesRead;
    }
    const after=await fd.stat();
    if(after.size!==st.size||after.mtimeMs!==st.mtimeMs)
      block("REGION_STORE_FILE_RACE");
    return bytes;
  }catch(e){
    if(e instanceof RegionStoreError)throw e;
    block("REGION_STORE_READ_FAILED");
  }finally{await fd?.close();}
}
function verifiedDraft(bytes,view){
  try{
    const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    return parseRegionReviewDraft(value,view);
  }catch{block("REGION_STORE_DRAFT_INVALID");}
}
export async function readRegionReviewDraft(root,view){
  const name=regionReviewDraftFilename(view);
  const dir=await directory(root,false);
  if(!dir)return {draft:null,revision:null};
  const bytes=await boundedRead(dir,name);
  if(!bytes)return {draft:null,revision:null};
  return {draft:verifiedDraft(bytes,view),revision:sha(bytes)};
}
/**
 * True multi-process CAS: O_EXCL lock guarantees one writer per result digest.
 * A crash leaves the lock to block writes; NEVER silently delete a stale lock.
 */
export async function saveRegionReviewDraft(root,view,input,expectedRevision){
  let checked;
  try{checked=parseRegionReviewDraft(input,view);}
  catch{block("REGION_STORE_DRAFT_INVALID");}
  if(expectedRevision!==null&&
     !(typeof expectedRevision==="string"&&/^[0-9a-f]{64}$/u.test(expectedRevision)))
    block("REGION_STORE_REVISION_INVALID");
  const bytes=Buffer.from(JSON.stringify(checked,null,2)+"\n","utf8");
  if(bytes.length<8||bytes.length>limit)block("REGION_STORE_SIZE_INVALID");
  const dir=await directory(root,true),filename=regionReviewDraftFilename(view);
  const target=join(dir,filename),lock=target+".lock";
  let locker=null,lockStat=null,tmp=null,fd=null;
  try{
    try{
      locker=await open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      lockStat=await locker.stat();
    }catch(e){
      if(e?.code==="EEXIST")block("REGION_STORE_LOCKED");
      block("REGION_STORE_LOCK_FAILED");
    }
    const current=await readRegionReviewDraft(root,view);
    if(current.revision!==expectedRevision)block("REGION_STORE_REVISION_CONFLICT");
    tmp=join(dir,".region-review-"+randomBytes(16).toString("hex")+".tmp");
    fd=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    await fd.writeFile(bytes);await fd.sync();await fd.close();fd=null;
    await boundedRead(dir,filename); // detect links/invalid existing final before overwrite
    await rename(tmp,target);tmp=null;
    return {revision:sha(bytes),status:"REVIEW_DRAFT_UNATTESTED",
      graphVerified:false,humanVerified:false};
  }catch(e){
    if(e instanceof RegionStoreError)throw e;
    block("REGION_STORE_WRITE_FAILED");
  }finally{
    await fd?.close().catch(()=>{});
    if(tmp)await unlink(tmp).catch(()=>{});
    await locker?.close().catch(()=>{});
    if(lockStat){
      try{
        const st=await lstat(lock);
        if(st.isFile()&&!st.isSymbolicLink()&&
           st.ino===lockStat.ino&&st.dev===lockStat.dev)await unlink(lock);
      }catch{}
    }
  }
}
