/**
 * Opt-in P127 private evidence bridge. No directory browsing, no arbitrary
 * filenames, no models/OCR, no private records in logs. This is strictly scoped
 * to one previously generated r02 result. The ordinary annotator never uses it.
 */
import { constants } from "node:fs";
import { lstat, realpath, open, mkdir, rename, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  validateGraphReviewSource, parseGraphReviewDraft,
  MAX_CROP_BYTES, MAX_MANIFEST_BYTES, MAX_RESULT_BYTES, MAX_REVIEW_BYTES,
} from "./graph-review.mjs";

const SOURCE = "real-mineru-39440805765-1";
export const PRIVATE_FILENAMES = Object.freeze({
  result:"glm-cloud-v1-RB-PDF-13-page-002-region-01-retry-p127-r02-20261021/cloud-vision-proposals.json",
  manifest:"region-proposals-v1-RB-PDF-13/region-proposals.json",
  crop:"region-proposals-v1-RB-PDF-13/crops/page-002-region-01.png",
  draft:"private-reviews/P127-graph-review-r02-DRAFT-UNATTESTED.json",
});
const sha = value => createHash("sha256").update(value).digest("hex");
const decoder = new TextDecoder("utf-8",{fatal:true});
const PNG_MAGIC = Buffer.from([137,80,78,71,13,10,26,10]);
export class PrivateGraphError extends Error {
  constructor(code) { super(code); this.name="PrivateGraphError"; this.code=code; }
}
const fail=code=>{throw new PrivateGraphError(code);};
function scoped(root, relative) {
  if(typeof root!=="string"||!root||typeof relative!=="string"||
      relative.split("/").some(p=>!p||p==="."||p===".."||p.includes("\\"))) fail("PRIVATE_PATH_INVALID");
  const base=resolve(root), full=resolve(base,...relative.split("/"));
  if(!full.startsWith(base+sep))fail("PRIVATE_PATH_INVALID");
  return full;
}
async function verifyPath(root,relative,{missing=false}={}) {
  const base=resolve(root);
  // Reject a linked base and every linked component, including NTFS junctions
  // that Node reports as symbolic links. No path is supplied by HTTP clients.
  for(const p of [base,...relative.split("/").slice(0,-1).map((_,i)=>
    resolve(base,...relative.split("/").slice(0,i+1)))]) {
    try {
      const st=await lstat(p);
      if(!st.isDirectory()||st.isSymbolicLink())fail("PRIVATE_DIRECTORY_UNSAFE");
      const canonical=await realpath(p);
      if(resolve(canonical).toLowerCase()!==resolve(p).toLowerCase())fail("PRIVATE_DIRECTORY_UNSAFE");
    }catch(e){
      if(missing&&e?.code==="ENOENT")return null;
      if(e instanceof PrivateGraphError)throw e;
      fail("PRIVATE_DIRECTORY_NOT_READY");
    }
  }
  const filename=scoped(root,relative);
  try{
    const st=await lstat(filename);
    if(!st.isFile()||st.isSymbolicLink())fail("PRIVATE_EVIDENCE_UNSAFE");
    if(resolve(await realpath(filename)).toLowerCase()!==filename.toLowerCase())fail("PRIVATE_EVIDENCE_UNSAFE");
    return st;
  }catch(e){
    if(missing&&e?.code==="ENOENT")return null;
    if(e instanceof PrivateGraphError)throw e;
    fail("PRIVATE_EVIDENCE_NOT_READY");
  }
}
async function readBounded(root,rel,max,{missing=false}={}){
  const st=await verifyPath(root,rel,{missing});
  if(st===null)return null;
  if(st.size<8||st.size>max)fail("PRIVATE_EVIDENCE_SIZE_INVALID");
  let handle;
  try{
    handle=await open(scoped(root,rel),constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const fdStat=await handle.stat();
    if(!fdStat.isFile()||fdStat.size!==st.size||fdStat.dev!==st.dev||fdStat.ino!==st.ino)fail("PRIVATE_EVIDENCE_RACE");
    const bytes=Buffer.allocUnsafe(st.size);
    let pos=0;
    while(pos<bytes.length){
      const x=await handle.read(bytes,pos,bytes.length-pos,pos);
      if(x.bytesRead===0)fail("PRIVATE_EVIDENCE_TRUNCATED");
      pos+=x.bytesRead;
    }
    const after=await handle.stat();
    if(after.size!==st.size||after.mtimeMs!==st.mtimeMs)fail("PRIVATE_EVIDENCE_RACE");
    return bytes;
  }catch(e){
    if(e instanceof PrivateGraphError)throw e;
    fail("PRIVATE_EVIDENCE_READ_BLOCKED");
  }finally{await handle?.close();}
}
function json(bytes){
  try{return JSON.parse(decoder.decode(bytes));}
  catch{fail("PRIVATE_EVIDENCE_JSON_INVALID");}
}
function dimensions(bytes){
  if(bytes.length<33||!bytes.subarray(0,8).equals(PNG_MAGIC)||
      bytes.toString("ascii",12,16)!=="IHDR"||bytes.readUInt32BE(8)!==13)fail("PRIVATE_CROP_PNG_INVALID");
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<20||height<20||width>12000||height>12000||width*height>18_000_000)fail("PRIVATE_CROP_DIMENSIONS_INVALID");
  return {cropWidth:width,cropHeight:height};
}
export async function readPrivateP127Bundle(root){
  const [rb,mb,cb]=await Promise.all([
    readBounded(root,PRIVATE_FILENAMES.result,MAX_RESULT_BYTES),
    readBounded(root,PRIVATE_FILENAMES.manifest,MAX_MANIFEST_BYTES),
    readBounded(root,PRIVATE_FILENAMES.crop,MAX_CROP_BYTES),
  ]);
  const identity={resultSha256:sha(rb),manifestSha256:sha(mb),cropSha256:sha(cb),...dimensions(cb)};
  let view;
  try{view=validateGraphReviewSource(json(rb),json(mb),identity);}
  catch{fail("PRIVATE_GRAPH_PROVENANCE_INVALID");}
  // Encode only the exact three verified P127 files, not directory contents.
  return {source:SOURCE,identity,view,
    data:{resultBase64:rb.toString("base64"),manifestBase64:mb.toString("base64"),
      cropBase64:cb.toString("base64")},
    authority:"PROPOSED_UNVERIFIED",humanVerified:false};
}
export async function readPrivateP127Draft(root,view){
  const existing=await readBounded(root,PRIVATE_FILENAMES.draft,MAX_REVIEW_BYTES,{missing:true});
  if(!existing)return {draft:null,revision:null};
  let draft;
  try{draft=parseGraphReviewDraft(json(existing),view);}
  catch{fail("PRIVATE_DRAFT_STALE_OR_INVALID");}
  return {draft,revision:sha(existing)};
}
export async function writePrivateP127Draft(root,view,raw,expectedRevision){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))fail("PRIVATE_DRAFT_INVALID");
  let checked;
  try{checked=parseGraphReviewDraft(raw,view);}
  catch{fail("PRIVATE_DRAFT_STALE_OR_INVALID");}
  if(expectedRevision!==null&&!(typeof expectedRevision==="string"&&/^[0-9a-f]{64}$/u.test(expectedRevision)))
    fail("PRIVATE_DRAFT_REVISION_INVALID");
  const text=JSON.stringify(checked,null,2)+"\n";
  const bytes=Buffer.from(text,"utf8");
  if(bytes.length<8||bytes.length>MAX_REVIEW_BYTES)fail("PRIVATE_DRAFT_OVERSIZE");
  const current=await readPrivateP127Draft(root,view);
  if(current.revision!==expectedRevision)fail("PRIVATE_DRAFT_CONFLICT");
  const directory=scoped(root,"private-reviews");
  try{await mkdir(directory,{recursive:false,mode:0o700});}
  catch(e){if(e?.code!=="EEXIST")fail("PRIVATE_DRAFT_DIRECTORY_FAILED");}
  // After creation, fail closed on symbolic-link replacement.
  await verifyPath(root,"private-reviews/"+PRIVATE_FILENAMES.draft.split("/").at(-1),{missing:true});
  const target=scoped(root,PRIVATE_FILENAMES.draft);
  const temp=join(directory,".p127-graph-"+randomBytes(12).toString("hex")+".tmp");
  let fd;
  try{
    fd=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    await fd.writeFile(bytes);await fd.sync();await fd.close();fd=null;
    // Protect the final path immediately prior to a single atomic rename.
    await verifyPath(root,PRIVATE_FILENAMES.draft,{missing:true});
    await rename(temp,target);
    return {revision:sha(bytes),status:"REVIEW_DRAFT_UNATTESTED",humanVerified:false};
  }catch(e){
    if(e instanceof PrivateGraphError)throw e;
    fail("PRIVATE_DRAFT_WRITE_FAILED");
  }finally{await fd?.close();await rm(temp,{force:true}).catch(()=>{});}
}
