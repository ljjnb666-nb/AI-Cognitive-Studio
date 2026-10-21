import { describe,it,expect } from "vitest";
import {
  validateGraphReviewSource, createGraphReviewDraft, parseGraphReviewDraft,
  updateGraphDecision,graphReviewProgress,GraphReviewError,REVIEW_STATUS,
} from "../annotation/graph-review.mjs";

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
    pages:[{sourcePhysicalPage1Based:127,regions:[{regionId:"page-002-region-01",
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
const reject=(work,code)=>{
  try {work();throw new Error("SHOULD_HAVE_REJECTED");}
  catch(e){expect(e).toBeInstanceOf(GraphReviewError);expect(e.code).toBe(code);}
};
const view=()=>{const {result,manifest,identity}=input();return validateGraphReviewSource(result,manifest,identity);};

describe("P127 review — offline synthetic only, no private book or inference",()=>{
  it("attaches SHA, P127 origin, exact mapped page geometry and unverified status",()=>{
    const v=view();
    expect(v).toMatchObject({fixtureId:"RB-PDF-13",physicalPage:127,regionId:"page-002-region-01",
      width:200,height:100,offset:[100,200],graphVerified:false,reviewStatus:"NOT_REVIEWED"});
    expect(v.nodes.map(n=>n.id)).toEqual(["n1","n2"]);
    expect(v.edges[0]).toMatchObject({id:"e1",from:"n1",to:"n2",direction:"UNKNOWN"});
    expect(v).not.toHaveProperty("humanVerified",true);
  });
  it("rejects untrusted model authority, wrong source, stale manifest or crop",()=>{
    const cases=[
      [(x)=>x.result.graphVerified=true,"GRAPH_RESULT_IDENTITY_MISMATCH"],
      [(x)=>x.result.reviewStatus="VERIFIED","GRAPH_RESULT_IDENTITY_MISMATCH"],
      [(x)=>x.result.results[0].proposal.humanVerified=true,"GRAPH_UNVERIFIED_CONTRACT_INVALID"],
      [(x)=>x.result.results[0].proposal.graphStatus="VERIFIED","GRAPH_UNVERIFIED_CONTRACT_INVALID"],
      [(x)=>x.result.results[0].sourcePhysicalPage1Based=379,"GRAPH_UNVERIFIED_CONTRACT_INVALID"],
      [(x)=>x.manifest.pages[0].sourcePhysicalPage1Based=379,"GRAPH_CROP_EVIDENCE_MISMATCH"],
      [(x)=>x.manifest.pages[0].regions[0].cropSha256=hash("e"),"GRAPH_CROP_EVIDENCE_MISMATCH"],
      [(x)=>x.identity.manifestSha256=hash("e"),"GRAPH_RESULT_IDENTITY_MISMATCH"],
      [(x)=>x.result.attemptClass="INITIAL_ATTEMPT","GRAPH_RESULT_IDENTITY_MISMATCH"],
      [(x)=>x.result.results.push(x.result.results[0]),"GRAPH_RESULT_IDENTITY_MISMATCH"],
      [(x)=>x.manifest.pages.push(x.manifest.pages[0]),"GRAPH_REGION_NOT_UNIQUE"],
    ];
    for(const [change,code] of cases){const x=input();change(x);reject(()=>validateGraphReviewSource(x.result,x.manifest,x.identity),code);}
  });
  it("rejects invented arrow tips, coordinate displacement, duplicate IDs and spoofed claims",()=>{
    const cases=[
      [(x)=>x.result.results[0].proposal.nodes[0].bboxCropPixels=[190,20,50,30],"GRAPH_NODE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].mappedPageEvidence.mappedNodes[0].bboxPagePixels=[111,220,50,30],"GRAPH_NODE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].proposal.nodes[1].id="n1","GRAPH_NODE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].proposal.nodes[0].label="<script>\u0000</script>","GRAPH_TEXT_INVALID"],
      [(x)=>x.result.results[0].proposal.edges[0].arrowTipCropPixels=[201,45],"GRAPH_EDGE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].mappedPageEvidence.mappedEdges[0].shaftPagePixels[1][0]=999,"GRAPH_EDGE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].proposal.edges[0].direction="GUARANTEED","GRAPH_EDGE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].proposal.edges[0].toNodeId="n3","GRAPH_EDGE_OR_MAPPING_INVALID"],
      [(x)=>x.result.results[0].mappedPageEvidence.mappedEdges[0].claim="HUMAN_CERTIFIED","GRAPH_EDGE_OR_MAPPING_INVALID"],
    ];
    for(const [change,code] of cases){const x=input();change(x);reject(()=>validateGraphReviewSource(x.result,x.manifest,x.identity),code);}
  });
  it("creates exactly one draft decision for each machine candidate, never truth",()=>{
    const v=view(),d=createGraphReviewDraft(v),p=graphReviewProgress(d,v);
    expect(p).toMatchObject({total:3,reviewed:0,unreviewed:3,certified:false,status:REVIEW_STATUS});
    expect(d).toMatchObject({status:REVIEW_STATUS,humanVerified:false,graphVerified:false});
    expect(d.decisions).toEqual([
      {kind:"node",id:"n1",decision:"UNREVIEWED",note:""},
      {kind:"node",id:"n2",decision:"UNREVIEWED",note:""},
      {kind:"edge",id:"e1",decision:"UNREVIEWED",note:""},
    ]);
    const d2=updateGraphDecision(d,v,"edge","e1","VISIBLE_MISMATCH","没有看清箭头");
    const d3=updateGraphDecision(d2,v,"node","n1","VISIBLE_MATCH","");
    expect(d.decisions[2].decision).toBe("UNREVIEWED");
    expect(graphReviewProgress(d3,v)).toMatchObject({total:3,reviewed:2,match:1,mismatch:1,unreviewed:1,certified:false});
    expect(JSON.stringify(d3)).not.toMatch(/"VERIFIED":true/);
  });
  it("rejects forged human verification, source switching, duplicate decisions and unsafe text",()=>{
    const v=view();
    const mutate=[
      [(d)=>d.humanVerified=true,"GRAPH_REVIEW_LINEAGE_INVALID"],
      [(d)=>d.status="VERIFIED","GRAPH_REVIEW_LINEAGE_INVALID"],
      [(d)=>d.resultSha256=hash("d"),"GRAPH_REVIEW_LINEAGE_INVALID"],
      [(d)=>d.decisions[1].id="n1","GRAPH_DECISION_INVALID"],
      [(d)=>d.decisions[0].kind="edge","GRAPH_DECISION_INVALID"],
      [(d)=>d.decisions[0].decision="CERTIFIED","GRAPH_DECISION_INVALID"],
      [(d)=>d.decisions[0].note="not allowed until reviewed","GRAPH_DECISION_INVALID"],
      [(d)=>{d.decisions[0].decision="UNCERTAIN";d.decisions[0].note="A".repeat(281)},"GRAPH_TEXT_INVALID"],
    ];
    for(const [change,code] of mutate){const d=createGraphReviewDraft(v);change(d);reject(()=>parseGraphReviewDraft(d,v),code);}
    reject(()=>updateGraphDecision(createGraphReviewDraft(v),v,"edge","e500","VISIBLE_MATCH"),"GRAPH_DECISION_INVALID");
  });
});
