import { expect, it } from "vitest";
import { bookAnalysisPhaseDescription, bookAnalysisProgressDisplay } from "../lib/book-analysis-progress";
it("分块进度按已保存计数计算，不将分块完成称为全书完成",()=>{
  expect(bookAnalysisProgressDisplay({runId:"fixture",stage:"CHUNK_ANALYSIS",completedChunks:26,totalChunks:278})).toEqual({stage:"分块理解",percent:9.4,chunksComplete:false});
  expect(bookAnalysisProgressDisplay({runId:"fixture",stage:"BOOK_SYNTHESIS",completedChunks:278,totalChunks:278})).toEqual({stage:"全书综合",percent:100,chunksComplete:true});
  expect(bookAnalysisProgressDisplay({runId:"fixture",stage:"QUEUED",completedChunks:0,totalChunks:0})).toMatchObject({stage:"等待开始",percent:null,chunksComplete:false});
});

it("全书综合和最终核验不能由分块100%推断为成功", () => {
  expect(bookAnalysisPhaseDescription("BOOK_SYNTHESIS")).toContain("之后还需");
  expect(bookAnalysisPhaseDescription("EMBEDDINGS")).toContain("还需核验");
  expect(bookAnalysisPhaseDescription("FINALIZING")).toContain("核验通过后才会");
  expect(bookAnalysisPhaseDescription("COMPLETED")).toBe("全书处理已完成。");
});
