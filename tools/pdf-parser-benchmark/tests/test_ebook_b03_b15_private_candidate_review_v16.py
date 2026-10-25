"""No-network synthetic-only test of private B03/B15 reviewer HTML and source gates."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_private_glm_visual_reference import VisualGateError
from test_ebook_b03_b15_blind_visual_triage_v14 import fake_response
from test_ebook_b15_fresh_only_resume_v15 import partial
import ebook_b03_b15_blind_visual_triage_v14 as v14
import ebook_b15_fresh_only_resume_v15 as v15
import ebook_b03_b15_private_candidate_review_v16 as stage


def three_completed(root):
    partial(root)
    assert v15.resume(root,fake_response)=={
        "completed":3,"unknown":1,"not_started":0,
    }


def folder(root):
    return root/"semantic_gate"/"multibook_matrix_20261023"


class PrivateCandidateReviewTests(unittest.TestCase):
    def test_three_candidate_one_unknown_private_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            base,artifacts,report=stage.strict_output(root)
            self.assertEqual(base,folder(root))
            self.assertEqual(set(artifacts),{stage.REPORT,stage.INDEX})
            self.assertEqual((report["v14_candidate_count"],report["v14_unknown_request_count"]),(3,1))
            self.assertEqual(report["new_model_calls"],0)
            self.assertIs(report["independent_gold_approved"],False)
            self.assertIs(report["full_page_coverage_verified"],False)
            self.assertIsNone(report["cer"])
            self.assertEqual(len(report["regions"]),4)
            self.assertEqual({r["region"] for r in report["regions"] if r["state"]=="MODEL_CANDIDATE_NOT_GOLD"},
                             {"R1C2","R1C3","R3C2"})
            self.assertEqual(len([r for r in report["regions"] if r["state"].startswith("CHARGE")]),1)
            self.assertNotIn(b"ONLY_SYNTHETIC_CHARACTERS",artifacts[stage.REPORT])
            self.assertIn(b"ONLY_SYNTHETIC_CHARACTERS",artifacts[stage.INDEX])
            self.assertNotIn(b"<script",artifacts[stage.INDEX])
            self.assertFalse((base/stage.SUBDIR).exists())

    def test_create_audit_and_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            a=stage.execute(root,write=True)
            self.assertEqual(a["v14_candidate_count"],3)
            self.assertEqual(stage.execute(root,audit=True),a)
            with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                stage.execute(root,write=True)
            private=folder(root)/stage.SUBDIR
            self.assertEqual(len(list(private.iterdir())),2)
            (private/stage.INDEX).write_bytes(b"changed")
            with self.assertRaisesRegex(VisualGateError,"TAMPERED"):
                stage.execute(root,audit=True)

    def test_html_injection_from_untrusted_model_is_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            dest=folder(root)/v14.SUBDIR/"B03_p0067_R1C2.candidate.private.json"
            item=json.loads(dest.read_text("utf-8"))
            item["candidate"]["transcription"]="<script>alert('x')</script> & <img src=x onerror=x>"
            item["candidate"]["uncertainties"]=["<b>not gold</b>"]
            item["candidate"]["visual_flags"]=["foo & bar"]
            dest.write_text(json.dumps(item,ensure_ascii=False),encoding="utf-8")
            _,outputs,_=stage.strict_output(root)
            view=outputs[stage.INDEX].decode("utf-8")
            self.assertNotIn("<script",view.lower())
            self.assertNotIn("<b>not gold</b>",view)
            self.assertIn("&lt;script&gt;",view)
            self.assertIn("&lt;b&gt;not gold&lt;/b&gt;",view)
            self.assertIn("foo &amp; bar",view)
            self.assertNotIn("onerror=x>",view)
            self.assertNotIn(b"<script",outputs[stage.REPORT])

    def test_ambiguous_B03_charge_fence_never_reclassified_as_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            target=folder(root)/v14.SUBDIR/"B03_p0067_R2C2.candidate.private.json"
            self.assertFalse(target.exists())
            _,outputs,report=stage.strict_output(root)
            self.assertFalse(target.exists())
            unknown=[r for r in report["regions"] if r["region"]=="R2C2"]
            self.assertEqual(unknown[0]["state"],"CHARGE_OUTCOME_UNKNOWN_NEVER_AUTO_RETRY")
            self.assertEqual(sum(r["state"]=="MODEL_CANDIDATE_NOT_GOLD" for r in report["regions"]),3)

    def test_source_tile_changed_fails_closed_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            target=folder(root)/v14.SOURCE_DIR/"B15_p0109_R3C2.private.png"
            target.write_bytes(b"tampered")
            with self.assertRaisesRegex(VisualGateError,"TILE_TAMPERED"):
                stage.execute(root,write=True)
            self.assertFalse((folder(root)/stage.SUBDIR).exists())

    def test_approval_flag_in_candidate_cannot_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            target=folder(root)/v14.SUBDIR/"B15_p0109_R3C2.candidate.private.json"
            record=json.loads(target.read_text("utf-8"))
            record["independent_gold_approved"]=True
            target.write_text(json.dumps(record),encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"CANDIDATE_FENCE_INVALID"):
                stage.strict_output(root)

    def test_missing_existing_candidate_rejected_not_filled_by_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);three_completed(root)
            target=folder(root)/v14.SUBDIR/"B03_p0067_R1C2.candidate.private.json"
            target.unlink()
            with self.assertRaisesRegex(VisualGateError,"EXPECTED_THREE_COMPLETE_ONE_UNKNOWN_CHANGED"):
                stage.strict_output(root)

if __name__=="__main__":
    unittest.main()
