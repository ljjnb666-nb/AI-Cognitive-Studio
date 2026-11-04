"""Text-free layout statistics; graph semantics always unverified."""
import math

def _count(value):
    try: n=len(value)
    except (TypeError,ValueError): return None
    return n if 0<=n<=100000 else None

def paddle_layout_signals(records):
    result={"result_pages":0,"recognized_text_boxes":0,"detection_polygons":0,"recognized_polygons":0,
        "confidence_entries":0,"low_confidence_boxes":0,"confidence_mean":None,
        "geometry_integrity":"NOT_AVAILABLE","graph_relationships":0,"graph_semantics":"UNVERIFIED"}
    total=0.
    checks=[]
    for raw in records:
        if not isinstance(raw,dict): raise TypeError("OCR result not dict")
        d=raw.get("res",raw)
        if not isinstance(d,dict) or not isinstance(d.get("rec_texts"),list):
            raise TypeError("rec_texts missing")
        n=len(d["rec_texts"])
        result["result_pages"]+=1
        result["recognized_text_boxes"]+=n
        for source,target in (("dt_polys","detection_polygons"),("rec_polys","recognized_polygons")):
            count=_count(d.get(source))
            if count is not None:
                result[target]+=count
                if source=="rec_polys": checks.append(count==n)
        scores=d.get("rec_scores")
        if scores is not None:
            if _count(scores)!=n: checks.append(False)
            else:
                for value in scores:
                    f=float(value)
                    if not math.isfinite(f) or not 0<=f<=1: raise ValueError("bad confidence")
                    result["confidence_entries"]+=1
                    total+=f
                    if f<0.6: result["low_confidence_boxes"]+=1
                checks.append(True)
    if result["confidence_entries"]:
        result["confidence_mean"]=round(total/result["confidence_entries"],4)
    if checks:
        result["geometry_integrity"]="CONSISTENT" if all(checks) else "INCONSISTENT"
    return result

def docling_layout_signals(document):
    result={"text_items":0,"picture_items":0,"table_items":0,"group_items":0,
            "items_with_provenance":0,"graph_relationships":0,"graph_semantics":"UNVERIFIED"}
    for source,target in (("texts","text_items"),("pictures","picture_items"),
                          ("tables","table_items"),("groups","group_items")):
        items=getattr(document,source,None)
        if items is None: continue
        count=_count(items)
        if count is None: raise ValueError("bad Docling collection")
        result[target]=count
        if source!="groups":
            result["items_with_provenance"]+=sum(1 for obj in items if bool(getattr(obj,"prov",None)))
    return result
