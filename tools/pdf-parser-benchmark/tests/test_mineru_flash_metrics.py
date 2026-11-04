#!/usr/bin/env python3
"""No-book test: embedded image payloads must never inflate parsed-text counts."""
import sys
import tempfile
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_windows_mineru_flash_real import flash_markdown_metrics, normalize, summarize_model_verify


class FlashMarkdownTextMetricsTests(unittest.TestCase):
    def test_plain_chinese_remains(self):
        actual, metrics = flash_markdown_metrics("## 第一章\n文字和数字123。")
        self.assertEqual(actual, normalize("第一章文字和数字123"))
        self.assertEqual(metrics["markdown_image_count"], 0)
        self.assertEqual(metrics["nontext_removed_characters"], 0)

    def test_markdown_embedded_png_is_excluded(self):
        image = "aGVsbG8" + "Q" * 512
        actual, metrics = flash_markdown_metrics(
            f"正文开头\n![image](data:image/png;base64,{image})\n正文结束")
        self.assertEqual(actual, "正文开头正文结束")
        self.assertEqual(metrics["markdown_image_count"], 1)
        self.assertEqual(metrics["embedded_data_uri_count"], 1)
        self.assertGreater(metrics["nontext_removed_characters"], 500)

    def test_html_embedded_jpeg_is_excluded(self):
        image = "R" * 777
        actual, metrics = flash_markdown_metrics(
            f"段落<img src=\"data:image/jpeg;base64,{image}\">下一段")
        self.assertEqual(actual, "段落下一段")
        self.assertEqual(metrics["html_image_count"], 1)
        self.assertEqual(metrics["embedded_data_uri_count"], 1)

    def test_detached_encoded_blob_is_excluded(self):
        blob = "ABcd0123+/" * 120
        actual, metrics = flash_markdown_metrics("说明\n" + blob + "\n完成")
        self.assertEqual(actual, "说明完成")
        self.assertGreater(metrics["long_encoded_chunk_count"], 0)
        self.assertGreater(metrics["encoded_chunk_characters"], 512)



class MineruModelVerificationDiagnosticsTests(unittest.TestCase):
    def _classify(self, stdout, stderr, code):
        with tempfile.TemporaryDirectory() as private_test:
            out = Path(private_test) / "verify.stdout"
            err = Path(private_test) / "verify.stderr"
            out.write_text(stdout, encoding="utf-8")
            err.write_text(stderr, encoding="utf-8")
            return summarize_model_verify({"exit_code": code}, out, err)

    def test_missing_onnx_bundle_is_classified_and_private_path_not_leaked(self):
        diagnostic = self._classify(
            "MinerU-4_models_onnx: MISSING under D:\\\\private-models",
            "", 1,
        )
        self.assertEqual(diagnostic["class"], "MODEL_ASSET_INCOMPLETE")
        self.assertTrue(diagnostic["flags"]["onnx_bundle"])
        self.assertNotIn("private-models", str(diagnostic))

    def test_runtime_import_error_is_distinguished_from_missing_weights(self):
        diagnostic = self._classify("", "ModuleNotFoundError: No module named 'onnxruntime'", 1)
        self.assertEqual(diagnostic["class"], "RUNTIME_ERROR")

    def test_cli_argument_error_is_distinguished(self):
        diagnostic = self._classify("", "Error: No such option --small-backend", 2)
        self.assertEqual(diagnostic["class"], "CLI_ARGUMENT_INVALID")

    def test_zero_exit_only_proves_file_readiness_not_inference(self):
        diagnostic = self._classify("READY", "", 0)
        self.assertEqual(diagnostic["class"], "READY_FILES_ONLY_NOT_INFERRED")


if __name__ == "__main__":
    unittest.main()
