import { describe,it,expect } from "vitest";
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { startAnnotationServer } from "../annotation/server.mjs";
import { createGraphReviewDraft } from "../annotation/graph-review.mjs";
import { verifyAutoGraphBundle } from "../annotation/graph-review-auto.mjs";
import {
 PRIVATE_FILENAMES,readPrivateP127Bundle,readPrivateP127Draft,writePrivateP127Draft,
 listPrivateGraphReviewQueue,PrivateGraphError,
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
