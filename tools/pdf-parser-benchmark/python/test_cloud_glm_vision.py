"""Synthetic-only GLM cloud privacy, cost and provenance regression tests."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from io import BytesIO

sys.path.insert(0,str(Path(__file__).resolve().parent))
import cloud_glm_vision as glm

SHA="a"*64

def provenance():
    return {"schemaVersion":"acs-pdf-private-region-evidence-v1",
            "fixtureId":"RB-PDF-13","allRegionsAreUnverified":True,
            "noSemanticGraphClaims":True,"pages":[{"sourcePhysicalPage1Based":127,
            "regions":[{"regionId":"page-002-region-01","cropSha256":SHA,
                        "bboxPixels":[100,200,300,240],
                        "proposalStatus":"UNVERIFIED_REGION_SUGGESTION",
                        "nodes":None,"directedEdges":None,"timingRelations":None}]}]}

def item(p):
    return {"regionId":"page-002-region-01","crop":p,
            "sha":SHA,"page":127,"width":300,"height":240}

def graph():
    return {"nodes":[
        {"id":"n1","label":"A","bboxCropPixels":[10,20,50,35],
         "proposalConfidence":0.4,"reviewStatus":"NOT_REVIEWED"},
        {"id":"n2","label":"B","bboxCropPixels":[210,20,50,35],
         "proposalConfidence":0.4,"reviewStatus":"NOT_REVIEWED"}],
        "edges":[{"id":"e1","fromNodeId":"n1","toNodeId":"n2",
                  "direction":"FROM_TO_SUGGESTED","arrowTipCropPixels":[200,35],
                  "shaftCropPixels":[[85,35],[195,35]],
                  "proposalConfidence":0.3,"reviewStatus":"NOT_REVIEWED"}]}

class GLMTests(unittest.TestCase):
    def test_model_allowlist_and_url(self):
        self.assertEqual(glm.DEFAULT_MODEL,"glm-5.3-flash")
        self.assertEqual(glm.API,"https://open.bigmodel.cn/api/paas/v4/chat/completions")
        with self.assertRaisesRegex(glm.CloudBlocked,"MODEL_NOT_ALLOWLISTED"):
            glm.execute_cloud(Path("unused"),"RB-PDF-13","https://evil",
                              region_id=None,max_regions=1,cloud_consent=True,key="demo")

    def test_opt_in_before_any_private_file(self):
        with patch.object(glm,"verify_regions") as read:
            with self.assertRaisesRegex(glm.CloudBlocked,"CONSENT_REQUIRED"):
                glm.execute_cloud(Path("unused"),"RB-PDF-13",glm.DEFAULT_MODEL,
                                  region_id=None,max_regions=1,cloud_consent=False,key="demo")
            read.assert_not_called()

    def test_missing_key_before_private_file(self):
        with patch.dict("os.environ",{"ZHIPU_API_KEY":""}):
            with patch.object(glm,"verify_regions") as read:
                with self.assertRaisesRegex(glm.CloudBlocked,"API_KEY_MISSING"):
                    glm.execute_cloud(Path("unused"),"RB-PDF-13",glm.DEFAULT_MODEL,
                                      region_id=None,max_regions=1,cloud_consent=True)
                read.assert_not_called()

    def test_request_limit_and_region_scope(self):
        rows=[dict(item(Path("none")),regionId=f"page-002-region-{i:02d}") for i in range(1,9)]
        self.assertEqual(len(glm.plan_regions(rows,None,1)),1)
        with self.assertRaisesRegex(glm.CloudBlocked,"COUNT_LIMIT"):
            glm.plan_regions(rows,None,4)
        with self.assertRaisesRegex(glm.CloudBlocked,"REGION_ID_INVALID"):
            glm.plan_regions(rows,"../foo",1)

    def test_no_redirect_to_other_domain(self):
        with self.assertRaisesRegex(glm.CloudBlocked,"REDIRECT"):
            glm.NeverFollowRedirect().redirect_request(None,None,302,"moved",{},"https://other")

    def test_http_error_redacts_server_body_and_secret(self):
        fake=HTTPError(glm.API,401,"secret",{},BytesIO(b"BOOK_TEXT SECRET"))
        with patch.object(glm,"build_opener") as opener:
            opener.return_value.open.side_effect=fake
            with self.assertRaisesRegex(glm.CloudBlocked,"AUTH_DENIED") as raised:
                glm.request_glm({"model":glm.DEFAULT_MODEL},"demo-key")
        self.assertNotIn("BOOK_TEXT",str(raised.exception))
        self.assertNotIn("demo-key",str(raised.exception))

    def test_request_is_crop_only_base64_and_pinned_model(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"crop.png"
            p.write_bytes(b"SYNTHETIC-IMAGE")
            row=item(p)
            row["sha"]=hashlib.sha256(p.read_bytes()).hexdigest()
            reply={"choices":[{"finish_reason":"stop","message":{"content":json.dumps(graph())}}]}
            with patch.object(glm,"request_glm",return_value=reply) as send:
                self.assertEqual(glm.infer_cloud_one(row,glm.DEFAULT_MODEL,"demo-key"),graph())
        payload,key=send.call_args.args
        self.assertEqual(key,"demo-key")
        self.assertEqual(payload["model"],glm.DEFAULT_MODEL)
        self.assertEqual(len(payload["messages"]),2)
        self.assertTrue(payload["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertNotIn("demo-key",json.dumps(payload))

    def test_changed_crop_sha_stops_upload(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"crop.png"
            p.write_bytes(b"CHANGED")
            with patch.object(glm,"request_glm") as send:
                with self.assertRaisesRegex(glm.CloudBlocked,"CHANGED"):
                    glm.infer_cloud_one(item(p),glm.DEFAULT_MODEL,"demo")
                send.assert_not_called()

    def test_model_non_json_and_truncation_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"crop.png"
            p.write_bytes(b"SYNTHETIC")
            row=item(p)
            row["sha"]=hashlib.sha256(p.read_bytes()).hexdigest()
            for text,reason in [("not JSON","CONTENT_NOT_PURE_JSON"),(json.dumps({"nodes":[],"edges":[],"verified":True}),"GRAPH_FIELDS_INVALID")]:
                reply={"choices":[{"finish_reason":"stop","message":{"content":text}}]}
                with patch.object(glm,"request_glm",return_value=reply):
                    with self.assertRaisesRegex(glm.CloudBlocked,reason):
                        glm.infer_cloud_one(row,glm.DEFAULT_MODEL,"demo")
            reply={"choices":[{"finish_reason":"stop","message":{"content":""}}]}
            with patch.object(glm,"request_glm",return_value=reply):
                with self.assertRaisesRegex(glm.CloudBlocked,"CONTENT_MISSING"):
                    glm.infer_cloud_one(row,glm.DEFAULT_MODEL,"demo")
            reply={"choices":[{"finish_reason":"length","message":{"content":json.dumps(graph())}}]}
            with patch.object(glm,"request_glm",return_value=reply):
                with self.assertRaisesRegex(glm.CloudBlocked,"GENERATION_TRUNCATED"):
                    glm.infer_cloud_one(row,glm.DEFAULT_MODEL,"demo")

    def test_strict_full_json_fence_and_redacted_response_metadata(self):
        body=json.dumps(graph())
        fence=chr(96)*3
        self.assertEqual(glm.parse_complete_graph_json(body),graph())
        self.assertEqual(glm.parse_complete_graph_json(" "+fence+"json\n"+body+"\n"+fence+" "),graph())
        for candidate in ("prefix "+body, body+" suffix", fence+"json\n"+body+"\n"+fence+" more",
                          fence+"python\n"+body+"\n"+fence,
                          fence+"json\n"+body+"\n"+fence+"\n"+fence+"json\n"+body+"\n"+fence):
            with self.subTest(candidate=candidate[:10]):
                with self.assertRaisesRegex(glm.CloudBlocked,"CONTENT_NOT_PURE_JSON"):
                    glm.parse_complete_graph_json(candidate)
        with self.assertRaisesRegex(glm.CloudBlocked,"GRAPH_FIELDS_INVALID"):
            glm.parse_complete_graph_json(json.dumps({"nodes":[],"edges":[],"verified":True}))
        sample={"model":glm.DEFAULT_MODEL,"usage":{"prompt_tokens":124,"completion_tokens":38},
                "choices":[{"finish_reason":"length",
                            "message":{"content":"PRIVATE BOOK BODY",
                                       "reasoning_content":"PRIVATE CHAIN"}}]}
        metadata=glm.response_metadata(sample,glm.DEFAULT_MODEL)
        self.assertEqual(metadata["finishStatus"],"LENGTH")
        self.assertEqual(metadata["contentChars"],17)
        self.assertTrue(metadata["modelMatchesRequested"])
        self.assertTrue(metadata["reasoningPresent"])
        self.assertNotIn("PRIVATE",json.dumps(metadata))

    def test_post_http_receipt_is_private_bounded_and_blocks_replay(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder=root/"reports"/glm.SOURCE_RUN/"region-proposals-v1-RB-PDF-13"
            folder.mkdir(parents=True)
            (folder/"region-proposals.json").write_text(json.dumps(provenance()),encoding="utf-8")
            def synthetic_rejected(row, model, key, *, observer=None):
                observer("REQUEST_DISPATCHED")
                observer("HTTP_200",responseBytes=141)
                observer("RESPONSE_META",**glm.response_metadata({
                    "model":model,"choices":[{"finish_reason":"stop",
                                             "message":{"content":"PRIVATE BOOK BODY"}}]},model))
                raise glm.CloudBlocked("CLOUD_CONTENT_NOT_PURE_JSON")
            with patch.object(glm,"verify_regions",return_value=(provenance(),[item(root/"fake")])):
                with patch.object(glm,"infer_cloud_one",side_effect=synthetic_rejected):
                    with self.assertRaisesRegex(glm.CloudBlocked,"CONTENT_NOT_PURE_JSON"):
                        glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                            region_id=None,max_regions=1,cloud_consent=True,key="demo")
            receipt=root/"reports"/glm.SOURCE_RUN/".glm-cloud-v1-RB-PDF-13-page-002-region-01.cloud-attempted"
            raw=receipt.read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE",raw)
            self.assertNotIn("demo",raw)
            events=[json.loads(line)["event"] for line in raw.splitlines()[1:]]
            self.assertEqual(events,["REQUEST_DISPATCHED","HTTP_200","RESPONSE_META","FAILED"])
            with patch.object(glm,"verify_regions",return_value=(provenance(),[item(root/"fake")])):
                with patch.object(glm,"infer_cloud_one") as call:
                    with self.assertRaisesRegex(glm.CloudBlocked,"ALREADY_EXISTS"):
                        glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                            region_id=None,max_regions=1,cloud_consent=True,key="demo")
                    call.assert_not_called()

    def test_mock_cloud_result_unreviewed_and_no_replay(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder=root/"reports"/glm.SOURCE_RUN/"region-proposals-v1-RB-PDF-13"
            folder.mkdir(parents=True)
            (folder/"region-proposals.json").write_text(json.dumps(provenance()),encoding="utf-8")
            row=item(root/"fake.png")
            with patch.object(glm,"verify_regions",return_value=(provenance(),[row])):
                with patch.object(glm,"infer_cloud_one",return_value=graph()) as model:
                    result=glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                        region_id=None,max_regions=1,cloud_consent=True,key="demo")
                    model.assert_called_once()
                with patch.object(glm,"infer_cloud_one") as model:
                    with self.assertRaisesRegex(glm.CloudBlocked,"ALREADY_EXISTS"):
                        glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                            region_id=None,max_regions=1,cloud_consent=True,key="demo")
                    model.assert_not_called()
            self.assertEqual(result["imagesSentToGLM"],1)
            self.assertFalse(result["graphRelationsHumanVerified"])
            output=root/"reports"/glm.SOURCE_RUN/"glm-cloud-v1-RB-PDF-13-page-002-region-01"/"cloud-vision-proposals.json"
            doc=json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(doc["graphVerified"])
            self.assertEqual(doc["reviewStatus"],"NOT_REVIEWED")

    def test_invalid_arrow_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder=root/"reports"/glm.SOURCE_RUN/"region-proposals-v1-RB-PDF-13"
            folder.mkdir(parents=True)
            (folder/"region-proposals.json").write_text(json.dumps(provenance()))
            bad=graph()
            bad["edges"][0]["arrowTipCropPixels"]=[999,999]
            with patch.object(glm,"verify_regions",return_value=(provenance(),[item(root/"fake")])):
                with patch.object(glm,"infer_cloud_one",return_value=bad):
                    with self.assertRaisesRegex(glm.CloudBlocked,"EVIDENCE_REJECTED"):
                        glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                            region_id=None,max_regions=1,cloud_consent=True,key="demo")

    def test_failed_billable_call_has_durable_no_replay_marker(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder=root/"reports"/glm.SOURCE_RUN/"region-proposals-v1-RB-PDF-13"
            folder.mkdir(parents=True)
            (folder/"region-proposals.json").write_text(json.dumps(provenance()))
            row=item(root/"fake.png")
            with patch.object(glm,"verify_regions",return_value=(provenance(),[row])):
                with patch.object(glm,"infer_cloud_one",side_effect=glm.CloudBlocked("CLOUD_RATE_LIMITED")) as send:
                    with self.assertRaisesRegex(glm.CloudBlocked,"RATE_LIMITED"):
                        glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                            region_id=None,max_regions=1,cloud_consent=True,key="demo")
                    send.assert_called_once()
                receipt=root/"reports"/glm.SOURCE_RUN/".glm-cloud-v1-RB-PDF-13-page-002-region-01.cloud-attempted"
                self.assertTrue(receipt.is_file())
                with patch.object(glm,"infer_cloud_one") as send:
                    with self.assertRaisesRegex(glm.CloudBlocked,"ALREADY_EXISTS"):
                        glm.execute_cloud(root,"RB-PDF-13",glm.DEFAULT_MODEL,
                            region_id=None,max_regions=1,cloud_consent=True,key="demo")
                    send.assert_not_called()

if __name__=="__main__":
    unittest.main()
