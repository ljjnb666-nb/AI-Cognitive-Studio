"""Synthetic mutation-based checks; never require private books."""
import copy
import json
from pathlib import Path
import sys
import unittest
BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "scripts"))
from ebook_evidence_gate import GateError, validate
class EvidenceGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sample = json.loads((BASE / "corpus" / "ebook-20261022.cross-engine-evidence.json").read_text(encoding="utf-8"))
    def row(self, data, engine="MinerU Flash", book="B15"):
        return next(x for x in data["observations"] if x["engine"] == engine and x["book_id"] == book)
    def rejected(self, data):
        with self.assertRaises(GateError):
            validate(data)
    def test_valid_ledger(self):
        self.assertEqual(validate(self.sample), 12)
    def test_plausible_character_count_drift_rejected(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"PaddleOCR","B15")["characters"]=223
        self.rejected(d)
    def test_plausible_latency_drift_rejected(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"Docling","B31")["wall_ms"]=10044.2
        self.rejected(d)
    def test_native_proxy_drift_rejected(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"Docling","B16")["native_text_layer_proxy_cer"]=0.0035
        self.rejected(d)
    def test_document_hash_mismatch_rejected(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"PaddleOCR","B31")["source_document_sha256"]="a"*64
        self.rejected(d)
    def test_cross_book_hash_swap_rejected(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"Docling","B15")["source_document_sha256"]=self.row(d,"Docling","B16")["source_document_sha256"]
        self.rejected(d)
    def test_manifest_hash_drift_rejected(self):
        d=copy.deepcopy(self.sample)
        manifest=json.loads((BASE/"corpus"/"ebook-20261022.manifest.json").read_text(encoding="utf-8"))
        entry=next(x for x in manifest["sources"] if x["id"]=="B15")
        entry["sha256"]="a"*64
        with self.assertRaises(GateError):
            validate(d, manifest)
    def test_manifest_page_mismatch_rejected(self):
        d=copy.deepcopy(self.sample)
        manifest=json.loads((BASE/"corpus"/"ebook-20261022.manifest.json").read_text(encoding="utf-8"))
        entry=next(x for x in manifest["sources"] if x["id"]=="B31")
        entry["selected_physical_pages"]=[15]
        with self.assertRaises(GateError):
            validate(d, manifest)
    def test_spatial_box_invented_on_non_docling_rejected(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"PaddleOCR","B15")["picture_boxes"]=2
        self.rejected(d)
    def test_duplicate_manifest_source_rejected(self):
        d=copy.deepcopy(self.sample)
        manifest=json.loads((BASE/"corpus"/"ebook-20261022.manifest.json").read_text(encoding="utf-8"))
        entry=next(x for x in manifest["sources"] if x["id"]=="B15")
        manifest["sources"].append(copy.deepcopy(entry))
        with self.assertRaises(GateError):
            validate(d,manifest)

    def test_boolean_run_id_cannot_impersonate_number(self):
        d=copy.deepcopy(self.sample)
        self.row(d,"Docling","B15")["run_id"]=True
        self.rejected(d)
    def test_winner_rejected(self):
        d=copy.deepcopy(self.sample); d["selection_status"]="FINAL"; self.rejected(d)
    def test_wrong_sha(self):
        d=copy.deepcopy(self.sample); d["source_head_sha"]="a"*40; self.rejected(d)
    def test_wrong_run(self):
        d=copy.deepcopy(self.sample); self.row(d)["run_id"]=12; self.rejected(d)
    def test_dropped_page(self):
        d=copy.deepcopy(self.sample); d["observations"].pop(); self.rejected(d)
    def test_duplicate_page(self):
        d=copy.deepcopy(self.sample); d["observations"][0]=d["observations"][1]; self.rejected(d)
    def test_mineru_scanned_not_ocr_success(self):
        d=copy.deepcopy(self.sample); self.row(d)["interpretation"]="SCANNED_OCR_TEXT_ONLY_NOT_SEMANTICS"; self.rejected(d)
    def test_old_base64_count_rejected(self):
        d=copy.deepcopy(self.sample); self.row(d)["characters"]=382755; self.rejected(d)
    def test_graph_unverified(self):
        d=copy.deepcopy(self.sample); self.row(d,"Docling","B31")["graph_semantics"]="VERIFIED"; self.rejected(d)
    def test_no_fake_scanned_reference(self):
        d=copy.deepcopy(self.sample); self.row(d,"PaddleOCR","B31")["native_text_layer_proxy_cer"]=0.; self.rejected(d)
    def test_certified_cer_denied(self):
        d=copy.deepcopy(self.sample); d["certified_cer"]=0.; self.rejected(d)
    def test_human_verified_denied(self):
        d=copy.deepcopy(self.sample); self.row(d,"PaddleOCR","B16")["human_verified"]=True; self.rejected(d)
    def test_rotated_reference_not_claimed(self):
        d=copy.deepcopy(self.sample); self.row(d,"Docling","B15")["spatial_alignment"]="PROVISIONAL_SPATIAL_OVERLAP_ONLY"; self.rejected(d)
    def test_private_book_text_field_denied(self):
        d=copy.deepcopy(self.sample); d["observations"][0]["ocr_text"]="secret"; self.rejected(d)
    def test_speed_ranking_denied(self):
        d=copy.deepcopy(self.sample); d["comparison_policy"]="FASTEST_WINS"; self.rejected(d)
    def test_fabricated_picture_count_denied(self):
        d=copy.deepcopy(self.sample); self.row(d,"Docling","B31")["picture_boxes"]=4; self.rejected(d)
if __name__ == "__main__":
    unittest.main()
