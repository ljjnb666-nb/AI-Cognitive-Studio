#!/usr/bin/env python3
"""Continue only B15's NEVER-STARTED source tile. Do not retry uncertain B03.

The existing V14 receipt must be EXACTLY 2 completed, 1 ambiguous charge
fence (B03 R2C2) and 1 not started (B15 R3C2). Strict fail closed; one call
maximum, private source image and reply never enter CI/PR output.
"""
import argparse
import json
import os
from pathlib import Path
import sys

import ebook_b03_b15_blind_visual_triage_v14 as prior
from ebook_private_glm_visual_reference import (
    MODEL, request_visual, VisualGateError, MAX_IMAGE_BYTES,
)

FINAL=("B15",109,"R3C2")
MISSING=("B03",67,"R2C2")
DONE=(("B03",67,"R1C2"),("B03",67,"R1C3"))
ALLOWED_PUBLIC_ERRORS=frozenset((
    "VISION_TRANSPORT_UNKNOWN_OUTCOME",
    "VISION_PROVIDER_NON_200",
    "VISION_PROVIDER_RESPONSE_INVALID",
    "VISION_PROVIDER_NON_TEXT_REPLY",
    "V14_PROVIDER_REPLY_INVALID",
    "V14_PROVIDER_JSON_INVALID",
    "V14_PROVIDER_SCHEMA_INVALID",
    "V15_FINAL_TILE_OUTCOME_UNKNOWN",
))


def status_path(dest,key,kind):
    book,page,region=key
    return dest/(f"{book}_p{page:04d}_{region}.{kind}.private.json")


def contract(root):
    folder,tiles=prior.source_contract(root)
    state=prior.private_inventory(root) # checks all v13 SHA and present candidates
    if state!={"completed":2,"unknown":1,"not_started":1}:
        raise VisualGateError("V15_PRIOR_EXACT_STATE_CHANGED")
    dest=folder/prior.SUBDIR
    for target in DONE:
        if not (status_path(dest,target,"attempt").is_file() and
                status_path(dest,target,"candidate").is_file()):
            raise VisualGateError("V15_PRIOR_COMPLETE_TARGETS_CHANGED")
    if not status_path(dest,MISSING,"attempt").is_file() or \
            status_path(dest,MISSING,"candidate").exists():
        raise VisualGateError("V15_AMBIGUOUS_CHARGE_FENCE_CHANGED")
    journal=status_path(dest,FINAL,"attempt")
    candidate=status_path(dest,FINAL,"candidate")
    if (journal.exists() or candidate.exists() or journal.is_symlink()
            or candidate.is_symlink()):
        raise VisualGateError("V15_FINAL_TILE_OUTCOME_UNKNOWN")
    image,image_sha=tiles[FINAL]
    if not 0<len(image)<=MAX_IMAGE_BYTES:
        raise VisualGateError("V15_PROVIDER_IMAGE_BUDGET_INVALID")
    return dest,image,image_sha,journal,candidate


def resume(root,call):
    if call is None:
        raise VisualGateError("V15_PROVIDER_NOT_CONFIGURED")
    dest,raw,image_sha,journal,candidate=contract(root)
    book,page,region=FINAL
    # This is an irreversible charge fence. No automatic retry after it.
    prior.exclusive(journal,prior.canonical({
        "schema_version":14,"state":"REQUEST_INITIATED_NO_RETRY",
        "source_tile_sha256_private":image_sha,"book_id":book,
        "physical_page":page,"region":region,"model":MODEL,
    }))
    reply=call(raw,prior.prompt(book,region),book,region)
    parsed=prior.parse_response(reply)
    result={"schema_version":14,"status":prior.AUTHORITY,
            "book_id":book,"physical_page":page,"region":region,
            "source_tile_sha256_private":image_sha,"model":MODEL,
            "candidate":parsed,"independent_gold_approved":False,
            "full_page_reference":False,"cer":None,
            "curve_correspondence_verified":False}
    blob=prior.canonical(result)
    if len(blob)>prior.MAX_RECORD:
        raise VisualGateError("V15_PRIVATE_RESULT_TOO_LARGE")
    prior.exclusive(candidate,blob)
    after=prior.private_inventory(root)
    if after!={"completed":3,"unknown":1,"not_started":0}:
        raise VisualGateError("V15_POSTCALL_INVENTORY_INVALID")
    return after


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-only",action="store_true")
    mode.add_argument("--resume-fresh-only",action="store_true")
    parser.add_argument("--allow-cloud-vision",action="store_true")
    args=parser.parse_args(argv)
    try:
        root=Path(args.private_root)
        if args.check_only:
            contract(root)
            print("ACS_V15_B15_FRESH_ONLY=SAFE_TO_START")
            print("ACS_V15_COMPLETED=2")
            print("ACS_V15_UNKNOWN=1")
            print("ACS_V15_NOT_STARTED=1")
            print("ACS_V15_NEW_MODEL_CALLS=0")
            return 0
        if not args.allow_cloud_vision:
            raise VisualGateError("V15_CLOUD_NOT_EXPLICITLY_ENABLED")
        key=(os.environ.get("ACS_GLM_VISION_API_KEY")
             or os.environ.get("GLM_API_KEY")
             or os.environ.get("ZHIPUAI_API_KEY")
             or os.environ.get("ZAI_API_KEY"))
        if not isinstance(key,str) or len(key)<12:
            print("ACS_V15_CLOUD=PROVIDER_NOT_CONFIGURED")
            return 3
        # Fail the full original-source and exact-state preflight before loading
        # a cloud transport. Never send B03 unresolved R2C2 a second time.
        contract(root)
        import requests
        def observer(image,prompt,_book,_region):
            return request_visual(image,prompt,key,requests_module=requests,round_id=1)
        after=resume(root,observer)
        print("ACS_V15_CLOUD=ONE_FRESH_B15_CANDIDATE_CREATED")
        print("ACS_V15_COMPLETED="+str(after["completed"]))
        print("ACS_V15_UNKNOWN="+str(after["unknown"]))
        print("ACS_V15_NOT_STARTED="+str(after["not_started"]))
        print("ACS_V15_NEW_MODEL_CALLS=1")
        print("ACS_V15_GOLD=NOT_APPROVED")
    except Exception as exc:
        if isinstance(exc,VisualGateError) and exc.code in ALLOWED_PUBLIC_ERRORS:
            print("ACS_V15_SAFE_REJECTION_CLASS="+exc.code)
        else:
            print("ACS_V15_SAFE_REJECTION_CLASS=OTHER_REJECTED")
        print("ACS_V15_CLOUD=REJECTED")
        return 2
    return 0


if __name__=="__main__":
    sys.exit(main())
