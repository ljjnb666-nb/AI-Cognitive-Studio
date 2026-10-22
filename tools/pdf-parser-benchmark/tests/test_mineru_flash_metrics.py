#!/usr/bin/env python3
"""No-book test: embedded image payloads must never inflate parsed-text counts."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_windows_mineru_flash_real import flash_markdown_metrics, normalize


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


if __name__ == "__main__":
    unittest.main()
