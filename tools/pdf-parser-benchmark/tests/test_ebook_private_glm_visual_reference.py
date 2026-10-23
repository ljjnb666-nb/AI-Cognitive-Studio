"""Synthetic only: GLM private page-pixel provisional ROIs; zero actual API calls."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_glm_visual_reference import (
    AUTHORITY, VisualGateError, _one_to_one_consensus, build_reference,
    parse_model_regions, render_page, request_visual, source_manifest,
    write_private,
)

RAW = {"B15": b"fictional PDF A", "B31": b"fictional PDF B"}
PAGES = {"B15": (109, 438, 270, "chart"), "B31": (126, 504, 0, "directed_graph")}
MANIFEST = {"sources": [
    {"id": book, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
     "total_physical_pages": PAGES[book][1]} for book, data in RAW.items()
]}


class FakePix:
    width, height = 900, 1100
    def tobytes(self, fmt):
        assert fmt == "png"
        return b"fake PNG bytes"


class FakePage:
    def __init__(self, book):
        self.rotation = PAGES[book][2]
    def get_pixmap(self, *, matrix, alpha, colorspace):
        assert alpha is False
        return FakePix()


class FakePDF:
    def __init__(self, book):
        self.book = book
        self.page_count = PAGES[book][1]
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return None
    def __getitem__(self, index):
        assert index == PAGES[self.book][0]-1
        return FakePage(self.book)


class FakeFitz:
    csRGB = object()
    def Matrix(self, x, y):
        return (x,y)
    def open(self, *, stream, filetype):
        assert filetype == "pdf"
        return FakePDF(next(book for book, data in RAW.items() if stream == data))


def reply(kind, shift=0):
    box = ([100+shift, 120+shift, 440+shift, 460+shift]
           if kind == "chart" else [220+shift, 250+shift, 760+shift, 850+shift])
    return json.dumps({"regions":[{"kind":kind,"box":box}]})


class PrivateVision(unittest.TestCase):
    def test_manifest_and_invalid_source(self):
        self.assertEqual(set(source_manifest(MANIFEST)), {"B15","B31"})
        wrong = copy.deepcopy(MANIFEST)
        wrong["sources"][0]["total_physical_pages"] = 99
        with self.assertRaisesRegex(VisualGateError,"MANIFEST_TARGET_INVALID"):
            source_manifest(wrong)

    def test_two_image_only_passes_emit_private_l2(self):
        calls = []
        def vision(image, prompt, book, round_id):
            calls.append((image, book, round_id, prompt))
            return reply(PAGES[book][3], 5*(round_id-1))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            ref, audit = build_reference(MANIFEST, RAW, fitz=FakeFitz(),
                                         vision_call=vision, private_root=root)
            self.assertEqual(ref["authority"], AUTHORITY)
            self.assertEqual(len(ref["regions"]), 2)
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(img == b"fake PNG bytes" for img,_,_,_ in calls))
            self.assertTrue(all(x["graph_semantics"] == "UNVERIFIED" for x in audit))
            self.assertTrue(all(x["evidence"] == "L2_AI_VISUAL_PROVISIONAL" for x in ref["regions"]))
            write_private(root,ref,audit)
            self.assertEqual(json.loads((root/"semantic_gate"/"B15_B31_roi_candidates.private.json").read_text()),ref)
            with self.assertRaisesRegex(VisualGateError,"PRIVATE_REFERENCE_ALREADY_EXISTS_NO_OVERWRITE"):
                write_private(root,ref,audit)

    def test_wrong_sha_stops_before_network(self):
        payload = {**RAW,"B15":b"wrong"}
        with self.assertRaisesRegex(VisualGateError,"PRIVATE_SOURCE_IDENTITY_MISMATCH"):
            build_reference(MANIFEST, payload, fitz=FakeFitz(),
                            vision_call=lambda *_:self.fail("network must not run"),
                            private_root=Path("."))

    def test_missing_book_stops_before_network(self):
        with self.assertRaisesRegex(VisualGateError,"PRIVATE_SOURCES_INCOMPLETE"):
            build_reference(MANIFEST, {"B15":RAW["B15"]}, fitz=FakeFitz(),
                            vision_call=lambda *_:self.fail("network must not run"),
                            private_root=Path("."))

    def test_rotated_page_geometry_fails_closed(self):
        class Broken(FakePDF):
            def __getitem__(self,index):
                p=super().__getitem__(index)
                p.rotation=90
                return p
        class WrongFitz(FakeFitz):
            def open(self, *,stream,filetype):
                return Broken(next(book for book,data in RAW.items() if data==stream))
        with self.assertRaisesRegex(VisualGateError,"REAL_PDF_ROTATION_CHANGED"):
            build_reference(MANIFEST, RAW, fitz=WrongFitz(),
                            vision_call=lambda *_:self.fail("model must not run"),
                            private_root=Path("."))

    def test_physical_page_display_render(self):
        image, rotation, size = render_page(RAW["B15"],109,FakeFitz())
        self.assertEqual((image,rotation,size),(b"fake PNG bytes",270,(900,1100)))

    def test_reply_json_strict_no_markdown(self):
        self.assertEqual(len(parse_model_regions(reply("chart"),"chart")),1)
        with self.assertRaisesRegex(VisualGateError,"MODEL_JSON_NOT_STRICT"):
            parse_model_regions("~~~json\n"+reply("chart")+"\n~~~","chart")

    def test_wrong_kind_or_extra_fields(self):
        for entry in ({"kind":"caption","box":[1,2,400,500]},
                      {"kind":"chart","box":[1,2,400,500],"humanVerified":True}):
            with self.assertRaises(VisualGateError):
                parse_model_regions(json.dumps({"regions":[entry]}),"chart")

    def test_empty_model_abstention_not_fake_zero(self):
        with self.assertRaisesRegex(VisualGateError,"MODEL_REGION_COUNT_INVALID"):
            parse_model_regions('{"regions":[]}',"chart")

    def test_nonfinite_bad_and_degenerate_boxes(self):
        for values in ([True,2,300,400],[0,float("nan"),100,400],
                       [200,200,200,300],[-1,20,300,400],[0,0,9999,1000]):
            with self.assertRaises(VisualGateError):
                parse_model_regions(json.dumps({"regions":[{"kind":"chart","box":values}]}),"chart")

    def test_duplicate_model_boxes(self):
        row={"kind":"chart","box":[100,150,600,700]}
        with self.assertRaisesRegex(VisualGateError,"MODEL_REGION_DUPLICATED"):
            parse_model_regions(json.dumps({"regions":[row,row]}),"chart")

    def test_count_disagreement(self):
        with self.assertRaisesRegex(VisualGateError,"L2_PASSES_DISAGREE_ON_REGION_COUNT"):
            _one_to_one_consensus([(.1,.1,.4,.4)],[ (.1,.1,.4,.4),(.5,.5,.9,.9)])

    def test_location_disagreement(self):
        with self.assertRaisesRegex(VisualGateError,"L2_PASSES_SPATIAL_CONSENSUS_UNAVAILABLE"):
            _one_to_one_consensus([(.1,.1,.4,.4)],[ (.5,.5,.9,.9)])

    def test_permuted_region_order(self):
        a=[(.1,.1,.35,.4),(.5,.5,.8,.9)]
        self.assertEqual(_one_to_one_consensus(a,[a[1],a[0]]),a)

    def test_provider_network_unknown_outcome_never_retried(self):
        class Error:
            calls=0
            def post(self,*args,**kwargs):
                self.calls+=1
                raise RuntimeError("unknown")
        fake=Error()
        with self.assertRaisesRegex(VisualGateError,"VISION_TRANSPORT_UNKNOWN_OUTCOME"):
            request_visual(b"img","prompt","x"*20,requests_module=fake,round_id=1)
        self.assertEqual(fake.calls,1)

    def test_provider_endpoint_fenced_no_redirect(self):
        class Response:
            status_code=200
            calls=0
            def post(self,url,*,json,headers,timeout,allow_redirects):
                self.calls+=1
                self.req=(url,json,headers,timeout,allow_redirects)
                return self
            def json(self):
                return {"choices":[{"message":{"content":reply("chart")}}]}
        fake=Response()
        result=request_visual(b"image","prompt","x"*20,requests_module=fake,round_id=2)
        self.assertEqual(len(parse_model_regions(result,"chart")),1)
        url,payload,headers,timeout,redirects=fake.req
        self.assertEqual(url,"https://open.bigmodel.cn/api/paas/v4/chat/completions")
        self.assertFalse(redirects)
        self.assertEqual(fake.calls,1)
        self.assertEqual(payload["model"],"glm-4.6v")
        self.assertTrue(payload["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_missing_key_no_network(self):
        with self.assertRaisesRegex(VisualGateError,"VISION_API_KEY_NOT_CONFIGURED"):
            request_visual(b"img","prompt","",requests_module=None,round_id=1)


if __name__=="__main__":
    unittest.main()
