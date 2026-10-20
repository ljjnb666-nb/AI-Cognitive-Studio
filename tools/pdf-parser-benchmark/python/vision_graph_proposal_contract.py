"""Validate PRIVATE vision-model graph suggestions against SHA-pinned region crops.

Only PROPOSED_UNVERIFIED is accepted. This does not perform OCR/vision inference,
certify arrow directions, or transform machine suggestions into human ground truth.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path


class SuggestionBlocked(ValueError):
    pass


def finite_number(v):
    return type(v) in (int, float) and math.isfinite(v)


def rect_inside(box, width, height) -> bool:
    if (not isinstance(box, list) or len(box) != 4
            or not all(finite_number(x) for x in box)):
        return False
    x,y,w,h=box
    return x>=0 and y>=0 and w>0 and h>0 and x+w<=width and y+h<=height


def point_inside(point,width,height) -> bool:
    return (isinstance(point,list) and len(point)==2
            and all(finite_number(x) for x in point)
            and 0<=point[0]<width and 0<=point[1]<height)


def validate_candidate(payload: dict, provenance: dict) -> dict:
    """Validate proposed labels/relations; return evidence-bound page coordinates.

    Every proposed edge must cite the very same PNG crop as its endpoints and
    include a pixel-level tip and shaft witness. These are NOT proof of an arrow.
    """
    if not isinstance(payload,dict) or not isinstance(provenance,dict):
        raise SuggestionBlocked("SCHEMA_INVALID")
    if (payload.get("schemaVersion")!="acs-vision-graph-proposal-v1"
            or payload.get("graphStatus")!="PROPOSED_UNVERIFIED"
            or payload.get("reviewStatus")!="NOT_REVIEWED"
            or payload.get("humanVerified") is not False
            or payload.get("coordinateSpace")!="REGION_CROP_TOP_LEFT_PIXELS"):
        raise SuggestionBlocked("UNVERIFIED_STATUS_REQUIRED")
    if (provenance.get("schemaVersion")!="acs-pdf-private-region-evidence-v1"
            or provenance.get("allRegionsAreUnverified") is not True
            or provenance.get("noSemanticGraphClaims") is not True):
        raise SuggestionBlocked("SOURCE_REGION_MANIFEST_NOT_TRUSTED")
    if payload.get("fixtureId") != provenance.get("fixtureId"):
        raise SuggestionBlocked("SOURCE_FIXTURE_MISMATCH")
    region_id = payload.get("regionId")
    candidates=[]
    for page in provenance.get("pages",[]):
        for region in page.get("regions",[]):
            if region.get("regionId")==region_id:
                candidates.append((page,region))
    if len(candidates)!=1:
        raise SuggestionBlocked("SOURCE_REGION_NOT_UNIQUE")
    page,region=candidates[0]
    digest=payload.get("sourceCropSha256")
    if (not isinstance(digest,str) or not re.fullmatch(r"[0-9a-f]{64}",digest)
            or digest!=region.get("cropSha256")):
        raise SuggestionBlocked("CROP_SHA_MISMATCH")
    if (region.get("proposalStatus")!="UNVERIFIED_REGION_SUGGESTION"
            or region.get("nodes") is not None
            or region.get("directedEdges") is not None
            or region.get("timingRelations") is not None):
        raise SuggestionBlocked("REGION_PRETENDS_VERIFIED")
    x0,y0,width,height=region["bboxPixels"]
    if not all(type(v) is int for v in (x0,y0,width,height)) or width<20 or height<20:
        raise SuggestionBlocked("SOURCE_REGION_BOUNDS_INVALID")
    nodes=payload.get("nodes")
    edges=payload.get("edges")
    if not isinstance(nodes,list) or not isinstance(edges,list) or len(nodes)>80 or len(edges)>120:
        raise SuggestionBlocked("GRAPH_BUDGET_EXCEEDED")
    mapped_nodes=[]
    seen=set()
    for node in nodes:
        if not isinstance(node,dict):
            raise SuggestionBlocked("NODE_INVALID")
        nid=node.get("id")
        label=node.get("label")
        confidence=node.get("proposalConfidence")
        if (not isinstance(nid,str) or not re.fullmatch(r"n[0-9]{1,3}",nid)
                or nid in seen or not isinstance(label,str) or len(label)>160
                or any(ord(c)<32 for c in label)
                or not finite_number(confidence) or not 0<=confidence<=1
                or node.get("reviewStatus")!="NOT_REVIEWED"):
            raise SuggestionBlocked("NODE_NOT_SAFE")
        box=node.get("bboxCropPixels")
        if not rect_inside(box,width,height):
            raise SuggestionBlocked("NODE_BOUNDS_INVALID")
        seen.add(nid)
        mapped_nodes.append({"id":nid,"bboxPagePixels":[x0+box[0],y0+box[1],box[2],box[3]],
                             "sourcePhysicalPage1Based":page["sourcePhysicalPage1Based"],
                             "claim":"MACHINE_SUGGESTION_NOT_VERIFIED"})
    mapped_edges=[]
    edge_ids=set()
    for edge in edges:
        if not isinstance(edge,dict):
            raise SuggestionBlocked("EDGE_INVALID")
        eid=edge.get("id")
        a,b=edge.get("fromNodeId"),edge.get("toNodeId")
        if (not isinstance(eid,str) or not re.fullmatch(r"e[0-9]{1,3}",eid)
                or eid in edge_ids or a not in seen or b not in seen or a==b):
            raise SuggestionBlocked("EDGE_ENDPOINTS_INVALID")
        direction=edge.get("direction")
        if direction not in ("UNKNOWN","FROM_TO_SUGGESTED","TO_FROM_SUGGESTED"):
            raise SuggestionBlocked("ARROW_DIRECTION_NOT_SUPPORTED")
        tip=edge.get("arrowTipCropPixels")
        shaft=edge.get("shaftCropPixels")
        confidence=edge.get("proposalConfidence")
        if (not point_inside(tip,width,height)
                or not isinstance(shaft,list) or len(shaft)!=2
                or not all(point_inside(p,width,height) for p in shaft)
                or not finite_number(confidence) or not 0<=confidence<=1
                or edge.get("reviewStatus")!="NOT_REVIEWED"):
            raise SuggestionBlocked("EDGE_EVIDENCE_MISSING")
        edge_ids.add(eid)
        mapped_edges.append({
            "id":eid,"arrowTipPagePixels":[x0+tip[0],y0+tip[1]],
            "shaftPagePixels":[[x0+p[0],y0+p[1]] for p in shaft],
            "sourcePhysicalPage1Based":page["sourcePhysicalPage1Based"],
            "claim":"GEOMETRIC_WITNESS_AND_RELATION_UNVERIFIED",
        })
    return {
        "regionId":region_id,
        "sourcePhysicalPage1Based":page["sourcePhysicalPage1Based"],
        "sourceCropSha256":digest,
        "mappedNodes":mapped_nodes,
        "mappedEdges":mapped_edges,
        "graphVerified":False,
        "needsIndependentHumanReview":True,
    }


def empty_template(provenance: dict) -> list[dict]:
    """Issue empty, binding-safe suggestion envelopes, no fabricated graph."""
    output=[]
    for page in provenance.get("pages",[]):
        for region in page.get("regions",[]):
            output.append({
                "schemaVersion":"acs-vision-graph-proposal-v1",
                "fixtureId":provenance["fixtureId"],
                "regionId":region["regionId"],
                "sourceCropSha256":region["cropSha256"],
                "coordinateSpace":"REGION_CROP_TOP_LEFT_PIXELS",
                "graphStatus":"PROPOSED_UNVERIFIED",
                "reviewStatus":"NOT_REVIEWED",
                "humanVerified":False,
                "nodes":[],"edges":[],
            })
    return output
