"""Synthetic-only private Gold gate tests. No user book text, paid models or APIs."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_private_gold_cer_gate_v28 as gate

SHA=lambda b:hashlib.sha256(b).hexdigest()
BOOKS=gate.BOOKS

class GoldGateTests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory()
        self.addCleanup(self.t.cleanup)
        self.base=Path(self.t.name)
        self.root=self.base/"private"
        self.root.mkdir()
        for sub in ("pages","evidence","out"):
            (self.root/sub).mkdir()
        self.manifest={"corpus_id":"SYNTHETIC-NO-BOOK-CONTENT","sources":[
            {"id":book,"sha256":SHA(book.encode()),"total_physical_pages":100,
             "selected_physical_pages":[5]} for book in BOOKS]}
        self.packet={"schema_version":28,"corpus_id":self.manifest["corpus_id"],"rows":[]}
        for book in BOOKS:
            png=f"{book}_p0005_FULL.private.png"
            data=b"SYNTHETIC-PNG-"+book.encode()
            (self.root/"pages"/png).write_bytes(data)
            self.packet["rows"].append({"book_id":book,"physical_page":5,
                "source_pdf_sha256":SHA(book.encode()),"source_png_filename":png,
                "source_png_sha256":SHA(data),"reference":None,"bleedthrough":"UNDETERMINED",
                "candidates":[{"engine":"RapidOCR","text":"一二三",
                               "physical_page":5,"source_pdf_sha256":SHA(book.encode())}]})
    def approve(self,row):
        text="一二三"
        row["bleedthrough"]="FRONT_ONLY_VERIFIED"
        row["reference"]={"text":text,"text_sha256":SHA(text.encode()),
            "authority":"SOURCE_INDEPENDENT_APPROVED","review_origin":"DIRECT_SOURCE_IMAGE",
            "source_png_sha256":row["source_png_sha256"],
            "bleedthrough_verdict":row["bleedthrough"],
            "review_receipt":{"status":"APPROVED","source_png_sha256":row["source_png_sha256"],
                "reference_text_sha256":SHA(text.encode()),"review_source":"ORIGINAL_PAGE_IMAGE",
                "engine_candidates_not_used_as_reference":True}}
    def report(self):
        return gate.make_report(self.manifest,self.packet,self.root/"pages")
    def test_missing_gold_gives_null_cer(self):
        r=self.report()
        self.assertEqual(r["pending_pages"],5)
        self.assertEqual(r["complete_books"],[])
        self.assertIsNone(r["official_fivebook_cer"])
        self.assertIsNone(r["provisional_page_metrics"])
    def test_only_complete_fivebooks_can_have_official_cer(self):
        for row in self.packet["rows"]:self.approve(row)
        r=self.report()
        self.assertTrue(r["fivebook_gold_complete"])
        self.assertEqual(r["official_fivebook_cer"][0]["cer"],0.0)
        self.packet["rows"][0]["candidates"][0]["text"]="一二甲"
        changed=self.report()["official_fivebook_cer"][0]
        self.assertEqual(changed["errors"],1)
        self.assertAlmostEqual(changed["cer"],1/15)
    def test_partial_approval_yields_provisional_not_official(self):
        self.approve(self.packet["rows"][0])
        r=self.report()
        self.assertEqual(r["pending_pages"],4)
        self.assertIsNone(r["official_fivebook_cer"])
        self.assertEqual(r["provisional_page_metrics"][0]["evaluated_pages"],1)
    def test_declared_approval_requires_independent_source_receipt(self):
        self.approve(self.packet["rows"][0])
        self.packet["rows"][0]["reference"]["review_receipt"]["engine_candidates_not_used_as_reference"]=False
        with self.assertRaisesRegex(gate.GateError,"REFERENCE_REVIEW_RECEIPT_INVALID"):
            self.report()
    def test_bleedthrough_unresolved_must_not_be_gold(self):
        self.approve(self.packet["rows"][1])
        self.packet["rows"][1]["bleedthrough"]="UNDETERMINED"
        self.packet["rows"][1]["reference"]["bleedthrough_verdict"]="UNDETERMINED"
        with self.assertRaisesRegex(gate.GateError,"REFERENCE_AUTHORITY_NOT_ESTABLISHED"):
            self.report()
    def test_source_identity_image_tamper_and_missing_pages_rejected(self):
        self.packet["rows"][0]["source_pdf_sha256"]="f"*64
        with self.assertRaisesRegex(gate.GateError,"GOLD_SOURCE_HASH_MISMATCH"):
            self.report()
        self.packet["rows"][0]["source_pdf_sha256"]=SHA(b"B03")
        (self.root/"pages"/"B03_p0005_FULL.private.png").write_bytes(b"CHANGED")
        with self.assertRaisesRegex(gate.GateError,"GOLD_SOURCE_IMAGE_CHANGED"):
            self.report()
        del self.packet["rows"][0]
        self.assertEqual(self.report()["missing_packet_pages"],1)
        self.assertEqual(self.report()["pending_pages"],5)
        self.assertIsNone(self.report()["official_fivebook_cer"])
    def test_engine_agreement_is_not_gold(self):
        self.packet["rows"][0]["candidates"].append({
            **self.packet["rows"][0]["candidates"][0],"engine":"MinerU"})
        self.packet["rows"][0]["candidates"].append({
            **self.packet["rows"][0]["candidates"][0],"engine":"Docling"})
        self.assertIsNone(self.report()["official_fivebook_cer"])
    def test_empty_candidate_is_real_deletion_error(self):
        for row in self.packet["rows"]:self.approve(row)
        self.packet["rows"][0]["candidates"][0]["text"]=""
        r=self.report()["official_fivebook_cer"][0]
        self.assertEqual(r["errors"],3)
        self.assertAlmostEqual(r["cer"],3/15)
    def test_missing_one_engine_page_must_not_be_full_cer(self):
        for row in self.packet["rows"]:self.approve(row)
        self.packet["rows"][0]["candidates"]=[]
        r=self.report()
        self.assertTrue(r["fivebook_gold_complete"])
        self.assertIsNone(r["official_fivebook_cer"])
        self.assertEqual(r["provisional_page_metrics"][0]["evaluated_pages"],4)
    def test_rejects_wrong_page_and_duplicate_rows(self):
        self.packet["rows"][0]["physical_page"]=50
        with self.assertRaisesRegex(gate.GateError,"GOLD_SOURCE_PAGE_MISMATCH"):
            self.report()
        self.packet["rows"][0]["physical_page"]=5
        self.packet["rows"].append(copy.deepcopy(self.packet["rows"][0]))
        with self.assertRaisesRegex(gate.GateError,"GOLD_SOURCE_PAGE_MISMATCH"):
            self.report()
    def test_json_duplicate_keys_rejected_and_cer_exacts(self):
        p=self.root/"evidence"/"bad.json"
        p.write_text('{"a":1,"a":2}',encoding="utf-8")
        with self.assertRaisesRegex(gate.GateError,"DUPLICATE_JSON_KEYS"):
            gate.read_json(p)
        self.assertEqual(gate.distance("学习中文","学习汉语"),2)
        self.assertEqual(gate.distance("ABCD","ABC"),1)
    def test_cli_safe_null_and_no_private_text_in_stdout(self):
        from contextlib import redirect_stdout
        from io import StringIO
        for name,data in (("manifest.json",self.manifest),("packet.json",self.packet)):
            (self.root/"evidence"/name).write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8")
        old=sys.argv
        sys.argv=["gate","--private-root",str(self.root),
            "--manifest",str(self.root/"evidence/manifest.json"),
            "--packet",str(self.root/"evidence/packet.json"),
            "--source-images",str(self.root/"pages"),
            "--private-output",str(self.root/"out/output.private.json")]
        try:
            stdout=StringIO()
            with redirect_stdout(stdout):code=gate.main()
            self.assertEqual(code,0)
            self.assertIn("OFFICIAL_CER=NULL",stdout.getvalue())
            self.assertNotIn("一二三",stdout.getvalue())
            report=json.loads((self.root/"out/output.private.json").read_text())
            self.assertIsNone(report["official_fivebook_cer"])
            with redirect_stdout(StringIO()):
                self.assertEqual(gate.main(),2)
        finally:
            sys.argv=old

if __name__=="__main__":
    unittest.main()
