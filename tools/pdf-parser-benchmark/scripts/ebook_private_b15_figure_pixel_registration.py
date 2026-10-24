#!/usr/bin/env python3
"""Private B15 figure-to-page pixel registration *candidates*, never semantic truth.

Read immutable source PNG, MinerU Markdown and v1 RapidOCR flow receipt. Match the
embedded JPEG in the original page at bounded scales and right-angle rotations.
All imagery/coordinates/hashes stay in a private D: receipt. Fixed public status only.
"""
import argparse
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys

MAX_MD = 12_000_000
MAX_PNG = 12_000_000
MAX_ANCHOR = 120_000
MAX_OUT = 32_000
MAX_PIXELS = 4_000_000
FIGURE_ID = "1-4-16"
STATUS = "PIXEL_ALIGNMENT_CANDIDATE_UNVERIFIED"
IMAGE_RE = re.compile(r'!\[[^\]]{0,64}\]\(data:image/jpeg;base64,([A-Za-z0-9+/=]+)\)')
SCALES = (0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6, 1.8)


class GateError(Exception):
    pass


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def read_bytes(path, limit):
    p = Path(path)
    if (p.is_symlink() or not p.is_file() or not 0 < p.stat().st_size <= limit):
        raise GateError('PRIVATE_INPUT_MISSING_OR_UNSAFE')
    return p.read_bytes()


def no_duplicates(pairs):
    data = {}
    for k, v in pairs:
        if k in data:
            raise GateError('PRIVATE_DUPLICATE_JSON_KEY')
        data[k] = v
    return data


def reject_nonfinite(_):
    raise GateError('PRIVATE_NONFINITE_VALUE')


def read_json(path, limit):
    try:
        return json.loads(read_bytes(path, limit).decode('utf-8'),
                          object_pairs_hook=no_duplicates,
                          parse_constant=reject_nonfinite)
    except (UnicodeError, ValueError, TypeError):
        raise GateError('PRIVATE_JSON_NOT_VALID') from None


def canonical(data):
    return (json.dumps(data, ensure_ascii=False, sort_keys=True,
                       separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def source_proof(source, markdown, anchor):
    if not isinstance(anchor, dict) or anchor.get('schema_version') != 1:
        raise GateError('PRIOR_ANCHOR_VERSION_INVALID')
    ident = anchor.get('page_identity')
    if (not isinstance(ident, dict) or ident.get('book_id') != 'B15' or
            ident.get('physical_page') != 109 or
            ident.get('source_render_png_sha256_private') != sha256(source) or
            ident.get('mineru_markdown_sha256_private') != sha256(markdown) or
            anchor.get('status') != 'FIGURE_TEXT_CANDIDATES_UNVERIFIED' or
            anchor.get('selected_figure_id') != FIGURE_ID or
            anchor.get('candidate_count') != 19 or
            len(anchor.get('page_source_ocr_candidates', [])) != 19 or
            anchor.get('independent_gold_available') is not False or
            anchor.get('image_to_page_geometry_verified') is not False or
            anchor.get('series_to_curve_correspondence_verified') is not False or
            anchor.get('label_to_marker_correspondence_verified') is not False or
            anchor.get('cer', object()) is not None):
        raise GateError('PRIOR_ANCHOR_PROVENANCE_OR_AUTHORITY_FAILED')
    try:
        markdown_text = markdown.decode('utf-8')
    except UnicodeError:
        raise GateError('MINERU_MARKDOWN_INVALID') from None
    images = IMAGE_RE.findall(markdown_text)
    if len(images) != 2:
        raise GateError('MINERU_EMBEDDED_IMAGE_COUNT_CHANGED')
    try:
        selected = base64.b64decode(images[1], validate=True)
    except (ValueError, base64.binascii.Error):
        raise GateError('MINERU_IMAGE_ENCODING_CHANGED') from None
    if (not (100 < len(selected) < 5_000_000) or
            selected[:3] != b'\xff\xd8\xff' or selected[-2:] != b'\xff\xd9' or
            anchor.get('selected_image_sha256_private') != sha256(selected) or
            len(anchor.get('retained_figures', [])) != 2 or
            anchor['retained_figures'][1].get('embedded_jpeg_sha256_private') != sha256(selected)):
        raise GateError('MINERU_EMBEDDED_SELECTED_IMAGE_CHANGED')
    return selected


def grayscale(raw, expected_format):
    from PIL import Image, ImageFile
    import numpy as np
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        with Image.open(BytesIO(raw)) as im:
            im.load()
            if im.format != expected_format or im.width * im.height > MAX_PIXELS:
                raise GateError('SOURCE_IMAGE_FORMAT_OR_SIZE_INVALID')
            if min(im.size) < 50:
                raise GateError('IMAGE_TOO_SMALL')
            # np array is temporary, never written to CI logs.
            return np.asarray(im.convert('L'), dtype=np.uint8).copy()
    except GateError:
        raise
    except (OSError, ValueError, MemoryError):
        raise GateError('SOURCE_IMAGE_DECODE_REJECTED') from None


def registration(page, figure):
    """Bounded 4-orientation/12-scale grayscale CCOEFF proposals; never gold."""
    import cv2
    import numpy as np
    cv2.setNumThreads(1)
    if page.ndim != 2 or figure.ndim != 2 or page.dtype != np.uint8 or figure.dtype != np.uint8:
        raise GateError('IMAGE_ARRAY_INVALID')
    page_h, page_w = page.shape
    if not (50 <= page_h <= 3000 and 50 <= page_w <= 3000 and
            page_h * page_w <= MAX_PIXELS):
        raise GateError('SOURCE_PAGE_BUDGET_INVALID')
    if float(np.std(figure)) < 7.0:
        raise GateError('EMBEDDED_FIGURE_LOW_VARIANCE')
    found = []
    for deg, rotated in ((0, figure), (90, cv2.rotate(figure, cv2.ROTATE_90_CLOCKWISE)),
                         (180, cv2.rotate(figure, cv2.ROTATE_180)),
                         (270, cv2.rotate(figure, cv2.ROTATE_90_COUNTERCLOCKWISE))):
        for scale in SCALES:
            h = round(rotated.shape[0] * scale)
            w = round(rotated.shape[1] * scale)
            if not (40 <= h <= page_h and 40 <= w <= page_w and h * w <= MAX_PIXELS):
                continue
            interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
            template = cv2.resize(rotated, (w, h), interpolation=interp)
            if float(np.std(template)) < 7.0:
                continue
            correlation = cv2.matchTemplate(page, template, cv2.TM_CCOEFF_NORMED)
            _, strength, _, (x, y) = cv2.minMaxLoc(correlation)
            if not np.isfinite(strength):
                continue
            found.append({'rotation_clockwise_degrees': deg, 'scale': scale,
                          'match_score_not_accuracy': round(float(strength), 6),
                          'source_page_pixel_box_candidate': [x, y, x + w, y + h]})
    if not found:
        raise GateError('NO_BOUNDED_IMAGE_PROPOSAL')
    found.sort(key=lambda m: (-m['match_score_not_accuracy'],
                              m['rotation_clockwise_degrees'], m['scale']))
    # Do not assert a unique match based only on one template peak.
    top = found[0]
    return {'hypotheses': found[:6],
            'candidate_generated': True,
            'high_correlation_signal_not_proof': top['match_score_not_accuracy'] >= 0.65,
            'source_image_dimensions_pixels': [page_w, page_h],
            'embedded_image_dimensions_pixels': [figure.shape[1], figure.shape[0]]}


def build(source, markdown, anchor):
    image = source_proof(source, markdown, anchor)
    result = registration(grayscale(source, 'PNG'), grayscale(image, 'JPEG'))
    return {'schema_version': 2, 'status': STATUS,
            'book_id': 'B15', 'physical_page': 109, 'figure_id': FIGURE_ID,
            'source_render_png_sha256_private': sha256(source),
            'mineru_markdown_sha256_private': sha256(markdown),
            'prior_v1_anchor_sha256_private': sha256(canonical(anchor)),
            'embedded_figure_jpeg_sha256_private': sha256(image),
            'registration': result,
            'source_pixel_frame_to_ocr_quad_verified': False,
            'image_to_page_geometry_verified': False,
            'label_to_marker_correspondence_verified': False,
            'series_to_curve_correspondence_verified': False,
            'visual_semantic_reference_verified': False,
            'independent_gold_available': False,
            'cer': None, 'new_ocr_calls': 0, 'new_cloud_calls': 0,
            'new_model_downloads': 0,
            'next_review': 'HUMAN_OR_SOURCE_ATTESTED_FIGURE_ROI_AND_SYMBOL_CHECK'}


def run(page_path, markdown_path, anchor_path, output_path, *, audit_only):
    source = read_bytes(page_path, MAX_PNG)
    markdown = read_bytes(markdown_path, MAX_MD)
    anchor = read_json(anchor_path, MAX_ANCHOR)
    # Record exact prior receipt bytes as provenance; producer used canonical JSON + newline.
    if read_bytes(anchor_path, MAX_ANCHOR) != canonical(anchor):
        raise GateError('PRIOR_V1_RECEIPT_NONCANONICAL')
    output = canonical(build(source, markdown, anchor))
    if len(output) > MAX_OUT:
        raise GateError('OUTPUT_EXCEEDS_PRIVATE_LIMIT')
    target = Path(output_path)
    if audit_only:
        if read_bytes(target, MAX_OUT) != output:
            raise GateError('PRIVATE_FROZEN_PROPOSAL_MUTATED')
    else:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, 'O_NOFOLLOW'):
            flags |= os.O_NOFOLLOW
        with os.fdopen(os.open(target, flags, 0o600), 'wb') as fd:
            fd.write(output)
    return json.loads(output)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--page-png', required=True)
    parser.add_argument('--mineru-markdown', required=True)
    parser.add_argument('--anchor-v1', required=True)
    parser.add_argument('--private-output', required=True)
    parser.add_argument('--audit-only', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = run(args.page_png, args.mineru_markdown, args.anchor_v1,
                     args.private_output, audit_only=args.audit_only)
        if (result['image_to_page_geometry_verified'] is not False or
                result['label_to_marker_correspondence_verified'] is not False or
                result['independent_gold_available'] is not False or
                result['cer'] is not None):
            raise GateError('FROZEN_AUTHORITY_CONSTRAINT_VIOLATED')
        print('ACS_FIGURE_PIXEL_PROPOSAL=' + ('PRIVATE_AUDIT_PASS' if args.audit_only else 'PRIVATE_CREATED'))
        print('ACS_FIGURE_PIXEL_CANDIDATE_COUNT=' + str(len(result['registration']['hypotheses'])))
        print('ACS_FIGURE_PIXEL_GEOMETRY=UNVERIFIED')
        print('ACS_FIGURE_PIXEL_SYMBOL_MAPPING=UNVERIFIED')
        print('ACS_FIGURE_PIXEL_CLOUD_OCR_CALLS=0')
    except Exception:
        # Security: even unexpected source/decoder errors cannot echo private content.
        print('ACS_FIGURE_PIXEL_PROPOSAL=REJECTED')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
