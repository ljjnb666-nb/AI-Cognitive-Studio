"""Synthetic zero-book layout evidence regression."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_layout_signals import paddle_layout_signals,docling_layout_signals
class TestLayout(unittest.TestCase):
    def test_paddle_fields_privacy(self):
        d=paddle_layout_signals([{"res":{"rec_texts":["私密","private"],"rec_scores":[0.95,0.3],
            "rec_polys":[[],[]],"dt_polys":[[],[]]}}])
        self.assertEqual((d["recognized_text_boxes"],d["recognized_polygons"]), (2,2))
        self.assertEqual(d["low_confidence_boxes"],1)
        self.assertEqual(d["confidence_mean"],0.625)
        self.assertEqual(d["geometry_integrity"],"CONSISTENT")
        self.assertNotIn("私密",str(d))
        self.assertNotIn("private",str(d))
    def test_paddle_flat(self):
        self.assertEqual(paddle_layout_signals([{"rec_texts":["x"]}])["recognized_text_boxes"],1)
    def test_paddle_mismatched_polygons(self):
        self.assertEqual(paddle_layout_signals([{"rec_texts":["x"],"rec_polys":[]}])["geometry_integrity"],"INCONSISTENT")
    def test_paddle_missing_scores(self):
        d=paddle_layout_signals([{"rec_texts":["x"]}])
        self.assertIsNone(d["confidence_mean"])
        self.assertEqual(d["geometry_integrity"],"NOT_AVAILABLE")
    def test_paddle_nan(self):
        with self.assertRaises(ValueError):
            paddle_layout_signals([{"rec_texts":["x"],"rec_scores":[float("nan")]}])
    def test_paddle_over_one(self):
        with self.assertRaises(ValueError):
            paddle_layout_signals([{"rec_texts":["x"],"rec_scores":[1.1]}])
    def test_paddle_missing_text_list(self):
        with self.assertRaises(TypeError):
            paddle_layout_signals([{"rec_scores":[0.6]}])
    def test_paddle_two_results(self):
        d=paddle_layout_signals([{"rec_texts":["a"],"rec_scores":[0.8]},
            {"rec_texts":["b","c"],"rec_scores":[0.7,0.9]}])
        self.assertEqual(d["recognized_text_boxes"],3)
        self.assertEqual(d["confidence_mean"],0.8)
    def test_docling_privacy(self):
        obj=SimpleNamespace(text="私密",prov=[object()])
        d=docling_layout_signals(SimpleNamespace(texts=[obj],pictures=[obj,obj],tables=[],groups=[obj]))
        self.assertEqual(d["picture_items"],2)
        self.assertEqual(d["items_with_provenance"],3)
        self.assertNotIn("私密",str(d))
    def test_docling_optional_fields(self):
        self.assertEqual(docling_layout_signals(SimpleNamespace(texts=[]))["picture_items"],0)
    def test_docling_never_infers_graph(self):
        d=docling_layout_signals(SimpleNamespace(pictures=[SimpleNamespace(prov=[])]))
        self.assertEqual(d["graph_relationships"],0)
        self.assertEqual(d["graph_semantics"],"UNVERIFIED")
    def test_docling_bad_field(self):
        with self.assertRaises(ValueError):
            docling_layout_signals(SimpleNamespace(texts=object()))
if __name__=="__main__":
    unittest.main()
