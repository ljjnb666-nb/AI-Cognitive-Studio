"""Offline synthetic tests; no access to the user's Windows data or book bytes."""
import contextlib
import hashlib
import importlib.util
import io
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "verify_b03_source_readonly.py"
spec = importlib.util.spec_from_file_location("acs_b03_readonly", SOURCE)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class PrivateB03SourceVerifierTests(unittest.TestCase):
    def make_fixture(self, root: pathlib.Path, rel: str = "private/book.pdf"):
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        content = b"%PDF-1.4\nSYNTHETIC PAGE REFERENCE ONLY\n"
        target.write_bytes(content)
        return target, len(content), hashlib.sha256(content).hexdigest()

    def test_30005_non_pdf_files_do_not_block_exact_pdf_sha(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            expected, size, sha = self.make_fixture(root, "private/book.pdf")
            junk = [f"ocr_cache_{i:05}.png" for i in range(30005)]
            with patch.object(module.os, "walk", return_value=[
                (str(root), ["private"], junk),
                (str(root / "private"), [], ["book.pdf"]),
            ]):
                result = module.identify_exact_original(root, size, sha)
            self.assertEqual(result, expected)

    def test_pdf_scan_limit_still_rejects_too_many_actual_pdfs(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            for n in range(5):
                self.make_fixture(root, f"books/{n}.pdf")
            with patch.object(module, "MAX_DISCOVERED_FILES", 4):
                with self.assertRaisesRegex(module.ReviewBlocked, "SEARCH_TOO_BROAD"):
                    module.identify_exact_original(root, 100, "a" * 64)

    def test_known_sha_finds_only_matching_book(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            expected, size, sha = self.make_fixture(root)
            unrelated, _, _ = self.make_fixture(root, "other/another.pdf")
            unrelated.write_bytes(b"%PDF-1.4\nSYNTHETIC PAGE REFERENCE ONLY?\n")
            result = module.identify_exact_original(root, size, sha)
            with self.subTest("matching_sha"):
                self.assertEqual(result, expected)

    def test_size_match_but_sha_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            _, size, sha = self.make_fixture(root)
            with self.assertRaises(module.ReviewBlocked):
                module.identify_exact_original(root, size, "0" * 64)
            self.assertNotEqual(sha, "0" * 64)

    def test_duplicate_books_are_rejected_instead_of_guessing_a_source(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            _, size, sha = self.make_fixture(root)
            self.make_fixture(root, "other/copy.pdf")
            with self.assertRaises(module.ReviewBlocked):
                module.identify_exact_original(root, size, sha)

    def test_skips_symlinked_pdf_and_nested_root(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            original, size, sha = self.make_fixture(root)
            link = root / "private" / "linked.pdf"
            try:
                link.symlink_to(original)
            except (OSError, NotImplementedError):
                self.skipTest("Symlinks unavailable under current test runtime")
            self.assertEqual(module.identify_exact_original(root, size, sha), original)
            with self.assertRaises(module.ReviewBlocked):
                module.identify_exact_original(link, size, sha)

    def test_page_67_has_explicit_page_count_and_bounded_render(self):
        class FakeDocument:
            def __len__(self):
                return 271

            def load_page(self, n):
                assert n == 66
                return types.SimpleNamespace(
                    rect=types.SimpleNamespace(width=612, height=792),
                    get_pixmap=lambda matrix, alpha: types.SimpleNamespace(width=594, height=768),
                )

            def close(self):
                return None

        fake_fitz = types.SimpleNamespace(
            open=lambda path: FakeDocument(),
            Matrix=lambda sx, sy: (sx, sy),
        )
        with patch.dict(sys.modules, {"fitz": fake_fitz}):
            count, rendered = module.verify_page_source(pathlib.Path("fake.pdf"))
        self.assertEqual((count, rendered), ("PASS", "PASS"))

    def test_source_changed_while_rendering_is_rejected_even_if_size_and_mtime_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            original, size, original_sha = self.make_fixture(root)
            first = original.stat()

            def swapped_during_render(path):
                content = bytearray(path.read_bytes())
                content[10] ^= 1
                path.write_bytes(content)
                import os
                os.utime(path, ns=(first.st_atime_ns, first.st_mtime_ns))
                return "PASS", "PASS"

            with (
                patch.object(module, "identify_exact_original", return_value=original),
                patch.object(module, "verify_page_source", side_effect=swapped_during_render),
                patch.object(module, "EXPECTED_SIZE", size),
                patch.object(module, "EXPECTED_SHA256", original_sha),
            ):
                with self.assertRaisesRegex(module.ReviewBlocked,
                                            "SOURCE_CHANGED_DURING_PAGE_VERIFY"):
                    module.inspect(root)

    def test_stable_source_remains_verified_after_page_render(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            original, size, original_sha = self.make_fixture(root)
            with (
                patch.object(module, "identify_exact_original", return_value=original),
                patch.object(module, "verify_page_source", return_value=("PASS", "PASS")),
                patch.object(module, "EXPECTED_SIZE", size),
                patch.object(module, "EXPECTED_SHA256", original_sha),
            ):
                found = module.inspect(root)
                self.assertEqual((found.source, found.page_count, found.page_67_render),
                                 ("PASS", "PASS", "PASS"))

    def test_main_redacts_private_path_and_still_rejects_incomplete_page_review(self):
        sentinel = pathlib.Path("C:/PRIVATE_SENTINEL_ONLY_DO_NOT_OUTPUT/secret.pdf")
        with patch.object(module, "inspect", side_effect=ValueError(str(sentinel))):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = module.main(["--root", str(sentinel)])
            self.assertEqual(result, 2)
            self.assertNotIn("PRIVATE_SENTINEL", output.getvalue())
            self.assertNotIn(str(sentinel), output.getvalue())
            self.assertIn('"source_pdf_sha256":"NOT_VERIFIED"', output.getvalue())
            self.assertNotIn("5be652d206", output.getvalue())

    def test_sha_only_is_never_misrepresented_as_page_or_png_lineage(self):
        with patch.object(module, "inspect", return_value=module.Finding(
                "PASS", "NOT_TESTED_PYMUPDF_UNAVAILABLE", "NOT_TESTED_PYMUPDF_UNAVAILABLE")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                status = module.main(["--root", "."])
            self.assertEqual(status, 2)
            self.assertIn('"source_pdf_sha256":"PASS"', out.getvalue())
            self.assertIn('"uploaded_library_png_identity":"NOT_ATTESTED"', out.getvalue())
            self.assertIn('"full_page_gold":"NOT_MEASURED"', out.getvalue())


if __name__ == "__main__":
    unittest.main()
