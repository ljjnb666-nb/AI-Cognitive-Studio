#!/usr/bin/env python3
"""Source-first physical-page textual scope, independent of OCR engine output.

A page may contain readable main text, navigational page furniture, visual
decoration and back-side bleed-through. Mixing these zones silently would
distort CER. This module defines two stable, reproducible text scopes. It
never approves a reference, supplies a CER, or infers classification from OCR.
"""
import hashlib
import unicodedata

VERSION="page-text-scope-v1"
MAIN_ROLES=frozenset(("body","boxed_heading","boxed_body"))
META_ROLES=frozenset(("running_header","page_number","section_page"))
EXCLUDED_ROLES=frozenset(("background_decoration","reverse_bleedthrough","non_text_graphic"))
ROLES=MAIN_ROLES|META_ROLES|EXCLUDED_ROLES
MAX_BLOCKS=128
MAX_TEXT_CHARS=100000

class TextScopeError(ValueError):
    pass

def _punctuation_count(value):
    return sum(unicodedata.category(ch).startswith("P") for ch in value)

def _view(rows, allowed):
    selected=[x for x in rows if x["type"] in allowed]
    text="\n".join(x["source_text_candidate"] for x in selected)
    return {
        "block_ids":[x["id"] for x in selected],
        "source_characters":sum(len(x["source_text_candidate"]) for x in selected),
        "punctuation_characters":sum(_punctuation_count(x["source_text_candidate"]) for x in selected),
        "unscored_source_text_sha256_private":hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "independent_gold_approved":False,
        "cer":None,
    }

def classify_front_page_text(blocks,*,scope_decisions):
    """Validate source blocks and produce comparable, *unapproved* scopes.

    Scopes are based on physical front-side content, not language-model
    correction or the strings emitted by MinerU/RapidOCR/Docling.
    """
    if (not isinstance(blocks,list) or not 0<len(blocks)<=MAX_BLOCKS or
            not isinstance(scope_decisions,dict) or
            scope_decisions.get("only_visible_physical_page_text") is not True or
            scope_decisions.get("exclude_reverse_bleedthrough") is not True or
            scope_decisions.get("exclude_cross_page_inferred_text") is not True or
            scope_decisions.get("record_decoration_separately") is not True):
        raise TextScopeError("SOURCE_TEXT_SCOPE_INVALID")
    seen=set()
    for x in blocks:
        if not isinstance(x,dict):
            raise TextScopeError("SOURCE_TEXT_BLOCK_INVALID")
        ident,role,s=x.get("id"),x.get("type"),x.get("source_text_candidate")
        if (not isinstance(ident,str) or not 0<len(ident)<=60 or ident in seen or
                role not in ROLES or not isinstance(s,str) or
                not 0<len(s)<=MAX_TEXT_CHARS or "\x00" in s or
                x.get("characters_including_punctuation")!=len(s) or
                x.get("punctuation_characters")!=_punctuation_count(s)):
            raise TextScopeError("SOURCE_TEXT_BLOCK_INVALID")
        seen.add(ident)
    main=_view(blocks,MAIN_ROLES)
    printed=_view(blocks,MAIN_ROLES|META_ROLES)
    exclusions=[{"block_id":x["id"],"role":x["type"]} for x in blocks
                if x["type"] in EXCLUDED_ROLES]
    return {
        "schema_version":VERSION,
        "status":"SOURCE_SCOPE_PROFILE_DRAFT_NOT_GOLD",
        "reading_content":main,
        "front_printed_text":printed,
        "separately_recorded_excluded_visuals":exclusions,
        "scope_policy":{
            "running_headers":"IN_FRONT_PRINTED_NOT_READING",
            "printed_page_numbers":"IN_FRONT_PRINTED_NOT_READING",
            "background_decorative_letters":"SEPARATE_VISUAL_TEXT_NOT_CER",
            "reverse_bleedthrough":"NEVER_IN_FRONT_PAGE_TEXT",
            "cross_page_continuation":"VISIBLE_FRAGMENT_ONLY",
            "misprinted_source_glyphs":"PRESERVE_LITERAL",
        },
        "source_review_is_external_claim_only":True,
        "punctuation_and_reading_order_independently_approved":False,
        "automatic_gold_approval":False,
        "all_ocr_engine_cer":None,
    }
