"""Source-only offline visual workbench synthetic gates (no image / OCR models)."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_blind_review_offline_workbench as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    images=folder/s.SUBDIR
    images.mkdir(parents=True)
    (folder/s.V9).write_bytes(b"SYNTHETIC LOCKED V9 SOURCE ONLY")
    pages=[]
    for book,page,scope in s.EXPECTED:
        name=f"{book}_p{page:04d}_{scope}"
        image=images/(name+".source.private.png")
        form=images/(name+".blank.private.json")
        image.write_bytes(("private-image-"+name).encode("utf-8"))
        form.write_bytes(("private-form-"+name).encode("utf-8"))
        pages.append({
            "book_id":book,"physical_page":page,"scope":scope,
            "source_image_sha256_private":"a"*64,
            "cropped_image_sha256_private":hashlib.sha256(image.read_bytes()).hexdigest(),
            "blank_form_sha256_private":hashlib.sha256(form.read_bytes()).hexdigest(),
        })
    upstream={
        "image_count":2,"reviewed_reference_count":0,
        "independent_reference_created":False,"cer":None,
        "pages":pages,
    }
    return folder,upstream


class LocalWorkbenchTests(unittest.TestCase):
    def invoke(self,root,folder,upstream,*,write=False,audit=False):
        with patch.object(s,"_private_folder",return_value=folder):
            return s.run(root,{},write=write,audit=audit,
                         upstream_fn=lambda r,m,audit:upstream)

    def test_generates_chinese_offline_viewer_and_unverified_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior=fixture(root)
            res=self.invoke(root,folder,prior,write=True)
            self.assertEqual(res["independent_review_count"],0)
            self.assertIsNone(res["cer"])
            self.assertFalse(res["independent_reference_created"])
            html=(folder/s.SUBDIR/s.HTML_NAME).read_text("utf-8")
            for required in ("原图盲审工作台","B15 · 第109页","B03 · 第67页",
                             "DRAFT_UNVERIFIED","connect-src 'none'",
                             "reviewer_approval:null","independent_reference_verified:false",
                             "cer:null","URL.createObjectURL"):
                self.assertIn(required,html)
            for forbidden in ("https://","http://","PRIVATE OCR TEXT",
                              "INDEPENDENTLY_APPROVED","OCR 正确率 100%"):
                self.assertNotIn(forbidden,html)
            self.assertEqual(self.invoke(root,folder,prior,audit=True),res)
            with self.assertRaisesRegex(VisualGateError,"ALREADY_CREATED"):
                self.invoke(root,folder,prior,write=True)

    def test_changes_in_existing_source_image_fail_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior=fixture(root)
            file=folder/s.SUBDIR/"B15_p0109_R3C2.source.private.png"
            file.write_bytes(b"other image content")
            with self.assertRaisesRegex(VisualGateError,"IMAGE_HASH_CHANGED"):
                self.invoke(root,folder,prior,write=True)
            self.assertFalse((folder/s.REPORT).exists())

    def test_editing_existing_blank_source_form_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior=fixture(root)
            file=folder/s.SUBDIR/"B03_p0067_FULL.blank.private.json"
            file.write_bytes(b"an invented OCR gold")
            with self.assertRaisesRegex(VisualGateError,"FORM_HASH_CHANGED"):
                self.invoke(root,folder,prior,write=True)

    def test_tampering_html_and_receipt_rejected_in_audit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior=fixture(root)
            self.invoke(root,folder,prior,write=True)
            html=folder/s.SUBDIR/s.HTML_NAME
            html.write_bytes(b"changed HTML")
            with self.assertRaisesRegex(VisualGateError,"FROZEN_TAMPERED"):
                self.invoke(root,folder,prior,audit=True)

    def test_upstream_approval_or_unsafe_page_identity_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior=fixture(root)
            prior["reviewed_reference_count"]=1
            with self.assertRaisesRegex(VisualGateError,"NOT_UNREVIEWED"):
                self.invoke(root,folder,prior,write=True)
            prior["reviewed_reference_count"]=0
            prior["pages"][0]["scope"]="FULL"
            with self.assertRaisesRegex(VisualGateError,"PAGE_LIST_INVALID"):
                self.invoke(root,folder,prior,write=True)
            self.assertFalse((folder/s.REPORT).exists())


if __name__=="__main__":
    unittest.main()
