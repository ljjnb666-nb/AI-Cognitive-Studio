"""Synthetic gates for REAL-layout attempt orchestrator; never load a model."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_docling_standard_layout_real as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root,n=1):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    (folder/s.PARENT).write_text("upstream synthetic only",encoding="utf-8")
    pdf=folder/"docling_native_single_pages"/"B15_p0109.private.pdf"
    pdf.parent.mkdir()
    pdf.write_bytes(b"private PDF bytes test only")
    options=[(f"tool-env/candidate{i}",root/f"tool-env/candidate{i}")
             for i in range(n)]
    for _,p in options:
        p.mkdir(parents=True)
    return folder,pdf,options


def bind(root,folder,pdf,candidates):
    parent={"corpus_id":"SYNTHETIC"}
    return patch.object(s,"verify_source",
        return_value=(folder,pdf,hashlib.sha256(pdf.read_bytes()).hexdigest(),
                      parent,candidates))


class LayoutTrialTests(unittest.TestCase):
    def test_no_candidate_blocks_but_never_infers(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,_=fixture(root,0)
            with bind(root,folder,pdf,[]):
                data=s.trial(root,{},write=True)
                self.assertEqual(data["status"],"BLOCKED_OFFLINE_LAYOUT_MODEL_CANDIDATE")
                self.assertEqual(data["ocr_page_count"],0)
                self.assertFalse(data["actual_layout_success"])
                self.assertEqual(s.trial(root,{},audit=True),data)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    s.trial(root,{},write=True)

    def test_multiple_candidates_require_selection(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,candidates=fixture(root,2)
            with bind(root,folder,pdf,candidates):
                data=s.trial(root,{},write=True)
                self.assertEqual(data["status"],
                    "BLOCKED_MULTIPLE_LAYOUT_CANDIDATES_AMBIGUOUS")
                self.assertFalse((folder/s.WORKER_JSON).exists())

    def test_success_marks_actual_layout_but_no_ocr_or_accuracy(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,candidates=fixture(root)
            def fake_run(argv,**kw):
                self.assertEqual(kw["env"]["HF_HUB_OFFLINE"],"1")
                self.assertEqual(kw["env"]["TRANSFORMERS_OFFLINE"],"1")
                self.assertEqual(kw["env"]["ALL_PROXY"],"http://127.0.0.1:1")
                record={"kind":"REAL_DOCLING_STANDARD_OCR_OFF_LAYOUT_EXECUTED",
                        "duration_ms":1234,
                        "markdown_private":"仅本地敏感字样",
                        "text_item_count":2,"picture_item_count":1,
                        "table_item_count":0}
                s._exclusive(Path(argv[-1]),json.dumps(
                    record,ensure_ascii=False).encode("utf-8"))
                return SimpleNamespace(returncode=0,stdout=b"",stderr=b"private")
            with bind(root,folder,pdf,candidates):
                actual=s.trial(root,{},write=True,runner=fake_run)
                self.assertEqual(actual["status"],
                                 "REAL_STANDARD_LAYOUT_SUCCESS_OCR_DISABLED")
                self.assertTrue(actual["actual_layout_success"])
                self.assertEqual(actual["ocr_page_count"],0)
                self.assertIsNone(actual["cer"])
                self.assertEqual(actual["duration_ms"],1234)
                self.assertNotIn("仅本地敏感字样",
                    (folder/s.REPORT).read_text("utf-8"))
                self.assertEqual(s.trial(root,{},audit=True),actual)
                (folder/s.WORKER_LOG).write_bytes(b"tamper")
                with self.assertRaisesRegex(VisualGateError,"WORKER_TAMPERED"):
                    s.trial(root,{},audit=True)

    def test_failure_log_remains_private_and_is_auditable(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,candidates=fixture(root)
            def failed(argv,**kw):
                return SimpleNamespace(returncode=2,stdout=b"",
                                       stderr=b"PRIVATE_DIAGNOSTIC_STACKTRACE")
            with bind(root,folder,pdf,candidates):
                data=s.trial(root,{},write=True,runner=failed)
                self.assertEqual(data["status"],
                    "BLOCKED_STANDARD_LAYOUT_RUNTIME_PRIVATE_ERROR")
                self.assertNotIn("PRIVATE_DIAGNOSTIC_STACKTRACE",
                    (folder/s.REPORT).read_text("utf-8"))
                self.assertIn(b"PRIVATE_DIAGNOSTIC_STACKTRACE",
                    (folder/s.WORKER_LOG).read_bytes())
                self.assertEqual(s.trial(root,{},audit=True),data)

    def test_cache_boundary_disallows_symlink_and_nonunique(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,candidates=fixture(root,0)
            rows=[{"candidate":path,"model_weight_files":0,"config_files":0}
                  for path in s.ARTIFACT_FOLDERS]
            self.assertEqual(s.fixed_candidate(root,rows),[])
            model=root/rows[0]["candidate"]
            model.parent.mkdir(parents=True,exist_ok=True)
            model.symlink_to(root,target_is_directory=True)
            rows[0]["model_weight_files"]=1
            rows[0]["config_files"]=1
            with self.assertRaisesRegex(VisualGateError,"UNSAFE"):
                s.fixed_candidate(root,rows)


if __name__=="__main__":
    unittest.main()
