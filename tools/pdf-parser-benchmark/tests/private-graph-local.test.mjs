import { describe,it,expect } from "vitest";
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { startAnnotationServer } from "../annotation/server.mjs";
import { createGraphReviewDraft } from "../annotation/graph-review.mjs";
import { verifyAutoGraphBundle } from "../annotation/graph-review-auto.mjs";
import { verifyGraphCropPreview } from "../annotation/graph-crop-preview.mjs";
import {compileGraphBatchPlan,buildPrivateGraphBatchPlan,publicGraphBatchSummary,BatchPlanError} from "../annotation/graph-batch-plan.mjs";
import { createRegionReviewDraft } from "../annotation/region-graph-review.mjs";
import {compileTrustedGraphRegistry,TRUSTED_GRAPH_RESULTS,publicRegisteredGraphMetadata,RegistryError} from "../annotation/graph-result-registry.mjs";
import {
 PRIVATE_FILENAMES,readPrivateP127Bundle,readPrivateP127Draft,writePrivateP127Draft,
 listPrivateGraphReviewQueue,readPrivateGraphCropPreview,readRegisteredGraphBundle,saveRegisteredGraphReviewDraft,PrivateGraphError,
} from "../annotation/private-graph-local.mjs";

const hash = content => createHash("sha256").update(content).digest("hex");
const token="a".repeat(64),wrongToken="b".repeat(64);
const png=()=>{
  const b=Buffer.alloc(33);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(b,0);
  b.writeUInt32BE(13,8);b.write("IHDR",12,"ascii");
  b.writeUInt32BE(200,16);b.writeUInt32BE(100,20);
  return b; // Synthetic header only; no real copyrighted crop or UI decoding.
};
async function fixture(){
  const tmp=await mkdtemp(join(tmpdir(),"acs-p127-auto-fixture-"));
  const root=join(tmp,"reports","real-mineru-39440805765-1");
  const crop=png(),cropSha=hash(crop);
  const nodes=[
    {id:"n1",label:"客户端",bboxCropPixels:[10,20,50,30],proposalConfidence:.6,reviewStatus:"NOT_REVIEWED"},
    {id:"n2",label:"服务器",bboxCropPixels:[120,25,55,35],proposalConfidence:.5,reviewStatus:"NOT_REVIEWED"},
  ];
  const edges=[
    {id:"e1",fromNodeId:"n1",toNodeId:"n2",direction:"UNKNOWN",arrowTipCropPixels:[110,45],
      shaftCropPixels:[[75,45],[104,45]],proposalConfidence:.4,reviewStatus:"NOT_REVIEWED"},
  ];
  const regions={schemaVersion:"acs-pdf-private-region-evidence-v1",
    sourceRun:"real-mineru-39440805765-1",fixtureId:"RB-PDF-13",
    allRegionsAreUnverified:true,noSemanticGraphClaims:true,
    pages:[{subsetPageIndex:1,sourcePhysicalPage1Based:127,regions:[{regionId:"page-002-region-01",
      proposalStatus:"UNVERIFIED_REGION_SUGGESTION",nodes:null,directedEdges:null,timingRelations:null,
      cropSha256:cropSha,bboxPixels:[100,200,200,100]}]}]};
  const manifest=Buffer.from(JSON.stringify(regions));
  const region={schemaVersion:"acs-vision-graph-proposal-v1",fixtureId:"RB-PDF-13",
    regionId:"page-002-region-01",sourceCropSha256:cropSha,
    coordinateSpace:"REGION_CROP_TOP_LEFT_PIXELS",graphStatus:"PROPOSED_UNVERIFIED",
    reviewStatus:"NOT_REVIEWED",humanVerified:false,nodes,edges};
  const mapped={regionId:"page-002-region-01",sourcePhysicalPage1Based:127,
    sourceCropSha256:cropSha,graphVerified:false,needsIndependentHumanReview:true,
    mappedNodes:nodes.map(n=>({id:n.id,bboxPagePixels:[100+n.bboxCropPixels[0],200+n.bboxCropPixels[1],n.bboxCropPixels[2],n.bboxCropPixels[3]],
      sourcePhysicalPage1Based:127,claim:"MACHINE_SUGGESTION_NOT_VERIFIED"})),
    mappedEdges:edges.map(e=>({id:e.id,arrowTipPagePixels:[100+e.arrowTipCropPixels[0],200+e.arrowTipCropPixels[1]],
      shaftPagePixels:e.shaftCropPixels.map(p=>[100+p[0],200+p[1]]),
      sourcePhysicalPage1Based:127,claim:"GEOMETRIC_WITNESS_AND_RELATION_UNVERIFIED"}))};
  const resultDoc={schemaVersion:"acs-glm-cloud-vision-proposal-v1",
    sourceRun:"real-mineru-39440805765-1",fixtureId:"RB-PDF-13",provider:"ZHIPU_GLMCLOUD_STANDARD_API",
    model:"glm-5.3-flash",attemptClass:"EXPLICIT_P127_SECOND_ATTEMPT",
    transferScope:"EXPLICITLY_SELECTED_CROP_IMAGES_ONLY",
    sourceRegionManifestSha256:hash(manifest),reviewStatus:"NOT_REVIEWED",graphVerified:false,
    results:[{regionId:"page-002-region-01",sourcePhysicalPage1Based:127,cropSha256:cropSha,
      proposal:region,mappedPageEvidence:mapped,humanReviewStatus:"NOT_REVIEWED",graphVerified:false}]};
  const result=Buffer.from(JSON.stringify(resultDoc));
  const files={result,manifest,crop};
  for(const [name,buffer] of Object.entries(files)){
    const p=join(root,...PRIVATE_FILENAMES[name].split("/"));
    await mkdir(dirname(p),{recursive:true});await writeFile(p,buffer);
  }
  await writeFile(join(root,"do-not-read-private.txt"),"SYNTHETIC_PRIVATE_SENTINEL_FOR_EXCLUSION");
  return {root,tmp,files,resultDoc,regions};
}
const withFixture=async fn=>{
  const x=await fixture();
  try{return await fn(x);}finally{await rm(x.tmp,{recursive:true,force:true});}
};
const expectCode=async(promise,code)=>{
  try{await promise;throw new Error("SHOULD_FAIL");}
  catch(e){expect(e).toBeInstanceOf(PrivateGraphError);expect(e.code).toBe(code);}
};
function send(app,path,opts={}){
  const url=new URL(app.url);
  const body=opts.body===undefined?null:Buffer.from(JSON.stringify(opts.body));
  const headers={
    Host:opts.host??url.host,
    ...(opts.auth===false?{}:{"x-acs-review-token":opts.auth??token}),
    ...(opts.origin?{Origin:opts.origin}:{}),
    ...(opts.site?{"sec-fetch-site":opts.site}:{}),
    ...(body?{"Content-Type":"application/json","Content-Length":body.length,
      "x-acs-draft-revision":opts.revision??"none"}:{}),
  };
  return new Promise((resolve,reject)=>{
    const req=request({hostname:"127.0.0.1",port:url.port,path,method:opts.method??"GET",headers},res=>{
      const chunks=[];res.on("data",b=>chunks.push(b));res.on("end",()=>{
        const bytes=Buffer.concat(chunks);
        let value;try{value=JSON.parse(bytes.toString("utf8"));}catch{value=null;}
        resolve({status:res.statusCode,headers:res.headers,value,bytes});
      });
    });req.on("error",reject);req.end(body);
  });
}
describe("03D P127 local auto import — strictly synthetic, no D: data",()=>{
  it("reads fixed allowlist bytes with SHA and returns no unrelated file",()=>withFixture(async x=>{
    const bundle=await readPrivateP127Bundle(x.root);
    expect(bundle.view).toMatchObject({physicalPage:127,graphVerified:false,reviewStatus:"NOT_REVIEWED"});
    expect(bundle.view.nodes).toHaveLength(2);expect(bundle.view.edges).toHaveLength(1);
    expect(bundle.identity.resultSha256).toBe(hash(x.files.result));
    expect(bundle.identity.manifestSha256).toBe(hash(x.files.manifest));
    expect(bundle.identity.cropSha256).toBe(hash(x.files.crop));
    expect(Buffer.from(bundle.data.resultBase64,"base64")).toEqual(x.files.result);
    expect(Buffer.from(bundle.data.manifestBase64,"base64")).toEqual(x.files.manifest);
    expect(Buffer.from(bundle.data.cropBase64,"base64")).toEqual(x.files.crop);
    expect(JSON.stringify(bundle)).not.toContain("SYNTHETIC_PRIVATE_SENTINEL");
  }));
  it("browser raw-byte verifier accepts exact three SHA-pinned inputs and rejects substitution",()=>withFixture(async x=>{
    const bundle=await readPrivateP127Bundle(x.root);
    const data={...bundle.data,identity:bundle.identity,authority:bundle.authority};
    const verified=await verifyAutoGraphBundle(data);
    expect(verified.identity).toEqual(bundle.identity);
    expect(verified.result.schemaVersion).toBe("acs-glm-cloud-vision-proposal-v1");
    expect(Buffer.from(verified.crop)).toEqual(x.files.crop);
    const changedCrop={...data,cropBase64:Buffer.from("synthetic_wrong_png").toString("base64")};
    await expect(verifyAutoGraphBundle(changedCrop)).rejects.toMatchObject({code:"GRAPH_AUTO_SOURCE_SHA_INVALID"});
    const modifiedManifest={...data,manifestBase64:Buffer.concat([x.files.manifest,Buffer.from(" ")]).toString("base64")};
    await expect(verifyAutoGraphBundle(modifiedManifest)).rejects.toMatchObject({code:"GRAPH_AUTO_SOURCE_SHA_INVALID"});
    const changedResult={...data,resultBase64:Buffer.from('{"fake":true}').toString("base64")};
    await expect(verifyAutoGraphBundle(changedResult)).rejects.toMatchObject({code:"GRAPH_AUTO_SOURCE_SHA_INVALID"});
    await expect(verifyAutoGraphBundle({...data,authority:"VERIFIED"})).rejects.toMatchObject({code:"GRAPH_AUTO_BUNDLE_INVALID"});
    await expect(verifyAutoGraphBundle({...data,cropBase64:"x".repeat(12_000_000)}))
      .rejects.toMatchObject({code:"GRAPH_AUTO_BUNDLE_TOO_LARGE"});
  }));
  it("fails closed if the crop bytes or manifest source SHA change",()=>withFixture(async x=>{
    const cropPath=join(x.root,...PRIVATE_FILENAMES.crop.split("/"));
    const changed=Buffer.from(x.files.crop);changed[32]=5;
    await writeFile(cropPath,changed);
    await expectCode(readPrivateP127Bundle(x.root),"PRIVATE_GRAPH_PROVENANCE_INVALID");
    await writeFile(cropPath,x.files.crop);
    const manifestPath=join(x.root,...PRIVATE_FILENAMES.manifest.split("/"));
    await writeFile(manifestPath,Buffer.concat([x.files.manifest,Buffer.from(" ")]));
    await expectCode(readPrivateP127Bundle(x.root),"PRIVATE_GRAPH_PROVENANCE_INVALID");
  }));
  it("rejects a crop symlink even when pointing at valid bytes",()=>withFixture(async x=>{
    const p=join(x.root,...PRIVATE_FILENAMES.crop.split("/"));
    await rm(p);const outside=join(x.tmp,"outside.png");await writeFile(outside,x.files.crop);
    await symlink(outside,p);
    await expectCode(readPrivateP127Bundle(x.root),"PRIVATE_EVIDENCE_UNSAFE");
  }));
  it("requires explicit server option; default server exposes no private API",async()=>{
    const app=await startAnnotationServer();
    try{
      const r=await send(app,"/api/private-graph/p127/bundle");
      expect(r.status).toBe(404);expect(r.bytes.toString()).not.toContain("sourceRun");
    }finally{await app.close();}
  });
  it("requires a capability and exact loopback Host/Origin/Fetch-Site",()=>withFixture(async x=>{
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token});
    try{
      for(const opts of [{auth:false},{auth:wrongToken},{host:"attacker.example"},
        {origin:"https://attacker.example"},{site:"cross-site"}]){
        const r=await send(app,"/api/private-graph/p127/bundle",opts);
        expect(r.status).toBe(403);expect(r.value?.resultBase64).toBeUndefined();
      }
      expect((await send(app,"/api/private-graph/p127/bundle")).status).toBe(200);
      expect((await send(app,"/api/private-graph/p127/crop")).status).toBe(404);
      expect((await send(app,"/api/private-graph/p127/bundle",{method:"PUT"})).status).toBe(405);
      const graphPage=await send(app,"/graph-review.html",{auth:false});
      expect(graphPage.status).toBe(200);
      expect(graphPage.headers["content-security-policy"]).toContain("connect-src 'self'");
      const legacy=await send(app,"/index.html",{auth:false});
      expect(legacy.headers["content-security-policy"]).toContain("connect-src 'none'");
    }finally{await app.close();}
  }));
  it("read-only real-data mode exposes no draft writes despite valid token",()=>withFixture(async x=>{
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token,privateGraphReadOnly:true});
    try{
      const b=await send(app,"/api/private-graph/p127/bundle");
      expect(b.status).toBe(200);
      const d=await send(app,"/api/private-graph/p127/draft");
      expect(d.status).toBe(200);
      expect(d.value).toEqual({draft:null,revision:null});
      const raw=createGraphReviewDraft((await readPrivateP127Bundle(x.root)).view);
      const denied=await send(app,"/api/private-graph/p127/draft",{method:"PUT",body:raw,revision:"none"});
      expect(denied.status).toBe(405);
      expect(denied.value.code).toBe("PRIVATE_DRAFT_WRITE_DISABLED");
      expect((await readPrivateP127Draft(x.root,(await readPrivateP127Bundle(x.root)).view)).revision).toBe(null);
    }finally{await app.close();}
  }));
  it("restores and revision-writes an unattested draft; stale revision cannot overwrite",()=>withFixture(async x=>{
    const v=(await readPrivateP127Bundle(x.root)).view;
    const none=await readPrivateP127Draft(x.root,v);
    expect(none).toEqual({draft:null,revision:null});
    const draft=createGraphReviewDraft(v);draft.decisions[0].decision="VISIBLE_MATCH";
    const saved=await writePrivateP127Draft(x.root,v,draft,null);
    expect(saved).toMatchObject({status:"REVIEW_DRAFT_UNATTESTED",humanVerified:false});
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
    const now=await readPrivateP127Draft(x.root,v);
    expect(now.revision).toBe(saved.revision);
    expect(now.draft).toMatchObject({humanVerified:false,graphVerified:false});
    await expectCode(writePrivateP127Draft(x.root,v,draft,null),"PRIVATE_DRAFT_CONFLICT");
    draft.decisions[1].decision="UNCERTAIN";
    const next=await writePrivateP127Draft(x.root,v,draft,saved.revision);
    expect(next.revision).not.toBe(saved.revision);
    await expectCode(writePrivateP127Draft(x.root,v,draft,saved.revision),"PRIVATE_DRAFT_CONFLICT");
  }));
  it("blocks forged verification and mismatched result lineage without creating draft",()=>withFixture(async x=>{
    const v=(await readPrivateP127Bundle(x.root)).view;
    const d=createGraphReviewDraft(v);d.graphVerified=true;
    await expectCode(writePrivateP127Draft(x.root,v,d,null),"PRIVATE_DRAFT_STALE_OR_INVALID");
    d.graphVerified=false;d.resultSha256="f".repeat(64);
    await expectCode(writePrivateP127Draft(x.root,v,d,null),"PRIVATE_DRAFT_STALE_OR_INVALID");
    expect((await readPrivateP127Draft(x.root,v)).revision).toBe(null);
  }));
  it("one request saves and concurrent stale draft updates produce exactly one winner",()=>withFixture(async x=>{
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token});
    try{
      const bundle=await readPrivateP127Bundle(x.root);
      const original=createGraphReviewDraft(bundle.view);
      const requests=await Promise.all([
        send(app,"/api/private-graph/p127/draft",{method:"PUT",body:original,revision:"none"}),
        send(app,"/api/private-graph/p127/draft",{method:"PUT",body:original,revision:"none"}),
      ]);
      expect(requests.map(r=>r.status).sort()).toEqual([200,409]);
      const loaded=await send(app,"/api/private-graph/p127/draft");
      expect(loaded.status).toBe(200);
      expect(loaded.value.draft).toMatchObject({graphVerified:false,humanVerified:false});
      expect(loaded.value.revision).toMatch(/^[0-9a-f]{64}$/);
      const changed=loaded.value.draft;changed.decisions[0].decision="UNCERTAIN";
      const update=await send(app,"/api/private-graph/p127/draft",
        {method:"PUT",body:changed,revision:loaded.value.revision});
      expect(update.status).toBe(200);
      expect(update.value.revision).not.toBe(loaded.value.revision);
    }finally{await app.close();}
  }));
  it("refuses private draft writes with wrong method, missing auth, forged source or stale revision",()=>withFixture(async x=>{
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token});
    try{
      const draft=createGraphReviewDraft((await readPrivateP127Bundle(x.root)).view);
      expect((await send(app,"/api/private-graph/p127/draft",{method:"POST",body:draft})).status).toBe(405);
      expect((await send(app,"/api/private-graph/p127/draft",{method:"PUT",body:draft,auth:false})).status).toBe(403);
      draft.humanVerified=true;
      const forged=await send(app,"/api/private-graph/p127/draft",{method:"PUT",body:draft});
      expect(forged.status).toBe(422);
      expect(forged.value.code).toBe("PRIVATE_DRAFT_STALE_OR_INVALID");
    }finally{await app.close();}
  }));
});

describe("03E-01 multiple fixture evidence queue — safe bounded inventory only",()=>{
  it("discovers verified P127 r02 and never promotes crop-only pages to human review",()=>withFixture(async x=>{
    const p12Crop=png(),digest=hash(p12Crop);
    const doc={schemaVersion:"acs-pdf-private-region-evidence-v1",
      fixtureId:"RB-PDF-12",sourceRun:"real-mineru-39440805765-1",
      allRegionsAreUnverified:true,noSemanticGraphClaims:true,
      pages:[{subsetPageIndex:0,sourcePhysicalPage1Based:51,regions:[{
        regionId:"page-001-region-01",proposalStatus:"UNVERIFIED_REGION_SUGGESTION",
        nodes:null,directedEdges:null,timingRelations:null,
        bboxPixels:[10,20,200,100],cropSha256:digest
      }]}]};
    const manifest=join(x.root,"region-proposals-v1-RB-PDF-12","region-proposals.json");
    const crop=join(x.root,"region-proposals-v1-RB-PDF-12","crops","page-001-region-01.png");
    await mkdir(dirname(crop),{recursive:true});
    await writeFile(manifest,JSON.stringify(doc));await writeFile(crop,p12Crop);
    const queue=await listPrivateGraphReviewQueue(x.root);
    expect(queue).toMatchObject({schemaVersion:"acs-private-graph-review-queue-v1",
      authority:"DISCOVERY_ONLY_NOT_GROUND_TRUTH",
      counts:{total:2,ready:1,cropOnly:1,blocked:0}});
    expect(queue.items.map(x=>x.id)).toEqual([
      "RB-PDF-12:page-001-region-01","RB-PDF-13:page-002-region-01"
    ]);
    expect(queue.items[0]).toMatchObject({sourcePhysicalPage1Based:51,
      evidenceStatus:"CROP_READY_NO_GRAPH",reviewable:false,graphVerified:false});
    expect(queue.items[1]).toMatchObject({sourcePhysicalPage1Based:127,
      evidenceStatus:"GRAPH_READY_FOR_HUMAN_REVIEW",reviewable:true,
      nodeCount:2,edgeCount:1,reviewedCount:0,graphVerified:false});
    expect(JSON.stringify(queue)).not.toContain("合成客户端");
    expect(JSON.stringify(queue)).not.toContain("cropSha256");
    expect(JSON.stringify(queue)).not.toContain("fake-private-reports");
  }));
  it("reports a missing or forged crop as blocked without promoting or hiding other crops",()=>withFixture(async x=>{
    const crop=join(x.root,...PRIVATE_FILENAMES.crop.split("/"));
    await writeFile(crop,Buffer.from("corrupt-but-not-too-short"));
    const queue=await listPrivateGraphReviewQueue(x.root);
    expect(queue.counts).toEqual({total:1,ready:0,cropOnly:0,blocked:1});
    expect(queue.items[0]).toMatchObject({reviewable:false,evidenceStatus:"CROP_MISSING_OR_BLOCKED"});
  }));
  it("fails closed for forged page sequence and graph manifest duplicate IDs",()=>withFixture(async x=>{
    const path=join(x.root,...PRIVATE_FILENAMES.manifest.split("/"));
    const manifest=JSON.parse((await readFile(path)).toString("utf8"));
    manifest.pages[0].subsetPageIndex=0;
    await writeFile(path,JSON.stringify(manifest));
    await expectCode(listPrivateGraphReviewQueue(x.root),"PRIVATE_QUEUE_REGION_INVALID");
  }));
  it("rejects forged source manifest and prevents arbitrary-file inventory",()=>withFixture(async x=>{
    const path=join(x.root,...PRIVATE_FILENAMES.manifest.split("/"));
    const manifest=JSON.parse((await readFile(path)).toString("utf8"));
    manifest.pages[0].regions[0].directedEdges=[{from:"evil"}];
    await writeFile(path,JSON.stringify(manifest));
    await expectCode(listPrivateGraphReviewQueue(x.root),"PRIVATE_QUEUE_REGION_INVALID");
  }));
  it("queue endpoint uses local capability, forbids writes, and is disabled by default",()=>withFixture(async x=>{
    const off=await startAnnotationServer();
    try{expect((await send(off,"/api/private-graph/queue")).status).toBe(404);}
    finally{await off.close();}
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token});
    try{
      expect((await send(app,"/api/private-graph/queue",{auth:false})).status).toBe(403);
      expect((await send(app,"/api/private-graph/queue",{origin:"https://attacker.invalid"})).status).toBe(403);
      expect((await send(app,"/api/private-graph/queue",{method:"POST"})).status).toBe(405);
      const queue=await send(app,"/api/private-graph/queue");
      expect(queue.status).toBe(200);
      expect(queue.value.counts).toMatchObject({total:1,ready:1});
      expect(queue.bytes.toString("utf8")).not.toContain("合成客户端");
    }finally{await app.close();}
  }));
});

describe("03E-02 on-demand region crop preview — no graph authority",()=>{
  it("returns only selected P127 private crop and proves PNG SHA in the browser",()=>withFixture(async x=>{
    const id="RB-PDF-13:page-002-region-01";
    const preview=await readPrivateGraphCropPreview(x.root,id);
    expect(preview).toMatchObject({id,sourcePhysicalPage1Based:127,
      width:200,height:100,authority:"CROP_ONLY_UNVERIFIED",graphVerified:false,humanVerified:false});
    expect(preview.cropSha256).toBe(hash(x.files.crop));
    const verified=await verifyGraphCropPreview(preview,{id,sourcePhysicalPage1Based:127});
    expect(Buffer.from(verified.bytes)).toEqual(x.files.crop);
    expect(verified.graphVerified).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("合成客户端");
    expect(JSON.stringify(preview)).not.toContain("graphStatus");
  }));
  it("strictly rejects traversal, forged book names and invented region IDs",()=>withFixture(async x=>{
    for(const id of ["../do-not-read-private.txt","RB-PDF-11:page-002-region-01",
      "RB-PDF-13:../page-002-region-01","RB-PDF-13:page-002-region-99",
      "RB-PDF-13:page-002-region-01/../../","RB-PDF-13:page-002-region-01%2fsecret"]){
      await expectCode(readPrivateGraphCropPreview(x.root,id),
        id==="RB-PDF-13:page-002-region-99"?"PRIVATE_PREVIEW_REGION_NOT_FOUND":"PRIVATE_PREVIEW_ID_INVALID");
    }
  }));
  it("rejects altered PNG and changed physical page instead of displaying a misleading preview",()=>withFixture(async x=>{
    const id="RB-PDF-13:page-002-region-01";
    const preview=await readPrivateGraphCropPreview(x.root,id);
    await expect(verifyGraphCropPreview({...preview,pngBase64:Buffer.from("not-valid-PNG").toString("base64")},
      {id,sourcePhysicalPage1Based:127})).rejects.toMatchObject({code:"GRAPH_CROP_PREVIEW_PNG_INVALID"});
    const modified=Buffer.from(x.files.crop);modified[32]=7;
    await expect(verifyGraphCropPreview({...preview,pngBase64:modified.toString("base64")},
      {id,sourcePhysicalPage1Based:127})).rejects.toMatchObject({code:"GRAPH_CROP_PREVIEW_SHA_MISMATCH"});
    await expect(verifyGraphCropPreview(preview,{id,sourcePhysicalPage1Based:379}))
      .rejects.toMatchObject({code:"GRAPH_CROP_PREVIEW_METADATA_INVALID"});
    await expect(verifyGraphCropPreview({...preview,authority:"HUMAN_VERIFIED"},
      {id,sourcePhysicalPage1Based:127})).rejects.toMatchObject({code:"GRAPH_CROP_PREVIEW_METADATA_INVALID"});
    const crop=join(x.root,...PRIVATE_FILENAMES.crop.split("/"));
    await writeFile(crop,modified);
    await expectCode(readPrivateGraphCropPreview(x.root,id),"PRIVATE_PREVIEW_PROVENANCE_MISMATCH");
  }));
  it("never follows a linked crop or reads sibling files",()=>withFixture(async x=>{
    const crop=join(x.root,...PRIVATE_FILENAMES.crop.split("/"));
    await rm(crop);
    const outside=join(x.tmp,"outside.png");await writeFile(outside,x.files.crop);
    await symlink(outside,crop);
    await expectCode(readPrivateGraphCropPreview(x.root,"RB-PDF-13:page-002-region-01"),"PRIVATE_EVIDENCE_UNSAFE");
  }));
  it("requires local token and canonical single GET query, with no draft writes",()=>withFixture(async x=>{
    const id="RB-PDF-13%3Apage-002-region-01",path="/api/private-graph/crop?item="+id;
    const off=await startAnnotationServer();
    try{expect((await send(off,path)).status).toBe(404);}finally{await off.close();}
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token,privateGraphReadOnly:true});
    try{
      expect((await send(app,path,{auth:false})).status).toBe(403);
      expect((await send(app,path,{site:"cross-site"})).status).toBe(403);
      expect((await send(app,path,{origin:"https://attacker.invalid"})).status).toBe(403);
      expect((await send(app,path,{method:"POST"})).status).toBe(405);
      expect((await send(app,path+"&item="+id)).status).toBe(400);
      expect((await send(app,"/api/private-graph/crop?item=..%2fsecret")).status).toBe(400);
      const answer=await send(app,path);
      expect(answer.status).toBe(200);
      expect(answer.value).toMatchObject({id:"RB-PDF-13:page-002-region-01",graphVerified:false,
        authority:"CROP_ONLY_UNVERIFIED"});
      expect(Buffer.from(answer.value.pngBase64,"base64")).toEqual(x.files.crop);
      expect((await send(app,"/api/private-graph/p127/draft")).value).toEqual({draft:null,revision:null});
    }finally{await app.close();}
  }));
});

function addSyntheticP51Registration(x){
  const fixture="RB-PDF-12",regionId="page-001-region-01",physicalPage=51;
  const doc=structuredClone(x.regions);
  doc.fixtureId=fixture;
  doc.pages[0].subsetPageIndex=0;doc.pages[0].sourcePhysicalPage1Based=physicalPage;
  doc.pages[0].regions[0].regionId=regionId;
  const m=Buffer.from(JSON.stringify(doc));
  const result=structuredClone(x.resultDoc);
  result.fixtureId=fixture;result.attemptClass="EXPLICIT_P51_INITIAL_ATTEMPT";
  result.sourceRegionManifestSha256=hash(m);
  const row=result.results[0];row.regionId=regionId;row.sourcePhysicalPage1Based=physicalPage;
  row.proposal.fixtureId=fixture;row.proposal.regionId=regionId;
  row.mappedPageEvidence.regionId=regionId;
  row.mappedPageEvidence.sourcePhysicalPage1Based=physicalPage;
  for(const node of row.mappedPageEvidence.mappedNodes)node.sourcePhysicalPage1Based=physicalPage;
  for(const edge of row.mappedPageEvidence.mappedEdges)edge.sourcePhysicalPage1Based=physicalPage;
  const r=Buffer.from(JSON.stringify(result));
  const crop=x.files.crop;
  const registration={
    id:fixture+":"+regionId,fixtureId:fixture,regionId,physicalPage,
    kind:"REGISTERED_REGION",sourceRun:"real-mineru-39440805765-1",
    provider:"ZHIPU_GLMCLOUD_STANDARD_API",model:"glm-5.3-flash",
    attemptClass:"EXPLICIT_P51_INITIAL_ATTEMPT",
    resultPath:"glm-cloud-v1-"+fixture+"-"+regionId+"-synthetic/cloud-vision-proposals.json",
    manifestPath:"region-proposals-v1-"+fixture+"/region-proposals.json",
    cropPath:"region-proposals-v1-"+fixture+"/crops/"+regionId+".png",
    resultSha256:hash(r),manifestSha256:hash(m),cropSha256:hash(crop)
  };
  return {registration,result:r,manifest:m,crop};
}
async function writeSyntheticRegistered(x,prepared){
  const reg=prepared.registration;
  for(const [path,bytes] of [
    [reg.resultPath,prepared.result],
    [reg.manifestPath,prepared.manifest],
    [reg.cropPath,prepared.crop]
  ]){
    const output=join(x.root,...path.split("/"));
    await mkdir(dirname(output),{recursive:true});
    await writeFile(output,bytes);
  }
}
describe("03E-03B code-pinned result registration and per-region HTTP fences",()=>{
  it("defaults to exact legacy P127 and cannot invent generic results from crop-only evidence",()=>withFixture(async x=>{
    const list=publicRegisteredGraphMetadata();
    expect(list).toMatchObject({schemaVersion:"acs-trusted-graph-registration-v1",
      authority:"REGISTERED_SOURCE_ONLY_NOT_GROUND_TRUTH"});
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({id:"RB-PDF-13:page-002-region-01",
      reviewKind:"LEGACY_P127",graphVerified:false});
    const queue=await listPrivateGraphReviewQueue(x.root);
    expect(queue.counts).toMatchObject({total:1,ready:1});
    expect(queue.items[0].reviewKind).toBe("LEGACY_P127");
    await expectCode(readRegisteredGraphBundle(x.root,"RB-PDF-12:page-001-region-01"),
      "PRIVATE_REGISTERED_RESULT_NOT_FOUND");
  }));
  it("rejects wrong source path, spoofed legacy, missing exact SHA, and duplicate registration",()=>{
    const valid=structuredClone(TRUSTED_GRAPH_RESULTS[0]);
    const changed=[
      {...valid,id:"RB-PDF-12:page-001-region-01",fixtureId:"RB-PDF-12"},
      {...valid,resultPath:"../outside/private.json"},
      {...valid,manifestPath:"other/region-proposals.json"},
      {...valid,kind:"REGISTERED_REGION"},
    ];
    for(const entry of changed)expect(()=>compileTrustedGraphRegistry([entry])).toThrow(RegistryError);
    expect(()=>compileTrustedGraphRegistry([valid,valid])).toThrow(RegistryError);
    expect(()=>compileTrustedGraphRegistry(Array(33).fill(valid))).toThrow(RegistryError);
  });
  it("can verify explicitly SHA-pinned second book, and save its draft without touching legacy",()=>withFixture(async x=>{
    const prepared=addSyntheticP51Registration(x);
    await writeSyntheticRegistered(x,prepared);
    const registry=[...TRUSTED_GRAPH_RESULTS,prepared.registration];
    const item=prepared.registration.id;
    const bundle=await readRegisteredGraphBundle(x.root,item,registry);
    expect(bundle).toMatchObject({reviewKind:"REGISTERED_REGION",
      authority:"PROPOSED_UNVERIFIED",humanVerified:false});
    expect(bundle.view).toMatchObject({fixtureId:"RB-PDF-12",physicalPage:51,
      regionId:"page-001-region-01",graphVerified:false});
    expect(bundle.saved).toEqual({draft:null,revision:null});
    expect(bundle.view.nodes).toHaveLength(2);
    const draft=createRegionReviewDraft(bundle.view);
    draft.decisions[0].decision="UNCERTAIN";
    const stored=await saveRegisteredGraphReviewDraft(x.root,item,draft,null,registry);
    expect(stored).toMatchObject({status:"REVIEW_DRAFT_UNATTESTED",graphVerified:false});
    expect((await readRegisteredGraphBundle(x.root,item,registry)).saved.draft.decisions[0].decision).toBe("UNCERTAIN");
    expect((await readPrivateP127Draft(x.root,(await readPrivateP127Bundle(x.root)).view)).revision).toBe(null);
    await expectCode(saveRegisteredGraphReviewDraft(x.root,item,draft,null,registry),
      "PRIVATE_REGION_STORE_REVISION_CONFLICT");
  }));
  it("rejects mismatched pinned SHA, even if a new region model result is structurally plausible",()=>withFixture(async x=>{
    const prepared=addSyntheticP51Registration(x);
    await writeSyntheticRegistered(x,prepared);
    const tampered={...prepared.registration,resultSha256:"e".repeat(64)};
    await expectCode(readRegisteredGraphBundle(x.root,tampered.id,[...TRUSTED_GRAPH_RESULTS,tampered]),
      "PRIVATE_REGISTERED_SOURCE_SHA_INVALID");
    const queue=await listPrivateGraphReviewQueue(x.root,[...TRUSTED_GRAPH_RESULTS,tampered]);
    expect(queue.counts).toMatchObject({total:2,ready:1,blocked:1});
    expect(queue.items.find(item=>item.id===tampered.id)).toMatchObject({
      reviewable:false,evidenceStatus:"GRAPH_EVIDENCE_BLOCKED"});
  }));
  it("registers a second region under local token and saves only its CAS draft",()=>withFixture(async x=>{
    const prepared=addSyntheticP51Registration(x);
    await writeSyntheticRegistered(x,prepared);
    const registry=[...TRUSTED_GRAPH_RESULTS,prepared.registration];
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token,
      trustedGraphRegistrations:registry});
    const item="RB-PDF-12%3Apage-001-region-01";
    try{
      const batch=await send(app,"/api/private-graph/batch/plan");
      expect(batch.status).toBe(200);
      expect(batch.value.counts).toMatchObject({discovered:2,eligible:0,alreadyHasGraph:2});
      expect(batch.value).toMatchObject({providerRequestsIssued:0,dispatchEnabled:false});
      const meta=await send(app,"/api/private-graph/registry");
      expect(meta.status).toBe(200);
      expect(meta.value.entries).toHaveLength(2);
      expect(JSON.stringify(meta.value)).not.toContain("resultSha256");
      expect((await send(app,"/api/private-graph/registry",{auth:false})).status).toBe(403);
      expect((await send(app,"/api/private-graph/registry?item=x")).status).toBe(400);
      const unauthorized=await send(app,"/api/private-graph/registered/bundle?item="+item,{auth:false});
      expect(unauthorized.status).toBe(403);
      expect((await send(app,"/api/private-graph/registered/bundle?item="+item+"&item="+item)).status).toBe(400);
      const response=await send(app,"/api/private-graph/registered/bundle?item="+item);
      expect(response.status).toBe(200);
      expect(response.value.reviewKind).toBe("REGISTERED_REGION");
      expect(response.value.saved).toEqual({draft:null,revision:null});
      const bundle=await readRegisteredGraphBundle(x.root,prepared.registration.id,registry);
      const draft=createRegionReviewDraft(bundle.view);
      draft.decisions[0].decision="VISIBLE_MATCH";
      const target="/api/private-graph/registered/draft?item="+item;
      const first=await send(app,target,{method:"PUT",body:draft});
      expect(first.status).toBe(200);
      expect(first.value.graphVerified).toBe(false);
      const concurrent=await send(app,target,{method:"PUT",body:draft});
      expect(concurrent.status).toBe(409);
      expect((await send(app,target)).value.draft.decisions[0].decision).toBe("VISIBLE_MATCH");
      const P127="/api/private-graph/registered/draft?item=RB-PDF-13%3Apage-002-region-01";
      expect((await send(app,P127,{method:"PUT",body:createGraphReviewDraft((await readPrivateP127Bundle(x.root)).view)})).status).toBe(422);
      expect((await readPrivateP127Draft(x.root,(await readPrivateP127Bundle(x.root)).view)).revision).toBe(null);
    }finally{await app.close();}
  }));
  it("hard-disables generic drafts in read-only mode with correct token",()=>withFixture(async x=>{
    const prepared=addSyntheticP51Registration(x);
    await writeSyntheticRegistered(x,prepared);
    const registry=[...TRUSTED_GRAPH_RESULTS,prepared.registration];
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token,
      privateGraphReadOnly:true,trustedGraphRegistrations:registry});
    try{
      const target="/api/private-graph/registered/draft?item=RB-PDF-12%3Apage-001-region-01";
      const bundle=await readRegisteredGraphBundle(x.root,prepared.registration.id,registry);
      expect((await send(app,target,{method:"PUT",body:createRegionReviewDraft(bundle.view)})).status).toBe(405);
      expect((await send(app,target)).value).toMatchObject({draft:null,revision:null});
    }finally{await app.close();}
  }));
});

const fakeQueue=(ids,statuses)=>({
  schemaVersion:"acs-private-graph-review-queue-v1",
  authority:"DISCOVERY_ONLY_NOT_GROUND_TRUTH",
  items:ids.map((id,i)=>({
    id,fixtureId:id.split(":")[0],regionId:id.split(":")[1],
    sourcePhysicalPage1Based:i+50,
    reviewable:statuses[i]==="GRAPH_READY_FOR_HUMAN_REVIEW",
    evidenceStatus:statuses[i],graphVerified:false,humanVerified:false
  })),
  counts:{total:ids.length}
});
const fakeProof=(id,physical,cropSha,bytes=128)=>({
  id,sourcePhysicalPage1Based:physical,authority:"CROP_ONLY_UNVERIFIED",
  graphVerified:false,humanVerified:false,cropSha256:cropSha,
  width:200,height:100,byteLength:bytes,priorAttemptBlocked:false
});
describe("03E-04A paid inference batch PLANNING, strictly no dispatch",()=>{
  it("real inventory with only P127 returns zero payable work and does not write files",()=>withFixture(async x=>{
    const before=await readFile(join(x.root,...PRIVATE_FILENAMES.result.split("/")));
    const plan=await buildPrivateGraphBatchPlan(x.root);
    expect(plan).toMatchObject({
      schemaVersion:"acs-offline-graph-batch-plan-v1",
      authority:"PREVIEW_ONLY_NO_PROVIDER_DISPATCH",
      needsExplicitPaidAuthorization:true,providerRequestsIssued:0,dispatchEnabled:false,
      priceEstimate:null,counts:{discovered:1,eligible:0,alreadyHasGraph:1}
    });
    expect(plan.excluded[0].reason).toBe("ALREADY_HAS_GRAPH");
    expect(await readFile(join(x.root,...PRIVATE_FILENAMES.result.split("/")))).toEqual(before);
  }));
  it("plans distinct crop-only regions exactly once by SHA with fixed model and no credentials",()=>{
    const ids=["RB-PDF-12:page-001-region-01","RB-PDF-12:page-001-region-02",
      "RB-PDF-13:page-002-region-01"];
    const queue=fakeQueue(ids,["CROP_READY_NO_GRAPH","CROP_READY_NO_GRAPH",
      "GRAPH_READY_FOR_HUMAN_REVIEW"]);
    const proof=[fakeProof(ids[0],50,"a".repeat(64),1000),
      fakeProof(ids[1],51,"b".repeat(64),2000),null];
    const one=compileGraphBatchPlan(queue,proof,{maxRequests:1,maxTotalBytes:10000});
    expect(one.counts).toEqual({discovered:3,eligible:1,excluded:2,alreadyHasGraph:1,
      blocked:0,limitExcluded:1});
    expect(one.planned[0]).toMatchObject({id:ids[0],cropSha256:"a".repeat(64),cropBytes:1000});
    expect(one.excluded.map(x=>x.reason)).toEqual(["EXCEEDS_BATCH_LIMIT","ALREADY_HAS_GRAPH"]);
    const attempted=compileGraphBatchPlan(queue,[
      {...proof[0],priorAttemptBlocked:true},proof[1],null
    ],{maxRequests:2});
    expect(attempted.planned.map(x=>x.id)).toEqual([ids[1]]);
    expect(attempted.excluded[0].reason).toBe("PRIOR_ATTEMPT_OR_OUTPUT_PRESENT");
    expect(one.priceEstimate).toBe(null);
    expect(one.providerRequestsIssued).toBe(0);
    const same=compileGraphBatchPlan(queue,proof,{maxRequests:1,maxTotalBytes:10000});
    expect(same.planSha256).toBe(one.planSha256);
    const bigger=compileGraphBatchPlan(queue,proof,{maxRequests:2,maxTotalBytes:10000});
    expect(bigger.planSha256).not.toBe(one.planSha256);
    expect(bigger.planned).toHaveLength(2);
    const publicView=publicGraphBatchSummary(one);
    expect(JSON.stringify(publicView)).not.toContain("cropSha256");
    expect(JSON.stringify(publicView)).not.toContain("resultPath");
    expect(publicView.items[0].status).toBe("WAITING_FOR_AUTHORIZATION");
  });
  it("rejects approval forged as verified, corrupted source identity or duplicate IDs",()=>{
    const id="RB-PDF-12:page-001-region-01",q=fakeQueue([id],["CROP_READY_NO_GRAPH"]);
    const p=fakeProof(id,50,"a".repeat(64));
    for(const forged of [
      {...p,graphVerified:true},
      {...p,sourcePhysicalPage1Based:999},
      {...p,cropSha256:"not-a-sha"},
      {...p,authority:"HUMAN_VERIFIED"},
      {...p,byteLength:0}
    ])expect(()=>compileGraphBatchPlan(q,[forged])).toThrow(BatchPlanError);
    expect(()=>compileGraphBatchPlan(fakeQueue([id,id],[
      "CROP_READY_NO_GRAPH","CROP_READY_NO_GRAPH"]),[p,p])).toThrow(BatchPlanError);
  });
  it("rejects duplicate image SHA, excess request bytes, and invalid operator limits",()=>{
    const ids=["RB-PDF-12:page-001-region-01","RB-PDF-13:page-001-region-01"];
    const queue=fakeQueue(ids,["CROP_READY_NO_GRAPH","CROP_READY_NO_GRAPH"]);
    const proofs=[fakeProof(ids[0],50,"a".repeat(64)),
      fakeProof(ids[1],51,"a".repeat(64))];
    const duplicatePlan=compileGraphBatchPlan(queue,proofs);
    expect(duplicatePlan.counts).toMatchObject({eligible:1,excluded:1,blocked:1});
    expect(duplicatePlan.excluded[0].reason).toBe("DUPLICATE_IMAGE_SHA");
    expect(()=>compileGraphBatchPlan(queue,proofs,{maxRequests:15})).toThrow(BatchPlanError);
    expect(()=>compileGraphBatchPlan(queue,proofs,{maxTotalBytes:0})).toThrow(BatchPlanError);
    const oversized=compileGraphBatchPlan(fakeQueue([ids[0]],["CROP_READY_NO_GRAPH"]),
      [fakeProof(ids[0],50,"b".repeat(64),7_000_001)]);
    expect(oversized.counts).toMatchObject({eligible:0,blocked:1});
    expect(oversized.excluded[0].reason).toBe("EXCEEDS_PER_REQUEST_LIMIT");
  });
  it("forbids rerunning a reserved GLM request after receipt, stage or output exists",()=>withFixture(async x=>{
    const doc=structuredClone(x.regions);
    doc.fixtureId="RB-PDF-12";
    doc.pages[0].subsetPageIndex=0;doc.pages[0].sourcePhysicalPage1Based=51;
    doc.pages[0].regions[0].regionId="page-001-region-01";
    const crop=x.files.crop;
    const folder=join(x.root,"region-proposals-v1-RB-PDF-12");
    await mkdir(join(folder,"crops"),{recursive:true});
    await writeFile(join(folder,"region-proposals.json"),JSON.stringify(doc));
    await writeFile(join(folder,"crops","page-001-region-01.png"),crop);
    const first=await buildPrivateGraphBatchPlan(x.root);
    expect(first.counts).toMatchObject({discovered:2,eligible:1,alreadyHasGraph:1});
    const base="glm-cloud-v1-RB-PDF-12-page-001-region-01";
    const receipt=join(x.root,"."+base+".cloud-attempted");
    await writeFile(receipt,"RESERVED_NO_REPLAY");
    const second=await buildPrivateGraphBatchPlan(x.root);
    expect(second.counts).toMatchObject({eligible:0,blocked:1,alreadyHasGraph:1});
    expect(second.excluded.find(row=>row.id==="RB-PDF-12:page-001-region-01").reason)
      .toBe("PRIOR_ATTEMPT_OR_OUTPUT_PRESENT");
    await rm(receipt);
    const genericBatch=join(x.root,".glm-cloud-v1-RB-PDF-12-batch.cloud-attempted");
    await writeFile(genericBatch,"PREVIOUS_BATCH_ATTEMPT");
    const third=await buildPrivateGraphBatchPlan(x.root);
    expect(third.counts.eligible).toBe(0);
    await rm(genericBatch);
    await mkdir(join(x.root,"."+base+"-stage"));
    const fourth=await buildPrivateGraphBatchPlan(x.root);
    expect(fourth.counts.eligible).toBe(0);
  }));
  it("read-only HTTP plan requires capability and rejects request bodies or query parameters",()=>withFixture(async x=>{
    const off=await startAnnotationServer();
    try{expect((await send(off,"/api/private-graph/batch/plan")).status).toBe(404);}
    finally{await off.close();}
    const app=await startAnnotationServer({privateGraphRoot:x.root,graphAccessToken:token});
    try{
      const path="/api/private-graph/batch/plan";
      expect((await send(app,path,{auth:false})).status).toBe(403);
      expect((await send(app,path,{origin:"https://attacker.invalid"})).status).toBe(403);
      expect((await send(app,path,{method:"POST",body:{approve:true}})).status).toBe(405);
      expect((await send(app,path+"?approve=true")).status).toBe(400);
      const res=await send(app,path);
      expect(res.status).toBe(200);
      expect(res.value).toMatchObject({authority:"PREVIEW_ONLY_NO_PROVIDER_DISPATCH",
        counts:{discovered:1,eligible:0},dispatchEnabled:false,
        providerRequestsIssued:0,needsExplicitPaidAuthorization:true});
      expect(res.bytes.toString("utf8")).not.toContain("合成客户端");
      expect(res.bytes.toString("utf8")).not.toContain("pngBase64");
    }finally{await app.close();}
  }));
});
