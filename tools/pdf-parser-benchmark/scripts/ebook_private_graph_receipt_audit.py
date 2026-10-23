#!/usr/bin/env python3
"""Read-only, no-network audit of the private B15/B31 graph proposal ledger.

No provider calls, no retry, no mutation and no raw book content in stdout.
A request marker proves at most a local attempt boundary, NOT provider billing.
"""
import argparse
import json
from pathlib import Path
import re
import sys

from ebook_semantic_structure_gate import Rejected, facts

TARGETS = {"B15": 109, "B31": 126}
SHA = re.compile(r"[a-f0-9]{64}\Z")
PREFIX = "visual_graph_proposal_"
MARKER_STATUS = "PAYMENT_OUTCOME_UNKNOWN_UNTIL_CANDIDATE_EXISTS"
MAX_JSON_BYTES = 65536


class AuditError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def no_duplicate_keys(pairs):
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise AuditError("DUPLICATE_JSON_KEY")
        obj[k] = v
    return obj


def reject_constant(_):
    raise AuditError("NONFINITE_JSON_VALUE")


def private_json(path, root):
    if not path.exists() and not path.is_symlink():
        return None
    if path.is_symlink() or not path.is_file():
        raise AuditError("PRIVATE_RECORD_UNSAFE")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise AuditError("PRIVATE_RECORD_OUTSIDE_ROOT")
    if not 0 < path.stat().st_size <= MAX_JSON_BYTES:
        raise AuditError("PRIVATE_RECORD_SIZE_INVALID")
    try:
        return json.loads(path.read_text(encoding="utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (UnicodeError, ValueError, OSError) as exc:
        if isinstance(exc, AuditError):
            raise
        raise AuditError("PRIVATE_RECORD_JSON_INVALID") from None


def identities(manifest):
    if not isinstance(manifest, dict) or not isinstance(manifest.get("sources"), list):
        raise AuditError("MANIFEST_SCHEMA_INVALID")
    source = {}
    for row in manifest["sources"]:
        if not isinstance(row, dict) or row.get("id") not in TARGETS:
            continue
        book = row["id"]
        if (book in source or not isinstance(row.get("sha256"), str) or
                not SHA.fullmatch(row["sha256"]) or
                type(row.get("size")) is not int or row["size"] <= 0 or
                type(row.get("total_physical_pages")) is not int or
                row["total_physical_pages"] < TARGETS[book]):
            raise AuditError("MANIFEST_SOURCE_INVALID")
        source[book] = row["sha256"]
    if set(source) != set(TARGETS):
        raise AuditError("MANIFEST_TARGET_MISSING")
    return source


def check_marker(record, book, sha):
    if (not isinstance(record, dict) or set(record) != {
        "status", "source_document_sha256", "physical_page", "model", "provider"
    }):
        raise AuditError("REQUEST_MARKER_SCHEMA_INVALID")
    if (record["status"] != MARKER_STATUS or
            record["source_document_sha256"] != sha or
            type(record["physical_page"]) is not int or
            record["physical_page"] != TARGETS[book] or
            record["model"] != "glm-4.6v" or record["provider"] != "GLM"):
        raise AuditError("REQUEST_MARKER_IDENTITY_INVALID")


def check_candidate(record, book, sha):
    if not isinstance(record, dict):
        raise AuditError("CANDIDATE_SCHEMA_INVALID")
    try:
        page_id, atoms, _ = facts(record, False)
    except Rejected as exc:
        raise AuditError("CANDIDATE_" + exc.code) from None
    if page_id != (book, TARGETS[book], sha):
        raise AuditError("CANDIDATE_PAGE_IDENTITY_INVALID")
    if record.get("engine") != {
        "name": "glm_visual_proposal", "version": "glm-4.6v"
    }:
        raise AuditError("CANDIDATE_ENGINE_INVALID")
    if record.get("abstained", False) and atoms:
        raise AuditError("CANDIDATE_ABSTENTION_WITH_FACTS")
    if record.get("abstained", False):
        return "PRIVATE_ABSTENTION_UNCERTIFIED"
    if not atoms:
        return "PRIVATE_EMPTY_CANDIDATE_UNVERIFIED"
    return "PRIVATE_CANDIDATE_PRESENT_UNCERTIFIED"


def audit(root, manifest):
    # Scope is only the already-chosen private D: directory; this tool
    # deliberately does not enumerate source files, create folders or write.
    if not root.is_dir() or root.is_symlink():
        raise AuditError("PRIVATE_ROOT_INVALID")
    safe_root = root.resolve(strict=True)
    folder = safe_root / "semantic_gate"
    if folder.is_symlink():
        raise AuditError("PRIVATE_LEDGER_DIRECTORY_UNSAFE")
    if folder.exists() and not folder.is_dir():
        raise AuditError("PRIVATE_LEDGER_DIRECTORY_INVALID")
    sources = identities(manifest)
    statuses = {}
    for book in sorted(TARGETS):
        marker = private_json(folder / (PREFIX + book + ".request.private.json"), safe_root)
        candidate = private_json(folder / (PREFIX + book + ".candidate.private.json"), safe_root)
        if marker is None and candidate is None:
            statuses[book] = "NOT_STARTED"
        elif marker is None:
            raise AuditError("ORPHAN_CANDIDATE_WITHOUT_REQUEST_MARKER")
        else:
            check_marker(marker, book, sources[book])
            statuses[book] = ("QUARANTINED_PAID_OUTCOME_UNKNOWN"
                              if candidate is None else
                              check_candidate(candidate, book, sources[book]))
    return statuses


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args(argv)
    root = Path(args.private_root)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    statuses = audit(root, manifest)
    for book, status in statuses.items():
        print("ACS_GRAPH_RECEIPT=" + book + "|STATUS=" + status, flush=True)
    print("ACS_GRAPH_RECEIPT_READ_ONLY=TRUE", flush=True)
    print("ACS_GRAPH_PAID_BILLING=UNVERIFIED", flush=True)
    print("ACS_GRAPH_SEMANTICS=UNVERIFIED", flush=True)
    print("ACS_GRAPH_NEW_PROVIDER_CALLS=0", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AuditError, OSError, ValueError) as exc:
        print("ACS_GRAPH_RECEIPT_AUDIT_REJECTED=" +
              (exc.code if isinstance(exc, AuditError) else type(exc).__name__))
        sys.exit(2)
