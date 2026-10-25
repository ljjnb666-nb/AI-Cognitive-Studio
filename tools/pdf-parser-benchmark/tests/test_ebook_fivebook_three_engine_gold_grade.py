"""Gold v9+ comparator: synthetic only; no user books, source OCR or cloud calls."""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_three_engine_gold_grade as stage
import ebook_fivebook_reference_gate as gate
from ebook_private_glm_visual_reference import VisualGateError


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fixture(root,approved=False,source_sha_override=None):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    sourcepdf="a"*64
    corpus="ONLY_SYNTHETIC_CORPUS"
    gold={"page_count":5,"corpus_id":corpus,
          "reference_provenance_truth_requires_external_audit":True,"rows":[]}
    three={"same_original_page_count":5,"corpus_id":corpus,"rows":[]}
    native={"ocr_focus_image_count":5,"corpus_id":corpus,"rows":[]}
    rapid={"pages":[]}
    pages=dict(zip(stage.ALL_BOOKS,(67,64,109,72,126)))
    for book,page in pages.items():
        png=(b"ONLY_SYNTHETIC_BYTE_PATTERN_"+book.encode())
        file=folder/f"{book}_p{page:04d}.private.png"
        file.write_bytes(png)
        native["rows"].append({"book_id":book,"pages":[{
            "physical_page":page,"ocr_focus_png":file.name,
            "ocr_focus_png_sha256":sha(png),
        }]})
        gold["rows"].append({
            "book_id":book,"physical_page":page,
            "original_pdf_source_sha256_private":sourcepdf,
            "reference_state":("ATTESTED_REFERENCE_CER_COMPUTED" if book=="B03" and approved
                               else "INDEPENDENT_REFERENCE_NOT_PROVIDED"),
            "reference_normalized_chars":5 if book=="B03" and approved else None,
        })
        model={"book_id":book,"physical_page":page}
        if book=="B03" and approved:
            md=b"HELXO"
            worker=b"SYNTHETIC_WORKER_BYTES"
            (folder/stage.file_names(book)[1]).write_bytes(md)
            (folder/stage.worker_paths(folder,book)[1].name).write_bytes(worker)
            model.update({
                "mineru_markdown_sha256_private":sha(md),
                "standard_worker_sha256_private":sha(worker),
                "rapidocr_rows_sha256_private":"e"*64,
                "normalized_characters":dict(zip(stage.ENGINES,(5,5,5))),
            })
        three["rows"].append(model)
        rapid["pages"].append({
            "book_id":book,"physical_page":page,
            "private_rows_sha256":"e"*64,
            "rapidocr_private_rows":[{"text":"HELLO"}],
        })
    if approved:
        refdir=folder/"independent_reference_v1"
        refdir.mkdir()
        page_file=refdir/"B03_p0067.verified.private.json"
        candidate={
            "schema_version":1,"corpus_id":corpus,"book_id":"B03","physical_page":67,
            "original_page_pdf_sha256":sourcepdf,
            "reference_origin":"INDEPENDENT_PAGE_TRANSCRIPTION",
            "verification_method":"MANUAL_SOURCE_PAGE_REVIEW",
            "reviewed_source_page":True,
            "not_derived_from_rapidocr_or_mineru":True,
            "reviewer_approval":"INDEPENDENTLY_APPROVED",
            "independent_source_sha256":sourcepdf,
            "reference_text":"HELLO",
            "reference_text_sha256":sha(b"HELLO"),
            "reviewer_record_id":"independentA01",
            "reference_scope":gate.FULL_PAGE_SCOPE,
            "source_page_png_sha256_private":source_sha_override or sha(b"ONLY_SYNTHETIC_BYTE_PATTERN_B03"),
            "full_page_coverage":{
                "coverage_scope":gate.FULL_PAGE_SCOPE,
                "reviewed_grid_cells":list(gate.REVIEW_GRID),
                "sidebars_and_vertical_text_reviewed":True,
                "all_visible_text_and_punctuation_transcribed":True,
                "page_reading_order_reviewed":True,
                "unresolved_text_regions":[],
            },
        }
        page_file.write_text(json.dumps(candidate),encoding="utf-8")
    return folder,gold,three,native,rapid


def injected(root,fixtures,version=1):
    _,gold,three,native,rapid=fixtures
    return stage.compute(root,{},snapshot_version=version,
        reference_fn=lambda r,m,snapshot_version:gold,
        three_fn=lambda r,m,audit:three,
        native_fn=lambda r,m:native,
        rapid_fn=lambda r,m:rapid)


class ThreeEngineGoldGradeTests(unittest.TestCase):
    def test_no_independent_gold_means_no_scores_for_any_of_three_engines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=fixture(root)
            report=injected(root,data,version=9)
            self.assertEqual(report["graded_page_count"],0)
            self.assertEqual(report["not_graded_count"],5)
            self.assertTrue(report["zero_new_model_calls"])
            for row in report["rows"]:
                self.assertEqual(row["reference_state"],"MISSING")
                self.assertEqual(row["normalized_alnum_cer"],{e:None for e in stage.ENGINES})
                self.assertFalse(row["reference_source_image_bound"])
                self.assertFalse(row["figure_semantics_verified"])

    def test_approved_same_image_and_three_frozen_engines_score_only_that_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=fixture(root,approved=True)
            with patch.object(stage,"valid_worker",return_value=({"private_markdown":"HELAO"},5)):
                report=injected(root,data)
            self.assertEqual(report["graded_page_count"],1)
            self.assertEqual(report["not_graded_count"],4)
            row=report["rows"][0]
            self.assertEqual(row["normalized_alnum_cer"],{
                stage.ENGINES[0]:0.0,stage.ENGINES[1]:0.2,stage.ENGINES[2]:0.2,
            })
            self.assertTrue(row["source_image_sha_verified"])
            self.assertTrue(row["reference_source_image_bound"])
            self.assertFalse(row["punctuation_layout_and_reading_order_scored"])

    def test_approved_claim_with_wrong_source_png_sha_fails_before_scoring(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=fixture(root,approved=True,source_sha_override="f"*64)
            with self.assertRaisesRegex(VisualGateError,"REVIEW_SOURCE_IMAGE_NOT_ATTESTED"):
                injected(root,data)

    def test_source_png_changed_after_native_receipt_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=fixture(root)
            (data[0]/"B29_p0072.private.png").write_bytes(b"CORRUPTED")
            with self.assertRaisesRegex(VisualGateError,"SOURCE_IMAGE_SHA_CHANGED"):
                injected(root,data)

    def test_snapshot_v9_v12_are_bounded_and_legacy_v1_v8_names_stable(self):
        self.assertEqual(stage.report_name(1),
                         "fivebook_three_engine_verified_gold_grade.v1.private.json")
        self.assertEqual(stage.report_name(9),
                         "fivebook_three_engine_verified_gold_grade.v9.private.json")
        self.assertEqual(stage.report_name(12),
                         "fivebook_three_engine_verified_gold_grade.v12.private.json")
        with self.assertRaisesRegex(VisualGateError,"VERSION_INVALID"):
            stage.report_name(13)

    def test_bounded_numeric_normalized_alnum_distances_never_claim_layout(self):
        ref="abcd"
        got=stage.score_alnum_only(ref,{
            stage.ENGINES[0]:"abcd",stage.ENGINES[1]:"abXd",
            stage.ENGINES[2]:"abcdX",
        })
        self.assertEqual(got[stage.ENGINES[0]],0.0)
        self.assertEqual(got[stage.ENGINES[1]],0.25)
        self.assertEqual(got[stage.ENGINES[2]],0.25)
        with self.assertRaisesRegex(VisualGateError,"SCORE_INPUT_INVALID"):
            stage.score_alnum_only("abc",{stage.ENGINES[0]:"abc"})

    def test_immutable_private_report_and_audit_tamper_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=root/"semantic_gate"/"multibook_matrix_20261023"
            folder.mkdir(parents=True)
            sample={"graded_page_count":0,"not_graded_count":5,"rows":[]}
            fake=lambda r,m,snapshot_version:sample
            result=stage.execute(root,{},write=True,snapshot_version=9,compute_fn=fake)
            self.assertEqual(result,sample)
            self.assertEqual(stage.execute(root,{},audit=True,snapshot_version=9,
                                           compute_fn=fake),sample)
            with self.assertRaisesRegex(VisualGateError,"ALREADY_FROZEN"):
                stage.execute(root,{},write=True,snapshot_version=9,compute_fn=fake)
            (folder/stage.report_name(9)).write_bytes(b"tampered")
            with self.assertRaisesRegex(VisualGateError,"FROZEN_REPORT_CHANGED"):
                stage.execute(root,{},audit=True,snapshot_version=9,compute_fn=fake)

    def test_model_text_and_source_sha_not_embedded_in_grade_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=fixture(root,approved=True)
            with patch.object(stage,"valid_worker",return_value=({"private_markdown":"HELAO"},5)):
                report=injected(root,data)
            wire=json.dumps(report)
            self.assertNotIn("HELLO",wire)
            self.assertNotIn("HELAO",wire)
            self.assertNotIn("ONLY_SYNTHETIC_BYTE",wire)
            self.assertNotIn("a"*64,wire)


if __name__=="__main__":
    unittest.main()
