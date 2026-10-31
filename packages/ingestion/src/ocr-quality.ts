/** Evidence-based triage, not a Gold accuracy score. Markdown alone cannot
 * attest reading order, omitted tables or chart semantics. Standard proposals
 * therefore require manual review until a geometry attestation exists. */
export type OcrQualityDecision={status:"ACCEPTED"|"REVIEW_REQUIRED"|"REJECTED";reasons:string[]};
export function classifyOcrQuality(text:string,physicalPageIndex:number,requireStructureAttestation=false):OcrQualityDecision {
 const reject:string[]=[];const review:string[]=[];
 if(!text.trim()) reject.push("EMPTY_OUTPUT");
 if(Array.from(text).some(char=>{const code=char.charCodeAt(0);return code<32 && ![9,10,13].includes(code) || code===127;})) reject.push("CONTROL_CHARACTERS");
 const broken=(text.match(/\uFFFD/gu)??[]).length;
 if(broken>=3 || (broken>0 && broken/Math.max(1,text.length)>.01)) reject.push("GARBLED_TEXT");
 const pages=[...text.matchAll(/<!--\s*page\s*[:=]?\s*(\d+)\s*-->/gi)].map(m=>Number(m[1]));
 if(pages.some(page=>page!==physicalPageIndex+1)) reject.push("SOURCE_PAGE_MISMATCH");
 const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 const substantive=lines.filter(line=>line.length>=12);
 if(substantive.length>=3 && (substantive.length-new Set(substantive).size)/substantive.length>.25) review.push("DUPLICATE_BLOCKS");
 if(text.split(/\n\s*\n/).some(block=>block.length>20000)) review.push("ABNORMAL_TEXT_BLOCK");
 const levels=lines.filter(line=>/^#{1,6}\s/.test(line)).map(line=>/^#+/.exec(line)![0].length);
 if(levels.some((level,i)=>i>0 && level>levels[i-1]!+1)) review.push("READING_ORDER_RISK");
 if(lines.some(line=>line.includes("|") && line.split("|").length>=3) || /<table\b/i.test(text)) review.push("TABLE_STRUCTURE_UNATTESTED");
 if(/<chart\b|\[chart\]|\[图表\]|(?:^|\n)\s*(?:Figure|Chart|图表)\s*\d*/i.test(text)) review.push("CHART_SEMANTICS_UNATTESTED");
 if(/<chart\b|\[chart\]|\[图表\]/i.test(text)) review.push("UNVERIFIED_CHART_MARKER");
 if(/(?:^|\n)\s*[xyXY]\s*(?:轴|axis)?\s*[:：]?\s*\n\s*[-\d.]+(?:\s+[-\d.]+){2,}/.test(text)) review.push("AXIS_LABEL_LEAKAGE");
 if(requireStructureAttestation) review.push("STRUCTURE_UNATTESTED");
 return {status:reject.length?"REJECTED":review.length?"REVIEW_REQUIRED":"ACCEPTED",reasons:[...reject,...review]};
}
