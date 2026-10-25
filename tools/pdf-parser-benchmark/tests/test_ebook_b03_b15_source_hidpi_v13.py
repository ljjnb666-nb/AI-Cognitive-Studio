"""B03/B15 v13: only synthetic PDFs. Never read or upload original books."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b03_b15_source_hidpi_v13 as stage
from ebook_private_glm_visual_reference import VisualGateError

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def fixture(root):
    import fitz
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    records={}
    for book,page in stage.TARGETS:
        doc=fitz.open()
        pg=doc.new_page(width=270,height=350)
        pg.insert_text((25,35),"SYNTHETIC PAGE ONLY "+book)
        raw=doc.tobytes()
        doc.close()
        source=root/(book+".pdf")
        source.write_bytes(raw)
        records[book]={
            "physical_page":page,
            "source_file":source,
            "original_pdf_sha256":"a"*64,
            "single_pdf_sha256":digest(raw),
        }
    return folder,records

def kwargs(entries):
    return {"contract_fn":lambda root,manifest:(entries,)}

class SourceHiDpiTests(unittest.TestCase):
    def test_source_only_pdf_to_nine_tiles_no_gold(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder,records=fixture(root)
            packet,artifacts,receipt=stage.packet(root,{},**kwargs(records))
            self.assertEqual(packet,folder)
            self.assertEqual(len(artifacts),20)
            self.assertEqual(receipt["pages"],2)
            self.assertEqual(receipt["tiles"],18)
            self.assertIsNone(receipt["cer"])
            self.assertIsNone(receipt["reviewer_approval"])
            self.assertIsNone(receipt["gold_reference"])
            self.assertEqual(receipt["ocr_or_model_calls"],0)
            self.assertTrue(all(len(r["region_tiles"])==9 for r in receipt["source_pages"]))
            for row in receipt["source_pages"]:
                self.assertTrue(row["intrinsic_scan_detail_not_guaranteed"])
                self.assertTrue(row["source_only_not_independent_gold"])
            self.assertNotIn(b"SYNTHETIC PAGE ONLY",artifacts[stage.REPORT])
            self.assertNotIn(b"SYNTHETIC PAGE ONLY",artifacts[stage.INDEX])
            self.assertNotIn(("a"*64).encode(),artifacts[stage.INDEX])

    def test_private_create_replay_and_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder,records=fixture(root)
            result=stage.execute(root,{},write=True,**kwargs(records))
            self.assertEqual(result["tiles"],18)
            self.assertEqual(len(list((folder/stage.SUBDIR).iterdir())),20)
            self.assertEqual(stage.execute(root,{},audit=True,**kwargs(records)),result)
            with self.assertRaisesRegex(VisualGateError,"SNAPSHOT_ALREADY_EXISTS"):
                stage.execute(root,{},write=True,**kwargs(records))
            tile=folder/stage.SUBDIR/"B15_p0109_R3C2.private.png"
            tile.write_bytes(b"changed")
            with self.assertRaisesRegex(VisualGateError,"AUDIT_BYTES_CHANGED"):
                stage.execute(root,{},audit=True,**kwargs(records))

    def test_staged_pdf_tamper_refused_without_private_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder,records=fixture(root)
            records["B03"]["source_file"].write_bytes(b"altered")
            with self.assertRaisesRegex(VisualGateError,"STAGED_SOURCE_SHA_CHANGED"):
                stage.execute(root,{},write=True,**kwargs(records))
            self.assertFalse((folder/stage.SUBDIR).exists())

    def test_wrong_physical_page_and_missing_book_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            _,records=fixture(root)
            del records["B15"]
            with self.assertRaisesRegex(VisualGateError,"SOURCE_ENTRY_INVALID"):
                stage.packet(root,{},**kwargs(records))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            _,records=fixture(root)
            records["B03"]["physical_page"]=66
            with self.assertRaisesRegex(VisualGateError,"SOURCE_ENTRY_INVALID"):
                stage.packet(root,{},**kwargs(records))

    def test_staged_source_must_be_one_page(self):
        import fitz
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            _,records=fixture(root)
            doc=fitz.open()
            doc.new_page();doc.new_page()
            raw=doc.tobytes();doc.close()
            records["B15"]["source_file"].write_bytes(raw)
            records["B15"]["single_pdf_sha256"]=digest(raw)
            with self.assertRaisesRegex(VisualGateError,"PAGE_COUNT_CHANGED"):
                stage.packet(root,{},**kwargs(records))

    def test_write_and_audit_flags_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            _,records=fixture(root)
            for flags in ({"write":False,"audit":False},{"write":True,"audit":True}):
                with self.assertRaisesRegex(VisualGateError,"EXPLICIT_MODE_REQUIRED"):
                    stage.execute(root,{},**flags,**kwargs(records))

if __name__=="__main__":
    unittest.main()
