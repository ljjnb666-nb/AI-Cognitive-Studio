import { expect,it } from "vitest";
import { classifyOcrQuality } from "../src/ocr-quality.js";
it("accepts simple candidate text but never treats unverified standard structure as proven",()=>{
 expect(classifyOcrQuality("A useful paragraph.",0).status).toBe("ACCEPTED");
 expect(classifyOcrQuality("A useful paragraph.",0,true)).toEqual({status:"REVIEW_REQUIRED",reasons:["STRUCTURE_UNATTESTED"]});
});
it.each([["","EMPTY_OUTPUT"],["abc\u0000def","CONTROL_CHARACTERS"],["a���b","GARBLED_TEXT"],["<!-- page: 2 --> text","SOURCE_PAGE_MISMATCH"]])("rejects corrupt or mismatched page output",(text,reason)=>{
 const decision=classifyOcrQuality(text!,0);expect(decision.status).toBe("REJECTED");expect(decision.reasons).toContain(reason);
});
it.each([["same repeated paragraph\nsame repeated paragraph\nsame repeated paragraph","DUPLICATE_BLOCKS"],["# title\n##### misplaced","READING_ORDER_RISK"],["| a | b |\n| 1 | 2 |","TABLE_STRUCTURE_UNATTESTED"],["<chart>plot</chart>","UNVERIFIED_CHART_MARKER"],["x axis:\n0 1 2 3","AXIS_LABEL_LEAKAGE"],["x".repeat(20001),"ABNORMAL_TEXT_BLOCK"]])("requires review of structural risks",(text,reason)=>{
 const decision=classifyOcrQuality(text!,0);expect(decision.status).toBe("REVIEW_REQUIRED");expect(decision.reasons).toContain(reason);
});
