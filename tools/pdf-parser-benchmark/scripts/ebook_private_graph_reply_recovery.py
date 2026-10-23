#!/usr/bin/env python3
"""Private, SHA-bound GLM reply custody and offline-only recovery.

The saved model content is sensitive, potentially copyrighted book data.
No network imports, no secret access, no raw response printing, no retries.
A saved HTTP 200 model response does NOT prove payment or graph correctness.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from ebook_private_glm_visual_reference import MODEL, PAGES, VisualGateError
from ebook_private_graph_receipt_audit import (
    AuditError, MAX_JSON_BYTES, PREFIX, check_marker,
    identities, no_duplicate_keys, private_json, reject_constant,
)

MAX_RAW_BYTES = 32768
FENCE = re.compile(r"\s*" + re.escape(chr(96) * 3) +
                   r"(?:json)?[ \t]*\r?\n(.*?)\r?\n" +
                   re.escape(chr(96) * 3) + r"[ \t]*\s*\Z",
                   re.DOTALL | re.IGNORECASE)
CUSTODY_STATUS = "HTTP_200_TEXT_CAPTURED_UNVERIFIED"
# Exactly one completed model message is required to produce a candidate.
# A truncated, filtered, tool-directed or missing completion reason is retained
# for private diagnostics but MUST NOT be treated as a valid final answer.
ALLOWED_FINISH_REASONS = {"stop", "length", "content_filter", "tool_calls", "unknown"}


def require_terminal_finish_reason(reason):
    if reason not in ALLOWED_FINISH_REASONS:
        raise VisualGateError("REPLY_FINISH_REASON_INVALID")
    if reason != "stop":
        raise VisualGateError("REPLY_COMPLETION_NOT_FINAL")


def strict_payload(raw):
    """Accept one exact JSON object or one entire JSON-only code fence."""
    if not isinstance(raw, str):
        raise VisualGateError("STRUCTURE_MODEL_NON_TEXT")
    if not 0 < len(raw.encode("utf-8")) <= MAX_RAW_BYTES:
        raise VisualGateError("STRUCTURE_MODEL_REPLY_SIZE_INVALID")
    whole_fence = FENCE.fullmatch(raw)
    body = whole_fence.group(1) if whole_fence else raw
    try:
        value = json.loads(body, object_pairs_hook=no_duplicate_keys,
                           parse_constant=reject_constant)
    except (TypeError, ValueError):
        raise VisualGateError("STRUCTURE_MODEL_JSON_INVALID") from None
    if not isinstance(value, dict):
        raise VisualGateError("STRUCTURE_MODEL_SCHEMA_INVALID")
    return value


def _folder(root):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise VisualGateError("PRIVATE_ROOT_UNSAFE")
    safe = root.resolve(strict=True)
    folder = safe / "semantic_gate"
    if not folder.is_dir() or folder.is_symlink():
        raise VisualGateError("PRIVATE_LEDGER_DIRECTORY_UNSAFE")
    if not folder.resolve(strict=True).is_relative_to(safe):
        raise VisualGateError("PRIVATE_LEDGER_OUTSIDE_ROOT")
    return safe, folder


def _paths(folder, book):
    if book not in PAGES:
        raise VisualGateError("UNKNOWN_BOOK_NOT_ALLOWED")
    marker = folder / (PREFIX + book + ".request.private.json")
    snapshot = folder / (PREFIX + book + ".reply.private.json")
    candidate = folder / (PREFIX + book + ".candidate.private.json")
    return marker, snapshot, candidate


def _marker_matches(marker_path, root, book, digest):
    marker = private_json(marker_path, root)
    if marker is None:
        raise VisualGateError("REQUEST_MARKER_REQUIRED")
    try:
        check_marker(marker, book, digest)
    except AuditError:
        raise VisualGateError("REQUEST_MARKER_IDENTITY_INVALID") from None


def _save_exclusive(path, data):
    # Same-directory O_EXCL, never overwrite a prior paid-attempt receipt.
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_JSON_BYTES:
        raise VisualGateError("PRIVATE_REPLY_ENVELOPE_TOO_LARGE")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)


def capture_reply(root, book, digest, reply, *, finish_reason="unknown"):
    """Call only AFTER provider has returned text and BEFORE JSON parsing."""
    safe, folder = _folder(root)
    marker, path, candidate = _paths(folder, book)
    _marker_matches(marker, safe, book, digest)
    if candidate.exists() or candidate.is_symlink():
        raise VisualGateError("CANDIDATE_ALREADY_EXISTS_NO_OVERWRITE")
    if not isinstance(reply, str):
        raise VisualGateError("STRUCTURE_MODEL_NON_TEXT")
    if type(finish_reason) is not str or finish_reason not in ALLOWED_FINISH_REASONS:
        raise VisualGateError("REPLY_FINISH_REASON_INVALID")
    encoded = reply.encode("utf-8")
    if not 0 < len(encoded) <= MAX_RAW_BYTES:
        raise VisualGateError("STRUCTURE_MODEL_REPLY_SIZE_INVALID")
    envelope = {
        "schema_version": 1,
        "book_id": book,
        "physical_page": PAGES[book][0],
        "source_document_sha256": digest,
        "model": MODEL,
        "status": CUSTODY_STATUS,
        "finish_reason": finish_reason,
        "raw_text_utf8": reply,
        "reply_sha256": hashlib.sha256(encoded).hexdigest(),
        "reply_byte_count": len(encoded),
    }
    _save_exclusive(path, envelope)
    # Do not log the returned path, content, SHA, or book graph facts.
    return path


def _validated_snapshot(root, book, digest):
    safe, folder = _folder(root)
    marker, snapshot_path, candidate_path = _paths(folder, book)
    _marker_matches(marker, safe, book, digest)
    snapshot = private_json(snapshot_path, safe)
    if snapshot is None:
        return None, candidate_path
    required = {
        "schema_version", "book_id", "physical_page",
        "source_document_sha256", "model", "status", "finish_reason", "raw_text_utf8",
        "reply_sha256", "reply_byte_count",
    }
    if not isinstance(snapshot, dict) or set(snapshot) != required:
        raise VisualGateError("REPLY_CUSTODY_SCHEMA_INVALID")
    reply = snapshot["raw_text_utf8"]
    if not isinstance(reply, str):
        raise VisualGateError("REPLY_CUSTODY_NON_TEXT")
    raw = reply.encode("utf-8")
    if (type(snapshot["schema_version"]) is not int or
            snapshot["schema_version"] != 1 or
            snapshot["book_id"] != book or
            type(snapshot["physical_page"]) is not int or
            snapshot["physical_page"] != PAGES[book][0] or
            snapshot["source_document_sha256"] != digest or
            snapshot["model"] != MODEL or
            snapshot["status"] != CUSTODY_STATUS or
            type(snapshot["finish_reason"]) is not str or
            snapshot["finish_reason"] not in ALLOWED_FINISH_REASONS or
            type(snapshot["reply_byte_count"]) is not int or
            snapshot["reply_byte_count"] != len(raw) or
            snapshot["reply_sha256"] != hashlib.sha256(raw).hexdigest()):
        raise VisualGateError("REPLY_CUSTODY_INTEGRITY_INVALID")
    return (reply, snapshot["finish_reason"]), candidate_path


def offline_recover(root, manifest, book, *, write_candidate=False):
    """Offline-only. Default inspection does not write a candidate file."""
    if book not in PAGES:
        raise VisualGateError("UNKNOWN_BOOK_NOT_ALLOWED")
    digest = identities(manifest)[book]
    saved, output = _validated_snapshot(root, book, digest)
    if saved is None:
        if write_candidate:
            raise VisualGateError("NO_CAPTURED_REPLY_NO_RECOVERY")
        return "NO_CAPTURED_REPLY_LEGACY_ATTEMPT"
    reply, finish_reason = saved
    require_terminal_finish_reason(finish_reason)
    # Late import avoids cycles: online proposal imports capture_reply.
    from ebook_private_visual_graph_proposal import parse_candidate
    candidate = parse_candidate(reply, book, {"sha256": digest})
    if output.exists() or output.is_symlink():
        raise VisualGateError("CANDIDATE_ALREADY_EXISTS_NO_OVERWRITE")
    if write_candidate:
        _save_exclusive(output, candidate)
        return "PRIVATE_CANDIDATE_RECOVERED_UNCERTIFIED"
    return "RECOVERABLE_OFFLINE_NO_WRITE"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--book", choices=sorted(PAGES), required=True)
    parser.add_argument("--write-candidate", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.private_root)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    status = offline_recover(root, manifest, args.book,
                             write_candidate=args.write_candidate)
    print("ACS_PRIVATE_GRAPH_REPLY=" + args.book + "|STATUS=" + status)
    print("ACS_PRIVATE_GRAPH_REPLY_PROVIDER_CALLS=0")
    print("ACS_PRIVATE_GRAPH_REPLY_CERTIFIED_F1=UNVERIFIED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, AuditError, OSError, ValueError) as exc:
        code = exc.code if isinstance(exc, (VisualGateError, AuditError)) else type(exc).__name__
        print("ACS_PRIVATE_GRAPH_REPLY_REJECTED=" + code)
        sys.exit(2)
