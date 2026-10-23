"""Synthetic-only native PDF page provenance, no private book bytes."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_native_pages import evaluate, _summarize
from ebook_windows_private_preflight import PreflightError

PAGES = {"B15": 438, "B16": 213, "B31": 504}
ROTATIONS = {"B15": 270, "B16": 0, "B31": 0}
RAW = {book: (b"%PDF-1.7 fake header " + book.encode()) for book in PAGES}
MANIFEST = {"sources": [
    {"id": book, "sha256": hashlib.sha256(raw).hexdigest(),
     "size": len(raw), "total_physical_pages": PAGES[book]}
    for book, raw in RAW.items()
]}


class FakePage:
    def __init__(self, book):
        self.rotation = ROTATIONS[book]
        self.book = book
    def get_text(self, kind, sort=False):
        if kind != "text" or sort is not True:
            raise AssertionError("Unexpected mode")
        return "中文 A-B 123" if self.book == "B16" else ""


class FakeDoc:
    def __init__(self, book):
        self.book = book
        self.page_count = PAGES[book]
    def __getitem__(self, page):
        expected = {"B15": 108, "B16": 52, "B31": 125}[self.book]
        if page != expected:
            raise AssertionError("Wrong physical page")
        return FakePage(self.book)
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return None


class FakeFitz:
    def open(self, *, stream, filetype):
        if filetype != "pdf":
            raise AssertionError("Wrong filetype")
        for book, raw in RAW.items():
            if stream == raw:
                return FakeDoc(book)
        raise AssertionError("Nonfixture source")


class NativePages(unittest.TestCase):
    def test_real_source_sha_selection_but_fake_pdf_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/"a.pdf").write_bytes(RAW["B15"])
            (root/"b.PDF").write_bytes(RAW["B16"])
            with zipfile.ZipFile(root/"books.zip", "w") as archive:
                archive.writestr("p/B31.pdf", RAW["B31"])
            result = evaluate(root, MANIFEST, FakeFitz())
            self.assertEqual(result["observed"], ["B15", "B16", "B31"])
            self.assertEqual(result["missing"], [])
            self.assertEqual([(r["physical_page"],r["pdf_rotation_degrees"]) for r in result["rows"]],
                             [(109,270),(53,0),(126,0)])
            self.assertEqual(result["rows"][0]["native_text_chars"], 0)
            self.assertGreater(result["rows"][1]["native_text_chars"], 0)
            self.assertEqual(result["rows"][2]["diagram_semantics"], "UNVERIFIED")
            self.assertNotIn("native_text", result["rows"][0])

    def test_rotation_change_fails_closed(self):
        class WrongFitz(FakeFitz):
            def open(self, *, stream, filetype):
                doc = super().open(stream=stream, filetype=filetype)
                class Wrong(FakeDoc):
                    def __getitem__(self, page):
                        p = super().__getitem__(page)
                        p.rotation = 90
                        return p
                return Wrong(doc.book)
        with self.assertRaisesRegex(PreflightError, "NATIVE_PHYSICAL_ROTATION_CHANGED"):
            _summarize("B15", RAW["B15"], MANIFEST["sources"][0], WrongFitz())

    def test_page_count_change_fails_closed(self):
        class WrongFitz(FakeFitz):
            def open(self, *, stream, filetype):
                doc = super().open(stream=stream, filetype=filetype)
                doc.page_count = 109
                return doc
        with self.assertRaisesRegex(PreflightError, "NATIVE_PAGE_COUNT_CHANGED"):
            _summarize("B15", RAW["B15"], MANIFEST["sources"][0], WrongFitz())

    def test_missing_real_source_is_unverified_not_accuracy_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            result = evaluate(Path(directory), MANIFEST, FakeFitz())
            self.assertEqual(result["missing"], ["B15", "B16", "B31"])
            self.assertEqual(result["rows"], [])

    def test_duplicate_corpus_id_refused(self):
        manifest = {"sources": MANIFEST["sources"] + [MANIFEST["sources"][0]]}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(PreflightError, "NATIVE_MANIFEST_TARGET_INVALID"):
                evaluate(Path(directory), manifest, FakeFitz())


if __name__ == "__main__":
    unittest.main()
