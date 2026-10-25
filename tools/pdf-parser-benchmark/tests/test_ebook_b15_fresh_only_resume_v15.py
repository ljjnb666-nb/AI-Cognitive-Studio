"""Pure synthetic no-network gate for B15 fresh-only one-call continuation."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from test_ebook_b03_b15_blind_visual_triage_v14 import fixture, fake_response
from ebook_private_glm_visual_reference import VisualGateError
import ebook_b03_b15_blind_visual_triage_v14 as prev
import ebook_b15_fresh_only_resume_v15 as stage


def partial(root):
    fixture(root)
    counter=[0]
    def call(raw,prompt,book,region):
        counter[0]+=1
        if counter[0]==3:
            raise VisualGateError("SYNTHETIC_UNKNOWN_CHARGED_ATTEMPT")
        return fake_response(raw,prompt,book,region)
    with unittest.TestCase().assertRaisesRegex(VisualGateError,"SYNTHETIC_UNKNOWN"):
        prev.execute(root,mode="write",vision_call=call)
    assert prev.private_inventory(root)=={
        "completed":2,"unknown":1,"not_started":1,
    }


class FreshOnlyGate(unittest.TestCase):
    def test_readonly_contract_for_exact_2_1_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);partial(root)
            dest,raw,img_sha,attempt,candidate=stage.contract(root)
            self.assertEqual(dest.name,prev.SUBDIR)
            self.assertTrue(raw.startswith(b"\x89PNG"))
            self.assertEqual(len(img_sha),64)
            self.assertFalse(attempt.exists())
            self.assertFalse(candidate.exists())

    def test_resumes_only_new_b15_and_never_retries_unknown_b03(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);partial(root)
            calls=[]
            def observer(raw,prompt,book,region):
                calls.append((book,region))
                self.assertEqual((book,region),("B15","R3C2"))
                self.assertNotIn("MinerU",prompt)
                return fake_response(raw,prompt,book,region)
            after=stage.resume(root,observer)
            self.assertEqual(after,{"completed":3,"unknown":1,"not_started":0})
            self.assertEqual(calls,[("B15","R3C2")])
            dest=root/"semantic_gate"/"multibook_matrix_20261023"/prev.SUBDIR
            self.assertFalse(stage.status_path(dest,stage.MISSING,"candidate").exists())
            data=json.loads(stage.status_path(dest,stage.FINAL,"candidate").read_text("utf-8"))
            self.assertFalse(data["independent_gold_approved"])
            self.assertFalse(data["curve_correspondence_verified"])
            self.assertIsNone(data["cer"])
            with self.assertRaisesRegex(VisualGateError,"PRIOR_EXACT_STATE_CHANGED"):
                stage.resume(root,observer)
            self.assertEqual(len(calls),1)

    def test_transport_unknown_on_b15_leaves_charge_fence_and_never_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);partial(root)
            count=[0]
            def unknown(*_args):
                count[0]+=1
                raise VisualGateError("VISION_TRANSPORT_UNKNOWN_OUTCOME")
            with self.assertRaisesRegex(VisualGateError,"VISION_TRANSPORT_UNKNOWN_OUTCOME"):
                stage.resume(root,unknown)
            self.assertEqual(prev.private_inventory(root),
                             {"completed":2,"unknown":2,"not_started":0})
            with self.assertRaisesRegex(VisualGateError,"PRIOR_EXACT_STATE_CHANGED"):
                stage.resume(root,unknown)
            self.assertEqual(count[0],1)

    def test_invalid_provider_reply_does_not_trigger_a_second_charge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);partial(root)
            with self.assertRaisesRegex(VisualGateError,"PROVIDER_JSON_INVALID"):
                stage.resume(root,lambda *_args:'{"transcription":')
            self.assertEqual(prev.private_inventory(root),
                             {"completed":2,"unknown":2,"not_started":0})

    def test_first_two_candidates_and_unknown_third_mandatory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);fixture(root)
            with self.assertRaisesRegex(VisualGateError,"PRIOR_EXACT_STATE_CHANGED"):
                stage.contract(root)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);partial(root)
            dest=root/"semantic_gate"/"multibook_matrix_20261023"/prev.SUBDIR
            stage.status_path(dest,stage.MISSING,"attempt").unlink()
            with self.assertRaisesRegex(VisualGateError,"PRIOR_EXACT_STATE_CHANGED"):
                stage.contract(root)

    def test_reject_source_tile_tamper_before_any_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);partial(root)
            image=root/"semantic_gate"/"multibook_matrix_20261023"/prev.SOURCE_DIR/"B15_p0109_R3C2.private.png"
            image.write_bytes(b"tampered")
            called=[]
            with self.assertRaisesRegex(VisualGateError,"TILE_TAMPERED"):
                stage.resume(root,lambda *_args:called.append(1))
            self.assertEqual(called,[])

if __name__=="__main__":
    unittest.main()
