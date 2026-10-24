"""No-private-log synthetic policy tests for all eleven protected Windows receipts."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_private_ci_receipt_gate as guard


def examples():
    rows=[{"book_id":"B15","status":"SUCCESS","results":[
        {"engine":"Docling","layout_evidence":{
            "graph_semantics":"UNVERIFIED",
            "spatial_alignment":{"reference_region_count":1},
            "spatial_alignment_status":"ROTATED_DISPLAY_TRANSFORM_UNVERIFIED",
            "source_pdf_rotation_degrees":270,"picture_items":2,
            "picture_boxes_with_geometry":2}}]},
        {"book_id":"B31","status":"SUCCESS","results":[
        {"engine":"Docling","layout_evidence":{
            "graph_semantics":"UNVERIFIED",
            "spatial_alignment":{"reference_region_count":1},
            "spatial_alignment_status":"PROVISIONAL",
            "source_pdf_rotation_degrees":0,"picture_items":1,
            "picture_boxes_with_geometry":1}}]},
        {"book_id":"B03","status":"SUCCESS","results":[
        {"engine":"Docling","layout_evidence":{
            "graph_semantics":"UNVERIFIED"}}]}]
    return {
        "fivebook-standard":{"all_five_real_standard_ocr_succeeded":True,
                             "actual_standard_ocr_success_pages":5,
                             "rows":[{}, {}, {}, {}, {}],"cer":None},
        "fivebook-consensus":{"same_original_page_count":5,
                              "rows":[{}, {}, {}, {}, {}],
                              "independent_ocr_truth":None,"cer":None},
        "blind-source":{"image_count":2,"reviewed_reference_count":0,
                        "independent_reference_created":False,
                        "pages":[{},{}],"cer":None},
        "blind-workbench":{"pages":[{},{}],"independent_reference_created":False,
                           "independent_review_count":0,
                           "review_draft_export_only":True,
                           "external_network_calls":0,"cer":None},
        "edge-workbench":{"pages":[{},{}],"independent_reference_created":False,
                          "independent_review_count":0,
                          "review_draft_export_only":True,
                          "external_network_calls":0,"cer":None},
        "legacy-b15-frame":{"rows":rows},
        "legacy-mineru-flash":{"rows":[
            {"status":"NATIVE_TEXT_EXTRACTED","markdown_diagnostics":{}},
            {"status":"NATIVE_TEXT_EXTRACTED","markdown_diagnostics":{}},
            {"status":"FLASH_NO_NATIVE_TEXT_CONTROL","markdown_diagnostics":{}}],
            "failed":[],"missing":[],"model_root_diagnostics":{
                "explicit_model_show":{},"inherited_model_show":{}}},
        "legacy-docling-real":{
            "docling_version":"2.141.0","docling_ocr_backend":"RapidOcrOptions",
            "rows":[{**rows[0],"docling_status":"SUCCESS","physical_page":109},
                    {**rows[1],"docling_status":"SUCCESS","physical_page":126},
                    {"book_id":"B16","physical_page":53,"status":"SUCCESS",
                     "docling_status":"SUCCESS","results":[{"engine":"Docling",
                     "layout_evidence":{"graph_semantics":"UNVERIFIED"}}]}],
            "failed":[],"missing":[]},
        "legacy-paddle-real":{
            "version":"3.7.0","initialization_ms":123,
            "rows":[{"book_id":book,"physical_page":page,"status":"SUCCESS",
                     "recognized_characters":10,
                     "layout_evidence":{"graph_semantics":"UNVERIFIED"}}
                    for book,page in (("B15",109),("B16",53),("B31",126))],
            "failed":[],"missing":[]},
        "legacy-rotation":{"rows":rows,"failed":[],"missing":[]},
        "legacy-visual-l2":{"rows":rows,"failed":[],"missing":[]},
    }


class PrivateGateTests(unittest.TestCase):
    def test_eleven_accepted_private_report_policies(self):
        for policy,data in examples().items():
            with self.subTest(policy=policy):
                self.assertTrue(guard.verify(data,policy))

    def test_all_eleven_policies_reject_invalid_authority(self):
        for policy,data in examples().items():
            with self.subTest(policy=policy):
                if policy=="fivebook-standard":
                    data["all_five_real_standard_ocr_succeeded"]=False
                elif policy=="fivebook-consensus":
                    data["independent_ocr_truth"]="SYNTHETIC FALSE GOLD"
                elif policy=="blind-source":
                    data["reviewed_reference_count"]=1
                elif policy in ("blind-workbench","edge-workbench"):
                    data["independent_reference_created"]=True
                elif policy=="legacy-b15-frame":
                    data["rows"][0]["results"][0]["layout_evidence"]["spatial_alignment"]=None
                elif policy=="legacy-mineru-flash":
                    data["rows"][0]["status"]="FAIL"
                elif policy=="legacy-docling-real":
                    data["rows"][0]["results"][0]["layout_evidence"]["source_pdf_rotation_degrees"]=0
                elif policy=="legacy-paddle-real":
                    data["rows"][0]["layout_evidence"]["graph_semantics"]="VERIFIED"
                elif policy=="legacy-rotation":
                    data["rows"][0]["results"][0]["layout_evidence"]["source_pdf_rotation_degrees"]=0
                else:
                    data["rows"][0]["results"][0]["layout_evidence"]["graph_semantics"]="VERIFIED"
                with self.assertRaises(guard.PrivateGateError):
                    guard.verify(data,policy)

    def test_private_parse_failure_cli_prints_only_fixed_result(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/"private.json"
            token="SYNTHETIC_PRIVATE_BOOK_TEXT_MUST_NOT_LOG"
            file.write_text('{"secret":"'+token+'","secret":"'+token+'"}',encoding="utf-8")
            buf=io.StringIO()
            with redirect_stdout(buf):
                with self.assertRaises(SystemExit) as exit_code:
                    guard.main(["--private-input",str(file),"--policy","blind-source"])
            self.assertEqual(exit_code.exception.code,2)
            self.assertEqual(buf.getvalue().strip(),"ACS_PRIVATE_RECEIPT_GATE=REJECTED")
            self.assertNotIn(token,buf.getvalue())
            file.write_text("{"+token,encoding="utf-8")
            buf=io.StringIO()
            with redirect_stdout(buf):
                with self.assertRaises(SystemExit):
                    guard.main(["--private-input",str(file),"--policy","blind-source"])
            self.assertEqual(buf.getvalue().strip(),"ACS_PRIVATE_RECEIPT_GATE=REJECTED")

    def test_safe_private_success_does_not_echo_input(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/"private.json"
            payload=examples()["fivebook-standard"]
            payload["private_ocr_text"]="SYNTHETIC_NEVER_LOG_THIS"
            file.write_text(json.dumps(payload),encoding="utf-8")
            buf=io.StringIO()
            with redirect_stdout(buf):
                guard.main(["--private-input",str(file),"--policy","fivebook-standard"])
            self.assertEqual(buf.getvalue().strip().splitlines(),[
                "ACS_PRIVATE_RECEIPT_GATE=PASS",
                "ACS_PRIVATE_RECEIPT_PRIVACY=NO_PRIVATE_JSON_IN_LOG"])
            self.assertNotIn("SYNTHETIC_NEVER_LOG_THIS",buf.getvalue())

    def test_unexpected_exception_also_cannot_escape_private_message(self):
        from unittest.mock import patch
        buffer=io.StringIO()
        with patch.object(guard,"read_private",
                          side_effect=RuntimeError("PRIVATE_OCR_NEVER_PRINT_THIS")):
            with redirect_stdout(buffer):
                with self.assertRaises(SystemExit) as result:
                    guard.main(["--private-input","/SYNTHETIC/PRIVATE.json",
                                "--policy","blind-source"])
        self.assertEqual(result.exception.code,2)
        self.assertEqual(buffer.getvalue().strip(),"ACS_PRIVATE_RECEIPT_GATE=REJECTED")
        self.assertNotIn("PRIVATE_OCR_NEVER_PRINT_THIS",buffer.getvalue())

    def test_read_private_reject_symlink_without_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            private=root/"book.json"
            private.write_text(json.dumps(examples()["blind-source"]),encoding="utf-8")
            alias=root/"alias.json"
            alias.symlink_to(private)
            with self.assertRaises(guard.PrivateGateError):
                guard.read_private(alias)

    def test_all_eleven_windows_workflows_use_guard_not_powershell_parser(self):
        repo=Path(__file__).resolve().parents[3]
        names=[
            "ebook-blind-review-offline-workbench.yml",
            "ebook-b15-b03-blind-source-review.yml",
            "ebook-fivebook-three-engine-crossbook-consensus.yml",
            "ebook-fivebook-docling-standard-rapidocr-real.yml",
            "ebook-blind-review-edge-real-smoke.yml",
            "acs-ebook-b15-frame-private.yml",
            "acs-ebook-windows-mineru-flash-real.yml",
            "acs-ebook-windows-rotation-private.yml",
            "acs-ebook-private-visual-l2.yml",
            "acs-ebook-windows-docling-real.yml",
            "acs-ebook-windows-paddle-real.yml",
        ]
        for name in names:
            with self.subTest(name=name):
                data=(repo/".github"/"workflows"/name).read_text("utf-8")
                if name=="acs-ebook-windows-docling-real.yml":
                    # This parser consumes PUBLIC PyPI metadata, not a private OCR receipt.
                    self.assertEqual(data.count(" | ConvertFrom-Json"),1)
                    self.assertIn("$metadata=Get-Content -LiteralPath $json -Raw | ConvertFrom-Json",data)
                    self.assertNotIn("$report=Get-Content",data)
                else:
                    self.assertNotIn(" | ConvertFrom-Json",data)
                self.assertIn("ebook_private_ci_receipt_gate.py",data)
                self.assertIn("--private-input",data)
                self.assertIn("--policy",data)


if __name__=="__main__":
    unittest.main()
