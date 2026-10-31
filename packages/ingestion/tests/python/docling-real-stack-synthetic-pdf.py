#!/usr/bin/env python3
"""Create exactly three synthetic PDF pages; no private corpus inputs."""
import argparse
from pathlib import Path
import fitz

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
args = parser.parse_args()
output = Path(args.output)
if not output.parent.is_dir() or output.exists():
    raise SystemExit(2)
doc = fitz.open()
for first, second in [
    ("PAGE_ZERO_DO_NOT_EXPORT", "PRIVATE_BOOK_READS_ZERO"),
    ("SECOND_PAGE_LAYOUT_TEST", "STRUCTURED_PARAGRAPH_CONTENT"),
    ("THIRD_PAGE_DO_NOT_EXPORT", "NON_TARGET_PAGE"),
]:
    page=doc.new_page(width=612,height=792)
    page.insert_text((40,100),first,fontsize=16)
    page.insert_text((40,155),second,fontsize=12)
doc.save(str(output))
doc.close()
print("ACS_DOCLING_REAL_STACK_SYNTHETIC_PDF=PASS")
