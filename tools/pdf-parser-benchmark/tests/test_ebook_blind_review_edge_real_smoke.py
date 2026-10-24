"""No browser/model synthetic contract tests for real Edge private workflow."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_blind_review_edge_real_smoke as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    work=folder/s.SUBDIR
    work.mkdir(parents=True)
    base=('<!doctype html><html><head>'
          '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">'
          '</head><body>原图盲审工作台 DRAFT_UNVERIFIED</body></html>').encode()
    (work/s.HTML_NAME).write_bytes(base)
    prior={
        "independent_reference_created":False,"independent_review_count":0,
        "review_draft_export_only":True,"external_network_calls":0,"cer":None,
        "workbench_html_sha256_private":hashlib.sha256(base).hexdigest(),
        "pages":[],
    }
    for book,page,scope in (("B15",109,"R3C2"),("B03",67,"FULL")):
        name=f"{book}_p{page:04d}_{scope}.source.private.png"
        data=("PRIVATE_IMAGE_FAKE_"+name).encode()
        (work/name).write_bytes(data)
        prior["pages"].append({
            "book_id":book,"physical_page":page,"scope":scope,
            "image_sha256_private":hashlib.sha256(data).hexdigest(),
        })
    edge=root/"Program Files"/"Microsoft"/"Edge"/"Application"/"msedge.exe"
    edge.parent.mkdir(parents=True)
    edge.write_bytes(b"FAKE EDGE BINARY FOR SYNTH ONLY")
    return folder,prior,edge


class EdgeAcceptanceTests(unittest.TestCase):
    def invoke(self,root,folder,prior,edge,*,runner):
        with patch.object(s,"_private_folder",return_value=folder):
            return s.test_viewer(root,{},edge_fn=lambda:edge,runner=runner,
                audit_fn=lambda r,m,audit:prior)

    def test_five_real_interaction_verdict_only_from_browser(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior,edge=fixture(root)
            calls=[]
            def fake_run(args,**kwargs):
                calls.append(args)
                self.assertIn("--dump-dom",args)
                self.assertIn("--headless=new",args)
                self.assertIn("--disable-background-networking",args)
                self.assertIn("--proxy-server=http://127.0.0.1:1",args)
                self.assertTrue(args[-1].startswith("file:"))
                self.assertTrue(kwargs["env"]["HTTPS_PROXY"].endswith(":1"))
                return SimpleNamespace(returncode=0,
                    stdout=b'<html data-acs-edge-real="PASS" data-acs-edge-tests="5"></html>',
                    stderr=b"")
            result=self.invoke(root,folder,prior,edge,runner=fake_run)
            self.assertEqual(len(calls),1)
            self.assertEqual(result["browser_interactions_passed"],5)
            self.assertEqual(result["private_source_images_displayed"],2)
            self.assertTrue(result["real_edge_binary_used"])
            self.assertIsNone(result["cer"])
            self.assertFalse(result["browser_network_packets_measured"])
            self.assertEqual(list((folder/s.SUBDIR).glob(".edge-smoke-private-*")),[])

    def test_browser_negative_verdict_fails_closed_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior,edge=fixture(root)
            def fail(*args,**kwargs):
                return SimpleNamespace(returncode=0,
                    stdout=b'<html data-acs-edge-real="FAIL" data-acs-edge-tests="4">',
                    stderr=b"PRIVATE ERROR")
            with self.assertRaisesRegex(VisualGateError,"INTERACTION_FAILED"):
                self.invoke(root,folder,prior,edge,runner=fail)

    def test_missing_source_image_sha_refuses_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior,edge=fixture(root)
            (folder/s.SUBDIR/"B03_p0067_FULL.source.private.png").write_bytes(b"changed")
            with self.assertRaisesRegex(VisualGateError,"ORIGINAL_PNG_SHA_CHANGED"):
                self.invoke(root,folder,prior,edge,runner=lambda *a,**k:
                            self.fail("browser may not launch"))
            self.assertEqual(list((folder/s.SUBDIR).glob(".edge-smoke-private-*")),[])

    def test_upstream_false_certified_reference_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior,edge=fixture(root)
            prior["independent_reference_created"]=True
            with self.assertRaisesRegex(VisualGateError,"NOT_A_BLIND_SOURCE"):
                self.invoke(root,folder,prior,edge,runner=lambda *a,**k:
                            self.fail("browser may not launch"))

    def test_no_offline_csp_or_private_html_tamper(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,prior,edge=fixture(root)
            (folder/s.SUBDIR/s.HTML_NAME).write_bytes(b"different")
            with self.assertRaisesRegex(VisualGateError,"HTML_SHA_CHANGED"):
                self.invoke(root,folder,prior,edge,runner=lambda *a,**k:
                            self.fail("browser may not launch"))
            with self.assertRaisesRegex(VisualGateError,"SOURCE_HTML_CONTRACT_INVALID"):
                s.make_test_html(b"<html><body>not isolated</body></html>")


if __name__=="__main__":
    unittest.main()
