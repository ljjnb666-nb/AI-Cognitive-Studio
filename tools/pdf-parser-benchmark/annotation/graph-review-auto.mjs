/**
 * Browser + Node shared verifier for the explicitly authorized P127 bundle.
 * The local server returns the RAW bytes of three private files via base64;
 * this verifier must digest all three originals (never JSON re-serialized).
 */
import { MAX_RESULT_BYTES,MAX_MANIFEST_BYTES,MAX_CROP_BYTES,GraphReviewError } from "./graph-review.mjs";
const hex=/^[0-9a-f]{64}$/u;
const error=code=>{throw new GraphReviewError(code);};
function decode(value,max){
  if(typeof value!=="string"||value.length>Math.ceil(max*4/3)+8)
    error("GRAPH_AUTO_BUNDLE_TOO_LARGE");
  let out;
  try{out=Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
  catch{error("GRAPH_AUTO_BUNDLE_DECODE_INVALID");}
  if(out.length<8||out.length>max)error("GRAPH_AUTO_BUNDLE_TOO_LARGE");
  return out;
}
function json(bytes){
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{error("GRAPH_AUTO_SOURCE_JSON_INVALID");}
}
async function digest(bytes){
  if(!globalThis.crypto?.subtle)error("GRAPH_BROWSER_SHA_UNAVAILABLE");
  try{
    const sum=await globalThis.crypto.subtle.digest("SHA-256",bytes);
    return Array.from(new Uint8Array(sum),x=>x.toString(16).padStart(2,"0")).join("");
  }catch{error("GRAPH_AUTO_DIGEST_FAILED");}
}
export async function verifyAutoGraphBundle(bundle){
  const identity=bundle?.identity;
  if(bundle?.authority!=="PROPOSED_UNVERIFIED"||
      identity===null||typeof identity!=="object"||Array.isArray(identity)||
      ![identity.resultSha256,identity.manifestSha256,identity.cropSha256].every(x=>typeof x==="string"&&hex.test(x)))
    error("GRAPH_AUTO_BUNDLE_INVALID");
  const resultBytes=decode(bundle.resultBase64,MAX_RESULT_BYTES),
    manifestBytes=decode(bundle.manifestBase64,MAX_MANIFEST_BYTES),
    cropBytes=decode(bundle.cropBase64,MAX_CROP_BYTES);
  const [rh,mh,ch]=await Promise.all([digest(resultBytes),digest(manifestBytes),digest(cropBytes)]);
  if(rh!==identity.resultSha256||mh!==identity.manifestSha256||ch!==identity.cropSha256)
    error("GRAPH_AUTO_SOURCE_SHA_INVALID");
  return {result:json(resultBytes),manifest:json(manifestBytes),crop:cropBytes,identity};
}
