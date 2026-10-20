"""Synthetic-only tests; never touches users' D: private books, pixels or models."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
from private_region_proposals import (
    RegionBlocked, rectangle_iou, constrain_region, select_regions, source_images,
)
from vision_graph_proposal_contract import (
    SuggestionBlocked, validate_candidate, empty_template,
)


def sha(blob): return hashlib.sha256(blob).hexdigest()


def provenance():
    return {
        "schemaVersion":"acs-pdf-private-region-evidence-v1",
        "fixtureId":"RB-PDF-13",
        "allRegionsAreUnverified":True,
        "noSemanticGraphClaims":True,
        "pages":[{
            "sourcePhysicalPage1Based":127,
            "regions":[{
                "regionId":"page-002-region-01",
                "cropSha256":"a"*64,
                "bboxPixels":[200,300,300,200],
                "proposalStatus":"UNVERIFIED_REGION_SUGGESTION",
                "nodes":None,"directedEdges":None,"timingRelations":None,
            }],
        }],
    }


def proposed():
    return {
        "schemaVersion":"acs-vision-graph-proposal-v1",
        "fixtureId":"RB-PDF-13",
        "regionId":"page-002-region-01",
        "sourceCropSha256":"a"*64,
        "coordinateSpace":"REGION_CROP_TOP_LEFT_PIXELS",
        "graphStatus":"PROPOSED_UNVERIFIED",
        "reviewStatus":"NOT_REVIEWED",
        "humanVerified":False,
        "nodes":[
            {"id":"n1","label":"left","bboxCropPixels":[10,20,70,45],
             "proposalConfidence":.6,"reviewStatus":"NOT_REVIEWED"},
            {"id":"n2","label":"right","bboxCropPixels":[150,20,75,45],
             "proposalConfidence":.5,"reviewStatus":"NOT_REVIEWED"},
        ],
        "edges":[{
            "id":"e1","fromNodeId":"n1","toNodeId":"n2",
            "direction":"FROM_TO_SUGGESTED","arrowTipCropPixels":[148,45],
            "shaftCropPixels":[[100,45],[140,45]],
            "proposalConfidence":.4,"reviewStatus":"NOT_REVIEWED",
        }],
    }


class RegionSelectionTest(unittest.TestCase):
    def test_rectangle_iou(self):
        self.assertEqual(rectangle_iou((0,0,10,10),(20,20,10,10)),0)
        self.assertAlmostEqual(rectangle_iou((0,0,10,10),(0,0,10,10)),1)

    def test_clamp_bounds(self):
        self.assertEqual(constrain_region((2,3,40,30),100,100,8),(0,0,50,41))
        self.assertIsNone(constrain_region((200,200,30,30),100,100))

    def test_suppress_duplicate_candidates_and_cap(self):
        raw=[(50,50,310,290),(55,53,308,288),
             (500,500,260,250),(810,810,100,100)]
        result=select_regions(raw,1000,1000,cap=2)
        self.assertEqual(len(result),2)
        self.assertTrue(all(result[0] != y for y in result[1:]))

    def test_reject_tiny_and_full_page_boxes(self):
        self.assertEqual(select_regions([(10,10,10,10),(0,0,1000,1000)],1000,1000),[])

    def test_invalid_budget(self):
        with self.assertRaises(RegionBlocked):
            select_regions([],100,100,cap=0)


class SourceIntegrityTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.fixture="RB-PDF-13"
        base=self.root/"reports"/"real-mineru-39440805765-1"
        self.evid=base/"figure-evidence-v1-RB-PDF-13"
        (self.evid/"pages").mkdir(parents=True)
        (self.root/"fixtures").mkdir()
        self.pdf=self.root/"fixtures"/"RB-PDF-13.pdf"
        self.md=base/"RB-PDF-13.md"
        self.png=self.evid/"pages"/"page-002.png"
        self.pdf.write_bytes(b"FAKE-PDF")
        self.md.write_bytes(b"FAKE-MD")
        self.png.write_bytes(b"FAKE-PNG")
        self.record={
            "schemaVersion":"acs-mineru-figure-page-evidence-v1",
            "sourceRun":"real-mineru-39440805765-1",
            "fixtureId":self.fixture,
            "sourcePages1Based":[51,127,379],
            "claim":"PERSISTED_FULL_PAGE_VISUAL_FALLBACK_ONLY",
            "noCroppedFigureOrDiagramRelationshipClaim":True,
            "sourceSubsetSha256":sha(self.pdf.read_bytes()),
            "sourceMarkdownSha256":sha(self.md.read_bytes()),
            "images":[{
                "subsetPageIndex":1,"sourcePhysicalPage1Based":127,
                "relativeImagePath":"pages/page-002.png",
                "imageBytes":8,
                "imageSha256":sha(self.png.read_bytes()),
                "widthPixels":500,"heightPixels":700,
                "sourceFigureBlockRefs":["doc:abcdef01/tier:flash/page:2/block:1"],
                "regionType":"FULL_PAGE_UNCROPPED",
                "graphSemantics":"NOT_VERIFIED",
                "figureRegionBounds":None,"diagramEdges":None,
            }],
        }
        self.save()

    def save(self):
        (self.evid/"figure-evidence.json").write_text(json.dumps(self.record),encoding="utf-8")

    def test_valid_provenance(self):
        self.assertEqual(source_images(self.root,self.fixture)[0]["physicalPage"],127)

    def test_altered_png_fails_closed(self):
        self.png.write_bytes(b"ALTERED!")
        with self.assertRaises(RegionBlocked):
            source_images(self.root,self.fixture)

    def test_forged_physical_page_rejected(self):
        self.record["images"][0]["sourcePhysicalPage1Based"]=379
        self.save()
        with self.assertRaises(RegionBlocked):
            source_images(self.root,self.fixture)

    def test_path_traversal_rejected(self):
        self.record["images"][0]["relativeImagePath"]="../../etc.txt"
        self.save()
        with self.assertRaises(RegionBlocked):
            source_images(self.root,self.fixture)

    def test_fake_verified_edges_rejected(self):
        self.record["images"][0]["graphSemantics"]="VERIFIED"
        self.save()
        with self.assertRaises(RegionBlocked):
            source_images(self.root,self.fixture)


class VisionProposalTest(unittest.TestCase):
    def test_valid_unreviewed_proposal_maps_to_page(self):
        result=validate_candidate(proposed(),provenance())
        self.assertFalse(result["graphVerified"])
        self.assertEqual(result["mappedNodes"][0]["bboxPagePixels"],[210,320,70,45])
        self.assertEqual(result["mappedEdges"][0]["arrowTipPagePixels"],[348,345])

    def test_empty_templates_do_not_fabricate_graph(self):
        items=empty_template(provenance())
        self.assertEqual(len(items),1)
        self.assertEqual(items[0]["nodes"],[])
        self.assertEqual(items[0]["edges"],[])

    def test_unsupported_status_rejected(self):
        val=proposed();val["humanVerified"]=True
        with self.assertRaises(SuggestionBlocked):validate_candidate(val,provenance())
        val=proposed();val["graphStatus"]="VERIFIED"
        with self.assertRaises(SuggestionBlocked):validate_candidate(val,provenance())

    def test_sha_page_and_node_bounds_rejected(self):
        p=proposed();p["sourceCropSha256"]="b"*64
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())
        p=proposed();p["nodes"][0]["bboxCropPixels"]=[290,190,30,30]
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())

    def test_invented_endpoint_or_arrow_without_evidence_rejected(self):
        p=proposed();p["edges"][0]["toNodeId"]="unknown"
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())
        p=proposed();p["edges"][0]["arrowTipCropPixels"]=[900,20]
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())
        p=proposed();del p["edges"][0]["shaftCropPixels"]
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())

    def test_invalid_relation_direction_rejected(self):
        p=proposed();p["edges"][0]["direction"]="CERTIFIED"
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())

    def test_duplicate_node_and_self_edge_rejected(self):
        p=proposed();p["nodes"][1]["id"]="n1"
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())
        p=proposed();p["edges"][0]["toNodeId"]="n1"
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())

    def test_strict_confidence_and_control_chars(self):
        p=proposed();p["nodes"][0]["proposalConfidence"]=1.5
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())
        p=proposed();p["nodes"][0]["label"]="bad\nlabel"
        with self.assertRaises(SuggestionBlocked):validate_candidate(p,provenance())


if __name__=="__main__":
    unittest.main()
