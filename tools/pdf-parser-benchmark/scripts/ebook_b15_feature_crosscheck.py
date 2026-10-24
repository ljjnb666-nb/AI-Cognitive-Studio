#!/usr/bin/env python3
"""Private B15 feature corroboration; never a verified geometric or OCR gold."""
import argparse
from io import BytesIO
import math
import os
from pathlib import Path
import sys
import ebook_private_b15_figure_pixel_registration as pixel

STATUS='FEATURE_CORROBORATION_PROPOSAL_UNVERIFIED'
MAX_V3=32_000
MAX_V4=50_000
MAX_OVERLAY=12_000_000

class GateError(Exception):
    pass

def require(value):
    if not value:
        raise GateError('PRIVATE_SOURCE_OR_GEOMETRY_INVALID')

def validate_v3(v3,page,markdown,anchor):
    require(isinstance(v3,dict) and v3.get('schema_version')==3)
    require(v3.get('status')==pixel.STATUS)
    require(v3.get('book_id')=='B15' and v3.get('physical_page')==109)
    require(v3.get('figure_id')==pixel.FIGURE_ID)
    require(v3.get('source_render_png_sha256_private')==pixel.sha256(page))
    require(v3.get('mineru_markdown_sha256_private')==pixel.sha256(markdown))
    require(v3.get('prior_v1_anchor_sha256_private')==pixel.sha256(pixel.canonical(anchor)))
    for key in ('image_to_page_geometry_verified','source_pixel_frame_to_ocr_quad_verified',
                'independent_gold_available','series_to_curve_correspondence_verified',
                'label_to_marker_correspondence_verified'):
        require(v3.get(key) is False)
    require(v3.get('cer',object()) is None)
    reg=v3.get('registration')
    require(isinstance(reg,dict) and reg.get('candidate_generated') is True)
    hypotheses=reg.get('hypotheses')
    require(isinstance(hypotheses,list) and 1<=len(hypotheses)<=6)
    source=pixel.grayscale(page,'PNG')
    require(reg.get('source_image_dimensions_pixels')==[source.shape[1],source.shape[0]])
    figure_bytes=pixel.source_proof(page,markdown,anchor)
    require(v3.get('embedded_figure_jpeg_sha256_private')==pixel.sha256(figure_bytes))
    for item in hypotheses:
        require(isinstance(item,dict))
        rect=item.get('source_page_pixel_box_candidate')
        require(isinstance(rect,list) and len(rect)==4 and all(type(n) is int for n in rect))
        require(0<=rect[0]<rect[2]<=source.shape[1])
        require(0<=rect[1]<rect[3]<=source.shape[0])
        score=item.get('match_score_not_accuracy')
        require(type(score) in (float,int) and math.isfinite(score) and -1<=score<=1)
    return source,pixel.grayscale(figure_bytes,'JPEG')

def iou(a,b):
    x1=max(a[0],b[0]); y1=max(a[1],b[1])
    x2=min(a[2],b[2]); y2=min(a[3],b[3])
    intersection=max(0,x2-x1)*max(0,y2-y1)
    area_a=(a[2]-a[0])*(a[3]-a[1])
    area_b=(b[2]-b[0])*(b[3]-b[1])
    return intersection/(area_a+area_b-intersection) if area_a+area_b>intersection else 0.0

def feature_proposal(page,figure,boxes):
    """Independent ORB/RANSAC candidate, including an honest low-feature state."""
    import cv2
    import numpy as np
    cv2.setNumThreads(1)
    detector=cv2.ORB_create(nfeatures=1400,fastThreshold=12)
    fk,fd=detector.detectAndCompute(figure,None)
    pk,pd=detector.detectAndCompute(page,None)
    result={'method':'ORB_RANSAC','status':'INSUFFICIENT_INDEPENDENT_FEATURE_EVIDENCE',
            'feature_correlated_candidate':False,'selected_template_hypothesis_index':None,
            'inlier_count':0,'inlier_fraction':0.0,'matching_iou_not_accuracy':None,
            'proposal_box_private':None,'proposal_quad_private':None}
    if fd is None or pd is None or len(fk)<12 or len(pk)<12:
        return result
    pairs=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(fd,pd,k=2)
    matches=[a for pair in pairs if len(pair)==2 for a,b in [pair] if a.distance<0.72*b.distance]
    if len(matches)<9:
        return result
    left=np.float32([fk[x.queryIdx].pt for x in matches]).reshape(-1,1,2)
    right=np.float32([pk[x.trainIdx].pt for x in matches]).reshape(-1,1,2)
    homography,mask=cv2.findHomography(left,right,cv2.RANSAC,4.0,maxIters=1500,confidence=0.995)
    if homography is None or mask is None or not np.all(np.isfinite(homography)):
        return result
    inliers=int(mask.sum()); fraction=inliers/len(matches)
    if inliers<8 or fraction<0.35:
        return result
    h,w=figure.shape
    corners=np.float32([[0,0],[w,0],[w,h],[0,h]]).reshape(-1,1,2)
    proposed=cv2.perspectiveTransform(corners,homography).reshape(4,2)
    if not np.all(np.isfinite(proposed)) or abs(float(cv2.contourArea(proposed.astype(np.float32))))<1600:
        return result
    if not cv2.isContourConvex(proposed.astype(np.float32)):
        return result
    xmin=int(round(float(proposed[:,0].min())))
    ymin=int(round(float(proposed[:,1].min())))
    xmax=int(round(float(proposed[:,0].max())))
    ymax=int(round(float(proposed[:,1].max())))
    if not (0<=xmin<xmax<=page.shape[1] and 0<=ymin<ymax<=page.shape[0]):
        return result
    box=[xmin,ymin,xmax,ymax]
    scores=[iou(box,candidate) for candidate in boxes]
    best=max(range(len(scores)),key=scores.__getitem__)
    result.update({'selected_template_hypothesis_index':best,
                   'inlier_count':inliers,'inlier_fraction':round(fraction,5),
                   'matching_iou_not_accuracy':round(scores[best],5),
                   'proposal_box_private':box,
                   'proposal_quad_private':[[round(float(x),2),round(float(y),2)] for x,y in proposed]})
    if scores[best]>=0.45:
        result['status']='GEOMETRY_CANDIDATES_CROSS_METHOD_CONSISTENT_UNVERIFIED'
        result['feature_correlated_candidate']=True
    else:
        result['status']='FEATURE_TEMPLATE_CONFLICT_REVIEW_REQUIRED'
    return result

def overlay_png(source,boxes,features):
    from PIL import Image,ImageDraw
    with Image.open(BytesIO(source)) as im:
        im.load()
        require(im.format=='PNG' and im.width*im.height<=pixel.MAX_PIXELS)
        out=im.convert('RGB')
    draw=ImageDraw.Draw(out)
    for index,box in enumerate(boxes):
        draw.rectangle(box,outline=(222,46,46) if index==0 else (234,165,58),width=3)
        draw.text((box[0]+2,box[1]+2),f'C{index+1}',fill=(210,30,30))
    if features['proposal_quad_private']:
        points=[tuple(p) for p in features['proposal_quad_private']]
        draw.line(points+[points[0]],fill=(22,180,180),width=3)
    buffer=BytesIO()
    out.save(buffer,format='PNG')
    raw=buffer.getvalue()
    require(0<len(raw)<=MAX_OVERLAY)
    return raw

def build(page,markdown,anchor,v3):
    source,figure=validate_v3(v3,page,markdown,anchor)
    boxes=[h['source_page_pixel_box_candidate'] for h in v3['registration']['hypotheses']]
    feature=feature_proposal(source,figure,boxes)
    overlay=overlay_png(page,boxes,feature)
    data={'schema_version':4,'status':STATUS,'book_id':'B15','physical_page':109,
          'figure_id':pixel.FIGURE_ID,'prior_v3_sha256_private':pixel.sha256(pixel.canonical(v3)),
          'original_png_sha256_private':pixel.sha256(page),
          'template_boxes_private':boxes,'independent_feature_candidate':feature,
          'review_overlay_sha256_private':pixel.sha256(overlay),
          'original_page_pixel_registration_verified':False,
          'figure_text_label_to_marker_verified':False,
          'series_to_curve_correspondence_verified':False,
          'independent_gold_available':False,'cer':None,
          'new_ocr_calls':0,'new_cloud_calls':0,'new_model_downloads':0}
    return data,overlay

def exclusive(path,data):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os,'O_NOFOLLOW'):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),'wb') as stream:
        stream.write(data)

def run(page_path,md_path,anchor_path,v3_path,report_path,overlay_path,*,audit_only):
    source=pixel.read_bytes(page_path,pixel.MAX_PNG)
    md=pixel.read_bytes(md_path,pixel.MAX_MD)
    anchor=pixel.read_json(anchor_path,pixel.MAX_ANCHOR)
    v3=pixel.read_json(v3_path,MAX_V3)
    require(pixel.read_bytes(anchor_path,pixel.MAX_ANCHOR)==pixel.canonical(anchor))
    require(pixel.read_bytes(v3_path,MAX_V3)==pixel.canonical(v3))
    report,overlay=build(source,md,anchor,v3)
    raw=pixel.canonical(report)
    require(len(raw)<=MAX_V4)
    target=Path(report_path);image=Path(overlay_path)
    require(target!=image)
    if audit_only:
        require(pixel.read_bytes(target,MAX_V4)==raw)
        require(pixel.read_bytes(image,MAX_OVERLAY)==overlay)
    else:
        require(not target.exists() and not target.is_symlink())
        require(not image.exists() and not image.is_symlink())
        exclusive(target,raw)
        exclusive(image,overlay)
    return report

def main(argv=None):
    p=argparse.ArgumentParser()
    for name in ('page-png','mineru-markdown','anchor-v1','pixel-v3','private-output','private-overlay'):
        p.add_argument('--'+name,required=True)
    p.add_argument('--audit-only',action='store_true')
    a=p.parse_args(argv)
    try:
        out=run(a.page_png,a.mineru_markdown,a.anchor_v1,a.pixel_v3,
                a.private_output,a.private_overlay,audit_only=a.audit_only)
        print('ACS_B15_FEATURE_REVIEW='+('PRIVATE_VERIFIED' if a.audit_only else 'PRIVATE_CREATED'))
        print('ACS_B15_FEATURE_METHOD=ORB_RANSAC')
        print('ACS_B15_FEATURE_CONSENSUS_SIGNAL='+str(out['independent_feature_candidate']['feature_correlated_candidate']).upper())
        print('ACS_B15_FEATURE_GOLD=UNVERIFIED')
        print('ACS_B15_FEATURE_REGISTRATION=UNVERIFIED')
        print('ACS_B15_FEATURE_NEW_MODEL_CALLS=0')
    except Exception:
        print('ACS_B15_FEATURE_REVIEW=REJECTED')
        return 2
    return 0

if __name__=='__main__':
    sys.exit(main())
