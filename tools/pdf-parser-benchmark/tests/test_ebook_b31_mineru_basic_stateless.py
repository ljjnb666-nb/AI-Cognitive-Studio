"""Synthetic MinerU Basic stateless PDF OCR contract, no actual model calls."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_mineru_basic_stateless as target
import ebook_mineru403_failure_triage as diag
from test_ebook_b31_mineru403_reuse import prepare,create_cached_runtime
from test_ebook_mineru403_failure_triage import logs


def fixture(root):
    manifest=prepare(root)
    create_cached_runtime(root)
    folder=logs(root)
    kit=root/"python"/"mineru"/"Scripts"/"mineru-kit.exe"
    kit.write_bytes(b"fake mineru-kit 4.0.3")
    def verifying(argv,env,logfile):
        assert argv[1:3]==["models","verify"]
        assert env["MINERU_MODEL_SOURCE"]=="local"
        logfile.write_text("Basic ONNX all expected models ready",encoding="utf-8")
        return 0
    diag.run(root,manifest,write=True,runner=verifying)
    return manifest,folder


def conversion(command,env,log):
    assert command[1]=="parse"
    assert command[3]=="-o"
    assert command[command.index("--tier")+1]=="basic"
    assert command[command.index("--ocr-mode")+1]=="ocr"
    assert "mineru-kit.exe" in command[0]
    assert env["MINERU_MODEL_SOURCE"]=="local"
    assert env["MINERU_MODEL_SMALL_BACKEND"]=="onnx"
    assert env["MINERU_TABLE_DEVICE"]=="cpu"
    assert env["HTTP_PROXY"]=="http://127.0.0.1:1"
    Path(command[4]).write_text("# ONLY FAKE PDF / NO GOLD\n\nsample",encoding="utf-8")
    log.write_text("synthetic local parse success",encoding="utf-8")
    return 0


class BasicStatelessTests(unittest.TestCase):
    def test_same_original_page_and_verified_onnx_preflight(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            m,folder=fixture(root)
            data=target.run(root,m)
            self.assertTrue(data["basic_models_verified"])
            self.assertFalse(data["real_inference"])
            self.assertEqual(data["physical_page"],126)
            self.assertEqual(data["onnx_weight_count"],5)
            self.assertFalse((folder/target.REPORT).exists())

    def test_true_stateless_basic_success_private_then_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            m,folder=fixture(root)
            data=target.run(root,m,write=True,runner=conversion)
            self.assertTrue(data["real_inference"])
            self.assertEqual(data["entrypoint"],"mineru-kit parse")
            self.assertEqual(data["model_files_count"],5)
            self.assertEqual(data["paid_provider_calls"],0)
            self.assertIsNone(data["ocr_quality_gold"])
            self.assertEqual(target.audit_existing(root,m),data)
            with self.assertRaisesRegex(target.VisualGateError,"OUTPUT_EXISTS"):
                target.run(root,m,write=True,runner=conversion)

    def test_failure_remains_failed_and_partial_log_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            m,folder=fixture(root)
            def fail(command,env,log):
                log.write_text("PRIVATE_ERR_SENTINEL",encoding="utf-8")
                return 12
            with self.assertRaisesRegex(target.VisualGateError,"INFERENCE_FAILED"):
                target.run(root,m,write=True,runner=fail)
            self.assertFalse((folder/target.REPORT).exists())
            self.assertEqual((folder/target.LOG).read_text(),"PRIVATE_ERR_SENTINEL")
            with self.assertRaisesRegex(target.VisualGateError,"OUTPUT_EXISTS"):
                target.run(root,m,write=True,runner=conversion)

    def test_no_prior_verified_models_refuses_inference(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);m=prepare(root)
            create_cached_runtime(root)
            with self.assertRaises(target.VisualGateError):
                target.run(root,m,write=True,runner=conversion)
            self.assertFalse((root/"semantic_gate"/"multibook_matrix_20261023"/target.REPORT).exists())

    def test_tampered_markdown_not_considered_accepted_result(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);m,folder=fixture(root)
            target.run(root,m,write=True,runner=conversion)
            path=folder/target.MARKDOWN
            path.write_bytes(path.read_bytes()+b"bad")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.audit_existing(root,m)

    def test_forged_gold_or_tier_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);m,folder=fixture(root)
            target.run(root,m,write=True,runner=conversion)
            f=folder/target.REPORT
            data=json.loads(f.read_text("utf-8"))
            data["tier"]="standard"
            data["ocr_quality_gold"]={"cer":0.0}
            f.write_text(json.dumps(data),encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.audit_existing(root,m)


if __name__=="__main__":
    unittest.main()
