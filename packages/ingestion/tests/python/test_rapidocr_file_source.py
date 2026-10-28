"""Pure Python file admission checks; no OCR wheel or private book required."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "src" / "rapidocr" / "rapidocr-child.py"
SPEC = importlib.util.spec_from_file_location("acs_rapidocr_child_source_gate", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("RAPIDOCR_TEST_SCRIPT_NOT_FOUND")
child = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(child)


class RapidOcrFileSourceGateTest(unittest.TestCase):
    def test_valid_151495200_byte_verified_file_is_admitted(self):
        with tempfile.TemporaryDirectory(prefix="acs-ocr-source-") as root:
            source = Path(root) / "staged.pdf"
            with source.open("wb") as out:
                out.write(b"%PDF-1.7\n")
                out.truncate(151_495_200)
            self.assertEqual(source.stat().st_size, 151_495_200)
            self.assertEqual(child.MAX_BYTES, 200 * 1024 * 1024)
            # Only the admission gate is being tested, not parsing or OCR.
            child.validate_source_file(source)

    def test_oversized_source_is_rejected_without_loading(self):
        with tempfile.TemporaryDirectory(prefix="acs-ocr-source-") as root:
            source = Path(root) / "oversized.pdf"
            with source.open("wb") as out:
                out.write(b"%PDF-1.7\n")
                out.truncate(200 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(RuntimeError, "OCR_INPUT_INVALID"):
                child.validate_source_file(source)

    def test_bad_magic_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="acs-ocr-source-") as root:
            source = Path(root) / "not-pdf.pdf"
            source.write_bytes(b"HELLO WORLD")
            with self.assertRaisesRegex(RuntimeError, "OCR_INPUT_INVALID"):
                child.validate_source_file(source)

    def test_symlink_is_rejected_if_supported(self):
        with tempfile.TemporaryDirectory(prefix="acs-ocr-source-") as root:
            source = Path(root) / "source.pdf"
            link = Path(root) / "link.pdf"
            source.write_bytes(b"%PDF-1.4\n")
            try:
                link.symlink_to(source)
            except (OSError, NotImplementedError):
                self.skipTest("Symlinks unavailable on this host")
            with self.assertRaisesRegex(RuntimeError, "OCR_INPUT_INVALID"):
                child.validate_source_file(link)


if __name__ == "__main__":
    unittest.main()
