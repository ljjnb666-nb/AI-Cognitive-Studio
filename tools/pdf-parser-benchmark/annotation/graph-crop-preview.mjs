/**
 * 03E-02 single selected crop SHA guard (browser and Node synthetic tests).
 * Never grants graph or ground-truth authority; only verifies bytes and ID.
 */
import { GraphReviewError, MAX_CROP_BYTES } from "./graph-review.mjs";
const HASH=/^[0-9a-f]{64}$/u;
const ID=/^(RB-PDF-(?:12|13)):(page-[0-9]{3}-region-[0-9]{2})$/u;
const block=code=>{throw new GraphReviewError(code);};
export async function verifyGraphCropPreview(payload, expected){
  const match=typeof expected?.id==="string"?ID.exec(expected.id):null;
  if(!match || !payload || typeof payload!=="object" || Array.isArray(payload) ||
      payload.schemaVersion!=="acs-private-crop-preview-v1" ||
      payload.id!==expected.id || payload.fixtureId!==match[1] ||
      payload.regionId!==match[2] ||
      payload.sourcePhysicalPage1Based!==expected.sourcePhysicalPage1Based ||
      payload.authority!=="CROP_ONLY_UNVERIFIED" ||
      payload.graphVerified!==false || payload.humanVerified!==false ||
      typeof payload.cropSha256!=="string" || !HASH.test(payload.cropSha256) ||
      !Number.isSafeInteger(payload.width)||!Number.isSafeInteger(payload.height)||
      payload.width<20||payload.height<20||payload.width>12000||
      payload.height>12000||payload.width*payload.height>18_000_000)
    block("GRAPH_CROP_PREVIEW_METADATA_INVALID");
  const value=payload.pngBase64;
  if(typeof value!=="string"||value.length>Math.ceil(MAX_CROP_BYTES*4/3)+8)
    block("GRAPH_CROP_PREVIEW_SIZE_INVALID");
  let bytes;
  try{bytes=Uint8Array.from(atob(value),ch=>ch.charCodeAt(0));}
  catch{block("GRAPH_CROP_PREVIEW_BASE64_INVALID");}
  if(bytes.length<33||bytes.length>MAX_CROP_BYTES||
      ![137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))
    block("GRAPH_CROP_PREVIEW_PNG_INVALID");
  if(!crypto?.subtle)block("GRAPH_CROP_PREVIEW_DIGEST_UNAVAILABLE");
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  const actual=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,"0")).join("");
  if(actual!==payload.cropSha256)block("GRAPH_CROP_PREVIEW_SHA_MISMATCH");
  return {bytes,width:payload.width,height:payload.height,
    id:payload.id,sourcePhysicalPage1Based:payload.sourcePhysicalPage1Based,
    graphVerified:false};
}
