"""Synthetic-only offline B15/B31 PNG staging contract."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_private_visual_image_preflight import prepare
from ebook_private_glm_visual_reference import VisualGateError
from test_ebook_private_glm_visual_reference import RAW, MANIFEST, FakeFitz


class Images(unittest.TestCase):
    def test_sha_selected_pages_render_locally_and_idempotently(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            (root/"sample.pdf").write_bytes(RAW["B15"])
            with zipfile.ZipFile(root/"sample.zip","w") as z:
                z.writestr("sample/B31.pdf",RAW["B31"])
            first=prepare(root,MANIFEST,FakeFitz())
            self.assertEqual([r["id"] for r in first],["B15","B31"])
            self.assertEqual([r["rotation_degrees"] for r in first],[270,0])
            for row in first:
                output=root/"semantic_gate"/"visual_inputs"/(row["id"]+"_p"+str(row["physical_page"])+"_display.png")
                self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(),row["image_sha256"])
            self.assertEqual(prepare(root,MANIFEST,FakeFitz()),first)

    def test_missing_real_source_fails_closed(self):
        with tempfile.TemporaryDirectory() as name:
            with self.assertRaisesRegex(VisualGateError,"PRIVATE_SOURCE_BYTES_MISSING"):
                prepare(Path(name),MANIFEST,FakeFitz())

    def test_existing_render_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            (root/"a.pdf").write_bytes(RAW["B15"])
            (root/"b.pdf").write_bytes(RAW["B31"])
            prepare(root,MANIFEST,FakeFitz())
            file=root/"semantic_gate"/"visual_inputs"/"B15_p109_display.png"
            file.write_bytes(b"tampered")
            with self.assertRaisesRegex(VisualGateError,"EXISTING_PRIVATE_RENDER_MISMATCH"):
                prepare(root,MANIFEST,FakeFitz())


if __name__=="__main__":
    unittest.main()
