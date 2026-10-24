"""Synthetic figure anchor gates: no real book text or images in public CI."""
import base64
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_private_mineru_figure_rapidocr_anchor as m


def sample():
    blob=b'\xff\xd8\xff'+b'opaque synthetic JPEG payload'*12+b'\xff\xd9'
    image='![](data:image/jpeg;base64,'+base64.b64encode(blob).decode()+')'
    md=(image+'\n\n图 1-4-15\n\n随机文本\n'+image+'\n\n图 1-4-16\n').encode('utf-8')
    sha='a'*64
    png='b'*64
    receipt={'book_id':'B15','physical_page':109,'real_inference':True,
             'ocr_quality_gold':None,'graph_quality_gold':None,
             'markdown_sha256_private':m.digest(md),'original_pdf_sha256':sha,
             'rapidocr_source_png_sha256':png}
    def row(text,y):
        return {'text':text,'score':0.98,
                'origin':'LOCAL_SOURCE_IMAGE_OCR_NOT_GOLD',
                'quad':[[1.0,float(y)],[50.0,float(y)],
                        [50.0,float(y+9)],[1.0,float(y+9)]]}
    rows=[row('之前文字（图1-4-16）',150),row('标签A',180),
          row('标签B',190),row('△图例C',201),row('符号D',212),
          row('图 1-4-16',250)]
    rapid={'ocr_accuracy_gold':None,
           'pages':[{'book_id':'B15','physical_page':109,
                     'source_document_sha256':sha,'render_png_sha256':png,
                     'rapidocr_private_rows':rows,'rapidocr_line_count':len(rows),
                     'private_rows_sha256':m.digest(m.canonical(rows))}]}
    return md,receipt,rapid


class FigureAnchorTests(unittest.TestCase):
    def test_source_only_figure_binding_not_a_gold(self):
        raw,receipt,rapid=sample()
        result=m.build(raw,receipt,rapid)
        self.assertEqual(result['candidate_count'],4)
        self.assertEqual([x['figure_id'] for x in result['retained_figures']],
                         ['1-4-15','1-4-16'])
        self.assertFalse(result['image_to_page_geometry_verified'])
        self.assertFalse(result['series_to_curve_correspondence_verified'])
        self.assertFalse(result['independent_gold_available'])
        self.assertIsNone(result['cer'])

    def test_mineru_or_pdf_source_sha_conflict_rejected(self):
        raw,receipt,rapid=sample()
        receipt['markdown_sha256_private']='a'*64
        with self.assertRaisesRegex(m.GateError,'MINERU_IDENTITY'):
            m.build(raw,receipt,rapid)
        raw,receipt,rapid=sample()
        rapid['pages'][0]['source_document_sha256']='f'*64
        with self.assertRaisesRegex(m.GateError,'CROSS_ENGINE_SOURCE'):
            m.build(raw,receipt,rapid)

    def test_rapidocr_row_tamper_or_figure_caption_ambiguity_rejected(self):
        raw,receipt,rapid=sample()
        rapid['pages'][0]['rapidocr_private_rows'][1]['text']='altered'
        with self.assertRaisesRegex(m.GateError,'RAPIDOCR_FROZEN_ROWS'):
            m.build(raw,receipt,rapid)
        raw,receipt,rapid=sample()
        rapid['pages'][0]['rapidocr_private_rows'][2]['text']='图 1-4-16'
        rapid['pages'][0]['private_rows_sha256']=m.digest(
            m.canonical(rapid['pages'][0]['rapidocr_private_rows']))
        with self.assertRaisesRegex(m.GateError,'AMBIGUOUS'):
            m.build(raw,receipt,rapid)

    def test_missing_or_nonadjacent_original_figure_image_rejected(self):
        raw,receipt,rapid=sample()
        marker='图 1-4-16'.encode('utf-8')
        changed=raw.replace(marker,b'caption must be adjacent\n'+marker)
        receipt['markdown_sha256_private']=m.digest(changed)
        with self.assertRaisesRegex(m.GateError,'CAPTION_NOT_ADJACENT'):
            m.build(changed,receipt,rapid)
        raw,receipt,rapid=sample()
        changed=raw[:raw.find(b'![](data:image/jpeg;base64,',12)]
        receipt['markdown_sha256_private']=m.digest(changed)
        with self.assertRaisesRegex(m.GateError,'IMAGE_COUNT_NOT_TWO'):
            m.build(changed,receipt,rapid)

    def test_exclusive_create_and_frozen_audit_reject_edit(self):
        raw,receipt,rapid=sample()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'source.md').write_bytes(raw)
            (root/'receipt.json').write_bytes(m.canonical(receipt))
            (root/'rapid.json').write_bytes(m.canonical(rapid))
            target=root/'anchor.private.json'
            def call(audit):
                return m.run(root/'source.md',root/'receipt.json',
                             root/'rapid.json',target,audit_only=audit)
            first=call(False)
            self.assertEqual(first,call(True))
            with self.assertRaises(FileExistsError):
                call(False)
            target.write_bytes(b'tampered')
            with self.assertRaisesRegex(m.GateError,'FROZEN_FIGURE'):
                call(True)

    def test_invalid_source_page_quad_even_with_new_sha_rejected(self):
        raw,receipt,rapid=sample()
        rapid['pages'][0]['rapidocr_private_rows'][1]['quad'][0][1]=-5.0
        rapid['pages'][0]['private_rows_sha256']=m.digest(
            m.canonical(rapid['pages'][0]['rapidocr_private_rows']))
        with self.assertRaisesRegex(m.GateError,'ROW_INVALID'):
            m.build(raw,receipt,rapid)


if __name__=='__main__':
    unittest.main()
