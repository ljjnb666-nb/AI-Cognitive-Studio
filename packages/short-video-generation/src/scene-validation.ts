/** Both planned scenes and the requested duration use milliseconds. */
export function assertScenes(
  scenes: Array<{ ordinal: number; targetDurationMs: number; narrationText: string }>,
  targetDurationMs: number,
) {
  if (
    scenes.some((scene, index) => scene.ordinal !== index + 1) ||
    scenes.reduce((total, scene) => total + scene.targetDurationMs, 0) > targetDurationMs * 1.15 ||
    scenes.some(scene => /^(首先|其次|最后|总结|总之|综上|让我们)/.test(scene.narrationText))
  ) throw new Error("SHORT_VIDEO_SCENE_QUALITY_INVALID");
}
