import { loadFixture } from "./harness.js";
import type { FixtureRecord } from "./harness.js";

/** Returns null instead of throwing when the fixture is absent (setup paths). */
export async function loadFixtureSafe(fixtureId: string): Promise<FixtureRecord | null> {
  try {
    return await loadFixture(fixtureId);
  } catch {
    return null;
  }
}
