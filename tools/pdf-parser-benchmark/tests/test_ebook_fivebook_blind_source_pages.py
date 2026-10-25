"""Fivebook source packet tests: only machine-generated blank synthetic images."""
from io import BytesIO,StringIO
from contextlib import redirect_stdout
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_blind_source_pages as stage
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    manifest={"corpus_id":"SYNTHETIC_ONLY","sources":[]}
    native={"selected_native_pages":24,"ocr_focus_image_count":5,
            "corpus_id":"SYNTHETIC_ONLY","rows":[]}
    for i,(book,page) in enumerate(stage.TARGETS):
        img=Image.new("RGB",(180,240),(245-i*15,242,234))
        buf=BytesIO();img.save(buf,format="PNG")
        raw=buf.getvalue()
        name=f"{book}_p{page:04d}.private.png"
        (folder/name).write_bytes(raw)
        pdf_sha=hashlib.sha256(("fake-pdf-"+book).encode()).hexdigest()
        manifest["sources"].append({
            "id":book,"sha256":pdf_sha,"ocr_physical_pages":[page],
        })
        native["rows"].append({
            "book_id":book,"source_document_sha256":pdf_sha,
            "pages":[{
                "physical_page":page,"ocr_focus_png":name,
                "ocr_focus_png_sha256":stage.sha(raw),
                "ocr_focus_width":180,"ocr_focus_height":240,
            }],
        })
    native["rows"].append({"book_id":"B16","source_document_sha256":"f"*64,"pages":[]})
    manifest["sources"].append({"id":"B16","sha256":"f"*64,"ocr_physical_pages":[]})
    return folder,manifest,native


class FivebookBlindSourceTests(unittest.TestCase):
    def invoke(self,root,manifest,native,*,write=False,audit=False):
        return stage.run(root,manifest,write=write,audit=audit,
                         native_fn=lambda r,m:native)

    def test_all_five_synthetic_original_pages_frozen_and_replayed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            report=self.invoke(root,manifest,native,write=True)
            self.assertEqual(report["focus_source_page_count"],5)
            self.assertEqual(report["reviewer_approvals"],0)
            self.assertIsNone(report["cer"])
            self.assertFalse(report["reference_text_created"])
            output=folder/stage.SUBDIR
            self.assertEqual(len(list(output.iterdir())),12)
            for book,page in stage.TARGETS:
                doc=output/(book+f"_p{page:04d}.unreviewed.private.json")
                entry=stage.json.loads(doc.read_text("utf-8"))
                self.assertIsNone(entry["reviewer_approval"])
                self.assertIsNone(entry["visual_transcription_draft"])
                self.assertFalse(entry["all_nine_grid_regions_reviewed"])
                self.assertFalse(entry["independent_gold_available"])
                self.assertIsNone(entry["cer"])
            self.assertEqual(report,self.invoke(root,manifest,native,audit=True))
            with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                self.invoke(root,manifest,native,write=True)

    def test_private_packet_contains_no_ocr_text_or_source_pixels_in_html(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            self.invoke(root,manifest,native,write=True)
            content=(folder/stage.SUBDIR/stage.INDEX).read_text("utf-8")
            self.assertIn("connect-src 'none'",content)
            self.assertIn("DRAFT_UNVERIFIED",content)
            self.assertIn("B08",content)
            self.assertIn("B29",content)
            self.assertIn("B31",content)
            self.assertNotIn("PRIVATE_OCR_TEXT",content)
            self.assertNotIn("INDEPENDENTLY_APPROVED",content)

    def test_any_single_source_image_mutation_invalidates_entire_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            self.invoke(root,manifest,native,write=True)
            (folder/"B08_p0064.private.png").write_bytes(b"BAD-IMAGE")
            with self.assertRaisesRegex(VisualGateError,"SOURCE_SHA_MISMATCH"):
                self.invoke(root,manifest,native,audit=True)

    def test_private_review_report_and_empty_form_cannot_be_edited(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            self.invoke(root,manifest,native,write=True)
            form=folder/stage.SUBDIR/"B29_p0072.unreviewed.private.json"
            form.write_text('{"reviewer_approval":"INDEPENDENTLY_APPROVED"}')
            with self.assertRaisesRegex(VisualGateError,"FROZEN_OUTPUT_CHANGED"):
                self.invoke(root,manifest,native,audit=True)

    def test_document_or_physical_page_substitution_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            manifest["sources"][0]["ocr_physical_pages"]=[99]
            with self.assertRaisesRegex(VisualGateError,"PDF_PAGE_IDENTITY_CHANGED"):
                self.invoke(root,manifest,native,write=True)
            manifest["sources"][0]["ocr_physical_pages"]=[67]
            native["rows"][0]["source_document_sha256"]="a"*64
            with self.assertRaisesRegex(VisualGateError,"PDF_PAGE_IDENTITY_CHANGED"):
                self.invoke(root,manifest,native,write=True)
            self.assertFalse((folder/stage.SUBDIR).exists())

    def test_partial_or_preexisting_outputs_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            out=folder/stage.SUBDIR
            out.mkdir()
            present=out/"B03_p0067.private.png"
            present.write_bytes(b"PRIVATE_PRESERVE")
            with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                self.invoke(root,manifest,native,write=True)
            self.assertEqual(present.read_bytes(),b"PRIVATE_PRESERVE")
            self.assertFalse((out/stage.REPORT).exists())

    def test_bad_image_rejected_even_with_recomputed_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,manifest,native=fixture(root)
            raw=b"NOT_A_PNG"
            (folder/"B31_p0126.private.png").write_bytes(raw)
            native["rows"][4]["pages"][0]["ocr_focus_png_sha256"]=stage.sha(raw)
            with self.assertRaisesRegex(VisualGateError,"IMAGE_INVALID"):
                self.invoke(root,manifest,native,write=True)

    def test_any_private_runtime_failure_outputs_only_fixed_rejection(self):
        with patch.object(stage,"run",side_effect=RuntimeError("PRIVATE_BOOK_CONTENT")):
            stdout=StringIO()
            with redirect_stdout(stdout):
                code=stage.main(["--private-root","PRIVATE_PATH",
                                 "--manifest","PRIVATE_MANIFEST","--audit-only"])
            self.assertEqual(code,2)
            self.assertEqual(stdout.getvalue().strip(),"ACS_FIVEBOOK_BLIND_V11=REJECTED")


if __name__=="__main__":
    unittest.main()
