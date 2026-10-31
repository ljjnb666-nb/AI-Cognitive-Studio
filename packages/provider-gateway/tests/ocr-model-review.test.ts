import {expect,it} from "vitest";
import {OCR_REVIEW_AXES,validateOcrModelReview} from "../src/vision/ocr-model-review.js";
const identity={sourceSha256:"a".repeat(64),physicalPageIndex:7,ocrTextSha256:"b".repeat(64)};
const response=()=>({schemaVersion:1,...identity,axes:Object.fromEntries(OCR_REVIEW_AXES.map(axis=>[axis,{status:"CLEAR",reason:"Visible evidence supports this check."}]))});
it("accepts independent checks but grants no publication authority",()=>{
 expect(validateOcrModelReview(response(),identity).status).toBe("PASSED");
 expect(validateOcrModelReview(response(),identity)).not.toHaveProperty("approvedForPodcast");
});
it.each(["text","readingOrder","tables","charts","formulas","hallucination"])("uncertainty in %s blocks passing",axis=>{
 const result=response();result.axes[axis]={status:"UNKNOWN",reason:"Cannot verify this region."};
 expect(validateOcrModelReview(result,identity).status).toBe("REVIEW_REQUIRED");
 result.axes[axis]={status:"ISSUE",reason:"A visible discrepancy remains."};
 expect(validateOcrModelReview(result,identity).status).toBe("REJECTED");
});
it.each(["sourceSha256","physicalPageIndex","ocrTextSha256"])("rejects a judgement for another %s",field=>{
 expect(()=>validateOcrModelReview({...response(),[field]:"wrong"},identity)).toThrow("Invalid OCR review evidence");
});
it("rejects omitted axes, blank reasons and self-declared approval",()=>{
 const missing=response();delete missing.axes.tables;
 expect(()=>validateOcrModelReview(missing,identity)).toThrow();
 const blank=response();blank.axes.text={status:"CLEAR",reason:" "};
 expect(()=>validateOcrModelReview(blank,identity)).toThrow();
 expect(()=>validateOcrModelReview({...response(),approvedForPodcast:true},identity)).toThrow();
});
