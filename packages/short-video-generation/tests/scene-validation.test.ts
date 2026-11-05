import { describe, expect, it } from "vitest";
import { assertScenes } from "../src/scene-validation.js";
describe("planned video duration units", () => {
  it("rejects a two-minute scene plan for a requested fifteen-second video", () => {
    const scenes = Array.from({ length: 6 }, (_, index) => ({ ordinal: index + 1, targetDurationMs: 20_000, narrationText: "Evidence changes this decision." }));
    expect(() => assertScenes(scenes, 15_000)).toThrow("SHORT_VIDEO_SCENE_QUALITY_INVALID");
  });
  it("allows the documented fifteen-percent tolerance without multiplying it by a thousand", () => {
    const scene = { ordinal: 1, targetDurationMs: 17_250, narrationText: "Evidence changes this decision." };
    expect(() => assertScenes([scene], 15_000)).not.toThrow();
    expect(() => assertScenes([{ ...scene, targetDurationMs: 17_251 }], 15_000)).toThrow("SHORT_VIDEO_SCENE_QUALITY_INVALID");
  });
});
