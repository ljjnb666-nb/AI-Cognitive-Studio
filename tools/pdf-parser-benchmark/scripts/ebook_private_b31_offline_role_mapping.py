#!/usr/bin/env python3
"""Offline B31 node-ID anonymization preserving original graph connectivity.

This tool never calls GLM, never modifies the paid request or reply, and never
reveals node labels. A normalized graph is PROVISIONAL, not independent gold.
"""
import argparse
import copy
import json
from pathlib import Path
import sys

from ebook_private_graph_receipt_audit import AuditError, identities
from ebook_private_graph_reply_recovery import (
    _save_exclusive, _validated_snapshot, strict_payload,
    require_terminal_finish_reason, VisualGateError,
)
from ebook_private_visual_graph_proposal import parse_candidate
from ebook_semantic_structure_gate import ROLE


def _identity_role(raw):
    if type(raw) is not str or not raw or len(raw) > 128:
        raise VisualGateError("B31_NODE_ID_INVALID")
    if ROLE.fullmatch(raw):
        return True
    if not any(ord(ch) > 127 for ch in raw):
        raise VisualGateError("B31_UNSUPPORTED_ASCII_NODE_ID")
    if not raw.strip():
        raise VisualGateError("B31_EMPTY_UNICODE_NODE_ID")
    return False


def normalize(payload):
    """Only node identities and exact references may change, never edge direction."""
    if not isinstance(payload, dict) or set(payload) != {
        "objects", "relations", "axes", "trends", "abstained"
    }:
        raise VisualGateError("B31_PROPOSAL_SCHEMA_INVALID")
    objs = payload.get("objects")
    if not isinstance(objs, list) or not 1 <= len(objs) <= 128:
        raise VisualGateError("B31_NODES_MISSING_OR_EXCESSIVE")
    result = copy.deepcopy(payload)
    roles = {}
    mapped = 0
    for i, node in enumerate(result["objects"], 1):
        if not isinstance(node, dict) or "role" not in node:
            raise VisualGateError("B31_OBJECT_ROLE_MISSING")
        raw = node["role"]
        valid = _identity_role(raw)
        if raw in roles:
            raise VisualGateError("B31_DUPLICATE_OR_AMBIGUOUS_NODE_ID")
        new_role = raw if valid else "anon_node_%03d" % i
        roles[raw] = new_role
        mapped += int(not valid)
    if len(set(roles.values())) != len(roles):
        raise VisualGateError("B31_GENERATED_NODE_ID_COLLISION")
    for node in result["objects"]:
        node["role"] = roles[node["role"]]

    def resolve(raw):
        if type(raw) is not str or raw not in roles:
            raise VisualGateError("B31_UNRESOLVED_NODE_REFERENCE")
        return roles[raw]

    for node in result["objects"]:
        if node.get("parent_role") is not None:
            node["parent_role"] = resolve(node["parent_role"])
    for edge in result.get("relations", []):
        if not isinstance(edge, dict):
            raise VisualGateError("B31_RELATION_SHAPE_INVALID")
        for field in ("source_role", "target_role"):
            edge[field] = resolve(edge.get(field))
    for axis in result.get("axes", []):
        if not isinstance(axis, dict):
            raise VisualGateError("B31_AXIS_SHAPE_INVALID")
        axis["chart_role"] = resolve(axis.get("chart_role"))
    for trend in result.get("trends", []):
        if not isinstance(trend, dict):
            raise VisualGateError("B31_TREND_SHAPE_INVALID")
        trend["chart_role"] = resolve(trend.get("chart_role"))
        if trend.get("series_role") is not None:
            trend["series_role"] = resolve(trend["series_role"])
    return result, mapped


def offline_candidate(root, manifest, *, write=False):
    sha = identities(manifest)["B31"]
    saved, dest = _validated_snapshot(root, "B31", sha)
    if saved is None:
        raise VisualGateError("B31_ORIGINAL_REPLY_NOT_CAPTURED")
    raw, finish = saved
    require_terminal_finish_reason(finish)
    if dest.exists() or dest.is_symlink():
        raise VisualGateError("B31_CANDIDATE_ALREADY_EXISTS_NO_OVERWRITE")
    proposal = strict_payload(raw)
    normalized, mapped = normalize(proposal)
    candidate = parse_candidate(json.dumps(normalized, separators=(",", ":")),
                                "B31", {"sha256": sha})
    if candidate["abstained"]:
        raise VisualGateError("B31_ABSTAINED_NOT_A_GRAPH_CANDIDATE")
    if not candidate["objects"] or not any(
            relation["directed"] for relation in candidate["relations"]):
        raise VisualGateError("B31_TOPOLOGY_REQUIRED")
    # parse_candidate -> facts() has now checked exact role referential
    # integrity, duplicate edges, direction type and general graph validity.
    if len(candidate["objects"]) != len(proposal["objects"]) or len(
            candidate["relations"]) != len(proposal["relations"]):
        raise VisualGateError("B31_GRAPH_CARDINALITY_CHANGED")
    result = {
        "renamed_nodes": mapped,
        "objects": len(candidate["objects"]),
        "relations": len(candidate["relations"]),
        "directed_edges": sum(e["directed"] for e in candidate["relations"]),
        "status": "PROVISIONAL_GRAPH_NOT_INDEPENDENT_GOLD",
    }
    if write:
        _save_exclusive(dest, candidate)
        result["status"] = "PRIVATE_CANDIDATE_WRITTEN_PROVISIONAL"
    return result


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-root", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--write-candidate", action="store_true",
                    help="Only when explicitly requested, create one private derived file")
    args = ap.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    report = offline_candidate(Path(args.private_root), manifest,
                               write=args.write_candidate)
    print("ACS_B31_OFFLINE_MAPPING_STATUS=" + report["status"])
    for key in ("renamed_nodes", "objects", "relations", "directed_edges"):
        print("ACS_B31_OFFLINE_MAPPING_" + key.upper() + "=" + str(report[key]))
    print("ACS_B31_NEW_PROVIDER_CALLS=0")
    print("ACS_B31_INDEPENDENT_GRAPH_F1=UNVERIFIED")
    print("ACS_B31_HUMAN_GOLD=FALSE")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VisualGateError, AuditError, OSError, ValueError, TypeError) as err:
        code = err.code if isinstance(err, (VisualGateError, AuditError)) else type(err).__name__
        print("ACS_B31_OFFLINE_MAPPING_REJECTED=" + code)
        sys.exit(2)
