"""Synthetic-only tests: no user books, OCR models or provider calls."""
import hashlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_threebook_source_hidpi_v17 as v17


class ThreeBookSourceHiDpiTests(unittest.TestCase):
    def setUp(self):
        import fitz
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.folder=self.root/"semantic_gate"/"multibook_matrix_20261023"
        self.folder.mkdir(parents=True)
        self.entries={}
        for book,page in v17.TARGETS:
            pdf=fitz.open()
            pg=pdf.new_page(width=220,height=290)
            pg.insert_text((30,60),"Synthetic test page only",fontsize=16)
            raw=pdf.tobytes()
            pdf.close()
            path=self.folder/f"{book}_p{page:04d}.private.pdf"
            path.write_bytes(raw)
            self.entries[book]={"physical_page":page,"source_file":path,
                               "single_pdf_sha256":hashlib.sha256(raw).hexdigest(),
                               "original_pdf_sha256":"a"*64}
        self.contract=lambda root,manifest:(self.entries,)

    def test_write_audit_same_bytes_and_no_gold(self):
        result=v17.execute(self.root,{},write=True,contract_fn=self.contract)
        self.assertEqual((result['pages'],result['tiles'],result['full_images']),(3,27,3))
        self.assertIsNone(result['cer'])
        self.assertFalse(result['independent_approval'])
        self.assertEqual(len(list((self.folder/v17.SUBDIR).iterdir())),32)
        replay=v17.execute(self.root,{},audit=True,contract_fn=self.contract)
        self.assertEqual(result,replay)
        with self.assertRaises(Exception):
            v17.execute(self.root,{},write=True,contract_fn=self.contract)

    def test_source_tampering_fails_closed(self):
        path=self.entries['B08']['source_file']
        path.write_bytes(path.read_bytes()+b'tampered')
        with self.assertRaises(Exception):
            v17.execute(self.root,{},write=True,contract_fn=self.contract)

    def test_snapshot_tampering_fails_closed(self):
        v17.execute(self.root,{},write=True,contract_fn=self.contract)
        target=self.folder/v17.SUBDIR/"B31_p0126_R3C3.private.png"
        target.write_bytes(b'bad')
        with self.assertRaises(Exception):
            v17.execute(self.root,{},audit=True,contract_fn=self.contract)

    def test_html_offline_and_no_authority(self):
        v17.execute(self.root,{},write=True,contract_fn=self.contract)
        html=(self.folder/v17.SUBDIR/v17.INDEX).read_text('utf-8')
        self.assertIn("connect-src 'none'",html)
        self.assertIn("script-src 'none'",html)
        self.assertNotIn("https://",html)
        self.assertIn('未审核',html) if '未审核' in html else self.assertIn('尚待独立核验',html)

if __name__=='__main__':
    unittest.main()
