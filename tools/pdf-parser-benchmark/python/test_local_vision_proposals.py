"""Synthetic-only checks for local image proposal and review safety."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
import local_vision_proposals as local

SHA="a"*64

def provenance():
    return {
        "schemaVersion":"acs-pdf-private-region-evidence-v1",
        "sourceRun":"real-mineru-39440805765-1",
        "fixtureId":"RB-PDF-13",
        "allRegionsAreUnverified":True,"noSemanticGraphClaims":True,
        "pages":[{"sourcePhysicalPage1Based":127,
                  "regions":[{"regionId":"page-002-region-01",
                              "bboxPixels":[200,300,300,200],"cropSha256":SHA,
                              "proposalStatus":"UNVERIFIED_REGION_SUGGESTION",
                              "nodes":None,"directedEdges":None,"timingRelations":None}]}],
    }

def item(path):
    return {"page":127,"regionId":"page-002-region-01",
            "crop":path,"sha":SHA,"width":300,"height":200}

def graph():
    return {"nodes":[
        {"id":"n1","label":"client","bboxCropPixels":[10,20,50,30],
         "proposalConfidence":.5,"reviewStatus":"NOT_REVIEWED"},
        {"id":"n2","label":"server","bboxCropPixels":[190,20,50,30],
         "proposalConfidence":.4,"reviewStatus":"NOT_REVIEWED"}],
        "edges":[{
            "id":"e1","fromNodeId":"n1","toNodeId":"n2",
            "direction":"FROM_TO_SUGGESTED","arrowTipCropPixels":[185,35],
            "shaftCropPixels":[[80,35],[170,35]],
            "proposalConfidence":.4,"reviewStatus":"NOT_REVIEWED"}]}

class VisionFlowTests(unittest.TestCase):
    def test_empty_template_no_fabrication(self):
        out=local.build_proposal([item(Path("missing"))],provenance(),mode="prepare",model=None)
        self.assertEqual((out[0]["proposal"]["nodes"],out[0]["proposal"]["edges"]),([],[]))
        self.assertFalse(out[0]["graphVerified"])
        self.assertEqual(out[0]["mode"],"NOT_RUN_TEMPLATE")

    def test_mock_vision_success_still_unverified(self):
        with patch.object(local,"infer_one",return_value=graph()):
            out=local.build_proposal([item(Path("synthetic"))],provenance(),mode="infer",model="local-test")
        self.assertEqual(out[0]["mappedPageEvidence"]["mappedNodes"][0]["bboxPagePixels"],[210,320,50,30])
        self.assertEqual(out[0]["mode"],"MODEL_GENERATED_UNREVIEWED")
        self.assertFalse(out[0]["mappedPageEvidence"]["graphVerified"])

    def test_arrow_out_of_bounds_rejected(self):
        bad=graph()
        bad["edges"][0]["arrowTipCropPixels"]=[9999,44]
        with patch.object(local,"infer_one",return_value=bad):
            with self.assertRaisesRegex(local.LocalVisionBlocked,"EVIDENCE_GATE"):
                local.build_proposal([item(Path("synthetic"))],provenance(),mode="infer",model="vision")

    def test_source_sha_mismatch_rejected(self):
        forged=item(Path("synthetic"))
        forged["sha"]="b"*64
        with self.assertRaisesRegex(local.LocalVisionBlocked,"EVIDENCE_GATE"):
            local.build_proposal([forged],provenance(),mode="prepare",model=None)

    def test_wrong_model_id_or_absent_model_fails_closed(self):
        with patch.object(local,"strict_local_request",return_value={"data":[{"id":"other"}]}):
            with self.assertRaisesRegex(local.LocalVisionBlocked,"NOT_LOADED"):
                local.ensure_loaded_model("demo-vision")
        with self.assertRaisesRegex(local.LocalVisionBlocked,"MODEL_ID_INVALID"):
            local.ensure_loaded_model("https://example.org/model")

    def test_only_local_endpoints(self):
        with self.assertRaisesRegex(local.LocalVisionBlocked,"ENDPOINT"):
            local.strict_local_request("https://example.com")
        with self.assertRaisesRegex(local.LocalVisionBlocked,"ENDPOINT"):
            local.strict_local_request("/v1/other")

    def test_never_follow_cloud_redirect(self):
        with self.assertRaisesRegex(local.LocalVisionBlocked,"REDIRECT"):
            local.NoRedirect().redirect_request(None,None,302,"found",{},"https://example.com")

    def test_strict_json_no_fences_or_extra_fields(self):
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/"synthetic.png"
            image.write_bytes(b"NOT_REAL_IMAGE")
            fenced=chr(96)*3+"json\n"+json.dumps({"nodes":[],"edges":[]})+"\n"+chr(96)*3
            for text in (fenced,json.dumps({"nodes":[],"edges":[],"verified":True})):
                fake={"choices":[{"message":{"content":text}}]}
                with patch.object(local,"strict_local_request",return_value=fake):
                    with self.assertRaisesRegex(local.LocalVisionBlocked,"STRICT_JSON"):
                        local.infer_one("vision",item(image))

    def test_transport_is_strict_loopback_data_url(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"synthetic.png"
            path.write_bytes(b"SYNTHETIC-TEST")
            response={"choices":[{"message":{"content":json.dumps({"nodes":[],"edges":[]})}}]}
            with patch.object(local,"strict_local_request",return_value=response) as mock:
                v=local.infer_one("test-model",item(path))
        self.assertEqual(v,{"nodes":[],"edges":[]})
        endpoint,payload=mock.call_args.args
        self.assertEqual(endpoint,"/v1/chat/completions")
        self.assertEqual(payload["model"],"test-model")
        self.assertTrue(payload["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(local.API_ROOT,"http://127.0.0.1:1234")

    def test_empty_inference_still_not_verified(self):
        with patch.object(local,"infer_one",return_value={"nodes":[],"edges":[]}):
            out=local.build_proposal([item(Path("synthetic"))],provenance(),mode="infer",model="vision")
        self.assertFalse(out[0]["mappedPageEvidence"]["graphVerified"])

    def test_prepare_creates_private_file_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder=root/"reports"/local.SOURCE_RUN/"region-proposals-v1-RB-PDF-13"
            folder.mkdir(parents=True)
            (folder/"region-proposals.json").write_text(json.dumps(provenance()),encoding="utf-8")
            with patch.object(local,"verify_regions",return_value=(provenance(),[item(root/"missing.png")])):
                out=local.execute(root,"RB-PDF-13","prepare",None)
                self.assertEqual(out["status"],"VISION_TEMPLATES_SAVED_NO_INFERENCE")
                with self.assertRaisesRegex(local.LocalVisionBlocked,"COLLISION"):
                    local.execute(root,"RB-PDF-13","prepare",None)
            saved=root/"reports"/local.SOURCE_RUN/"local-vision-proposals-v1-RB-PDF-13-prepare"/"vision-proposals.json"
            doc=json.loads(saved.read_text(encoding="utf-8"))
            self.assertIsNone(doc["modelId"])
            self.assertFalse(doc["graphVerified"])

    def test_model_off_does_not_read_private_crop(self):
        with patch.object(local,"ensure_loaded_model",side_effect=local.LocalVisionBlocked("LOCAL_MODEL_API_UNAVAILABLE")):
            with patch.object(local,"verify_regions") as probe:
                with self.assertRaisesRegex(local.LocalVisionBlocked,"API_UNAVAILABLE"):
                    local.execute(Path("unused"),"RB-PDF-13","infer","demo")
                probe.assert_not_called()

    def test_forged_reviewed_status_rejected(self):
        data=graph()
        data["nodes"][0]["reviewStatus"]="VERIFIED"
        with patch.object(local,"infer_one",return_value=data):
            with self.assertRaises(local.LocalVisionBlocked):
                local.build_proposal([item(Path("none"))],provenance(),mode="infer",model="vision")

if __name__=="__main__":
    unittest.main()
