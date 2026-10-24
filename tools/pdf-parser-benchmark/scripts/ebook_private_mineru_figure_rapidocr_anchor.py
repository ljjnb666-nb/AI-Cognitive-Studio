#!/usr/bin/env python3
"""Bind a retained MinerU figure to RapidOCR page-flow text candidates.

Offline, private, no new model inference. Page flow is NOT geometrical image
registration and labels/markers/curves are NOT independently verified.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import unicodedata

STATUS='FIGURE_TEXT_CANDIDATES_UNVERIFIED'
FIGURE_ID='1-4-16'
MAX_MD=12_000_000
MAX_JSON=400_000
MAX_IMAGE=5_000_000
MAX_OUT=100_000
IMAGE_RE=re.compile(r'!\[[^\]]{0,64}\]\(data:image/jpeg;base64,([A-Za-z0-9+/=\r\n]+)\)')
CAPTION_RE=re.compile(r'图\s*([0-9]+)\s*[-－—]\s*([0-9]+)\s*[-－—]\s*([0-9]+)')


class GateError(Exception):
    pass


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def canonical(obj):
    return json.dumps(obj,ensure_ascii=False,sort_keys=True,
                      separators=(',',':')).encode('utf-8')


def read_private(path,limit):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=limit:
        raise GateError('SOURCE_FILE_MISSING_OR_UNSAFE')
    return path.read_bytes()


def no_dupes(pairs):
    obj={}
    for key,value in pairs:
        if key in obj:
            raise ValueError('DUPLICATE_JSON_KEY')
        obj[key]=value
    return obj


def read_json(path,limit):
    try:
        return json.loads(read_private(path,limit),object_pairs_hook=no_dupes,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError,UnicodeError):
        raise GateError('PRIVATE_JSON_INVALID') from None


def caption_id(value):
    match=CAPTION_RE.search(unicodedata.normalize('NFKC',value))
    return '-'.join(match.groups()) if match else None


def extract_figures(text):
    matches=list(IMAGE_RE.finditer(text))
    if len(matches)!=2:
        raise GateError('MINERU_IMAGE_COUNT_NOT_TWO')
    figures=[]
    for i,m in enumerate(matches):
        trailing=text[m.end():matches[i+1].start() if i+1<len(matches) else len(text)]
        lines=[line.strip() for line in trailing.splitlines() if line.strip()]
        if not lines or caption_id(lines[0]) is None:
            raise GateError('MINERU_FIGURE_CAPTION_NOT_ADJACENT')
        if len(CAPTION_RE.findall(lines[0]))!=1:
            raise GateError('MINERU_FIGURE_CAPTION_AMBIGUOUS')
        try:
            blob=base64.b64decode(m.group(1),validate=True)
        except (ValueError,base64.binascii.Error):
            raise GateError('MINERU_IMAGE_BASE64_INVALID') from None
        if not (100<len(blob)<MAX_IMAGE and blob[:3]==b'\xff\xd8\xff'
                and blob[-2:]==b'\xff\xd9'):
            raise GateError('MINERU_EMBEDDED_JPEG_INVALID')
        figures.append({
            'figure_id':caption_id(lines[0]),
            'mineru_embedded_image_index':i+1,
            'embedded_jpeg_sha256_private':digest(blob),
            'embedded_jpeg_bytes':len(blob),
            'mineru_image_bytes_preserved':True,
        })
    if [f['figure_id'] for f in figures]!=['1-4-15',FIGURE_ID]:
        raise GateError('MINERU_FIGURE_ID_SEQUENCE_CHANGED')
    return figures


def valid_quad(quad):
    return isinstance(quad,list) and len(quad)==4 and all(
        isinstance(point,list) and len(point)==2 and all(
            type(value) in (float,int) and 0<=value<=10000
            for value in point) for point in quad)


def flow_candidates(rows):
    """Only page-flow proximity, never image pixel coordinate registration."""
    references=[]
    captions=[]
    for i,row in enumerate(rows):
        if (not isinstance(row,dict) or not valid_quad(row.get('quad')) or
                not isinstance(row.get('text'),str) or len(row['text'])>500 or
                row.get('origin')!='LOCAL_SOURCE_IMAGE_OCR_NOT_GOLD' or
                type(row.get('score')) not in (float,int) or
                not 0<=row['score']<=1):
            raise GateError('RAPIDOCR_ROW_INVALID')
        if caption_id(row['text'])==FIGURE_ID:
            target=(captions if re.fullmatch(
                r'\s*图\s*1\s*[-－—]\s*4\s*[-－—]\s*16\s*',
                unicodedata.normalize('NFKC',row['text'])) else references)
            target.append(i)
    if len(references)!=1 or len(captions)!=1:
        raise GateError('RAPIDOCR_FIGURE_REFERENCE_CAPTION_AMBIGUOUS')
    start,end=references[0],captions[0]
    if not start<end or end-start<3:
        raise GateError('RAPIDOCR_FIGURE_READING_ORDER_INVALID')
    reference_bottom=max(point[1] for point in rows[start]['quad'])
    caption_top=min(point[1] for point in rows[end]['quad'])
    if caption_top<=reference_bottom:
        raise GateError('RAPIDOCR_FIGURE_VERTICAL_WINDOW_INVALID')
    selected=[]
    for i,row in enumerate(rows):
        if i<=start or i>=end:
            continue
        top=min(point[1] for point in row['quad'])
        bottom=max(point[1] for point in row['quad'])
        if top<reference_bottom or bottom>caption_top:
            raise GateError('RAPIDOCR_FIGURE_ROW_OUTSIDE_FLOW_WINDOW')
        selected.append({
            'page_row_index':i,
            'text_candidate':row['text'],
            'source_page_quad_candidate':row['quad'],
            'recognizer_confidence_not_accuracy':row['score'],
        })
    if not 4<=len(selected)<=50:
        raise GateError('RAPIDOCR_FIGURE_ROW_COUNT_INVALID')
    return selected,{
        'reference_row_index':start,'caption_row_index':end,
        'reference_bottom_y':reference_bottom,'caption_top_y':caption_top,
    }


def build(md_raw,mineru,rapid,*,book='B15',page=109):
    if (book!='B15' or page!=109 or mineru.get('book_id')!=book or
            mineru.get('physical_page')!=page or
            mineru.get('real_inference') is not True or
            mineru.get('graph_quality_gold') is not None or
            mineru.get('ocr_quality_gold') is not None or
            mineru.get('markdown_sha256_private')!=digest(md_raw)):
        raise GateError('MINERU_IDENTITY_OR_RECEIPT_FAILED')
    pages=[r for r in rapid.get('pages',[]) if
           r.get('book_id')==book and r.get('physical_page')==page]
    if len(pages)!=1 or rapid.get('ocr_accuracy_gold') is not None:
        raise GateError('RAPIDOCR_PAGE_IDENTITY_OR_GOLD_INVALID')
    source=pages[0]
    if (mineru.get('original_pdf_sha256')!=source.get('source_document_sha256') or
            mineru.get('rapidocr_source_png_sha256')!=source.get('render_png_sha256')):
        raise GateError('CROSS_ENGINE_SOURCE_IDENTITY_FAILED')
    rows=source.get('rapidocr_private_rows')
    if (not isinstance(rows,list) or not 1<=len(rows)<=200 or
            source.get('rapidocr_line_count')!=len(rows) or
            source.get('private_rows_sha256')!=digest(canonical(rows))):
        raise GateError('RAPIDOCR_FROZEN_ROWS_TAMPERED')
    figures=extract_figures(md_raw.decode('utf-8'))
    candidates,window=flow_candidates(rows)
    target=next(f for f in figures if f['figure_id']==FIGURE_ID)
    return {
        'schema_version':1,'status':STATUS,
        'page_identity':{
            'book_id':book,'physical_page':page,
            'source_pdf_sha256_private':mineru['original_pdf_sha256'],
            'source_render_png_sha256_private':source['render_png_sha256'],
            'mineru_markdown_sha256_private':digest(md_raw),
            'rapidocr_rows_sha256_private':source['private_rows_sha256'],
        },
        'retained_figures':figures,
        'selected_figure_id':FIGURE_ID,
        'selected_image_sha256_private':target['embedded_jpeg_sha256_private'],
        'page_flow_window_candidate':window,
        'page_source_ocr_candidates':candidates,
        'candidate_count':len(candidates),
        'image_to_page_geometry_verified':False,
        'label_to_marker_correspondence_verified':False,
        'series_to_curve_correspondence_verified':False,
        'visual_semantic_reference_verified':False,
        'independent_gold_available':False,
        'cer':None,
        'new_inference_calls':0,'new_downloads':0,
        'next_review':'VERIFY_FIGURE_ROI_REGISTRATION_AND_LEGEND_MARKERS_ON_SOURCE_IMAGE',
    }


def run(md_path,receipt_path,rapid_path,output_path,*,audit_only):
    raw=read_private(md_path,MAX_MD)
    result=build(raw,read_json(receipt_path,MAX_JSON),
                 read_json(rapid_path,MAX_JSON))
    encoded=canonical(result)+b'\n'
    if len(encoded)>MAX_OUT:
        raise GateError('OUTPUT_LIMIT')
    target=Path(output_path)
    if audit_only:
        if read_private(target,MAX_OUT)!=encoded:
            raise GateError('FROZEN_FIGURE_ANCHOR_CHANGED')
    else:
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
        if hasattr(os,'O_NOFOLLOW'):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(target,flags,0o600),'wb') as stream:
            stream.write(encoded)
    return result


def main():
    cli=argparse.ArgumentParser()
    cli.add_argument('--mineru-markdown',required=True)
    cli.add_argument('--mineru-receipt',required=True)
    cli.add_argument('--rapidocr-json',required=True)
    cli.add_argument('--private-output',required=True)
    cli.add_argument('--audit-only',action='store_true')
    args=cli.parse_args()
    try:
        result=run(args.mineru_markdown,args.mineru_receipt,
                   args.rapidocr_json,args.private_output,
                   audit_only=args.audit_only)
        print('ACS_FIGURE_ANCHOR_STATUS='+('PRIVATE_VERIFIED' if args.audit_only else 'PRIVATE_CREATED'))
        print('ACS_FIGURE_ANCHOR_FIGURE_COUNT='+str(len(result['retained_figures'])))
        print('ACS_FIGURE_ANCHOR_CANDIDATE_COUNT='+str(result['candidate_count']))
        print('ACS_FIGURE_ANCHOR_GOLD=UNVERIFIED')
        print('ACS_FIGURE_ANCHOR_CURVE_MAPPING=UNVERIFIED')
        print('ACS_FIGURE_ANCHOR_CALLS=0')
    except (GateError,TypeError,KeyError,ValueError,UnicodeError,OSError,AttributeError):
        print('ACS_FIGURE_ANCHOR_REJECTED=PRIVATE_SOURCE_OR_SPATIAL_GATE')
        sys.exit(2)


if __name__=='__main__':
    main()
