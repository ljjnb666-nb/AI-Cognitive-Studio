import {describe,it,expect} from "vitest";
import {
  validateRegionRegistration,validateRegionGraphCandidate,
  createRegionReviewDraft,parseRegionReviewDraft,updateRegionReviewDraft,
  regionReviewProgress,regionReviewDraftFilename,GraphReviewError
} from "../annotation/region-graph-review.mjs";
const hash = letter => letter.repeat(64);
const input = () => {
  const cropSha=hash("a"), manifestSha=hash("b"), resultSha=hash("c");
  const nodes=[
    {id:"n1",label:"客户端",bboxCropPixels:[10,20,50,30],proposalConfidence:.6,reviewStatus:"NOT_REVIEWED"},
    {id:"n2",label:"服务器",bboxCropPixels:[120,25,55,35],proposalConfidence:.5,reviewStatus:"NOT_REVIEWED"},
  ];
  const edges=[
    {id:"e1",fromNodeId:"n1",toNodeId:"n2",direction:"UNKNOWN",arrowTipCropPixels:[110,45],
      shaftCropPixels:[[75,45],[104,45]],proposalConfidence:.4,reviewStatus:"NOT_REVIEWED"},
  ];
  const manifest={schemaVersion:"acs-pdf-private-region-evidence-v1",
    sourceRun:"real-mineru-39440805765-1",fixtureId:"RB-PDF-13",
    allRegionsAreUnverified:true,noSemanticGraphClaims:true,
    pages:[{subsetPageIndex:1,sourcePhysicalPage1Based:127,regions:[{regionId:"page-002-region-01",
      proposalStatus:"UNVERIFIED_REGION_SUGGESTION",nodes:null,directedEdges:null,timingRelations:null,
      cropSha256:cropSha,bboxPixels:[100,200,200,100]}]}]};
  const proposal={schemaVersion:"acs-vision-graph-proposal-v1",fixtureId:"RB-PDF-13",
    regionId:"page-002-region-01",sourceCropSha256:cropSha,
    coordinateSpace:"REGION_CROP_TOP_LEFT_PIXELS",graphStatus:"PROPOSED_UNVERIFIED",
    reviewStatus:"NOT_REVIEWED",humanVerified:false,nodes,edges};
  const mappedPageEvidence={regionId:"page-002-region-01",sourcePhysicalPage1Based:127,
    sourceCropSha256:cropSha,graphVerified:false,needsIndependentHumanReview:true,
    mappedNodes:nodes.map(n=>({id:n.id,bboxPagePixels:[100+n.bboxCropPixels[0],200+n.bboxCropPixels[1],n.bboxCropPixels[2],n.bboxCropPixels[3]],
      sourcePhysicalPage1Based:127,claim:"MACHINE_SUGGESTION_NOT_VERIFIED"})),
    mappedEdges:edges.map(e=>({id:e.id,arrowTipPagePixels:[100+e.arrowTipCropPixels[0],200+e.arrowTipCropPixels[1]],
      shaftPagePixels:e.shaftCropPixels.map(p=>[100+p[0],200+p[1]]),
      sourcePhysicalPage1Based:127,claim:"GEOMETRIC_WITNESS_AND_RELATION_UNVERIFIED"}))};
  const result={schemaVersion:"acs-glm-cloud-vision-proposal-v1",
    sourceRun:"real-mineru-39440805765-1",fixtureId:"RB-PDF-13",provider:"ZHIPU_GLMCLOUD_STANDARD_API",
    model:"glm-5.3-flash",attemptClass:"EXPLICIT_P127_SECOND_ATTEMPT",
    transferScope:"EXPLICITLY_SELECTED_CROP_IMAGES_ONLY",
    sourceRegionManifestSha256:manifestSha,reviewStatus:"NOT_REVIEWED",graphVerified:false,
    results:[{regionId:"page-002-region-01",sourcePhysicalPage1Based:127,cropSha256:cropSha,
      proposal,mappedPageEvidence,humanReviewStatus:"NOT_REVIEWED",graphVerified:false}]};
  return {result,manifest,identity:{cropSha256:cropSha,manifestSha256:manifestSha,resultSha256:resultSha,cropWidth:200,cropHeight:100}};
};
describe("03E-03 generic registered graph candidate, synthetic only",()=>{
  it("preserves exact P127 source and every mapped page coordinate",()=>{
    const v=validate();
    expect(v).toMatchObject({fixtureId:"RB-PDF-13",physicalPage:127,
      regionId:"page-002-region-01",graphVerified:false,reviewStatus:"NOT_REVIEWED"});
    expect(v.nodes).toHaveLength(2);expect(v.edges).toHaveLength(1);
    expect(v.edges[0].tip).toEqual([110,45]);
  });
  it("accepts another registered book and page without copying P127 constants",()=>{
    const {x,reg}=fixture12();const v=validate(x,reg);
    expect(v).toMatchObject({fixtureId:"RB-PDF-12",physicalPage:51,
      regionId:"page-001-region-01",graphVerified:false});
    expect(v.nodes[0].box).toEqual([10,20,50,30]);
  });
  it("rejects model attempting fixture/page/region/attempt substitution",()=>{
    const changes=[
      [x=>x.result.fixtureId="RB-PDF-12","GRAPH_RESULT_IDENTITY_MISMATCH"],
      [x=>x.result.attemptClass="WRONG_ATTEMPT","GRAPH_RESULT_IDENTITY_MISMATCH"],
      [x=>x.result.provider="OTHER","GRAPH_RESULT_IDENTITY_MISMATCH"],
      [x=>x.result.graphVerified=true,"GRAPH_RESULT_IDENTITY_MISMATCH"],
      [x=>x.result.results[0].regionId="page-001-region-01","GRAPH_UNVERIFIED_CONTRACT_INVALID"],
      [x=>x.result.results[0].sourcePhysicalPage1Based=51,"GRAPH_UNVERIFIED_CONTRACT_INVALID"],
      [x=>x.manifest.fixtureId="RB-PDF-12","GRAPH_MANIFEST_INVALID"],
      [x=>x.manifest.pages[0].sourcePhysicalPage1Based=51,"GRAPH_CROP_EVIDENCE_MISMATCH"],
      [x=>x.manifest.pages[0].subsetPageIndex=0,"REGION_GRAPH_MANIFEST_REGION_INVALID"],
      [x=>x.manifest.pages.push(x.manifest.pages[0]),"REGION_GRAPH_MANIFEST_PAGE_INVALID"],
      [x=>x.result.results[0].proposal.humanVerified=true,"GRAPH_UNVERIFIED_CONTRACT_INVALID"],
      [x=>x.result.results[0].mappedPageEvidence.graphVerified=true,"GRAPH_UNVERIFIED_CONTRACT_INVALID"],
    ];
    for(const [change,code] of changes){
      const x=input();change(x);throws(()=>validate(x),code);
    }
  });
  it("rejects forged source SHAs and unregistered crop/result",()=>{
    const x=input(),reg=registration();reg.expectedCropSha256=hash("e");
    throws(()=>validate(x,reg),"REGION_GRAPH_PINNED_CROP_MISMATCH");
    const reg2=registration();reg2.expectedResultSha256=hash("d");
    throws(()=>validate(x,reg2),"REGION_GRAPH_PINNED_RESULT_MISMATCH");
    const reg3=registration();reg3.model="malicious";
    throws(()=>validateRegionRegistration(reg3),"REGION_GRAPH_REGISTRATION_INVALID");
    const reg4=registration();reg4.regionId="../private";
    throws(()=>validateRegionRegistration(reg4),"REGION_GRAPH_REGISTRATION_INVALID");
  });
  it("rejects invented arrows, shifted page evidence, duplicate IDs and confidence forgery",()=>{
    const cases=[
      [x=>x.result.results[0].proposal.nodes[0].bboxCropPixels=[185,20,50,30],"GRAPH_NODE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].proposal.nodes[0].proposalConfidence=5,"GRAPH_NODE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].proposal.nodes[1].id="n1","GRAPH_NODE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].mappedPageEvidence.mappedNodes[0].bboxPagePixels=[111,220,50,30],"GRAPH_NODE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].proposal.edges[0].toNodeId="n3","GRAPH_EDGE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].proposal.edges[0].arrowTipCropPixels=[999,45],"GRAPH_EDGE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].proposal.edges[0].direction="VERIFIED","GRAPH_EDGE_OR_MAPPING_INVALID"],
      [x=>x.result.results[0].mappedPageEvidence.mappedEdges[0].claim="CERTIFIED","GRAPH_EDGE_OR_MAPPING_INVALID"],
    ];
    for(const [change,code] of cases){const x=input();change(x);throws(()=>validate(x),code);}
  });
  it("draft names are unique by book, region and full 256-bit result SHA",()=>{
    const v1=validate(),{x,reg}=fixture12(),v2=validate(x,reg);
    expect(regionReviewDraftFilename(v1)).toContain("RB-PDF-13-page-002-region-01-"+hash("c"));
    expect(regionReviewDraftFilename(v2)).toContain("RB-PDF-12-page-001-region-01-"+hash("d"));
    expect(regionReviewDraftFilename(v1)).not.toBe(regionReviewDraftFilename(v2));
    const v3={...v1,resultSha256:hash("e")};
    expect(regionReviewDraftFilename(v3)).not.toBe(regionReviewDraftFilename(v1));
  });
  it("each draft starts unreviewed and never grants semantic verification",()=>{
    const v=validate(),d=createRegionReviewDraft(v);
    expect(d).toMatchObject({status:"REVIEW_DRAFT_UNATTESTED",graphVerified:false,humanVerified:false,
      physicalPage:127,regionId:v.regionId});
    expect(regionReviewProgress(d,v)).toMatchObject({total:3,reviewed:0,certified:false});
    const next=updateRegionReviewDraft(d,v,"edge","e1","UNCERTAIN","箭头尖端不清");
    expect(regionReviewProgress(next,v)).toMatchObject({total:3,reviewed:1,uncertain:1,certified:false});
    expect(d.decisions[2].decision).toBe("UNREVIEWED");
  });
  it("blocks cross-book, cross-page, cross-result and fake approvals",()=>{
    const v=validate(),{x,reg}=fixture12(),v2=validate(x,reg);
    const base=createRegionReviewDraft(v);
    throws(()=>parseRegionReviewDraft(base,v2),"GRAPH_REVIEW_LINEAGE_INVALID");
    const forged=[
      d=>d.fixtureId="RB-PDF-12",d=>d.physicalPage=51,
      d=>d.resultSha256=hash("f"),d=>d.cropSha256=hash("e"),
      d=>d.humanVerified=true,d=>d.graphVerified=true,d=>d.status="VERIFIED"
    ];
    for(const mutate of forged){
      const d=createRegionReviewDraft(v);mutate(d);
      throws(()=>parseRegionReviewDraft(d,v),"GRAPH_REVIEW_LINEAGE_INVALID");
    }
  });
  it("rejects duplicate decisions, fake IDs, invalid notes and out-of-range status",()=>{
    const v=validate();
    const cases=[
      [d=>d.decisions[1].id="n1","GRAPH_DECISION_INVALID"],
      [d=>d.decisions[0].decision="APPROVED","GRAPH_DECISION_INVALID"],
      [d=>d.decisions[0].note="should not note unreviewed","GRAPH_DECISION_INVALID"],
      [d=>{d.decisions[0].decision="UNCERTAIN";d.decisions[0].note="a".repeat(281);},"GRAPH_TEXT_INVALID"],
    ];
    for(const [fn,code] of cases){const d=createRegionReviewDraft(v);fn(d);throws(()=>parseRegionReviewDraft(d,v),code);}
    throws(()=>updateRegionReviewDraft(createRegionReviewDraft(v),v,"node","n999","VISIBLE_MATCH"),"GRAPH_DECISION_INVALID");
  });
});
