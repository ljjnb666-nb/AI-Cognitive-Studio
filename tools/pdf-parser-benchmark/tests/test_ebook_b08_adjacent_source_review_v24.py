"""Synthetic only: B08 source-neighbor packet, immutable audit and tamper fail-closed."""
import hashlib
from io import BytesIO
import json
import sys
import tempfile
from pathlib import Path
import unittest

import fitz

test_parent=Path(__file__).resolve().parent
scripts=test_parent if (test_parent/'ebook_b08_adjacent_source_review_v24.py').exists() else test_parent.parent/'scripts'
sys.path.insert(0,str(scripts))
import ebook_b08_adjacent_source_review_v24 as mod

class SourceNeighborTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.matrix=self.root/'semantic_gate'/'multibook_matrix_20261023'
        v17=self.matrix/'b08_b29_b31_source_hidpi_v17'
        v17.mkdir(parents=True)
        with fitz.open() as pdf:
            for i in range(66):
                page=pdf.new_page(width=350,height=490)
                if i in (62,63,64):
                    page.insert_text((20,42),f'SYNTHETIC SOURCE PAGE {i+1}',fontsize=12)
            self.raw=pdf.tobytes()
        with fitz.open(stream=self.raw,filetype='pdf') as pdf:
            bmp=pdf[63].get_pixmap(matrix=fitz.Matrix(3,3),colorspace=fitz.csRGB,alpha=False)
            focus=bmp.tobytes('png')
            size=[bmp.width,bmp.height]
        (v17/mod.FOCUS_PNG).write_bytes(focus)
        h=hashlib.sha256(self.raw).hexdigest()
        self.manifest={'sources':[{'id':'B08','size':len(self.raw),'sha256':h,'total_physical_pages':66}]}
        self.receipt={'schema_version':17,'status':'SOURCE_ONLY_NOT_GOLD',
                      'rows':[{'book_id':'B08','physical_page':64,
                               'original_pdf_sha256_private':h,'full_png_name':mod.FOCUS_PNG,
                               'full_png_sha256_private':mod.digest(focus),
                               'full_png_dimensions':size,'independent_gold':False}]}
        (v17/'b08_b29_b31_source_hidpi.v17.private.json').write_bytes(mod.canonical(self.receipt))
        self.contract=lambda root,identity: iter([('B08',self.raw)])

    def test_writes_and_replays_only_nearby_pages(self):
        report=mod.execute(self.root,self.manifest,write=True,raw_sources_fn=self.contract)
        self.assertEqual(report['adjacent_physical_pages'],[63,65])
        self.assertFalse(report['bleedthrough_alignment_verified'])
        self.assertFalse(report['reference_gold_approved'])
        self.assertIsNone(report['full_page_cer'])
        target=self.matrix/mod.SUBDIR
        self.assertEqual(len(list(target.iterdir())),5)
        self.assertTrue((target/'B08_p0065_SOURCE.private.png').is_file())
        self.assertEqual(mod.execute(self.root,self.manifest,audit=True,raw_sources_fn=self.contract),report)

    def test_rejects_tampered_frozen_focus(self):
        path=self.matrix/'b08_b29_b31_source_hidpi_v17'/mod.FOCUS_PNG
        path.write_bytes(path.read_bytes()+b'\x00')
        with self.assertRaisesRegex(mod.SourceError,'V17_FOCUS_PNG_SHA_INVALID'):
            mod.build(self.root,self.manifest,raw_sources_fn=self.contract)

    def test_rejects_wrong_original_book_bytes(self):
        with self.assertRaisesRegex(mod.SourceError,'ORIGINAL_BOOK_SHA_INVALID'):
            mod.build(self.root,self.manifest,raw_sources_fn=lambda *_: iter([('B08',b'WRONG')]))

    def test_rejects_snapshot_mutation_and_rewrite(self):
        mod.execute(self.root,self.manifest,write=True,raw_sources_fn=self.contract)
        with self.assertRaisesRegex(mod.SourceError,'PRIVATE_SNAPSHOT_EXISTS'):
            mod.execute(self.root,self.manifest,write=True,raw_sources_fn=self.contract)
        img=self.matrix/mod.SUBDIR/'B08_p0063_SOURCE.private.png'
        img.write_bytes(img.read_bytes()+b'x')
        with self.assertRaisesRegex(mod.SourceError,'FROZEN_CONTENT_CHANGED'):
            mod.execute(self.root,self.manifest,audit=True,raw_sources_fn=self.contract)

    def test_rejects_forged_gold_and_duplicate_manifest(self):
        original=self.receipt
        p=self.matrix/'b08_b29_b31_source_hidpi_v17'/'b08_b29_b31_source_hidpi.v17.private.json'
        fake=json.loads(json.dumps(original))
        fake['rows'][0]['independent_gold']=True
        p.write_bytes(mod.canonical(fake))
        with self.assertRaisesRegex(mod.SourceError,'V17_RECEIPT_PROVENANCE_INVALID'):
            mod.build(self.root,self.manifest,raw_sources_fn=self.contract)
        with self.assertRaisesRegex(mod.SourceError,'DUPLICATE_JSON_KEYS'):
            mod.json_safely(b'{"a":1,"a":2}')

if __name__=='__main__':unittest.main()
