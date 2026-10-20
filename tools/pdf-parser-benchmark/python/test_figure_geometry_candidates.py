"""No private files/models; synthetic, pure-Python geometry safety regressions."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
from figure_geometry_candidates import (
    CandidateBlocked, match_arrow_tip, validate_evidence,
)

SHA="a"*64


class GeometryTests(unittest.TestCase):
    def test_rightward_tip_with_aligned_shaft(self):
        triangle=[(120,50),(110,44),(110,56)]
        matched=match_arrow_tip(triangle,(60,50,110,50))
        self.assertIsNotNone(matched)
        self.assertEqual(matched["tip"],[120,50])
        self.assertEqual(matched["status"],"GEOMETRIC_ARROWHEAD_CANDIDATE_UNVERIFIED")

    def test_leftward_tip_with_aligned_shaft(self):
        tri=[(50,50),(60,44),(60,56)]
        x=match_arrow_tip(tri,(60,50,110,50))
        self.assertIsNotNone(x)
        self.assertEqual(x["tip"],[50,50])

    def test_no_arrow_from_plain_shaft_or_wrong_direction(self):
        tri=[(120,50),(110,44),(110,56)]
        self.assertIsNone(match_arrow_tip(tri,(110,50,160,50)))
        self.assertIsNone(match_arrow_tip(tri,(100,70,100,10)))
        self.assertIsNone(match_arrow_tip(tri,(12,12,24,24)))

    def test_no_arrow_from_degenerate_or_huge_triangle(self):
        self.assertIsNone(match_arrow_tip([(1,1),(1,1),(2,2)],(0,0,20,20)))
        self.assertIsNone(match_arrow_tip([(200,50),(1,1),(1,100)],(1,50,200,50)))
        self.assertIsNone(match_arrow_tip([(120,50),(110,44)],(60,50,110,50)))

    def test_no_arrow_with_nonpositive_gap(self):
        self.assertIsNone(match_arrow_tip([(120,50),(110,44),(110,56)],(60,50,110,50),max_gap=0))


class PrivateEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.fixture="RB-PDF-12"
        self.rdir=self.root/"reports"/"real-mineru-39440805765-1"
        self.base=self.rdir/"figure-evidence-v1-RB-PDF-12"
        (self.base/"pages").mkdir(parents=True)
        (self.root/"fixtures").mkdir()
        self.pdf=(self.root/"fixtures"/"RB-PDF-12.pdf")
        self.md=self.rdir/"RB-PDF-12.md"
        self.png=self.base/"pages"/"page-003.png"
        self.pdf.write_bytes(b"SYNTHETIC-PDF-BYTES")
        self.md.write_bytes(b"SYNTHETIC-MARKDOWN")
        self.png.write_bytes(b"SYNTHETIC-PNG-BYTES")
        self.meta={
            "schemaVersion":"acs-mineru-figure-page-evidence-v1",
            "fixtureId":self.fixture,
            "sourceRun":"real-mineru-39440805765-1",
            "sourcePages1Based":[73,145,261],
            "claim":"PERSISTED_FULL_PAGE_VISUAL_FALLBACK_ONLY",
            "noCroppedFigureOrDiagramRelationshipClaim":True,
            "sourceSubsetSha256":self.sha(self.pdf),
            "sourceMarkdownSha256":self.sha(self.md),
            "images":[{
                "subsetPageIndex":2,
                "sourcePhysicalPage1Based":261,
                "relativeImagePath":"pages/page-003.png",
                "imageBytes":self.png.stat().st_size,
                "imageSha256":self.sha(self.png),
                "widthPixels":900,
                "heightPixels":1200,
                "sourceFigureBlockRefs":["doc:abcdefab/tier:flash/page:3/block:1"],
                "regionType":"FULL_PAGE_UNCROPPED",
                "graphSemantics":"NOT_VERIFIED",
                "figureRegionBounds":None,
                "diagramEdges":None,
            }],
        }
        self.save()

    def sha(self,file):
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def save(self):
        (self.base/"figure-evidence.json").write_text(json.dumps(self.meta),encoding="utf-8")

    def test_valid_metadata(self):
        pages=validate_evidence(self.root,self.fixture)
        self.assertEqual(len(pages),1)
        self.assertEqual(pages[0]["physical"],261)

    def test_rejects_changed_pdf_or_markdown_or_png(self):
        for path in (self.pdf,self.md,self.png):
            initial=path.read_bytes()
            path.write_bytes(initial+b"X")
            with self.assertRaises(CandidateBlocked):
                validate_evidence(self.root,self.fixture)
            path.write_bytes(initial)

    def test_rejects_parent_page_mixup_and_path_escape(self):
        self.meta["images"][0]["sourcePhysicalPage1Based"]=379
        self.save()
        with self.assertRaises(CandidateBlocked):
            validate_evidence(self.root,self.fixture)
        self.meta["images"][0]["sourcePhysicalPage1Based"]=261
        self.meta["images"][0]["relativeImagePath"]="../otherfile.png"
        self.save()
        with self.assertRaises(CandidateBlocked):
            validate_evidence(self.root,self.fixture)

    def test_rejects_claimed_completed_graph(self):
        self.meta["images"][0]["graphSemantics"]="VERIFIED"
        self.save()
        with self.assertRaises(CandidateBlocked):
            validate_evidence(self.root,self.fixture)

    def test_rejects_duplicate_or_fake_ref(self):
        self.meta["images"][0]["sourceFigureBlockRefs"].append("doc:abcdefab/tier:flash/page:3/block:1")
        self.save()
        with self.assertRaises(CandidateBlocked):
            validate_evidence(self.root,self.fixture)

    def test_no_unknown_fixture(self):
        with self.assertRaises(CandidateBlocked):
            validate_evidence(self.root,"../../other")


if __name__=="__main__":
    unittest.main()
