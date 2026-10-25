"""Synthetic-only visual triage tests: never call GLM, never read user books."""
from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b03_b15_blind_visual_triage_v14 as stage
from ebook_private_glm_visual_reference import VisualGateError


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fixture(root):
    p=root/"semantic_gate"/"multibook_matrix_20261023"/"b03_b15_source_hidpi_v13"
    p.mkdir(parents=True)
    pages=[]
    for book,page in (("B03",67),("B15",109)):
        tiles=[]
        for row in range(1,4):
            for col in range(1,4):
                region=f"R{row}C{col}"
                filename=f"{book}_p{page:04d}_{region}.private.png"
                with BytesIO() as out:
                    image=Image.new("RGB",(120,140),(250,245,230))
                    image.save(out,format="PNG")
                    raw=out.getvalue()
                (p/filename).write_bytes(raw)
                tiles.append({"region":region,"filename":filename,
                              "sha256_private":sha(raw)})
        pages.append({"book_id":book,"physical_page":page,"region_tiles":tiles})
    receipt={
      "schema_version":13,"pages":2,"tiles":18,
      "evidence":"SHA_BOUND_SOURCE_ONLY_HIDPI_TILES_NO_REFERENCE_NO_CER",
      "gold_reference":None,"reviewer_approval":None,"cer":None,
      "ocr_or_model_calls":0,"source_pages":pages,
    }
    (p/stage.SOURCE_REPORT).write_text(json.dumps(receipt),encoding="utf-8")
    return p


def fake_response(_raw,_prompt,_book,_region):
    return json.dumps({"transcription":"ONLY_SYNTHETIC_CHARACTERS",
                       "uncertainties":["NOT_SURE"],
                       "visual_flags":["SOURCE_ONLY"]})


class BlindSourceVisionTests(unittest.TestCase):
    def test_source_only_precheck_no_cloud_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); fixture(root)
            result=stage.execute(root,mode="check")
            self.assertEqual(result["calls"],0)
            self.assertEqual(result["completed"],0)
            self.assertFalse(result["gold"])
            self.assertFalse((root/"semantic_gate"/"multibook_matrix_20261023"/stage.SUBDIR).exists())

    def test_four_source_only_bounded_candidates_and_readonly_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            calls=[]
            def observe(raw,prompt,book,region):
                calls.append((book,region,prompt))
                self.assertNotIn("MinerU",prompt)
                self.assertNotIn("RapidOCR",prompt)
                self.assertLessEqual(len(raw),stage.MAX_IMAGE_BYTES)
                return fake_response(raw,prompt,book,region)
            result=stage.execute(root,mode="write",vision_call=observe)
            self.assertEqual((result["completed"],result["calls"]),(4,4))
            self.assertEqual(len(calls),4)
            folder=root/"semantic_gate"/"multibook_matrix_20261023"/stage.SUBDIR
            self.assertEqual(len(list(folder.iterdir())),8)
            audit=stage.execute(root,mode="audit")
            self.assertEqual((audit["completed"],audit["calls"]),(4,0))
            output=json.loads((folder/"B15_p0109_R3C2.candidate.private.json").read_text("utf-8"))
            self.assertFalse(output["independent_gold_approved"])
            self.assertFalse(output["full_page_reference"])
            self.assertIsNone(output["cer"])
            self.assertFalse(output["curve_correspondence_verified"])

    def test_second_write_skips_existing_requests_without_double_charging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            stage.execute(root,mode="write",vision_call=fake_response)
            def no_repeat(*_args):
                raise AssertionError("the cloud must not be recalled")
            replay=stage.execute(root,mode="write",vision_call=no_repeat)
            self.assertEqual((replay["completed"],replay["calls"]),(4,0))

    def test_unknown_network_outcome_never_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            def loss(*_args):
                raise VisualGateError("NETWORK_OUTCOME_UNKNOWN")
            with self.assertRaisesRegex(VisualGateError,"NETWORK_OUTCOME_UNKNOWN"):
                stage.execute(root,mode="write",vision_call=loss)
            with self.assertRaisesRegex(VisualGateError,"PREVIOUS_REQUEST_OUTCOME_UNKNOWN"):
                stage.execute(root,mode="write",vision_call=fake_response)

    def test_malformed_provider_json_rejected_and_not_replayed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            with self.assertRaisesRegex(VisualGateError,"PROVIDER_JSON_INVALID"):
                stage.execute(root,mode="write",vision_call=lambda *_:'{"transcription":"a"')
            with self.assertRaisesRegex(VisualGateError,"PREVIOUS_REQUEST_OUTCOME_UNKNOWN"):
                stage.execute(root,mode="write",vision_call=fake_response)

    def test_changed_other_unselected_tile_rejected_before_cloud(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); folder=fixture(root)
            (folder/"B15_p0109_R1C1.private.png").write_bytes(b"BAD")
            called=[]
            with self.assertRaisesRegex(VisualGateError,"TILE_TAMPERED"):
                stage.execute(root,mode="write",vision_call=lambda *_:called.append(1))
            self.assertEqual(called,[])

    def test_duplicate_or_invalid_v13_source_report_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=fixture(root)
            path=folder/stage.SOURCE_REPORT
            record=json.loads(path.read_text("utf-8"))
            record["gold_reference"]="FAKE_APPROVAL"
            path.write_text(json.dumps(record),encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"V13_AUTHORITY_INVALID"):
                stage.execute(root,mode="check")

    def test_response_schema_bounded_and_strict(self):
        with self.assertRaisesRegex(VisualGateError,"PROVIDER_SCHEMA_INVALID"):
            stage.parse_response('{"transcription":"X","uncertainties":[],"visual_flags":[],"gold":true}')
        with self.assertRaisesRegex(VisualGateError,"PROVIDER_SCHEMA_INVALID"):
            stage.parse_response(json.dumps({"transcription":"X","uncertainties":["a"*141],"visual_flags":[]}))
        self.assertEqual(stage.parse_response(fake_response(None,None,None,None))["visual_flags"],
                         ["SOURCE_ONLY"])


    def test_inventory_zero_calls_partial_unknown_after_transport_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            self.assertEqual(stage.private_inventory(root),
                             {"completed":0,"unknown":0,"not_started":4})
            def charged_unknown(*_args):
                raise VisualGateError("SYNTHETIC_REQUEST_OUTCOME_UNKNOWN")
            with self.assertRaisesRegex(VisualGateError,"SYNTHETIC_REQUEST_OUTCOME_UNKNOWN"):
                stage.execute(root,mode="write",vision_call=charged_unknown)
            self.assertEqual(stage.private_inventory(root),
                             {"completed":0,"unknown":1,"not_started":3})

    def test_inventory_complete_read_only_and_no_private_text_in_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            stage.execute(root,mode="write",vision_call=fake_response)
            inv=stage.private_inventory(root)
            self.assertEqual(inv,{"completed":4,"unknown":0,"not_started":0})
            self.assertNotIn("ONLY_SYNTHETIC_CHARACTERS",json.dumps(inv))

    def test_inventory_rejects_orphan_and_tampered_unknown_journal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            dest=root/"semantic_gate"/"multibook_matrix_20261023"/stage.SUBDIR
            dest.mkdir()
            (dest/"B03_p0067_R1C2.candidate.private.json").write_text("{}",encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"ORPHANED_CANDIDATE"):
                stage.private_inventory(root)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            def fail(*_args):
                raise VisualGateError("SYNTHETIC_TRANSPORT_UNKNOWN")
            with self.assertRaises(VisualGateError):
                stage.execute(root,mode="write",vision_call=fail)
            journal=root/"semantic_gate"/"multibook_matrix_20261023"/stage.SUBDIR/"B03_p0067_R1C2.attempt.private.json"
            j=json.loads(journal.read_text("utf-8"))
            j["source_tile_sha256_private"]="f"*64
            journal.write_text(json.dumps(j),encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"ATTEMPT_FENCE_INVALID"):
                stage.private_inventory(root)

if __name__=="__main__":
    unittest.main()
