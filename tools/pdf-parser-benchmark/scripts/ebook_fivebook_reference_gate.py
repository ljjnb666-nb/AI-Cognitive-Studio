#!/usr/bin/env python3
"""Five-book independent-reference admission gate and conditional CER.

Machine outputs never create reference text. No provider calls or downloads.
References must pre-exist in D: private folder and be externally reviewed.
The code verifies identities, hash and attestation shape, NOT whether the
independent review claim itself is true. Missing reference -> no CER value.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from ebook_fivebook_text_consensus import (
    compute as compute_consensus,lexical,mineru_lexical_source,
)
from ebook_fivebook_mineru_basic_matrix import (
    combined, ALL_BOOKS,file_names,
)
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapid
from ebook_b31_mineru_basic_stateless import MARKDOWN as B31_MD
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="fivebook_independent_reference_admission.private.json"
REFERENCES="independent_reference_v1"
EVIDENCE="INDEPENDENT_REFERENCE_ATTESTATION_GATE_NOT_AUTOMATIC_GOLD"
MAX_REPORT=80000
MAX_REFERENCE=75000
MAX_PUBLISHER_SOURCE=1_000_000
MAX_NORMALIZED=5000
MAX_DISTANCE_CELLS=6_000_000
SHA=re.compile(r"^[0-9a-f]{64}$")
ORIGINS={"PUBLISHER_ORIGINAL_TEXT","INDEPENDENT_PAGE_TRANSCRIPTION"}
METHODS={"PUBLISHER_SOURCE_VERIFICATION","MANUAL_SOURCE_PAGE_REVIEW"}
FULL_PAGE_SCOPE="COMPLETE_PHYSICAL_PAGE_TEXT"
REVIEW_GRID=tuple(f"R{r}C{c}" for r in range(1,4) for c in range(1,4))
MAX_SNAPSHOT_VERSION=12


def snapshot_names(version):
    """Fixed filenames only. Each revision has a private reference directory."""
    if type(version) is not int or not 1<=version<=MAX_SNAPSHOT_VERSION:
        raise VisualGateError("REFERENCE_SNAPSHOT_VERSION_INVALID")
    if version==1:
        return REPORT,REFERENCES
    return REPORT.replace(".private.json",f".v{version}.private.json"),f"independent_reference_v{version}"


def private_load(path):
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_REFERENCE:
        raise VisualGateError("REFERENCE_FILE_MISSING_OR_UNSAFE")
    try:
        return json.loads(path.read_text("utf-8"),
            object_pairs_hook=no_duplicate_keys,parse_constant=reject_constant)
    except (UnicodeError,ValueError,TypeError):
        raise VisualGateError("REFERENCE_INVALID_JSON") from None


def identity(row):
    return row["book_id"],row["physical_page"]


def require_full_page_coverage(candidate):
    """A paragraph/legend/8-span spot-check must never be scored as full-page CER.

    This validates the reviewer's explicit full-page *claim*, not its factual
    truth. Source-level independence still requires an external review audit.
    Image/diagram structure is separately evaluated and is NOT OCR CER.
    """
    coverage=candidate.get("full_page_coverage")
    if (candidate.get("reference_scope")!=FULL_PAGE_SCOPE or
            not isinstance(coverage,dict) or
            coverage.get("coverage_scope")!=FULL_PAGE_SCOPE or
            coverage.get("reviewed_grid_cells")!=list(REVIEW_GRID) or
            coverage.get("sidebars_and_vertical_text_reviewed") is not True or
            coverage.get("all_visible_text_and_punctuation_transcribed") is not True or
            coverage.get("page_reading_order_reviewed") is not True or
            type(coverage.get("unresolved_text_regions")) is not list or
            coverage["unresolved_text_regions"]!=[]):
        raise VisualGateError("REFERENCE_FULL_PAGE_COVERAGE_UNVERIFIED")


def admit_reference(candidate,baseline,corpus,*,reference_file=None):
    """Never accept either compared model as the purported independent source."""
    if (not isinstance(candidate,dict) or candidate.get("schema_version")!=1 or
            candidate.get("corpus_id")!=corpus or
            candidate.get("book_id")!=baseline["book_id"] or
            type(candidate.get("physical_page")) is not int or
            candidate["physical_page"]!=baseline["physical_page"] or
            candidate.get("original_page_pdf_sha256")!=baseline["source_pdf_sha256_private"] or
            candidate.get("reference_origin") not in ORIGINS or
            candidate.get("verification_method") not in METHODS or
            candidate.get("reviewed_source_page") is not True or
            candidate.get("not_derived_from_rapidocr_or_mineru") is not True or
            candidate.get("reviewer_approval")!="INDEPENDENTLY_APPROVED" or
            not isinstance(candidate.get("independent_source_sha256"),str) or
            not SHA.fullmatch(candidate["independent_source_sha256"]) or
            not isinstance(candidate.get("reference_text_sha256"),str) or
            not SHA.fullmatch(candidate["reference_text_sha256"]) or
            not isinstance(candidate.get("reviewer_record_id"),str) or
            not re.fullmatch(r"[A-Za-z0-9_-]{8,80}",
                             candidate["reviewer_record_id"])):
        raise VisualGateError("REFERENCE_IDENTITY_OR_INDEPENDENCE_ATTESTATION_INVALID")
    require_full_page_coverage(candidate)
    if candidate["verification_method"]=="PUBLISHER_SOURCE_VERIFICATION" and (
        candidate["reference_origin"]!="PUBLISHER_ORIGINAL_TEXT"):
        raise VisualGateError("REFERENCE_ORIGIN_METHOD_CONFLICT")
    if candidate["verification_method"]=="MANUAL_SOURCE_PAGE_REVIEW" and (
        candidate["reference_origin"]!="INDEPENDENT_PAGE_TRANSCRIPTION"):
        raise VisualGateError("REFERENCE_ORIGIN_METHOD_CONFLICT")
    # A claimed source digest without the source artifact is not evidence.
    if candidate["reference_origin"]=="INDEPENDENT_PAGE_TRANSCRIPTION":
        if candidate["independent_source_sha256"]!=baseline["source_pdf_sha256_private"]:
            raise VisualGateError("REFERENCE_MANUAL_SOURCE_PDF_SHA_MISMATCH")
    else:
        if reference_file is None:
            raise VisualGateError("REFERENCE_PUBLISHER_SOURCE_ARTIFACT_REQUIRED")
        source_artifact=reference_file.with_name(
            reference_file.name.replace(".verified.private.json",".publisher_source.private.txt"))
        if (source_artifact.is_symlink() or not source_artifact.is_file() or
                not 0<source_artifact.stat().st_size<=MAX_PUBLISHER_SOURCE):
            raise VisualGateError("REFERENCE_PUBLISHER_SOURCE_ARTIFACT_MISSING")
        digest=hashlib.sha256()
        with source_artifact.open("rb") as source:
            for chunk in iter(lambda:source.read(1024*1024),b""):
                digest.update(chunk)
        if digest.hexdigest()!=candidate["independent_source_sha256"]:
            raise VisualGateError("REFERENCE_PUBLISHER_SOURCE_SHA_MISMATCH")
    value=candidate.get("reference_text")
    if not isinstance(value,str) or not 0<len(value)<=MAX_REFERENCE:
        raise VisualGateError("REFERENCE_TEXT_EMPTY_OR_TOO_LARGE")
    if hashlib.sha256(value.encode("utf-8")).hexdigest()!=candidate["reference_text_sha256"]:
        raise VisualGateError("REFERENCE_TEXT_SHA_CHANGED")
    ref=lexical(value)
    if not ref:
        raise VisualGateError("REFERENCE_NORMALIZED_TEXT_EMPTY")
    return ref


def edit_distance(reference,prediction):
    """Exact insertion/deletion/substitution distance; not SequenceMatcher."""
    n,m=len(reference),len(prediction)
    if not 0<n<=MAX_NORMALIZED or m>MAX_NORMALIZED or n*m>MAX_DISTANCE_CELLS:
        raise VisualGateError("REFERENCE_CER_COMPUTATION_BUDGET_EXCEEDED")
    row=list(range(m+1))
    for i,character in enumerate(reference,1):
        updated=[i]+[0]*m
        for j,other in enumerate(prediction,1):
            updated[j]=min(updated[j-1]+1,row[j]+1,
                           row[j-1]+(character!=other))
        row=updated
    return row[m]


def compute(root,manifest,*,snapshot_version=1):
    _,reference_dir=snapshot_names(snapshot_version)
    consensus=compute_consensus(root,manifest)
    matrix=combined(root,manifest,audit=True)
    rapid=audit_rapid(root,manifest)
    if (len(consensus["rows"])!=5 or
            consensus.get("agreement_is_not_accuracy") is not True or
            matrix.get("identical_focus_pages")!=5):
        raise VisualGateError("REFERENCE_PRIOR_FIVE_PAGE_BENCHMARK_INVALID")
    ri={(row["book_id"],row["physical_page"]):row for row in rapid["pages"]}
    folder=_private_folder(root)
    refdir=folder/reference_dir
    if refdir.is_symlink() or (refdir.exists() and not refdir.is_dir()):
        raise VisualGateError("REFERENCE_DIRECTORY_UNSAFE")
    rows=[]
    for item in matrix["rows"]:
        book,page=identity(item)
        if book not in ALL_BOOKS or (book,page) not in ri:
            raise VisualGateError("REFERENCE_FOCUS_PAGE_IDENTITY_INVALID")
        candidate=refdir/(f"{book}_p{page:04d}.verified.private.json")
        record={
            "book_id":book,"physical_page":page,
            "original_pdf_source_sha256_private":item["source_pdf_sha256_private"],
            "reference_state":"INDEPENDENT_REFERENCE_NOT_PROVIDED",
            "cer_rapidocr":None,"cer_mineru_basic":None,
            "reference_normalized_chars":None,"source_attestation_is_external_claim":None,
        }
        if candidate.exists() or candidate.is_symlink():
            ref=admit_reference(private_load(candidate),item,matrix["corpus_id"],reference_file=candidate)
            source=folder/(B31_MD if book=="B31" else file_names(book)[1])
            if source.is_symlink() or not source.is_file():
                raise VisualGateError("REFERENCE_MINERU_SOURCE_MISSING")
            try:
                markdown=source.read_text("utf-8")
            except UnicodeError:
                raise VisualGateError("REFERENCE_MINERU_SOURCE_INVALID_UTF8") from None
            texts=ri[(book,page)]["rapidocr_private_rows"]
            if (not isinstance(texts,list) or
                    any(not isinstance(line,dict) or not isinstance(line.get("text"),str)
                        for line in texts)):
                raise VisualGateError("REFERENCE_RAPID_ROWS_INVALID")
            r=lexical("\n".join(t["text"] for t in texts))
            m=lexical(mineru_lexical_source(markdown))
            if (len(r)!=next(c["rapidocr_normalized_alnum_chars"]
                            for c in consensus["rows"] if identity(c)==(book,page)) or
                    len(m)!=next(c["mineru_nonimage_normalized_alnum_chars"]
                            for c in consensus["rows"] if identity(c)==(book,page))):
                raise VisualGateError("REFERENCE_COMPARED_TEXT_IDENTITY_CHANGED")
            record.update({
                "reference_state":"ATTESTED_REFERENCE_CER_COMPUTED",
                "reference_scope":FULL_PAGE_SCOPE,
                "reference_coverage_attestation_is_external_claim":True,
                "reference_normalized_chars":len(ref),
                "cer_rapidocr":round(edit_distance(ref,r)/len(ref),6),
                "cer_mineru_basic":round(edit_distance(ref,m)/len(ref),6),
                "reference_text_sha256_private":hashlib.sha256(ref.encode("utf-8")).hexdigest(),
                "reference_receipt_sha256_private":hashlib.sha256(candidate.read_bytes()).hexdigest(),
                # Verification of the fact of independent review is external.
                "source_attestation_is_external_claim":True,
            })
        rows.append(record)
    if [r["book_id"] for r in rows]!=list(ALL_BOOKS):
        raise VisualGateError("REFERENCE_FIVE_BOOK_ORDER_CHANGED")
    approved=sum(row["reference_state"]=="ATTESTED_REFERENCE_CER_COMPUTED" for row in rows)
    return {
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":matrix["corpus_id"],
        "page_count":5,
        "reference_attested_count":approved,
        "no_reference_count":5-approved,
        "reference_provenance_truth_requires_external_audit":True,
        "automatic_ocr_as_gold_forbidden":True,
        "unreviewed_reference_scores_forbidden":True,
        "provider_calls":0,"model_downloads":0,"new_inference_calls":0,
        "rows":rows,
    }


def execute(root,manifest,*,write=False,audit=False,snapshot_version=1):
    report_name,_=snapshot_names(snapshot_version)
    folder=_private_folder(root)
    output=folder/report_name
    if not audit and (output.exists() or output.is_symlink()):
        raise VisualGateError("REFERENCE_REPORT_ALREADY_EXISTS")
    previous_hash=None
    if snapshot_version>1:
        # Audit the predecessor against its OWN frozen reference directory.
        # A later reference must never mutate or retroactively rescore v1.
        execute(root,manifest,audit=True,snapshot_version=snapshot_version-1)
        prior_name,_=snapshot_names(snapshot_version-1)
        previous_hash=hashlib.sha256((folder/prior_name).read_bytes()).hexdigest()
    result=compute(root,manifest,snapshot_version=snapshot_version)
    if previous_hash is not None:
        result["snapshot_version"]=snapshot_version
        result["previous_snapshot_sha256_private"]=previous_hash
        result["prior_report_revalidated"]=True
    blob=(json.dumps(result,sort_keys=True,ensure_ascii=False,
                     separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("REFERENCE_REPORT_SIZE_INVALID")
    if audit:
        if output.is_symlink() or not output.is_file() or output.read_bytes()!=blob:
            raise VisualGateError("REFERENCE_PRIVATE_RECEIPT_CHANGED")
    elif write:
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
        if hasattr(os,"O_NOFOLLOW"):flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(output,flags,0o600),"wb") as f:
            f.write(blob)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    group=parser.add_mutually_exclusive_group()
    group.add_argument("--write",action="store_true")
    group.add_argument("--audit-only",action="store_true")
    parser.add_argument("--snapshot-version",type=int,default=1,
                        help="Immutable independent-reference revision (1..12); v1 default")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    data=execute(Path(args.private_root),manifest,write=args.write,
                 audit=args.audit_only,snapshot_version=args.snapshot_version)
    print("ACS_REFERENCE_GATE_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_REFERENCE_GATE_SNAPSHOT=v"+str(args.snapshot_version))
    print("ACS_REFERENCE_GATE_PAGES="+str(data["page_count"]))
    print("ACS_REFERENCE_GATE_ATTESTED="+str(data["reference_attested_count"]))
    print("ACS_REFERENCE_GATE_MISSING="+str(data["no_reference_count"]))
    for row in data["rows"]:
        print("ACS_REFERENCE_GATE_"+row["book_id"]+"="+row["reference_state"])
    print("ACS_REFERENCE_GATE_EXTERNAL_ATTESTATION_NOT_CRYPTOGRAPHICALLY_PROVEN=TRUE")
    print("ACS_REFERENCE_GATE_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,TypeError,ValueError,OSError,RuntimeError):
        print("ACS_REFERENCE_GATE_REJECTED=PRIVATE_PROVENANCE_OR_SOURCE_FAILURE")
        sys.exit(2)
