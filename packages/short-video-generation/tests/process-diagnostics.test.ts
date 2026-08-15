import { describe, expect, it } from "vitest";
import {
  PROCESS_STDERR_EXCERPT_MAX_LENGTH,
  VIDEO_RENDER_FFMPEG_FAILED,
  VIDEO_RENDERING_STAGE,
  VideoRenderProcessError,
  videoRenderFailureDetails,
} from "../src/process-diagnostics.js";

describe("VideoRenderProcessError", () => {
  it("preserves a numeric ffmpeg exit with a sanitized diagnostic", () => {
    const error = new VideoRenderProcessError({
      code: 1,
      signal: null,
      killed: false,
      stderr: "\u001b[31merror\u001b[0m\r\n/tmp/ai-cognitive-short-video-test/captions.srt\u0000",
    }, "/tmp/ai-cognitive-short-video-test");

    expect(videoRenderFailureDetails(error)).toEqual({
      code: VIDEO_RENDER_FFMPEG_FAILED,
      stage: VIDEO_RENDERING_STAGE,
      adapter: "ffmpeg",
      exitCode: 1,
      processCode: null,
      signal: null,
      killed: false,
      stderrExcerpt: "error\n<tmp>/captions.srt",
    });
  });

  it("preserves a string process code without inventing an exit code", () => {
    const error = new VideoRenderProcessError({ code: "ENOENT", stderr: "ffmpeg missing" }, "/tmp/render");
    expect(error.diagnostic).toMatchObject({ exitCode: null, processCode: "ENOENT", stderrExcerpt: "ffmpeg missing" });
  });

  it("bounds stderr while retaining deterministic head and tail", () => {
    const error = new VideoRenderProcessError({ stderr: `head-${"x".repeat(10_000)}-tail` }, "/tmp/render");
    expect(error.diagnostic.stderrExcerpt.length).toBeLessThanOrEqual(PROCESS_STDERR_EXCERPT_MAX_LENGTH);
    expect(error.diagnostic.stderrExcerpt).toContain("head-");
    expect(error.diagnostic.stderrExcerpt).toContain("[...truncated...]");
    expect(error.diagnostic.stderrExcerpt).toContain("-tail");
  });
});
