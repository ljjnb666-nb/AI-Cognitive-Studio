"""Synthetic pixel-only B15 frame calibration; never called real ROI gold."""
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_b15_independent_frame import (
    BOOK, PAGE, ROTATION, _image_anchors, calibrate, infer_docling_frame,
)
from ebook_private_roi_alignment import Rejected
from ebook_roi_rotation_contract import AUTHORITY, FRAME_UNROTATED, FRAME_DISPLAY

W,H=180,260
RAW=b"synthetic PDF bytes: not a real document"
MANIFEST={"sources":[{"id":BOOK,"size":len(RAW),
    "sha256":hashlib.sha256(RAW).hexdigest(),"total_physical_pages":438}]}


def raster(w,h,pixel):
    return b"".join(bytes(pixel(x,y)) for y in range(h) for x in range(w))


def pixel(x,y):
    base=(x*19+y*23+(x*y)%29)%251
    return (base,(base*17+31)%256,(base*13+11)%256)


class FakePixmap:
    n=3
    def __init__(self,orientation):
        if orientation==0:
            self.width,self.height=W,H
            self.samples=raster(W,H,pixel)
        else:
            self.width,self.height=H,W
            # 270 degrees clockwise -> display coords (y,W-1-x)
            self.samples=raster(H,W,lambda x,y:pixel(W-1-y,x))


class FakePage:
    def __init__(self):
        self.rotation=270
    def get_pixmap(self,*,matrix,alpha,colorspace):
        return FakePixmap(self.rotation)
    def set_rotation(self,d):
        self.rotation=d


class FakePDF:
    def __init__(self):
        self.page=FakePage()
    def __enter__(self):
        return self
    def __exit__(self,*_):
        return None
    def __len__(self):
        return 438
    def __getitem__(self,index):
        assert index==108
        return self.page


class FakeFitz:
    csRGB=object()
    def open(self,*,stream,filetype):
        assert stream==RAW and filetype=="pdf"
        return FakePDF()
    def Matrix(self,a,b):
        return (a,b)


def report(size):
    return {"schema_version":1,"missing":[],"failed":[],"rows":[{
        "status":"SUCCESS","book_id":"B15","physical_page":109,
        "source_sha256":MANIFEST["sources"][0]["sha256"],
        "docling_status":"SUCCESS","results":[{
            "engine":"Docling","layout_evidence":{"private_docling_page_size":size}
        }]
    }]}


class Calibration(unittest.TestCase):
    def test_dimensions_show_unrotated_docling_frame(self):
        self.assertEqual(infer_docling_frame([W,H],[W,H],[H,W]),FRAME_UNROTATED)

    def test_dimensions_show_display_docling_frame(self):
        self.assertEqual(infer_docling_frame([H,W],[W,H],[H,W]),FRAME_DISPLAY)

    def test_square_or_unmatched_aspect_fails_closed(self):
        with self.assertRaisesRegex(Rejected,"FRAME_ASPECT_RATIO_AMBIGUOUS"):
            infer_docling_frame([100,100],[200,200],[200,200])
        with self.assertRaisesRegex(Rejected,"FRAME_ASPECT_RATIO_AMBIGUOUS"):
            infer_docling_frame([300,300],[180,260],[260,180])

    def test_pixel_landmarks_are_independent_spread_and_verified(self):
        pairs=_image_anchors(FakePixmap(0),FakePixmap(270),270)
        self.assertGreaterEqual(len(pairs),3)
        self.assertTrue(all(0<v<1 for src,dst in pairs for v in (*src,*dst)))
        for src,dst in pairs:
            self.assertAlmostEqual(dst[0],src[1],delta=.01)
            self.assertAlmostEqual(dst[1],1-src[0],delta=.01)

    def test_private_frame_calibration_unrotated_candidate(self):
        record=calibrate(MANIFEST,report([W,H]),RAW,FakeFitz())
        self.assertEqual(record["candidate_frame"],FRAME_UNROTATED)
        self.assertEqual(record["authority"],AUTHORITY)
        self.assertEqual(record["physical_page"],109)
        self.assertEqual(record["source_pdf_rotation_degrees"],270)
        self.assertGreaterEqual(len(record["anchor_pairs"]),3)
        self.assertEqual(set(record),{
            "schema_version","authority","book_id","physical_page",
            "source_document_sha256","source_pdf_rotation_degrees",
            "candidate_frame","reference_frame","anchor_pairs",
        })
        self.assertEqual(record["reference_frame"],FRAME_DISPLAY)

    def test_private_frame_calibration_display_candidate(self):
        record=calibrate(MANIFEST,report([H,W]),RAW,FakeFitz())
        self.assertEqual(record["candidate_frame"],FRAME_DISPLAY)
        self.assertGreaterEqual(len(record["anchor_pairs"]),3)

    def test_wrong_sha_never_renders_pdf(self):
        with self.assertRaisesRegex(Rejected,"FRAME_SOURCE_SHA_MISMATCH"):
            calibrate(MANIFEST,report([W,H]),b"modified",FakeFitz())

    def test_wrong_docling_page_or_book_blocks_calibration(self):
        bad=report([W,H])
        bad["rows"][0]["physical_page"]=110
        with self.assertRaisesRegex(Rejected,"FRAME_DOCLING_SOURCE_MISMATCH"):
            calibrate(MANIFEST,bad,RAW,FakeFitz())

    def test_invalid_docling_frame_dimensions_blocks(self):
        for size in ([float("nan"),H],[-1,H],[0,H]):
            with self.assertRaises(Rejected):
                infer_docling_frame(size,[W,H],[H,W])

    def test_insufficient_texture_is_not_independent_evidence(self):
        image=FakePixmap(0)
        image.samples=b"\xff"*len(image.samples)
        with self.assertRaisesRegex(Rejected,"FRAME_INDEPENDENT_PIXEL_ANCHORS_MISSING"):
            _image_anchors(image,FakePixmap(270),270)


if __name__=="__main__":
    unittest.main()
