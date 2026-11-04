#!/usr/bin/env python3
"""Private-only diagram structural agreement gate. Never confers human certification."""
import argparse
import json
from pathlib import Path
import re
import sys

ROLE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
BOOK = re.compile(r"^(?:B[0-9]{2}|synthetic[a-z0-9_]{1,40})$")
SHA = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN = {"humanverified", "graphverified", "isgold", "goldcertified"}


class Rejected(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def token(value):
    if not isinstance(value, str) or not ROLE.fullmatch(value):
        raise Rejected("INVALID_ROLE_TOKEN")
    return value


def keys(value, allowed):
    if not isinstance(value, dict) or set(value) - allowed:
        raise Rejected("SCHEMA_KEYS_UNEXPECTED")


def protect(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).replace("_", "").lower() in FORBIDDEN:
                raise Rejected("UNAUTHORIZED_VERIFICATION_CLAIM")
            protect(item)
    elif isinstance(value, list):
        for item in value:
            protect(item)


def rows(doc, name, maximum):
    data = doc.get(name, [])
    if not isinstance(data, list) or len(data) > maximum:
        raise Rejected("INVALID_COLLECTION_" + name.upper())
    return data


def facts(doc, reference):
    protect(doc)
    allowed = ({"schema_version", "page", "objects", "relations", "axes", "trends", "evidence"}
               if reference else {"schema_version", "page", "objects", "relations", "axes",
                                  "trends", "engine", "abstained"})
    keys(doc, allowed)
    if doc.get("schema_version") != 1:
        raise Rejected("SCHEMA_VERSION_MISMATCH")
    page = doc.get("page")
    keys(page, {"book_id", "physical_page", "source_document_sha256"})
    book, number, digest = page.get("book_id"), page.get("physical_page"), page.get("source_document_sha256")
    if not isinstance(book, str) or not BOOK.fullmatch(book):
        raise Rejected("INVALID_BOOK_ID")
    if type(number) is not int or not 1 <= number <= 100000 or not isinstance(digest, str) or not SHA.fullmatch(digest):
        raise Rejected("INVALID_PAGE_PROVENANCE")
    if reference:
        evidence = doc.get("evidence")
        keys(evidence, {"tier", "reviewer"})
        if evidence.get("tier") not in ("L2_AI_VISUAL_PROVISIONAL", "L3_SYNTHETIC_SELF_AUTHORED"):
            raise Rejected("REFERENCE_AUTHORITY_UNSUPPORTED")
        token(evidence.get("reviewer"))
    else:
        engine = doc.get("engine")
        keys(engine, {"name", "version"})
        token(engine.get("name"))
        version = engine.get("version")
        if not isinstance(version, str) or not version.strip() or len(version) > 100:
            raise Rejected("INVALID_ENGINE_VERSION")
        if type(doc.get("abstained", False)) is not bool:
            raise Rejected("INVALID_ABSTENTION")
    atoms, roles = set(), {}
    for node in rows(doc, "objects", 128):
        keys(node, {"role", "kind", "parent_role"})
        role, kind = token(node.get("role")), token(node.get("kind"))
        if role in roles:
            raise Rejected("DUPLICATE_OBJECT_ROLE")
        roles[role] = kind
        atoms.add(("object", role, kind))
    for node in doc.get("objects", []):
        parent = node.get("parent_role")
        if parent is not None:
            token(parent)
            if parent not in roles or parent == node["role"]:
                raise Rejected("INVALID_PARENT_RELATION")
            atoms.add(("contains", parent, node["role"]))
    for edge in rows(doc, "relations", 512):
        keys(edge, {"source_role", "target_role", "relation", "directed"})
        src, dst, kind = token(edge.get("source_role")), token(edge.get("target_role")), token(edge.get("relation"))
        directed = edge.get("directed")
        if src not in roles or dst not in roles or type(directed) is not bool:
            raise Rejected("INVALID_EDGE_ENDPOINT_OR_DIRECTION")
        if not directed and dst < src:
            src, dst = dst, src
        atom = ("edge", src, kind, dst, directed)
        if atom in atoms:
            raise Rejected("DUPLICATE_RELATION")
        atoms.add(atom)
    for axis in rows(doc, "axes", 128):
        keys(axis, {"chart_role", "dimension", "meaning"})
        chart, dimension, meaning = token(axis.get("chart_role")), axis.get("dimension"), token(axis.get("meaning"))
        if roles.get(chart) != "chart" or dimension not in ("x", "y"):
            raise Rejected("INVALID_CHART_AXIS")
        atom = ("axis", chart, dimension, meaning)
        if atom in atoms:
            raise Rejected("DUPLICATE_CHART_AXIS")
        atoms.add(atom)
    for trend in rows(doc, "trends", 128):
        keys(trend, {"chart_role", "shape"})
        chart, shape = token(trend.get("chart_role")), token(trend.get("shape"))
        if roles.get(chart) != "chart":
            raise Rejected("INVALID_TREND_CHART")
        atom = ("trend", chart, shape)
        if atom in atoms:
            raise Rejected("DUPLICATE_CHART_TREND")
        atoms.add(atom)
    return (book, number, digest), atoms, doc


def evaluate(reference, candidate):
    identity, expected, ref = facts(reference, True)
    actual_identity, actual, pred = facts(candidate, False)
    if identity != actual_identity:
        raise Rejected("SOURCE_PAGE_IDENTITY_MISMATCH")
    if not expected:
        raise Rejected("EMPTY_REFERENCE_STRUCTURE")
    if pred.get("abstained", False) and actual:
        raise Rejected("ABSTENTION_WITH_STRUCTURE")
    matched, missing, extra = expected & actual, expected - actual, actual - expected
    reversed_edges = sum(1 for e in missing if e[0] == "edge" and e[4] is True and
                         ("edge", e[3], e[2], e[1], True) in extra)
    return {
        "schema_version": 1,
        "status": "ABSTAINED_NO_STRUCTURAL_PREDICTION" if pred.get("abstained", False) or not actual
                  else "PROVISIONAL_AGREEMENT_ONLY",
        "evidence_tier": ref["evidence"]["tier"],
        "certified_graph_accuracy": None, "certified_graph_f1": None,
        "human_verified": False, "graph_verified": False,
        "counts": {
            "reference_facts": len(expected), "candidate_facts": len(actual),
            "matched": len(matched), "missing": len(missing), "unexpected": len(extra),
            "reversed_directed_edges": reversed_edges,
            "matched_edges": sum(e[0] == "edge" for e in matched),
            "missing_edges": sum(e[0] == "edge" for e in missing),
            "unexpected_edges": sum(e[0] == "edge" for e in extra),
        },
        "limits": "Provisional agreement only, not independent gold accuracy; no source text exported",
    }


def load_private(path, root):
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise Rejected("PRIVATE_PATH_REQUIRED")
    if not resolved.is_file() or resolved.stat().st_size > 262144:
        raise Rejected("INVALID_INPUT_FILE")
    try:
        return json.loads(resolved.read_text(encoding="utf-8"))
    except (UnicodeError, ValueError):
        raise Rejected("INVALID_INPUT_JSON") from None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    for name in ("private-root", "reference", "prediction", "output"):
        ap.add_argument("--" + name, required=True)
    args = ap.parse_args(argv)
    root = Path(args.private_root).resolve(strict=True)
    if not root.is_dir():
        raise Rejected("PRIVATE_ROOT_MISSING")
    report = evaluate(load_private(args.reference, root), load_private(args.prediction, root))
    out = Path(args.output).resolve()
    if not out.is_relative_to(root) or out.suffix.lower() != ".json":
        raise Rejected("PRIVATE_REPORT_PATH_REQUIRED")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(report, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out)
    print("ACS_STRUCTURE_AUDIT_STATUS=" + report["status"])
    for key, value in report["counts"].items():
        print("ACS_STRUCTURE_AUDIT_" + key.upper() + "=" + str(value))
    print("ACS_STRUCTURE_AUDIT_CERTIFIED_F1=UNAVAILABLE")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Rejected as exc:
        print("ACS_STRUCTURE_AUDIT_REJECTED=" + exc.code)
        sys.exit(2)
