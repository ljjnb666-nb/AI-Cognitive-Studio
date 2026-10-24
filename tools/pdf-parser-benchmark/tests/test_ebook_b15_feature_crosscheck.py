"""Public synthetic-only ORB feature corroboration tests (no private pixels)."""
import base64
from contextlib import redirect_stdout
from io import BytesIO, StringIO
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import ebook_b15_feature_crosscheck as crosscheck
import ebook_private_b15_figure_pixel_registration as pixel


def sample():
    rng=random.Random(12)
    w,h=240,180
    image=Image.frombytes('L',(w,h),bytes(rng.randrange(256) for _ in range(w*h)))
    page=Image.new('L',(900,800),255)
    page.paste(image,(280,480))
    buf=BytesIO();page.save(buf,format='PNG');page=buf.getvalue()
    jpg=BytesIO();image.save(jpg,format='JPEG',quality=92);jpeg=jpg.getvalue()
    embed='![](data:image/jpeg;base64,'+base64.b64encode(jpeg).decode()+')'
    md=(embed+'\n\n图 1-4-15\n'+embed+'\n\n图 1-4-16\n').encode()
    anchor={'schema_version':1,'status':'FIGURE_TEXT_CANDIDATES_UNVERIFIED',
            'page_identity':{'book_id':'B15','physical_page':109,
                             'source_render_png_sha256_private':pixel.sha256(page),
                             'mineru_markdown_sha256_private':pixel.sha256(md)},
            'selected_figure_id':'1-4-16','candidate_count':19,
            'page_source_ocr_candidates':[{'page_row_index':i} for i in range(19)],
            'selected_image_sha256_private':pixel.sha256(jpeg),
            'retained_figures':[{'figure_id':'1-4-15'},
                                {'figure_id':'1-4-16','embedded_jpeg_sha256_private':pixel.sha256(jpeg)}],
            'independent_gold_available':False,'image_to_page_geometry_verified':False,
            'series_to_curve_correspondence_verified':False,
            'label_to_marker_correspondence_verified':False,'cer':None}
    v3={'schema_version':3,'status':pixel.STATUS,'book_id':'B15','physical_page':109,
        'figure_id':'1-4-16',
        'source_render_png_sha256_private':pixel.sha256(page),
        'mineru_markdown_sha256_private':pixel.sha256(md),
        'prior_v1_anchor_sha256_private':pixel.sha256(pixel.canonical(anchor)),
        'embedded_figure_jpeg_sha256_private':pixel.sha256(jpeg),
        'image_to_page_geometry_verified':False,'source_pixel_frame_to_ocr_quad_verified':False,
        'independent_gold_available':False,'series_to_curve_correspondence_verified':False,
        'label_to_marker_correspondence_verified':False,'cer':None,
        'registration':{'candidate_generated':True,'source_image_dimensions_pixels':[900,800],
                        'hypotheses':[{'source_page_pixel_box_candidate':[280,480,520,660],
                                       'match_score_not_accuracy':0.94}]}}
    return page,md,anchor,v3


class CrosscheckTests(unittest.TestCase):
    def test_independent_synthetic_orb_consensus_not_gold(self):
        page,md,anchor,v3=sample()
        result,overlay=crosscheck.build(page,md,anchor,v3)
        self.assertEqual(result['schema_version'],4)
        self.assertFalse(result['original_page_pixel_registration_verified'])
        self.assertFalse(result['independent_gold_available'])
        self.assertIsNone(result['cer'])
        feature=result['independent_feature_candidate']
        self.assertTrue(feature['feature_correlated_candidate'])
        self.assertGreater(feature['inlier_count'],8)
        self.assertGreater(feature['matching_iou_not_accuracy'],0.9)
        with Image.open(BytesIO(overlay)) as drawn:
            self.assertEqual(drawn.size,(900,800))

    def test_uninformative_flat_chart_cannot_claim_consensus(self):
        import numpy as np
        feature=crosscheck.feature_proposal(np.full((700,800),255,dtype='uint8'),
                                            np.full((120,160),255,dtype='uint8'),
                                            [[50,50,210,170]])
        self.assertFalse(feature['feature_correlated_candidate'])
        self.assertEqual(feature['status'],'INSUFFICIENT_INDEPENDENT_FEATURE_EVIDENCE')

    def test_false_golden_status_rejected(self):
        page,md,anchor,v3=sample()
        v3['independent_gold_available']=True
        with self.assertRaises(crosscheck.GateError):
            crosscheck.build(page,md,anchor,v3)

    def test_prior_v3_sha_mismatch_rejected(self):
        page,md,anchor,v3=sample()
        v3['source_render_png_sha256_private']='0'*64
        with self.assertRaises(crosscheck.GateError):
            crosscheck.build(page,md,anchor,v3)

    def test_private_report_overlay_exclusive_creation_and_audit(self):
        page,md,anchor,v3=sample()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,blob in [('page.png',page),('md.txt',md),
                              ('v1.json',pixel.canonical(anchor)),
                              ('v3.json',pixel.canonical(v3))]:
                (root/name).write_bytes(blob)
            def run(audit):
                return crosscheck.run(root/'page.png',root/'md.txt',root/'v1.json',
                                      root/'v3.json',root/'report.json',
                                      root/'overlay.png',audit_only=audit)
            self.assertEqual(run(False),run(True))
            with self.assertRaises(crosscheck.GateError):
                run(False)
            (root/'overlay.png').write_bytes(b'changed')
            with self.assertRaises(crosscheck.GateError):
                run(True)

    def test_private_exception_is_not_exposed_to_ci(self):
        with patch.object(crosscheck,'run',
                          side_effect=RuntimeError('NEVER_LEAK_PRIVATE_OCR')):
            output=StringIO()
            with redirect_stdout(output):
                status=crosscheck.main([
                    '--page-png','x','--mineru-markdown','x','--anchor-v1','x',
                    '--pixel-v3','x','--private-output','x','--private-overlay','x'])
            self.assertEqual(status,2)
            self.assertEqual(output.getvalue().strip(),'ACS_B15_FEATURE_REVIEW=REJECTED')


if __name__=='__main__':
    unittest.main()
