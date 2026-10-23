"""Synthetic image payload accounting is not OCR quality or literal text export."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_mineru_markdown_structure as subject


def sample(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    payload="# Heading\n\n![figure](data:image/png;base64,QUJDREVGRw==)\n\nVisible 私有 OCR"
    encoded=payload.encode("utf-8")
    (folder/"b31_mineru403_basic_onnx_stateless.private.md").write_bytes(encoded)
    mineru={
        "book_id":"B31","physical_page":126,"real_inference":True,
        "engine_version":"4.0.3","markdown_character_count":len(payload),
        "markdown_byte_count":len(encoded),
        "markdown_sha256_private":"c"*64,
        "source_document_sha256":"a"*64,
    }
    rapid={
        "book_id":"B31","physical_page":126,
        "recognized_line_count":50,"recognized_character_count":1191,
        "source_page_png_sha256":"b"*64,
    }
    return folder,payload,mineru,rapid


class MarkdownStructureTests(unittest.TestCase):
    def test_base64_image_is_counted_as_image_not_real_ocr(self):
        data=subject.count_structure(
            "文字 ![diagram](data:image/png;base64,QUJDREVG) 更多字")
        self.assertEqual(data["embedded_image_data_uri_count"],1)
        self.assertGreaterEqual(data["embedded_image_data_uri_raw_characters"],30)
        self.assertEqual(data["markdown_image_reference_count"],1)
        self.assertTrue(data["base64_image_payloads_are_not_ocr_text"])
        self.assertLess(data["nonwhitespace_nonimage_markdown_residue_chars"],20)

    def test_external_image_reference_not_a_transcription(self):
        data=subject.count_structure("# Title\n![图](private.png)\n|a|b|\n")
        self.assertEqual(data["markdown_image_reference_count"],1)
        self.assertEqual(data["embedded_image_data_uri_count"],0)
        self.assertEqual(data["pipe_table_line_count"],1)

    def test_synthetic_source_same_page_no_literal_markdown_in_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,raw,m,r=sample(root)
            with mock.patch.object(subject,"audit_mineru",return_value=m),\
                 mock.patch.object(subject,"audit_rapidocr",return_value=r),\
                 mock.patch.object(subject,"_private_folder",return_value=folder):
                data=subject.run(root,{},write=True)
                self.assertEqual(data["rapidocr_character_count"],1191)
                self.assertNotIn("Visible 私有 OCR",json.dumps(data,ensure_ascii=False))
                self.assertEqual(subject.audit_existing(root,{}),data)
                with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                    subject.run(root,{},write=True)

    def test_tampering_markdown_report_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,raw,m,r=sample(root)
            with mock.patch.object(subject,"audit_mineru",return_value=m),\
                 mock.patch.object(subject,"audit_rapidocr",return_value=r),\
                 mock.patch.object(subject,"_private_folder",return_value=folder):
                subject.run(root,{},write=True)
                f=folder/subject.REPORT
                d=json.loads(f.read_text("utf-8"))
                d["mineru"]["embedded_image_data_uri_count"]=0
                f.write_text(json.dumps(d),encoding="utf-8")
                with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                    subject.audit_existing(root,{})

    def test_source_length_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,raw,m,r=sample(root)
            m["markdown_character_count"]+=1
            with mock.patch.object(subject,"audit_mineru",return_value=m),\
                 mock.patch.object(subject,"audit_rapidocr",return_value=r),\
                 mock.patch.object(subject,"_private_folder",return_value=folder):
                with self.assertRaisesRegex(subject.VisualGateError,"SOURCE_CHANGED"):
                    subject.run(root,{},write=True)
            self.assertFalse((folder/subject.REPORT).exists())

    def test_audit_forged_gold_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,raw,m,r=sample(root)
            with mock.patch.object(subject,"audit_mineru",return_value=m),\
                 mock.patch.object(subject,"audit_rapidocr",return_value=r),\
                 mock.patch.object(subject,"_private_folder",return_value=folder):
                subject.run(root,{},write=True)
                f=folder/subject.REPORT
                d=json.loads(f.read_text("utf-8"))
                d["actual_ocr_transcription_quality"]={"cer":0}
                f.write_text(json.dumps(d),encoding="utf-8")
                with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                    subject.audit_existing(root,{})


if __name__=="__main__":
    unittest.main()
