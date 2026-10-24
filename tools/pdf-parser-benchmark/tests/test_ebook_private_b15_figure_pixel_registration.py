"""Synthetic only: no copyrighted book images or private OCR text."""
import base64
from io import BytesIO, StringIO
import json
from pathlib import Path
import random
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ebook_private_b15_figure_pixel_registration as m


def fixture():
    rng = random.Random(8417)
    w, h = 170, 135
    figure = Image.frombytes('L', (w, h), bytes(rng.randrange(0, 256) for _ in range(w * h)))
    canvas = Image.new('L', (780, 680), 255)
    canvas.paste(figure, (245, 378))
    pngbuf = BytesIO()
    canvas.save(pngbuf, format='PNG')
    jpegbuf = BytesIO()
    figure.save(jpegbuf, format='JPEG', quality=90)
    jpg = jpegbuf.getvalue()
    embedding = '![](data:image/jpeg;base64,' + base64.b64encode(jpg).decode('ascii') + ')'
    markdown = (embedding + '\n\n图 1-4-15\n' + embedding + '\n\n图 1-4-16\n').encode('utf-8')
    page = pngbuf.getvalue()
    anchor = {'schema_version': 1, 'status': 'FIGURE_TEXT_CANDIDATES_UNVERIFIED',
              'page_identity': {'book_id': 'B15', 'physical_page': 109,
                                'source_render_png_sha256_private': m.sha256(page),
                                'mineru_markdown_sha256_private': m.sha256(markdown)},
              'selected_figure_id': '1-4-16', 'candidate_count': 19,
              'page_source_ocr_candidates': [{'page_row_index': i} for i in range(19)],
              'selected_image_sha256_private': m.sha256(jpg),
              'retained_figures': [{'figure_id': '1-4-15'},
                                   {'figure_id': '1-4-16', 'embedded_jpeg_sha256_private': m.sha256(jpg)}],
              'independent_gold_available': False, 'image_to_page_geometry_verified': False,
              'label_to_marker_correspondence_verified': False,
              'series_to_curve_correspondence_verified': False, 'cer': None}
    return page, markdown, anchor


class PixelRegistrationTests(unittest.TestCase):
    def test_private_source_pixel_candidate_never_becomes_gold(self):
        page, md, anchor = fixture()
        result = m.build(page, md, anchor)
        self.assertEqual(result['status'], m.STATUS)
        self.assertFalse(result['image_to_page_geometry_verified'])
        self.assertFalse(result['series_to_curve_correspondence_verified'])
        self.assertFalse(result['label_to_marker_correspondence_verified'])
        self.assertIsNone(result['cer'])
        best = result['registration']['hypotheses'][0]
        self.assertGreater(best['match_score_not_accuracy'], 0.65)
        self.assertTrue(result['registration']['high_correlation_signal_not_proof'])
        self.assertTrue(result['registration']['top_candidate_intersects_prior_R3C2_not_proof'])
        self.assertEqual(best['rotation_clockwise_degrees'], 0)
        self.assertEqual(best['source_page_pixel_box_candidate'], [245, 378, 415, 513])

    def test_original_source_sha_and_authority_rejected_if_tampered(self):
        page, md, anchor = fixture()
        anchor['page_identity']['source_render_png_sha256_private'] = '0' * 64
        with self.assertRaises(m.GateError):
            m.build(page, md, anchor)
        page, md, anchor = fixture()
        anchor['independent_gold_available'] = True
        with self.assertRaises(m.GateError):
            m.build(page, md, anchor)

    def test_reject_low_variance_figure(self):
        import numpy as np
        with self.assertRaisesRegex(m.GateError, 'LOW_VARIANCE'):
            m.registration(np.full((500, 600), 255, dtype='uint8'),
                           np.full((80, 90), 255, dtype='uint8'))

    def test_exclusive_private_write_audit_and_tamper_detection(self):
        page, md, anchor = fixture()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root/'original.png').write_bytes(page)
            (root/'mineru.md').write_bytes(md)
            (root/'v1.json').write_bytes(m.canonical(anchor))
            report = root/'v2.private.json'
            def run(audit):
                return m.run(root/'original.png', root/'mineru.md', root/'v1.json',report,audit_only=audit)
            one = run(False)
            self.assertEqual(one, run(True))
            with self.assertRaises(FileExistsError):
                run(False)
            report.write_text('replaced',encoding='utf-8')
            with self.assertRaises(m.GateError):
                run(True)

    def test_unexpected_cli_exception_has_fixed_public_output(self):
        with patch.object(m, 'run', side_effect=ValueError('SYNTHETIC_PRIVATE_OCR_TEXT')):
            out=StringIO()
            with redirect_stdout(out):
                code=m.main(['--page-png','/fake.png','--mineru-markdown','/fake.md',
                             '--anchor-v1','/fake.json','--private-output','/fake.json'])
            self.assertEqual(code,2)
            self.assertEqual(out.getvalue().strip(),'ACS_FIGURE_PIXEL_PROPOSAL=REJECTED')
            self.assertNotIn('SYNTHETIC_PRIVATE_OCR_TEXT', out.getvalue())

    def test_read_private_reject_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'real'
            p.write_bytes(b'bytes')
            alias=Path(d)/'alias'
            alias.symlink_to(p)
            with self.assertRaises(m.GateError):
                m.read_bytes(alias, 100)


if __name__=='__main__':
    unittest.main()
