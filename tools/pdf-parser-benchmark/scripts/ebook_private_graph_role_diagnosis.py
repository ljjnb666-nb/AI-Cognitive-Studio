#!/usr/bin/env python3
"""Privacy-preserving diagnostic for an already captured GLM B31 reply.

No provider calls, no file mutations and no returned raw text, role value,
book content, source SHA or API credential in any stdout/stderr.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

from ebook_private_graph_receipt_audit import AuditError, identities
from ebook_private_graph_reply_recovery import (
    _validated_snapshot, strict_payload, VisualGateError,
)
from ebook_semantic_structure_gate import ROLE


FIELDS = {
    "objects": (("role", "object_role"), ("kind", "object_kind"),
                ("parent_role", "object_parent_role")),
    "relations": (("source_role", "edge_source_role"),
                  ("target_role", "edge_target_role"),
                  ("relation", "edge_relation")),
    "axes": (("chart_role", "axis_chart_role"),
             ("meaning", "axis_meaning")),
    "trends": (("chart_role", "trend_chart_role"),
               ("series_role", "trend_series_role"),
               ("shape", "trend_shape")),
}
LIMITS = {"objects": 128, "relations": 512, "axes": 128, "trends": 128}
MAX_DIAGNOSTIC_TOKENS = 1000


def reason(value):
    """Classify without ever serializing the original invalid value."""
    if type(value) is not str:
        return "non_string"
    if not value:
        return "empty"
    if len(value) > 64:
        return "too_long"
    if value != value.strip():
        return "surrounding_whitespace"
    if any(ord(ch) > 127 for ch in value):
        return "non_ascii"
    if any("A" <= ch <= "Z" for ch in value):
        return "uppercase"
    if not ("a" <= value[0] <= "z"):
        return "invalid_prefix"
    return "punctuation_or_spacing"


def summarize(payload):
    if not isinstance(payload, dict) or set(payload) != {
            "objects", "relations", "axes", "trends", "abstained"}:
        raise VisualGateError("DIAGNOSIS_SCHEMA_MISMATCH")
    violations = Counter()
    classes = Counter()
    inspected = 0
    for collection, columns in FIELDS.items():
        rows = payload.get(collection)
        if not isinstance(rows, list) or len(rows) > LIMITS[collection]:
            raise VisualGateError("DIAGNOSIS_COLLECTION_INVALID")
        for row in rows:
            if not isinstance(row, dict):
                raise VisualGateError("DIAGNOSIS_ROW_INVALID")
            for source_key, public_field in columns:
                if source_key not in row or row[source_key] is None:
                    continue
                value = row[source_key]
                inspected += 1
                if inspected > MAX_DIAGNOSTIC_TOKENS:
                    raise VisualGateError("DIAGNOSIS_TOKEN_BUDGET_EXCEEDED")
                if type(value) is str and ROLE.fullmatch(value):
                    continue
                violations[public_field] += 1
                classes[reason(value)] += 1
    return {
        "invalid_fields": dict(sorted(violations.items())),
        "invalid_types": dict(sorted(classes.items())),
        "tokens_checked": inspected,
        "invalid_token_count": sum(violations.values()),
        "candidate_certified": False,
        "provider_requests": 0,
    }


def diagnose(root, manifest, *, book="B31"):
    if book != "B31":
        raise VisualGateError("B31_ONLY_DIAGNOSIS")
    digest = identities(manifest)[book]
    saved, output = _validated_snapshot(root, book, digest)
    if saved is None:
        raise VisualGateError("B31_REPLY_SNAPSHOT_MISSING")
    reply, finish_reason = saved
    # Snapshot SHA, page and model were checked above; only 'stop' was eligible
    # for the original parsing step. Do not publish its content.
    if finish_reason != "stop":
        raise VisualGateError("B31_REPLY_NONTERMINAL_NOT_DIAGNOSABLE")
    payload = strict_payload(reply)
    report = summarize(payload)
    if output.exists() or output.is_symlink():
        raise VisualGateError("B31_CANDIDATE_EXISTS_DIAGNOSIS_NOT_NEEDED")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-root", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    report = diagnose(Path(args.private_root), manifest)
    # Publicly fixed enumerations/counts only, never raw nodes, role values,
    # source SHA, private directories or complete model response.
    print("ACS_B31_PRIVATE_ROLE_DIAGNOSIS=PASS_READONLY")
    print("ACS_B31_PRIVATE_ROLE_INVALID_TOKEN_COUNT=" + str(report["invalid_token_count"]))
    for field, count in report["invalid_fields"].items():
        print("ACS_B31_INVALID_FIELD=" + field + "|COUNT=" + str(count))
    for cls, count in report["invalid_types"].items():
        print("ACS_B31_INVALID_CLASS=" + cls + "|COUNT=" + str(count))
    print("ACS_B31_PROVIDER_CALLS=0")
    print("ACS_B31_CANDIDATE=UNVERIFIED_NOT_WRITTEN")
    print("ACS_B31_INDEPENDENT_GOLD=NONE")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, AuditError, OSError, ValueError) as error:
        code = error.code if isinstance(error, (VisualGateError, AuditError)) else type(error).__name__
        print("ACS_B31_ROLE_DIAGNOSIS_REJECTED=" + code)
        sys.exit(2)
