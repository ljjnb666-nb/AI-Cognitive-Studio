"""Only synthetic bytes, not actual books or OCR text."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_v28_source_bridge_v29 as bridge

HASH=lambda raw:hashlib.sha256(raw).hexdigest()
PNG=b"\x89PNG\r\n\x1a\n"+b"SYNTHETIC-DATA-ONLY"
FOCUS=bridge.FOCUS

class PrivateSourceBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.folder=self.root/"semantic_gate"/bridge.SOURCE_FOLDER
        self.folder.mkdir(parents=True)
        hi=self.folder/bridge.V17
        hi.mkdir()
        self.manifest={"corpus_id":"ACS-EBOOK-20261022-A","sources":[]}
        native_rows=[]
        hidpi_rows=[]
        for book in list(bridge.BOOKS)+["B16"]:
            if book=="B16":
                native_rows.append({"book_id":"B16","source_document_sha256":HASH(b"B16"),
                                    "ocr_focus_requested":None,"pages":[
                                        {"physical_page":p} for p in (15,53,106,159)]})
                continue
            page=FOCUS[book]
            pages=sorted({15,page,page+1,page+2})
            self.manifest["sources"].append({"id":book,"format":"pdf","sha256":HASH(book.encode()),
                "total_physical_pages":1000,"selected_physical_pages":pages,
                "ocr_physical_pages":[page]})
            entry=f"{book}_p{page:04d}.private.png"
            data=PNG+book.encode()
            (self.folder/entry).write_bytes(data)
            native_rows.append({"book_id":book,
                "source_document_sha256":HASH(book.encode()),"ocr_focus_requested":page,
                "pages":[{"physical_page":p,**({
                    "ocr_focus_png":entry,"ocr_focus_png_sha256":HASH(data)
                } if p==page else {})} for p in pages]})
            if book in ("B08","B29","B31"):
                full=f"{book}_p{page:04d}_FULL.private.png"
                pixels=PNG+b"HIDPI-"+book.encode()
                (hi/full).write_bytes(pixels)
                hidpi_rows.append({"book_id":book,"physical_page":page,
                    "original_pdf_sha256_private":HASH(book.encode()),
                    "full_png_name":full,"full_png_sha256_private":HASH(pixels),
                    "independent_gold":False})
        self.native={"schema_version":1,"evidence":bridge.NATIVE_EVIDENCE,"rows":native_rows}
        self.v17={"schema_version":17,"status":"SOURCE_ONLY_NOT_GOLD",
                  "independent_approval":False,"rows":hidpi_rows}
        self.save()
    def save(self):
        (self.folder/bridge.NATIVE_RECEIPT).write_text(json.dumps(self.native))
        (self.folder/bridge.V17/bridge.V17_RECEIPT).write_text(json.dumps(self.v17))
    def test_private_staging_and_readonly_byte_replay(self):
        receipt=bridge.execute(self.root,self.manifest,write=True)
        self.assertEqual(receipt["staged_pages"],5)
        self.assertEqual(receipt["unavailable_selected_pages"],15)
        self.assertEqual(receipt["independent_approved_pages"],0)
        self.assertIsNone(receipt["official_cer"])
        self.assertEqual(bridge.execute(self.root,self.manifest,audit=True),receipt)
        target=self.folder/bridge.SUBDIR
        self.assertEqual(len(list(target.iterdir())),7)
        packet=json.loads((target/bridge.PACKET).read_text())
        self.assertTrue(all(x["reference"] is None and x["candidates"]==[]
                            for x in packet["rows"]))
        self.assertEqual(len([x for x in receipt["rows"]
                              if x["source_tier"]=="NATIVE_FOCUS_SOURCE_1P4X"]),2)
    def test_rejects_mutated_native_source_image(self):
        p=self.folder/"B03_p0067.private.png"
        p.write_bytes(p.read_bytes()+b"corrupted")
        with self.assertRaisesRegex(bridge.GateError,"SOURCE_PNG_SHA_CHANGED"):
            bridge.source_bundle(self.root,self.manifest)
    def test_rejects_mutated_hidpi_source_image(self):
        p=self.folder/bridge.V17/"B08_p0064_FULL.private.png"
        p.write_bytes(p.read_bytes()+b"corrupted")
        with self.assertRaisesRegex(bridge.GateError,"SOURCE_PNG_SHA_CHANGED"):
            bridge.source_bundle(self.root,self.manifest)
    def test_rejects_swapped_book_sha_and_wrong_focus(self):
        self.manifest["sources"][0]["sha256"]=HASH(b"OTHER")
        with self.assertRaisesRegex(bridge.GateError,"NATIVE_SOURCE_PAGE_IDENTITY_CHANGED"):
            bridge.source_bundle(self.root,self.manifest)
        self.manifest["sources"][0]["sha256"]=HASH(b"B03")
        self.native["rows"][0]["ocr_focus_requested"]=999
        self.save()
        with self.assertRaisesRegex(bridge.GateError,"NATIVE_SOURCE_PAGE_IDENTITY_CHANGED"):
            bridge.source_bundle(self.root,self.manifest)
    def test_no_rewrite_and_fail_on_staged_tamper(self):
        bridge.execute(self.root,self.manifest,write=True)
        with self.assertRaisesRegex(bridge.GateError,"PRIVATE_BRIDGE_SNAPSHOT_EXISTS"):
            bridge.execute(self.root,self.manifest,write=True)
        p=self.folder/bridge.SUBDIR/bridge.PACKET
        p.write_bytes(p.read_bytes()+b"\n")
        with self.assertRaisesRegex(bridge.GateError,"PRIVATE_BRIDGE_CONTENT_CHANGED"):
            bridge.execute(self.root,self.manifest,audit=True)
    def test_no_fake_approved_gold_and_no_partial_as_full(self):
        self.v17["rows"][0]["independent_gold"]=True
        self.save()
        with self.assertRaisesRegex(bridge.GateError,"V17_SOURCE_IDENTITY_CHANGED"):
            bridge.source_bundle(self.root,self.manifest)
    def test_missing_matrix_and_duplicate_identity_denied(self):
        p=self.folder/bridge.NATIVE_RECEIPT
        p.unlink()
        with self.assertRaisesRegex(bridge.GateError,"PRIVATE_INPUT_MISSING"):
            bridge.source_bundle(self.root,self.manifest)
        self.save()
        self.native["rows"][0]["book_id"]="B08"
        self.save()
        with self.assertRaisesRegex(bridge.GateError,"SOURCE_RECEIPT_ROW_DUPLICATE"):
            bridge.source_bundle(self.root,self.manifest)

if __name__=="__main__":
    unittest.main()
