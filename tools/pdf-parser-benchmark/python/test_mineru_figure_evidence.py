"""Synthetic-only regression for local MinerU full-page figure evidence."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mineru_figure_evidence import EvidenceBlocked, plan_figures, validate_source

SHA = "a" * 64
REF1 = f"![Image block](doc:{SHA[:8]}/tier:flash/page:1/block:1)"
REF3 = f"![Image block](doc:{SHA[:8]}/tier:flash/page:3/block:7)"


def sample(extra1=REF1, extra3=REF3):
    lines = ["<!-- page 1 of 3 -->", "正文。", extra1,
             "<!-- page 2 of 3 -->", chr(96)*3 + "python",
             "print('safe')", chr(96)*3,
             "<!-- page 3 of 3 -->", "另一页。", extra3]
    return "\n".join(lines)


class PlanFigureTest(unittest.TestCase):
    def test_references_bound_to_correct_page(self):
        result = plan_figures(sample(), SHA)
        self.assertEqual([(x.local_page, len(x.refs)) for x in result], [(1, 1), (3, 1)])
        self.assertEqual(result[1].refs, (f"doc:{SHA[:8]}/tier:flash/page:3/block:7",))

    def test_nonfigure_page_never_generates_unproven_image(self):
        self.assertEqual(plan_figures(sample("", ""), SHA), [])

    def test_missing_middle_marker_rejected(self):
        with self.assertRaises(EvidenceBlocked):
            plan_figures(sample().replace("<!-- page 2 of 3 -->", ""), SHA)

    def test_no_untrusted_url_or_relative_path(self):
        for spoof in ["![Image block](https://remote.invalid/leak)",
                      "![Image block](../../private.pdf)",
                      "![caption](doc:aaaaaaa/tier:flash/page:1/block:1)"]:
            with self.subTest(spoof=spoof):
                with self.assertRaises(EvidenceBlocked):
                    plan_figures(sample(spoof, REF3), SHA)

    def test_cross_page_and_wrong_source_rejected(self):
        for spoof in [REF1.replace("page:1", "page:3"),
                      REF1.replace("doc:aaaaaaaa", "doc:bbbbbbbb"),
                      REF1.replace("tier:flash", "tier:other")]:
            with self.subTest(spoof=spoof):
                with self.assertRaises(EvidenceBlocked):
                    plan_figures(sample(spoof, REF3), SHA)

    def test_duplicate_ref_rejected(self):
        with self.assertRaises(EvidenceBlocked):
            plan_figures(sample(REF1 + "\n" + REF1, REF3), SHA)

    def test_fenced_marker_and_ref_are_not_metadata(self):
        text = sample().replace("print('safe')", "<!-- page 100 of 3 -->\n" + REF1)
        self.assertEqual(len(plan_figures(text, SHA)), 2)

    def test_malformed_real_marker_must_fail(self):
        with self.assertRaises(EvidenceBlocked):
            plan_figures(sample().replace("<!-- page 1 of 3 -->", "<!-- page x of 3 -->"), SHA)

    def test_before_marker_body_is_rejected(self):
        with self.assertRaises(EvidenceBlocked):
            plan_figures("untrusted prose\n" + sample(), SHA)

    def test_invalid_digest_or_tier(self):
        with self.assertRaises(EvidenceBlocked):
            plan_figures(sample(), "a" * 12)
        with self.assertRaises(EvidenceBlocked):
            plan_figures(sample(), SHA, expected_tier="advanced")


class FixtureIntegrityTest(unittest.TestCase):
    def test_parent_and_subset_sha_must_match(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            folder = root / "fixtures"
            folder.mkdir()
            data = [("RB-PDF-12", b"FAKE-PDF-SUBSET"),
                    ("RB-PDF-02", b"FAKE-PDF-PARENT")]
            rows = []
            for fid, blob in data:
                (folder / (fid + ".pdf")).write_bytes(blob)
                rows.append({"id": fid, "filename": fid + ".pdf",
                             "expectedSha256": hashlib.sha256(blob).hexdigest(),
                             "declaredBytes": len(blob)})
            rows[0].update({"fixtureClass": "private-real-page-subset",
                            "sourceFixtureId": "RB-PDF-02",
                            "sourcePages1Based": [73, 145, 261],
                            "sourceSha256": rows[1]["expectedSha256"]})
            (folder / "fixtures.manifest.json").write_text(
                json.dumps({"fixtures": rows}), encoding="utf-8")
            pdf, digest, pages = validate_source(root, "RB-PDF-12")
            self.assertEqual(pdf.name, "RB-PDF-12.pdf")
            self.assertEqual(pages, (73, 145, 261))
            self.assertEqual(digest, rows[0]["expectedSha256"])
            (folder / "RB-PDF-02.pdf").write_bytes(b"CHANGED-PARENT")
            with self.assertRaises(EvidenceBlocked):
                validate_source(root, "RB-PDF-12")

    def test_outside_fixture_id_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(EvidenceBlocked):
                validate_source(Path(d), "../../outside")


if __name__ == "__main__":
    unittest.main()
