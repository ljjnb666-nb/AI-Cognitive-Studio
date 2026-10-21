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
import {lookupTrustedGraphResult,TRUSTED_GRAPH_RESULTS,RegistryError} from "./graph-result-registry.mjs";
import {validateRegionGraphCandidate,RegionReviewError} from "./region-graph-review.mjs";
import {readRegionReviewDraft,saveRegionReviewDraft,RegionStoreError} from "./region-review-store.mjs";
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

/**
 * 03E-01: bounded, deterministic inventory of ALREADY generated region crops.
 * The only source directories are two hard-coded figure manifests. This does
 * NOT enumerate arbitrary private directories, infer graphs, or call a model.
 * Only the audited P127 r02 has a currently supported review detail view.
 */
const QUEUE_FIXTURES = Object.freeze(["RB-PDF-12","RB-PDF-13"]);
const QUEUE_SCHEMA = "acs-private-graph-review-queue-v1";
const REGION_ID = /^page-([0-9]{3})-region-([0-9]{2})$/u;
const MAX_QUEUE_ITEMS = 32;
function boundedManifest(doc,fixture){
  if (!doc || typeof doc!=="object" || Array.isArray(doc) ||
      doc.schemaVersion!=="acs-pdf-private-region-evidence-v1" ||
      doc.sourceRun!==SOURCE || doc.fixtureId!==fixture ||
      doc.allRegionsAreUnverified!==true || doc.noSemanticGraphClaims!==true ||
      !Array.isArray(doc.pages) || doc.pages.length>3) fail("PRIVATE_QUEUE_MANIFEST_INVALID");
  const items=[], seen=new Set(), pageNumbers=new Set();
  for(const page of doc.pages){
    if(!page||typeof page!=="object"||Array.isArray(page)||
        !Number.isSafeInteger(page.sourcePhysicalPage1Based) ||
        page.sourcePhysicalPage1Based<1 || page.sourcePhysicalPage1Based>5000 ||
        !Number.isSafeInteger(page.subsetPageIndex) || page.subsetPageIndex<0 ||
        page.subsetPageIndex>2 || pageNumbers.has(page.subsetPageIndex) ||
        !Array.isArray(page.regions)||page.regions.length>4) fail("PRIVATE_QUEUE_PAGE_INVALID");
    pageNumbers.add(page.subsetPageIndex);
    for(const region of page.regions){
      if(!region || typeof region!=="object" || Array.isArray(region) ||
          typeof region.regionId!=="string" ||
          !REGION_ID.test(region.regionId) ||
          region.regionId!==`page-${String(page.subsetPageIndex+1).padStart(3,"0")}-region-${String(page.regions.indexOf(region)+1).padStart(2,"0")}` ||
          seen.has(region.regionId) ||
          region.proposalStatus!=="UNVERIFIED_REGION_SUGGESTION" ||
          region.nodes != null || region.directedEdges != null ||
          region.timingRelations != null ||
          typeof region.cropSha256!=="string" ||
          !/^[0-9a-f]{64}$/u.test(region.cropSha256) ||
          !Array.isArray(region.bboxPixels) ||
          region.bboxPixels.length!==4 ||
          !region.bboxPixels.every(x=>Number.isSafeInteger(x)) ||
          region.bboxPixels[0]<0||region.bboxPixels[1]<0||
          region.bboxPixels[2]<20||region.bboxPixels[3]<20) fail("PRIVATE_QUEUE_REGION_INVALID");
      seen.add(region.regionId);
      items.push({fixtureId:fixture,sourcePhysicalPage1Based:page.sourcePhysicalPage1Based,
        regionId:region.regionId,cropSha256:region.cropSha256,
        width:region.bboxPixels[2],height:region.bboxPixels[3]});
      if(items.length>MAX_QUEUE_ITEMS)fail("PRIVATE_QUEUE_CAP_EXCEEDED");
    }
  }
  return items;
}
export async function listPrivateGraphReviewQueue(root,registrations=TRUSTED_GRAPH_RESULTS){
  const discovered=[];
  for(const fixture of QUEUE_FIXTURES){
    const rel=`region-proposals-v1-${fixture}/region-proposals.json`;
    const contents=await readBounded(root,rel,MAX_MANIFEST_BYTES,{missing:true});
    if(!contents)continue;
    const entries=boundedManifest(json(contents),fixture);
    for(const entry of entries){
      const cropRelative=`region-proposals-v1-${fixture}/crops/${entry.regionId}.png`;
      // Do not read or emit private pixels, labels, model responses or paths.
      let bytes=null;
      // One bad/unsafe crop is a blocked queue item, not a reason to conceal
      // all other verified regions. A forged manifest itself fails globally.
      try{bytes=await readBounded(root,cropRelative,MAX_CROP_BYTES,{missing:true});}
      catch(e){if(!(e instanceof PrivateGraphError))throw e;}
      let evidenceStatus="CROP_MISSING_OR_BLOCKED";
      if(bytes){
        let size;
        try{size=dimensions(bytes);}catch{/* isolate the single crop */}
        if(sha(bytes)===entry.cropSha256 &&
            size?.cropWidth===entry.width && size?.cropHeight===entry.height){
          evidenceStatus="CROP_READY_NO_GRAPH";
        }
      }
      discovered.push({id:fixture+":"+entry.regionId,
        fixtureId:fixture,sourcePhysicalPage1Based:entry.sourcePhysicalPage1Based,
        regionId:entry.regionId,evidenceStatus,reviewable:false,
        graphVerified:false,humanVerified:false});
      if(discovered.length>MAX_QUEUE_ITEMS)fail("PRIVATE_QUEUE_CAP_EXCEEDED");
    }
  }
  // The single known model result is checked by the same contract as manual
  // import; a corrupt/missing graph cannot turn into a 'ready to review' item.
  for(const entry of discovered){
    // Crop-only evidence is never upgraded by a filename or model claim.
    // A source can become reviewable only through a reviewed code registry.
    let reg;
    try{reg=lookupTrustedGraphResult(entry.id,registrations);}
    catch{fail("PRIVATE_REGISTERED_ID_INVALID");}
    if(!reg || entry.evidenceStatus!=="CROP_READY_NO_GRAPH")continue;
    try{
      const bundle=await readRegisteredGraphBundle(root,entry.id,registrations);
      if(bundle.identity.cropSha256!==(
        // The queue already verified this exact crop's SHA.
        (await readPrivateGraphCropPreview(root,entry.id)).cropSha256
      ))fail("PRIVATE_REGISTERED_QUEUE_CROP_CHANGED");
      entry.evidenceStatus="GRAPH_READY_FOR_HUMAN_REVIEW";
      entry.reviewable=true;
      entry.reviewKind=bundle.reviewKind;
      entry.nodeCount=bundle.view.nodes.length;
      entry.edgeCount=bundle.view.edges.length;
      entry.reviewedCount=bundle.saved.draft?.decisions
        .filter(x=>x.decision!=="UNREVIEWED").length??0;
    }catch{
      entry.evidenceStatus="GRAPH_EVIDENCE_BLOCKED";
    }
  }
  discovered.sort((a,b)=>
    a.fixtureId.localeCompare(b.fixtureId) ||
    a.sourcePhysicalPage1Based-b.sourcePhysicalPage1Based ||
    a.regionId.localeCompare(b.regionId));
  return {schemaVersion:QUEUE_SCHEMA,authority:"DISCOVERY_ONLY_NOT_GROUND_TRUTH",
    items:discovered,counts:{
      total:discovered.length,
      ready:discovered.filter(x=>x.reviewable).length,
      cropOnly:discovered.filter(x=>x.evidenceStatus==="CROP_READY_NO_GRAPH").length,
      blocked:discovered.filter(x=>x.evidenceStatus==="CROP_MISSING_OR_BLOCKED"||
        x.evidenceStatus==="GRAPH_EVIDENCE_BLOCKED").length
    }};
}

/**
 * 03E-02: on-demand preview of exactly one previously inventoried crop.
 * The client submits ONLY a canonical fixture:region ID, never a path.
 * No directory scans, no inference, no review-state changes.
 */
const CROP_ID = /^(RB-PDF-(?:12|13)):(page-[0-9]{3}-region-[0-9]{2})$/u;
export async function readPrivateGraphCropPreview(root, itemId){
  if(typeof itemId!=="string" || itemId.length>48) fail("PRIVATE_PREVIEW_ID_INVALID");
  const match=CROP_ID.exec(itemId);
  if(!match) fail("PRIVATE_PREVIEW_ID_INVALID");
  const [,fixture,regionId]=match;
  const manifestPath=`region-proposals-v1-${fixture}/region-proposals.json`;
  const manifestBytes=await readBounded(root,manifestPath,MAX_MANIFEST_BYTES);
  const entries=boundedManifest(json(manifestBytes),fixture);
  const region=entries.find(e=>e.regionId===regionId);
  if(!region) fail("PRIVATE_PREVIEW_REGION_NOT_FOUND");
  const cropPath=`region-proposals-v1-${fixture}/crops/${regionId}.png`;
  const bytes=await readBounded(root,cropPath,MAX_CROP_BYTES);
  const size=dimensions(bytes),cropSha256=sha(bytes);
  if(cropSha256!==region.cropSha256 ||
      size.cropWidth!==region.width || size.cropHeight!==region.height)
    fail("PRIVATE_PREVIEW_PROVENANCE_MISMATCH");
  return {
    schemaVersion:"acs-private-crop-preview-v1",
    id:itemId,fixtureId:fixture,regionId,
    sourcePhysicalPage1Based:region.sourcePhysicalPage1Based,
    cropSha256,width:region.width,height:region.height,
    authority:"CROP_ONLY_UNVERIFIED",
    graphVerified:false,humanVerified:false,
    pngBase64:bytes.toString("base64")
  };
}

/** Trusted registry is code-owned; callers cannot supply a filesystem path. */
export async function readRegisteredGraphBundle(root,itemId,registrations=TRUSTED_GRAPH_RESULTS){
  let reg;
  try{reg=lookupTrustedGraphResult(itemId,registrations);}
  catch(e){if(e instanceof RegistryError)fail("PRIVATE_REGISTERED_ID_INVALID");throw e;}
  if(!reg)fail("PRIVATE_REGISTERED_RESULT_NOT_FOUND");
  if(reg.kind==="LEGACY_P127"){
    const bundle=await readPrivateP127Bundle(root);
    const saved=await readPrivateP127Draft(root,bundle.view);
    return {...bundle,reviewKind:"LEGACY_P127",saved};
  }
  const [resultBytes,manifestBytes,cropBytes]=await Promise.all([
    readBounded(root,reg.resultPath,MAX_RESULT_BYTES),
    readBounded(root,reg.manifestPath,MAX_MANIFEST_BYTES),
    readBounded(root,reg.cropPath,MAX_CROP_BYTES)
  ]);
  const identity={resultSha256:sha(resultBytes),manifestSha256:sha(manifestBytes),
    cropSha256:sha(cropBytes),...dimensions(cropBytes)};
  if(identity.resultSha256!==reg.resultSha256 ||
      identity.manifestSha256!==reg.manifestSha256 ||
      identity.cropSha256!==reg.cropSha256)
    fail("PRIVATE_REGISTERED_SOURCE_SHA_INVALID");
  let view;
  try{
    view=validateRegionGraphCandidate(json(resultBytes),json(manifestBytes),identity,{
      fixtureId:reg.fixtureId,regionId:reg.regionId,
      sourcePhysicalPage1Based:reg.physicalPage,
      sourceRun:reg.sourceRun,provider:reg.provider,model:reg.model,
      attemptClass:reg.attemptClass,
      expectedCropSha256:reg.cropSha256,
      expectedResultSha256:reg.resultSha256,
    });
  }catch(e){
    if(e instanceof RegionReviewError)fail("PRIVATE_REGISTERED_GRAPH_INVALID");
    throw e;
  }
  let saved;
  try{saved=await readRegionReviewDraft(root,view);}
  catch(e){if(e instanceof RegionStoreError)fail(e.code.replace(/^REGION_/u,"PRIVATE_REGION_"));throw e;}
  return {source:SOURCE,identity,view,reviewKind:"REGISTERED_REGION",saved,
    authority:"PROPOSED_UNVERIFIED",humanVerified:false,
    data:{resultBase64:resultBytes.toString("base64"),
      manifestBase64:manifestBytes.toString("base64"),
      cropBase64:cropBytes.toString("base64")}
  };
}
export async function saveRegisteredGraphReviewDraft(root,itemId,raw,revision,registrations=TRUSTED_GRAPH_RESULTS){
  const bundle=await readRegisteredGraphBundle(root,itemId,registrations);
  if(bundle.reviewKind!=="REGISTERED_REGION")
    fail("PRIVATE_REGISTERED_LEGACY_DRAFT_SEPARATE");
  try{
    return await saveRegionReviewDraft(root,bundle.view,raw,revision);
  }catch(e){
    if(e instanceof RegionStoreError)
      fail(e.code.replace(/^REGION_/u,"PRIVATE_REGION_"));
    throw e;
  }
}
