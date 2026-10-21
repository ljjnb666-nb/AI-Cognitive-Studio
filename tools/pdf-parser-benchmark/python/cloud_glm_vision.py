"""GLM cloud vision adapter for the existing SHA-bound private MinerU crop workflow.

Explicit opt-in only. The GLM API receives selected image crop bytes.
Never upload whole PDFs, original book pages, OCR markdown, or test artifacts.
No logs contain API keys, user content, model responses, or private coordinates.
Every model proposal stays PROPOSED_UNVERIFIED; no automatic graph publication.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_vision_proposals import (
    ROOT, SOURCE_RUN, PAGES, SYSTEM_PROMPT, USER_PROMPT,
    LocalVisionBlocked, verify_regions,
)
from vision_graph_proposal_contract import (
    SuggestionBlocked, empty_template, validate_candidate,
)

# Do not make any API URL or hostname user-configurable.
API = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
MODELS = frozenset(("glm-5.3-flash", "glm-5.3-flashx", "glm-4.6v-flash"))
DEFAULT_MODEL = "glm-5.3-flash"
MAX_IMAGE_BYTES = 8_000_000
MAX_REQUEST_BYTES = 12_000_000
MAX_RESPONSE_BYTES = 128_000
MAX_REGIONS_IN_ONE_RUN = 3
REGION_RE = re.compile(r"page-[0-9]{3}-region-[0-9]{2}\Z")


class CloudBlocked(ValueError):
    pass



def response_metadata(answer: dict, expected_model: str) -> dict:
    """Only bounded categorical telemetry. No provider text or reasoning is recorded."""
    choices = answer.get("choices")
    count = len(choices) if isinstance(choices, list) else -1
    choice = choices[0] if count > 0 and isinstance(choices[0], dict) else {}
    message = choice.get("message")
    message = message if isinstance(message, dict) else {}
    finish = choice.get("finish_reason")
    content = message.get("content")
    actual_model = answer.get("model")
    usage = answer.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    def tokens(field):
        value = usage.get(field)
        return value if type(value) is int and 0 <= value <= 2000000 else -1
    return {
        "modelMatchesRequested": actual_model == expected_model,
        "modelFieldPresent": isinstance(actual_model, str),
        "choicesCount": min(count, 2000000),
        "finishStatus": "STOP" if finish == "stop" else ("LENGTH" if finish == "length" else ("MISSING" if finish is None else "OTHER")),
        "contentKind": "TEXT" if isinstance(content, str) else ("MISSING" if content is None else "OTHER"),
        "contentChars": min(len(content), 2000000) if isinstance(content, str) else -1,
        "reasoningPresent": isinstance(message.get("reasoning_content"), str) and bool(message["reasoning_content"]),
        "promptTokens": tokens("prompt_tokens"),
        "completionTokens": tokens("completion_tokens"),
    }


def record_attempt(receipt: Path, event: str, **fields) -> None:
    """Append fixed-shape metadata to a PRIVATE local receipt. Never add raw strings."""
    permitted = {
        "REQUEST_DISPATCHED": set(),
        "HTTP_200": {"responseBytes"},
        "RESPONSE_META": set(response_metadata({}, DEFAULT_MODEL)),
        "MODEL_RESULT_ACCEPTED": {"nodeCount", "edgeCount"},
        "FAILED": {"errorCode"},
        "OUTPUT_SAVED": set(),
    }
    if event not in permitted or set(fields) != permitted[event]:
        raise CloudBlocked("CLOUD_RECEIPT_FIELD_INVALID")
    for name, value in fields.items():
        if name == "errorCode":
            if not isinstance(value, str) or not re.fullmatch(r"CLOUD_[A-Z0-9_]{3,70}", value):
                raise CloudBlocked("CLOUD_RECEIPT_FIELD_INVALID")
        elif name in ("finishStatus", "contentKind"):
            if value not in (("STOP", "LENGTH", "MISSING", "OTHER") if name == "finishStatus" else ("TEXT", "MISSING", "OTHER")):
                raise CloudBlocked("CLOUD_RECEIPT_FIELD_INVALID")
        elif type(value) is bool:
            pass
        elif type(value) is not int or not -1 <= value <= 2000000:
            raise CloudBlocked("CLOUD_RECEIPT_FIELD_INVALID")
    with receipt.open("a", encoding="utf-8") as out:
        out.write(json.dumps({"event": event, **fields}, sort_keys=True) + "\n")
        out.flush()
        os.fsync(out.fileno())


class NeverFollowRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise CloudBlocked("CLOUD_API_REDIRECT_REJECTED")


def secret_from_environment() -> str:
    key = os.environ.get("ZHIPU_API_KEY", "")
    if not isinstance(key, str) or not 10 <= len(key) <= 512 or any(c.isspace() for c in key):
        raise CloudBlocked("ZHIPU_API_KEY_MISSING_OR_INVALID")
    return key


def request_glm(payload: dict, key: str, *, observer=None) -> dict:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if len(raw) > MAX_REQUEST_BYTES:
        raise CloudBlocked("CLOUD_REQUEST_SIZE_LIMIT")
    req = Request(API, data=raw, method="POST",
                  headers={"Content-Type": "application/json",
                           "Authorization": "Bearer " + key})
    # No proxies, no redirects; only TLS to the pinned Zhipu API endpoint.
    opener = build_opener(ProxyHandler({}), NeverFollowRedirect())
    if observer is not None:
        observer("REQUEST_DISPATCHED")
    try:
        with opener.open(req, timeout=120) as response:
            if response.status != 200:
                raise CloudBlocked("CLOUD_HTTP_REJECTED")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        # Never surface HTTP response bodies: they could echo data or credentials.
        if exc.code in (401, 403):
            raise CloudBlocked("CLOUD_AUTH_DENIED") from None
        if exc.code == 429:
            raise CloudBlocked("CLOUD_RATE_LIMITED") from None
        raise CloudBlocked("CLOUD_HTTP_REJECTED") from None
    except (URLError, OSError, TimeoutError):
        raise CloudBlocked("CLOUD_API_UNREACHABLE") from None
    if observer is not None:
        observer("HTTP_200", responseBytes=min(len(body), 2000000))
    if len(body) > MAX_RESPONSE_BYTES:
        raise CloudBlocked("CLOUD_RESPONSE_TOO_LARGE")
    try:
        answer = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise CloudBlocked("CLOUD_RESPONSE_NOT_JSON") from None
    if not isinstance(answer, dict):
        raise CloudBlocked("CLOUD_RESPONSE_SHAPE_INVALID")
    return answer


def infer_cloud_one(item: dict, model: str, key: str, *, observer=None) -> dict:
    if model not in MODELS:
        raise CloudBlocked("VISION_MODEL_NOT_ALLOWLISTED")
    crop = item["crop"]
    if (crop.is_symlink() or not crop.is_file() or
            not 0 < crop.stat().st_size <= MAX_IMAGE_BYTES):
        raise CloudBlocked("CROP_TOO_LARGE_OR_UNSAFE")
    # Provenance has already been verified; recheck bytes immediately before upload.
    image = crop.read_bytes()
    if hashlib.sha256(image).hexdigest() != item["sha"]:
        raise CloudBlocked("CROP_CHANGED_BEFORE_UPLOAD")
    payload = {
        "model": model,
        "stream": False,
        "do_sample": False,
        "reasoning_effort": "low",
        "max_tokens": 6000,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": USER_PROMPT.format(
                    width=item["width"], height=item["height"])},
                {"type": "image_url", "image_url": {
                    "url": "data:image/png;base64," + base64.b64encode(image).decode("ascii")
                }},
            ]},
        ],
    }
    answer = request_glm(payload, key) if observer is None else request_glm(payload, key, observer=observer)
    if observer is not None:
        observer("RESPONSE_META", **response_metadata(answer, model))
    if isinstance(answer.get("model"), str) and answer["model"] != model:
        raise CloudBlocked("CLOUD_RETURNED_MODEL_MISMATCH")
    try:
        choice = answer["choices"][0]
        if not isinstance(choice, dict):
            raise TypeError()
        finish = choice.get("finish_reason")
        if finish == "length":
            raise CloudBlocked("CLOUD_GENERATION_TRUNCATED")
        if finish not in ("stop", None):
            raise CloudBlocked("CLOUD_FINISH_STATUS_REJECTED")
        content = choice["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise CloudBlocked("CLOUD_CONTENT_MISSING")
        if len(content) > MAX_RESPONSE_BYTES:
            raise CloudBlocked("CLOUD_CONTENT_TOO_LARGE")
        obj = parse_complete_graph_json(content)
    except (KeyError, IndexError, TypeError):
        raise CloudBlocked("CLOUD_RESPONSE_ENVELOPE_INVALID") from None
    return obj



def parse_complete_graph_json(content: str) -> dict:
    """One whole JSON object, optionally inside one complete json code fence."""
    stripped = content.strip()
    if stripped.startswith("""" + chr(96) * 3 + """"):
        lines = stripped.splitlines()
        fence = chr(96) * 3
        if (len(lines) < 3 or lines[0] not in (fence + "json", fence + "JSON")
                or lines[-1] != fence or any(fence in line for line in lines[1:-1])):
            raise CloudBlocked("CLOUD_CONTENT_NOT_PURE_JSON")
        stripped = "\n".join(lines[1:-1])
    try:
        obj = json.loads(stripped)
    except (UnicodeError, ValueError):
        raise CloudBlocked("CLOUD_CONTENT_NOT_PURE_JSON") from None
    if not isinstance(obj, dict) or set(obj) != {"nodes", "edges"}:
        raise CloudBlocked("CLOUD_GRAPH_FIELDS_INVALID")
    return obj


def plan_regions(items: list[dict], region_id: str | None,
                 max_regions: int) -> list[dict]:
    if type(max_regions) is not int or not 1 <= max_regions <= MAX_REGIONS_IN_ONE_RUN:
        raise CloudBlocked("REQUEST_COUNT_LIMIT")
    if region_id is not None and (not isinstance(region_id, str)
                                  or not REGION_RE.fullmatch(region_id)):
        raise CloudBlocked("REGION_ID_INVALID")
    selected = [item for item in items if region_id is None or item["regionId"] == region_id]
    if not selected or (region_id is not None and len(selected) != 1):
        raise CloudBlocked("REGION_NOT_FOUND")
    return selected[:max_regions]


def execute_cloud(root: Path, fixture: str, model: str, *,
                  region_id: str | None, max_regions: int,
                  cloud_consent: bool, key: str | None = None) -> dict:
    if cloud_consent is not True:
        raise CloudBlocked("EXPLICIT_CLOUD_CONSENT_REQUIRED")
    if model not in MODELS:
        raise CloudBlocked("VISION_MODEL_NOT_ALLOWLISTED")
    # Fail BEFORE crop access if the key hasn't been provided.
    secret = key if key is not None else secret_from_environment()
    provenance, all_items = verify_regions(root, fixture)
    selected = plan_regions(all_items, region_id, max_regions)
    report = root / "reports" / SOURCE_RUN
    target_id = selected[0]["regionId"] if len(selected) == 1 else "batch"
    output = report / ("glm-cloud-v1-" + fixture + "-" + target_id)
    stage = report / ("." + output.name + "-stage")
    # Keep a durable spend/attempt marker even if a request fails after billing.
    # Never automatically retry such a failure; manual review is required.
    receipt = report / ("." + output.name + ".cloud-attempted")
    if (output.exists() or output.is_symlink() or stage.exists()
            or stage.is_symlink() or receipt.exists() or receipt.is_symlink()):
        raise CloudBlocked("CLOUD_RESULT_ALREADY_EXISTS")
    try:
        with receipt.open("x", encoding="utf-8") as entry:
            entry.write("Cloud attempt reserved; do not replay without inspection.\n")
            entry.flush()
            os.fsync(entry.fileno())
    except FileExistsError:
        raise CloudBlocked("CLOUD_RESULT_ALREADY_EXISTS") from None
    stage.mkdir()
    def observe(event, **fields):
        record_attempt(receipt, event, **fields)
    try:
        templates = {entry["regionId"]:entry for entry in empty_template(provenance)}
        results = []
        for item in selected:
            template = templates.get(item["regionId"])
            if not isinstance(template, dict) or template["sourceCropSha256"] != item["sha"]:
                raise CloudBlocked("SOURCE_TEMPLATE_SHA_MISMATCH")
            proposal = dict(template)
            model_result = infer_cloud_one(item, model, secret, observer=observe)
            observe("MODEL_RESULT_ACCEPTED", nodeCount=len(model_result["nodes"]), edgeCount=len(model_result["edges"]))
            proposal["nodes"] = model_result["nodes"]
            proposal["edges"] = model_result["edges"]
            try:
                checked = validate_candidate(proposal, provenance)
            except (SuggestionBlocked, KeyError, TypeError, ValueError):
                raise CloudBlocked("CLOUD_PROPOSAL_EVIDENCE_REJECTED") from None
            results.append({
                "regionId": item["regionId"],
                "sourcePhysicalPage1Based": item["page"],
                "cropSha256": item["sha"],
                "proposal": proposal,
                "mappedPageEvidence": checked,
                "humanReviewStatus": "NOT_REVIEWED",
                "graphVerified": False,
            })
        metadata = {
            "schemaVersion": "acs-glm-cloud-vision-proposal-v1",
            "sourceRun": SOURCE_RUN,
            "fixtureId": fixture,
            "provider": "ZHIPU_GLMCLOUD_STANDARD_API",
            "model": model,
            "sourceRegionManifestSha256": hashlib.sha256(
                (report / ("region-proposals-v1-" + fixture) /
                 "region-proposals.json").read_bytes()).hexdigest(),
            "transferScope": "EXPLICITLY_SELECTED_CROP_IMAGES_ONLY",
            "reviewStatus": "NOT_REVIEWED",
            "graphVerified": False,
            "results": results,
        }
        path = stage / "cloud-vision-proposals.json"
        with path.open("x", encoding="utf-8") as handle:
            json.dump(metadata, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.rename(stage, output)
        observe("OUTPUT_SAVED")
    except BaseException as exc:
        # Retain first-failure diagnostics while preserving the original error.
        code = str(exc) if isinstance(exc, CloudBlocked) else "CLOUD_RUNTIME_BLOCKED"
        if not re.fullmatch(r"CLOUD_[A-Z0-9_]{3,70}", code):
            code = "CLOUD_RUNTIME_BLOCKED"
        try:
            observe("FAILED", errorCode=code)
        except (OSError, CloudBlocked):
            pass
        # Durable receipt remains even when output is incomplete. No auto retries.
        if stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
        raise
    return {
        "status": "GLM_CLOUD_PROPOSALS_SAVED_UNREVIEWED",
        "fixtureId": fixture,
        "imagesSentToGLM": len(selected),
        "wholePdfSent": False,
        "cropMayIncludeMostOfAPage": True,
        "modelProposedNodes": sum(len(r["proposal"]["nodes"]) for r in results),
        "modelProposedEdges": sum(len(r["proposal"]["edges"]) for r in results),
        "graphRelationsHumanVerified": False,
        "outputSavedOnlyInPrivateDrive": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", choices=tuple(PAGES), required=True)
    parser.add_argument("--model", choices=sorted(MODELS), default=DEFAULT_MODEL)
    parser.add_argument("--region-id", default=None)
    parser.add_argument("--max-regions", type=int, default=1)
    parser.add_argument("--allow-cloud-upload", action="store_true")
    args = parser.parse_args()
    try:
        result = execute_cloud(
            ROOT, args.fixture, args.model,
            region_id=args.region_id, max_regions=args.max_regions,
            cloud_consent=args.allow_cloud_upload,
        )
    except (CloudBlocked, LocalVisionBlocked) as exc:
        code = str(exc)
        if not re.fullmatch(r"[A-Z0-9_]{3,80}", code):
            code = "SAFE_ERROR"
        print("ACS_GLM_CLOUD_BLOCKED=" + code)
        sys.exit(2)
    except Exception:
        print("ACS_GLM_CLOUD_RUNTIME_BLOCKED")
        sys.exit(2)
    print("ACS_GLM_CLOUD_RESULT=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
