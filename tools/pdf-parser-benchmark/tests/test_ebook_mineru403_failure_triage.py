"""No PDF parse invocation, no secret text in MinerU offline diagnostic output."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_mineru403_failure_triage as triage
import ebook_multibook_native_matrix as native
from test_ebook_b31_mineru403_reuse import prepare, create_cached_runtime


def logs(root):
    folder=root/"semantic_gate"/native.FOLDER
    for ix,name in enumerate(triage.PREVIOUS_LOGS):
        (folder/name).write_text(
            "Secret PDF paragraph NEVER_PUBLISH\n" +
            (("Traceback (most recent call last)\n"
              "ModuleNotFoundError: No module named 'hidden_private_module'\n")
             if ix==0 else "Error: No such option: --wrong-flag\n"),
            encoding="utf-8",
        )
    return folder


class PrivateTriageTests(unittest.TestCase):
    def test_private_strings_never_echoed_by_classifier(self):
        raw=b"PRIVATE_PAGE_1234 Error: No such option: --abc\n"
        record=triage.classify_private_bytes(raw)
        self.assertEqual(record["categories"],["CLI_ARGUMENT_REJECTED"])
        self.assertNotIn("PRIVATE_PAGE_1234",json.dumps(record))
        self.assertNotIn("--abc",json.dumps(record))

    def test_exception_types_only_not_user_file_paths(self):
        result=triage.classify_private_bytes(
            b"Traceback (most recent call last):\n"
            b"FileNotFoundError: [Errno 2] /PRIVATE/PDF/TEXT/file.pdf")
        self.assertIn("FileNotFoundError",result["known_exception_classes"])
        self.assertNotIn("file.pdf",json.dumps(result))
        self.assertTrue(result["contains_traceback"])

    def test_write_one_private_and_audit_without_actual_ocr(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            manifest=prepare(root)
            create_cached_runtime(root)
            folder=logs(root)
            kit=root/"python"/"mineru"/"Scripts"/"mineru-kit.exe"
            kit.write_bytes(b"synthetic kit executable")
            calls=[]
            def runner(argv,env,log):
                calls.append(argv)
                self.assertEqual(argv[1:4],["models","verify","--tier"])
                self.assertEqual(env["MINERU_MODEL_SOURCE"],"local")
                self.assertEqual(env["HTTP_PROXY"],"http://127.0.0.1:1")
                log.write_bytes(b"models verification incomplete\n")
                return 7
            result=triage.run(root,manifest,write=True,runner=runner)
            self.assertEqual(len(calls),1)
            self.assertEqual(result["new_mineru_parse_calls"],0)
            self.assertFalse(result["basic_model_probe"]["basic_models_verified"])
            self.assertEqual(result["basic_model_probe"]["verify_exit_code"],7)
            self.assertEqual(len(result["old_failures"]),2)
            self.assertEqual(triage.audit_existing(root,manifest),result)
            self.assertIn("Secret PDF paragraph",(
                folder/triage.PREVIOUS_LOGS[0]).read_text())
            with self.assertRaisesRegex(triage.VisualGateError,"ALREADY_EXISTS"):
                triage.run(root,manifest,write=True,runner=runner)

    def test_missing_kit_is_not_success_or_inference(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            create_cached_runtime(root);logs(root)
            data=triage.run(root,manifest,write=True)
            self.assertFalse(data["basic_model_probe"]["kit_present"])
            self.assertFalse(data["basic_model_probe"]["models_verify_ran"])
            self.assertFalse(data["basic_model_probe"]["basic_models_verified"])
            self.assertEqual(triage.audit_existing(root,manifest),data)

    def test_old_failure_log_tampering_rejected_after_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            create_cached_runtime(root);folder=logs(root)
            triage.run(root,manifest,write=True)
            with (folder/triage.PREVIOUS_LOGS[0]).open("ab") as f:
                f.write(b"tampered")
            with self.assertRaisesRegex(triage.VisualGateError,"INVALID"):
                triage.audit_existing(root,manifest)

    def test_false_gold_and_false_parse_flag_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            create_cached_runtime(root);folder=logs(root)
            triage.run(root,manifest,write=True)
            resultfile=folder/triage.REPORT
            data=json.loads(resultfile.read_text("utf-8"))
            data["new_mineru_parse_calls"]=1
            data["graph_accuracy_gold"]={"F1":1}
            resultfile.write_text(json.dumps(data),encoding="utf-8")
            with self.assertRaisesRegex(triage.VisualGateError,"INVALID"):
                triage.audit_existing(root,manifest)

    def test_log_limit_and_bad_bytes_fail_closed(self):
        with self.assertRaisesRegex(triage.VisualGateError,"EXCEEDS_LIMIT"):
            triage.classify_private_bytes(b"q"*(triage.MAX_LOG+1))


if __name__=="__main__":
    unittest.main()
