#!/usr/bin/env python3
"""Zero user-book samples. Only synthetic nodes and directed graph facts."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_semantic_structure_gate import Rejected, evaluate, main

PAGE = {"book_id": "synthetic01", "physical_page": 1, "source_document_sha256": "a" * 64}


def reference():
    return {
        "schema_version": 1, "page": copy.deepcopy(PAGE),
        "evidence": {"tier": "L3_SYNTHETIC_SELF_AUTHORED", "reviewer": "test_suite"},
        "objects": [
            {"role": "source", "kind": "socket", "parent_role": "left"},
            {"role": "sink", "kind": "socket", "parent_role": "right"},
            {"role": "left", "kind": "process"}, {"role": "right", "kind": "process"},
            {"role": "plot", "kind": "chart"}],
        "relations": [{"source_role": "source", "target_role": "sink",
                       "relation": "moves_to", "directed": True}],
        "axes": [{"chart_role": "plot", "dimension": "x", "meaning": "time"}],
        "trends": [{"chart_role": "plot", "shape": "rise_then_fall"}],
    }


def candidate():
    obj = copy.deepcopy(reference())
    obj.pop("evidence")
    obj["engine"] = {"name": "synthetic_engine", "version": "1.0"}
    return obj


class SyntheticStructureGate(unittest.TestCase):
    def test_exact_agreement_never_certifies(self):
        x = evaluate(reference(), candidate())
        self.assertEqual(x["counts"]["missing"], 0)
        self.assertIsNone(x["certified_graph_f1"])
        self.assertFalse(x["human_verified"])
        self.assertFalse(x["graph_verified"])

    def test_reverse_directed_arrow(self):
        x = candidate()
        x["relations"][0]["source_role"] = "sink"
        x["relations"][0]["target_role"] = "source"
        y = evaluate(reference(), x)["counts"]
        self.assertEqual((y["reversed_directed_edges"], y["missing_edges"], y["unexpected_edges"]), (1, 1, 1))

    def test_undirected_reverse_is_equivalent(self):
        gold, pred = reference(), candidate()
        gold["relations"][0]["directed"] = False
        pred["relations"][0].update({"source_role": "sink", "target_role": "source", "directed": False})
        self.assertEqual(evaluate(gold, pred)["counts"]["missing"], 0)

    def test_missing_chart_and_axes(self):
        pred = candidate()
        pred["objects"] = [x for x in pred["objects"] if x["role"] != "plot"]
        pred["axes"] = []
        pred["trends"] = []
        self.assertEqual(evaluate(reference(), pred)["counts"]["missing"], 3)

    def test_wrong_curve_shape(self):
        pred = candidate()
        pred["trends"][0]["shape"] = "always_increasing"
        self.assertEqual(evaluate(reference(), pred)["counts"]["unexpected"], 1)

    def test_hallucinated_extra_arrow(self):
        pred = candidate()
        pred["relations"].append({"source_role": "sink", "target_role": "source",
                                  "relation": "moves_to", "directed": True})
        self.assertEqual(evaluate(reference(), pred)["counts"]["unexpected_edges"], 1)

    def test_ref_human_claim_rejected(self):
        gold = reference()
        gold["humanVerified"] = True
        with self.assertRaisesRegex(Rejected, "UNAUTHORIZED_VERIFICATION_CLAIM"):
            evaluate(gold, candidate())

    def test_candidate_graph_claim_rejected(self):
        pred = candidate()
        pred["graphVerified"] = True
        with self.assertRaisesRegex(Rejected, "UNAUTHORIZED_VERIFICATION_CLAIM"):
            evaluate(reference(), pred)

    def test_mismatched_source_digest_rejected(self):
        pred = candidate()
        pred["page"]["source_document_sha256"] = "b" * 64
        with self.assertRaisesRegex(Rejected, "SOURCE_PAGE_IDENTITY_MISMATCH"):
            evaluate(reference(), pred)

    def test_b31_real_book_id_allowed(self):
        gold, pred = reference(), candidate()
        gold["page"]["book_id"] = "B31"
        pred["page"]["book_id"] = "B31"
        self.assertEqual(evaluate(gold, pred)["counts"]["missing"], 0)

    def test_dangling_edge_rejected(self):
        pred = candidate()
        pred["relations"][0]["target_role"] = "unknown"
        with self.assertRaisesRegex(Rejected, "INVALID_EDGE_ENDPOINT_OR_DIRECTION"):
            evaluate(reference(), pred)

    def test_explicit_abstention_not_success(self):
        pred = candidate()
        pred.update({"abstained": True, "objects": [], "relations": [], "axes": [], "trends": []})
        result = evaluate(reference(), pred)
        self.assertEqual(result["status"], "ABSTAINED_NO_STRUCTURAL_PREDICTION")
        self.assertGreater(result["counts"]["missing"], 0)

    def test_implicit_empty_structure_abstains(self):
        pred = candidate()
        pred.update({"objects": [], "relations": [], "axes": [], "trends": []})
        self.assertEqual(evaluate(reference(), pred)["status"], "ABSTAINED_NO_STRUCTURAL_PREDICTION")

    def test_abstention_with_structure_rejected(self):
        pred = candidate()
        pred["abstained"] = True
        with self.assertRaisesRegex(Rejected, "ABSTENTION_WITH_STRUCTURE"):
            evaluate(reference(), pred)

    def test_cyclic_parent_graph_rejected(self):
        pred = candidate()
        # source -> left -> source is not a valid diagram hierarchy.
        pred["objects"][2]["parent_role"] = "source"
        with self.assertRaisesRegex(Rejected, "CYCLIC_OBJECT_CONTAINMENT"):
            evaluate(reference(), pred)

    def test_conflicting_same_dimension_axis_rejected(self):
        pred = candidate()
        pred["axes"].append({"chart_role": "plot", "dimension": "x",
                             "meaning": "distance"})
        with self.assertRaisesRegex(Rejected, "AMBIGUOUS_CHART_AXIS"):
            evaluate(reference(), pred)

    def test_multiseries_same_shape_is_not_collapsed(self):
        ref, pred = reference(), candidate()
        additions = [
            {"role": "curve_a", "kind": "series", "parent_role": "plot"},
            {"role": "curve_b", "kind": "series", "parent_role": "plot"},
        ]
        curves = [
            {"chart_role": "plot", "series_role": "curve_a", "shape": "rise"},
            {"chart_role": "plot", "series_role": "curve_b", "shape": "rise"},
        ]
        for doc in (ref, pred):
            doc["objects"].extend(copy.deepcopy(additions))
            doc["trends"] = copy.deepcopy(curves)
        correct = evaluate(ref, pred)
        self.assertEqual(correct["counts"]["missing"], 0)
        self.assertEqual(correct["counts"]["candidate_facts"],
                         correct["counts"]["reference_facts"])
        self.assertIsNone(correct["certified_graph_f1"])
        pred["trends"][1]["shape"] = "fall"
        wrong = evaluate(ref, pred)
        self.assertEqual((wrong["counts"]["missing"], wrong["counts"]["unexpected"]), (1, 1))

    def test_series_must_be_inside_named_chart(self):
        pred = candidate()
        pred["objects"].append({"role": "curve_a", "kind": "series",
                                "parent_role": "left"})
        pred["trends"] = [{"chart_role": "plot", "series_role": "curve_a",
                           "shape": "rise"}]
        with self.assertRaisesRegex(Rejected, "SERIES_OUTSIDE_CHART"):
            evaluate(reference(), pred)

    def test_duplicate_curve_trend_is_ambiguous(self):
        pred = candidate()
        pred["objects"].append({"role": "curve_a", "kind": "series",
                                "parent_role": "plot"})
        pred["trends"] = [
            {"chart_role": "plot", "series_role": "curve_a", "shape": "rise"},
            {"chart_role": "plot", "series_role": "curve_a", "shape": "fall"},
        ]
        with self.assertRaisesRegex(Rejected, "AMBIGUOUS_CHART_TREND"):
            evaluate(reference(), pred)

    def test_unknown_series_role_is_rejected(self):
        pred = candidate()
        pred["trends"] = [{"chart_role": "plot", "series_role": "ghost",
                           "shape": "rise"}]
        with self.assertRaisesRegex(Rejected, "INVALID_TREND_SERIES"):
            evaluate(reference(), pred)

    def test_private_report_omits_graph_facts(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / "reference.json").write_text(json.dumps(reference()), encoding="utf-8")
            (folder / "pred.json").write_text(json.dumps(candidate()), encoding="utf-8")
            output = folder / "out.json"
            self.assertEqual(main(["--private-root", str(folder), "--reference", str(folder / "reference.json"),
                                   "--prediction", str(folder / "pred.json"), "--output", str(output)]), 0)
            saved = output.read_text(encoding="utf-8")
            self.assertNotIn('"source"', saved)
            self.assertNotIn("moves_to", saved)
            self.assertNotIn(PAGE["source_document_sha256"], saved)

    def test_output_outside_private_root_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / "reference.json").write_text(json.dumps(reference()), encoding="utf-8")
            (folder / "pred.json").write_text(json.dumps(candidate()), encoding="utf-8")
            with self.assertRaisesRegex(Rejected, "PRIVATE_REPORT_PATH_REQUIRED"):
                main(["--private-root", str(folder), "--reference", str(folder / "reference.json"),
                      "--prediction", str(folder / "pred.json"), "--output", str(folder.parent / "outside.json")])


if __name__ == "__main__":
    unittest.main()
