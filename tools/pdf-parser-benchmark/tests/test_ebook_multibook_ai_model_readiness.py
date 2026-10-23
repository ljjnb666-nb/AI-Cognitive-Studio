"""Private, bounded model readiness is NOT an inference or accuracy result."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import fitz
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_multibook_native_matrix as baseline
import ebook_multibook_ai_model_readiness as target
from test_ebook_multibook_matrix import fixture


class ReadinessTests(unittest.TestCase):
    def prepared(self):
        temp=tempfile.TemporaryDirectory()
        root=Path(temp.name)
        manifest=fixture(root)
        baseline.evaluate(root,manifest,fitz,write=True)
        return temp,root,manifest

    def test_explicit_empty_scan_never_claims_engine_ready(self):
        temp,root,manifest=self.prepared()
        with temp:
            result=target.collect(root,manifest,roots=[])
            self.assertEqual(result["native_selected_pages"],24)
            self.assertEqual(result["roots_inspected_count"],0)
            self.assertFalse(result["docling_standard_inference_tested"])
            self.assertFalse(result["mineru_inference_tested"])
            self.assertTrue(result["cached_weights_are_not_completeness_proof"])
            self.assertIsNone(result["graph_quality_gold"])
            self.assertEqual(result["provider_calls"],0)

    def test_weight_hints_from_named_offline_dirs_are_not_model_completeness(self):
        temp,root,manifest=self.prepared()
        with temp:
            models=root/"tool-env"/"mineru-4.0.3"/"models"
            models.mkdir(parents=True)
            (models/"detector.onnx").write_bytes(b"x"*100_000)
            doc=root/"models"/"docling-layout"
            doc.mkdir(parents=True)
            (doc/"model.safetensors").write_bytes(b"d"*110_000)
            result=target.collect(root,manifest,roots=[root/"tool-env",root/"models"])
            self.assertEqual(result["model_weight_candidate_counts"]["mineru"],1)
            self.assertEqual(result["model_weight_candidate_counts"]["docling"],1)
            self.assertEqual(result["engine_states"]["docling_standard"],
                             "MODEL_COMPLETENESS_NOT_ATTESTED")
            self.assertEqual(result["engine_states"]["mineru"],
                             "MODEL_COMPLETENESS_NOT_ATTESTED")
            self.assertFalse(result["mineru_inference_tested"])

    def test_files_outside_known_model_directory_not_misclassified(self):
        temp,root,manifest=self.prepared()
        with temp:
            (root/"models").mkdir()
            (root/"models"/"chapter.pdf").write_bytes(b"x"*100_000)
            (root/"models"/"notes.onnx").write_bytes(b"y"*100_000)
            data=target.scan_cache([root/"models"])
            self.assertEqual(len(data["weights"]),0)

    def test_bad_or_partial_source_baseline_hard_failure(self):
        temp,root,manifest=self.prepared()
        with temp:
            baseline_report=(root/"semantic_gate"/baseline.FOLDER/
                             baseline.REPORT)
            baseline_report.unlink()
            with self.assertRaises(target.VisualGateError):
                target.run(root,manifest,roots=[],write=True)
            self.assertFalse((root/"semantic_gate"/baseline.FOLDER/target.NAME).exists())

    def test_one_write_then_strict_private_receipt_and_no_provider(self):
        temp,root,manifest=self.prepared()
        with temp:
            with patch.object(target,"package_state",return_value={
                "docling":"2.141.0","docling-core":"2.60.0","mineru":None,
                "mineru-kit":None,"rapidocr":None}):
                report=target.run(root,manifest,roots=[],write=True)
            self.assertEqual(target.audit_existing(root,manifest),report)
            self.assertEqual(report["model_downloads"],0)
            with self.assertRaisesRegex(target.VisualGateError,"ALREADY_EXISTS"):
                target.run(root,manifest,roots=[],write=True)

    def test_forged_inference_success_not_accepted(self):
        temp,root,manifest=self.prepared()
        with temp:
            target.run(root,manifest,roots=[],write=True)
            receipt=root/"semantic_gate"/baseline.FOLDER/target.NAME
            fake=json.loads(receipt.read_text("utf-8"))
            fake["docling_standard_inference_tested"]=True
            receipt.write_text(json.dumps(fake),encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.audit_existing(root,manifest)

    def test_forged_accuracy_not_accepted(self):
        temp,root,manifest=self.prepared()
        with temp:
            target.run(root,manifest,roots=[],write=True)
            receipt=root/"semantic_gate"/baseline.FOLDER/target.NAME
            fake=json.loads(receipt.read_text("utf-8"))
            fake["graph_quality_gold"]={"f1":1.0}
            receipt.write_text(json.dumps(fake),encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.audit_existing(root,manifest)

    def test_symlinked_model_path_is_skipped(self):
        temp,root,manifest=self.prepared()
        with temp:
            archive=root/"safe"/"mineru"
            archive.mkdir(parents=True)
            (archive/"model.onnx").write_bytes(b"a"*100_000)
            link=root/"models"
            try:
                link.symlink_to(archive,target_is_directory=True)
            except OSError:
                self.skipTest("symlink not supported by test runtime")
            self.assertEqual(target.scan_cache([link])["status"],"BOUNDED_INVENTORY")
            roots=target._allowed_roots(root,extra=[link])
            self.assertNotIn(link,roots)


if __name__=="__main__":
    unittest.main()
