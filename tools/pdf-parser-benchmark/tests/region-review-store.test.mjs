import {describe,it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createRegionReviewDraft,regionReviewDraftFilename} from "../annotation/region-graph-review.mjs";
import {readRegionReviewDraft,saveRegionReviewDraft,RegionStoreError} from "../annotation/region-review-store.mjs";
const hash=x=>x.repeat(64);
const view=(fixtureId="RB-PDF-13",regionId="page-002-region-01",physicalPage=127,resultSha256=hash("c"))=>({
  fixtureId,regionId,physicalPage,resultSha256,cropSha256:hash("a"),
  manifestSha256:hash("b"),graphVerified:false,reviewStatus:"NOT_REVIEWED",
  nodes:[{id:"n1"}],edges:[{id:"e1"}],
});
const temp=async work=>{const root=await mkdtemp(join(tmpdir(),"acs-multiregion-review-"));
 try{await work(root);}finally{await rm(root,{recursive:true,force:true});}};
const deny=async(p,code)=>{try{await p;throw Error("DID_NOT_REJECT");}
 catch(e){expect(e).toBeInstanceOf(RegionStoreError);expect(e.code).toBe(code);}};
describe("03E-03 private multi-region draft store, synthetic and offline",()=>{
  it("reads absent draft and atomically creates a strictly unattested draft",()=>temp(async root=>{
    const v=view(),d=createRegionReviewDraft(v);
    expect(await readRegionReviewDraft(root,v)).toEqual({draft:null,revision:null});
    const saved=await saveRegionReviewDraft(root,v,d,null);
    expect(saved).toMatchObject({status:"REVIEW_DRAFT_UNATTESTED",humanVerified:false,graphVerified:false});
    const loaded=await readRegionReviewDraft(root,v);
    expect(loaded.revision).toBe(saved.revision);
    expect(loaded.draft).toMatchObject({fixtureId:v.fixtureId,physicalPage:127,
      regionId:v.regionId,graphVerified:false,humanVerified:false});
  }));
  it("keeps P51 and P127 independent and result SHA changes never reuse a draft",()=>temp(async root=>{
    const v1=view(),v2=view("RB-PDF-12","page-001-region-01",51,hash("d"));
    const d1=createRegionReviewDraft(v1),d2=createRegionReviewDraft(v2);
    d1.decisions[0].decision="VISIBLE_MATCH";
    d2.decisions[0].decision="UNCERTAIN";
    await saveRegionReviewDraft(root,v1,d1,null);
    await saveRegionReviewDraft(root,v2,d2,null);
    expect((await readRegionReviewDraft(root,v1)).draft.decisions[0].decision).toBe("VISIBLE_MATCH");
    expect((await readRegionReviewDraft(root,v2)).draft.decisions[0].decision).toBe("UNCERTAIN");
    expect((await readRegionReviewDraft(root,{...v1,resultSha256:hash("e")})).revision).toBe(null);
    expect(regionReviewDraftFilename(v1)).not.toBe(regionReviewDraftFilename(v2));
  }));
  it("rejects revision conflict; a stale tab cannot overwrite a newer review",()=>temp(async root=>{
    const v=view(),a=createRegionReviewDraft(v),first=await saveRegionReviewDraft(root,v,a,null);
    a.decisions[1].decision="VISIBLE_MISMATCH";
    const second=await saveRegionReviewDraft(root,v,a,first.revision);
    await deny(saveRegionReviewDraft(root,v,a,first.revision),"REGION_STORE_REVISION_CONFLICT");
    expect((await readRegionReviewDraft(root,v)).revision).toBe(second.revision);
  }));
  it("serializes competing writers through exclusive lockfile across call sites",()=>temp(async root=>{
    const v=view(),d=createRegionReviewDraft(v);
    const results=await Promise.allSettled([
      saveRegionReviewDraft(root,v,d,null),saveRegionReviewDraft(root,v,d,null),
    ]);
    expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(x=>x.status==="rejected")).toHaveLength(1);
    expect(["REGION_STORE_LOCKED","REGION_STORE_REVISION_CONFLICT"])
      .toContain(results.find(x=>x.status==="rejected").reason.code);
    expect((await readRegionReviewDraft(root,v)).revision).toMatch(/^[0-9a-f]{64}$/);
  }));
  it("refuses forged human certification and cross-result draft takeover",()=>temp(async root=>{
    const v=view(),d=createRegionReviewDraft(v);
    d.humanVerified=true;
    await deny(saveRegionReviewDraft(root,v,d,null),"REGION_STORE_DRAFT_INVALID");
    d.humanVerified=false;d.resultSha256=hash("d");
    await deny(saveRegionReviewDraft(root,v,d,null),"REGION_STORE_DRAFT_INVALID");
    expect((await readRegionReviewDraft(root,v)).revision).toBe(null);
  }));
  it("refuses symlink draft and stale lock without deleting either",()=>temp(async root=>{
    const v=view(),d=createRegionReviewDraft(v);
    const dir=join(root,"private-region-reviews-v1");
    await mkdir(dir);
    const target=join(dir,regionReviewDraftFilename(v));
    const outside=join(root,"untrusted.txt");
    await writeFile(outside,JSON.stringify(d));
    await symlink(outside,target);
    await deny(readRegionReviewDraft(root,v),"REGION_STORE_FILE_UNSAFE");
    await deny(saveRegionReviewDraft(root,v,d,null),"REGION_STORE_FILE_UNSAFE");
    await rm(target);
    const lock=target+".lock";await writeFile(lock,"LOCKED_MANUAL_RECOVERY");
    await deny(saveRegionReviewDraft(root,v,d,null),"REGION_STORE_LOCKED");
    expect((await readFile(lock,"utf8")).toString()).toBe("LOCKED_MANUAL_RECOVERY");
  }));
});
