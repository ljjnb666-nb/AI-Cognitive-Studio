"""Offline synthetic tests of pinned RapidOCR 3.9.2 ONNX model integrity.

No OCR wheels, model downloads, PDF source bytes or network required.
"""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2] / "src" / "rapidocr" / "rapidocr-child.py"
SPEC = importlib.util.spec_from_file_location("acs_rapidocr_weight_gate", SOURCE)
assert SPEC and SPEC.loader
child = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = child
SPEC.loader.exec_module(child)


class PinnedRapidOcrModelIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="acs-model-integrity-fixture-")
        self.root = Path(self.tmp.name)
        self.models = self.root / "models"
        self.models.mkdir()
        self.bytes = {
            "det.onnx": b"D" * 10001,
            "rec.onnx": b"R" * 10002,
            "cls.onnx": b"C" * 10003,
        }
        for name, content in self.bytes.items():
            (self.models / name).write_bytes(content)
        self.expected = {
            name: hashlib.sha256(content).hexdigest()
            for name, content in self.bytes.items()
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_genuine_fixed_hash_set_returns_reproducible_fingerprint(self):
        first = child.verify_pinned_weights(self.models, self.expected)
        second = child.verify_pinned_weights(self.models, self.expected)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 64)

    def test_one_byte_model_tamper_is_rejected(self):
        rec = self.models / "rec.onnx"
        changed = bytearray(rec.read_bytes())
        changed[300] ^= 1
        rec.write_bytes(changed)
        with self.assertRaisesRegex(RuntimeError, "OCR_WEIGHTS_SHA_MISMATCH"):
            child.verify_pinned_weights(self.models, self.expected)

    def test_missing_weight_is_rejected(self):
        (self.models / "cls.onnx").unlink()
        with self.assertRaisesRegex(RuntimeError, "OCR_WEIGHTS_SET_MISMATCH"):
            child.verify_pinned_weights(self.models, self.expected)

    def test_extra_onnx_weight_is_rejected(self):
        (self.models / "unrecognized.onnx").write_bytes(b"Z" * 10001)
        with self.assertRaisesRegex(RuntimeError, "OCR_WEIGHTS_SET_MISMATCH"):
            child.verify_pinned_weights(self.models, self.expected)

    def test_wrong_size_is_rejected(self):
        (self.models / "det.onnx").write_bytes(b"D" * 100)
        with self.assertRaisesRegex(RuntimeError, "OCR_WEIGHTS_INVALID"):
            child.verify_pinned_weights(self.models, self.expected)

    def test_symlinked_weight_is_rejected(self):
        original = self.models / "rec.onnx"
        original.unlink()
        target = self.root / "outside.onnx"
        target.write_bytes(self.bytes["rec.onnx"])
        try:
            original.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks unavailable")
        with self.assertRaisesRegex(RuntimeError, "OCR_WEIGHTS_INVALID"):
            child.verify_pinned_weights(self.models, self.expected)

    def test_default_pinned_sha_are_exact_vendor_v392_set(self):
        self.assertEqual(child.RAPIDOCR, "3.9.2")
        self.assertEqual(child.ONNX, "1.22.1")
        self.assertEqual(child.PINNED_ONNX_SHA256, {
            "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
            "PP-OCRv6_rec_small.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
            "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
        })


if __name__ == "__main__":
    unittest.main()
