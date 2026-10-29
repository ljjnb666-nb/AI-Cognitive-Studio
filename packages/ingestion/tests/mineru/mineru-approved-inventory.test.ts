import { expect,it,afterEach } from "vitest";
import { mkdtempSync,rmSync,mkdirSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { approvedManifestText,isApprovedMineruManifest,APPROVED_MINERU_MANIFEST_SHA256 } from "../../src/mineru/mineru-approved-inventory.js";
import { parseMineruStandardManifest,verifyMineruStandardModels,verifyMineruModelFiles,parseMineruStandardAdmissionConfig } from "../../src/mineru/mineru-standard-admission.js";
const dirs:string[]=[];const temp=()=>{const p=mkdtempSync(join(tmpdir(),"approved-model-test-"));dirs.push(p);return p;};
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
it("pins the release inventory digest and includes required YAML resources and the VLM sentinel",()=>{
 const raw=approvedManifestText(),m=parseMineruStandardManifest(raw)!;
 expect(createHash("sha256").update(raw).digest("hex")).toBe(APPROVED_MINERU_MANIFEST_SHA256);
 expect(m.files).toHaveLength(16);expect(m.files.filter(f=>f.path.endsWith(".yml"))).toHaveLength(5);
 expect(isApprovedMineruManifest(m)).toBe(true);
 for(const changed of [{...m,mineruVersion:"4.0.4"},{...m,files:m.files.slice(1)},{...m,files:m.files.map((f,i)=>i===0?{...f,sha256:"a".repeat(64)}:f)}]) expect(isApprovedMineruManifest(changed as typeof m)).toBe(false);
});
it("rejects missing files using the full approved list and never grants approval to an updated self-report",async()=>{
 const raw=approvedManifestText();const a=parseMineruStandardAdmissionConfig({MINERU_STANDARD_MODEL_MANIFEST:"m"},()=>raw)!;
 const result=await verifyMineruStandardModels(temp(),a);expect(result.ok).toBe(false);
 if(!result.ok){expect(result.failures).toHaveLength(16);expect(result.failures.every(f=>f.reason==="MISSING")).toBe(true);}
 const tampered={...a,manifest:{...a.manifest,files:a.manifest.files.map((f,i)=>i===0?{...f,sizeBytes:f.sizeBytes+1}:f)}};
 expect(await verifyMineruStandardModels("not-read",tampered)).toMatchObject({ok:false,failures:[{reason:"UNAPPROVED_MODEL_INVENTORY"}]});
});
it("rejects physical directory escape, including Windows junctions",async()=>{
 const root=temp(),outside=temp();writeFileSync(join(outside,"asset.onnx"),"bytes");
 symlinkSync(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");
 const a=parseMineruStandardAdmissionConfig({MINERU_STANDARD_MODEL_MANIFEST:"m"},()=>JSON.stringify({schemaVersion:"mineru-standard-manifest-v1",mineruVersion:"4.0.3",files:[{path:"linked/asset.onnx",sizeBytes:5,sha256:createHash("sha256").update("bytes").digest("hex")}]}))!;
 expect(await verifyMineruModelFiles(root,a)).toMatchObject({ok:false,failures:[{reason:"SYMLINK_OR_ROOT_ESCAPE"}]});
});
