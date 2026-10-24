"""Independent human/publisher references stay private and are NOT model outputs."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_reference_gate as gate
from ebook_private_glm_visual_reference import VisualGateError


def fixtures(root):
    private=root/"semantic_gate"/"multibook_matrix_20261023"
    private.mkdir(parents=True)
    matrix=[]
    rapids=[]
    agreed=[]
    for i,book in enumerate(gate.ALL_BOOKS):
        page=126 if book=="B31" else i+21
        text="HELLO 你好"
        model_md="## HELLO 你好\n![img](data:image/png;base64,QUJD)"
        (private/(gate.B31_MD if book=="B31" else gate.file_names(book)[1])).write_text(
            model_md,encoding="utf-8")
        item={"book_id":book,"physical_page":page,
              "source_pdf_sha256_private":f"{i+1:064x}"}
        matrix.append(item)
        rapids.append({"book_id":book,"physical_page":page,
                       "rapidocr_private_rows":[{"text":text}]})
        agreed.append({"book_id":book,"physical_page":page,
                       "rapidocr_normalized_alnum_chars":7,
                       "mineru_nonimage_normalized_alnum_chars":7})
    result={"corpus_id":"SYNTHETIC-ONE","identical_focus_pages":5,"rows":matrix}
    rapid={"pages":rapids}
    consensus={"agreement_is_not_accuracy":True,"rows":agreed}
    return private,result,rapid,consensus


def create_reference(folder,book,page,sha,text="HELLO 你好",**updates):
    gold=folder/gate.REFERENCES
    gold.mkdir(exist_ok=True)
    receipt={
      "schema_version":1,"corpus_id":"SYNTHETIC-ONE",
      "book_id":book,"physical_page":page,
      "original_page_pdf_sha256":sha,
      "reference_origin":"INDEPENDENT_PAGE_TRANSCRIPTION",
      "verification_method":"MANUAL_SOURCE_PAGE_REVIEW",
      "reviewed_source_page":True,
      "not_derived_from_rapidocr_or_mineru":True,
      "reviewer_approval":"INDEPENDENTLY_APPROVED",
      "reviewer_record_id":"REVIEW_20261024_X1",
      "independent_source_sha256":sha,
      "reference_text":text,
      "reference_text_sha256":hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    receipt.update(updates)
    path=gold/f"{book}_p{page:04d}.verified.private.json"
    path.write_text(json.dumps(receipt,ensure_ascii=False),encoding="utf-8")
    return path


class GoldProtocolTests(unittest.TestCase):
    def patch_sources(self,folder,matrix,rapid,consensus):
        stack=ExitStack()
        stack.enter_context(patch.object(gate,"compute_consensus",return_value=consensus))
        stack.enter_context(patch.object(gate,"combined",return_value=matrix))
        stack.enter_context(patch.object(gate,"audit_rapid",return_value=rapid))
        stack.enter_context(patch.object(gate,"_private_folder",return_value=folder))
        return stack

    def test_no_reference_means_null_cer_not_a_fake_zero(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            with self.patch_sources(folder,matrix,rapid,consensus):
                result=gate.execute(root,{},write=True)
                self.assertEqual(result["reference_attested_count"],0)
                self.assertEqual(result["no_reference_count"],5)
                self.assertTrue(all(row["cer_rapidocr"] is None and
                                    row["cer_mineru_basic"] is None
                                    for row in result["rows"]))
                self.assertEqual(gate.execute(root,{},audit=True),result)
                self.assertNotIn("HELLO",json.dumps(result))

    def test_one_private_reviewed_reference_can_compute_exact_cer(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            path=create_reference(folder,first["book_id"],first["physical_page"],
                                  first["source_pdf_sha256_private"],text="HELLO 你")
            with self.patch_sources(folder,matrix,rapid,consensus):
                result=gate.execute(root,{},write=True)
                record=result["rows"][0]
                self.assertEqual(record["reference_state"],
                                 "ATTESTED_REFERENCE_CER_COMPUTED")
                self.assertEqual(result["reference_attested_count"],1)
                self.assertEqual(record["reference_normalized_chars"],6)
                self.assertAlmostEqual(record["cer_rapidocr"],1/6,places=6)
                self.assertAlmostEqual(record["cer_mineru_basic"],1/6,places=6)
                self.assertTrue(record["source_attestation_is_external_claim"])
                self.assertNotIn("HELLO",json.dumps(result))
                self.assertEqual(gate.execute(root,{},audit=True),result)

    def test_edit_distance_is_exact_not_fuzzy_similarity(self):
        self.assertEqual(gate.edit_distance("kitten","sitting"),3)
        self.assertEqual(gate.edit_distance("abc","abc"),0)
        self.assertEqual(gate.edit_distance("ab",""),2)
        self.assertEqual(gate.edit_distance("a","abc"),2)
        with self.assertRaisesRegex(VisualGateError,"BUDGET_EXCEEDED"):
            gate.edit_distance("x"*4000,"y"*4000)

    def test_unreviewed_reference_rejected_and_never_scored(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            create_reference(folder,first["book_id"],first["physical_page"],
              first["source_pdf_sha256_private"],not_derived_from_rapidocr_or_mineru=False)
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaisesRegex(VisualGateError,"ATTESTATION_INVALID"):
                    gate.execute(root,{},write=True)
                self.assertFalse((folder/gate.REPORT).exists())

    def test_wrong_page_and_source_sha_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            create_reference(folder,first["book_id"],first["physical_page"],
                             "b"*64)
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaises(VisualGateError):
                    gate.execute(root,{},write=True)

    def test_false_manual_source_sha_is_not_accepted_even_when_sha_format_valid(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            create_reference(folder,first["book_id"],first["physical_page"],
                first["source_pdf_sha256_private"],
                independent_source_sha256="b"*64)
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaisesRegex(VisualGateError,"MANUAL_SOURCE_PDF_SHA_MISMATCH"):
                    gate.execute(root,{},write=True)
                self.assertFalse((folder/gate.REPORT).exists())

    def test_publisher_reference_requires_real_private_artifact_and_matching_sha(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            ref=create_reference(folder,first["book_id"],first["physical_page"],
                first["source_pdf_sha256_private"],
                reference_origin="PUBLISHER_ORIGINAL_TEXT",
                verification_method="PUBLISHER_SOURCE_VERIFICATION")
            source=ref.with_name(ref.name.replace(
                ".verified.private.json",".publisher_source.private.txt"))
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaisesRegex(VisualGateError,"PUBLISHER_SOURCE_ARTIFACT_MISSING"):
                    gate.execute(root,{},write=True)
                source.write_text("Publisher source excerpt from a truly separate edition",
                                  encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"PUBLISHER_SOURCE_SHA_MISMATCH"):
                    gate.execute(root,{},write=True)
                raw=json.loads(ref.read_text("utf-8"))
                raw["independent_source_sha256"]=hashlib.sha256(source.read_bytes()).hexdigest()
                ref.write_text(json.dumps(raw),encoding="utf-8")
                record=gate.execute(root,{},write=True)
                self.assertEqual(record["reference_attested_count"],1)
                self.assertTrue(record["reference_provenance_truth_requires_external_audit"])

    def test_changed_gold_text_sha_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            create_reference(folder,first["book_id"],first["physical_page"],
                             first["source_pdf_sha256_private"],
                             reference_text_sha256="f"*64)
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaisesRegex(VisualGateError,"SHA_CHANGED"):
                    gate.execute(root,{},write=True)

    def test_reference_never_accepts_publisher_origin_with_manual_method(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            create_reference(folder,first["book_id"],first["physical_page"],
                             first["source_pdf_sha256_private"],
                             reference_origin="PUBLISHER_ORIGINAL_TEXT")
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaisesRegex(VisualGateError,"METHOD_CONFLICT"):
                    gate.execute(root,{},write=True)

    def test_receipt_mutation_or_later_gold_change_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            with self.patch_sources(folder,matrix,rapid,consensus):
                gate.execute(root,{},write=True)
                first=matrix["rows"][0]
                create_reference(folder,first["book_id"],first["physical_page"],
                                 first["source_pdf_sha256_private"])
                with self.assertRaisesRegex(VisualGateError,"RECEIPT_CHANGED"):
                    gate.execute(root,{},audit=True)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    gate.execute(root,{},write=True)

    def test_malicious_symlink_reference_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            first=matrix["rows"][0]
            path=folder/f"{first['book_id']}_p{first['physical_page']:04d}.private.json"
            path.write_text('{"unsafe":true}',encoding="utf-8")
            refdir=folder/gate.REFERENCES
            refdir.mkdir()
            link=refdir/f"{first['book_id']}_p{first['physical_page']:04d}.verified.private.json"
            try: link.symlink_to(path)
            except OSError: self.skipTest("symlinks not available")
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaisesRegex(VisualGateError,"UNSAFE"):
                    gate.execute(root,{},write=True)


    def test_v2_reference_is_scored_without_changing_or_rescoring_v1(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); folder,matrix,rapid,consensus=fixtures(root)
            with self.patch_sources(folder,matrix,rapid,consensus):
                first=gate.execute(root,{},write=True)
                v1=(folder/gate.REPORT)
                frozen=v1.read_bytes()
                self.assertEqual(first["reference_attested_count"],0)
                row=matrix["rows"][0]
                reference=create_reference(folder,row["book_id"],
                    row["physical_page"],row["source_pdf_sha256_private"],
                    text="HELLO 你")
                v2dir=folder/"independent_reference_v2"
                v2dir.mkdir()
                reference.rename(v2dir/reference.name)
                new=gate.execute(root,{},write=True,snapshot_version=2)
                self.assertEqual(new["snapshot_version"],2)
                self.assertEqual(new["reference_attested_count"],1)
                self.assertEqual(new["no_reference_count"],4)
                self.assertEqual(new["previous_snapshot_sha256_private"],
                                 hashlib.sha256(frozen).hexdigest())
                self.assertTrue(new["prior_report_revalidated"])
                self.assertEqual(new["rows"][0]["cer_rapidocr"],round(1/6,6))
                self.assertEqual(v1.read_bytes(),frozen)
                self.assertEqual(gate.execute(root,{},audit=True),first)
                self.assertEqual(gate.execute(root,{},audit=True,
                                              snapshot_version=2),new)
                self.assertNotIn("HELLO",json.dumps(new))

    def test_v2_requires_verified_v1_and_cannot_replace_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,matrix,rapid,consensus=fixtures(root)
            with self.patch_sources(folder,matrix,rapid,consensus):
                with self.assertRaises(VisualGateError):
                    gate.execute(root,{},write=True,snapshot_version=2)
                self.assertFalse((folder/gate.snapshot_names(2)[0]).exists())
                gate.execute(root,{},write=True)
                gate.execute(root,{},write=True,snapshot_version=2)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    gate.execute(root,{},write=True,snapshot_version=2)
                # If an older report is changed, new snapshot verification
                # cannot conceal or ignore broken historical provenance.
                (folder/gate.REPORT).write_text("{}",encoding="utf-8")
                with self.assertRaises(VisualGateError):
                    gate.execute(root,{},audit=True,snapshot_version=2)

    def test_snapshot_versions_are_bounded_not_paths(self):
        for value in (0,9,-1,True,"2",1.0):
            with self.assertRaisesRegex(VisualGateError,"VERSION_INVALID"):
                gate.snapshot_names(value)
        self.assertEqual(gate.snapshot_names(1),(gate.REPORT,gate.REFERENCES))
        self.assertEqual(gate.snapshot_names(2)[1],"independent_reference_v2")
        self.assertEqual(gate.snapshot_names(8)[0],
                         "fivebook_independent_reference_admission.v8.private.json")


if __name__=="__main__":
    unittest.main()
